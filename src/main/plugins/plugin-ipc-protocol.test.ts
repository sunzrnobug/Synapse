import { describe, expect, it, vi } from "vitest"
import {
  CAPABILITY_NAMES,
  deserializeError,
  nextCallId,
  parseChildToHostMessage,
  serializeError,
} from "./plugin-ipc-protocol"

describe("nextCallId", () => {
  it("returns a distinct id on every call, prefixed as requested", () => {
    const a = nextCallId("cmd")
    const b = nextCallId("cmd")
    expect(a).not.toBe(b)
    expect(a.startsWith("cmd-")).toBe(true)
    expect(b.startsWith("cmd-")).toBe(true)
  })
})

describe("serializeError", () => {
  it("extracts message and stack from a real Error", () => {
    const err = new Error("boom")
    const serialized = serializeError(err)
    expect(serialized.message).toBe("boom")
    expect(serialized.stack).toBe(err.stack)
  })

  it("duck-types a message off a non-Error object (errors thrown across the child process boundary aren't real Error instances)", () => {
    const serialized = serializeError({ message: "duck-typed" })
    expect(serialized).toEqual({ message: "duck-typed", stack: undefined })
  })

  it("falls back to String() for a value with no message", () => {
    expect(serializeError("just a string").message).toBe("just a string")
    expect(serializeError(42).message).toBe("42")
  })

  it("captures name as kind and extra own string/number/boolean properties", () => {
    // A capability-gate error thrown inside a capability-call handler (or a
    // plugin re-throwing what it caught from ctx.*) needs to survive one or
    // more process hops without plugin-ipc-protocol.ts importing the real
    // host-only error classes — duck-typing name+extra fields is what lets
    // plugin-process-host.ts reconstruct the specific class on the far side.
    class FakeCapabilityDenied extends Error {
      constructor(
        readonly pluginId: string,
        readonly capability: string,
        readonly why: string
      ) {
        super(`Capability denied for ${pluginId}: ${capability} (${why})`)
        this.name = "CapabilityDenied"
      }
    }
    const serialized = serializeError(
      new FakeCapabilityDenied("com.example.test", "network:https", "not granted")
    )
    expect(serialized.kind).toBe("CapabilityDenied")
    expect(serialized.extra).toEqual({
      pluginId: "com.example.test",
      capability: "network:https",
      why: "not granted",
    })
  })

  it('does not set kind for a plain Error (name is just "Error")', () => {
    expect(serializeError(new Error("nope")).kind).toBeUndefined()
  })

  it("omits extra entirely when there are no additional own properties", () => {
    expect(serializeError(new Error("nope")).extra).toBeUndefined()
  })
})

describe("deserializeError", () => {
  it("reconstructs an Error with the original message and stack", () => {
    const err = deserializeError({ message: "boom", stack: "Error: boom\n    at somewhere" })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("boom")
    expect(err.stack).toBe("Error: boom\n    at somewhere")
  })

  it("still produces a usable Error when no stack was captured", () => {
    const err = deserializeError({ message: "boom" })
    expect(err.message).toBe("boom")
  })

  it("defensively ignores a dangerous key in extra even if validation was bypassed", () => {
    // Belt-and-suspenders: parseChildToHostMessage already rejects this shape
    // (see the child-fault tests below), but deserializeError must never
    // trust its input either, since nothing stops a future caller from
    // constructing a SerializedError directly. JSON.parse (like structured
    // clone) defines "__proto__" as a plain OWN property rather than
    // invoking the exotic setter, which is exactly how this would arrive
    // over the wire — a literal `{ __proto__: ... }` in test source would
    // not reproduce that and must not be used here.
    const extra = JSON.parse('{"__proto__": "boom"}') as Record<string, string>
    const err = deserializeError({ message: "boom", extra })
    expect((Object.prototype as unknown as { polluted?: boolean }).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(err)).toBe(Error.prototype)
  })

  it("restores kind as .name and extra as plain own properties", () => {
    // The child re-serializes whatever it catches (e.g. a plugin's own code
    // re-throwing a capability error unchanged) — deserializeError must put
    // kind/extra back as duck-typed data so that second serialization round
    // trip still carries them, all the way to the host's own reconstruction.
    const err = deserializeError({
      message: "Capability denied for com.example.test: network:https (not granted)",
      kind: "CapabilityDenied",
      extra: { pluginId: "com.example.test", capability: "network:https", why: "not granted" },
    })
    expect(err.name).toBe("CapabilityDenied")
    expect((err as unknown as { pluginId: string }).pluginId).toBe("com.example.test")
    expect((err as unknown as { capability: string }).capability).toBe("network:https")
    expect((err as unknown as { why: string }).why).toBe("not granted")
  })
})

describe("parseChildToHostMessage", () => {
  it("rejects non-object input", () => {
    expect(parseChildToHostMessage(null)).toBeUndefined()
    expect(parseChildToHostMessage(undefined)).toBeUndefined()
    expect(parseChildToHostMessage("not an object")).toBeUndefined()
    expect(parseChildToHostMessage(42)).toBeUndefined()
  })

  it("rejects a message with an unrecognized type", () => {
    expect(parseChildToHostMessage({ type: "something-else" })).toBeUndefined()
  })

  it("rejects a message with no type field", () => {
    expect(parseChildToHostMessage({ callId: "c1", ok: true })).toBeUndefined()
  })

  describe("simple result messages (dispose-command-result, dispatch-event-result, dispatch-trigger-result)", () => {
    for (const type of [
      "dispose-command-result",
      "dispatch-event-result",
      "dispatch-trigger-result",
    ] as const) {
      it(`accepts a well-formed ok:true ${type}`, () => {
        expect(parseChildToHostMessage({ type, callId: "c1", ok: true })).toEqual({
          type,
          callId: "c1",
          ok: true,
        })
      })

      it(`accepts a well-formed ok:false ${type} with a SerializedError`, () => {
        const msg = { type, callId: "c1", ok: false, error: { message: "boom" } }
        expect(parseChildToHostMessage(msg)).toEqual(msg)
      })

      it(`rejects ${type} missing callId`, () => {
        expect(parseChildToHostMessage({ type, ok: true })).toBeUndefined()
      })

      it(`rejects ${type} with ok:false and no error`, () => {
        expect(parseChildToHostMessage({ type, callId: "c1", ok: false })).toBeUndefined()
      })

      it(`rejects ${type} with ok:true and an error present (ambiguous)`, () => {
        expect(
          parseChildToHostMessage({ type, callId: "c1", ok: true, error: { message: "x" } })
        ).toBeUndefined()
      })
    }
  })

  describe("invoke-command-result", () => {
    it("accepts a result with an opaque value", () => {
      const msg = { type: "invoke-command-result", callId: "c1", ok: true, value: { any: "shape" } }
      expect(parseChildToHostMessage(msg)).toEqual(msg)
    })

    it("rejects a malformed envelope even with a value present", () => {
      expect(
        parseChildToHostMessage({ type: "invoke-command-result", ok: true, value: {} })
      ).toBeUndefined()
    })
  })

  describe("invoke-tool-result", () => {
    it("accepts a well-formed tool result with text/json/image content blocks", () => {
      const msg = {
        type: "invoke-tool-result",
        callId: "c1",
        ok: true,
        value: {
          content: [
            { type: "text", text: "hi" },
            { type: "json", json: { a: 1 } },
            { type: "image", path: "out.png", mimeType: "image/png" },
          ],
          isError: false,
        },
      }
      expect(parseChildToHostMessage(msg)).toEqual(msg)
    })

    it("rejects a content block with an unrecognized type", () => {
      const msg = {
        type: "invoke-tool-result",
        callId: "c1",
        ok: true,
        value: { content: [{ type: "video", url: "x" }] },
      }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("rejects a content array over the size cap", () => {
      const content = Array.from({ length: 300 }, () => ({ type: "text", text: "x" }))
      const msg = { type: "invoke-tool-result", callId: "c1", ok: true, value: { content } }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("rejects a non-array content field", () => {
      const msg = { type: "invoke-tool-result", callId: "c1", ok: true, value: { content: "nope" } }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("rejects an accessor-backed content property without ever invoking its getter", () => {
      // A plugin's tool handler is untrusted input from the host's point of
      // view even under process isolation — a getter reachable this deep must
      // never execute merely because the host is validating message shape.
      const getterCalls = vi.fn(() => [])
      const value: Record<string, unknown> = {}
      Object.defineProperty(value, "content", { enumerable: true, get: getterCalls })
      const msg = { type: "invoke-tool-result", callId: "c1", ok: true, value }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
      expect(getterCalls).not.toHaveBeenCalled()
    })
  })

  describe("tool-progress", () => {
    it("accepts a well-formed progress report", () => {
      const msg = { type: "tool-progress", callId: "c1", pct: 42, message: "working" }
      expect(parseChildToHostMessage(msg)).toEqual(msg)
    })

    it("accepts a progress report with no message", () => {
      const msg = { type: "tool-progress", callId: "c1", pct: 0 }
      expect(parseChildToHostMessage(msg)).toEqual(msg)
    })

    it("rejects a non-finite pct", () => {
      expect(
        parseChildToHostMessage({ type: "tool-progress", callId: "c1", pct: Number.NaN })
      ).toBeUndefined()
      expect(
        parseChildToHostMessage({
          type: "tool-progress",
          callId: "c1",
          pct: Number.POSITIVE_INFINITY,
        })
      ).toBeUndefined()
    })

    it("rejects a non-string message", () => {
      expect(
        parseChildToHostMessage({ type: "tool-progress", callId: "c1", pct: 1, message: 123 })
      ).toBeUndefined()
    })
  })

  describe("capability-call", () => {
    it("accepts a call naming a real capability", () => {
      const msg = {
        type: "capability-call",
        callId: "c1",
        invocationId: "inv1",
        capability: "storage.get",
        args: ["key"],
      }
      expect(parseChildToHostMessage(msg)).toEqual(msg)
    })

    it("rejects a capability name not on the allowlist — the host dispatcher must never resolve an arbitrary string to a method", () => {
      const msg = {
        type: "capability-call",
        callId: "c1",
        invocationId: "inv1",
        capability: "process.exit",
        args: [],
      }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("rejects an args array over the size cap", () => {
      const msg = {
        type: "capability-call",
        callId: "c1",
        invocationId: "inv1",
        capability: "storage.get",
        args: Array.from({ length: 100 }, (_, i) => i),
      }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("rejects a non-array args field", () => {
      const msg = {
        type: "capability-call",
        callId: "c1",
        invocationId: "inv1",
        capability: "storage.get",
        args: "not-an-array",
      }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("rejects a missing invocationId", () => {
      const msg = { type: "capability-call", callId: "c1", capability: "storage.get", args: [] }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("every name in CAPABILITY_NAMES round-trips through the validator", () => {
      for (const capability of CAPABILITY_NAMES) {
        const msg = {
          type: "capability-call",
          callId: "c1",
          invocationId: "inv1",
          capability,
          args: [],
        }
        expect(parseChildToHostMessage(msg)).toEqual(msg)
      }
    })
  })

  describe("stream-cancel", () => {
    it("accepts a well-formed cancel", () => {
      const msg = { type: "stream-cancel", streamId: "s1" }
      expect(parseChildToHostMessage(msg)).toEqual(msg)
    })

    it("rejects a missing streamId", () => {
      expect(parseChildToHostMessage({ type: "stream-cancel" })).toBeUndefined()
    })
  })

  describe("child-fault", () => {
    it("accepts a well-formed fault", () => {
      const msg = { type: "child-fault", error: { message: "boom" } }
      expect(parseChildToHostMessage(msg)).toEqual(msg)
    })

    it("rejects a fault with a malformed error", () => {
      expect(
        parseChildToHostMessage({ type: "child-fault", error: { message: 123 } })
      ).toBeUndefined()
      expect(parseChildToHostMessage({ type: "child-fault" })).toBeUndefined()
    })

    it("accepts a well-formed error carrying kind and extra", () => {
      const msg = {
        type: "child-fault",
        error: {
          message: "Capability denied for x: network:https (not granted)",
          kind: "CapabilityDenied",
          extra: { pluginId: "com.example.test", capability: "network:https", why: "not granted" },
        },
      }
      expect(parseChildToHostMessage(msg)).toEqual(msg)
    })

    it("rejects an oversized kind string", () => {
      const msg = {
        type: "child-fault",
        error: { message: "x", kind: "y".repeat(10_000) },
      }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("rejects extra with too many keys", () => {
      const extra: Record<string, string> = {}
      for (let i = 0; i < 100; i += 1) extra[`k${i}`] = "v"
      expect(
        parseChildToHostMessage({ type: "child-fault", error: { message: "x", extra } })
      ).toBeUndefined()
    })

    it("rejects extra with a non-string/number/boolean value", () => {
      expect(
        parseChildToHostMessage({
          type: "child-fault",
          error: { message: "x", extra: { nested: { a: 1 } } },
        })
      ).toBeUndefined()
    })

    it("rejects extra carrying a dangerous key (prototype-pollution guard)", () => {
      for (const key of ["__proto__", "constructor", "prototype"]) {
        expect(
          parseChildToHostMessage({
            type: "child-fault",
            error: { message: "x", extra: { [key]: "boom" } },
          })
        ).toBeUndefined()
      }
    })
  })

  describe("load-plugin-result", () => {
    it("accepts a well-formed result", () => {
      const msg = {
        type: "load-plugin-result",
        callId: "c1",
        ok: true,
        value: {
          commandIds: ["a.b"],
          toolNames: ["t1"],
          hasClipboardChangeHandler: false,
          triggerHandlerNames: ["onTick"],
        },
      }
      expect(parseChildToHostMessage(msg)).toEqual(msg)
    })

    it("rejects a value with non-string entries in commandIds", () => {
      const msg = {
        type: "load-plugin-result",
        callId: "c1",
        ok: true,
        value: {
          commandIds: [123],
          toolNames: [],
          hasClipboardChangeHandler: false,
          triggerHandlerNames: [],
        },
      }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("rejects a value missing hasClipboardChangeHandler", () => {
      const msg = {
        type: "load-plugin-result",
        callId: "c1",
        ok: true,
        value: { commandIds: [], toolNames: [], triggerHandlerNames: [] },
      }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("rejects a value with non-string entries in triggerHandlerNames", () => {
      const msg = {
        type: "load-plugin-result",
        callId: "c1",
        ok: true,
        value: {
          commandIds: [],
          toolNames: [],
          hasClipboardChangeHandler: false,
          triggerHandlerNames: [123],
        },
      }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })

    it("rejects a value missing triggerHandlerNames", () => {
      const msg = {
        type: "load-plugin-result",
        callId: "c1",
        ok: true,
        value: { commandIds: [], toolNames: [], hasClipboardChangeHandler: false },
      }
      expect(parseChildToHostMessage(msg)).toBeUndefined()
    })
  })

  it("rejects an oversized id string (denial-of-service guard)", () => {
    const msg = {
      type: "stream-cancel",
      streamId: "x".repeat(10_000),
    }
    expect(parseChildToHostMessage(msg)).toBeUndefined()
  })

  it("rejects an oversized error message", () => {
    const msg = { type: "child-fault", error: { message: "x".repeat(20_000) } }
    expect(parseChildToHostMessage(msg)).toBeUndefined()
  })
})
