import type {
  ClipboardContent,
  NetworkRequestInit,
  NetworkResponse,
  NetworkStreamResponse,
  NotificationShowOptions,
  NotificationShowResult,
  PluginContext,
  PluginModule,
  ToolCaller,
  ToolContext,
} from "@synapse/plugin-sdk"
import type {
  ChildToHostMessage,
  CommandContextData,
  HostToChildMessage,
  ToolContextData,
} from "./plugin-ipc-protocol"
import { Buffer } from "node:buffer"
import process from "node:process"
import { deserializeError, nextCallId, serializeError } from "./plugin-ipc-protocol"

/**
 * Runs inside a plugin's `utilityProcess` child (Critical #1). This is the
 * ONLY place plugin code executes now — a real, separate OS process with a
 * genuinely independent V8 heap/require cache/object graph from the host,
 * closing the `node:vm` escape the previous sandbox was vulnerable to (see
 * plugin-ipc-protocol.ts's header comment for what this migration does and
 * does NOT close by itself).
 *
 * Every `ctx.*` method here is a thin client: it sends a `capability-call`
 * message to the host and awaits the response. No capability-gate logic,
 * grant state, or secret ever lives in this process — the host's dispatcher
 * (plugin-process-host.ts) is the only place that runs the real
 * `PluginBridge`-backed implementation.
 */

export interface RuntimePort {
  postMessage: (message: ChildToHostMessage) => void
  onMessage: (listener: (message: HostToChildMessage) => void) => void
}

export interface PluginRuntimeDeps {
  /** Loads the plugin's CommonJS module from an absolute path. Defaults to
   *  the real `require()`; injectable so tests don't need a real file. */
  loadModule: (mainPath: string) => unknown
}

class RuntimeFault extends Error {}

export function createPluginRuntime(
  port: RuntimePort,
  deps: Partial<PluginRuntimeDeps> = {}
): void {
  const loadModule = deps.loadModule ?? defaultLoadModule

  let pluginModule: PluginModule | undefined

  const pendingCapabilityCalls = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >()
  const clipboardListeners = new Map<string, (content: ClipboardContent) => void>()
  const toolAborts = new Map<string, AbortController>()
  const triggerAborts = new Map<string, AbortController>()
  const activeStreams = new Map<
    string,
    { push: (chunk: Uint8Array) => void; end: () => void; error: (err: Error) => void }
  >()

  function callCapability(
    invocationId: string,
    capability: string,
    args: unknown[]
  ): Promise<unknown> {
    const callId = nextCallId("cap")
    return new Promise((resolve, reject) => {
      pendingCapabilityCalls.set(callId, { resolve, reject })
      port.postMessage({ type: "capability-call", callId, invocationId, capability, args })
    })
  }

  function buildStorage(invocationId: string): PluginContext["storage"] {
    return {
      get: <T = unknown>(key: string) =>
        callCapability(invocationId, "storage.get", [key]) as Promise<T | undefined>,
      set: (key, value) => callCapability(invocationId, "storage.set", [key, value]).then(() => {}),
      delete: (key) => callCapability(invocationId, "storage.delete", [key]).then(() => {}),
      list: () => callCapability(invocationId, "storage.list", []) as Promise<string[]>,
    }
  }

  function buildClipboard(invocationId: string): PluginContext["clipboard"] {
    return {
      read: () =>
        callCapability(invocationId, "clipboard.read", []) as Promise<ClipboardContent | undefined>,
      write: (content) => callCapability(invocationId, "clipboard.write", [content]).then(() => {}),
      readText: () => callCapability(invocationId, "clipboard.readText", []) as Promise<string>,
      writeText: (text) =>
        callCapability(invocationId, "clipboard.writeText", [text]).then(() => {}),
      watch: (listener) => {
        let unregistered = false
        let listenerId: string | undefined
        void callCapability(invocationId, "clipboard.watch", [])
          .then((result) => {
            const id = (result as { listenerId: string }).listenerId
            if (unregistered) {
              // Unsubscribed before the registration round trip completed —
              // immediately unregister on the host side too, or the host
              // would push clipboard-changed events forever with nothing
              // listening for them here.
              void callCapability(invocationId, "clipboard.unwatch", [id])
              return
            }
            listenerId = id
            clipboardListeners.set(id, listener)
          })
          .catch(() => {
            // Denied or failed — matches the host's own "watch denied,
            // no-op" handling; there's nothing else to do here.
          })
        return () => {
          unregistered = true
          if (listenerId) {
            clipboardListeners.delete(listenerId)
            void callCapability(invocationId, "clipboard.unwatch", [listenerId])
          }
        }
      },
    }
  }

  function buildNotifications(invocationId: string): PluginContext["notifications"] {
    return {
      show: (options: NotificationShowOptions) =>
        callCapability(invocationId, "notifications.show", [
          options,
        ]) as Promise<NotificationShowResult>,
    }
  }

  function buildSystem(invocationId: string): PluginContext["system"] {
    return {
      openUrl: (url) => callCapability(invocationId, "system.openUrl", [url]).then(() => {}),
      openPath: (path) => callCapability(invocationId, "system.openPath", [path]).then(() => {}),
      captureScreen: (options) =>
        callCapability(invocationId, "system.captureScreen", [options]) as Promise<{
          path: string
        }>,
    }
  }

  function buildNetwork(invocationId: string): PluginContext["network"] {
    return {
      fetch: async (url, init) => {
        const value = (await callCapability(invocationId, "network.fetch", [
          url,
          serializableInit(init),
        ])) as {
          ok: boolean
          status: number
          statusText: string
          headers: Record<string, string>
          bodyBase64: string
        }
        return wireResponseToNetworkResponse(value)
      },
      fetchStream: async (url, init) => {
        const streamId = nextCallId("stream")
        const value = (await callCapability(invocationId, "network.fetchStream", [
          url,
          serializableInit(init),
          streamId,
        ])) as { ok: boolean; status: number; statusText: string; headers: Record<string, string> }
        return wireResponseToNetworkStreamResponse(value, streamId, port, activeStreams)
      },
    }
  }

  function buildFs(invocationId: string): PluginContext["fs"] {
    return {
      resolvePath: (rootId, relativePath) =>
        callCapability(invocationId, "fs.resolvePath", [rootId, relativePath]) as Promise<string>,
      readText: (rootId, relativePath) =>
        callCapability(invocationId, "fs.readText", [rootId, relativePath]) as Promise<string>,
      writeText: (rootId, relativePath, data) =>
        callCapability(invocationId, "fs.writeText", [rootId, relativePath, data]).then(() => {}),
      mkdir: (rootId, relativePath) =>
        callCapability(invocationId, "fs.mkdir", [rootId, relativePath]).then(() => {}),
      move: (fromRootId, fromRel, toRootId, toRel) =>
        callCapability(invocationId, "fs.move", [fromRootId, fromRel, toRootId, toRel]) as Promise<{
          journalId: string
        }>,
    }
  }

  function buildCredentials(invocationId: string): PluginContext["credentials"] {
    return {
      status: (id) =>
        callCapability(invocationId, "credentials.status", [id]) as ReturnType<
          PluginContext["credentials"]["status"]
        >,
      requestConnect: (id) =>
        callCapability(invocationId, "credentials.requestConnect", [id]).then(() => {}),
    }
  }

  function buildLog(invocationId: string): PluginContext["log"] {
    return (...args: unknown[]) => {
      void callCapability(invocationId, "log", args).catch(() => {})
    }
  }

  /** The capability sub-objects are identical between a command/event/trigger's
   *  full PluginContext and a tool's ToolContext — only the surrounding shape
   *  (locale/theme/preferences vs preferences/caller/signal/progress) differs. */
  function buildCapabilities(invocationId: string) {
    return {
      storage: buildStorage(invocationId),
      clipboard: buildClipboard(invocationId),
      notifications: buildNotifications(invocationId),
      system: buildSystem(invocationId),
      network: buildNetwork(invocationId),
      fs: buildFs(invocationId),
      credentials: buildCredentials(invocationId),
      log: buildLog(invocationId),
    }
  }

  function buildPluginContext(invocationId: string, context: CommandContextData): PluginContext {
    return {
      pluginId: context.pluginId,
      locale: context.locale,
      theme: context.theme,
      preferences: context.preferences,
      ...buildCapabilities(invocationId),
    }
  }

  function buildToolContext(
    invocationId: string,
    context: ToolContextData,
    caller: ToolCaller,
    signal: AbortSignal,
    callId: string
  ): ToolContext {
    return {
      pluginId: context.pluginId,
      preferences: context.preferences,
      caller,
      signal,
      // Always wired: the host decides whether a caller actually wants
      // progress (it just discards tool-progress messages it has no
      // subscriber for), so the child never needs to know that in advance.
      progress: (pct, message) => {
        port.postMessage({ type: "tool-progress", callId, pct, message })
      },
      ...buildCapabilities(invocationId),
    }
  }

  function ok(callId: string, type: string, value?: unknown): void {
    port.postMessage({ type, callId, ok: true, value } as unknown as ChildToHostMessage)
  }

  function fail(callId: string, type: string, err: unknown): void {
    port.postMessage({
      type,
      callId,
      ok: false,
      error: serializeError(err),
    } as unknown as ChildToHostMessage)
  }

  function requireModule(): PluginModule {
    if (!pluginModule) throw new RuntimeFault("No plugin module is loaded")
    return pluginModule
  }

  port.onMessage((message) => {
    switch (message.type) {
      case "load-plugin": {
        try {
          const loaded = normalizePluginModule(loadModule(message.mainPath))
          pluginModule = loaded
          port.postMessage({
            type: "load-plugin-result",
            callId: message.callId,
            ok: true,
            value: {
              commandIds: Object.keys(loaded.commands),
              toolNames: Object.keys(loaded.tools ?? {}),
              hasClipboardChangeHandler: typeof loaded.events?.onClipboardChange === "function",
              triggerHandlerNames: Object.keys(loaded.triggers ?? {}),
            },
          })
        } catch (err) {
          port.postMessage({
            type: "load-plugin-result",
            callId: message.callId,
            ok: false,
            error: serializeError(err),
          })
        }
        break
      }

      case "invoke-command": {
        void (async () => {
          try {
            const mod = requireModule()
            const handler = mod.commands[message.request.commandId]
            if (!handler)
              throw new RuntimeFault(`Plugin command is not exported: ${message.request.commandId}`)
            const ctx = buildPluginContext(message.invocationId, message.context)
            const { phase, payload } = message.request
            let value: unknown
            if (phase === "run") {
              value = await handler.run(
                { commandId: message.request.commandId, initialQuery: initialQueryOf(payload) },
                ctx
              )
            } else if (phase === "onSearchChange") {
              value = handler.onSearchChange
                ? await handler.onSearchChange(String(payload ?? ""), ctx)
                : undefined
            } else {
              const action = normalizeActionPayload(payload)
              value = handler.onAction
                ? await handler.onAction(action.actionId, action.payload, ctx)
                : undefined
            }
            ok(message.callId, "invoke-command-result", value)
          } catch (err) {
            fail(message.callId, "invoke-command-result", err)
          }
        })()
        break
      }

      case "dispose-command": {
        void (async () => {
          try {
            const mod = requireModule()
            const handler = mod.commands[message.commandId]
            if (handler?.dispose) {
              const ctx = buildPluginContext(message.invocationId, message.context)
              await handler.dispose(ctx)
            }
            ok(message.callId, "dispose-command-result")
          } catch (err) {
            fail(message.callId, "dispose-command-result", err)
          }
        })()
        break
      }

      case "invoke-tool": {
        void (async () => {
          const controller = new AbortController()
          toolAborts.set(message.callId, controller)
          try {
            const mod = requireModule()
            const handler = mod.tools?.[message.request.toolName]
            if (!handler)
              throw new RuntimeFault(`Plugin tool is not exported: ${message.request.toolName}`)
            const ctx = buildToolContext(
              message.invocationId,
              message.context,
              message.request.caller,
              controller.signal,
              message.callId
            )
            const value = await handler(message.request.input, ctx)
            ok(message.callId, "invoke-tool-result", value)
          } catch (err) {
            fail(message.callId, "invoke-tool-result", err)
          } finally {
            toolAborts.delete(message.callId)
          }
        })()
        break
      }

      case "cancel-tool": {
        toolAborts.get(message.callId)?.abort(message.reason)
        break
      }

      case "dispatch-event": {
        void (async () => {
          try {
            const mod = requireModule()
            const handler = mod.events?.onClipboardChange
            if (handler) {
              const ctx = buildPluginContext(message.invocationId, message.context)
              await handler({ content: message.payload as ClipboardContent }, ctx)
            }
            ok(message.callId, "dispatch-event-result")
          } catch (err) {
            fail(message.callId, "dispatch-event-result", err)
          }
        })()
        break
      }

      case "dispatch-trigger": {
        void (async () => {
          const controller = new AbortController()
          triggerAborts.set(message.callId, controller)
          try {
            const mod = requireModule()
            const exportName = message.handler.slice("triggers.".length)
            const handler = mod.triggers?.[exportName]
            if (typeof handler === "function") {
              const ctx = buildPluginContext(message.invocationId, message.context)
              await handler(message.event, ctx)
            }
            ok(message.callId, "dispatch-trigger-result")
          } catch (err) {
            fail(message.callId, "dispatch-trigger-result", err)
          } finally {
            triggerAborts.delete(message.callId)
          }
        })()
        break
      }

      case "cancel-trigger": {
        triggerAborts.get(message.callId)?.abort()
        break
      }

      case "capability-call-result": {
        const pending = pendingCapabilityCalls.get(message.callId)
        if (!pending) break
        pendingCapabilityCalls.delete(message.callId)
        if (message.ok) pending.resolve(message.value)
        else
          pending.reject(deserializeError(message.error ?? { message: "capability call failed" }))
        break
      }

      case "clipboard-changed": {
        clipboardListeners.get(message.listenerId)?.(message.content as ClipboardContent)
        break
      }

      case "stream-chunk": {
        activeStreams.get(message.streamId)?.push(new Uint8Array(message.data))
        break
      }

      case "stream-end": {
        activeStreams.get(message.streamId)?.end()
        activeStreams.delete(message.streamId)
        break
      }

      case "stream-error": {
        activeStreams.get(message.streamId)?.error(deserializeError(message.error))
        activeStreams.delete(message.streamId)
        break
      }

      default:
        break
    }
  })
}

function defaultLoadModule(mainPath: string): unknown {
  // eslint-disable-next-line ts/no-require-imports
  return require(mainPath)
}

// ── Real Electron entry point ─────────────────────────────────────────────
//
// `electron.vite.config.ts` builds this file as its own script
// (`out/main/plugin-runtime-entry.js`), loaded via `utilityProcess.fork()`
// from plugin-sandbox.ts. `process.parentPort` is an Electron-only global
// that exists only inside a forked utility process — it is never present
// under plain Node/Vitest, so this bootstrap is a no-op everywhere
// `createPluginRuntime()` is unit tested against a fake `RuntimePort`.
if (process.parentPort) {
  const parentPort = process.parentPort
  const port: RuntimePort = {
    postMessage: (message) => parentPort.postMessage(message),
    onMessage: (listener) => {
      parentPort.on("message", (event) => listener(event.data as HostToChildMessage))
    },
  }
  createPluginRuntime(port)
}

function initialQueryOf(payload: unknown): string | undefined {
  if (
    payload &&
    typeof payload === "object" &&
    typeof (payload as { initialQuery?: unknown }).initialQuery === "string"
  ) {
    return (payload as { initialQuery: string }).initialQuery
  }
  return undefined
}

function normalizeActionPayload(payload: unknown): { actionId: string; payload: unknown } {
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { actionId?: unknown }).actionId !== "string"
  ) {
    throw new RuntimeFault("onAction payload must include an actionId")
  }
  return {
    actionId: (payload as { actionId: string }).actionId,
    payload: (payload as { payload?: unknown }).payload,
  }
}

function normalizePluginModule(value: unknown): PluginModule {
  if (!value || typeof value !== "object") {
    throw new RuntimeFault("Plugin entry must export an object")
  }
  const commands = (value as { commands?: unknown }).commands
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    throw new RuntimeFault("Plugin entry must export a commands object")
  }
  for (const [commandId, handler] of Object.entries(commands)) {
    if (
      !handler ||
      typeof handler !== "object" ||
      typeof (handler as { run?: unknown }).run !== "function"
    ) {
      throw new RuntimeFault(`Plugin command ${commandId} must export a run function`)
    }
  }
  const tools = (value as { tools?: unknown }).tools
  if (tools !== undefined) {
    if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
      throw new RuntimeFault("Plugin entry tools must be an object")
    }
    for (const [toolName, handler] of Object.entries(tools)) {
      if (typeof handler !== "function") {
        throw new RuntimeFault(`Plugin tool ${toolName} must be a function`)
      }
    }
  }
  return value as PluginModule
}

function serializableInit(
  init: NetworkRequestInit | undefined
): Omit<NetworkRequestInit, "signal"> | undefined {
  if (!init) return undefined
  const { signal: _signal, ...rest } = init
  return rest
}

function wireResponseToNetworkResponse(value: {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  bodyBase64: string
}): NetworkResponse {
  const buffer = Buffer.from(value.bodyBase64, "base64")
  return {
    ok: value.ok,
    status: value.status,
    statusText: value.statusText,
    headers: value.headers,
    text: async () => buffer.toString("utf-8"),
    json: async <T = unknown>() => JSON.parse(buffer.toString("utf-8")) as T,
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  }
}

function wireResponseToNetworkStreamResponse(
  value: { ok: boolean; status: number; statusText: string; headers: Record<string, string> },
  streamId: string,
  port: RuntimePort,
  activeStreams: Map<
    string,
    { push: (chunk: Uint8Array) => void; end: () => void; error: (err: Error) => void }
  >
): NetworkStreamResponse {
  let cancelled = false
  let ended = false
  const pendingChunks: Uint8Array[] = []
  let pendingError: Error | undefined
  let wake: (() => void) | undefined

  activeStreams.set(streamId, {
    push: (chunk) => {
      pendingChunks.push(chunk)
      wake?.()
    },
    end: () => {
      ended = true
      wake?.()
    },
    error: (err) => {
      pendingError = err
      wake?.()
    },
  })

  async function* iterate(): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (pendingChunks.length > 0) {
        yield pendingChunks.shift()!
        continue
      }
      if (pendingError) throw pendingError
      if (ended || cancelled) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }

  return {
    ok: value.ok,
    status: value.status,
    statusText: value.statusText,
    headers: value.headers,
    body: {
      [Symbol.asyncIterator]: () => iterate(),
      cancel: () => {
        if (cancelled) return
        cancelled = true
        activeStreams.delete(streamId)
        port.postMessage({ type: "stream-cancel", streamId })
        wake?.()
      },
    },
  }
}
