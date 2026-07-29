import type { HostResourceApprovalRequestEvent } from "../ipc/host-resources"
import type { HostResourceApprovalRequest } from "./host-resource-approval"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HostResourceIpcService } from "../ipc/host-resources"
import { createGuiApprovalPort } from "./gui-approval-client"
import { startHeadlessApprovalServer } from "./headless-approval-server"

let dir: string
let portFilePath: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-e2e-"))
  portFilePath = path.join(dir, "mcp-approval.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function request(): HostResourceApprovalRequest {
  return {
    resourceType: "workspace-instructions",
    workspaceId: "w1",
    rootId: "r1",
    workspaceName: "My Workspace",
    rootName: "repo",
    uri: "workspace://w1/instructions",
  }
}

describe("host-resource approval, end to end through the real transport", () => {
  it("a headless-side request reaches HostResourceIpcService, gets a human answer, and the headless side receives it", async () => {
    const auditEntries: unknown[] = []
    const events: HostResourceApprovalRequestEvent[] = []
    const service = new HostResourceIpcService({
      sendApprovalRequest: (event) => {
        events.push(event)
        return []
      },
      audit: (entry) => auditEntries.push(entry),
    })

    const server = await startHeadlessApprovalServer({
      approveCapability: async () => ({ allow: false }), // unused in this test — proves the dispatch didn't cross kinds
      approveHostResource: service.hostResourceApprover,
      promptForGrant: async () => ({ allow: false }),
      portFilePath,
    })

    try {
      const client = createGuiApprovalPort({ portFilePath, spawnGui: () => {} })
      const resultPromise = client.requestHostResourceApproval({ request: request() })

      // Wait for the request to actually land, then answer it as a human
      // would — a fixed sleep here is a race under CPU contention (the
      // full suite can starve this event loop for well over 50ms); wait
      // on the real predicate instead.
      await vi.waitFor(() => expect(events).toHaveLength(1))
      service.resolve(events[0]!.promptId, true)

      const result = await resultPromise
      expect(result).toEqual({ allow: true })
      expect(auditEntries).toEqual([expect.objectContaining({ decision: "allow" })])
    } finally {
      await server.close()
    }
  })

  it("a denied request round-trips false end to end", async () => {
    const events: HostResourceApprovalRequestEvent[] = []
    const service = new HostResourceIpcService({
      sendApprovalRequest: (event) => {
        events.push(event)
        return []
      },
      audit: () => {},
    })

    const server = await startHeadlessApprovalServer({
      approveCapability: async () => ({ allow: true }),
      approveHostResource: service.hostResourceApprover,
      promptForGrant: async () => ({ allow: false }),
      portFilePath,
    })

    try {
      const client = createGuiApprovalPort({ portFilePath, spawnGui: () => {} })
      const resultPromise = client.requestHostResourceApproval({ request: request() })

      await vi.waitFor(() => expect(events).toHaveLength(1))
      service.resolve(events[0]!.promptId, false)

      expect(await resultPromise).toEqual({ allow: false })
    } finally {
      await server.close()
    }
  })

  it("fails closed when the GUI process side disposes with the request still pending", async () => {
    const events: HostResourceApprovalRequestEvent[] = []
    const service = new HostResourceIpcService({
      sendApprovalRequest: (event) => {
        events.push(event)
        return []
      },
      audit: () => {},
    })

    const server = await startHeadlessApprovalServer({
      approveCapability: async () => ({ allow: true }),
      approveHostResource: service.hostResourceApprover,
      promptForGrant: async () => ({ allow: false }),
      portFilePath,
    })

    try {
      const client = createGuiApprovalPort({ portFilePath, spawnGui: () => {} })
      const resultPromise = client.requestHostResourceApproval({ request: request() })

      await vi.waitFor(() => expect(events).toHaveLength(1))
      service.dispose() // simulates the window closing before the human answers

      expect(await resultPromise).toEqual({ allow: false, outcomeReason: "gui-disposed" })
    } finally {
      await server.close()
    }
  })
})
