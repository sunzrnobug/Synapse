import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"
import { createMarketplaceClient, MarketplaceApiError } from "./marketplace-client"

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

describe("createMarketplaceClient", () => {
  it("parses a well-formed session response", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        user: {
          id: "u1",
          handle: "alice",
          displayName: "Alice",
          role: "developer",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      })
    )
    const client = createMarketplaceClient({ baseUrl: "https://m.test", fetch })
    await expect(client.session("token")).resolves.toMatchObject({ user: { handle: "alice" } })
  })

  it("parses a well-formed device-start response", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        deviceCode: "dc1",
        userCode: "ABCD-EFGH",
        verificationUri: "https://m.test/verify",
        interval: 5,
        expiresAt: "2024-01-01T00:00:00.000Z",
      })
    )
    const client = createMarketplaceClient({ baseUrl: "https://m.test", fetch })
    await expect(client.deviceStart()).resolves.toMatchObject({ deviceCode: "dc1" })
  })

  it("parses a well-formed device-poll response", async () => {
    const fetch = vi.fn(async () => jsonResponse({ status: "pending" }))
    const client = createMarketplaceClient({ baseUrl: "https://m.test", fetch })
    await expect(client.devicePoll("dc1")).resolves.toEqual({ status: "pending" })
  })

  // A compromised or buggy marketplace server could return a 2xx response
  // whose body doesn't match the documented shape. Previously every call site
  // here cast `res.json()` straight to the expected type with no runtime
  // check, so malformed data flowed silently to the CLI's callers (login,
  // whoami, publish). Every response is now validated against its zod schema
  // from @synapsepkg/marketplace-types.
  it("rejects a well-formed 2xx session response whose body doesn't match the schema", async () => {
    const fetch = vi.fn(async () => jsonResponse({ user: { id: "u1" } }))
    const client = createMarketplaceClient({ baseUrl: "https://m.test", fetch })
    await expect(client.session("token")).rejects.toMatchObject({
      name: "MarketplaceApiError",
      code: "invalid_response",
    })
  })

  it("rejects a malformed device-start response", async () => {
    const fetch = vi.fn(async () => jsonResponse({ deviceCode: "dc1" }))
    const client = createMarketplaceClient({ baseUrl: "https://m.test", fetch })
    await expect(client.deviceStart()).rejects.toBeInstanceOf(MarketplaceApiError)
  })

  it("rejects a malformed device-poll response", async () => {
    const fetch = vi.fn(async () => jsonResponse({ status: "not-a-real-status" }))
    const client = createMarketplaceClient({ baseUrl: "https://m.test", fetch })
    await expect(client.devicePoll("dc1")).rejects.toBeInstanceOf(MarketplaceApiError)
  })

  it("rejects a malformed publish response", async () => {
    const fetch = vi.fn(async () => jsonResponse({ plugin: {} }))
    const client = createMarketplaceClient({ baseUrl: "https://m.test", fetch })
    const manifest = {
      manifestVersion: 2 as const,
      id: "com.synapse.fixture",
      name: "fixture",
      displayName: "Fixture",
      description: "desc",
      version: "1.0.0",
      author: "Synapse",
      engines: { synapse: "^0.2.0" },
      main: "dist/index.js",
      contributes: { commands: [{ id: "fixture.run", title: "Run", mode: "view" as const }] },
      capabilities: [],
    }
    await expect(
      client.publish(
        "token",
        { visibility: "private", sha256: "a".repeat(64), sizeBytes: 10, manifest },
        Buffer.from("data"),
        "fixture.syn"
      )
    ).rejects.toMatchObject({ name: "MarketplaceApiError", code: "invalid_response" })
  })
})
