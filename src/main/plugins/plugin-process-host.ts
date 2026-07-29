/* eslint-disable react/naming-convention-context-name */
import type {
  ClipboardContent,
  NetworkRequestInit,
  NetworkStreamResponse,
  PluginContext,
  PluginModule,
  ToolContext,
  ToolResult,
  View,
} from "@synapse/plugin-sdk"
import type { ClipboardWatchHandle, PluginBridge } from "./plugin-bridge"
import type {
  CapabilityCallMessage,
  ChildToHostMessage,
  HostToChildMessage,
  SerializedError,
} from "./plugin-ipc-protocol"
import type {
  DiscoveredPlugin,
  PluginEventRequest,
  PluginInvokeRequest,
  PluginSandboxModule,
  PluginToolInvokeRequest,
  PluginTriggerDispatch,
} from "./types"
import { Buffer } from "node:buffer"
import * as path from "node:path"
import { boundNonStreamingToolResult } from "../ai/tool-result-boundary"
import { logger } from "../logging"
import { CapabilityDenied } from "./capability-gate"
import { PermissionDenied } from "./permissions"
import {
  deserializeError,
  nextCallId,
  parseChildToHostMessage,
  serializeError,
} from "./plugin-ipc-protocol"

/**
 * Host-side counterpart to `plugin-runtime-entry.ts` (Critical #1). Manages
 * one `utilityProcess` child per loaded plugin and is the ONLY place that
 * dispatches a `capability-call` message to the real `PluginBridge`-backed
 * implementation — gate/grant/audit state never leaves this process. See
 * `plugin-ipc-protocol.ts`'s header comment for what this design does and
 * does not close by itself.
 *
 * This class is not yet wired into `PluginSandbox` — that rewrite (replacing
 * `plugin-sandbox.ts`'s `node:vm` internals while keeping its public method
 * signatures) is a separate, subsequent slice, along with the `utilityProcess`
 * mock and the `electron.vite.config.ts` build entry for the runtime-entry
 * script. `forkProcess` is required precisely so this file can be fully unit
 * tested today without any of that — tests inject a fake `ChildProcessHandle`,
 * mirroring how `plugin-runtime-entry.test.ts` used a fake `RuntimePort`
 * instead of a real `MessagePortMain`.
 */

export class PluginSandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PluginSandboxError"
  }
}

export class PluginInvocationTimeoutError extends PluginSandboxError {
  constructor(message: string) {
    super(message)
    this.name = "PluginInvocationTimeoutError"
  }
}

/**
 * A call was rejected because `abortPluginCapability` cancelled it — an
 * expected, intentional outcome of a capability revoke, not a sign the
 * plugin's process crashed. Callers that distinguish "plugin defect/crash"
 * from "policy decision" (e.g. `PluginRegistry`'s `markCrashed` gating)
 * must treat this the same as `PermissionDenied`/`CapabilityDenied`/
 * `PluginInvocationTimeoutError` — never as a crash.
 */
export class PluginCallCancelledError extends PluginSandboxError {
  constructor(
    readonly pluginId: string,
    message: string
  ) {
    super(message)
    this.name = "PluginCallCancelledError"
  }
}

/** Abstraction over Electron's `utilityProcess.fork()` return value, so the
 *  real Electron API is confined to whatever supplies `forkProcess`. */
export interface ChildProcessHandle {
  postMessage: (message: HostToChildMessage) => void
  onMessage: (listener: (message: unknown) => void) => void
  onExit: (listener: (code: number | null) => void) => void
  kill: () => void
}

export interface PluginProcessHostOptions {
  bridge: PluginBridge
  /** Absolute path to the built `plugin-runtime-entry.js` script. */
  entryScriptPath: string
  loadTimeoutMs?: number
  invokeTimeoutMs?: number
  /** `run` may await JIT capability prompts — keep this generous. */
  commandRunTimeoutMs?: number
  toolInvokeTimeoutMs?: number
  /** Spawns the child process for one plugin. Required — see class docs. */
  forkProcess: (entryScriptPath: string, pluginId: string) => ChildProcessHandle
}

type AnyPluginContext = PluginContext | ToolContext

type CapabilityCtx = Pick<
  PluginContext,
  "storage" | "clipboard" | "notifications" | "system" | "network" | "fs" | "credentials" | "log"
>

function capabilitiesOf(ctx: AnyPluginContext): CapabilityCtx {
  return ctx as unknown as CapabilityCtx
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

interface InvocationRecord {
  ctx: AnyPluginContext
}

interface ManagedProcess {
  pluginId: string
  rootDir: string
  mainPath: string
  manifest: DiscoveredPlugin["manifest"] & object
  handle: ChildProcessHandle
  commandIds: string[]
  toolNames: string[]
  hasClipboardChangeHandler: boolean
  triggerHandlerNames: string[]
  pendingCalls: Map<string, PendingCall>
  invocations: Map<string, InvocationRecord>
  progressSinks: Map<string, (pct: number, message?: string) => void>
  clipboardWatches: Map<string, () => void>
  activeStreams: Map<string, { cancel: () => void }>
  /** Set right before an intentional `kill()` so the exit handler doesn't
   *  also treat it as a crash. */
  expectedExit: boolean
  /** Set while `abortPluginCapability` is killing + reloading the child;
   *  other calls await this before touching the (possibly superseded)
   *  process entry. */
  restarting?: Promise<void>
}

export class PluginProcessHost {
  private readonly processes = new Map<string, ManagedProcess>()
  private readonly loadTimeoutMs: number
  private readonly invokeTimeoutMs: number
  private readonly commandRunTimeoutMs: number
  private readonly toolInvokeTimeoutMs: number

  constructor(private readonly options: PluginProcessHostOptions) {
    this.loadTimeoutMs = options.loadTimeoutMs ?? 5_000
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 5_000
    // Matches the pre-migration sandbox's default (plugin-sandbox.ts):
    // `run` may await JIT capability prompts, so this stays generous.
    this.commandRunTimeoutMs = options.commandRunTimeoutMs ?? 120_000
    this.toolInvokeTimeoutMs = options.toolInvokeTimeoutMs ?? 30_000
  }

  async loadPlugin(entry: DiscoveredPlugin): Promise<PluginSandboxModule> {
    if (entry.status !== "valid" || !entry.manifest) {
      throw new PluginSandboxError(`Cannot load plugin with status ${entry.status}`)
    }

    await this.unloadPlugin(entry.pluginId)

    const mainPath = resolveInside(entry.rootDir, entry.manifest.main)
    const manifest = entry.manifest
    const proc = this.spawn(entry.pluginId, entry.rootDir, mainPath, manifest)
    this.processes.set(entry.pluginId, proc)

    try {
      await this.sendLoadPlugin(proc)
    } catch (err) {
      this.processes.delete(entry.pluginId)
      proc.expectedExit = true
      proc.handle.kill()
      throw err
    }

    return {
      pluginId: entry.pluginId,
      manifest,
      module: buildStubModule(proc),
    }
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    const proc = await this.resolveProcess(pluginId)
    if (!proc) return

    for (const commandId of proc.commandIds) {
      try {
        await this.disposeCommand(pluginId, commandId)
      } catch (err) {
        logger.child(`plugin:${pluginId}`).warn("dispose failed during unload", { err })
      }
    }

    this.processes.delete(pluginId)
    this.rejectAllPending(
      proc,
      new PluginCallCancelledError(pluginId, `Plugin unloaded: ${pluginId}`)
    )
    this.teardownWatchesAndStreams(proc)
    proc.expectedExit = true
    proc.handle.kill()
    await this.options.bridge.disposePlugin(pluginId)
  }

  async invokeCommand(request: PluginInvokeRequest): Promise<View | void> {
    const proc = await this.resolveProcess(request.pluginId)
    if (!proc) throw new PluginSandboxError(`Plugin is not loaded: ${request.pluginId}`)
    if (!proc.commandIds.includes(request.commandId)) {
      throw new PluginSandboxError(`Plugin command is not exported: ${request.commandId}`)
    }

    const invocationId = nextCallId("inv")
    const ctx = this.options.bridge.createContext(request.pluginId, proc.manifest, {
      source: "runless",
      actor: "user",
      trigger: `command:${request.commandId}`,
    })
    proc.invocations.set(invocationId, { ctx })
    const callId = nextCallId("cmd")
    const timeoutMs = request.phase === "run" ? this.commandRunTimeoutMs : this.invokeTimeoutMs

    try {
      const value = await this.sendAndAwait<unknown>(
        proc,
        {
          type: "invoke-command",
          callId,
          invocationId,
          request: { commandId: request.commandId, phase: request.phase, payload: request.payload },
          context: commandContextData(ctx as PluginContext),
        },
        callId,
        timeoutMs
      )
      return value as View | void
    } finally {
      proc.invocations.delete(invocationId)
    }
  }

  async invokeTool(request: PluginToolInvokeRequest): Promise<ToolResult> {
    const proc = await this.resolveProcess(request.pluginId)
    if (!proc) throw new PluginSandboxError(`Plugin is not loaded: ${request.pluginId}`)
    if (!proc.toolNames.includes(request.toolName)) {
      throw new PluginSandboxError(`Plugin tool is not exported: ${request.toolName}`)
    }

    const controller = new AbortController()
    const signal = linkAbortSignals(controller.signal, request.options.signal)
    const timer = setTimeout(() => {
      // Typed the same as invokeCommand's timeout (via sendAndAwait) so
      // callers — notably PluginRegistry's crash-detection — can reliably
      // distinguish "this call timed out" from "the plugin actually
      // crashed" by class alone, regardless of which of the two racing
      // timeout mechanisms below actually wins.
      controller.abort(
        new PluginInvocationTimeoutError(`Plugin tool exceeded ${this.toolInvokeTimeoutMs}ms`)
      )
    }, this.toolInvokeTimeoutMs)

    const invocationId = nextCallId("inv")
    const ctx = this.options.bridge.createToolContext(request.pluginId, proc.manifest, {
      caller: request.options.caller,
      signal,
      progress: request.options.progress,
      capabilities: request.capabilities,
      toolName: request.toolName,
    })
    proc.invocations.set(invocationId, { ctx })
    const callId = nextCallId("tool")
    if (request.options.progress) proc.progressSinks.set(callId, request.options.progress)

    const onAbort = (): void => {
      proc.handle.postMessage({ type: "cancel-tool", callId, reason: errorMessage(signal.reason) })
    }
    signal.addEventListener("abort", onAbort, { once: true })

    try {
      const sendPromise = this.sendAndAwait<{
        content: ToolResult["content"]
        isError?: boolean
        structured?: unknown
      }>(
        proc,
        {
          type: "invoke-tool",
          callId,
          invocationId,
          request: {
            toolName: request.toolName,
            input: request.input,
            caller: request.options.caller,
          },
          context: toolContextData(ctx as ToolContext),
        },
        callId,
        this.toolInvokeTimeoutMs
      )
      const abortPromise = rejectWhenAborted(signal)
      // Both promises race the same deadline (the timeout above aborts
      // `signal` at exactly `toolInvokeTimeoutMs`, the same value passed to
      // sendAndAwait) — whichever loses the race would otherwise surface as
      // an unhandled rejection once nothing else observes it.
      sendPromise.catch(() => {})
      abortPromise.catch(() => {})
      const rawResult = await Promise.race([sendPromise, abortPromise])
      return boundNonStreamingToolResult(rawResult as ToolResult)
    } catch (err) {
      if (
        err instanceof PluginSandboxError ||
        err instanceof PermissionDenied ||
        err instanceof CapabilityDenied
      )
        throw err
      return {
        content: [{ type: "text", text: errorMessage(err) }],
        isError: true,
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      proc.invocations.delete(invocationId)
      proc.progressSinks.delete(callId)
    }
  }

  async disposeCommand(pluginId: string, commandId: string): Promise<void> {
    const proc = await this.resolveProcess(pluginId)
    if (!proc) return

    const invocationId = nextCallId("inv")
    const ctx = this.options.bridge.createContext(pluginId, proc.manifest, {
      source: "runless",
      actor: "user",
      trigger: `command:${commandId}:dispose`,
    })
    proc.invocations.set(invocationId, { ctx })
    const callId = nextCallId("dispose")
    try {
      await this.sendAndAwait(
        proc,
        {
          type: "dispose-command",
          callId,
          invocationId,
          commandId,
          context: commandContextData(ctx as PluginContext),
        },
        callId,
        this.invokeTimeoutMs
      )
    } finally {
      proc.invocations.delete(invocationId)
    }
  }

  async dispatchEvent(request: PluginEventRequest): Promise<void> {
    const proc = await this.resolveProcess(request.pluginId)
    if (!proc) throw new PluginSandboxError(`Plugin is not loaded: ${request.pluginId}`)
    if (request.event === "clipboard:change" && !proc.hasClipboardChangeHandler) return

    const invocationId = nextCallId("inv")
    const ctx = this.options.bridge.createContext(request.pluginId, proc.manifest, {
      source: "runless",
      actor: "background",
      trigger: "clipboard:change",
    })
    proc.invocations.set(invocationId, { ctx })
    const callId = nextCallId("evt")
    try {
      await this.sendAndAwait(
        proc,
        {
          type: "dispatch-event",
          callId,
          invocationId,
          event: request.event,
          // Wire payload is the bare ClipboardContent — the child wraps it
          // back into `{ content }` before calling events.onClipboardChange
          // (see plugin-runtime-entry.ts's "dispatch-event" case).
          payload: request.payload.content,
          context: commandContextData(ctx as PluginContext),
        },
        callId,
        this.invokeTimeoutMs
      )
    } finally {
      proc.invocations.delete(invocationId)
    }
  }

  async dispatchTrigger(request: PluginTriggerDispatch): Promise<void> {
    const proc = await this.resolveProcess(request.pluginId)
    if (!proc) throw new PluginSandboxError(`Plugin is not loaded: ${request.pluginId}`)

    const ctx = this.options.bridge.createContext(request.pluginId, proc.manifest, {
      source: "runless",
      actor: "background",
      trigger: request.trigger,
      signal: request.signal,
      invocationId: request.invocationId,
    })
    proc.invocations.set(request.invocationId, { ctx })
    const callId = nextCallId("trg")
    const onAbort = (): void => {
      proc.handle.postMessage({ type: "cancel-trigger", callId })
    }
    request.signal.addEventListener("abort", onAbort, { once: true })

    try {
      await this.sendAndAwait(
        proc,
        {
          type: "dispatch-trigger",
          callId,
          handler: request.handler,
          trigger: request.trigger,
          invocationId: request.invocationId,
          event: request.event,
          context: commandContextData(ctx as PluginContext),
        },
        callId,
        this.invokeTimeoutMs
      )
    } finally {
      request.signal.removeEventListener("abort", onAbort)
      proc.invocations.delete(request.invocationId)
    }
  }

  getLoadedModule(pluginId: string): PluginSandboxModule | undefined {
    const proc = this.processes.get(pluginId)
    if (!proc) return undefined
    return { pluginId: proc.pluginId, manifest: proc.manifest, module: buildStubModule(proc) }
  }

  /**
   * Revoke a capability for a loaded plugin. Intentionally plugin-wide, not
   * capability-scoped or call-scoped: unlike the pre-migration `node:vm`
   * sandbox (which could reach in and clear its own tracked timers), the host
   * has no way to inspect or cancel work already running inside a real OS
   * process. Killing and reloading the child is the only way to guarantee
   * every background timer/listener the plugin created is actually gone —
   * matching the "coarse" philosophy the old sandbox's own docs already
   * accepted, just enforced by process teardown instead of clearing handles.
   */
  abortPluginCapability(pluginId: string, capability: string): void {
    const proc = this.processes.get(pluginId)
    if (!proc) return
    void capability // reserved for future per-capability teardown

    this.rejectAllPending(
      proc,
      new PluginCallCancelledError(
        pluginId,
        `Plugin call was cancelled: capability revoked for ${pluginId}`
      )
    )
    this.teardownWatchesAndStreams(proc)
    proc.expectedExit = true
    proc.handle.kill()
    proc.restarting = this.restartProcess(proc)
  }

  private async restartProcess(old: ManagedProcess): Promise<void> {
    const fresh = this.spawn(old.pluginId, old.rootDir, old.mainPath, old.manifest)
    this.processes.set(old.pluginId, fresh)
    try {
      await this.sendLoadPlugin(fresh)
    } catch (err) {
      logger
        .child(`plugin:${old.pluginId}`)
        .error("failed to restart plugin process after capability revoke", { err })
      this.processes.delete(old.pluginId)
      fresh.expectedExit = true
      fresh.handle.kill()
    } finally {
      fresh.restarting = undefined
    }
  }

  /** Waits out an in-flight restart (if any), then returns the current
   *  (possibly superseded) process entry for a plugin. */
  private async resolveProcess(pluginId: string): Promise<ManagedProcess | undefined> {
    const proc = this.processes.get(pluginId)
    if (proc?.restarting) {
      await proc.restarting
      return this.processes.get(pluginId)
    }
    return proc
  }

  private spawn(
    pluginId: string,
    rootDir: string,
    mainPath: string,
    manifest: DiscoveredPlugin["manifest"] & object
  ): ManagedProcess {
    const handle = this.options.forkProcess(this.options.entryScriptPath, pluginId)
    const proc: ManagedProcess = {
      pluginId,
      rootDir,
      mainPath,
      manifest,
      handle,
      commandIds: [],
      toolNames: [],
      hasClipboardChangeHandler: false,
      triggerHandlerNames: [],
      pendingCalls: new Map(),
      invocations: new Map(),
      progressSinks: new Map(),
      clipboardWatches: new Map(),
      activeStreams: new Map(),
      expectedExit: false,
    }
    this.wireMessageHandling(proc)
    return proc
  }

  private async sendLoadPlugin(proc: ManagedProcess): Promise<void> {
    const callId = nextCallId("load")
    let value: {
      commandIds: string[]
      toolNames: string[]
      hasClipboardChangeHandler: boolean
      triggerHandlerNames: string[]
    }
    try {
      value = await this.sendAndAwait(
        proc,
        {
          type: "load-plugin",
          callId,
          pluginId: proc.pluginId,
          rootDir: proc.rootDir,
          mainPath: proc.mainPath,
          manifest: proc.manifest,
        },
        callId,
        this.loadTimeoutMs
      )
    } catch (err) {
      // A load failure reported by the child (e.g. normalizePluginModule's
      // validation in plugin-runtime-entry.ts) crosses the wire as a plain
      // deserialized Error — its original class identity doesn't survive
      // serializeError/deserializeError's duck-typed {message, stack}
      // shape. Re-wrap as PluginSandboxError so this stays, as it always
      // was, an infrastructure-failure type callers can rely on (a real
      // PluginInvocationTimeoutError from sendAndAwait's own timeout is
      // already correctly typed and passes through unchanged here).
      if (err instanceof PluginSandboxError) throw err
      throw new PluginSandboxError(errorMessage(err))
    }
    proc.commandIds = value.commandIds
    proc.toolNames = value.toolNames
    proc.hasClipboardChangeHandler = value.hasClipboardChangeHandler
    proc.triggerHandlerNames = value.triggerHandlerNames
  }

  private sendAndAwait<T>(
    proc: ManagedProcess,
    message: HostToChildMessage,
    callId: string,
    timeoutMs: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.pendingCalls.delete(callId)
        reject(new PluginInvocationTimeoutError(`Plugin call exceeded ${timeoutMs}ms`))
      }, timeoutMs)
      proc.pendingCalls.set(callId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      proc.handle.postMessage(message)
    })
  }

  private rejectAllPending(proc: ManagedProcess, err: Error): void {
    for (const pending of proc.pendingCalls.values()) pending.reject(err)
    proc.pendingCalls.clear()
  }

  private teardownWatchesAndStreams(proc: ManagedProcess): void {
    for (const unwatch of proc.clipboardWatches.values()) unwatch()
    proc.clipboardWatches.clear()
    for (const stream of proc.activeStreams.values()) stream.cancel()
    proc.activeStreams.clear()
  }

  private wireMessageHandling(proc: ManagedProcess): void {
    proc.handle.onMessage((raw) => {
      const message = parseChildToHostMessage(raw)
      if (!message) return
      this.dispatchChildMessage(proc, message)
    })
    proc.handle.onExit((code) => {
      if (proc.expectedExit) return
      this.handleCrash(proc, code)
    })
  }

  private dispatchChildMessage(proc: ManagedProcess, message: ChildToHostMessage): void {
    switch (message.type) {
      case "load-plugin-result":
      case "invoke-command-result":
      case "dispose-command-result":
      case "invoke-tool-result":
      case "dispatch-event-result":
      case "dispatch-trigger-result": {
        const pending = proc.pendingCalls.get(message.callId)
        if (!pending) return
        proc.pendingCalls.delete(message.callId)
        if (message.ok) pending.resolve("value" in message ? message.value : undefined)
        else pending.reject(reconstructError(message.error ?? { message: "plugin call failed" }))
        return
      }
      case "tool-progress":
        proc.progressSinks.get(message.callId)?.(message.pct, message.message)
        return
      case "capability-call":
        this.handleCapabilityCall(proc, message)
        return
      case "stream-cancel":
        proc.activeStreams.get(message.streamId)?.cancel()
        proc.activeStreams.delete(message.streamId)
        return
      case "child-fault":
        this.handleChildFault(proc, message.error)
        break
      default:
        break
    }
  }

  private handleCapabilityCall(proc: ManagedProcess, msg: CapabilityCallMessage): void {
    const invocation = proc.invocations.get(msg.invocationId)
    if (!invocation) {
      proc.handle.postMessage({
        type: "capability-call-result",
        callId: msg.callId,
        ok: false,
        error: serializeError(new Error(`Unknown invocation: ${msg.invocationId}`)),
      })
      return
    }

    if (msg.capability === "clipboard.watch") {
      this.handleClipboardWatch(proc, invocation.ctx, msg)
      return
    }
    if (msg.capability === "clipboard.unwatch") {
      this.handleClipboardUnwatch(proc, msg)
      return
    }
    if (msg.capability === "network.fetch") {
      void this.handleNetworkFetch(proc, invocation.ctx, msg)
      return
    }
    if (msg.capability === "network.fetchStream") {
      void this.handleNetworkFetchStream(proc, invocation.ctx, msg)
      return
    }

    void invokeCapabilityMethod(invocation.ctx, msg.capability, msg.args)
      .then((value) => {
        proc.handle.postMessage({
          type: "capability-call-result",
          callId: msg.callId,
          ok: true,
          value,
        })
      })
      .catch((err) => {
        proc.handle.postMessage({
          type: "capability-call-result",
          callId: msg.callId,
          ok: false,
          error: serializeError(err),
        })
      })
  }

  private handleClipboardWatch(
    proc: ManagedProcess,
    ctx: AnyPluginContext,
    msg: CapabilityCallMessage
  ): void {
    const listenerId = nextCallId("watch")
    const unwatch = capabilitiesOf(ctx).clipboard.watch((content: ClipboardContent) => {
      proc.handle.postMessage({ type: "clipboard-changed", listenerId, content })
    }) as ClipboardWatchHandle
    proc.clipboardWatches.set(listenerId, unwatch)
    // Hold the result until the capability gate actually settles — see
    // ClipboardWatchHandle's doc comment. Responding eagerly (on the
    // synchronous return of clipboard.watch()) would tell the child the
    // watch is live before a not-yet-granted capability's prompt/grant has
    // even resolved, and would silently swallow a denial instead of
    // surfacing it to the child as an error.
    unwatch.ready
      .then(() => {
        proc.handle.postMessage({
          type: "capability-call-result",
          callId: msg.callId,
          ok: true,
          value: { listenerId },
        })
      })
      .catch((err) => {
        proc.clipboardWatches.delete(listenerId)
        proc.handle.postMessage({
          type: "capability-call-result",
          callId: msg.callId,
          ok: false,
          error: serializeError(err),
        })
      })
  }

  private handleClipboardUnwatch(proc: ManagedProcess, msg: CapabilityCallMessage): void {
    const [listenerId] = msg.args as [string]
    proc.clipboardWatches.get(listenerId)?.()
    proc.clipboardWatches.delete(listenerId)
    proc.handle.postMessage({ type: "capability-call-result", callId: msg.callId, ok: true })
  }

  private async handleNetworkFetch(
    proc: ManagedProcess,
    ctx: AnyPluginContext,
    msg: CapabilityCallMessage
  ): Promise<void> {
    try {
      const [url, init] = msg.args as [string, NetworkRequestInit | undefined]
      const response = await capabilitiesOf(ctx).network.fetch(url, init)
      const buffer = await response.arrayBuffer()
      proc.handle.postMessage({
        type: "capability-call-result",
        callId: msg.callId,
        ok: true,
        value: {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          bodyBase64: Buffer.from(buffer).toString("base64"),
        },
      })
    } catch (err) {
      proc.handle.postMessage({
        type: "capability-call-result",
        callId: msg.callId,
        ok: false,
        error: serializeError(err),
      })
    }
  }

  private async handleNetworkFetchStream(
    proc: ManagedProcess,
    ctx: AnyPluginContext,
    msg: CapabilityCallMessage
  ): Promise<void> {
    const [url, init, streamId] = msg.args as [string, NetworkRequestInit | undefined, string]
    try {
      const response = await capabilitiesOf(ctx).network.fetchStream(url, init)
      proc.activeStreams.set(streamId, { cancel: () => response.body.cancel() })
      proc.handle.postMessage({
        type: "capability-call-result",
        callId: msg.callId,
        ok: true,
        value: {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      })
      void this.pumpStream(proc, streamId, response)
    } catch (err) {
      proc.handle.postMessage({
        type: "capability-call-result",
        callId: msg.callId,
        ok: false,
        error: serializeError(err),
      })
    }
  }

  private async pumpStream(
    proc: ManagedProcess,
    streamId: string,
    response: NetworkStreamResponse
  ): Promise<void> {
    try {
      for await (const chunk of response.body) {
        if (!proc.activeStreams.has(streamId)) return
        const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike)
        const data = view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength
        ) as ArrayBuffer
        proc.handle.postMessage({ type: "stream-chunk", streamId, data })
      }
      if (proc.activeStreams.has(streamId)) {
        proc.handle.postMessage({ type: "stream-end", streamId })
      }
    } catch (err) {
      if (proc.activeStreams.has(streamId)) {
        proc.handle.postMessage({ type: "stream-error", streamId, error: serializeError(err) })
      }
    } finally {
      proc.activeStreams.delete(streamId)
    }
  }

  /**
   * A crashed/exited child (not one we killed ourselves) is treated as an
   * unload: the plugin comes off the active map and every in-flight call
   * fails clearly. Whether to auto-reload is a policy decision that belongs
   * to a higher layer (PluginRegistry/PluginHost), not this class.
   */
  private handleCrash(proc: ManagedProcess, code: number | null): void {
    if (this.processes.get(proc.pluginId) !== proc) return
    this.processes.delete(proc.pluginId)
    this.rejectAllPending(
      proc,
      new PluginSandboxError(`Plugin process exited unexpectedly (code ${code}): ${proc.pluginId}`)
    )
    this.teardownWatchesAndStreams(proc)
  }

  private handleChildFault(proc: ManagedProcess, error: SerializedError): void {
    logger
      .child(`plugin:${proc.pluginId}`)
      .error("plugin child process reported an unhandled fault", { error })
    proc.expectedExit = true
    proc.handle.kill()
    this.handleCrash(proc, null)
  }
}

function commandContextData(ctx: PluginContext) {
  return {
    pluginId: ctx.pluginId,
    locale: ctx.locale,
    theme: ctx.theme,
    preferences: ctx.preferences,
  }
}

function toolContextData(ctx: ToolContext) {
  return { pluginId: ctx.pluginId, preferences: ctx.preferences }
}

async function invokeCapabilityMethod(
  ctx: AnyPluginContext,
  capability: string,
  args: unknown[]
): Promise<unknown> {
  if (capability === "log") {
    capabilitiesOf(ctx).log(...args)
    return undefined
  }
  const dot = capability.indexOf(".")
  const ns = capability.slice(0, dot) as keyof CapabilityCtx
  const method = capability.slice(dot + 1)
  const target = capabilitiesOf(ctx)[ns] as unknown as Record<string, unknown> | undefined
  const fn = target?.[method]
  if (typeof fn !== "function") throw new Error(`Unknown capability: ${capability}`)
  return (fn as (...a: unknown[]) => unknown).apply(target, args)
}

function buildStubModule(proc: {
  commandIds: string[]
  toolNames: string[]
  hasClipboardChangeHandler: boolean
  triggerHandlerNames: string[]
}): PluginModule {
  const stub = (): never => {
    throw new PluginSandboxError(
      "Plugin commands/tools/triggers run inside the plugin's own process; this host-side stub must never be called directly."
    )
  }
  const commands: PluginModule["commands"] = {}
  for (const commandId of proc.commandIds) commands[commandId] = { run: stub }
  const tools: NonNullable<PluginModule["tools"]> = {}
  for (const toolName of proc.toolNames) tools[toolName] = stub
  const triggers: NonNullable<PluginModule["triggers"]> = {}
  for (const name of proc.triggerHandlerNames) triggers[name] = stub
  return {
    commands,
    tools,
    triggers,
    events: proc.hasClipboardChangeHandler ? { onClipboardChange: stub } : undefined,
  }
}

function resolveInside(rootDir: string, relativePath: string): string {
  const root = path.resolve(rootDir)
  const target = path.resolve(root, relativePath)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new PluginSandboxError("Plugin main path escapes the plugin directory")
  }
  return target
}

function linkAbortSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) return primary
  if (typeof AbortSignal.any === "function") return AbortSignal.any([primary, secondary])

  const controller = new AbortController()
  if (primary.aborted) controller.abort(primary.reason)
  else if (secondary.aborted) controller.abort(secondary.reason)
  else {
    primary.addEventListener("abort", () => controller.abort(primary.reason), { once: true })
    secondary.addEventListener("abort", () => controller.abort(secondary.reason), { once: true })
  }
  return controller.signal
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => {
      const reason = signal.reason
      reject(reason instanceof Error ? reason : new PluginSandboxError("Plugin tool was cancelled"))
    }
    if (signal.aborted) fail()
    else signal.addEventListener("abort", fail, { once: true })
  })
}

/**
 * Reconstructs a real, `instanceof`-checkable error from a `SerializedError`
 * that crossed the wire from the child — the counterpart to
 * plugin-ipc-protocol.ts's generic, duck-typed `serializeError`/
 * `deserializeError` (which never import these classes, so the child's
 * bundle stays free of host-only security modules). Without this, a
 * CapabilityDenied/PermissionDenied thrown inside a capability-call handler
 * (or re-thrown unchanged by a plugin's own command/tool code) degrades to
 * a generic Error by the time it reaches PluginRegistry, which then
 * misclassifies a policy denial as a plugin crash.
 */
function reconstructError(serialized: SerializedError): Error {
  const extra = serialized.extra ?? {}
  const str = (key: string): string =>
    typeof extra[key] === "string" ? (extra[key] as string) : ""
  switch (serialized.kind) {
    case "CapabilityDenied":
      return new CapabilityDenied(str("pluginId"), str("capability"), str("why"))
    case "PermissionDenied":
      return new PermissionDenied(str("pluginId"), str("permission"))
    case "PluginInvocationTimeoutError":
      return new PluginInvocationTimeoutError(serialized.message)
    case "PluginCallCancelledError":
      return new PluginCallCancelledError(str("pluginId"), serialized.message)
    case "PluginSandboxError":
      return new PluginSandboxError(serialized.message)
    default:
      return deserializeError(serialized)
  }
}

function errorMessage(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message
  }
  return String(err)
}
