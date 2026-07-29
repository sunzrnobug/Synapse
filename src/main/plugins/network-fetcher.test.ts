import type * as https from "node:https"
import type { AddressInfo } from "node:net"
import type { ResolvedAddress } from "./network-dns"
import type {
  NetworkFetcherConfig,
  NetworkTransport,
  StreamTransportResult,
  TransportArgs,
  TransportResult,
} from "./network-fetcher"
import { Buffer } from "node:buffer"
import { createServer } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CapabilityDenied } from "./capability-gate"
import { actorOf } from "./invocation-context"
import {
  armHeadersDeadline,
  BodyAlreadyConsumed,
  createNetworkFetcher,
  defaultStreamTransport,
  defaultTransport,
  HeadersDeadlineExceededError,
} from "./network-fetcher"
import { startTlsLoopbackServer } from "./test-support/tls-loopback-server"

// ---- armHeadersDeadline -----------------------------------------------------

describe("armHeadersDeadline", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("destroys the request with HeadersDeadlineExceededError after remainingMs of no response", () => {
    vi.useFakeTimers()
    const destroy = vi.fn()
    const fakeRequest = { destroy } as unknown as ReturnType<typeof https.request>

    armHeadersDeadline(fakeRequest, 500)
    vi.advanceTimersByTime(499)
    expect(destroy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(destroy).toHaveBeenCalledTimes(1)
    const err = destroy.mock.calls[0]![0]
    expect(err).toBeInstanceOf(HeadersDeadlineExceededError)
    expect((err as HeadersDeadlineExceededError).deadlineMs).toBe(500)
  })

  it("clear() prevents the timer from ever firing", () => {
    vi.useFakeTimers()
    const destroy = vi.fn()
    const fakeRequest = { destroy } as unknown as ReturnType<typeof https.request>

    const handle = armHeadersDeadline(fakeRequest, 500)
    handle.clear()
    vi.advanceTimersByTime(10_000)

    expect(destroy).not.toHaveBeenCalled()
  })
})

describe("defaultTransport — headers deadline", () => {
  it("destroys the request with HeadersDeadlineExceededError if headers never arrive", async () => {
    const server = createServer(() => {
      /* never respond */
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const controller = new AbortController()
      await expect(
        defaultTransport({
          url: new URL(`https://127.0.0.1:${port}/`),
          method: "GET",
          headers: {},
          pinnedAddress: { address: "127.0.0.1", family: 4 },
          signal: controller.signal,
          timeoutMs: 30_000,
          headersDeadlineMs: 200,
          maxResponseBytes: 1024,
        })
      ).rejects.toBeInstanceOf(HeadersDeadlineExceededError)
    } finally {
      server.close()
    }
  })
})

describe("defaultStreamTransport — headers deadline", () => {
  it("destroys the request with HeadersDeadlineExceededError if headers never arrive", async () => {
    const server = createServer(() => {
      /* never respond */
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const controller = new AbortController()
      await expect(
        defaultStreamTransport({
          url: new URL(`https://127.0.0.1:${port}/`),
          method: "GET",
          headers: {},
          pinnedAddress: { address: "127.0.0.1", family: 4 },
          signal: controller.signal,
          timeoutMs: 30_000,
          headersDeadlineMs: 200,
          maxResponseBytes: 1024,
        })
      ).rejects.toBeInstanceOf(HeadersDeadlineExceededError)
    } finally {
      server.close()
    }
  })
})

describe("connectTimeoutMs — hop-scoped failover budget", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("passes the full connectTimeoutMs to the first address, and only the remaining budget to the second", async () => {
    vi.useFakeTimers()
    const receivedDeadlines: number[] = []
    let callCount = 0
    const transport = vi.fn(async (args: TransportArgs) => {
      receivedDeadlines.push(args.headersDeadlineMs)
      callCount += 1
      if (callCount === 1) {
        await vi.advanceTimersByTimeAsync(100)
        throw new Error("connection refused")
      }
      return { status: 200, statusText: "OK", headers: {}, body: Buffer.from("ok") }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({
        transport,
        resolve: fakeResolve([
          { address: "203.0.113.1", family: 4 },
          { address: "203.0.113.2", family: 4 },
        ]),
        connectTimeoutMs: 400,
      })
    )

    await fetcher.fetch("https://example.com/")

    expect(receivedDeadlines[0]).toBe(400)
    expect(receivedDeadlines[1]).toBeLessThanOrEqual(300)
    expect(receivedDeadlines[1]).toBeGreaterThan(0)
  })

  it("never attempts a second address once the hop deadline is fully consumed", async () => {
    vi.useFakeTimers()
    const transport = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(400)
      throw new Error("connection refused")
    })
    const fetcher = createNetworkFetcher(
      makeConfig({
        transport,
        resolve: fakeResolve([
          { address: "203.0.113.1", family: 4 },
          { address: "203.0.113.2", family: 4 },
        ]),
        connectTimeoutMs: 400,
      })
    )

    await expect(fetcher.fetch("https://example.com/")).rejects.toThrow()

    expect(transport).toHaveBeenCalledTimes(1)
  })
})

describe("connectTimeoutMs — excludes credential injection latency", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("buffered: a slow injectCredential (vault read / OAuth refresh) does not shrink the headers-deadline budget", async () => {
    vi.useFakeTimers()
    let receivedDeadline: number | undefined
    const transport = vi.fn(async (args: TransportArgs) => {
      receivedDeadline = args.headersDeadlineMs
      return { status: 200, statusText: "OK", headers: {}, body: Buffer.from("ok") }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({
        transport,
        connectTimeoutMs: 400,
        injectCredential: async () => {
          await vi.advanceTimersByTimeAsync(350)
          return undefined
        },
      })
    )

    await fetcher.fetch("https://example.com/")

    expect(receivedDeadline).toBe(400)
  })

  it("streaming: a slow injectCredential does not shrink the headers-deadline budget", async () => {
    vi.useFakeTimers()
    let receivedDeadline: number | undefined
    const streamTransport = vi.fn(async (args: TransportArgs) => {
      receivedDeadline = args.headersDeadlineMs
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {})(),
      }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({
        streamTransport,
        connectTimeoutMs: 400,
        injectCredential: async () => {
          await vi.advanceTimersByTimeAsync(350)
          return undefined
        },
      })
    )

    await fetcher.fetchStream("https://example.com/")

    expect(receivedDeadline).toBe(400)
  })
})

describe("defaultStreamTransport — real server regression: idle timeout, not old timeoutMs", () => {
  it("headers arriving before the deadline clear it (no late firing)", async () => {
    const server = await startTlsLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("chunk-1")
    })
    try {
      const controller = new AbortController()
      const resultPromise = defaultStreamTransport({
        url: new URL(`https://127.0.0.1:${server.port}/`),
        method: "GET",
        headers: {},
        pinnedAddress: { address: "127.0.0.1", family: 4 },
        signal: controller.signal,
        timeoutMs: 30_000,
        headersDeadlineMs: 300,
        maxResponseBytes: 1024,
        trustedCaPem: server.certPem,
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      const result = await resultPromise
      expect(result.status).toBe(200)
      controller.abort()
    } finally {
      await server.close()
    }
  })

  it("a real body idling well past the old fixed timeoutMs is NOT torn down by defaultStreamTransport — this is the regression test for the bug this spec fixes", async () => {
    let sendSecondChunk: (() => void) | undefined
    const chunkSent = new Promise<void>((resolve) => {
      sendSecondChunk = resolve
    })
    const server = await startTlsLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("chunk-1")
      void chunkSent.then(() => {
        res.write("chunk-2")
        res.end()
      })
    })
    try {
      const controller = new AbortController()
      const result = await defaultStreamTransport({
        url: new URL(`https://127.0.0.1:${server.port}/`),
        method: "GET",
        headers: {},
        pinnedAddress: { address: "127.0.0.1", family: 4 },
        signal: controller.signal,
        // Deliberately small: under the old bug, defaultStreamTransport
        // itself would install request.setTimeout(timeoutMs) after headers
        // and destroy the socket ~200ms after the first chunk. This test
        // waits well past that before the server sends the second chunk —
        // if the old low-level timer were still installed, the body
        // consumption below would throw/truncate instead of yielding both
        // chunks.
        timeoutMs: 200,
        headersDeadlineMs: 5_000,
        maxResponseBytes: 1024,
        trustedCaPem: server.certPem,
      })
      expect(result.status).toBe(200)

      await new Promise((resolve) => setTimeout(resolve, 500))
      sendSecondChunk?.()

      const chunks: Buffer[] = []
      for await (const chunk of result.stream) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks).toString()).toBe("chunk-1chunk-2")

      controller.abort()
    } finally {
      await server.close()
    }
  })
})

describe("defaultTransport — real server: headers deadline", () => {
  it("fires HeadersDeadlineExceededError when the server never sends a response", async () => {
    const server = await startTlsLoopbackServer(() => {
      /* never respond */
    })
    try {
      const controller = new AbortController()
      await expect(
        defaultTransport({
          url: new URL(`https://127.0.0.1:${server.port}/`),
          method: "GET",
          headers: {},
          pinnedAddress: { address: "127.0.0.1", family: 4 },
          signal: controller.signal,
          timeoutMs: 30_000,
          headersDeadlineMs: 300,
          maxResponseBytes: 1024,
          trustedCaPem: server.certPem,
        })
      ).rejects.toBeInstanceOf(HeadersDeadlineExceededError)
    } finally {
      await server.close()
    }
  })

  it("a full buffered response within the deadline succeeds normally", async () => {
    const server = await startTlsLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("hello")
    })
    try {
      const controller = new AbortController()
      const result = await defaultTransport({
        url: new URL(`https://127.0.0.1:${server.port}/`),
        method: "GET",
        headers: {},
        pinnedAddress: { address: "127.0.0.1", family: 4 },
        signal: controller.signal,
        timeoutMs: 30_000,
        headersDeadlineMs: 5_000,
        maxResponseBytes: 1024,
        trustedCaPem: server.certPem,
      })
      expect(result.status).toBe(200)
      expect(result.body.toString()).toBe("hello")
    } finally {
      await server.close()
    }
  })

  // A literal IP in the URL (127.0.0.1, as above) never exercises Node's own
  // DNS-lookup machinery: net.isIP() short-circuits and the custom `lookup`
  // on the Agent is never called. A real hostname (any name that isn't a
  // literal IP — "localhost" works because the loopback cert's SAN already
  // covers it) forces Node through lookupAndConnectMultiple, which invokes
  // the Agent's `lookup` with `{ all: true }` and expects the all-addresses
  // callback form. A `lookup` that always calls back with the single-address
  // 3-arg form regardless of `options.all` breaks under that path.
  it("connects when the URL host is a real hostname requiring DNS lookup, not a literal IP", async () => {
    const server = await startTlsLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("hello")
    })
    try {
      const controller = new AbortController()
      const result = await defaultTransport({
        url: new URL(`https://localhost:${server.port}/`),
        method: "GET",
        headers: {},
        pinnedAddress: { address: "127.0.0.1", family: 4 },
        signal: controller.signal,
        timeoutMs: 30_000,
        headersDeadlineMs: 5_000,
        maxResponseBytes: 1024,
        trustedCaPem: server.certPem,
      })
      expect(result.status).toBe(200)
      expect(result.body.toString()).toBe("hello")
    } finally {
      await server.close()
    }
  })
})

// ---- Test doubles -----------------------------------------------------------

const PUBLIC_ADDR: ResolvedAddress = { address: "140.82.112.3", family: 4 }

function fakeResolve(addrs: ResolvedAddress[] = [PUBLIC_ADDR]) {
  return vi.fn(async (_host: string) => addrs)
}

function okTransport(result: Partial<TransportResult> = {}): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (_args: TransportArgs): Promise<TransportResult> => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
      ...result,
    })
  )
}

interface FakeGate {
  ensure: ReturnType<typeof vi.fn>
  assertDeclared: ReturnType<typeof vi.fn>
}

function fakeGate(impl?: (req: unknown) => Promise<void>): FakeGate {
  return {
    ensure: vi.fn(impl ?? (async () => undefined)),
    assertDeclared: vi.fn(),
  }
}

function makeConfig(overrides: Partial<NetworkFetcherConfig> = {}): NetworkFetcherConfig {
  return {
    gate: fakeGate(),
    invocation: {
      source: "tool",
      trigger: "tool:fetch",
      caller: { kind: "user", principal: { kind: "local-user" } },
    },
    pluginId: "com.example.plugin",
    resolve: fakeResolve(),
    transport: okTransport(),
    maxRequestBytes: 1024,
    maxResponseBytes: 4096,
    timeoutMs: 1000,
    maxRedirects: 3,
    ...overrides,
  }
}

// ---- URL validation ---------------------------------------------------------

describe("network-fetcher URL validation", () => {
  it("rejects non-https url", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport }))
    await expect(fetcher.fetch("http://api.github.com/x")).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it("rejects userinfo in url", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport }))
    await expect(fetcher.fetch("https://user:pass@api.github.com/x")).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it("rejects non-default port", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport }))
    await expect(fetcher.fetch("https://api.github.com:8443/x")).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it("allows explicit default port 443 (normalizes to empty)", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport }))
    // new URL drops :443 → url.port === "" so this is allowed.
    await expect(fetcher.fetch("https://api.github.com:443/x")).resolves.toBeDefined()
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

// ---- Gate ordering ----------------------------------------------------------

describe("network-fetcher gate enforcement", () => {
  it("calls gate.ensure with network:https and a correct requestedScope BEFORE transport", async () => {
    const transport = okTransport()
    const gate = fakeGate()
    const fetcher = createNetworkFetcher(makeConfig({ gate, transport }))

    await fetcher.fetch("https://api.github.com/repos/foo", { method: "post" })

    expect(gate.ensure).toHaveBeenCalledTimes(1)
    const req = gate.ensure.mock.calls[0][0]
    expect(req.capability).toBe("network:https")
    expect(req.invocation.trigger).toBe("tool:fetch")
    expect(actorOf(req.invocation)).toBe("user")
    expect(req.requestedScope).toMatchObject({
      host: "api.github.com",
      method: "POST",
      path: "/repos/foo",
      origin: "https://api.github.com",
    })
    expect(req.signal).toBeInstanceOf(AbortSignal)
    // ordering: ensure resolved before transport invoked
    const ensureOrder = gate.ensure.mock.invocationCallOrder[0]
    const transportOrder = transport.mock.invocationCallOrder[0]
    expect(ensureOrder).toBeLessThan(transportOrder)
  })

  it("does NOT call transport when gate.ensure throws CapabilityDenied", async () => {
    const transport = okTransport()
    const gate = fakeGate(async () => {
      throw new CapabilityDenied("com.example.plugin", "network:https", "grant refused")
    })
    const fetcher = createNetworkFetcher(makeConfig({ gate, transport }))

    await expect(fetcher.fetch("https://api.github.com/x")).rejects.toBeInstanceOf(CapabilityDenied)
    expect(transport).not.toHaveBeenCalled()
  })
})

// ---- Header stripping -------------------------------------------------------

describe("network-fetcher request header stripping", () => {
  it("strips denylisted request headers but keeps Authorization", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport }))

    await fetcher.fetch("https://api.github.com/x", {
      headers: {
        Host: "evil.com",
        Cookie: "a=b",
        "Sec-Fetch-Mode": "cors",
        "Proxy-Authorization": "Basic xyz",
        Connection: "keep-alive",
        "Content-Length": "5",
        "Transfer-Encoding": "chunked",
        Authorization: "Bearer token",
        "X-Custom": "ok",
      },
    })

    const sentHeaders = transport.mock.calls[0][0].headers as Record<string, string>
    const lowerKeys = Object.keys(sentHeaders).map((k) => k.toLowerCase())
    expect(lowerKeys).not.toContain("host")
    expect(lowerKeys).not.toContain("cookie")
    expect(lowerKeys).not.toContain("sec-fetch-mode")
    expect(lowerKeys).not.toContain("proxy-authorization")
    expect(lowerKeys).not.toContain("connection")
    expect(lowerKeys).not.toContain("content-length")
    expect(lowerKeys).not.toContain("transfer-encoding")
    // kept
    expect(lowerKeys).toContain("authorization")
    expect(lowerKeys).toContain("x-custom")
  })
})

// ---- Path normalization (traversal) -----------------------------------------

describe("network-fetcher path normalization", () => {
  it("normalizes encoded traversal so scope can't be fooled", async () => {
    const transport = okTransport()
    const gate = fakeGate()
    const fetcher = createNetworkFetcher(makeConfig({ gate, transport }))

    await fetcher.fetch("https://api.github.com/repos/..%2f..%2fadmin")

    const req = gate.ensure.mock.calls[0][0]
    // Must NOT still look like /repos/** — must be the resolved /admin.
    expect(req.requestedScope.path).toBe("/admin")
    expect(req.requestedScope.path.startsWith("/repos/")).toBe(false)
  })

  it("resolves dot-segments and collapses double slashes", async () => {
    const transport = okTransport()
    const gate = fakeGate()
    const fetcher = createNetworkFetcher(makeConfig({ gate, transport }))

    await fetcher.fetch("https://api.github.com/a/./b//c/../d")
    const req = gate.ensure.mock.calls[0][0]
    expect(req.requestedScope.path).toBe("/a/b/d")
  })
})

// ---- Private IP / SSRF ------------------------------------------------------

describe("network-fetcher SSRF guard", () => {
  it("rejects and does not call transport when resolve throws (private IP)", async () => {
    const transport = okTransport()
    const resolve = vi.fn(async () => {
      throw new Error("blocked non-public (private) address 127.0.0.1")
    })
    const fetcher = createNetworkFetcher(makeConfig({ transport, resolve }))

    await expect(fetcher.fetch("https://internal.evil.com/x")).rejects.toThrow(/private|public/)
    expect(transport).not.toHaveBeenCalled()
  })

  it("pins the first resolved address into the transport args", async () => {
    const addr: ResolvedAddress = { address: "1.2.3.4", family: 4 }
    const transport = okTransport()
    const fetcher = createNetworkFetcher(
      makeConfig({ transport, resolve: fakeResolve([addr, { address: "5.6.7.8", family: 4 }]) })
    )
    await fetcher.fetch("https://api.github.com/x")
    expect(transport.mock.calls[0][0].pinnedAddress).toEqual(addr)
  })
})

// ---- Redirects --------------------------------------------------------------

describe("network-fetcher redirects", () => {
  it("follows a same-origin redirect manually (re-ensure, re-transport)", async () => {
    const gate = fakeGate()
    let call = 0
    const transport = vi.fn(async (_args: TransportArgs): Promise<TransportResult> => {
      call += 1
      if (call === 1) {
        return {
          status: 302,
          statusText: "Found",
          headers: { location: "/redirected" },
          body: Buffer.alloc(0),
        }
      }
      return { status: 200, statusText: "OK", headers: {}, body: Buffer.from("done") }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ gate, transport: transport as unknown as NetworkTransport })
    )

    const res = await fetcher.fetch("https://api.github.com/start")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("done")
    expect(gate.ensure).toHaveBeenCalledTimes(2)
    expect(gate.ensure.mock.calls[1][0].requestedScope.path).toBe("/redirected")
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it("rejects a cross-origin redirect without following it", async () => {
    const gate = fakeGate()
    const transport = vi.fn(
      async (_args: TransportArgs): Promise<TransportResult> => ({
        status: 302,
        statusText: "Found",
        headers: { location: "https://evil.com/" },
        body: Buffer.alloc(0),
      })
    )
    const fetcher = createNetworkFetcher(
      makeConfig({ gate, transport: transport as unknown as NetworkTransport })
    )

    await expect(fetcher.fetch("https://api.github.com/start")).rejects.toThrow(/cross-origin/i)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(gate.ensure).toHaveBeenCalledTimes(1)
  })

  it("bounds redirects by maxRedirects", async () => {
    const transport = vi.fn(
      async (_args: TransportArgs): Promise<TransportResult> => ({
        status: 302,
        statusText: "Found",
        headers: { location: "/loop" },
        body: Buffer.alloc(0),
      })
    )
    const fetcher = createNetworkFetcher(
      makeConfig({ transport: transport as unknown as NetworkTransport, maxRedirects: 2 })
    )

    await expect(fetcher.fetch("https://api.github.com/loop")).rejects.toThrow(/redirect/i)
    // initial + 2 follows = 3 transport calls
    expect(transport).toHaveBeenCalledTimes(3)
  })

  it("drops Authorization on redirect", async () => {
    let call = 0
    const transport = vi.fn(async (_args: TransportArgs): Promise<TransportResult> => {
      call += 1
      if (call === 1) {
        return {
          status: 307,
          statusText: "Temporary Redirect",
          headers: { location: "/next" },
          body: Buffer.alloc(0),
        }
      }
      return { status: 200, statusText: "OK", headers: {}, body: Buffer.from("ok") }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ transport: transport as unknown as NetworkTransport })
    )

    await fetcher.fetch("https://api.github.com/start", {
      headers: { Authorization: "Bearer secret" },
    })

    const firstHeaders = transport.mock.calls[0][0].headers as Record<string, string>
    const secondHeaders = transport.mock.calls[1][0].headers as Record<string, string>
    expect(Object.keys(firstHeaders).map((k) => k.toLowerCase())).toContain("authorization")
    expect(Object.keys(secondHeaders).map((k) => k.toLowerCase())).not.toContain("authorization")
  })
})

// ---- Response shaping -------------------------------------------------------

describe("network-fetcher response", () => {
  it("strips set-cookie and hop-by-hop from returned headers", async () => {
    const transport = okTransport({
      headers: {
        "content-type": "text/plain",
        "set-cookie": "a=b",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        "proxy-authenticate": "x",
        "x-keep": "yes",
      },
    })
    const fetcher = createNetworkFetcher(makeConfig({ transport }))
    const res = await fetcher.fetch("https://api.github.com/x")
    expect(res.headers["set-cookie"]).toBeUndefined()
    expect(res.headers.connection).toBeUndefined()
    expect(res.headers["transfer-encoding"]).toBeUndefined()
    expect(res.headers["proxy-authenticate"]).toBeUndefined()
    expect(res.headers["content-type"]).toBe("text/plain")
    expect(res.headers["x-keep"]).toBe("yes")
  })

  it("ok=true for 200, ok=false for 404; body readers work", async () => {
    const okFetcher = createNetworkFetcher(
      makeConfig({ transport: okTransport({ body: Buffer.from('{"a":1}') }) })
    )
    const res = await okFetcher.fetch("https://api.github.com/x")
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"a":1}')

    const okFetcher2 = createNetworkFetcher(
      makeConfig({ transport: okTransport({ body: Buffer.from('{"a":1}') }) })
    )
    const res2 = await okFetcher2.fetch("https://api.github.com/x")
    expect(await res2.json<{ a: number }>()).toEqual({ a: 1 })

    const okFetcher3 = createNetworkFetcher(
      makeConfig({ transport: okTransport({ body: Buffer.from([1, 2, 3]) }) })
    )
    const res3 = await okFetcher3.fetch("https://api.github.com/x")
    const ab = await res3.arrayBuffer()
    expect(new Uint8Array(ab)).toEqual(new Uint8Array([1, 2, 3]))

    const notFound = createNetworkFetcher(
      makeConfig({ transport: okTransport({ status: 404, statusText: "Not Found" }) })
    )
    const res4 = await notFound.fetch("https://api.github.com/x")
    expect(res4.ok).toBe(false)
    expect(res4.status).toBe(404)
  })
})

// ---- Body limit -------------------------------------------------------------

describe("network-fetcher request body limit", () => {
  it("rejects a body over maxRequestBytes before calling transport", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport, maxRequestBytes: 4 }))
    await expect(
      fetcher.fetch("https://api.github.com/x", { method: "POST", body: "0123456789" })
    ).rejects.toThrow(/body|size|large/i)
    expect(transport).not.toHaveBeenCalled()
  })

  it("passes a within-limit body to the transport as a Buffer", async () => {
    const transport = okTransport()
    const fetcher = createNetworkFetcher(makeConfig({ transport, maxRequestBytes: 16 }))
    await fetcher.fetch("https://api.github.com/x", { method: "POST", body: "hello" })
    expect(transport.mock.calls[0][0].body).toEqual(Buffer.from("hello"))
  })
})

// ---- abortAll ---------------------------------------------------------------

describe("network-fetcher abortAll", () => {
  let pending: { reject: (e: unknown) => void } | undefined

  beforeEach(() => {
    pending = undefined
  })
  afterEach(() => {
    pending = undefined
  })

  it("aborts an in-flight fetch", async () => {
    const transport = vi.fn((args: TransportArgs): Promise<TransportResult> => {
      return new Promise<TransportResult>((_resolve, reject) => {
        pending = { reject }
        args.signal.addEventListener("abort", () => {
          reject(new Error("aborted"))
        })
      })
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ transport: transport as unknown as NetworkTransport })
    )

    const promise = fetcher.fetch("https://api.github.com/slow")
    // let the pipeline reach transport
    await vi.waitFor(() => expect(pending).toBeDefined())
    fetcher.abortAll()
    await expect(promise).rejects.toThrow()
  })
})

// ---- Address failover -------------------------------------------------------

describe("network-fetcher address failover", () => {
  const ADDR_A: ResolvedAddress = { address: "140.82.112.3", family: 4 }
  const ADDR_B: ResolvedAddress = { address: "140.82.112.4", family: 4 }

  it("rolls over to the next validated address when the first connection fails", async () => {
    const transport: NetworkTransport = vi.fn(async (args: TransportArgs) => {
      if (args.pinnedAddress.address === ADDR_A.address) throw new Error("ECONNREFUSED")
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        body: Buffer.from("ok"),
      }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ resolve: fakeResolve([ADDR_A, ADDR_B]), transport: transport as never })
    )

    const res = await fetcher.fetch("https://api.github.com/x")
    expect(res.status).toBe(200)
    expect((transport as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it("throws the last error when every address fails", async () => {
    const transport: NetworkTransport = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ resolve: fakeResolve([ADDR_A, ADDR_B]), transport: transport as never })
    )

    await expect(fetcher.fetch("https://api.github.com/x")).rejects.toThrow(/ECONNREFUSED/)
    expect((transport as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it("stops failover immediately once the request is aborted", async () => {
    const controller = new AbortController()
    const transport: NetworkTransport = vi.fn(async (args: TransportArgs) => {
      controller.abort()
      // Simulate the transport observing the abort and rejecting.
      void args
      throw new Error("aborted")
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ resolve: fakeResolve([ADDR_A, ADDR_B]), transport: transport as never })
    )

    await expect(
      fetcher.fetch("https://api.github.com/x", { signal: controller.signal })
    ).rejects.toThrow(/aborted/)
    // Aborted on the first attempt → no roll-over to the second address.
    expect((transport as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })
})

// ---- Streaming responses ----------------------------------------------------

function streamTransportFrom(
  chunks: Uint8Array[],
  result: Partial<StreamTransportResult> = {}
): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (_args: TransportArgs): Promise<StreamTransportResult> => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/octet-stream" },
      stream: (async function* () {
        for (const c of chunks) yield c
      })(),
      ...result,
    })
  )
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of body) parts.push(Buffer.from(chunk))
  return Buffer.concat(parts)
}

describe("network-fetcher streaming", () => {
  it("yields the body as chunks that reassemble to the original bytes", async () => {
    const chunks = [Buffer.from("hello "), Buffer.from("streamed "), Buffer.from("world")]
    const streamTransport = streamTransportFrom(chunks)
    const fetcher = createNetworkFetcher(makeConfig({ streamTransport: streamTransport as never }))

    const res = await fetcher.fetchStream("https://api.github.com/big")
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect((await drain(res.body)).toString("utf8")).toBe("hello streamed world")
  })

  it("throws BodyAlreadyConsumed on a second iteration of the body", async () => {
    const streamTransport = streamTransportFrom([Buffer.from("once")])
    const fetcher = createNetworkFetcher(makeConfig({ streamTransport: streamTransport as never }))

    const res = await fetcher.fetchStream("https://api.github.com/x")
    expect((await drain(res.body)).toString("utf8")).toBe("once")
    expect(() => res.body[Symbol.asyncIterator]()).toThrow(BodyAlreadyConsumed)
  })

  it("throws once the cumulative body exceeds maxStreamBytes", async () => {
    const streamTransport = streamTransportFrom([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)])
    const fetcher = createNetworkFetcher(
      makeConfig({ streamTransport: streamTransport as never, maxStreamBytes: 16 })
    )

    const res = await fetcher.fetchStream("https://api.github.com/big")
    await expect(drain(res.body)).rejects.toThrow(/maxStreamBytes/)
  })

  it("runs the consent gate before the stream transport (consent before egress)", async () => {
    const streamTransport = streamTransportFrom([Buffer.from("x")])
    const gate = fakeGate(async () => {
      throw new CapabilityDenied("p", "network:https", "scope not allowed")
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ gate, streamTransport: streamTransport as never })
    )

    await expect(fetcher.fetchStream("https://evil.com/x")).rejects.toBeInstanceOf(CapabilityDenied)
    expect(streamTransport).not.toHaveBeenCalled()
  })

  it("follows a same-origin redirect, then streams the final body", async () => {
    let call = 0
    const streamTransport = vi.fn(async (_args: TransportArgs): Promise<StreamTransportResult> => {
      call += 1
      if (call === 1) {
        return {
          status: 302,
          statusText: "Found",
          headers: { location: "https://api.github.com/final" },
          stream: (async function* () {
            yield Buffer.from("")
          })(),
        }
      }
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {
          yield Buffer.from("final body")
        })(),
      }
    })
    const fetcher = createNetworkFetcher(makeConfig({ streamTransport: streamTransport as never }))

    const res = await fetcher.fetchStream("https://api.github.com/start")
    expect((await drain(res.body)).toString("utf8")).toBe("final body")
    expect(streamTransport.mock.calls).toHaveLength(2)
  })

  it("rejects a cross-origin redirect", async () => {
    const streamTransport = streamTransportFrom([], {
      status: 302,
      headers: { location: "https://evil.com/x" },
    })
    const fetcher = createNetworkFetcher(makeConfig({ streamTransport: streamTransport as never }))

    await expect(fetcher.fetchStream("https://api.github.com/start")).rejects.toThrow(
      /cross-origin redirect/
    )
  })

  it("strips set-cookie and hop-by-hop headers on the streamed response", async () => {
    const streamTransport = streamTransportFrom([Buffer.from("x")], {
      headers: { "set-cookie": "a=1", connection: "keep-alive", "content-type": "text/plain" },
    })
    const fetcher = createNetworkFetcher(makeConfig({ streamTransport: streamTransport as never }))

    const res = await fetcher.fetchStream("https://api.github.com/x")
    const keys = Object.keys(res.headers).map((k) => k.toLowerCase())
    expect(keys).not.toContain("set-cookie")
    expect(keys).not.toContain("connection")
    expect(keys).toContain("content-type")
  })

  it("abortAll mid-stream makes the iterator throw", async () => {
    const streamTransport = vi.fn(
      async (args: TransportArgs): Promise<StreamTransportResult> => ({
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {
          yield Buffer.from("first")
          await new Promise((r) => setTimeout(r, 5))
          if (args.signal.aborted) throw new Error("aborted")
          yield Buffer.from("second")
        })(),
      })
    )
    const fetcher = createNetworkFetcher(makeConfig({ streamTransport: streamTransport as never }))

    const res = await fetcher.fetchStream("https://api.github.com/x")
    const iterator = res.body[Symbol.asyncIterator]()
    expect(Buffer.from((await iterator.next()).value!).toString("utf8")).toBe("first")
    fetcher.abortAll()
    await expect(iterator.next()).rejects.toThrow(/aborted/)
  })

  it("yields plain Uint8Array chunks, never a Node Buffer", async () => {
    const streamTransport = streamTransportFrom([Buffer.from("abc"), Buffer.from("def")])
    const fetcher = createNetworkFetcher(makeConfig({ streamTransport: streamTransport as never }))

    const res = await fetcher.fetchStream("https://api.github.com/x")
    let count = 0
    for await (const chunk of res.body) {
      count += 1
      expect(chunk instanceof Uint8Array).toBe(true)
      expect(chunk.constructor).toBe(Uint8Array)
      expect(Buffer.isBuffer(chunk)).toBe(false)
    }
    expect(count).toBe(2)
  })

  it("does not drain an unbounded redirect body (capped by maxRedirectDrainBytes)", async () => {
    let redirectPulls = 0
    let call = 0
    const streamTransport = vi.fn(async (_args: TransportArgs): Promise<StreamTransportResult> => {
      call += 1
      if (call === 1) {
        return {
          status: 302,
          statusText: "Found",
          headers: { location: "https://api.github.com/final" },
          stream: (async function* () {
            while (true) {
              redirectPulls += 1
              yield Buffer.alloc(1024)
            }
          })(),
        }
      }
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {
          yield Buffer.from("final body")
        })(),
      }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({
        streamTransport: streamTransport as never,
        maxRedirectDrainBytes: 4096,
        maxRedirectDrainMs: 1000,
      })
    )

    const res = await fetcher.fetchStream("https://api.github.com/start")
    expect((await drain(res.body)).toString("utf8")).toBe("final body")
    expect(streamTransport.mock.calls).toHaveLength(2)
    expect(redirectPulls).toBeLessThanOrEqual(6)
  })

  it("destroys the socket if the body is never consumed (unconsumed timeout)", async () => {
    vi.useFakeTimers()
    try {
      let captured: AbortSignal | undefined
      const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
        captured = args.signal
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          stream: (async function* () {
            yield Buffer.from("x")
          })(),
        }
      })
      const fetcher = createNetworkFetcher(
        makeConfig({ streamTransport: streamTransport as never, maxUnconsumedStreamMs: 1000 })
      )

      await fetcher.fetchStream("https://api.github.com/x")
      expect(captured?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(captured?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does NOT abort once consumption has started (unconsumed timer cleared)", async () => {
    vi.useFakeTimers()
    try {
      let captured: AbortSignal | undefined
      const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
        captured = args.signal
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          stream: (async function* () {
            yield Buffer.from("x")
          })(),
        }
      })
      const fetcher = createNetworkFetcher(
        makeConfig({ streamTransport: streamTransport as never, maxUnconsumedStreamMs: 1000 })
      )

      const res = await fetcher.fetchStream("https://api.github.com/x")
      await drain(res.body)
      await vi.advanceTimersByTimeAsync(5000)
      expect(captured?.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects before exposing body when Content-Length exceeds maxStreamBytes", async () => {
    const streamTransport = streamTransportFrom([Buffer.from("x")], {
      headers: { "content-length": String(1024 * 1024) },
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ streamTransport: streamTransport as never, maxStreamBytes: 1024 })
    )

    await expect(fetcher.fetchStream("https://api.github.com/big")).rejects.toThrow(
      /content-length/i
    )
  })

  it("forces Accept-Encoding: identity, overriding a plugin-supplied value", async () => {
    let captured: Record<string, string> | undefined
    const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
      captured = args.headers
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {
          yield Buffer.from("x")
        })(),
      }
    })
    const fetcher = createNetworkFetcher(makeConfig({ streamTransport: streamTransport as never }))

    const res = await fetcher.fetchStream("https://api.github.com/x", {
      headers: { "Accept-Encoding": "gzip, br" },
    })
    await drain(res.body)
    expect(captured?.["accept-encoding"]).toBe("identity")
  })

  it("body.cancel() aborts the socket and releases the in-flight slot", async () => {
    let captured: AbortSignal | undefined
    const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
      captured = args.signal
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {
          yield Buffer.from("first")
          await new Promise(() => {})
        })(),
      }
    })
    const fetcher = createNetworkFetcher(
      makeConfig({ streamTransport: streamTransport as never, maxUnconsumedStreamMs: 1_000_000 })
    )

    const res = await fetcher.fetchStream("https://api.github.com/x")
    res.body.cancel()
    expect(captured?.aborted).toBe(true)
  })

  it("aborts a stream that idles longer than streamIdleTimeoutMs", async () => {
    vi.useFakeTimers()
    try {
      let captured: AbortSignal | undefined
      const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
        captured = args.signal
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          stream: (async function* () {
            yield Buffer.from("first")
            await new Promise((r) => setTimeout(r, 60_000))
            yield Buffer.from("second")
          })(),
        }
      })
      const fetcher = createNetworkFetcher(
        makeConfig({ streamTransport: streamTransport as never, streamIdleTimeoutMs: 1000 })
      )

      const res = await fetcher.fetchStream("https://api.github.com/x")
      const it = res.body[Symbol.asyncIterator]()
      expect(Buffer.from((await it.next()).value!).toString("utf8")).toBe("first")
      await vi.advanceTimersByTimeAsync(1000)
      expect(captured?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("aborts a stream that exceeds maxStreamDurationMs", async () => {
    vi.useFakeTimers()
    try {
      let captured: AbortSignal | undefined
      const streamTransport = vi.fn(async (args: TransportArgs): Promise<StreamTransportResult> => {
        captured = args.signal
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          stream: (async function* () {
            yield Buffer.from("a")
            await new Promise((r) => setTimeout(r, 10_000))
            yield Buffer.from("b")
          })(),
        }
      })
      const fetcher = createNetworkFetcher(
        makeConfig({
          streamTransport: streamTransport as never,
          streamIdleTimeoutMs: 1_000_000,
          maxStreamDurationMs: 2000,
        })
      )

      const res = await fetcher.fetchStream("https://api.github.com/x")
      const it = res.body[Symbol.asyncIterator]()
      await it.next()
      await vi.advanceTimersByTimeAsync(2000)
      expect(captured?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("enforces the per-plugin concurrent-stream cap and releases on cancel", async () => {
    const streamTransport = vi.fn(
      async (): Promise<StreamTransportResult> => ({
        status: 200,
        statusText: "OK",
        headers: {},
        stream: (async function* () {
          yield Buffer.from("x")
          await new Promise(() => {})
        })(),
      })
    )
    const fetcher = createNetworkFetcher(
      makeConfig({
        streamTransport: streamTransport as never,
        maxConcurrentStreams: 2,
        maxUnconsumedStreamMs: 1_000_000,
      })
    )

    const a = await fetcher.fetchStream("https://api.github.com/a")
    await fetcher.fetchStream("https://api.github.com/b")
    await expect(fetcher.fetchStream("https://api.github.com/c")).rejects.toThrow(
      /concurrent streams/
    )

    a.body.cancel()
    await expect(fetcher.fetchStream("https://api.github.com/c")).resolves.toBeDefined()
  })
})

describe("network-fetcher credential injection", () => {
  it("injects a credential header for an in-scope request via the injectCredential port", async () => {
    const seen: Record<string, string> = {}
    const transport = vi.fn(async (args: TransportArgs) => {
      Object.assign(seen, args.headers)
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        body: Buffer.from("{}"),
      }
    })
    const fetcher = createNetworkFetcher({
      ...makeConfig({ transport }),
      injectCredential: ({ host, method, path }, pluginHeaders) =>
        host === "api.github.com" &&
        method === "GET" &&
        path === "/repos/foo" &&
        !("authorization" in pluginHeaders)
          ? { name: "authorization", value: "Bearer ghp_secret" }
          : undefined,
    })
    await fetcher.fetch("https://api.github.com/repos/foo")
    expect(seen.authorization).toBe("Bearer ghp_secret")
  })

  it("rejects the fetch when injectCredential throws a conflict", async () => {
    const fetcher = createNetworkFetcher({
      ...makeConfig({ transport: okTransport() }),
      injectCredential: () => {
        throw new Error("conflict")
      },
    })
    await expect(
      fetcher.fetch("https://api.github.com/repos/foo", { headers: { authorization: "Bearer x" } })
    ).rejects.toThrow(/conflict/)
  })
})
