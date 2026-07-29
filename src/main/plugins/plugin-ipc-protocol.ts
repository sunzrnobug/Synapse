import type { PluginManifest } from "@synapse/plugin-manifest"
import type { ToolCaller, ToolContentBlock } from "@synapse/plugin-sdk"

/**
 * Message shapes exchanged between the host process and a plugin's
 * `utilityProcess` child over a `MessagePortMain`. Plugin code runs in its
 * own OS process here (Critical #1 — see plugin-process-host.ts, not yet
 * written) instead of a `node:vm` context in the host process: there is no
 * shared V8 heap, `require` cache, or object graph, so the ORIGINAL escape
 * this replaces (a captured host function reference reaching the HOST's
 * real `process`/`require` via `Function.constructor`, from inside the
 * host's own memory space) has nothing to capture.
 *
 * Capability-gate state (grants, prompts, budgets, `CapabilityGovernance`)
 * stays entirely host-side. The child only ever carries opaque ids
 * (`pluginId`, `invocationId`, `callId`) — never a real host object,
 * function reference, or secret. Every capability call the child's thin
 * `ctx` stub makes is a plain, serializable request; the host looks up the
 * real `PluginBridge`-backed implementation itself.
 *
 * IMPORTANT — what this protocol alone does NOT provide: OS-process
 * isolation only guarantees the plugin can't reach INTO the host's memory.
 * It says nothing about what the plugin can reach from INSIDE its own
 * process. Unless plugin-runtime-entry.ts (not yet written) also restricts
 * the child's own Node environment — e.g. by intercepting `require`/
 * `Module._load` before the plugin's code loads so `require("fs")`,
 * `require("child_process")`, `require("net")`, etc. are unavailable or
 * shimmed, and by minimizing the child's inherited environment variables —
 * a plugin running in this child has completely unrestricted, ungated
 * access to the real filesystem, network, environment, and process APIs.
 * It would have no NEED to go through the capability-call protocol below
 * at all, and every capability gate this design relies on would be
 * bypassable by the plugin simply choosing not to use `ctx`. Closing that
 * gap is a hard requirement for this migration to actually deliver its
 * stated security goal, not an optional hardening pass — it is unresolved
 * as of this file; do not treat process isolation alone as "done."
 */

// ── Command / tool / event / trigger invocation (host -> child) ──────────

/**
 * `pluginId`/`locale`/`theme`/`preferences` are host-computed state
 * (settings, manifest defaults + user overrides) `PluginContext` needs but
 * the child has no other way to obtain — `PluginBridge.createContext()`
 * used to compute these directly, in-process; now the host must send a
 * fresh snapshot with every invocation that builds a full `PluginContext`
 * (commands, clipboard-change events, triggers). Tool contexts
 * (`ToolContext extends Omit<PluginContext, "locale"|"theme">`) only need
 * `preferences` — see `ToolContextData`.
 */
export interface CommandContextData {
  pluginId: string
  locale: string
  theme: { mode: "light" | "dark"; accent: string }
  preferences: Record<string, unknown>
}

export interface ToolContextData {
  pluginId: string
  preferences: Record<string, unknown>
}

export interface InvokeCommandWireRequest {
  commandId: string
  phase: "run" | "onSearchChange" | "onAction"
  payload?: unknown
}

export interface InvokeCommandMessage {
  type: "invoke-command"
  callId: string
  /** Tags every capability-call this invocation's ctx methods make, so the
   *  host can look up the InvocationContext (grants/audit/budget) it built
   *  when it sent this message — never sent to the child itself. */
  invocationId: string
  request: InvokeCommandWireRequest
  context: CommandContextData
}

export interface DisposeCommandMessage {
  type: "dispose-command"
  callId: string
  invocationId: string
  commandId: string
  context: CommandContextData
}

export interface InvokeToolWireRequest {
  toolName: string
  input: unknown
  caller: ToolCaller
}

export interface InvokeToolMessage {
  type: "invoke-tool"
  callId: string
  invocationId: string
  request: InvokeToolWireRequest
  context: ToolContextData
}

/** Host tells the child to abort a tool's `ctx.signal` (timeout or caller cancel). */
export interface CancelToolMessage {
  type: "cancel-tool"
  callId: string
  reason?: string
}

export interface DispatchEventMessage {
  type: "dispatch-event"
  callId: string
  invocationId: string
  event: "clipboard:change"
  payload: unknown
  context: CommandContextData
}

export interface DispatchTriggerMessage {
  type: "dispatch-trigger"
  callId: string
  /** Manifest handler path, e.g. "triggers.onTick". */
  handler: string
  trigger: string
  invocationId: string
  event: unknown
  context: CommandContextData
}

/** Host tells the child to abort a trigger dispatch's signal. */
export interface CancelTriggerMessage {
  type: "cancel-trigger"
  callId: string
}

// ── Results (child -> host) ───────────────────────────────────────────────

export interface SerializedError {
  message: string
  stack?: string
  /**
   * The original error's `.name` (e.g. "CapabilityDenied") — duck-typed, not
   * a class reference, so this shared protocol file never needs to import
   * host-only error classes (capability-gate.ts, permissions.ts) into the
   * child's bundle. Lets a HOST-side boundary (plugin-process-host.ts,
   * which already imports those classes for other reasons) reconstruct the
   * specific error type after it has crossed one or more process hops —
   * without this, a CapabilityDenied thrown inside a capability-call
   * handler degrades to a generic Error by the time it reaches
   * PluginRegistry, which then misclassifies a policy denial as a crash.
   */
  kind?: string
  /** Additional own string/number/boolean properties the original error
   *  carried (e.g. CapabilityDenied's pluginId/capability/why,
   *  PermissionDenied's pluginId/permission) — also duck-typed. */
  extra?: Record<string, string | number | boolean>
}

export interface InvokeCommandResultMessage {
  type: "invoke-command-result"
  callId: string
  ok: boolean
  /** A `View | void` on success. */
  value?: unknown
  error?: SerializedError
}

export interface DisposeCommandResultMessage {
  type: "dispose-command-result"
  callId: string
  ok: boolean
  error?: SerializedError
}

export interface InvokeToolResultMessage {
  type: "invoke-tool-result"
  callId: string
  ok: boolean
  value?: { content: ToolContentBlock[]; isError?: boolean; structured?: unknown }
  error?: SerializedError
}

export interface DispatchEventResultMessage {
  type: "dispatch-event-result"
  callId: string
  ok: boolean
  error?: SerializedError
}

export interface DispatchTriggerResultMessage {
  type: "dispatch-trigger-result"
  callId: string
  ok: boolean
  error?: SerializedError
}

/** Reports `ctx.progress(pct, message)` for an in-flight tool call. */
export interface ToolProgressMessage {
  type: "tool-progress"
  callId: string
  pct: number
  message?: string
}

// ── Generic capability calls (child -> host -> child) ────────────────────

/**
 * Every `ctx.*` method that is plain data in/out — `storage.get`,
 * `clipboard.readText`, `fs.move`, `credentials.status`, etc. — is a single
 * request/response round trip through this generic envelope. `capability`
 * is a dot-path into the ctx object (e.g. `"storage.get"`); `args` is the
 * method's argument list. The host's dispatcher (plugin-process-host.ts)
 * maps `capability` to the real `PluginBridge`-backed implementation —
 * this is the ONLY place gate/grant/audit logic runs, matching the
 * pre-migration design where the sandbox called `PluginBridge` directly.
 */
export interface CapabilityCallMessage {
  type: "capability-call"
  callId: string
  invocationId: string
  capability: string
  args: unknown[]
}

export interface CapabilityCallResultMessage {
  type: "capability-call-result"
  callId: string
  ok: boolean
  value?: unknown
  error?: SerializedError
}

// ── clipboard.watch (push-based; no listener function crosses the boundary) ──

/** Host -> child: the OS clipboard changed for a listener this child registered. */
export interface ClipboardChangedMessage {
  type: "clipboard-changed"
  listenerId: string
  content: unknown
}

// ── network.fetchStream (chunked; the request itself is one capability call) ──

export interface StreamChunkMessage {
  type: "stream-chunk"
  streamId: string
  /** Transferred as an ArrayBuffer over MessagePortMain, not base64. */
  data: ArrayBuffer
}

export interface StreamEndMessage {
  type: "stream-end"
  streamId: string
}

export interface StreamErrorMessage {
  type: "stream-error"
  streamId: string
  error: SerializedError
}

/** Child -> host: stop reading, release the in-flight slot (NetworkStreamBody.cancel()). */
export interface StreamCancelMessage {
  type: "stream-cancel"
  streamId: string
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export interface LoadPluginMessage {
  type: "load-plugin"
  callId: string
  pluginId: string
  rootDir: string
  mainPath: string
  manifest: PluginManifest
}

export interface LoadPluginResultMessage {
  type: "load-plugin-result"
  callId: string
  ok: boolean
  /** Command ids, tool names, and trigger export names the loaded module
   *  actually exports — lets the host validate manifest triggers/commands/
   *  tools against reality without the real functions ever crossing over. */
  value?: {
    commandIds: string[]
    toolNames: string[]
    hasClipboardChangeHandler: boolean
    triggerHandlerNames: string[]
  }
  error?: SerializedError
}

/** Unhandled error in the child (e.g. a runaway timer callback throwing) — not
 *  tied to any in-flight call. The host treats this like a crash. */
export interface ChildFaultMessage {
  type: "child-fault"
  error: SerializedError
}

export type HostToChildMessage =
  | LoadPluginMessage
  | InvokeCommandMessage
  | DisposeCommandMessage
  | InvokeToolMessage
  | CancelToolMessage
  | DispatchEventMessage
  | DispatchTriggerMessage
  | CancelTriggerMessage
  | CapabilityCallResultMessage
  | ClipboardChangedMessage
  | StreamChunkMessage
  | StreamEndMessage
  | StreamErrorMessage

export type ChildToHostMessage =
  | LoadPluginResultMessage
  | InvokeCommandResultMessage
  | DisposeCommandResultMessage
  | InvokeToolResultMessage
  | ToolProgressMessage
  | DispatchEventResultMessage
  | DispatchTriggerResultMessage
  | CapabilityCallMessage
  | StreamCancelMessage
  | ChildFaultMessage

let callIdCounter = 0

/** Monotonic per-process call ids — readable in logs, unlike a UUID, and
 *  cheaper than crypto.randomUUID() for a value that's never a secret and
 *  never crosses a trust boundary (child and host each mint their own). */
export function nextCallId(prefix: string): string {
  callIdCounter += 1
  return `${prefix}-${callIdCounter}`
}

/** Own-property keys that would reach the prototype chain (or otherwise
 *  aren't plain data) if ever copied onto a live object via `Object.assign`/
 *  `Object.defineProperty` — rejected outright rather than merely skipped,
 *  since a message trying to smuggle one of these is itself a signal
 *  something is wrong upstream. */
const DANGEROUS_EXTRA_KEYS = new Set(["__proto__", "constructor", "prototype"])

export function serializeError(err: unknown): SerializedError {
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    const obj = err as Record<string, unknown>
    const stack = obj.stack
    const name = obj.name
    // "Error" is the default/uninformative name every plain Error carries —
    // only a real, more specific name is worth round-tripping as `kind`.
    const kind = typeof name === "string" && name !== "Error" ? name : undefined
    const extra: Record<string, string | number | boolean> = {}
    for (const key of Object.keys(obj)) {
      if (key === "message" || key === "stack" || key === "name") continue
      const value = obj[key]
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        extra[key] = value
      }
    }
    return {
      message: obj.message as string,
      stack: typeof stack === "string" ? stack : undefined,
      kind,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    }
  }
  return { message: String(err) }
}

/** Reconstruct an Error from a wire-transferred SerializedError, preserving
 *  the original stack for host-side logs when available. */
export function deserializeError(serialized: SerializedError): Error {
  const err = new Error(serialized.message)
  if (serialized.stack) err.stack = serialized.stack
  if (serialized.kind) err.name = serialized.kind
  if (serialized.extra) {
    // Never blindly Object.assign an externally-sourced bag onto a live
    // object — parseChildToHostMessage already rejects a dangerous key
    // (__proto__/constructor/prototype) upstream, but this function must
    // not rely on always being called after that gate.
    for (const [key, value] of Object.entries(serialized.extra)) {
      if (DANGEROUS_EXTRA_KEYS.has(key)) continue
      Object.defineProperty(err, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
  }
  return err
}

// ── Runtime validation for messages arriving from the child ──────────────
//
// TypeScript types are erased at runtime and enforce nothing on a message
// that actually crosses the process boundary — a compromised or merely
// buggy child process is untrusted input from the host's point of view,
// exactly like any other IPC sender. `parseChildToHostMessage` is the gate
// every message from a plugin's utilityProcess must pass before the host's
// dispatcher (plugin-process-host.ts, not yet written) acts on it: right
// shape, right types, and bounded sizes so a malformed or oversized message
// can't wedge the host's call-tracking state or exhaust memory.
//
// This validates STRUCTURE, not tool-result content safety in depth — the
// pre-migration sandbox's `cloneToolResultInContext`/`boundNonStreamingToolResult`
// (plugin-sandbox.ts) additionally guarded against a plugin returning a
// Proxy/accessor-backed object; `MessagePortMain`'s structured clone can't
// carry a live Proxy or getter across a process boundary the way `node:vm`
// could within one, so that specific attack is closed by construction here,
// but the same JSON-shape/size validation `boundNonStreamingToolResult`
// already does downstream still applies on top of this structural check.

const MAX_ID_LENGTH = 200
const MAX_MESSAGE_LENGTH = 8_000
const MAX_ARGS = 32
const MAX_CONTENT_BLOCKS = 256

/** Every `ctx.*` method reachable through the generic capability-call
 *  envelope — the host dispatcher's allowlist. A `capability-call` naming
 *  anything else is rejected here, before it ever reaches a dispatch table
 *  that might (through a bug) resolve an unintended host method by string. */
export const CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  "storage.get",
  "storage.set",
  "storage.delete",
  "storage.list",
  "clipboard.read",
  "clipboard.write",
  "clipboard.watch",
  "clipboard.unwatch",
  "clipboard.readText",
  "clipboard.writeText",
  "notifications.show",
  "system.openUrl",
  "system.openPath",
  "system.captureScreen",
  "network.fetch",
  "network.fetchStream",
  "fs.resolvePath",
  "fs.readText",
  "fs.writeText",
  "fs.mkdir",
  "fs.move",
  "credentials.status",
  "credentials.requestConnect",
  "log",
])

function isString(v: unknown, maxLen = MAX_ID_LENGTH): v is string {
  return typeof v === "string" && v.length <= maxLen
}

function isNonEmptyString(v: unknown, maxLen = MAX_ID_LENGTH): v is string {
  return isString(v, maxLen) && v.length > 0
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean"
}

/** Rejects an accessor descriptor (`get`/`set`) before its value is ever
 *  read — the caller must branch on this before touching `.value`. */
function isDataDescriptor(
  descriptor: PropertyDescriptor
): descriptor is PropertyDescriptor & { value: unknown } {
  return "value" in descriptor
}

const MAX_EXTRA_KEYS = 16

function isSerializedError(v: unknown): v is SerializedError {
  if (!v || typeof v !== "object") return false
  const e = v as Record<string, unknown>
  if (!isNonEmptyString(e.message, MAX_MESSAGE_LENGTH)) return false
  if (e.stack !== undefined && !isString(e.stack, MAX_MESSAGE_LENGTH)) return false
  if (e.kind !== undefined && !isNonEmptyString(e.kind)) return false
  if (e.extra !== undefined && !isValidExtra(e.extra)) return false
  return true
}

function isValidExtra(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_EXTRA_KEYS) return false
  for (const [key, val] of entries) {
    if (!isNonEmptyString(key) || DANGEROUS_EXTRA_KEYS.has(key)) return false
    if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") return false
    if (typeof val === "string" && val.length > MAX_MESSAGE_LENGTH) return false
  }
  return true
}

/** Every result message shares `{ callId, ok, error? }`; `ok: false` requires
 *  a valid SerializedError, `ok: true` must not carry one (unambiguous). */
function hasValidResultEnvelope(v: Record<string, unknown>): boolean {
  if (!isNonEmptyString(v.callId)) return false
  if (!isBoolean(v.ok)) return false
  if (v.ok) return v.error === undefined
  return isSerializedError(v.error)
}

function isToolContentBlock(v: unknown): boolean {
  if (!v || typeof v !== "object") return false
  const b = v as Record<string, unknown>
  if (b.type === "text") return isString(b.text, MAX_MESSAGE_LENGTH)
  if (b.type === "json") return true
  if (b.type === "image") return isNonEmptyString(b.path) && isNonEmptyString(b.mimeType, 200)
  return false
}

export function parseChildToHostMessage(raw: unknown): ChildToHostMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const v = raw as Record<string, unknown>
  if (!isString(v.type, 64)) return undefined

  switch (v.type) {
    case "load-plugin-result": {
      if (!hasValidResultEnvelope(v)) return undefined
      if (v.value !== undefined) {
        const value = v.value as Record<string, unknown>
        if (!value || typeof value !== "object") return undefined
        if (
          !Array.isArray(value.commandIds) ||
          value.commandIds.length > MAX_ARGS ||
          !value.commandIds.every((id) => isString(id))
        )
          return undefined
        if (
          !Array.isArray(value.toolNames) ||
          value.toolNames.length > MAX_ARGS ||
          !value.toolNames.every((id) => isString(id))
        )
          return undefined
        if (!isBoolean(value.hasClipboardChangeHandler)) return undefined
        if (
          !Array.isArray(value.triggerHandlerNames) ||
          value.triggerHandlerNames.length > MAX_ARGS ||
          !value.triggerHandlerNames.every((id) => isString(id))
        )
          return undefined
      }
      return v as unknown as LoadPluginResultMessage
    }

    case "invoke-command-result":
    case "dispose-command-result":
    case "dispatch-event-result":
    case "dispatch-trigger-result": {
      if (!hasValidResultEnvelope(v)) return undefined
      return v as unknown as ChildToHostMessage
    }

    case "invoke-tool-result": {
      if (!hasValidResultEnvelope(v)) return undefined
      if (v.value !== undefined) {
        const value = v.value as Record<string, unknown>
        if (!value || typeof value !== "object") return undefined
        // Read via property descriptors, never direct member access: a
        // compromised/buggy child is untrusted input, and an accessor this
        // deep (e.g. a tool handler's returned object) must never execute
        // merely because the host is validating message shape.
        const contentDescriptor = Object.getOwnPropertyDescriptor(value, "content")
        if (!contentDescriptor || !isDataDescriptor(contentDescriptor)) return undefined
        const content: unknown = contentDescriptor.value
        if (!Array.isArray(content) || content.length > MAX_CONTENT_BLOCKS) return undefined
        for (let i = 0; i < content.length; i += 1) {
          const blockDescriptor = Object.getOwnPropertyDescriptor(content, i)
          if (!blockDescriptor || !isDataDescriptor(blockDescriptor)) return undefined
          if (!isToolContentBlock(blockDescriptor.value)) return undefined
        }
        const isErrorDescriptor = Object.getOwnPropertyDescriptor(value, "isError")
        if (isErrorDescriptor !== undefined) {
          if (!isDataDescriptor(isErrorDescriptor) || !isBoolean(isErrorDescriptor.value))
            return undefined
        }
      }
      return v as unknown as InvokeToolResultMessage
    }

    case "tool-progress": {
      if (!isNonEmptyString(v.callId)) return undefined
      if (typeof v.pct !== "number" || !Number.isFinite(v.pct)) return undefined
      if (v.message !== undefined && !isString(v.message, MAX_MESSAGE_LENGTH)) return undefined
      return v as unknown as ToolProgressMessage
    }

    case "capability-call": {
      if (!isNonEmptyString(v.callId)) return undefined
      if (!isNonEmptyString(v.invocationId)) return undefined
      if (!isString(v.capability, 100) || !CAPABILITY_NAMES.has(v.capability)) return undefined
      if (!Array.isArray(v.args) || v.args.length > MAX_ARGS) return undefined
      return v as unknown as CapabilityCallMessage
    }

    case "stream-cancel": {
      if (!isNonEmptyString(v.streamId)) return undefined
      return v as unknown as StreamCancelMessage
    }

    case "child-fault": {
      if (!isSerializedError(v.error)) return undefined
      return v as unknown as ChildFaultMessage
    }

    default:
      return undefined
  }
}
