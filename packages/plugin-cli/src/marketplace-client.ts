import type {
  DeviceCodePollResponse,
  DeviceCodeStartResponse,
  PublishResponse,
  SessionResponse,
  Visibility,
} from "@synapsepkg/marketplace-types"
import type { PluginManifest } from "@synapsepkg/plugin-manifest"
import type { Buffer } from "node:buffer"
import type { z } from "zod"
import {
  deviceCodePollResponseSchema,
  deviceCodeStartResponseSchema,
  publishResponseSchema,
  sessionResponseSchema,
} from "@synapsepkg/marketplace-types"

/** Error carrying the marketplace API's status + machine code. */
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

export interface PublishMetadata {
  visibility: Visibility
  sha256: string
  sizeBytes: number
  manifest: PluginManifest
}

export interface MarketplaceClient {
  deviceStart: () => Promise<DeviceCodeStartResponse>
  devicePoll: (deviceCode: string) => Promise<DeviceCodePollResponse>
  session: (token: string) => Promise<SessionResponse>
  publish: (
    token: string,
    meta: PublishMetadata,
    pkg: Buffer,
    filename: string
  ) => Promise<PublishResponse>
}

export interface ClientOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
}

/** A thin client for the marketplace HTTP API, used by the CLI commands. */
export function createMarketplaceClient(options: ClientOptions): MarketplaceClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const base = options.baseUrl.replace(/\/+$/, "")

  async function readError(res: Response): Promise<never> {
    let code = "http_error"
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      if (body.error?.code) code = body.error.code
      if (body.error?.message) message = body.error.message
    } catch {
      // non-JSON body; keep defaults
    }
    throw new MarketplaceApiError(res.status, code, message)
  }

  function parse<T>(res: Response, schema: z.ZodType<T>, json: unknown): T {
    const result = schema.safeParse(json)
    if (!result.success) {
      throw new MarketplaceApiError(
        res.status,
        "invalid_response",
        `Marketplace returned an unexpected response shape: ${result.error.message}`
      )
    }
    return result.data
  }

  async function postJson<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    token?: string
  ): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) return readError(res)
    return parse(res, schema, await res.json())
  }

  return {
    async deviceStart() {
      const res = await doFetch(`${base}/auth/device/start`, { method: "POST" })
      if (!res.ok) return readError(res)
      return parse(res, deviceCodeStartResponseSchema, await res.json())
    },

    devicePoll(deviceCode: string) {
      return postJson("/auth/device/poll", { deviceCode }, deviceCodePollResponseSchema)
    },

    async session(token: string) {
      const res = await doFetch(`${base}/session`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!res.ok) return readError(res)
      return parse(res, sessionResponseSchema, await res.json())
    },

    async publish(token, meta, pkg, filename) {
      const form = new FormData()
      form.append("metadata", JSON.stringify(meta))
      form.append("package", new Blob([pkg], { type: "application/zip" }), filename)
      const res = await doFetch(`${base}/plugins`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      })
      if (!res.ok) return readError(res)
      return parse(res, publishResponseSchema, await res.json())
    },
  }
}
