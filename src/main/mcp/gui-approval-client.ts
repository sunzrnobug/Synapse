import type { Socket } from "node:net"
import type { ApprovalOutcomeReason, ApprovalResult } from "../approvals/types"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { connect } from "node:net"
import { createJsonLineReader, writeJsonLine } from "./line-delimited-socket"

export interface GuiApprovalRequest {
  identity: GrantIdentity
  request: Omit<CapabilityRequest, "signal">
  /** Local to this process only — never serialized. Watched to decide
   *  when to write a cancel frame on the already-open socket. AbortSignal
   *  is not JSON-serializable; the request body stays signal-free
   *  (stripSignal() at the call site is correct and stays). */
  signal?: AbortSignal
}

export interface GuiPromptRequest {
  identity: GrantIdentity
  request: Omit<CapabilityRequest, "signal">
  /** First-time-grant tier ("consent" | "elevated"), surfaced to the GUI
   *  prompt dialog. */
  tier: string
  /** Local to this process only — never serialized. Same role as
   *  {@link GuiApprovalRequest.signal}. */
  signal?: AbortSignal
}

export interface GuiApprovalPort {
  requestApproval: (input: GuiApprovalRequest) => Promise<ApprovalResult>
  requestPrompt: (input: GuiPromptRequest) => Promise<ApprovalResult>
  requestHostResourceApproval: (input: {
    request: HostResourceApprovalRequest
    /** Local to this process only — never serialized. Watched to decide
     *  when to write a cancel frame on the already-open socket, or (if
     *  still connecting) to give up on the connect/retry/wait loop
     *  early. Does NOT itself reach the GUI process — a request already
     *  sent and already showing a dialog is unaffected until the cancel
     *  frame arrives. */
    signal?: AbortSignal
  }) => Promise<ApprovalResult>
}

export interface GuiApprovalClientOptions {
  portFilePath: string
  /** Launches (or, if a second instance, causes Electron's existing
   *  single-instance handling to focus) the GUI process. Called at most
   *  once per request call — only when the first connection attempt
   *  fails. */
  spawnGui: () => void
  /** Total time budget for getting a TCP connection established (spawning
   *  and retrying included). Does NOT bound how long a human takes to
   *  answer once connected — see responseTimeoutMs. */
  connectTimeoutMs?: number
  /** Time budget for a response once connected. */
  responseTimeoutMs?: number
  /** Test seam: overrides the retry poll interval (default 300ms). */
  retryIntervalMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_INTERVAL_MS = 300

export function createGuiApprovalPort(options: GuiApprovalClientOptions): GuiApprovalPort {
  return {
    requestApproval: (input) =>
      sendPayload(
        { kind: "plugin-capability", identity: input.identity, request: input.request },
        options,
        input.signal
      ),
    requestPrompt: (input) =>
      sendPayload(
        {
          kind: "plugin-prompt",
          identity: input.identity,
          request: input.request,
          tier: input.tier,
        },
        options,
        input.signal
      ),
    requestHostResourceApproval: (input) =>
      sendPayload({ kind: "host-resource", request: input.request }, options, input.signal),
  }
}

type OutgoingPayload =
  | {
      kind: "plugin-capability"
      identity: GrantIdentity
      request: Omit<CapabilityRequest, "signal">
    }
  | {
      kind: "plugin-prompt"
      identity: GrantIdentity
      request: Omit<CapabilityRequest, "signal">
      tier: string
    }
  | { kind: "host-resource"; request: HostResourceApprovalRequest }

async function sendPayload(
  payload: OutgoingPayload,
  options: GuiApprovalClientOptions,
  signal?: AbortSignal
): Promise<ApprovalResult> {
  if (signal?.aborted) return { allow: false, outcomeReason: "cancelled" }

  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const deadline = Date.now() + connectTimeoutMs

  let spawned = false
  let connected: { socket: Socket; token: string } | undefined
  for (;;) {
    if (signal?.aborted) return { allow: false, outcomeReason: "cancelled" }
    const endpoint = await readEndpoint(options.portFilePath)
    if (endpoint) {
      try {
        const socket = await tryConnect(endpoint.port, perAttemptTimeoutMs(deadline))
        connected = { socket, token: endpoint.token }
        break
      } catch {
        // Not up yet, or refused — fall through to spawn+retry below.
      }
    }
    if (!spawned) {
      spawned = true
      options.spawnGui()
    }
    if (Date.now() >= deadline) return { allow: false, outcomeReason: "send-failed" }
    await sleep(Math.min(retryIntervalMs, Math.max(0, deadline - Date.now())))
  }

  // Connected: from here on, any failure is fail-closed directly — never
  // loop back into spawn/retry, which would either double-prompt the user
  // or hang further. A response timeout or caller abort at this point
  // writes a best-effort cancel frame on the still-open socket so the GUI
  // side can drop its own pending prompt instead of leaving it hanging.
  const requestId = randomUUID()
  const reader = createJsonLineReader(connected.socket)
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  try {
    try {
      writeJsonLine(connected.socket, { token: connected.token, requestId, ...payload })
    } catch {
      // The request itself never made it onto the wire — this is the only
      // path that means "never delivered", so it's the only path that
      // should ever produce "send-failed".
      return { allow: false, outcomeReason: "send-failed" }
    }

    // reader.next() waits indefinitely here — the response timeout below
    // is the sole timeout authority, so there is exactly one setTimeout
    // race decision (not two racing timers on the same delay). If the
    // socket closes/errors after the request was already sent, that's a
    // disconnect, not a failure to send — reader.next() rejecting here
    // maps to "client-disconnected", distinct from the pre-send failure
    // above.
    const responsePromise = reader
      .next()
      .then((value) => ({ kind: "response" as const, value }))
      .catch(() => ({ kind: "client-disconnected" as const }))
    const timeoutPromise = new Promise<{ kind: "timed-out" }>((resolve) => {
      timeoutTimer = setTimeout(resolve, responseTimeoutMs, { kind: "timed-out" })
    })
    const abortPromise = signal ? waitForAbort(signal) : new Promise<never>(() => {})

    const winner = await Promise.race([responsePromise, timeoutPromise, abortPromise])

    if (winner.kind === "response") return parseResponse(winner.value)
    if (winner.kind === "client-disconnected") {
      return { allow: false, outcomeReason: "client-disconnected" }
    }

    try {
      writeJsonLine(connected.socket, { type: "cancel", requestId, reason: winner.kind })
    } catch {
      // Best-effort — the caller already has a definitive local outcome
      // regardless of whether the cancel frame actually reached the GUI
      // side.
    }
    return { allow: false, outcomeReason: winner.kind }
  } finally {
    clearTimeout(timeoutTimer)
    reader.dispose()
    connected.socket.end()
  }
}

/**
 * Turn an AbortSignal into a promise without missing an abort that happened
 * while the socket was being opened or the request frame was being written.
 * Checking only before the connection loop is insufficient: a caller can
 * abort after that check but before an event listener is installed.
 */
function waitForAbort(signal: AbortSignal): Promise<{ kind: "cancelled" }> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort)
      resolve({ kind: "cancelled" })
    }
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function parseResponse(value: unknown): ApprovalResult {
  const response = (value ?? {}) as { allow?: unknown; outcomeReason?: unknown }
  if (response.allow === true) return { allow: true }
  if (typeof response.outcomeReason === "string") {
    return { allow: false, outcomeReason: response.outcomeReason as ApprovalOutcomeReason }
  }
  return { allow: false }
}

function perAttemptTimeoutMs(deadline: number): number {
  return Math.max(200, Math.min(2000, deadline - Date.now()))
}

async function readEndpoint(
  portFilePath: string
): Promise<{ port: number; token: string } | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(portFilePath, "utf-8")) as Record<string, unknown>
    if (typeof raw.port !== "number" || typeof raw.token !== "string") return undefined
    return { port: raw.port, token: raw.token }
  } catch {
    return undefined
  }
}

function tryConnect(port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("connect timed out"))
    }, timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
