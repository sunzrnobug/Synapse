import type {
  AdminReportsResponse,
  DeviceCodePollResponse,
  DeviceCodeStartResponse,
  MyPluginsResponse,
  PluginDetailResponse,
  RateResponse,
  ReportStatus,
  ResolveDownloadResponse,
  SearchPluginsResponse,
  SessionResponse,
  Visibility,
} from "@synapse/marketplace-types"
import type { z } from "zod"
import process from "node:process"
import {
  actionOkResponseSchema,
  adminReportsResponseSchema,
  deviceCodePollResponseSchema,
  deviceCodeStartResponseSchema,
  myPluginsResponseSchema,
  pluginDetailResponseSchema,
  rateResponseSchema,
  resolveDownloadResponseSchema,
  searchPluginsResponseSchema,
  sessionResponseSchema,
} from "@synapse/marketplace-types"

// Client for the Synapse marketplace backend (the authoritative source).
// The desktop app browses plugins, resolves signed download URLs, and — when
// signed in — sends a bearer token so owners see private plugins and can rate.
// The legacy static registry (marketplace-registry.ts) remains a read-only
// fallback for offline/degraded operation.

export const DEFAULT_MARKETPLACE_API_URL = "http://localhost:8787"

export class MarketplaceApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "MarketplaceApiError"
    this.status = status
    this.code = code
  }
}

export interface MarketplaceApiOptions {
  baseUrl?: string
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** Supplies the current session token for authenticated requests, if any. */
  getToken?: () => Promise<string | undefined> | string | undefined
}

export interface MarketplaceApi {
  search: (query?: string) => Promise<SearchPluginsResponse>
  detail: (pluginId: string) => Promise<PluginDetailResponse>
  resolveDownload: (pluginId: string, version: string) => Promise<ResolveDownloadResponse>
  rate: (pluginId: string, stars: number) => Promise<RateResponse>
  myPlugins: () => Promise<MyPluginsResponse>
  setVisibility: (pluginId: string, visibility: Visibility) => Promise<PluginDetailResponse>
  yank: (pluginId: string, version: string, reason?: string) => Promise<PluginDetailResponse>
  report: (pluginId: string, reason: string) => Promise<void>
  adminRemove: (pluginId: string) => Promise<void>
  adminRestore: (pluginId: string) => Promise<void>
  adminReports: (status?: ReportStatus) => Promise<AdminReportsResponse>
  resolveReport: (reportId: string, status: "reviewed" | "dismissed") => Promise<void>
  session: () => Promise<SessionResponse>
  deviceStart: () => Promise<DeviceCodeStartResponse>
  devicePoll: (deviceCode: string) => Promise<DeviceCodePollResponse>
}

export function resolveMarketplaceBaseUrl(explicit?: string): string {
  return (explicit ?? process.env.SYNAPSE_MARKETPLACE_URL ?? DEFAULT_MARKETPLACE_API_URL).replace(
    /\/+$/,
    ""
  )
}

export function createMarketplaceApi(options: MarketplaceApiOptions = {}): MarketplaceApi {
  const doFetch = options.fetch ?? globalThis.fetch
  const base = resolveMarketplaceBaseUrl(options.baseUrl)

  async function authHeader(): Promise<Record<string, string>> {
    const token = options.getToken ? await options.getToken() : undefined
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  async function handle<T>(response: Response, schema?: z.ZodType<T>): Promise<T> {
    if (!response.ok) {
      let code = "http_error"
      let message = `Marketplace request failed (${response.status})`
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } }
        if (body.error?.code) code = body.error.code
        if (body.error?.message) message = body.error.message
      } catch {
        // non-JSON error body; keep defaults
      }
      throw new MarketplaceApiError(response.status, code, message)
    }
    const json: unknown = await response.json()
    if (!schema) return json as T
    const result = schema.safeParse(json)
    if (!result.success) {
      throw new MarketplaceApiError(
        response.status,
        "invalid_response",
        `Marketplace returned an unexpected response shape: ${result.error.message}`
      )
    }
    return result.data
  }

  async function get<T>(path: string, schema?: z.ZodType<T>): Promise<T> {
    const headers = await authHeader()
    try {
      const response =
        Object.keys(headers).length > 0
          ? await doFetch(`${base}${path}`, { headers })
          : await doFetch(`${base}${path}`)
      return await handle<T>(response, schema)
    } catch (err) {
      throw asApiError(err)
    }
  }

  async function send<T>(
    path: string,
    method: string,
    body: unknown,
    schema?: z.ZodType<T>
  ): Promise<T> {
    const headers = { "content-type": "application/json", ...(await authHeader()) }
    try {
      const response = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: JSON.stringify(body),
      })
      return await handle<T>(response, schema)
    } catch (err) {
      throw asApiError(err)
    }
  }

  return {
    search(query?: string) {
      const suffix = query && query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""
      return get(`/plugins${suffix}`, searchPluginsResponseSchema)
    },
    detail(pluginId: string) {
      return get(`/plugins/${encodeURIComponent(pluginId)}`, pluginDetailResponseSchema)
    },
    resolveDownload(pluginId: string, version: string) {
      return get(
        `/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/download`,
        resolveDownloadResponseSchema
      )
    },
    rate(pluginId: string, stars: number) {
      return send(
        `/plugins/${encodeURIComponent(pluginId)}/rating`,
        "PUT",
        { stars },
        rateResponseSchema
      )
    },
    myPlugins() {
      return get("/plugins/mine", myPluginsResponseSchema)
    },
    setVisibility(pluginId: string, visibility: Visibility) {
      return send(
        `/plugins/${encodeURIComponent(pluginId)}/visibility`,
        "PATCH",
        { visibility },
        pluginDetailResponseSchema
      )
    },
    yank(pluginId: string, version: string, reason?: string) {
      return send(
        `/plugins/${encodeURIComponent(pluginId)}/yank`,
        "POST",
        { version, ...(reason ? { reason } : {}) },
        pluginDetailResponseSchema
      )
    },
    async report(pluginId: string, reason: string) {
      await send(
        `/plugins/${encodeURIComponent(pluginId)}/report`,
        "POST",
        { reason },
        actionOkResponseSchema
      )
    },
    async adminRemove(pluginId: string) {
      await send(
        `/plugins/${encodeURIComponent(pluginId)}/remove`,
        "POST",
        {},
        actionOkResponseSchema
      )
    },
    async adminRestore(pluginId: string) {
      await send(
        `/plugins/${encodeURIComponent(pluginId)}/restore`,
        "POST",
        {},
        actionOkResponseSchema
      )
    },
    adminReports(status?: ReportStatus) {
      const suffix = status ? `?status=${encodeURIComponent(status)}` : ""
      return get(`/admin/reports${suffix}`, adminReportsResponseSchema)
    },
    async resolveReport(reportId: string, status: "reviewed" | "dismissed") {
      await send(
        `/admin/reports/${encodeURIComponent(reportId)}/resolve`,
        "POST",
        { status },
        actionOkResponseSchema
      )
    },
    session() {
      return get("/session", sessionResponseSchema)
    },
    deviceStart() {
      return send("/auth/device/start", "POST", {}, deviceCodeStartResponseSchema)
    },
    devicePoll(deviceCode: string) {
      return send("/auth/device/poll", "POST", { deviceCode }, deviceCodePollResponseSchema)
    },
  }
}

function asApiError(err: unknown): MarketplaceApiError {
  if (err instanceof MarketplaceApiError) return err
  return new MarketplaceApiError(
    0,
    "network_error",
    `Could not reach the marketplace: ${err instanceof Error ? err.message : String(err)}`
  )
}
