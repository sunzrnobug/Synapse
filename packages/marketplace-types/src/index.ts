// @synapsepkg/marketplace-types
//
// The marketplace domain model and HTTP API contract as a single source of
// truth. zod schemas are authoritative; TypeScript types are inferred from them
// (no hand-maintained parallel interfaces to drift). Shared by the marketplace
// server, the plugin CLI, the desktop app, and the web portal so a request
// validated on the client matches what the server parses.

export {
  actionOkResponseSchema,
  adminReportsResponseSchema,
  apiErrorSchema,
  createReviewRequestSchema,
  deviceCodePollRequestSchema,
  deviceCodePollResponseSchema,
  deviceCodeStartResponseSchema,
  listReviewsResponseSchema,
  myPluginsResponseSchema,
  paginationQuerySchema,
  pluginDetailResponseSchema,
  publishRequestSchema,
  publishResponseSchema,
  rateRequestSchema,
  rateResponseSchema,
  reportRequestSchema,
  resolveDownloadResponseSchema,
  resolveReportRequestSchema,
  searchPluginsQuerySchema,
  searchPluginsResponseSchema,
  sessionResponseSchema,
  setVisibilityRequestSchema,
  yankRequestSchema,
} from "./api"

export type {
  ActionOkResponse,
  AdminReportsResponse,
  ApiError,
  CreateReviewRequest,
  DeviceCodePollRequest,
  DeviceCodePollResponse,
  DeviceCodeStartResponse,
  ListReviewsResponse,
  MyPluginsResponse,
  PaginationQuery,
  PluginDetailResponse,
  PublishRequest,
  PublishResponse,
  RateRequest,
  RateResponse,
  ReportRequest,
  ResolveDownloadResponse,
  ResolveReportRequest,
  SearchPluginsQuery,
  SearchPluginsResponse,
  SessionResponse,
  SetVisibilityRequest,
  YankRequest,
} from "./api"

export {
  authProviderSchema,
  handleSchema,
  httpsUrlSchema,
  localizedStringSchema,
  pluginIdSchema,
  pluginSortSchema,
  pluginStatusSchema,
  reportKindSchema,
  reportStatusSchema,
  semverSchema,
  sha256Schema,
  timestampSchema,
  userRoleSchema,
  visibilitySchema,
} from "./common"

export type {
  AuthProvider,
  LocalizedString,
  PluginSort,
  PluginStatus,
  ReportKind,
  ReportStatus,
  UserRole,
  Visibility,
} from "./common"

export {
  authIdentitySchema,
  downloadSchema,
  pluginSchema,
  pluginStatsSchema,
  pluginSummarySchema,
  pluginVersionSchema,
  ratingSchema,
  reportSchema,
  reviewSchema,
  userSchema,
} from "./domain"

export type {
  AuthIdentity,
  Download,
  Plugin,
  PluginStats,
  PluginSummary,
  PluginVersion,
  Rating,
  Report,
  Review,
  User,
} from "./domain"
