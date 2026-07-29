import { z } from "zod"
import {
  httpsUrlSchema,
  pluginSortSchema,
  semverSchema,
  sha256Schema,
  timestampSchema,
  visibilitySchema,
} from "./common"
import {
  pluginSchema,
  pluginSummarySchema,
  pluginVersionSchema,
  ratingSchema,
  reportSchema,
  reviewSchema,
  userSchema,
} from "./domain"

// HTTP API contract shared by the marketplace server and every client (CLI,
// desktop app, web portal). Request and response bodies validate against the
// same schemas on both ends. The `.syn` payload itself rides as a multipart
// part on publish; everything here is JSON metadata.

// ── Pagination ────────────────────────────────────────────────────────────────

export const paginationQuerySchema = z
  .object({
    page: z.number().int().min(1).default(1),
    perPage: z.number().int().min(1).max(100).default(20),
  })
  .strict()

const paginationMeta = {
  page: z.number().int().min(1),
  perPage: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
}

// ── Auth: CLI device-code flow + session ──────────────────────────────────────

/** Server's reply to a device-code request — what `synapse-plugin login` shows. */
export const deviceCodeStartResponseSchema = z
  .object({
    deviceCode: z.string().min(1),
    userCode: z.string().min(1),
    verificationUri: httpsUrlSchema,
    /** Seconds the CLI should wait between polls. */
    interval: z.number().int().positive(),
    expiresAt: timestampSchema,
  })
  .strict()

export const deviceCodePollRequestSchema = z.object({ deviceCode: z.string().min(1) }).strict()

/** Poll result: still waiting, or authorized with tokens. */
export const deviceCodePollResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z
    .object({
      status: z.literal("authorized"),
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1).optional(),
      expiresAt: timestampSchema,
      user: userSchema,
    })
    .strict(),
])

/** The authenticated caller — `GET /session` / `whoami`. */
export const sessionResponseSchema = z.object({ user: userSchema }).strict()

// ── Browse & search ───────────────────────────────────────────────────────────

export const searchPluginsQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    category: z.string().min(1).optional(),
    sort: pluginSortSchema.default("relevance"),
    page: z.number().int().min(1).default(1),
    perPage: z.number().int().min(1).max(100).default(20),
  })
  .strict()

export const searchPluginsResponseSchema = z
  .object({
    items: z.array(pluginSummarySchema),
    ...paginationMeta,
  })
  .strict()

/** Full plugin view: the record, its versions, and the caller's own rating. */
export const pluginDetailResponseSchema = z
  .object({
    plugin: pluginSchema,
    ownerHandle: z.string().min(1),
    versions: z.array(pluginVersionSchema),
    myRating: ratingSchema.optional(),
  })
  .strict()

export const myPluginsResponseSchema = z.object({ items: z.array(pluginSummarySchema) }).strict()

// ── Publish & lifecycle ───────────────────────────────────────────────────────

/**
 * Publish metadata accompanying the uploaded `.syn`. Plugin id, version, and
 * engine range are read from `manifest`; the server cross-checks the upload's
 * digest against `sha256` and rejects on mismatch.
 */
export const publishRequestSchema = z
  .object({
    visibility: visibilitySchema,
    sha256: sha256Schema,
    sizeBytes: z.number().int().positive(),
    manifest: pluginVersionSchema.shape.manifestSnapshot,
  })
  .strict()

export const publishResponseSchema = z
  .object({
    plugin: pluginSchema,
    version: pluginVersionSchema,
  })
  .strict()

export const setVisibilityRequestSchema = z.object({ visibility: visibilitySchema }).strict()

export const yankRequestSchema = z
  .object({
    version: semverSchema,
    reason: z.string().min(1).max(500).optional(),
  })
  .strict()

/** A user-submitted abuse/quality report against a plugin. */
export const reportRequestSchema = z.object({ reason: z.string().min(1).max(1000) }).strict()

/** Uniform ack for action endpoints with no data to return: report a
 *  plugin, admin remove/restore, resolve a report. */
export const actionOkResponseSchema = z.object({ status: z.literal("ok") }).strict()

// ── Admin moderation ──────────────────────────────────────────────────────────

/** The admin review queue. */
export const adminReportsResponseSchema = z.object({ items: z.array(reportSchema) }).strict()

/** Resolve a report: mark it actioned or dismissed. */
export const resolveReportRequestSchema = z
  .object({ status: z.enum(["reviewed", "dismissed"]) })
  .strict()

// ── Download ──────────────────────────────────────────────────────────────────

/** A short-lived, signed URL plus the digest the client must verify post-download. */
export const resolveDownloadResponseSchema = z
  .object({
    version: semverSchema,
    downloadUrl: httpsUrlSchema,
    sha256: sha256Schema,
    expiresAt: timestampSchema,
  })
  .strict()

// ── Ratings & reviews ─────────────────────────────────────────────────────────

export const rateRequestSchema = z.object({ stars: z.number().int().min(1).max(5) }).strict()

export const rateResponseSchema = z
  .object({
    rating: ratingSchema,
    stats: pluginSchema.shape.stats,
  })
  .strict()

export const createReviewRequestSchema = z.object({ body: z.string().min(1).max(4000) }).strict()

export const listReviewsResponseSchema = z
  .object({
    items: z.array(reviewSchema),
    ...paginationMeta,
  })
  .strict()

// ── Errors ────────────────────────────────────────────────────────────────────

/** Uniform error envelope returned by the API on a non-2xx response. */
export const apiErrorSchema = z
  .object({
    error: z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      /** Field-level validation problems, when the cause is a bad request body. */
      issues: z.array(z.string().min(1)).optional(),
    }),
  })
  .strict()

export type PaginationQuery = z.infer<typeof paginationQuerySchema>
export type DeviceCodeStartResponse = z.infer<typeof deviceCodeStartResponseSchema>
export type DeviceCodePollRequest = z.infer<typeof deviceCodePollRequestSchema>
export type DeviceCodePollResponse = z.infer<typeof deviceCodePollResponseSchema>
export type SessionResponse = z.infer<typeof sessionResponseSchema>
export type SearchPluginsQuery = z.infer<typeof searchPluginsQuerySchema>
export type SearchPluginsResponse = z.infer<typeof searchPluginsResponseSchema>
export type PluginDetailResponse = z.infer<typeof pluginDetailResponseSchema>
export type MyPluginsResponse = z.infer<typeof myPluginsResponseSchema>
export type PublishRequest = z.infer<typeof publishRequestSchema>
export type PublishResponse = z.infer<typeof publishResponseSchema>
export type SetVisibilityRequest = z.infer<typeof setVisibilityRequestSchema>
export type YankRequest = z.infer<typeof yankRequestSchema>
export type ReportRequest = z.infer<typeof reportRequestSchema>
export type ActionOkResponse = z.infer<typeof actionOkResponseSchema>
export type AdminReportsResponse = z.infer<typeof adminReportsResponseSchema>
export type ResolveReportRequest = z.infer<typeof resolveReportRequestSchema>
export type ResolveDownloadResponse = z.infer<typeof resolveDownloadResponseSchema>
export type RateRequest = z.infer<typeof rateRequestSchema>
export type RateResponse = z.infer<typeof rateResponseSchema>
export type CreateReviewRequest = z.infer<typeof createReviewRequestSchema>
export type ListReviewsResponse = z.infer<typeof listReviewsResponseSchema>
export type ApiError = z.infer<typeof apiErrorSchema>
