import type { Server, Socket } from "node:net"
import type { ApprovalResult } from "../approvals/types"
import type {
  CapabilityApprover,
  CapabilityRequest,
  GrantPromptPort,
} from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest, HostResourceApprover } from "./host-resource-approval"
import { randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import { createServer } from "node:net"
import { parseCancelFrame } from "./approval-cancel-frame"
import { createJsonLineReader, writeJsonLine } from "./line-delimited-socket"

// Listens on a loopback-only, OS-assigned TCP port and forwards each
// approval request to the matching approver — in production, the exact
// same CapabilityIpcService.capabilityApprover / HostResourceIpcService
// .hostResourceApprover the GUI's own in-app prompts already use, so a
// forwarded request renders through the identical renderer dialog. The
// random token written alongside the port number (not loopback-only TCP
// by itself) is the trust boundary: any local process could otherwise
// connect, but only a process able to read this file under userDataDir
// (the same trust boundary this app already uses for other local
// secrets) has the token.
//
// Carries two independent request kinds over one socket/token/spawn/
// timeout/fail-closed implementation: plugin-capability approvals
// (GrantIdentity + CapabilityRequest) and host-resource approvals
// (HostResourceApprovalRequest) — see the spec's "Why this exists" for
// why these two share a transport but nothing else.

const MAX_FIELD_LENGTH = 500

export interface HeadlessApprovalServerOptions {
  approveCapability: CapabilityApprover
  approveHostResource: HostResourceApprover
  /** First-time JIT capability grant decisions (see {@link GrantPromptPort}).
   *  Required, not optional with an auto-allow default: `CapabilityGovernance`'s
   *  own default (`capability-governance.ts`) auto-allows when no `prompt` is
   *  supplied, which is the right fallback for early scaffolding but the wrong
   *  one for a real transport — silently allowing every first-time grant
   *  whenever no GUI is attached defeats "no silent auto-allow" outright. */
  promptForGrant: GrantPromptPort
  portFilePath: string
  /** Time budget for one connection to send a complete request line.
   *  Defaults to 10s — generous for a same-machine round trip, short enough
   *  that a stuck client can't tie up a socket indefinitely. */
  requestTimeoutMs?: number
}

export interface HeadlessApprovalServerHandle {
  close: () => Promise<void>
}

export async function startHeadlessApprovalServer(
  options: HeadlessApprovalServerOptions
): Promise<HeadlessApprovalServerHandle> {
  const token = randomBytes(32).toString("hex")
  const server: Server = createServer((socket) => {
    void handleConnection(socket, token, options)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("headless approval server: expected a TCP AddressInfo")
  }
  await fs.writeFile(options.portFilePath, JSON.stringify({ port: address.port, token }), {
    mode: 0o600,
  })

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function handleConnection(
  socket: Socket,
  token: string,
  options: HeadlessApprovalServerOptions
): Promise<void> {
  const reader = createJsonLineReader(socket)
  try {
    const payload = await reader.next(options.requestTimeoutMs ?? 10_000)
    const parsed = parsePayload(payload)
    if (!parsed || parsed.token !== token) {
      writeJsonLine(socket, { allow: false, error: "unauthorized" })
      return
    }

    const connectionController = new AbortController()
    const onSocketEnd = (): void => connectionController.abort("client-disconnected")
    socket.once("error", onSocketEnd)
    socket.once("close", onSocketEnd)

    const approverPromise =
      parsed.kind === "plugin-capability"
        ? options.approveCapability({
            identity: parsed.identity,
            request: { ...parsed.request, signal: connectionController.signal },
          })
        : parsed.kind === "plugin-prompt"
          ? options.promptForGrant({
              identity: parsed.identity,
              request: { ...parsed.request, signal: connectionController.signal },
              tier: parsed.tier,
            })
          : options.approveHostResource({
              request: parsed.request,
              signal: connectionController.signal,
            })

    const cancelWatchPromise = (async (): Promise<"cancel" | undefined> => {
      let line: unknown
      try {
        line = await reader.next()
      } catch {
        connectionController.abort("client-disconnected")
        return undefined
      }
      const frame = parseCancelFrame(line, parsed.requestId)
      if (frame) {
        connectionController.abort(frame.reason)
        return "cancel"
      }
      // Any other line on this connection is a protocol error — tear down.
      connectionController.abort("client-disconnected")
      return undefined
    })()

    const winner = await Promise.race([
      approverPromise.then((result) => ({ kind: "approved" as const, result })),
      cancelWatchPromise.then((outcome) => ({ kind: "cancel" as const, outcome })),
    ])

    socket.off("error", onSocketEnd)
    socket.off("close", onSocketEnd)

    if (winner.kind === "approved") {
      // Cast anticipates approvers returning the richer ApprovalResult shape
      // (Task 10) — today both approvers only ever resolve `boolean`.
      const result = winner.result as boolean | ApprovalResult
      const allow = typeof result === "boolean" ? result : result.allow
      const outcomeReason =
        typeof result !== "boolean" && !result.allow && "outcomeReason" in result
          ? result.outcomeReason
          : undefined
      writeJsonLine(socket, { allow, ...(outcomeReason ? { outcomeReason } : {}) })
    }
  } catch (err) {
    writeJsonLine(socket, { allow: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    reader.dispose()
    socket.end()
  }
}

type ParsedPayload =
  | {
      token: string
      kind: "plugin-capability"
      requestId: string
      identity: GrantIdentity
      request: CapabilityRequest
    }
  | {
      token: string
      kind: "plugin-prompt"
      requestId: string
      identity: GrantIdentity
      request: CapabilityRequest
      tier: string
    }
  | {
      token: string
      kind: "host-resource"
      requestId: string
      request: HostResourceApprovalRequest
    }

function parsePayload(value: unknown): ParsedPayload | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  if (typeof v.token !== "string") return undefined
  if (typeof v.requestId !== "string" || v.requestId.length === 0) return undefined
  if (v.kind === "plugin-capability") return parseCapabilityPayload(v)
  if (v.kind === "plugin-prompt") return parsePromptPayload(v)
  if (v.kind === "host-resource") return parseHostResourcePayload(v)
  return undefined
}

/** Shared by plugin-capability and plugin-prompt — both carry a GrantIdentity
 *  plus a CapabilityRequest; plugin-prompt additionally carries a tier. */
function parseIdentityAndRequest(
  v: Record<string, unknown>
): { identity: GrantIdentity; request: CapabilityRequest } | undefined {
  if (!v.identity || typeof v.identity !== "object") return undefined
  if (!v.request || typeof v.request !== "object") return undefined
  const request = v.request as Record<string, unknown>
  if (typeof request.capability !== "string") return undefined
  if (typeof request.operation !== "string") return undefined
  if (!request.invocation || typeof request.invocation !== "object") return undefined
  const invocation = request.invocation as Record<string, unknown>
  if (typeof invocation.trigger !== "string") return undefined
  if (invocation.source === "tool") {
    if (!invocation.caller || typeof invocation.caller !== "object") return undefined
  } else if (invocation.source === "runless") {
    if (typeof invocation.actor !== "string") return undefined
  } else {
    return undefined
  }
  return {
    identity: v.identity as GrantIdentity,
    request: request as unknown as CapabilityRequest,
  }
}

function parseCapabilityPayload(
  v: Record<string, unknown>
): Extract<ParsedPayload, { kind: "plugin-capability" }> | undefined {
  const parsed = parseIdentityAndRequest(v)
  if (!parsed) return undefined
  return {
    token: v.token as string,
    kind: "plugin-capability",
    requestId: v.requestId as string,
    identity: parsed.identity,
    request: parsed.request,
  }
}

function parsePromptPayload(
  v: Record<string, unknown>
): Extract<ParsedPayload, { kind: "plugin-prompt" }> | undefined {
  if (typeof v.tier !== "string" || v.tier.length === 0) return undefined
  const parsed = parseIdentityAndRequest(v)
  if (!parsed) return undefined
  return {
    token: v.token as string,
    kind: "plugin-prompt",
    requestId: v.requestId as string,
    identity: parsed.identity,
    request: parsed.request,
    tier: v.tier,
  }
}

function parseHostResourcePayload(
  v: Record<string, unknown>
): Extract<ParsedPayload, { kind: "host-resource" }> | undefined {
  if (!v.request || typeof v.request !== "object") return undefined
  const r = v.request as Record<string, unknown>
  const requiredStrings = [
    r.resourceType,
    r.workspaceId,
    r.rootId,
    r.workspaceName,
    r.rootName,
    r.uri,
  ]
  if (requiredStrings.some((field) => typeof field !== "string")) return undefined
  if (r.resourceType !== "workspace-instructions") return undefined
  const optionalStrings = [r.clientId, r.reason]
  if (optionalStrings.some((field) => field !== undefined && typeof field !== "string"))
    return undefined
  const allStrings = [...requiredStrings, ...optionalStrings].filter(
    (field): field is string => typeof field === "string"
  )
  if (allStrings.some((field) => field.length > MAX_FIELD_LENGTH)) return undefined
  return {
    token: v.token as string,
    kind: "host-resource",
    requestId: v.requestId as string,
    request: r as unknown as HostResourceApprovalRequest,
  }
}
