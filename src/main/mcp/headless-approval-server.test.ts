import type { ApprovalResult } from "../approvals/types"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startHeadlessApprovalServer } from "./headless-approval-server"
import { readJsonLine, writeJsonLine } from "./line-delimited-socket"

function deferred<T = ApprovalResult>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let dir: string
let portFilePath: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-approval-"))
  portFilePath = path.join(dir, "mcp-approval.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function identity(): GrantIdentity {
  return {
    pluginId: "com.example.hello",
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "h",
  }
}

function capabilityRequest(): CapabilityRequest {
  return {
    capability: "clipboard:watch",
    invocation: {
      source: "tool",
      trigger: "mcp:call",
      caller: { kind: "mcp", principal: { kind: "external-mcp" } },
    },
    operation: "watch",
  }
}

function hostResourceRequest(): HostResourceApprovalRequest {
  return {
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    workspaceName: "My Workspace",
    rootName: "repo",
    uri: "workspace://w1/instructions",
  }
}

async function readEndpoint(): Promise<{ port: number; token: string }> {
  return JSON.parse(readFileSync(portFilePath, "utf-8"))
}

async function connectSocket(port: number) {
  const socket = connect(port, "127.0.0.1")
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  return socket
}

describe("startHeadlessApprovalServer", () => {
  it("forwards a plugin-capability request to approveCapability and returns its answer", async () => {
    const approveCapability = vi.fn(async () => ({ allow: true as const }))
    const approveHostResource = vi.fn(async () => ({ allow: true as const }))
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource,
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-forward-1",
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      const response = await readJsonLine(socket, 2000)
      expect(response).toEqual({ allow: true })
      expect(approveCapability).toHaveBeenCalledWith({
        identity: identity(),
        request: { ...capabilityRequest(), signal: expect.any(AbortSignal) },
      })
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("forwards a plugin-prompt request to promptForGrant and returns its answer", async () => {
    const approveCapability = vi.fn(async () => ({ allow: true as const }))
    const promptForGrant = vi.fn(async () => ({ allow: true as const }))
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource: vi.fn(async () => ({ allow: true as const })),
      promptForGrant,
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-prompt-1",
        kind: "plugin-prompt",
        identity: identity(),
        request: capabilityRequest(),
        tier: "consent",
      })
      const response = await readJsonLine(socket, 2000)
      expect(response).toEqual({ allow: true })
      expect(promptForGrant).toHaveBeenCalledWith({
        identity: identity(),
        request: { ...capabilityRequest(), signal: expect.any(AbortSignal) },
        tier: "consent",
      })
      expect(approveCapability).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false for a malformed plugin-prompt payload (missing tier)", async () => {
    const promptForGrant = vi.fn(async () => ({ allow: true as const }))
    const handle = await startHeadlessApprovalServer({
      approveCapability: vi.fn(async () => ({ allow: true as const })),
      approveHostResource: vi.fn(async () => ({ allow: true as const })),
      promptForGrant,
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-prompt-malformed",
        kind: "plugin-prompt",
        identity: identity(),
        request: capabilityRequest(),
        /* missing tier */
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(promptForGrant).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("forwards a host-resource request to approveHostResource and returns its answer", async () => {
    const approveCapability = vi.fn(async () => ({ allow: true as const }))
    const approveHostResource = vi.fn(async () => ({ allow: true as const }))
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource,
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-forward-2",
        kind: "host-resource",
        request: hostResourceRequest(),
      })
      const response = await readJsonLine(socket, 2000)
      expect(response).toEqual({ allow: true })
      expect(approveHostResource).toHaveBeenCalledWith({
        request: hostResourceRequest(),
        signal: expect.any(AbortSignal),
      })
      expect(approveCapability).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false and calls neither approver when the token is wrong", async () => {
    const approveCapability = vi.fn(async () => ({ allow: true as const }))
    const approveHostResource = vi.fn(async () => ({ allow: true as const }))
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource,
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token: "wrong-token",
        requestId: "req-wrong-token",
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveCapability).not.toHaveBeenCalled()
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false for a malformed plugin-capability payload", async () => {
    const approveCapability = vi.fn(async () => ({ allow: true as const }))
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource: vi.fn(async () => ({ allow: true as const })),
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-malformed-capability",
        kind: "plugin-capability",
        identity: identity() /* missing request */,
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveCapability).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false for a malformed host-resource payload", async () => {
    const approveHostResource = vi.fn(async () => ({ allow: true as const }))
    const handle = await startHeadlessApprovalServer({
      approveCapability: vi.fn(async () => ({ allow: true as const })),
      approveHostResource,
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-malformed-host-resource",
        kind: "host-resource",
        request: {
          resourceType: "workspace-instructions",
          workspaceId: "w1" /* missing rootId etc. */,
        },
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds allow:false for an unrecognized kind", async () => {
    const handle = await startHeadlessApprovalServer({
      approveCapability: vi.fn(async () => ({ allow: true as const })),
      approveHostResource: vi.fn(async () => ({ allow: true as const })),
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-unrecognized-kind",
        kind: "something-else",
        request: {},
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("rejects a host-resource request with an oversized field", async () => {
    const approveHostResource = vi.fn(async () => ({ allow: true as const }))
    const handle = await startHeadlessApprovalServer({
      approveCapability: vi.fn(async () => ({ allow: true as const })),
      approveHostResource,
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-oversized-field",
        kind: "host-resource",
        request: { ...hostResourceRequest(), clientId: "x".repeat(1000) },
      })
      const response = (await readJsonLine(socket, 2000)) as { allow: boolean }
      expect(response.allow).toBe(false)
      expect(approveHostResource).not.toHaveBeenCalled()
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("stops accepting connections after close()", async () => {
    const handle = await startHeadlessApprovalServer({
      approveCapability: async () => ({ allow: true as const }),
      approveHostResource: async () => ({ allow: true as const }),
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    const { port } = await readEndpoint()
    await handle.close()

    const socket = connect(port, "127.0.0.1")
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
    ).rejects.toThrow()
  })
})

describe("cancel frame", () => {
  it("aborts the approver's signal with reason 'cancelled' when a valid cancel frame arrives before the approver resolves", async () => {
    let receivedSignal: AbortSignal | undefined
    const pending = deferred<ApprovalResult>()
    const approveCapability = vi.fn(async ({ request }: { request: CapabilityRequest }) => {
      receivedSignal = request.signal
      return pending.promise
    })
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource: vi.fn(async () => ({ allow: true as const })),
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-cancel-1",
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      writeJsonLine(socket, { type: "cancel", requestId: "req-cancel-1", reason: "cancelled" })
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(receivedSignal?.aborted).toBe(true)
      expect(receivedSignal?.reason).toBe("cancelled")

      pending.resolve({ allow: false as const })
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("responds with the approver's result when it settles before any cancel frame arrives", async () => {
    const handle = await startHeadlessApprovalServer({
      approveCapability: async () => ({ allow: true as const }),
      approveHostResource: vi.fn(async () => ({ allow: true as const })),
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-cancel-2",
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      const response = await readJsonLine(socket, 2000)
      expect(response).toEqual({ allow: true })
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("aborts the approver's signal with reason 'client-disconnected' when the socket is destroyed mid-flight", async () => {
    let receivedSignal: AbortSignal | undefined
    const pending = deferred<ApprovalResult>()
    const approveCapability = vi.fn(async ({ request }: { request: CapabilityRequest }) => {
      receivedSignal = request.signal
      return pending.promise
    })
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource: vi.fn(async () => ({ allow: true as const })),
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-cancel-3",
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      socket.destroy()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(receivedSignal?.aborted).toBe(true)
      expect(receivedSignal?.reason).toBe("client-disconnected")

      pending.resolve({ allow: false as const })
    } finally {
      await handle.close()
    }
  })

  it("aborts the approver's signal with reason 'client-disconnected' when a non-JSON line arrives after the request", async () => {
    let receivedSignal: AbortSignal | undefined
    const pending = deferred<ApprovalResult>()
    const approveCapability = vi.fn(async ({ request }: { request: CapabilityRequest }) => {
      receivedSignal = request.signal
      return pending.promise
    })
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource: vi.fn(async () => ({ allow: true as const })),
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-cancel-non-json",
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      socket.write("not-json\n")
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(receivedSignal?.aborted).toBe(true)
      expect(receivedSignal?.reason).toBe("client-disconnected")

      pending.resolve({ allow: false as const })
      socket.end()
    } finally {
      await handle.close()
    }
  })

  it("aborts the approver's signal with reason 'client-disconnected' when a cancel frame has the wrong requestId", async () => {
    let receivedSignal: AbortSignal | undefined
    const pending = deferred<ApprovalResult>()
    const approveCapability = vi.fn(async ({ request }: { request: CapabilityRequest }) => {
      receivedSignal = request.signal
      return pending.promise
    })
    const handle = await startHeadlessApprovalServer({
      approveCapability,
      approveHostResource: vi.fn(async () => ({ allow: true as const })),
      promptForGrant: vi.fn(async () => ({ allow: true as const })),
      portFilePath,
    })
    try {
      const { port, token } = await readEndpoint()
      const socket = await connectSocket(port)
      writeJsonLine(socket, {
        token,
        requestId: "req-cancel-4",
        kind: "plugin-capability",
        identity: identity(),
        request: capabilityRequest(),
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      writeJsonLine(socket, { type: "cancel", requestId: "wrong-id", reason: "cancelled" })
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(receivedSignal?.aborted).toBe(true)
      expect(receivedSignal?.reason).toBe("client-disconnected")

      pending.resolve({ allow: false as const })
      socket.end()
    } finally {
      await handle.close()
    }
  })
})
