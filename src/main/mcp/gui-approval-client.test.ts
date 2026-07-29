import type { AddressInfo, Server, Socket } from "node:net"
import type { CapabilityRequest } from "../plugins/capability-gate"
import type { GrantIdentity } from "../plugins/grant-store"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
import { promises as fs, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createGuiApprovalPort } from "./gui-approval-client"
import { createJsonLineReader, readJsonLine, writeJsonLine } from "./line-delimited-socket"

let dir: string
let portFilePath: string
let server: Server | undefined
let openSockets: Socket[] = []

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-approval-client-"))
  portFilePath = path.join(dir, "mcp-approval.json")
})
afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  openSockets = []
  rmSync(dir, { recursive: true, force: true })
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  server = undefined
})

function identity(): GrantIdentity {
  return {
    pluginId: "com.example.hello",
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "h",
  }
}

function request(): Omit<CapabilityRequest, "signal"> {
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

/** Starts a fake "GUI approval server" that answers every request with
 *  `answer`, and writes the port file the client reads. */
async function startFakeGui(answer: boolean): Promise<void> {
  server = createServer((socket) => {
    openSockets.push(socket)
    void readJsonLine(socket, 2000).then(() => writeJsonLine(socket, { allow: answer }))
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const port = (server!.address() as AddressInfo).port
  await fs.writeFile(portFilePath, JSON.stringify({ port, token: "tok" }))
}

/** Starts a fake "GUI approval server" that accepts the connection,
 *  records every line it receives into `receivedLines`, but never writes
 *  a response — used to prove the client can give up locally (abort or
 *  response timeout) without waiting on a GUI answer that never arrives,
 *  and to observe the cancel frame the client writes in the process. */
async function startSilentFakeGui(receivedLines: unknown[]): Promise<void> {
  server = createServer((socket) => {
    openSockets.push(socket)
    const reader = createJsonLineReader(socket)
    void (async () => {
      for (;;) {
        try {
          receivedLines.push(await reader.next())
        } catch {
          return
        }
      }
    })()
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const port = (server!.address() as AddressInfo).port
  await fs.writeFile(portFilePath, JSON.stringify({ port, token: "tok" }))
}

/** Starts a fake "GUI approval server" that accepts the connection, reads
 *  the request line, then destroys the socket without ever writing a
 *  response — simulates the GUI process crashing/closing mid-request,
 *  after the request was already successfully delivered. */
async function startDisconnectingFakeGui(): Promise<void> {
  server = createServer((socket) => {
    openSockets.push(socket)
    void readJsonLine(socket, 2000).then(() => socket.destroy())
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const port = (server!.address() as AddressInfo).port
  await fs.writeFile(portFilePath, JSON.stringify({ port, token: "tok" }))
}

describe("createGuiApprovalPort — client-disconnected", () => {
  it("a socket that closes after the request was sent resolves 'client-disconnected', not 'send-failed'", async () => {
    await startDisconnectingFakeGui()
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })

    const result = await port.requestApproval({ identity: identity(), request: request() })

    expect(result).toEqual({ allow: false, outcomeReason: "client-disconnected" })
  })

  it("requestHostResourceApproval: a socket that closes after the request was sent resolves 'client-disconnected'", async () => {
    await startDisconnectingFakeGui()
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })

    const result = await port.requestHostResourceApproval({ request: hostResourceRequest() })

    expect(result).toEqual({ allow: false, outcomeReason: "client-disconnected" })
  })
})

describe("createGuiApprovalPort", () => {
  it("resolves true when the GUI is already listening and answers true", async () => {
    await startFakeGui(true)
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({ portFilePath, spawnGui })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toEqual({ allow: true })
    expect(spawnGui).not.toHaveBeenCalled()
  })

  it("resolves false when the GUI is already listening and answers false", async () => {
    await startFakeGui(false)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toEqual({ allow: false })
  })

  it("spawns the GUI and retries until a server appears, then succeeds", async () => {
    const spawnGui = vi.fn(() => {
      // Simulate the GUI taking a moment to come up.
      setTimeout(() => void startFakeGui(true), 150)
    })
    const port = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 3000,
      retryIntervalMs: 50,
    })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toEqual({ allow: true })
    expect(spawnGui).toHaveBeenCalledOnce()
  })

  it("fails closed when nothing ever starts listening before connectTimeoutMs", async () => {
    const spawnGui = vi.fn() // deliberately never actually starts a server
    const port = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 300,
      retryIntervalMs: 50,
    })
    const result = await port.requestApproval({ identity: identity(), request: request() })
    expect(result).toEqual({ allow: false, outcomeReason: "send-failed" })
    expect(spawnGui).toHaveBeenCalledOnce()
  })

  it("fails closed when connected but the GUI never responds before responseTimeoutMs", async () => {
    server = createServer((socket) => {
      openSockets.push(socket)
      socket.on("end", () => socket.destroy())
    })
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
    const port_ = (server!.address() as AddressInfo).port
    await fs.writeFile(portFilePath, JSON.stringify({ port: port_, token: "tok" }))

    const spawnGui = vi.fn()
    const clientPort = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 3000,
      responseTimeoutMs: 200,
    })
    const result = await clientPort.requestApproval({ identity: identity(), request: request() })
    expect(result).toEqual({ allow: false, outcomeReason: "timed-out" })
    // Connected successfully on the first attempt — must not spawn/retry once
    // a connection is established, even though the response itself timed out.
    expect(spawnGui).not.toHaveBeenCalled()
  })
})

describe("createGuiApprovalPort — cancel frame", () => {
  it("aborting the caller signal after the request is sent resolves 'cancelled' locally, without waiting for a GUI response, and writes a cancel frame", async () => {
    const receivedLines: unknown[] = []
    await startSilentFakeGui(receivedLines)
    const controller = new AbortController()

    const resultPromise = createGuiApprovalPort({
      portFilePath,
      spawnGui: vi.fn(),
    }).requestApproval({ identity: identity(), request: request(), signal: controller.signal })

    // Wait for the request frame itself, rather than guessing with a wall-clock
    // delay. On a busy worker, a fixed delay could abort after the connection
    // loop's check but before it installs the in-flight abort listener.
    await vi.waitFor(() => expect(receivedLines).toHaveLength(1))
    controller.abort()

    const result = await resultPromise
    expect(result).toEqual({ allow: false, outcomeReason: "cancelled" })

    await vi.waitFor(() => expect(receivedLines).toHaveLength(2))
    expect(receivedLines[1]).toMatchObject({ type: "cancel", reason: "cancelled" })
  })

  it("responseTimeoutMs elapsing resolves 'timed-out' locally, without a caller signal, and writes a cancel frame", async () => {
    const receivedLines: unknown[] = []
    await startSilentFakeGui(receivedLines)

    const result = await createGuiApprovalPort({
      portFilePath,
      spawnGui: vi.fn(),
      responseTimeoutMs: 100,
    }).requestApproval({ identity: identity(), request: request() })

    expect(result).toEqual({ allow: false, outcomeReason: "timed-out" })

    await vi.waitFor(() => expect(receivedLines).toHaveLength(2))
    expect(receivedLines[1]).toMatchObject({ type: "cancel", reason: "timed-out" })
  })

  it("resolves 'send-failed' when no port file ever appears and connectTimeoutMs elapses without ever reaching a server", async () => {
    const result = await createGuiApprovalPort({
      portFilePath: path.join(dir, "nonexistent-mcp-approval.json"),
      spawnGui: vi.fn(),
      connectTimeoutMs: 100,
      retryIntervalMs: 20,
    }).requestApproval({ identity: identity(), request: request() })

    expect(result).toEqual({ allow: false, outcomeReason: "send-failed" })
  })
})

describe("createGuiApprovalPort — requestHostResourceApproval", () => {
  it("resolves true when the GUI is already listening and answers true", async () => {
    await startFakeGui(true)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestHostResourceApproval({ request: hostResourceRequest() })
    expect(result).toEqual({ allow: true })
  })

  it("resolves false when the GUI is already listening and answers false", async () => {
    await startFakeGui(false)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestHostResourceApproval({ request: hostResourceRequest() })
    expect(result).toEqual({ allow: false })
  })

  it("fails closed when nothing ever starts listening before connectTimeoutMs", async () => {
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 300,
      retryIntervalMs: 50,
    })
    const result = await port.requestHostResourceApproval({ request: hostResourceRequest() })
    expect(result).toEqual({ allow: false, outcomeReason: "send-failed" })
    expect(spawnGui).toHaveBeenCalledOnce()
  })

  it("returns false immediately without connecting when signal is already aborted", async () => {
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({ portFilePath, spawnGui })
    const controller = new AbortController()
    controller.abort()
    const result = await port.requestHostResourceApproval({
      request: hostResourceRequest(),
      signal: controller.signal,
    })
    expect(result).toEqual({ allow: false, outcomeReason: "cancelled" })
    expect(spawnGui).not.toHaveBeenCalled()
  })
})

describe("createGuiApprovalPort — requestPrompt", () => {
  it("resolves true when the GUI is already listening and answers true", async () => {
    await startFakeGui(true)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestPrompt({
      identity: identity(),
      request: request(),
      tier: "consent",
    })
    expect(result).toEqual({ allow: true })
  })

  it("resolves false when the GUI is already listening and answers false", async () => {
    await startFakeGui(false)
    const port = createGuiApprovalPort({ portFilePath, spawnGui: vi.fn() })
    const result = await port.requestPrompt({
      identity: identity(),
      request: request(),
      tier: "consent",
    })
    expect(result).toEqual({ allow: false })
  })

  it("sends the request over the wire as kind: plugin-prompt, carrying identity/request/tier", async () => {
    const receivedLines: unknown[] = []
    await startSilentFakeGui(receivedLines)
    const resultPromise = createGuiApprovalPort({
      portFilePath,
      spawnGui: vi.fn(),
      responseTimeoutMs: 200,
    }).requestPrompt({ identity: identity(), request: request(), tier: "elevated" })

    await vi.waitFor(() => expect(receivedLines).toHaveLength(1))
    expect(receivedLines[0]).toMatchObject({
      kind: "plugin-prompt",
      identity: identity(),
      request: request(),
      tier: "elevated",
    })

    await resultPromise
  })

  it("fails closed when nothing ever starts listening before connectTimeoutMs", async () => {
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({
      portFilePath,
      spawnGui,
      connectTimeoutMs: 300,
      retryIntervalMs: 50,
    })
    const result = await port.requestPrompt({
      identity: identity(),
      request: request(),
      tier: "consent",
    })
    expect(result).toEqual({ allow: false, outcomeReason: "send-failed" })
    expect(spawnGui).toHaveBeenCalledOnce()
  })

  it("returns false immediately without connecting when signal is already aborted", async () => {
    const spawnGui = vi.fn()
    const port = createGuiApprovalPort({ portFilePath, spawnGui })
    const controller = new AbortController()
    controller.abort()
    const result = await port.requestPrompt({
      identity: identity(),
      request: request(),
      tier: "consent",
      signal: controller.signal,
    })
    expect(result).toEqual({ allow: false, outcomeReason: "cancelled" })
    expect(spawnGui).not.toHaveBeenCalled()
  })
})
