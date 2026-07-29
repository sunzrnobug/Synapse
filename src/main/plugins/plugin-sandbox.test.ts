import type { DiscoveredPlugin, PluginManifest } from "./types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CapabilityDenied } from "./capability-gate"
import { PluginBridge } from "./plugin-bridge"
import { PluginInvocationTimeoutError, PluginSandbox, PluginSandboxError } from "./plugin-sandbox"
import { createInProcessPluginFork } from "./test-support/in-process-plugin-fork"

// Critical #1 migrated plugin execution from a `node:vm` context in the host
// process to a real `utilityProcess` child (see plugin-process-host.ts /
// plugin-runtime-entry.ts). PluginSandbox is now a thin, stable-signature
// wrapper — its own dispatch/protocol/timeout logic is exhaustively covered
// by plugin-process-host.test.ts against a fake ChildProcessHandle.
//
// These tests instead exercise the FULL, real, end-to-end path: real plugin
// code (written to a temp file, actually `require()`d) running through the
// real PluginBridge, via `createInProcessPluginFork()` — a test double that
// runs the real `plugin-runtime-entry.ts` logic in this same process instead
// of forking an actual OS process (Electron's utilityProcess doesn't exist
// under Vitest). This proves the wrapper wires bridge/context/dispatch
// together correctly; it is not a substitute for the real inter-process
// isolation guarantee, which can only be verified against a real
// utilityProcess (a manual Electron dogfooding pass, per the migration plan).
//
// Two categories of pre-migration test were dropped entirely, not adapted:
//   - "no Node globals inside the sandbox": the whole point of this migration
//     is that plugin code now has full, unrestricted Node access — isolation
//     comes from the OS process boundary, not from hiding globals. Asserting
//     `typeof require === "undefined"` would now be simply false, and
//     asserting otherwise would misrepresent the design.
//   - synchronous infinite loops (`while (true) {}`) at load time or inside a
//     command/tool: in production these hang only the CHILD process — the
//     HOST's own wall-clock timeout (a real, separate process's event loop)
//     still fires normally, so nothing needs to be specifically tested here.
//     `createInProcessPluginFork()` runs the "child" on the SAME thread as
//     the test, so such a loop would hang the entire test run instead of
//     demonstrating anything.

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-sandbox-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("pluginSandbox", () => {
  it("loads a CommonJS plugin and invokes command hooks", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run(input) {
        return { type: "list", items: [{ id: "run", title: input.commandId, actions: [] }] }
      },
      onSearchChange(text) {
        return { type: "toast", level: "info", message: text }
      },
      onAction(actionId, payload) {
        return { type: "toast", level: "success", message: actionId + ":" + payload.value }
      }
    }
  }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeCommand({ pluginId: entry.pluginId, commandId: "test.run", phase: "run" })
    ).resolves.toMatchObject({ type: "list" })
    await expect(
      sandbox.invokeCommand({
        pluginId: entry.pluginId,
        commandId: "test.run",
        phase: "onSearchChange",
        payload: "abc",
      })
    ).resolves.toEqual({ type: "toast", level: "info", message: "abc" })
    await expect(
      sandbox.invokeCommand({
        pluginId: entry.pluginId,
        commandId: "test.run",
        phase: "onAction",
        payload: { actionId: "save", payload: { value: "42" } },
      })
    ).resolves.toEqual({ type: "toast", level: "success", message: "save:42" })
  })

  it("rejects invoking a command that is not exported", async () => {
    const entry = await writePlugin(`
module.exports = { commands: { "test.run": { run() { return { type: "toast", message: "x" } } } } }
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeCommand({ pluginId: entry.pluginId, commandId: "missing", phase: "run" })
    ).rejects.toBeInstanceOf(PluginSandboxError)
  })

  it("times out commands that never resolve", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run() {
        return new Promise(() => {})
      }
    }
  }
}
`)
    const sandbox = sandboxForTest(5)
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeCommand({ pluginId: entry.pluginId, commandId: "test.run", phase: "run" })
    ).rejects.toBeInstanceOf(PluginInvocationTimeoutError)
  })

  it("gives command run a longer budget than search/action hooks", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run() {
        return new Promise((resolve) => setTimeout(() => resolve({ type: "toast", message: "ok" }), 40))
      },
      onSearchChange() {
        return new Promise(() => {})
      }
    }
  }
}
`)
    const sandbox = sandboxForTest(20, 2000, 2000, 100)
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeCommand({
        pluginId: entry.pluginId,
        commandId: "test.run",
        phase: "onSearchChange",
        payload: "q",
      })
    ).rejects.toBeInstanceOf(PluginInvocationTimeoutError)

    await expect(
      sandbox.invokeCommand({ pluginId: entry.pluginId, commandId: "test.run", phase: "run" })
    ).resolves.toEqual({ type: "toast", message: "ok" })
  })

  it("rejects loading a plugin whose entry has no commands object", async () => {
    const entry = await writePlugin("module.exports = { commands: {} }")
    const sandbox = sandboxForTest()

    // An empty commands object is structurally valid (normalizePluginModule
    // in plugin-runtime-entry.ts only requires each declared command to
    // have a run function) — loading succeeds with zero exported commands.
    await expect(sandbox.loadPlugin(entry)).resolves.toMatchObject({ pluginId: entry.pluginId })

    // A distinct rootDir/pluginId — require() caches by absolute path, so
    // reusing writePlugin()'s fixed path here would just replay entry's
    // already-cached (valid) module instead of exercising this shape.
    const rootDir = path.join(dir, "plugin-no-commands")
    await fs.mkdir(path.join(rootDir, "dist"), { recursive: true })
    await fs.writeFile(path.join(rootDir, "dist", "index.js"), "module.exports = {}", "utf-8")
    const noCommandsAtAll: DiscoveredPlugin = {
      pluginId: "com.synapse.test2",
      rootDir,
      source: { kind: "dev", priority: 1 },
      status: "valid",
      manifest: { ...manifest(), id: "com.synapse.test2" },
    }
    await expect(sandbox.loadPlugin(noCommandsAtAll)).rejects.toBeInstanceOf(PluginSandboxError)
  })

  it("dispatches clipboard change events to plugin handlers", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: {
    "test.run": {
      run() {
        return { type: "toast", level: "info", message: "ok" }
      }
    }
  },
  events: {
    async onClipboardChange(event, ctx) {
      const entries = (await ctx.storage.get("entries")) ?? []
      await ctx.storage.set("entries", entries.concat(event.content.text))
    }
  }
}
`)
    entry.manifest!.capabilities = [{ id: "storage:plugin" }]
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)
    await sandbox.dispatchEvent({
      pluginId: entry.pluginId,
      event: "clipboard:change",
      payload: { content: { type: "text", text: "hello" } },
    })

    const raw = await fs.readFile(path.join(dir, "plugin-data", "com.synapse.test.json"), "utf-8")
    const stored = JSON.parse(raw) as unknown
    expect(stored).toEqual({ entries: ["hello"] })
  })

  it("dispatchTrigger runs the manifest-named export with the safe event", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  triggers: {
    async onTick(event, ctx) {
      const prev = (await ctx.storage.get("calls")) ?? []
      await ctx.storage.set("calls", prev.concat([event]))
    }
  }
}
`)
    entry.manifest!.capabilities = [{ id: "storage:plugin" }]
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)
    await sandbox.dispatchTrigger({
      pluginId: entry.pluginId,
      triggerId: "t",
      trigger: "timer:t",
      handler: "triggers.onTick",
      invocationId: "inv-1",
      event: { firedAt: 5 },
      signal: new AbortController().signal,
    })
    const raw = await fs.readFile(path.join(dir, "plugin-data", "com.synapse.test.json"), "utf-8")
    expect(JSON.parse(raw)).toEqual({ calls: [{ firedAt: 5 }] })
  })

  it("dispatchTrigger is a no-op when the named handler is missing", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  triggers: {}
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)
    await expect(
      sandbox.dispatchTrigger({
        pluginId: entry.pluginId,
        triggerId: "t",
        trigger: "timer:t",
        handler: "triggers.onMissing",
        invocationId: "inv-1",
        event: {},
        signal: new AbortController().signal,
      })
    ).resolves.toBeUndefined()
  })

  it("invokes a tool and returns its result, exposing the caller in ctx", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  tools: {
    echo(input, ctx) {
      return { content: [{ type: "json", json: { input, caller: ctx.caller.kind } }] }
    }
  }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    const result = await sandbox.invokeTool({
      pluginId: entry.pluginId,
      toolName: "echo",
      input: { value: 1 },
      options: { caller: { kind: "agent", conversationId: "c1" } },
    })

    expect(result).toEqual({
      content: [{ type: "json", json: { input: { value: 1 }, caller: "agent" } }],
    })
  })

  it("rejects a result whose content is an accessor, without ever invoking it", async () => {
    // parseChildToHostMessage (plugin-ipc-protocol.ts) reads `content` via
    // Object.getOwnPropertyDescriptor and rejects a non-data descriptor
    // before ever touching `.value` — the malformed invoke-tool-result is
    // dropped at the wire layer, which leaves this call to time out rather
    // than resolve softly. The security property under test — the getter is
    // never invoked — must hold either way; only the failure mode changed
    // from the pre-migration vm sanitizer's synchronous throw.
    const entry = await writePlugin(`
globalThis.toolContentGetterCalls = 0
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", message: "x" } } } },
  tools: {
    accessor() {
      const result = {}
      Object.defineProperty(result, "content", {
        enumerable: true,
        get() { globalThis.toolContentGetterCalls += 1; return [] }
      })
      return result
    },
    count() {
      return { content: [{ type: "text", text: String(globalThis.toolContentGetterCalls) }] }
    }
  }
}
`)
    // Only the tool-invoke budget is under test; keep load/invoke generous.
    const sandbox = sandboxForTest(2000, 2000, 30)
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeTool({
        pluginId: entry.pluginId,
        toolName: "accessor",
        input: {},
        options: { caller: { kind: "agent" } },
      })
    ).rejects.toBeInstanceOf(PluginSandboxError)

    await expect(
      sandbox.invokeTool({
        pluginId: entry.pluginId,
        toolName: "count",
        input: {},
        options: { caller: { kind: "agent" } },
      })
    ).resolves.toMatchObject({ content: [{ type: "text", text: "0" }] })
  })

  it("surfaces a thrown handler error as an error result", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  tools: { boom() { throw new Error("nope") } }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    const result = await sandbox.invokeTool({
      pluginId: entry.pluginId,
      toolName: "boom",
      input: {},
      options: { caller: { kind: "agent" } },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: "text", text: "nope" })
  })

  it("times out a tool that never resolves", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  tools: { hang() { return new Promise(() => {}) } }
}
`)
    // Only the tool-invoke budget (5ms) is under test; keep load/invoke generous
    // so the load step does not flake under CPU load.
    const sandbox = sandboxForTest(2000, 2000, 5)
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeTool({
        pluginId: entry.pluginId,
        toolName: "hang",
        input: {},
        options: { caller: { kind: "agent" } },
      })
    ).rejects.toBeInstanceOf(PluginSandboxError)
  })

  it("honours an already-aborted caller signal", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  tools: { hang() { return new Promise(() => {}) } }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeTool({
        pluginId: entry.pluginId,
        toolName: "hang",
        input: {},
        options: { caller: { kind: "agent" }, signal: AbortSignal.abort() },
      })
    ).rejects.toBeTruthy()
  })

  it("rejects when the tool is not exported", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeTool({
        pluginId: entry.pluginId,
        toolName: "missing",
        input: {},
        options: { caller: { kind: "agent" } },
      })
    ).rejects.toBeInstanceOf(PluginSandboxError)
  })

  it("gates the tool context to the tool's declared permissions", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "x" } } } },
  tools: {
    async write(_input, ctx) {
      await ctx.clipboard.writeText("hi")
      return { content: [{ type: "text", text: "wrote" }] }
    }
  }
}
`)
    // Plugin is granted clipboard:write, but the tool declares no capabilities,
    // so its context must be gated down and deny the write.
    //
    // The denial is thrown host-side inside a capability-call handler, sent
    // to the child as a SerializedError, re-thrown by the child's ctx stub,
    // and re-serialized again when the tool handler doesn't catch it —
    // reconstructError (plugin-process-host.ts) restores the real
    // CapabilityDenied instance from the kind/extra fields serializeError/
    // deserializeError carry across each hop (plugin-ipc-protocol.ts), so
    // this matches the pre-migration same-process behavior exactly.
    entry.manifest!.capabilities = [{ id: "clipboard:write" }]
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    await expect(
      sandbox.invokeTool({
        pluginId: entry.pluginId,
        toolName: "write",
        input: {},
        capabilities: [],
        options: { caller: { kind: "agent" } },
      })
    ).rejects.toBeInstanceOf(CapabilityDenied)
  })

  it("abortPluginCapability lets the plugin keep working afterward (transparent reload)", async () => {
    const entry = await writePlugin(`
module.exports = {
  commands: { "test.run": { run() { return { type: "toast", level: "info", message: "ok" } } } }
}
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    expect(() => sandbox.abortPluginCapability(entry.pluginId, "storage:plugin")).not.toThrow()

    await expect(
      sandbox.invokeCommand({ pluginId: entry.pluginId, commandId: "test.run", phase: "run" })
    ).resolves.toEqual({ type: "toast", level: "info", message: "ok" })
  })

  it("getLoadedModule reflects the loaded plugin's exports, undefined once unloaded", async () => {
    const entry = await writePlugin(`
module.exports = { commands: { "test.run": { run() { return { type: "toast", message: "x" } } } } }
`)
    const sandbox = sandboxForTest()
    await sandbox.loadPlugin(entry)

    expect(sandbox.getLoadedModule(entry.pluginId)?.pluginId).toBe(entry.pluginId)

    await sandbox.unloadPlugin(entry.pluginId)
    expect(sandbox.getLoadedModule(entry.pluginId)).toBeUndefined()
  })

  it("uses the injected forkProcess instead of the real utilityProcess default", async () => {
    const entry = await writePlugin(`
module.exports = { commands: { "test.run": { run() { return { type: "toast", message: "x" } } } } }
`)
    let calls = 0
    const forkProcess = ((entryScriptPath: string, pluginId: string) => {
      calls += 1
      return createInProcessPluginFork()(entryScriptPath, pluginId)
    }) as ReturnType<typeof createInProcessPluginFork>
    const sandbox = new PluginSandbox({
      bridge: bridgeForTest(),
      forkProcess,
    })

    await sandbox.loadPlugin(entry)
    expect(calls).toBe(1)
  })
})

function bridgeForTest(): PluginBridge {
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
  })
}

// Default budgets are generous so normal (non-timeout) cases stay reliable when
// the test run saturates the CPU; the timeout-behavior tests pass explicit
// small values to trigger the timeouts they assert.
function sandboxForTest(
  invokeTimeoutMs = 2000,
  loadTimeoutMs = 2000,
  toolInvokeTimeoutMs = 2000,
  commandRunTimeoutMs = 2000
): PluginSandbox {
  return new PluginSandbox({
    bridge: bridgeForTest(),
    invokeTimeoutMs,
    loadTimeoutMs,
    toolInvokeTimeoutMs,
    commandRunTimeoutMs,
    forkProcess: createInProcessPluginFork(),
  })
}

async function writePlugin(code: string): Promise<DiscoveredPlugin> {
  const rootDir = path.join(dir, "plugin")
  await fs.mkdir(path.join(rootDir, "dist"), { recursive: true })
  await fs.writeFile(path.join(rootDir, "dist", "index.js"), code, "utf-8")
  return {
    pluginId: "com.synapse.test",
    rootDir,
    source: { kind: "dev", priority: 1 },
    status: "valid",
    manifest: manifest(),
  }
}

function manifest(): PluginManifest {
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
    capabilities: [],
  } as unknown as PluginManifest
}
