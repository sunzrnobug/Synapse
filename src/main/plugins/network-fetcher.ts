import type { NetworkHttpsRequestedScope } from "@synapse/plugin-manifest"
import type { IncomingMessage } from "node:http"
import type { CapabilityGatePort } from "./capability-gate"
import type { InvocationContext } from "./invocation-context"
import type { ResolvedAddress } from "./network-dns"
import { Buffer } from "node:buffer"
import * as https from "node:https"
import { networkHttpsAdapter } from "@synapse/plugin-manifest"
import { resolvePublicIps } from "./network-dns"

export class HeadersDeadlineExceededError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`headers not received within ${deadlineMs}ms`)
    this.name = "HeadersDeadlineExceededError"
  }
}

// network-fetcher — the ONLY host component that performs plugin network I/O.
//
// Every plugin HTTPS request flows through here. The chokepoint enforces, in a
// fixed order: https-only + no-userinfo + default-port-only URL validation;
// path normalization (so encoded traversal can't masquerade as a granted glob);
// capability-gate consent BEFORE any byte leaves the process; DNS resolution to
// PUBLIC IPs only with the connection PINNED to the validated address (the core
// SSRF / DNS-rebinding guard, implemented in the default transport); request/
// response size caps; hop-by-hop + cookie header stripping; and manual,
// same-origin-only, bounded redirect following.

export interface NetworkResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
  arrayBuffer: () => Promise<ArrayBuffer>
}

/** The streamed response body: backpressured chunks plus explicit teardown. */
export interface NetworkStreamBody extends AsyncIterable<Uint8Array> {
  /** Destroy the socket and release the in-flight slot. Idempotent. */
  cancel: () => void
}

/** Thrown when a stream body is iterated more than once. The body is consume-once
 *  (a single underlying socket) — a second iteration is a programming error, not
 *  a silent empty result. */
export class BodyAlreadyConsumed extends Error {
  constructor() {
    super("stream body already consumed")
    this.name = "BodyAlreadyConsumed"
  }
}

/** Like {@link NetworkResponse} but the body is consumed incrementally. */
export interface NetworkStreamResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  /** The response body as backpressured chunks. Consume once. */
  body: NetworkStreamBody
}

export interface NetworkFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string | ArrayBuffer | Uint8Array
  signal?: AbortSignal
}

/** One raw HTTPS round-trip to a PINNED address, NO redirect following. Injectable for tests. */
export interface TransportResult {
  status: number
  statusText: string
  headers: Record<string, string> // raw response headers (lowercased keys)
  body: Buffer // already size-capped by the transport
}

export interface TransportArgs {
  url: URL
  method: string
  headers: Record<string, string>
  body?: Buffer
  pinnedAddress: ResolvedAddress
  signal: AbortSignal
  timeoutMs: number
  headersDeadlineMs: number
  maxResponseBytes: number
  /** PEM of a CA/cert to trust for this request (test harness only). */
  trustedCaPem?: string
}

export type NetworkTransport = (args: TransportArgs) => Promise<TransportResult>

/** Headers plus an un-capped body stream from one round-trip. Injectable for tests. */
export interface StreamTransportResult {
  status: number
  statusText: string
  headers: Record<string, string> // raw response headers (lowercased keys)
  /** Raw response body; the fetcher caps total bytes while iterating. */
  stream: AsyncIterable<Uint8Array>
}

export type NetworkStreamTransport = (args: TransportArgs) => Promise<StreamTransportResult>

export interface NetworkFetcherConfig {
  gate: CapabilityGatePort
  invocation: InvocationContext
  pluginId: string
  /** Optional host-side credential injector. Called with the per-hop request and
   *  the (lowercased-key) headers about to be sent; returns the header to attach
   *  or undefined. Throwing aborts the fetch (plugin-set-header conflict). Plan 2
   *  supplies the real vault-backed implementation. */
  injectCredential?: (
    request: { host: string; method: string; path: string },
    pluginHeaders: Record<string, string>
  ) =>
    | { name: string; value: string }
    | undefined
    | Promise<{ name: string; value: string } | undefined>
  resolve?: (host: string) => Promise<ResolvedAddress[]> // default resolvePublicIps
  transport?: NetworkTransport // default node:https transport
  streamTransport?: NetworkStreamTransport // default node:https stream transport
  maxRequestBytes?: number // default 10 MiB
  maxResponseBytes?: number // default 25 MiB (buffered fetch)
  maxStreamBytes?: number // default 256 MiB (streamed fetch, hard total cap)
  timeoutMs?: number // default 30s
  connectTimeoutMs?: number // default 30s (absolute headers-received deadline, hop-scoped, shared across address failover)
  maxRedirects?: number // default 5
  maxRedirectDrainBytes?: number // default 64 KiB (redirect body is not trusted to be small)
  maxRedirectDrainMs?: number // default 2s
  maxUnconsumedStreamMs?: number // default 15s (body never consumed -> tear down)
  streamIdleTimeoutMs?: number // default 60s (max gap between chunks)
  maxStreamDurationMs?: number // default 10min (whole-stream ceiling)
  maxConcurrentStreams?: number // default 4 (live fetchStream bodies per plugin)
}

export interface NetworkFetcher {
  fetch: (url: string, init?: NetworkFetchInit) => Promise<NetworkResponse>
  /** Like {@link fetch} but the body is streamed; bounded by `maxStreamBytes`. */
  fetchStream: (url: string, init?: NetworkFetchInit) => Promise<NetworkStreamResponse>
  /** Aborts all in-flight fetches for this plugin (revoke teardown). */
  abortAll: () => void
}

const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_STREAM_BYTES = 256 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_REDIRECT_DRAIN_BYTES = 64 * 1024
const DEFAULT_MAX_REDIRECT_DRAIN_MS = 2_000
const DEFAULT_MAX_UNCONSUMED_STREAM_MS = 15_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_STREAM_DURATION_MS = 600_000
const DEFAULT_MAX_CONCURRENT_STREAMS = 4

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// Request headers a plugin may never set: they let the caller control framing,
// connection reuse, proxying, the Host pin, or smuggle cookies. Authorization
// is intentionally NOT here — it is a legitimate per-request credential.
const DENY_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "cookie",
])

// Response headers stripped before handing the response to the plugin:
// hop-by-hop framing headers plus set-cookie (plugins must not see host cookies).
const DENY_RESPONSE_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "set-cookie",
])

function isDeniedRequestHeader(key: string): boolean {
  const k = key.toLowerCase()
  return DENY_REQUEST_HEADERS.has(k) || k.startsWith("proxy-") || k.startsWith("sec-")
}

function isDeniedResponseHeader(key: string): boolean {
  const k = key.toLowerCase()
  return DENY_RESPONSE_HEADERS.has(k) || k.startsWith("proxy-")
}

/**
 * Normalize a URL pathname for SCOPE MATCHING: percent-decode each segment,
 * resolve `.`/`..` with a POSIX-style stack, and collapse empty segments
 * (`//`). This is what scope-matches so that `/repos/..%2f..%2fadmin` resolves
 * to `/admin` and cannot masquerade as a granted `/repos/**`. The ORIGINAL URL
 * is still used for the actual request; only the matched path uses this value.
 */
function normalizePath(pathname: string): string {
  const stack: string[] = []
  for (const raw of pathname.split("/")) {
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      // Malformed percent-encoding — keep the raw segment rather than throw, so
      // a bad byte can never be silently dropped into a shorter (more-permissive) path.
      decoded = raw
    }
    // Decoding may reveal encoded slashes (`%2f` → `/`), turning one raw segment
    // into several. Re-split so `..%2f..%2fadmin` collapses to `/admin` and can't
    // smuggle traversal past the scope match.
    for (const segment of decoded.split("/")) {
      if (segment === "" || segment === ".") continue
      if (segment === "..") {
        stack.pop()
        continue
      }
      stack.push(segment)
    }
  }
  return `/${stack.join("/")}`
}

function toBuffer(body: string | ArrayBuffer | Uint8Array): Buffer {
  if (typeof body === "string") return Buffer.from(body, "utf8")
  if (body instanceof Uint8Array) return Buffer.from(body)
  return Buffer.from(new Uint8Array(body))
}

/** Copy any chunk (possibly a Node Buffer) into a fresh plain Uint8Array so no
 *  Node Buffer instance or prototype crosses into plugin/sandbox code. */
function toPlainUint8Array(chunk: Uint8Array): Uint8Array {
  const copy = new Uint8Array(chunk.byteLength)
  copy.set(chunk)
  return copy
}

function stripRequestHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [key, value] of Object.entries(headers)) {
    if (isDeniedRequestHeader(key)) continue
    out[key] = value
  }
  return out
}

function stripResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (isDeniedResponseHeader(key)) continue
    out[key] = value
  }
  return out
}

function dropAuthorization(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") continue
    out[key] = value
  }
  return out
}

/** Force identity encoding on a streamed request: drop any plugin-supplied
 *  accept-encoding (case-insensitive) and pin to identity so host-counted bytes
 *  equal plugin-delivered bytes and compression bombs are avoided. */
function forceIdentityEncoding(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "accept-encoding") continue
    out[key] = value
  }
  out["accept-encoding"] = "identity"
  return out
}

function buildResponse(result: TransportResult): NetworkResponse {
  const headers = stripResponseHeaders(result.headers)
  const body = result.body
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    statusText: result.statusText,
    headers,
    text: async () => body.toString("utf8"),
    json: async <T = unknown>() => JSON.parse(body.toString("utf8")) as T,
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  }
}

export function createNetworkFetcher(config: NetworkFetcherConfig): NetworkFetcher {
  const resolve = config.resolve ?? resolvePublicIps
  const transport = config.transport ?? defaultTransport
  const streamTransport = config.streamTransport ?? defaultStreamTransport
  const maxRequestBytes = config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const maxStreamBytes = config.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const maxRedirectDrainBytes = config.maxRedirectDrainBytes ?? DEFAULT_MAX_REDIRECT_DRAIN_BYTES
  const maxRedirectDrainMs = config.maxRedirectDrainMs ?? DEFAULT_MAX_REDIRECT_DRAIN_MS
  const maxUnconsumedStreamMs = config.maxUnconsumedStreamMs ?? DEFAULT_MAX_UNCONSUMED_STREAM_MS
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const maxStreamDurationMs = config.maxStreamDurationMs ?? DEFAULT_MAX_STREAM_DURATION_MS
  const maxConcurrentStreams = config.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS
  const injectCredential = config.injectCredential

  // Every in-flight fetch's controller, so abortAll() (revoke teardown) can
  // tear them all down at once.
  const inFlight = new Set<AbortController>()
  let activeStreams = 0

  async function fetch(url: string, init: NetworkFetchInit = {}): Promise<NetworkResponse> {
    const method = (init.method ?? "GET").toUpperCase()

    // 5. Request body size cap — computed once, reused across redirects.
    let body: Buffer | undefined
    if (init.body !== undefined) {
      body = toBuffer(init.body)
      if (body.byteLength > maxRequestBytes) {
        throw new Error(
          `request body of ${body.byteLength} bytes exceeds maxRequestBytes (${maxRequestBytes})`
        )
      }
    }

    // 8. One controller for the whole fetch (incl. redirects). Linked to the
    // caller's signal and registered for abortAll().
    const controller = new AbortController()
    inFlight.add(controller)

    const onCallerAbort = (): void => controller.abort()
    if (init.signal) {
      if (init.signal.aborted) controller.abort()
      else init.signal.addEventListener("abort", onCallerAbort, { once: true })
    }

    try {
      return await run({
        currentUrl: url,
        method,
        // 6. Strip denylisted request headers (case-insensitive); Authorization kept.
        headers: stripRequestHeaders(init.headers),
        body,
        originUrl: new URL(url).origin,
        redirectsLeft: maxRedirects,
        controller,
      })
    } finally {
      // 13. Always deregister this fetch's controller.
      if (init.signal) init.signal.removeEventListener("abort", onCallerAbort)
      inFlight.delete(controller)
    }
  }

  interface RunArgs {
    currentUrl: string
    method: string
    headers: Record<string, string>
    body?: Buffer
    originUrl: string
    redirectsLeft: number
    controller: AbortController
  }

  // Steps 1–9: the shared, security-critical pre-flight that runs before ANY
  // byte leaves the process. Identical for buffered and streamed fetches so the
  // two paths cannot diverge in their enforcement.
  async function preflight(
    currentUrl: string,
    method: string,
    controller: AbortController
  ): Promise<{ parsed: URL; addresses: ResolvedAddress[] }> {
    // 1. Parse + validate the URL.
    const parsed = new URL(currentUrl)
    if (parsed.protocol !== "https:") throw new Error(`only https is allowed: ${parsed.protocol}`)
    if (parsed.username !== "" || parsed.password !== "")
      throw new Error("userinfo (user:pass@) is not allowed in url")
    if (parsed.port !== "")
      throw new Error(`only the default https port is allowed, got :${parsed.port}`)

    // 2. Normalize the path for scope matching only.
    const normalizedPath = normalizePath(parsed.pathname)

    // 3. Build the requested scope.
    const requested: NetworkHttpsRequestedScope = {
      url: parsed.toString(),
      origin: parsed.origin,
      host: parsed.hostname,
      method,
      path: normalizedPath,
    }

    // 4. Sanitized operation string for the audit/prompt surface.
    const operation = networkHttpsAdapter.sanitizeOperation("network", requested)

    // 7. Resolve to PUBLIC IPs only; throws on any private addr (SSRF/rebinding).
    const addresses = await resolve(parsed.hostname)
    if (addresses.length === 0) throw new Error(`no addresses resolved for ${parsed.hostname}`)

    // 9. Consent gate BEFORE any byte leaves the process.
    await config.gate.ensure({
      capability: "network:https",
      invocation: config.invocation,
      operation,
      requestedScope: requested,
      signal: controller.signal,
    })

    return { parsed, addresses }
  }

  async function run(args: RunArgs): Promise<NetworkResponse> {
    const { parsed, addresses } = await preflight(args.currentUrl, args.method, args.controller)

    // Credential injection for THIS hop. preflight already dropped Authorization
    // on redirects, so a hop outside the inject scope carries no credential and a
    // hop back inside re-attaches. A conflict throw aborts the whole fetch.
    let hopHeaders = args.headers
    if (injectCredential) {
      const lowered: Record<string, string> = {}
      for (const [k, v] of Object.entries(args.headers)) lowered[k.toLowerCase()] = v
      const injected = await injectCredential(
        { host: parsed.hostname, method: args.method, path: normalizePath(parsed.pathname) },
        lowered
      )
      if (injected) hopHeaders = { ...args.headers, [injected.name]: injected.value }
    }

    // The absolute headers-deadline clock starts here — after DNS resolution,
    // consent, AND credential injection (which can itself involve an async
    // vault read or OAuth refresh) have all completed. None of that latency
    // is network connectivity, so none of it counts against "connect + TLS +
    // headers-arrived."
    const hopDeadline = Date.now() + connectTimeoutMs

    // 10. Raw round-trip with address failover: try each validated public IP in
    // turn until one yields a response. A connection-level failure rolls over to
    // the next address; an aborted request (timeout / revoke) stops immediately.
    // No auto-redirect — that is handled below.
    let result: TransportResult | undefined
    let lastError: unknown
    for (const pinnedAddress of addresses) {
      const remainingMs = hopDeadline - Date.now()
      if (remainingMs <= 0) {
        lastError = new HeadersDeadlineExceededError(connectTimeoutMs)
        break
      }
      try {
        result = await transport({
          url: parsed,
          method: args.method,
          headers: hopHeaders,
          body: args.body,
          pinnedAddress,
          signal: args.controller.signal,
          timeoutMs,
          headersDeadlineMs: remainingMs,
          maxResponseBytes,
        })
        break
      } catch (err) {
        if (args.controller.signal.aborted) throw err
        lastError = err
      }
    }
    if (!result) throw lastError ?? new Error(`all addresses failed for ${parsed.hostname}`)

    // 11. Manual redirect handling.
    if (REDIRECT_STATUSES.has(result.status) && result.headers.location) {
      if (args.redirectsLeft <= 0) throw new Error(`too many redirects (max ${maxRedirects})`)

      const target = new URL(result.headers.location, parsed)
      // v1 policy: reject cross-origin redirects outright.
      if (target.origin !== args.originUrl)
        throw new Error(
          `cross-origin redirect from ${args.originUrl} to ${target.origin} is not allowed`
        )

      return run({
        currentUrl: target.toString(),
        method: args.method,
        // Drop Authorization defensively on any redirect.
        headers: dropAuthorization(args.headers),
        body: args.body,
        originUrl: args.originUrl,
        redirectsLeft: args.redirectsLeft - 1,
        controller: args.controller,
      })
    }

    // 12. Shape the response (hop-by-hop + set-cookie stripped).
    return buildResponse(result)
  }

  async function fetchStream(
    url: string,
    init: NetworkFetchInit = {}
  ): Promise<NetworkStreamResponse> {
    const method = (init.method ?? "GET").toUpperCase()

    let body: Buffer | undefined
    if (init.body !== undefined) {
      body = toBuffer(init.body)
      if (body.byteLength > maxRequestBytes) {
        throw new Error(
          `request body of ${body.byteLength} bytes exceeds maxRequestBytes (${maxRequestBytes})`
        )
      }
    }

    if (activeStreams >= maxConcurrentStreams) {
      throw new Error(`too many concurrent streams (max ${maxConcurrentStreams})`)
    }
    activeStreams += 1

    const controller = new AbortController()
    inFlight.add(controller)
    const onCallerAbort = (): void => controller.abort()
    if (init.signal) {
      if (init.signal.aborted) controller.abort()
      else init.signal.addEventListener("abort", onCallerAbort, { once: true })
    }

    let released = false
    const cleanup = (): void => {
      if (released) return
      released = true
      if (init.signal) init.signal.removeEventListener("abort", onCallerAbort)
      inFlight.delete(controller)
      activeStreams -= 1
    }

    try {
      const response = await runStream({
        currentUrl: url,
        method,
        headers: forceIdentityEncoding(stripRequestHeaders(init.headers)),
        body,
        originUrl: new URL(url).origin,
        redirectsLeft: maxRedirects,
        controller,
      })

      let consumed = false
      const unconsumedTimer = setTimeout(() => {
        if (consumed) return
        controller.abort()
        cleanup()
      }, maxUnconsumedStreamMs)
      if (typeof unconsumedTimer.unref === "function") unconsumedTimer.unref()
      const onStart = (): void => {
        consumed = true
        clearTimeout(unconsumedTimer)
      }

      return { ...response, body: makeStreamBody(response.body, controller, cleanup, onStart) }
    } catch (err) {
      cleanup()
      throw err
    }
  }

  /** Wrap a body so the in-flight controller is deregistered once it is drained,
   *  errors, or is returned. `onStart` fires when iteration actually begins. */
  async function* trackedStream(
    source: AsyncIterable<Uint8Array>,
    cleanup: () => void,
    onStart: () => void
  ): AsyncGenerator<Uint8Array> {
    onStart()
    try {
      for await (const chunk of source) yield chunk
    } finally {
      cleanup()
    }
  }

  /** Enforce a per-chunk idle timeout and a whole-stream duration ceiling. */
  async function* withStreamTimers(
    source: AsyncIterable<Uint8Array>,
    controller: AbortController
  ): AsyncGenerator<Uint8Array> {
    const durationTimer = setTimeout(() => controller.abort(), maxStreamDurationMs)
    if (typeof durationTimer.unref === "function") durationTimer.unref()
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(), streamIdleTimeoutMs)
      if (typeof idleTimer.unref === "function") idleTimer.unref()
    }
    try {
      armIdle()
      for await (const chunk of source) {
        armIdle()
        yield chunk
      }
    } finally {
      clearTimeout(durationTimer)
      if (idleTimer) clearTimeout(idleTimer)
    }
  }

  /** Build the plugin-facing body: timers + in-flight tracking + cancel(). */
  function makeStreamBody(
    source: AsyncIterable<Uint8Array>,
    controller: AbortController,
    cleanup: () => void,
    onStart: () => void
  ): NetworkStreamBody {
    const gen = trackedStream(withStreamTimers(source, controller), cleanup, onStart)
    let iterated = false
    return {
      [Symbol.asyncIterator]() {
        // Consume-once: a single socket cannot be replayed. A second `for await`
        // (or any second iterator acquisition) is a bug — fail loudly.
        if (iterated) throw new BodyAlreadyConsumed()
        iterated = true
        return gen
      },
      cancel(): void {
        onStart()
        controller.abort()
        cleanup()
        void gen.return(undefined)
      },
    }
  }

  /** Cap cumulative bytes; yield plain Uint8Array chunks only. */
  async function* cappedStream(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    let received = 0
    for await (const chunk of source) {
      received += chunk.byteLength
      if (received > maxStreamBytes)
        throw new Error(`response exceeded maxStreamBytes (${maxStreamBytes})`)
      yield toPlainUint8Array(chunk)
    }
  }

  /** Drain a redirect body without trusting it to be small. */
  async function drainRedirectBody(source: AsyncIterable<Uint8Array>): Promise<void> {
    let drained = 0
    const deadline = Date.now() + maxRedirectDrainMs
    for await (const chunk of source) {
      drained += chunk.byteLength
      if (drained > maxRedirectDrainBytes || Date.now() > deadline) break
    }
  }

  async function runStream(args: RunArgs): Promise<
    Omit<NetworkStreamResponse, "body"> & {
      body: AsyncIterable<Uint8Array>
    }
  > {
    const { parsed, addresses } = await preflight(args.currentUrl, args.method, args.controller)

    // Credential injection for THIS hop (same semantics as buffered fetch).
    let hopHeaders = args.headers
    if (injectCredential) {
      const lowered: Record<string, string> = {}
      for (const [k, v] of Object.entries(args.headers)) lowered[k.toLowerCase()] = v
      const injected = await injectCredential(
        { host: parsed.hostname, method: args.method, path: normalizePath(parsed.pathname) },
        lowered
      )
      if (injected) hopHeaders = { ...args.headers, [injected.name]: injected.value }
    }

    // See run()'s identical comment: the clock starts after credential
    // injection, not before.
    const hopDeadline = Date.now() + connectTimeoutMs

    // Round-trip with address failover, streaming the body. Connection-level
    // failure rolls over; abort stops immediately.
    let result: StreamTransportResult | undefined
    let lastError: unknown
    for (const pinnedAddress of addresses) {
      const remainingMs = hopDeadline - Date.now()
      if (remainingMs <= 0) {
        lastError = new HeadersDeadlineExceededError(connectTimeoutMs)
        break
      }
      try {
        result = await streamTransport({
          url: parsed,
          method: args.method,
          headers: hopHeaders,
          body: args.body,
          pinnedAddress,
          signal: args.controller.signal,
          timeoutMs,
          headersDeadlineMs: remainingMs,
          maxResponseBytes: maxStreamBytes,
        })
        break
      } catch (err) {
        if (args.controller.signal.aborted) throw err
        lastError = err
      }
    }
    if (!result) throw lastError ?? new Error(`all addresses failed for ${parsed.hostname}`)

    // Manual redirect handling: drain + discard the (tiny) redirect body, then
    // follow. Cross-origin rejected; Authorization dropped — same as buffered.
    if (REDIRECT_STATUSES.has(result.status) && result.headers.location) {
      if (args.redirectsLeft <= 0) throw new Error(`too many redirects (max ${maxRedirects})`)
      const target = new URL(result.headers.location, parsed)
      if (target.origin !== args.originUrl)
        throw new Error(
          `cross-origin redirect from ${args.originUrl} to ${target.origin} is not allowed`
        )
      await drainRedirectBody(result.stream)
      return runStream({
        currentUrl: target.toString(),
        method: args.method,
        headers: dropAuthorization(args.headers),
        body: args.body,
        originUrl: args.originUrl,
        redirectsLeft: args.redirectsLeft - 1,
        controller: args.controller,
      })
    }

    const declaredLength = Number(result.headers["content-length"])
    if (Number.isFinite(declaredLength) && declaredLength > maxStreamBytes) {
      await result.stream[Symbol.asyncIterator]().return?.(undefined)
      throw new Error(`content-length ${declaredLength} exceeds maxStreamBytes (${maxStreamBytes})`)
    }

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      statusText: result.statusText,
      headers: stripResponseHeaders(result.headers),
      body: cappedStream(result.stream),
    }
  }

  function abortAll(): void {
    for (const controller of inFlight) controller.abort()
  }

  return { fetch, fetchStream, abortAll }
}

/** Absolute, non-resettable deadline for "headers received" — armed once,
 *  never extended by subsequent socket activity (unlike Node's own
 *  request.setTimeout(), which resets on any traffic). Caller is
 *  responsible for calling clear() on every exit path: response received,
 *  abort, or request error. */
export function armHeadersDeadline(
  request: ReturnType<typeof https.request>,
  remainingMs: number
): { clear: () => void } {
  const timer = setTimeout(() => {
    request.destroy(new HeadersDeadlineExceededError(remainingMs))
  }, remainingMs)
  if (typeof timer.unref === "function") timer.unref()
  return { clear: () => clearTimeout(timer) }
}

/**
 * Builds the Agent's `lookup` callback that pins every connection to the one
 * already-validated address, for both call shapes Node's own connect logic
 * may use.
 *
 * A literal-IP URL never reaches this at all (net.isIP short-circuits before
 * any lookup call), but a real hostname does — and since Node 18.13,
 * connecting to a hostname (not a literal IP) goes through
 * lookupAndConnectMultiple by default (autoSelectFamily/Happy Eyeballs),
 * which invokes `lookup` with `{ all: true }` and expects the callback as
 * `(err, addresses[])`, not the classic `(err, address, family)`. Answering
 * only the classic form regardless of `options.all` throws
 * ERR_INVALID_IP_ADDRESS deep in node:net once Node tries to read the
 * addresses array that was never given.
 */
function pinnedLookup(pinnedAddress: ResolvedAddress): NonNullable<https.AgentOptions["lookup"]> {
  return (_hostname, options, callback) => {
    if (options.all)
      callback(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }])
    else callback(null, pinnedAddress.address, pinnedAddress.family)
  }
}

/**
 * Default production transport over node:https.
 *
 * DNS PIN (the core SSRF / rebinding guard): the custom `lookup` callback on the
 * Agent ignores the hostname and hands node EXACTLY the address we already
 * validated as public. The socket therefore connects to the validated IP and
 * can never be re-resolved to a private address between our check and connect.
 * The original hostname is preserved on the request (servername/Host) for TLS
 * SNI and virtual-host routing — we pin the IP, not the name.
 */
export function defaultTransport(args: TransportArgs): Promise<TransportResult> {
  return new Promise<TransportResult>((resolve, reject) => {
    if (args.signal.aborted) {
      reject(new Error("aborted"))
      return
    }

    const agent = new https.Agent({
      // Pin every connection for this request to the validated address.
      lookup: pinnedLookup(args.pinnedAddress),
      ...(args.trustedCaPem ? { ca: args.trustedCaPem } : {}),
    })

    let settled = false
    // Declared up front so every handler below can call it without a
    // use-before-define hazard; `request` is captured by closure.
    let request: ReturnType<typeof https.request> | undefined
    let headersDeadline: { clear: () => void } | undefined
    const onAbort = (): void => {
      headersDeadline?.clear()
      request?.destroy(new Error("aborted"))
    }
    const cleanup = (): void => {
      args.signal.removeEventListener("abort", onAbort)
      agent.destroy()
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    const succeed = (result: TransportResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    args.signal.addEventListener("abort", onAbort, { once: true })

    request = https.request(
      args.url,
      {
        method: args.method,
        headers: args.headers,
        agent,
        servername: args.url.hostname, // TLS SNI uses the real name, not the pinned IP.
      },
      (response: IncomingMessage) => {
        headersDeadline?.clear()
        // Post-headers body-idle timeout starts fresh here — decoupled
        // from the absolute pre-headers deadline that just cleared.
        request?.setTimeout(args.timeoutMs, () => {
          request?.destroy(new Error(`request timed out after ${args.timeoutMs}ms`))
        })

        const chunks: Buffer[] = []
        let received = 0

        response.on("data", (chunk: Buffer) => {
          if (settled) return
          received += chunk.byteLength
          if (received > args.maxResponseBytes) {
            response.destroy()
            fail(new Error(`response exceeded maxResponseBytes (${args.maxResponseBytes})`))
            return
          }
          chunks.push(chunk)
        })

        response.on("end", () => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue
            headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value
          }
          succeed({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            headers,
            body: Buffer.concat(chunks),
          })
        })

        response.on("error", fail)
      }
    )

    headersDeadline = armHeadersDeadline(request, args.headersDeadlineMs)
    request.on("error", (err) => {
      headersDeadline?.clear()
      fail(err)
    })

    if (args.body) request.write(args.body)
    request.end()
  })
}

/**
 * Default production STREAM transport over node:https. Same DNS pin / SNI as
 * {@link defaultTransport}, but resolves once response headers arrive and hands
 * back the response stream (an `AsyncIterable<Uint8Array>`) instead of buffering.
 * The agent is destroyed when the stream ends, errors, or the request aborts, so
 * a fully-drained (or torn-down) body releases the socket.
 */
export function defaultStreamTransport(args: TransportArgs): Promise<StreamTransportResult> {
  return new Promise<StreamTransportResult>((resolve, reject) => {
    if (args.signal.aborted) {
      reject(new Error("aborted"))
      return
    }

    const agent = new https.Agent({
      lookup: pinnedLookup(args.pinnedAddress),
      ...(args.trustedCaPem ? { ca: args.trustedCaPem } : {}),
    })

    let request: ReturnType<typeof https.request> | undefined
    let headersDeadline: { clear: () => void } | undefined
    const onAbort = (): void => {
      headersDeadline?.clear()
      request?.destroy(new Error("aborted"))
    }
    args.signal.addEventListener("abort", onAbort, { once: true })

    const releaseAgent = (): void => {
      args.signal.removeEventListener("abort", onAbort)
      agent.destroy()
    }

    request = https.request(
      args.url,
      {
        method: args.method,
        headers: args.headers,
        agent,
        servername: args.url.hostname,
      },
      (response: IncomingMessage) => {
        headersDeadline?.clear()
        // No request.setTimeout() here — body-phase timing is owned
        // entirely by withStreamTimers() (streamIdleTimeoutMs,
        // maxStreamDurationMs) in the outer closure, via controller.abort(),
        // a mechanism independent of request.destroy(). Installing a second
        // socket-level timer here is exactly the bug this task fixes.
        response.on("close", releaseAgent)
        response.on("error", releaseAgent)

        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(response.headers)) {
          if (value === undefined) continue
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value
        }
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          headers,
          stream: response,
        })
      }
    )

    headersDeadline = armHeadersDeadline(request, args.headersDeadlineMs)
    request.on("error", (err) => {
      headersDeadline?.clear()
      releaseAgent()
      reject(err)
    })

    if (args.body) request.write(args.body)
    request.end()
  })
}
