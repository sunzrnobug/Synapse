import { describe, expect, it, vi } from "vitest"
import {
  createMarketplaceApi,
  MarketplaceApiError,
  resolveMarketplaceBaseUrl,
} from "./marketplace-api"

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

describe("resolveMarketplaceBaseUrl", () => {
  it("prefers an explicit url and trims trailing slashes", () => {
    expect(resolveMarketplaceBaseUrl("https://m.test/")).toBe("https://m.test")
  })
})

describe("createMarketplaceApi", () => {
  it("builds the search URL with an encoded query", async () => {
    const fetch = vi.fn(async () => jsonResponse({ items: [], page: 1, perPage: 20, total: 0 }))
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await api.search("hello world")
    expect(fetch).toHaveBeenCalledWith("https://m.test/plugins?q=hello%20world")
  })

  it("omits the query param when empty", async () => {
    const fetch = vi.fn(async () => jsonResponse({ items: [], page: 1, perPage: 20, total: 0 }))
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await api.search("   ")
    expect(fetch).toHaveBeenCalledWith("https://m.test/plugins")
  })

  it("requests detail and download by id/version", async () => {
    const detailBody = {
      plugin: {
        id: "com.a.b",
        ownerUserId: "user-1",
        visibility: "public",
        status: "active",
        displayName: "B",
        description: "desc",
        categories: [],
        stats: { downloads: 0, ratingAvg: 0, ratingCount: 0 },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
      ownerHandle: "owner",
      versions: [],
    }
    const downloadBody = {
      version: "1.2.0",
      downloadUrl: "https://cdn.test/pkg.syn",
      sha256: "a".repeat(64),
      expiresAt: "2024-01-01T00:00:00.000Z",
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(detailBody))
      .mockResolvedValueOnce(jsonResponse(downloadBody))
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await api.detail("com.a.b")
    expect(fetch).toHaveBeenLastCalledWith("https://m.test/plugins/com.a.b")
    await api.resolveDownload("com.a.b", "1.2.0")
    expect(fetch).toHaveBeenLastCalledWith("https://m.test/plugins/com.a.b/versions/1.2.0/download")
  })

  it("maps an error envelope to MarketplaceApiError", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ error: { code: "not_found", message: "nope" } }, { ok: false, status: 404 })
    )
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await expect(api.detail("com.a.b")).rejects.toMatchObject({
      name: "MarketplaceApiError",
      status: 404,
      code: "not_found",
    })
  })

  it("wraps network failures", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    })
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await expect(api.search()).rejects.toBeInstanceOf(MarketplaceApiError)
  })

  // A compromised or buggy marketplace server could return a 2xx response
  // whose body doesn't match the documented shape. Previously the client cast
  // `response.json()` straight to the expected type with no runtime check, so
  // malformed data would flow silently into callers. Every response is now
  // validated against its zod schema from @synapse/marketplace-types.
  it("rejects a well-formed 2xx response whose body doesn't match the schema", async () => {
    const fetch = vi.fn(async () => jsonResponse({ items: "not-an-array", page: 1 }))
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await expect(api.search()).rejects.toMatchObject({
      name: "MarketplaceApiError",
      code: "invalid_response",
    })
  })

  // report/adminRemove/adminRestore/resolveReport were the remaining gap:
  // they discarded their response, so `send<{ status: string }>(...)` was
  // called with no schema at all — handle()'s `if (!schema) return json as T`
  // branch means literally any 2xx JSON body was accepted as success.
  it.each([
    ["report", (api: ReturnType<typeof createMarketplaceApi>) => api.report("com.a.b", "spam")],
    ["adminRemove", (api: ReturnType<typeof createMarketplaceApi>) => api.adminRemove("com.a.b")],
    ["adminRestore", (api: ReturnType<typeof createMarketplaceApi>) => api.adminRestore("com.a.b")],
    [
      "resolveReport",
      (api: ReturnType<typeof createMarketplaceApi>) => api.resolveReport("rep-1", "reviewed"),
    ],
  ] as const)(
    "%s rejects a well-formed 2xx response whose body doesn't match the ok-ack schema",
    async (_name, call) => {
      const fetch = vi.fn(async () => jsonResponse({ unexpected: "shape" }))
      const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
      await expect(call(api)).rejects.toMatchObject({
        name: "MarketplaceApiError",
        code: "invalid_response",
      })
    }
  )

  it("adminRemove resolves normally against the real { status: 'ok' } shape the server sends", async () => {
    const fetch = vi.fn(async () => jsonResponse({ status: "ok" }))
    const api = createMarketplaceApi({ baseUrl: "https://m.test", fetch })
    await expect(api.adminRemove("com.a.b")).resolves.toBeUndefined()
  })
})
