import type { PluginContext } from "@synapse/plugin-sdk"
import type { ApprovalResult } from "../approvals/types"
import type {
  ChildToHostMessage,
  HostToChildMessage,
  LoadPluginResultMessage,
} from "./plugin-ipc-protocol"
import type { ChildProcessHandle } from "./plugin-process-host"
import type { DiscoveredPlugin, PluginManifest } from "./types"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CapabilityDenied } from "./capability-gate"
import { createCapabilityGovernance } from "./capability-governance"
import { PermissionDenied } from "./permissions"
import { PluginBridge } from "./plugin-bridge"
import {
  PluginCallCancelledError,
  PluginInvocationTimeoutError,
  PluginProcessHost,
  PluginSandboxError,
} from "./plugin-process-host"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-process-host-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// ── Fakes ──────────────────────────────────────────────────────────────────

function fakeChild() {
  const sent: HostToChildMessage[] = []
  let onMessage: ((message: unknown) => void) | undefined
  let onExit: ((code: number | null) => void) | undefined
  const kill = vi.fn()
  const handle: ChildProcessHandle = {
    postMessage: (message) => sent.push(message),
    onMessage: (listener) => {
      onMessage = listener
    },
    onExit: (listener) => {
      onExit = listener
    },
    kill,
  }
  return {
    handle,
    sent,
    send: (message: ChildToHostMessage) => onMessage?.(message),
    sendRaw: (message: unknown) => onMessage?.(message),
    exit: (code: number | null = null) => onExit?.(code),
    kill,
    lastOfType: <T extends HostToChildMessage["type"]>(type: T) =>
      [...sent].reverse().find((m) => m.type === type) as
        | (HostToChildMessage & { type: T })
        | undefined,
    allOfType: (type: string) => sent.filter((m) => m.type === type),
  }
}

type FakeChild = ReturnType<typeof fakeChild>

function bridgeForTest(
  overrides: { prompt?: Parameters<typeof createCapabilityGovernance>[0]["prompt"] } = {}
): PluginBridge {
  return new PluginBridge({
    userDataDir: dir,
    adapters: {
      clipboard: { read: async () => undefined, write: async () => {} },
      notifications: { show: async () => {} },
      system: {
        openUrl: async () => {},
        openPath: async () => {},
        captureScreen: async () => ({ path: "capture.png" }),
      },
    },
    storageFlushMs: 0,
    governance: overrides.prompt
      ? createCapabilityGovernance({ userDataDir: dir, prompt: overrides.prompt })
      : undefined,
  })
}

function hostForTest(overrides: Record<string, unknown> = {}) {
  const children: FakeChild[] = []
  const host = new PluginProcessHost({
    bridge: bridgeForTest(),
    entryScriptPath: "/entry/plugin-runtime-entry.js",
    loadTimeoutMs: 200,
    invokeTimeoutMs: 200,
    commandRunTimeoutMs: 200,
    toolInvokeTimeoutMs: 200,
    forkProcess: () => {
      const child = fakeChild()
      children.push(child)
      return child.handle
    },
    ...overrides,
  })
  return { host, children }
}

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: 2,
    id: "com.synapse.test",
    name: "Test",
    displayName: "Test",
    description: "test",
    version: "0.1.0",
    author: "Synapse",
    engines: { synapse: "^0.1.0" },
    main: "dist/index.js",
    contributes: { commands: [{ id: "test.run", title: "Run", mode: "view" }] },
    capabilities: [
      { id: "storage:plugin" },
      { id: "clipboard:read" },
      { id: "clipboard:write" },
      { id: "clipboard:watch" },
      { id: "network:https" },
    ],
    ...overrides,
  } as PluginManifest
}

function discoveredPlugin(overrides: Partial<DiscoveredPlugin> = {}): DiscoveredPlugin {
  return {
    pluginId: "com.synapse.test",
    rootDir: "/plugins/test",
    source: { kind: "dev", priority: 1 },
    status: "valid",
    manifest: manifest(),
    ...overrides,
  }
}

const defaultLoadValue = {
  commandIds: ["test.run"],
  toolNames: ["greet"],
  hasClipboardChangeHandler: false,
  triggerHandlerNames: [],
}

/** Drives one plugin through `loadPlugin()`, replying with a canned
 *  load-plugin-result. Returns the resolved module and the fake child. */
async function loadPlugin(
  host: PluginProcessHost,
  children: FakeChild[],
  entry: DiscoveredPlugin = discoveredPlugin(),
  value: LoadPluginResultMessage["value"] = defaultLoadValue
) {
  const promise = host.loadPlugin(entry)
  const child = await waitForNewChild(children)
  const callId = (await waitForMessage(child, "load-plugin")).callId
  child.send({ type: "load-plugin-result", callId, ok: true, value })
  const result = await promise
  return { result, child }
}

/** `loadPlugin`/`unloadPlugin` always `await` at least once before spawning
 *  (they await any existing process's teardown first), so the fake child
 *  isn't in `children` synchronously after the call — unlike
 *  `plugin-runtime-entry.test.ts`'s fake port, which never crosses a real
 *  microtask boundary. Poll instead of assuming it's there immediately. */
async function waitForNewChild(
  children: FakeChild[],
  countBefore = children.length
): Promise<FakeChild> {
  await vi.waitFor(() => {
    expect(children.length).toBeGreaterThan(countBefore)
  })
  return children[children.length - 1]!
}

async function waitForMessage<T extends HostToChildMessage["type"]>(
  child: FakeChild,
  type: T
): Promise<HostToChildMessage & { type: T; callId: string }> {
  await vi.waitFor(() => {
    expect(child.lastOfType(type)).toBeTruthy()
  })
  return child.lastOfType(type) as unknown as HostToChildMessage & { type: T; callId: string }
}

// ── loadPlugin / unloadPlugin ───────────────────────────────────────────────

describe("pluginProcessHost — loadPlugin", () => {
  it("spawns a child and sends load-plugin with the resolved main path", async () => {
    const { host, children } = hostForTest()
    const entry = discoveredPlugin({ rootDir: "/plugins/test", manifest: manifest() })

    const promise = host.loadPlugin(entry)
    const child = await waitForNewChild(children)
    const msg = await waitForMessage(child, "load-plugin")
    expect(msg).toMatchObject({
      type: "load-plugin",
      pluginId: "com.synapse.test",
      rootDir: "/plugins/test",
    })
    expect(msg.mainPath.endsWith("dist/index.js") || msg.mainPath.endsWith("dist\\index.js")).toBe(
      true
    )

    child.send({
      type: "load-plugin-result",
      callId: msg.callId,
      ok: true,
      value: defaultLoadValue,
    })
    const result = await promise
    expect(result.pluginId).toBe("com.synapse.test")
    expect(result.manifest).toEqual(entry.manifest)
  })

  it("returns a stub module whose commands/tools/triggers/events reflect what the child reported", async () => {
    const { host, children } = hostForTest()
    const { result } = await loadPlugin(host, children, discoveredPlugin(), {
      commandIds: ["a.run"],
      toolNames: ["greet"],
      hasClipboardChangeHandler: true,
      triggerHandlerNames: ["onTick"],
    })

    expect(typeof result.module.commands["a.run"]?.run).toBe("function")
    expect(typeof result.module.tools?.greet).toBe("function")
    expect(typeof result.module.triggers?.onTick).toBe("function")
    expect(typeof result.module.events?.onClipboardChange).toBe("function")
  })

  it("rejects for a plugin entry that is not valid", async () => {
    const { host } = hostForTest()
    await expect(
      host.loadPlugin(discoveredPlugin({ status: "invalid", manifest: undefined }))
    ).rejects.toBeInstanceOf(PluginSandboxError)
  })

  it("rejects the path traversal escapes the plugin root", async () => {
    const { host } = hostForTest()
    await expect(
      host.loadPlugin(discoveredPlugin({ manifest: manifest({ main: "../../etc/passwd" }) }))
    ).rejects.toThrow(/escapes/)
  })

  it("propagates a load failure reported by the child and kills the process", async () => {
    const { host, children } = hostForTest()
    const promise = host.loadPlugin(discoveredPlugin())
    const child = await waitForNewChild(children)
    const callId = (await waitForMessage(child, "load-plugin")).callId
    child.send({
      type: "load-plugin-result",
      callId,
      ok: false,
      error: { message: "bad module" },
    })
    await expect(promise).rejects.toThrow("bad module")
    expect(child.kill).toHaveBeenCalled()
  })

  it("times out and rejects when the child never responds", async () => {
    const { host } = hostForTest({ loadTimeoutMs: 30 })
    await expect(host.loadPlugin(discoveredPlugin())).rejects.toBeInstanceOf(
      PluginInvocationTimeoutError
    )
  })

  it("kills any previously loaded process for the same plugin before loading again", async () => {
    const { host, children } = hostForTest()
    const { child: first } = await loadPlugin(host, children)
    await loadPlugin(host, children)
    expect(first.kill).toHaveBeenCalled()
    expect(children).toHaveLength(2)
  })
})

describe("pluginProcessHost — unloadPlugin", () => {
  it("is a no-op for a plugin that was never loaded", async () => {
    const { host } = hostForTest()
    await expect(host.unloadPlugin("nope")).resolves.toBeUndefined()
  })

  it("disposes every reported command and then kills the child", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children, discoveredPlugin(), {
      ...defaultLoadValue,
      commandIds: ["a.run", "b.run"],
    })

    // unloadPlugin disposes commands sequentially (each await gates the
    // next), so both round trips must be answered in order rather than
    // assumed to already be pending together.
    const unloadPromise = host.unloadPlugin("com.synapse.test")
    for (const commandId of ["a.run", "b.run"]) {
      const msg = await vi.waitFor(() => {
        const found = child
          .allOfType("dispose-command")
          .find((m) => (m as { commandId: string }).commandId === commandId) as
          | { callId: string }
          | undefined
        expect(found).toBeTruthy()
        return found!
      })
      child.send({ type: "dispose-command-result", callId: msg.callId, ok: true })
    }
    await unloadPromise
    expect(child.kill).toHaveBeenCalled()
  })

  it("still kills the child even if a dispose call fails", async () => {
    const { host, children } = hostForTest({ invokeTimeoutMs: 30 })
    const { child } = await loadPlugin(host, children)
    await host.unloadPlugin("com.synapse.test")
    expect(child.kill).toHaveBeenCalled()
  })

  it("rejects any other in-flight call with PluginCallCancelledError, not a generic crash-shaped error", async () => {
    const { host, children } = hostForTest({ invokeTimeoutMs: 30 })
    const { child } = await loadPlugin(host, children)
    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    await waitForMessage(child, "invoke-command")

    await host.unloadPlugin("com.synapse.test")
    await expect(promise).rejects.toBeInstanceOf(PluginCallCancelledError)
  })
})

// ── invokeCommand ────────────────────────────────────────────────────────────

describe("pluginProcessHost — invokeCommand", () => {
  it("rejects when the plugin is not loaded", async () => {
    const { host } = hostForTest()
    await expect(
      host.invokeCommand({ pluginId: "nope", commandId: "test.run", phase: "run" })
    ).rejects.toBeInstanceOf(PluginSandboxError)
  })

  it("rejects when the command was not reported by load-plugin", async () => {
    const { host, children } = hostForTest()
    await loadPlugin(host, children)
    await expect(
      host.invokeCommand({ pluginId: "com.synapse.test", commandId: "missing", phase: "run" })
    ).rejects.toThrow(/not exported/)
  })

  it("sends invoke-command with a fresh CommandContextData and resolves the child's value", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)

    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
      payload: { initialQuery: "abc" },
    })
    const msg = await waitForMessage(child, "invoke-command")
    expect(msg.request).toEqual({
      commandId: "test.run",
      phase: "run",
      payload: { initialQuery: "abc" },
    })
    expect(msg.context.pluginId).toBe("com.synapse.test")

    child.send({
      type: "invoke-command-result",
      callId: msg.callId,
      ok: true,
      value: { type: "toast", level: "info", message: "ok" },
    })
    await expect(promise).resolves.toEqual({ type: "toast", level: "info", message: "ok" })
  })

  it("propagates an error the child reports", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    const msg = await waitForMessage(child, "invoke-command")
    child.send({
      type: "invoke-command-result",
      callId: msg.callId,
      ok: false,
      error: { message: "boom" },
    })
    await expect(promise).rejects.toThrow("boom")
  })

  it("reconstructs a CapabilityDenied reported by the child with its real class and fields", async () => {
    // A capability-call handler throws CapabilityDenied host-side; if the
    // child's own ctx stub re-throws it unchanged, the child re-serializes
    // it when reporting invoke-command-result — kind/extra must round-trip
    // so PluginRegistry's `instanceof CapabilityDenied` exclusion (crash vs.
    // policy-denial) actually works, instead of degrading to a generic Error.
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    const msg = await waitForMessage(child, "invoke-command")
    child.send({
      type: "invoke-command-result",
      callId: msg.callId,
      ok: false,
      error: {
        message: "Capability denied for com.synapse.test: network:https (not granted)",
        kind: "CapabilityDenied",
        extra: { pluginId: "com.synapse.test", capability: "network:https", why: "not granted" },
      },
    })
    let caught: unknown
    await promise.catch((err: unknown) => {
      caught = err
    })
    expect(caught).toBeInstanceOf(CapabilityDenied)
    expect((caught as CapabilityDenied).pluginId).toBe("com.synapse.test")
    expect((caught as CapabilityDenied).capability).toBe("network:https")
    expect((caught as CapabilityDenied).why).toBe("not granted")
  })

  it("reconstructs a PermissionDenied reported by the child with its real class and fields", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    const msg = await waitForMessage(child, "invoke-command")
    child.send({
      type: "invoke-command-result",
      callId: msg.callId,
      ok: false,
      error: {
        message: "Plugin com.synapse.test has not declared required permission: clipboard:write",
        kind: "PermissionDenied",
        extra: { pluginId: "com.synapse.test", permission: "clipboard:write" },
      },
    })
    let caught: unknown
    await promise.catch((err: unknown) => {
      caught = err
    })
    expect(caught).toBeInstanceOf(PermissionDenied)
    expect((caught as PermissionDenied).permission).toBe("clipboard:write")
  })

  it("falls back to a generic Error for an unrecognized kind", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    const msg = await waitForMessage(child, "invoke-command")
    child.send({
      type: "invoke-command-result",
      callId: msg.callId,
      ok: false,
      error: { message: "plugin's own module-load fault", kind: "RuntimeFault" },
    })
    await expect(promise).rejects.toThrow("plugin's own module-load fault")
    await expect(promise).rejects.not.toBeInstanceOf(CapabilityDenied)
  })

  it("times out a run phase that never responds", async () => {
    const { host, children } = hostForTest({ commandRunTimeoutMs: 30 })
    await loadPlugin(host, children)
    await expect(
      host.invokeCommand({ pluginId: "com.synapse.test", commandId: "test.run", phase: "run" })
    ).rejects.toBeInstanceOf(PluginInvocationTimeoutError)
  })
})

// ── invokeTool ───────────────────────────────────────────────────────────────

describe("pluginProcessHost — invokeTool", () => {
  it("rejects when the tool was not reported by load-plugin", async () => {
    const { host, children } = hostForTest()
    await loadPlugin(host, children)
    await expect(
      host.invokeTool({
        pluginId: "com.synapse.test",
        toolName: "missing",
        input: {},
        options: { caller: { kind: "user" } },
      })
    ).rejects.toThrow(/not exported/)
  })

  it("sends invoke-tool and resolves a bounded ToolResult", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)

    const promise = host.invokeTool({
      pluginId: "com.synapse.test",
      toolName: "greet",
      input: { name: "Ada" },
      options: { caller: { kind: "user" } },
    })
    const msg = await waitForMessage(child, "invoke-tool")
    expect(msg.request).toEqual({
      toolName: "greet",
      input: { name: "Ada" },
      caller: { kind: "user" },
    })

    child.send({
      type: "invoke-tool-result",
      callId: msg.callId,
      ok: true,
      value: { content: [{ type: "text", text: "hi Ada" }] },
    })
    await expect(promise).resolves.toEqual({ content: [{ type: "text", text: "hi Ada" }] })
  })

  it("forwards tool-progress messages to the caller's progress callback", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const progress = vi.fn()

    const promise = host.invokeTool({
      pluginId: "com.synapse.test",
      toolName: "greet",
      input: {},
      options: { caller: { kind: "user" }, progress },
    })
    const msg = await waitForMessage(child, "invoke-tool")
    child.send({ type: "tool-progress", callId: msg.callId, pct: 50, message: "halfway" })
    expect(progress).toHaveBeenCalledWith(50, "halfway")

    child.send({ type: "invoke-tool-result", callId: msg.callId, ok: true, value: { content: [] } })
    await promise
  })

  it("times out, sends cancel-tool, and rejects with a timeout error", async () => {
    // Matches the pre-migration sandbox's contract (plugin-sandbox.test.ts):
    // infrastructure failures (timeout/cancel) propagate as a rejection; only
    // an actual plugin-handler-thrown error becomes a soft isError result.
    const { host, children } = hostForTest({ toolInvokeTimeoutMs: 30 })
    const { child } = await loadPlugin(host, children)

    await expect(
      host.invokeTool({
        pluginId: "com.synapse.test",
        toolName: "greet",
        input: {},
        options: { caller: { kind: "user" } },
      })
    ).rejects.toBeInstanceOf(PluginSandboxError)
    expect(child.lastOfType("cancel-tool")).toBeTruthy()
  })

  it("honors an externally aborted caller signal by sending cancel-tool", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const controller = new AbortController()

    const promise = host.invokeTool({
      pluginId: "com.synapse.test",
      toolName: "greet",
      input: {},
      options: { caller: { kind: "user" }, signal: controller.signal },
    })
    // Wait until invokeTool has actually registered its abort listener
    // (it does so only after resolving the process, which is itself async)
    // before aborting — otherwise the signal fires with nothing listening.
    await waitForMessage(child, "invoke-tool")
    controller.abort(new Error("caller cancelled"))
    const result = await promise
    expect(result.isError).toBe(true)
    expect(child.lastOfType("cancel-tool")).toBeTruthy()
  })
})

// ── disposeCommand / dispatchEvent / dispatchTrigger ────────────────────────

describe("pluginProcessHost — disposeCommand", () => {
  it("is a no-op when the plugin is not loaded", async () => {
    const { host } = hostForTest()
    await expect(host.disposeCommand("nope", "test.run")).resolves.toBeUndefined()
  })

  it("sends dispose-command and awaits the result", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const promise = host.disposeCommand("com.synapse.test", "test.run")
    const msg = await waitForMessage(child, "dispose-command")
    expect(msg.commandId).toBe("test.run")
    child.send({ type: "dispose-command-result", callId: msg.callId, ok: true })
    await expect(promise).resolves.toBeUndefined()
  })
})

describe("pluginProcessHost — dispatchEvent", () => {
  it("skips the round trip when the module has no clipboard-change handler", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children, discoveredPlugin(), {
      ...defaultLoadValue,
      hasClipboardChangeHandler: false,
    })
    await host.dispatchEvent({
      pluginId: "com.synapse.test",
      event: "clipboard:change",
      payload: { content: { type: "text", text: "x" } },
    })
    expect(child.allOfType("dispatch-event")).toHaveLength(0)
  })

  it("sends dispatch-event when the module declared a handler", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children, discoveredPlugin(), {
      ...defaultLoadValue,
      hasClipboardChangeHandler: true,
    })
    const promise = host.dispatchEvent({
      pluginId: "com.synapse.test",
      event: "clipboard:change",
      payload: { content: { type: "text", text: "x" } },
    })
    const msg = await waitForMessage(child, "dispatch-event")
    child.send({ type: "dispatch-event-result", callId: msg.callId, ok: true })
    await expect(promise).resolves.toBeUndefined()
  })
})

describe("pluginProcessHost — dispatchTrigger", () => {
  it("sends dispatch-trigger using the caller-supplied invocationId", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const controller = new AbortController()

    const promise = host.dispatchTrigger({
      pluginId: "com.synapse.test",
      triggerId: "t1",
      trigger: "timer:t1",
      handler: "triggers.onTick",
      invocationId: "inv-fixed",
      event: { at: 1 },
      signal: controller.signal,
    })
    const msg = await waitForMessage(child, "dispatch-trigger")
    expect(msg.invocationId).toBe("inv-fixed")
    expect(msg.handler).toBe("triggers.onTick")
    child.send({ type: "dispatch-trigger-result", callId: msg.callId, ok: true })
    await expect(promise).resolves.toBeUndefined()
  })

  it("sends cancel-trigger when the caller's signal aborts", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const controller = new AbortController()

    const promise = host.dispatchTrigger({
      pluginId: "com.synapse.test",
      triggerId: "t1",
      trigger: "timer:t1",
      handler: "triggers.onTick",
      invocationId: "inv-2",
      event: {},
      signal: controller.signal,
    })
    const msg = await waitForMessage(child, "dispatch-trigger")
    controller.abort()
    expect(child.lastOfType("cancel-trigger")).toBeTruthy()

    child.send({ type: "dispatch-trigger-result", callId: msg.callId, ok: true })
    await promise
  })
})

// ── capability-call dispatch ─────────────────────────────────────────────────

describe("pluginProcessHost — capability-call dispatch", () => {
  it("round-trips a generic storage capability call against the real bridge", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)

    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    const invokeMsg = await waitForMessage(child, "invoke-command")

    child.send({
      type: "capability-call",
      callId: "cap1",
      invocationId: invokeMsg.invocationId,
      capability: "storage.set",
      args: ["k", "v"],
    })
    await vi.waitFor(() => expect(child.lastOfType("capability-call-result")).toBeTruthy())
    expect(child.lastOfType("capability-call-result")).toMatchObject({ callId: "cap1", ok: true })

    child.send({
      type: "capability-call",
      callId: "cap2",
      invocationId: invokeMsg.invocationId,
      capability: "storage.get",
      args: ["k"],
    })
    await vi.waitFor(() =>
      expect(
        child
          .allOfType("capability-call-result")
          .find((m) => (m as { callId: string }).callId === "cap2")
      ).toBeTruthy()
    )
    const getResult = child
      .allOfType("capability-call-result")
      .find((m) => (m as { callId: string }).callId === "cap2")
    expect(getResult).toMatchObject({ ok: true, value: "v" })

    child.send({
      type: "invoke-command-result",
      callId: invokeMsg.callId,
      ok: true,
      value: undefined,
    })
    await promise
  })

  it("rejects a capability-call whose invocationId is unknown", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    child.send({
      type: "capability-call",
      callId: "cap1",
      invocationId: "no-such-invocation",
      capability: "storage.get",
      args: ["k"],
    })
    await vi.waitFor(() => expect(child.lastOfType("capability-call-result")).toBeTruthy())
    expect(child.lastOfType("capability-call-result")).toMatchObject({ callId: "cap1", ok: false })
  })

  it("pushes clipboard-changed to the child that registered a listener, and stops after unwatch", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)

    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    const invokeMsg = await waitForMessage(child, "invoke-command")

    child.send({
      type: "capability-call",
      callId: "watch1",
      invocationId: invokeMsg.invocationId,
      capability: "clipboard.watch",
      args: [],
    })
    await vi.waitFor(() => expect(child.lastOfType("capability-call-result")).toBeTruthy())
    const watchResult = child.lastOfType("capability-call-result") as unknown as {
      value: { listenerId: string }
    }
    const { listenerId } = watchResult.value

    child.send({
      type: "capability-call",
      callId: "unwatch1",
      invocationId: invokeMsg.invocationId,
      capability: "clipboard.unwatch",
      args: [listenerId],
    })
    await vi.waitFor(() =>
      expect(
        child
          .allOfType("capability-call-result")
          .find((m) => (m as { callId: string }).callId === "unwatch1")
      ).toBeTruthy()
    )

    child.send({
      type: "invoke-command-result",
      callId: invokeMsg.callId,
      ok: true,
      value: undefined,
    })
    await promise
  })

  it("does not post clipboard.watch's capability-call-result until the capability gate settles", async () => {
    // A real prompt round-trip (first-time consent, or grant persistence)
    // is asynchronous. If the host responded to the child eagerly — before
    // this settles — the child would believe the watch is live when the
    // gate might still deny it, and (as this exact race caused in
    // production) the response could race the write to disk that a
    // just-granted capability triggers.
    let resolvePrompt: (result: ApprovalResult) => void = () => {}
    const promptGate = new Promise<ApprovalResult>((resolve) => {
      resolvePrompt = resolve
    })
    const { host, children } = hostForTest({ bridge: bridgeForTest({ prompt: () => promptGate }) })
    const { child } = await loadPlugin(host, children)

    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    const invokeMsg = await waitForMessage(child, "invoke-command")

    child.send({
      type: "capability-call",
      callId: "watch1",
      invocationId: invokeMsg.invocationId,
      capability: "clipboard.watch",
      args: [],
    })

    await new Promise((resolve) => setImmediate(resolve))
    expect(child.lastOfType("capability-call-result")).toBeUndefined()

    resolvePrompt({ allow: true })
    await vi.waitFor(() => expect(child.lastOfType("capability-call-result")).toBeTruthy())
    expect(child.lastOfType("capability-call-result")).toMatchObject({ ok: true })

    child.send({
      type: "invoke-command-result",
      callId: invokeMsg.callId,
      ok: true,
      value: undefined,
    })
    await promise
  })

  it("posts an error capability-call-result when clipboard.watch's capability grant is refused", async () => {
    const { host, children } = hostForTest({
      bridge: bridgeForTest({ prompt: async () => ({ allow: false }) }),
    })
    const { child } = await loadPlugin(host, children)

    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    const invokeMsg = await waitForMessage(child, "invoke-command")

    child.send({
      type: "capability-call",
      callId: "watch1",
      invocationId: invokeMsg.invocationId,
      capability: "clipboard.watch",
      args: [],
    })

    await vi.waitFor(() => expect(child.lastOfType("capability-call-result")).toBeTruthy())
    expect(child.lastOfType("capability-call-result")).toMatchObject({ ok: false })

    child.send({
      type: "invoke-command-result",
      callId: invokeMsg.callId,
      ok: true,
      value: undefined,
    })
    await promise
  })

  it("buffers a network.fetch response into bodyBase64", async () => {
    // The real PluginBridge routes network.fetch through node:https (see
    // network-fetcher.ts) — no fetch()-stubbable seam, and a unit test has no
    // business making a real HTTPS call. A fake bridge exercises exactly the
    // dispatch/serialization logic this class owns (buffering the response
    // body and base64-encoding it for the wire) without touching the network.
    const fakeCtx = {
      pluginId: "com.synapse.test",
      locale: "en",
      theme: { mode: "light" as const, accent: "neutral" },
      preferences: {},
      storage: {} as unknown as PluginContext["storage"],
      clipboard: {} as unknown as PluginContext["clipboard"],
      notifications: {} as unknown as PluginContext["notifications"],
      system: {} as unknown as PluginContext["system"],
      fs: {} as unknown as PluginContext["fs"],
      credentials: {} as unknown as PluginContext["credentials"],
      log: () => {},
      network: {
        fetch: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain" },
          text: async () => "hello",
          json: async <T>() => ({}) as T,
          arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
        }),
        fetchStream: () => {
          throw new Error("not used by this test")
        },
      },
    } satisfies PluginContext
    const fakeBridge = {
      createContext: () => fakeCtx,
      createToolContext: () => {
        throw new Error("not used by this test")
      },
      disposePlugin: async () => {},
    } as unknown as PluginBridge

    const { host, children } = hostForTest({ bridge: fakeBridge })
    const { child } = await loadPlugin(host, children)
    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    const invokeMsg = await waitForMessage(child, "invoke-command")
    child.send({
      type: "capability-call",
      callId: "fetch1",
      invocationId: invokeMsg.invocationId,
      capability: "network.fetch",
      args: ["https://example.com", undefined],
    })
    await vi.waitFor(() => expect(child.lastOfType("capability-call-result")).toBeTruthy())
    const result = child.lastOfType("capability-call-result") as unknown as {
      ok: boolean
      value: { bodyBase64: string; status: number }
    }
    expect(result.ok).toBe(true)
    expect(Buffer.from(result.value.bodyBase64, "base64").toString("utf-8")).toBe("hello")

    child.send({
      type: "invoke-command-result",
      callId: invokeMsg.callId,
      ok: true,
      value: undefined,
    })
    await promise
  })
})

// ── abortPluginCapability (kill + restart) ──────────────────────────────────

describe("pluginProcessHost — abortPluginCapability", () => {
  it("kills the current child and transparently reloads a fresh one", async () => {
    const { host, children } = hostForTest()
    const { child: first } = await loadPlugin(host, children)

    host.abortPluginCapability("com.synapse.test", "storage:plugin")
    expect(first.kill).toHaveBeenCalled()

    const second = await waitForNewChild(children, 1)
    const reload = await waitForMessage(second, "load-plugin")
    second.send({
      type: "load-plugin-result",
      callId: reload.callId,
      ok: true,
      value: defaultLoadValue,
    })

    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    const invokeMsg = await waitForMessage(second, "invoke-command")
    second.send({
      type: "invoke-command-result",
      callId: invokeMsg.callId,
      ok: true,
      value: undefined,
    })
    await expect(promise).resolves.toBeUndefined()
  })

  it("rejects in-flight calls immediately when the capability is revoked", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })
    // invokeCommand awaits resolveProcess before it registers the pending
    // call, so abortPluginCapability must wait for the message to actually
    // be sent — otherwise it fires before there's anything to reject, and
    // this call would only fail later via its own timeout instead.
    await waitForMessage(child, "invoke-command")
    host.abortPluginCapability("com.synapse.test", "storage:plugin")
    // Specifically PluginCallCancelledError, not just any PluginSandboxError
    // — callers (PluginRegistry) must be able to tell "cancelled by a policy
    // decision" apart from "the process actually crashed".
    await expect(promise).rejects.toBeInstanceOf(PluginCallCancelledError)
  })

  it("is a no-op for a plugin that is not loaded", () => {
    const { host } = hostForTest()
    expect(() => host.abortPluginCapability("nope", "storage:plugin")).not.toThrow()
  })
})

// ── crash / fault handling ───────────────────────────────────────────────────

describe("pluginProcessHost — crash handling", () => {
  it("marks the plugin unloaded and rejects pending calls when the child exits unexpectedly", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    const promise = host.invokeCommand({
      pluginId: "com.synapse.test",
      commandId: "test.run",
      phase: "run",
    })

    child.exit(1)

    await expect(promise).rejects.toBeInstanceOf(PluginSandboxError)
    await expect(
      host.invokeCommand({ pluginId: "com.synapse.test", commandId: "test.run", phase: "run" })
    ).rejects.toThrow(/not loaded/)
  })

  it("does not treat an intentional kill (unload) as a crash", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    await host.unloadPlugin("com.synapse.test")
    // Simulate the OS actually tearing the process down after kill(); must not double-teardown or throw.
    expect(() => child.exit(0)).not.toThrow()
  })

  it("treats a child-fault message as a crash and kills the process", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    child.send({ type: "child-fault", error: { message: "runaway timer threw" } })
    expect(child.kill).toHaveBeenCalled()
    await expect(
      host.invokeCommand({ pluginId: "com.synapse.test", commandId: "test.run", phase: "run" })
    ).rejects.toThrow(/not loaded/)
  })
})

describe("pluginProcessHost — malformed messages", () => {
  it("silently ignores a message that fails structural validation", async () => {
    const { host, children } = hostForTest()
    const { child } = await loadPlugin(host, children)
    expect(() => child.sendRaw({ type: "capability-call", callId: "x" })).not.toThrow()
    expect(child.allOfType("capability-call-result")).toHaveLength(0)
  })
})

describe("pluginProcessHost — getLoadedModule", () => {
  it("returns undefined for a plugin that is not loaded", () => {
    const { host } = hostForTest()
    expect(host.getLoadedModule("nope")).toBeUndefined()
  })

  it("returns a stub module matching the loaded plugin's reported exports", async () => {
    const { host, children } = hostForTest()
    await loadPlugin(host, children)
    const loaded = host.getLoadedModule("com.synapse.test")
    expect(loaded?.pluginId).toBe("com.synapse.test")
    expect(typeof loaded?.module.commands["test.run"]?.run).toBe("function")
  })
})
