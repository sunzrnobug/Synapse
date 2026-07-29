import type { ChildToHostMessage, HostToChildMessage } from "./plugin-ipc-protocol"
import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"
import { createPluginRuntime } from "./plugin-runtime-entry"

function fakePort() {
  const sent: ChildToHostMessage[] = []
  let listener: ((message: HostToChildMessage) => void) | undefined
  return {
    port: {
      postMessage: (message: ChildToHostMessage) => sent.push(message),
      onMessage: (l: (message: HostToChildMessage) => void) => {
        listener = l
      },
    },
    sent,
    send: (message: HostToChildMessage) => listener?.(message),
    lastOfType: (type: string) => [...sent].reverse().find((m) => m.type === type),
    allOfType: (type: string) => sent.filter((m) => m.type === type),
  }
}

function loadValidPlugin(
  harness: ReturnType<typeof fakePort>,
  moduleValue: unknown,
  callId = "load1"
) {
  harness.send({
    type: "load-plugin",
    callId,
    pluginId: "com.example.test",
    rootDir: "/plugins/test",
    mainPath: "/plugins/test/dist/index.js",
    manifest: {
      id: "com.example.test",
    } as unknown as import("@synapse/plugin-manifest").PluginManifest,
  })
}

const commandContext = {
  pluginId: "com.example.test",
  locale: "en",
  theme: { mode: "light" as const, accent: "neutral" },
  preferences: {},
}

const toolContext = { pluginId: "com.example.test", preferences: {} }

describe("createPluginRuntime — load-plugin", () => {
  it("loads a valid module and reports its exported commands/tools/events", () => {
    const harness = fakePort()
    const loadModule = vi.fn(() => ({
      commands: { "a.run": { run: () => ({ type: "toast", level: "info", message: "ok" }) } },
      tools: { greet: () => ({ content: [] }) },
      events: { onClipboardChange: () => {} },
    }))
    createPluginRuntime(harness.port, { loadModule })

    loadValidPlugin(harness, undefined)

    expect(loadModule).toHaveBeenCalledWith("/plugins/test/dist/index.js")
    expect(harness.lastOfType("load-plugin-result")).toEqual({
      type: "load-plugin-result",
      callId: "load1",
      ok: true,
      value: {
        commandIds: ["a.run"],
        toolNames: ["greet"],
        hasClipboardChangeHandler: true,
        triggerHandlerNames: [],
      },
    })
  })

  it("reports hasClipboardChangeHandler: false when there is no events.onClipboardChange", () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, {
      loadModule: () => ({ commands: { "a.run": { run: () => {} } } }),
    })
    loadValidPlugin(harness, undefined)
    expect(harness.lastOfType("load-plugin-result")).toMatchObject({
      ok: true,
      value: {
        commandIds: ["a.run"],
        toolNames: [],
        hasClipboardChangeHandler: false,
        triggerHandlerNames: [],
      },
    })
  })

  it("reports the exported trigger handler names so the host can validate manifest triggers", () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, {
      loadModule: () => ({
        commands: { "a.run": { run: () => {} } },
        triggers: { onTick: () => {}, onDownloads: () => {} },
      }),
    })
    loadValidPlugin(harness, undefined)
    expect(harness.lastOfType("load-plugin-result")).toMatchObject({
      ok: true,
      value: { triggerHandlerNames: ["onTick", "onDownloads"] },
    })
  })

  it("reports failure for a module with no commands object", () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, { loadModule: () => ({}) })
    loadValidPlugin(harness, undefined)
    expect(harness.lastOfType("load-plugin-result")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("commands") },
    })
  })

  it("reports failure when a command handler has no run function", () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, {
      loadModule: () => ({ commands: { "a.run": {} } }),
    })
    loadValidPlugin(harness, undefined)
    expect(harness.lastOfType("load-plugin-result")).toMatchObject({ ok: false })
  })

  it("reports failure when requiring the module throws", () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, {
      loadModule: () => {
        throw new Error("cannot find module")
      },
    })
    loadValidPlugin(harness, undefined)
    expect(harness.lastOfType("load-plugin-result")).toMatchObject({
      ok: false,
      error: { message: "cannot find module" },
    })
  })
})

describe("createPluginRuntime — invoke-command", () => {
  it("dispatches phase 'run' to the command's run() and returns its result", async () => {
    const harness = fakePort()
    const run = vi.fn(() => ({ type: "toast", level: "info", message: "ok" }))
    createPluginRuntime(harness.port, { loadModule: () => ({ commands: { "a.run": { run } } }) })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "invoke-command",
      callId: "c1",
      invocationId: "inv1",
      request: { commandId: "a.run", phase: "run", payload: { initialQuery: "hi" } },
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("invoke-command-result")).toBeDefined())

    expect(run).toHaveBeenCalledWith(
      { commandId: "a.run", initialQuery: "hi" },
      expect.objectContaining({ pluginId: "com.example.test", locale: "en" })
    )
    expect(harness.lastOfType("invoke-command-result")).toEqual({
      type: "invoke-command-result",
      callId: "c1",
      ok: true,
      value: { type: "toast", level: "info", message: "ok" },
    })
  })

  it("dispatches phase 'onSearchChange'", async () => {
    const harness = fakePort()
    const onSearchChange = vi.fn(() => ({ type: "toast", level: "info", message: "changed" }))
    createPluginRuntime(harness.port, {
      loadModule: () => ({ commands: { "a.run": { run: () => {}, onSearchChange } } }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "invoke-command",
      callId: "c2",
      invocationId: "inv1",
      request: { commandId: "a.run", phase: "onSearchChange", payload: "query text" },
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("invoke-command-result")).toBeDefined())

    expect(onSearchChange).toHaveBeenCalledWith("query text", expect.anything())
  })

  it("dispatches phase 'onAction' with actionId/payload split out", async () => {
    const harness = fakePort()
    const onAction = vi.fn(() => undefined)
    createPluginRuntime(harness.port, {
      loadModule: () => ({ commands: { "a.run": { run: () => {}, onAction } } }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "invoke-command",
      callId: "c3",
      invocationId: "inv1",
      request: { commandId: "a.run", phase: "onAction", payload: { actionId: "go", payload: 42 } },
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("invoke-command-result")).toBeDefined())

    expect(onAction).toHaveBeenCalledWith("go", 42, expect.anything())
  })

  it("reports failure for an unexported commandId", async () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, {
      loadModule: () => ({ commands: { "a.run": { run: () => {} } } }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "invoke-command",
      callId: "c4",
      invocationId: "inv1",
      request: { commandId: "missing", phase: "run", payload: undefined },
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("invoke-command-result")).toBeDefined())

    expect(harness.lastOfType("invoke-command-result")).toMatchObject({ ok: false })
  })

  it("reports failure when the handler throws", async () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, {
      loadModule: () => ({
        commands: {
          "a.run": {
            run: () => {
              throw new Error("boom")
            },
          },
        },
      }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "invoke-command",
      callId: "c5",
      invocationId: "inv1",
      request: { commandId: "a.run", phase: "run", payload: undefined },
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("invoke-command-result")).toBeDefined())

    expect(harness.lastOfType("invoke-command-result")).toMatchObject({
      ok: false,
      error: { message: "boom" },
    })
  })
})

describe("createPluginRuntime — dispose-command", () => {
  it("calls dispose() when present and reports success", async () => {
    const harness = fakePort()
    const dispose = vi.fn()
    createPluginRuntime(harness.port, {
      loadModule: () => ({ commands: { "a.run": { run: () => {}, dispose } } }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "dispose-command",
      callId: "d1",
      invocationId: "inv1",
      commandId: "a.run",
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("dispose-command-result")).toBeDefined())

    expect(dispose).toHaveBeenCalled()
    expect(harness.lastOfType("dispose-command-result")).toEqual({
      type: "dispose-command-result",
      callId: "d1",
      ok: true,
    })
  })

  it("is a no-op success when the command has no dispose()", async () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, {
      loadModule: () => ({ commands: { "a.run": { run: () => {} } } }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "dispose-command",
      callId: "d2",
      invocationId: "inv1",
      commandId: "a.run",
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("dispose-command-result")).toBeDefined())

    expect(harness.lastOfType("dispose-command-result")).toEqual({
      type: "dispose-command-result",
      callId: "d2",
      ok: true,
    })
  })
})

describe("createPluginRuntime — invoke-tool", () => {
  it("dispatches to the tool handler and returns its result", async () => {
    const harness = fakePort()
    const greet = vi.fn(() => ({ content: [{ type: "text", text: "hi" }] }))
    createPluginRuntime(harness.port, { loadModule: () => ({ commands: {}, tools: { greet } }) })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "invoke-tool",
      callId: "t1",
      invocationId: "inv1",
      request: { toolName: "greet", input: { name: "world" }, caller: { kind: "agent" } },
      context: toolContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("invoke-tool-result")).toBeDefined())

    expect(greet).toHaveBeenCalledWith(
      { name: "world" },
      expect.objectContaining({ pluginId: "com.example.test", caller: { kind: "agent" } })
    )
    expect(harness.lastOfType("invoke-tool-result")).toEqual({
      type: "invoke-tool-result",
      callId: "t1",
      ok: true,
      value: { content: [{ type: "text", text: "hi" }] },
    })
  })

  it("reports failure for an unexported tool", async () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, { loadModule: () => ({ commands: {}, tools: {} }) })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "invoke-tool",
      callId: "t2",
      invocationId: "inv1",
      request: { toolName: "missing", input: {}, caller: { kind: "agent" } },
      context: toolContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("invoke-tool-result")).toBeDefined())

    expect(harness.lastOfType("invoke-tool-result")).toMatchObject({ ok: false })
  })

  it("forwards ctx.progress() calls as tool-progress messages tagged with the call's callId", async () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, {
      loadModule: () => ({
        commands: {},
        tools: {
          slow: (_input: unknown, ctx: { progress?: (pct: number, message?: string) => void }) => {
            ctx.progress?.(50, "halfway")
            return { content: [] }
          },
        },
      }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "invoke-tool",
      callId: "t3",
      invocationId: "inv1",
      request: { toolName: "slow", input: {}, caller: { kind: "agent" } },
      context: toolContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("invoke-tool-result")).toBeDefined())

    expect(harness.lastOfType("tool-progress")).toEqual({
      type: "tool-progress",
      callId: "t3",
      pct: 50,
      message: "halfway",
    })
  })

  it("aborts the tool's ctx.signal when a cancel-tool message arrives for the same callId", async () => {
    const harness = fakePort()
    let capturedSignal: AbortSignal | undefined
    createPluginRuntime(harness.port, {
      loadModule: () => ({
        commands: {},
        tools: {
          hang: (_input: unknown, ctx: { signal: AbortSignal }) => {
            capturedSignal = ctx.signal
            return new Promise(() => {})
          },
        },
      }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "invoke-tool",
      callId: "t4",
      invocationId: "inv1",
      request: { toolName: "hang", input: {}, caller: { kind: "agent" } },
      context: toolContext,
    })
    await vi.waitFor(() => expect(capturedSignal).toBeDefined())

    harness.send({ type: "cancel-tool", callId: "t4", reason: "timeout" })

    expect(capturedSignal?.aborted).toBe(true)
  })
})

describe("createPluginRuntime — dispatch-event", () => {
  it("dispatches a clipboard:change event to events.onClipboardChange", async () => {
    const harness = fakePort()
    const onClipboardChange = vi.fn()
    createPluginRuntime(harness.port, {
      loadModule: () => ({ commands: {}, events: { onClipboardChange } }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "dispatch-event",
      callId: "e1",
      invocationId: "inv1",
      event: "clipboard:change",
      payload: { type: "text", text: "copied" },
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("dispatch-event-result")).toBeDefined())

    expect(onClipboardChange).toHaveBeenCalledWith(
      { content: { type: "text", text: "copied" } },
      expect.anything()
    )
    expect(harness.lastOfType("dispatch-event-result")).toEqual({
      type: "dispatch-event-result",
      callId: "e1",
      ok: true,
    })
  })

  it("is a no-op success when the module has no onClipboardChange handler", async () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, { loadModule: () => ({ commands: {} }) })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "dispatch-event",
      callId: "e2",
      invocationId: "inv1",
      event: "clipboard:change",
      payload: {},
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("dispatch-event-result")).toBeDefined())

    expect(harness.lastOfType("dispatch-event-result")).toEqual({
      type: "dispatch-event-result",
      callId: "e2",
      ok: true,
    })
  })
})

describe("createPluginRuntime — dispatch-trigger", () => {
  it("resolves 'triggers.<name>' and dispatches the event to it", async () => {
    const harness = fakePort()
    const onTick = vi.fn()
    createPluginRuntime(harness.port, {
      loadModule: () => ({ commands: {}, triggers: { onTick } }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "dispatch-trigger",
      callId: "tr1",
      handler: "triggers.onTick",
      trigger: "timer:t",
      invocationId: "inv1",
      event: { tickCount: 1 },
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("dispatch-trigger-result")).toBeDefined())

    expect(onTick).toHaveBeenCalledWith({ tickCount: 1 }, expect.anything())
    expect(harness.lastOfType("dispatch-trigger-result")).toEqual({
      type: "dispatch-trigger-result",
      callId: "tr1",
      ok: true,
    })
  })

  it("is a no-op success (not an error) when the handler name doesn't resolve to an export", async () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, {
      loadModule: () => ({ commands: {}, triggers: {} }),
    })
    loadValidPlugin(harness, undefined)

    harness.send({
      type: "dispatch-trigger",
      callId: "tr2",
      handler: "triggers.missing",
      trigger: "timer:t",
      invocationId: "inv1",
      event: {},
      context: commandContext,
    })
    await vi.waitFor(() => expect(harness.lastOfType("dispatch-trigger-result")).toBeDefined())

    expect(harness.lastOfType("dispatch-trigger-result")).toEqual({
      type: "dispatch-trigger-result",
      callId: "tr2",
      ok: true,
    })
  })

  it("tolerates a cancel-trigger for a callId with no in-flight dispatch (already finished, or unknown)", () => {
    const harness = fakePort()
    createPluginRuntime(harness.port, { loadModule: () => ({ commands: {}, triggers: {} }) })
    loadValidPlugin(harness, undefined)

    expect(() => harness.send({ type: "cancel-trigger", callId: "never-dispatched" })).not.toThrow()
  })
})

describe("createPluginRuntime — capability-call round trips", () => {
  function primed() {
    const harness = fakePort()
    let ctxCapture: Record<string, unknown> | undefined
    createPluginRuntime(harness.port, {
      loadModule: () => ({
        commands: {
          "a.run": {
            run: (_input: unknown, ctx: Record<string, unknown>) => {
              ctxCapture = ctx
              return { type: "toast", level: "info", message: "ok" }
            },
          },
        },
      }),
    })
    loadValidPlugin(harness, undefined)
    harness.send({
      type: "invoke-command",
      callId: "prime",
      invocationId: "inv1",
      request: { commandId: "a.run", phase: "run", payload: undefined },
      context: commandContext,
    })
    return { harness, ctx: () => ctxCapture! }
  }

  it("storage.get sends a capability-call and resolves with the response value", async () => {
    const { harness, ctx } = primed()
    const storage = ctx().storage as { get: (key: string) => Promise<unknown> }
    const resultPromise = storage.get("k1")

    const call = harness.lastOfType("capability-call")
    expect(call).toMatchObject({ capability: "storage.get", invocationId: "inv1", args: ["k1"] })
    harness.send({
      type: "capability-call-result",
      callId: (call as { callId: string }).callId,
      ok: true,
      value: "stored-value",
    })

    expect(await resultPromise).toBe("stored-value")
  })

  it("rejects with a deserialized Error when the host reports the capability call failed", async () => {
    const { harness, ctx } = primed()
    const storage = ctx().storage as { get: (key: string) => Promise<unknown> }
    const resultPromise = storage.get("k1")
    const call = harness.lastOfType("capability-call") as { callId: string }

    harness.send({
      type: "capability-call-result",
      callId: call.callId,
      ok: false,
      error: { message: "not granted" },
    })

    await expect(resultPromise).rejects.toThrow("not granted")
  })

  it("clipboard.readText/writeText/read/write all forward through capability-call", async () => {
    const { harness, ctx } = primed()
    const clipboard = ctx().clipboard as {
      readText: () => Promise<string>
      writeText: (t: string) => Promise<void>
      read: () => Promise<unknown>
      write: (c: unknown) => Promise<void>
    }
    void clipboard.readText()
    void clipboard.writeText("x")
    void clipboard.read()
    void clipboard.write({ type: "text", text: "x" })

    const capabilities = harness
      .allOfType("capability-call")
      .map((m) => (m as { capability: string }).capability)
    expect(capabilities).toEqual([
      "clipboard.readText",
      "clipboard.writeText",
      "clipboard.read",
      "clipboard.write",
    ])
  })

  it("notifications.show, system.*, fs.*, credentials.* all forward through capability-call with the right names", async () => {
    const { harness, ctx } = primed()
    const c = ctx() as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
    void c.notifications.show({ title: "x" })
    void c.system.openUrl("https://x.test")
    void c.system.openPath("/tmp")
    void c.system.captureScreen()
    void c.fs.resolvePath("root", "a")
    void c.fs.readText("root", "a")
    void c.fs.writeText("root", "a", "data")
    void c.fs.mkdir("root", "a")
    void c.fs.move("root", "a", "root", "b")
    void c.credentials.status("cred1")
    void c.credentials.requestConnect("cred1")
    void (c.log as unknown as (...args: unknown[]) => void)("hello")

    const names = harness
      .allOfType("capability-call")
      .map((m) => (m as { capability: string }).capability)
    expect(names).toEqual([
      "notifications.show",
      "system.openUrl",
      "system.openPath",
      "system.captureScreen",
      "fs.resolvePath",
      "fs.readText",
      "fs.writeText",
      "fs.mkdir",
      "fs.move",
      "credentials.status",
      "credentials.requestConnect",
      "log",
    ])
  })

  it("network.fetch reconstructs a NetworkResponse from the wire payload, including body accessors", async () => {
    const { harness, ctx } = primed()
    const network = ctx().network as {
      fetch: (url: string) => Promise<{
        ok: boolean
        status: number
        text: () => Promise<string>
        json: <T>() => Promise<T>
      }>
    }
    const resultPromise = network.fetch("https://api.example.com/data")
    const call = harness.lastOfType("capability-call") as { callId: string; capability: string }
    expect(call.capability).toBe("network.fetch")

    harness.send({
      type: "capability-call-result",
      callId: call.callId,
      ok: true,
      value: {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({ hello: "world" })).toString("base64"),
      },
    })

    const response = await resultPromise
    expect(response.ok).toBe(true)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"hello":"world"}')
    expect(await response.json()).toEqual({ hello: "world" })
  })
})

describe("createPluginRuntime — clipboard.watch push protocol", () => {
  function primedWithClipboardWatch() {
    const harness = fakePort()
    let watchFn: ((listener: (content: unknown) => void) => () => void) | undefined
    createPluginRuntime(harness.port, {
      loadModule: () => ({
        commands: {
          "a.run": {
            run: (_input: unknown, ctx: { clipboard: { watch: typeof watchFn } }) => {
              watchFn = ctx.clipboard.watch
              return { type: "toast", level: "info", message: "ok" }
            },
          },
        },
      }),
    })
    loadValidPlugin(harness, undefined)
    harness.send({
      type: "invoke-command",
      callId: "prime",
      invocationId: "inv1",
      request: { commandId: "a.run", phase: "run", payload: undefined },
      context: commandContext,
    })
    return { harness, watch: () => watchFn! }
  }

  it("registers the listener once the host confirms the watch, and re-invokes it on clipboard-changed pushes", async () => {
    const { harness, watch } = primedWithClipboardWatch()
    const listener = vi.fn()
    watch()(listener)

    const call = harness.lastOfType("capability-call") as { callId: string; capability: string }
    expect(call.capability).toBe("clipboard.watch")
    harness.send({
      type: "capability-call-result",
      callId: call.callId,
      ok: true,
      value: { listenerId: "listener-1" },
    })
    await vi.waitFor(() => {})

    harness.send({
      type: "clipboard-changed",
      listenerId: "listener-1",
      content: { type: "text", text: "new" },
    })

    expect(listener).toHaveBeenCalledWith({ type: "text", text: "new" })
  })

  it("unsubscribing sends clipboard.unwatch with the registered listenerId", async () => {
    const { harness, watch } = primedWithClipboardWatch()
    const unwatch = watch()(vi.fn())

    const watchCall = harness.lastOfType("capability-call") as { callId: string }
    harness.send({
      type: "capability-call-result",
      callId: watchCall.callId,
      ok: true,
      value: { listenerId: "listener-2" },
    })
    await vi.waitFor(() => {})

    unwatch()

    const unwatchCall = harness
      .allOfType("capability-call")
      .find((m) => (m as { capability: string }).capability === "clipboard.unwatch")
    expect(unwatchCall).toMatchObject({ args: ["listener-2"] })
  })

  it("unsubscribing before the watch registration round trip completes still unwatches on the host once it resolves", async () => {
    const { harness, watch } = primedWithClipboardWatch()
    const unwatch = watch()(vi.fn())
    unwatch() // before the capability-call-result ever arrives

    const watchCall = harness.lastOfType("capability-call") as { callId: string }
    harness.send({
      type: "capability-call-result",
      callId: watchCall.callId,
      ok: true,
      value: { listenerId: "listener-3" },
    })
    await vi.waitFor(() => {
      const unwatchCall = harness
        .allOfType("capability-call")
        .find((m) => (m as { capability: string }).capability === "clipboard.unwatch")
      expect(unwatchCall).toMatchObject({ args: ["listener-3"] })
    })
  })
})

describe("createPluginRuntime — network.fetchStream chunked protocol", () => {
  function primedWithFetchStream() {
    const harness = fakePort()
    let fetchStreamFn:
      | ((url: string) => Promise<{
          body: AsyncIterable<Uint8Array> & { cancel: () => void }
        }>)
      | undefined
    createPluginRuntime(harness.port, {
      loadModule: () => ({
        commands: {
          "a.run": {
            run: (_input: unknown, ctx: { network: { fetchStream: typeof fetchStreamFn } }) => {
              fetchStreamFn = ctx.network.fetchStream
              return { type: "toast", level: "info", message: "ok" }
            },
          },
        },
      }),
    })
    loadValidPlugin(harness, undefined)
    harness.send({
      type: "invoke-command",
      callId: "prime",
      invocationId: "inv1",
      request: { commandId: "a.run", phase: "run", payload: undefined },
      context: commandContext,
    })
    return { harness, fetchStream: () => fetchStreamFn! }
  }

  it("yields chunks pushed by the host and completes on stream-end", async () => {
    const { harness, fetchStream } = primedWithFetchStream()
    const responsePromise = fetchStream()("https://api.example.com/stream")

    const call = harness.lastOfType("capability-call") as {
      callId: string
      capability: string
      args: unknown[]
    }
    expect(call.capability).toBe("network.fetchStream")
    harness.send({
      type: "capability-call-result",
      callId: call.callId,
      ok: true,
      value: { ok: true, status: 200, statusText: "OK", headers: {} },
    })
    const response = await responsePromise
    const streamId = (call.args as unknown as [string, unknown, string])[2]

    const collected: number[][] = []
    const consume = (async () => {
      for await (const chunk of response.body) collected.push([...chunk])
    })()

    harness.send({ type: "stream-chunk", streamId, data: new Uint8Array([1, 2, 3]).buffer })
    harness.send({ type: "stream-chunk", streamId, data: new Uint8Array([4, 5]).buffer })
    harness.send({ type: "stream-end", streamId })
    await consume

    expect(collected).toEqual([
      [1, 2, 3],
      [4, 5],
    ])
  })

  it("cancel() sends stream-cancel and stops iteration", async () => {
    const { harness, fetchStream } = primedWithFetchStream()
    const responsePromise = fetchStream()("https://api.example.com/stream")
    const call = harness.lastOfType("capability-call") as { callId: string; args: unknown[] }
    harness.send({
      type: "capability-call-result",
      callId: call.callId,
      ok: true,
      value: { ok: true, status: 200, statusText: "OK", headers: {} },
    })
    const response = await responsePromise
    const streamId = (call.args as unknown as [string, unknown, string])[2]

    response.body.cancel()

    const cancelMsg = harness.lastOfType("stream-cancel")
    expect(cancelMsg).toEqual({ type: "stream-cancel", streamId })

    const collected: unknown[] = []
    for await (const chunk of response.body) collected.push(chunk)
    expect(collected).toEqual([])
  })

  it("propagates a stream-error as a thrown error from the async iterator", async () => {
    const { harness, fetchStream } = primedWithFetchStream()
    const responsePromise = fetchStream()("https://api.example.com/stream")
    const call = harness.lastOfType("capability-call") as { callId: string; args: unknown[] }
    harness.send({
      type: "capability-call-result",
      callId: call.callId,
      ok: true,
      value: { ok: true, status: 200, statusText: "OK", headers: {} },
    })
    const response = await responsePromise
    const streamId = (call.args as unknown as [string, unknown, string])[2]

    harness.send({ type: "stream-error", streamId, error: { message: "connection reset" } })

    await expect(
      (async () => {
        for await (const _chunk of response.body) {
          // never reached
        }
      })()
    ).rejects.toThrow("connection reset")
  })
})
