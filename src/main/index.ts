import type { ClipboardContent } from "@synapse/plugin-sdk"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import type { ToolResilienceSettings } from "./ai/ai-settings-store"
import type { ChatProvider } from "./ai/providers/types"
import type { SecretProtector } from "./lan/credential-store"
import type { LanDevice, LanPairing, LanStatus, LanTransfer } from "./lan/types"
import type { HeadlessApprovalServerHandle } from "./mcp/headless-approval-server"
import type { SearchWindowDeps } from "./search-window"
import type { AutoUpdaterPort } from "./updates/update-service"
import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import * as path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { derivePluginProfile, profileToAgentText } from "@synapse/plugin-manifest"
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron"
import electronUpdater from "electron-updater"
import { AgentMissingKeyError, AgentService } from "./ai/agent-service"
import {
  aiSettingsFilePath,
  AiSettingsStore,
  DEFAULT_TOOL_RESILIENCE,
} from "./ai/ai-settings-store"
import { aiApprovalsFilePath, ApprovalStore } from "./ai/approval-store"
import {
  MIN_TOMBSTONE_RETENTION_MS,
  releaseArtifactRunResources,
} from "./ai/artifacts/artifact-retention"
import { artifactsRoot, ArtifactStore } from "./ai/artifacts/artifact-store"
import { ARTIFACT_FQ_PREFIX, ArtifactToolSource } from "./ai/artifacts/artifact-tool-source"
import { RootBudgetLedgerStore } from "./ai/budget/root-budget-ledger"
import { asFallbackSource, CompositeToolHost } from "./ai/composite-tool-host"
import { ConversationStore } from "./ai/conversation-store"
import { aiCredentialFilePath, AiCredentialStore } from "./ai/credential-store"
import {
  estimatorQuarantineFilePath,
  EstimatorQuarantineStore,
} from "./ai/estimator-quarantine-store"
import { ExecutionApprovalResolver } from "./ai/execution/execution-approval"
import { executionLogFilePath, ExecutionLogStore } from "./ai/execution/execution-log-store"
import { EXECUTION_FQ_PREFIX, ExecutionToolHostSource } from "./ai/execution/execution-tool-host"
import { createMcpClient } from "./ai/mcp-client-factory"
import { MCP_FQ_PREFIX, McpClientManager } from "./ai/mcp-client-manager"
import { aiMcpServersFilePath, McpServerConfigStore } from "./ai/mcp-server-config-store"
import { MemoryService } from "./ai/memory/memory-service"
import { aiMemoryFilePath, MemoryStore } from "./ai/memory/memory-store"
import { MEMORY_FQ_PREFIX, MemoryToolSource } from "./ai/memory/memory-tools"
import { OpenAiEmbeddingProvider } from "./ai/memory/openai-embedding-provider"
import { PLAN_FQ_PREFIX, PlanToolSource } from "./ai/plan/plan-tool-source"
import { RunPlanRegistry } from "./ai/plan/run-plan-registry"
import {
  PLUGIN_INTROSPECT_PREFIX,
  PluginIntrospectionToolSource,
} from "./ai/plugin-introspection-tools"
import { DEFAULT_PROVIDER_ID, defaultProviderCatalog } from "./ai/providers/catalog"
import { ResilientToolHost } from "./ai/resilient-tool-host"
import { getLatestPlan, runTraceDir, upsertRunTrace } from "./ai/run-trace-store"
import { AgentRunRecoveryService } from "./ai/runs/agent-run-recovery-service"
import { AgentRunStore } from "./ai/runs/agent-run-store"
import {
  freezeAuthoritySnapshot,
  withFrozenAuthorityCapabilities,
} from "./ai/runs/authority-snapshot"
import { buildTraceFromCheckpoint } from "./ai/runs/interactive-run-driver"
import { rootSetHashFor } from "./ai/runs/interactive-run-setup"
import { rebuildRecoveryAuthority } from "./ai/runs/recovery-authority"
import { createRunEventEmitter } from "./ai/runs/run-event-emitter"
import { RunEventStore } from "./ai/runs/run-event-store"
import { finalizeRun } from "./ai/runs/run-finalizer"
import { toAgentChildTaskSummary } from "./ai/runs/run-projection"
import {
  autoResumeRecoverableRuns,
  continueBackgroundOrSubagentRun,
} from "./ai/runs/run-recovery-orchestrator"
import { buildSkillCatalog } from "./ai/skills/skill-catalog"
import {
  releaseSkillPackageLeases,
  skillPackageLeasesFilePath,
  SkillPackageLeaseStore,
} from "./ai/skills/skill-package-leases"
import { skillPackagesRoot, SkillPackageStore } from "./ai/skills/skill-package-store"
import { SKILL_FQ_PREFIX, SkillToolSource } from "./ai/skills/skill-tool-source"
import { SubagentRunner } from "./ai/subagent/subagent-runner"
import { SpawnSubagentToolSource, SUBAGENT_FQ_PREFIX } from "./ai/subagent/subagent-tool-source"
import { ChildTaskScheduler } from "./ai/tasks/child-task-scheduler"
import { ChildTaskStore } from "./ai/tasks/child-task-store"
import { ChildTaskToolSource } from "./ai/tasks/child-task-tool-source"
import { AiToolRegistry } from "./ai/tool-registry"
import { migrateAgentShellRoots } from "./ai/workspace/workspace-migration"
import { WorkspaceRootStore } from "./ai/workspace/workspace-root-store"
import { WorkspaceStore } from "./ai/workspace/workspace-store"
import { ApprovalRegistry } from "./approvals/approval-registry"
import { ensureDevAppUserModelShortcut } from "./dev-app-shortcut"
import {
  destroyFloatingBallWindow,
  hideFloatingBallWindow,
  moveFloatingBallBy,
  openFloatingBallFeature,
  syncFloatingBallWindow,
  toggleFloatingBallMenu,
} from "./floating-ball-window"
import { registerAiIpc } from "./ipc/ai"
import { CapabilityIpcService, registerCapabilitiesIpc } from "./ipc/capabilities"
import { attachCapabilityPromptLifecycle } from "./ipc/capability-prompt-lifecycle"
import {
  createCapabilityPromptSender,
  createHostResourcePromptSender,
} from "./ipc/capability-prompt-router"
import { registerCredentialsIpc } from "./ipc/credentials"
import { HostResourceIpcService, registerHostResourcesIpc } from "./ipc/host-resources"
import { registerLanIpc } from "./ipc/lan"
import { LauncherService } from "./ipc/launcher-service"
import { registerMarketplaceIpc } from "./ipc/marketplace"
import { registerMcpOnboardingIpc } from "./ipc/mcp-onboarding"
import { registerMemoryIpc } from "./ipc/memory"
import { registerPluginIpc } from "./ipc/plugins"
import { registerRunsIpc } from "./ipc/runs"
import { registerTriggersIpc, TriggerIpcService } from "./ipc/triggers"
import { registerUpdatesIpc } from "./ipc/updates"
import { readJsonFile } from "./lan/atomic-json-store"
import { BonjourLanDiscoveryAdapter } from "./lan/bonjour-discovery-adapter"
import { LanCredentialLoadError } from "./lan/credential-store"
import {
  LAN_SIMULATION_PROFILE_ENV,
  resetDevLanSimulationCredentials,
  resolveDevLanSimulation,
} from "./lan/dev-simulation"
import { LanService } from "./lan/lan-service"
import { configureRootLogger, logger } from "./logging"
import { createFileSink } from "./logging/file-sink"
import { MarketplaceAccountService } from "./marketplace/account-service"
import { marketplaceTokenFilePath, MarketplaceTokenStore } from "./marketplace/token-store"
import { startHeadlessApprovalServer } from "./mcp/headless-approval-server"
import { createHostResourceAudit } from "./mcp/host-resource-audit"
import { runMcpConnectionTest } from "./mcp/mcp-connection-test"
import { purgeFinalizedMcpRuns } from "./mcp/mcp-durable-run"
import { McpRunLeaseStore } from "./mcp/mcp-run-lease"
import { defaultNotificationIcon, showStartupNotification } from "./notifications"
import { createCapabilityAudit } from "./plugins/capability-audit"
import { createElectronSecretPrompt, CredentialBroker } from "./plugins/credential-broker"
import { createElectronPluginAdapters } from "./plugins/electron-adapters"
import { GrantStore, grantStoreFilePath } from "./plugins/grant-store"
import { createHotkeyAdapter } from "./plugins/hotkey-adapter"
import { createMarketplaceApi } from "./plugins/marketplace-api"
import { PluginHost } from "./plugins/plugin-host"
import {
  getContentType,
  resolveSafePluginAssetPath,
  resolveStaticPath,
} from "./protocol/resolve-static-path"
import {
  consumeSearchWindowTrayOpenSuppression,
  ensureSearchWindow,
  hideSearchWindow,
  markSearchWindowReady,
  setSearchWindowQuitting,
  showSearchWindow,
  toggleSearchWindow,
} from "./search-window"
import { settingsFilePath } from "./settings/settings"
import {
  bindGlobalShortcut,
  bindGlobalShortcutWithRetry,
  resumeGlobalShortcut,
  suspendGlobalShortcut,
  unbindGlobalShortcut,
} from "./shortcut"
import { createTray, defaultTrayIcon, destroyTray, refreshTrayMenu } from "./tray"
import { shouldAutoCheckOnStartup, UpdateService } from "./updates/update-service"
import { attachWindowSecurity, isSameOrigin } from "./window-security"
import {
  dimTitleBarOverlay,
  resolveTitleBarScheme,
  titleBarOverlayForScheme,
} from "./window-title-bar"

const isDev = !app.isPackaged
const lanSimulation = resolveDevLanSimulation({
  defaultUserDataDir: app.getPath("userData"),
  isPackaged: app.isPackaged,
  profile: process.env[LAN_SIMULATION_PROFILE_ENV],
})
if (lanSimulation) {
  app.setPath("userData", lanSimulation.userDataDir)
}
configureRootLogger({ userDataDir: app.getPath("userData") })
if (lanSimulation) {
  logger.child("synapse").warn("using LAN simulation profile", {
    profile: lanSimulation.profile,
    userDataDir: lanSimulation.userDataDir,
  })
}
// electron-vite injects this in dev (Vite dev server URL). Undefined in prod.
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const isMcpStdioMode = process.argv.includes("--mcp-stdio")

// Custom scheme used for the production renderer. Loading the renderer at
// `app://app/index.html` makes absolute asset paths (`/assets/...`) resolve
// to `app://app/assets/...`, which the handler maps to files under
// `out/renderer/`. Loading via `file://` would make the same paths resolve
// to the filesystem root and 404 every asset.
const APP_SCHEME = "app"
const APP_ORIGIN = `${APP_SCHEME}://app`

// Serves a plugin's declared icon (manifest `icon` / command `icon`) from its
// install directory, as `plugin-asset://<pluginId>/<relativeIconPath>`. Reuses
// resolve-static-path's traversal check, rooted at that plugin's own rootDir
// rather than the renderer output directory.
const PLUGIN_ASSET_SCHEME = "plugin-asset"

// Must be called *before* app is ready. Marking the scheme `standard` and
// `secure` makes its origin behave like https for CORS, cookies, and CSP.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  {
    scheme: PLUGIN_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

// Marketplace user avatars are served by GitHub (avatars + camo redirects).
// Allowlist GitHub's image hosts in img-src rather than opening it to all https.
const AVATAR_IMG_SRC = "https://*.githubusercontent.com"

const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  `img-src 'self' data: blob: ${AVATAR_IMG_SRC} ${PLUGIN_ASSET_SCHEME}:; font-src 'self' data:; connect-src 'self'; ` +
  "object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'"

function devCsp(devOrigin: string): string {
  const ws = devOrigin.replace(/^http/, "ws")
  return (
    `default-src 'self' ${devOrigin} ${ws}; ` +
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devOrigin}; ` +
    `style-src 'self' 'unsafe-inline' ${devOrigin}; ` +
    `img-src 'self' data: blob: ${AVATAR_IMG_SRC} ${PLUGIN_ASSET_SCHEME}: ${devOrigin}; ` +
    `font-src 'self' data: ${devOrigin}; ` +
    `connect-src 'self' ${devOrigin} ${ws}`
  )
}

function applyCsp(): void {
  const csp = isDev && rendererDevUrl ? devCsp(rendererDevUrl) : PROD_CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    })
  })
}

function registerStaticProtocol(): void {
  // electron-vite emits the renderer bundle to out/renderer/, which sits
  // next to out/main/index.js after build.
  const root = path.join(__dirname, "../renderer")

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const resolved = resolveStaticPath(url.pathname, root)

    if (resolved.kind === "forbidden") {
      return new Response("Forbidden", { status: 403 })
    }

    // `net.fetch` reads the file (transparently handling asar) and returns a
    // Response with proper streaming. We override Content-Type because some
    // extensions (`.woff2`, `.wasm`) are not always inferred correctly.
    const fileUrl = pathToFileURL(resolved.filePath).toString()
    const response = await net.fetch(fileUrl, { bypassCustomProtocolHandlers: true })
    if (!response.ok) {
      return response
    }
    const headers = new Headers(response.headers)
    headers.set("content-type", getContentType(resolved.filePath))
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}

const launcher = new LauncherService()
let plugins: PluginHost

function registerPluginAssetProtocol(): void {
  protocol.handle(PLUGIN_ASSET_SCHEME, async (request) => {
    const url = new URL(request.url)
    const pluginId = url.hostname
    const entry = plugins?.registry.get(pluginId)
    if (!entry) return new Response("Not Found", { status: 404 })

    const resolved = await resolveSafePluginAssetPath(url.pathname, entry.rootDir)
    if (resolved.kind === "forbidden") {
      return new Response("Forbidden", { status: 403 })
    }

    const fileUrl = pathToFileURL(resolved.filePath).toString()
    const response = await net.fetch(fileUrl, { bypassCustomProtocolHandlers: true })
    if (!response.ok) return response
    const headers = new Headers(response.headers)
    headers.set("content-type", getContentType(resolved.filePath))
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}
let capabilityService!: CapabilityIpcService
let hostResourceIpcService!: HostResourceIpcService
let approvalRegistry!: ApprovalRegistry
let lan: LanService
let agent: AgentService
let agentRunRecoveryService: AgentRunRecoveryService
let childTaskStore: ChildTaskStore
let childTaskScheduler: ChildTaskScheduler
let estimatorQuarantine: EstimatorQuarantineStore | undefined
let sharedMemoryTools: MemoryToolSource | undefined
let sharedExecutionTools: ExecutionToolHostSource | undefined
let emitPlanForRun: (
  runId: string,
  steps: import("./ai/plan/plan-types").PlanStep[]
) => void = () => {}
let makeSubagentProvider: () => Promise<{ provider: ChatProvider; model: string }> = async () => {
  throw new Error("subagent provider not wired")
}
/** Origin-aware recovery orchestrator dispatch (P1-1): drives an
 *  already-resumed (status flipped back to "running") checkpoint's durable
 *  loop forward, choosing the right continuation by origin. Fire-and-forget
 *  from every caller — see run-recovery-orchestrator.ts's module header for
 *  why background-agent/subagent continuation is intentionally degraded
 *  relative to interactive. */
interface ContinuingAnyRun {
  completion: Promise<void>
  ownership: Promise<void>
}
const continuingAnyRuns = new Map<string, ContinuingAnyRun>()
let continueAnyRun: (runId: string) => Promise<void> = async () => {}
// Shared across initPluginHost() (background-agent runs) and
// createAgentService() (interactive runs, and the subagent runner it wires
// up) — one durable checkpoint/budget store pair per app run, not a
// per-caller copy, since the CAS/lease machinery each store owns is only
// correct when every caller mutating a given runId goes through the same
// in-memory lock map.
const agentRunStore = new AgentRunStore(path.join(app.getPath("userData"), "ai", "runs"))
const mcpRunLeaseStore = new McpRunLeaseStore(path.join(app.getPath("userData"), "ai", "runs"))
const agentBudgetStore = new RootBudgetLedgerStore(
  path.join(app.getPath("userData"), "ai", "budget")
)
const agentEventStore = new RunEventStore(path.join(app.getPath("userData"), "ai", "events"))
// Shared across the same set of callers as agentRunStore above — one
// conversation store and one artifact store per app run. `conversations` is
// declared before `artifactStore` so the latter's `isArtifactReferenced`
// closure (Task 21 retention) can reference it directly; the closure is
// only ever invoked lazily (from ArtifactStore.collectEligible()), long
// after both are constructed, so declaration order here is cosmetic, not
// load-bearing.
const conversations = new ConversationStore(
  path.join(app.getPath("userData"), "ai", "conversations")
)
/** How long a tombstoned conversation's artifact references stay pinned
 *  before retention may reclaim their bytes (design §"Retention": "Explicit
 *  conversation deletion schedules associated run artifacts for deletion
 *  after the conversation's undo/grace window"). The design doc does not
 *  pin an exact duration for this window (distinct from the *separate*
 *  "retain an expired-artifact tombstone for at least 30 days" requirement
 *  once bytes are actually deleted) — reusing the same 30-day floor here is
 *  a deliberate, conservative choice pending product input; a reviewer
 *  should double check whether a shorter conversation-undo window is
 *  actually wanted. */
const CONVERSATION_ARTIFACT_GRACE_MS = MIN_TOMBSTONE_RETENTION_MS
const artifactStore = new ArtifactStore(artifactsRoot(app.getPath("userData")), {
  isArtifactReferenced: async (uri) => {
    const referenced = await conversations.collectReferencedArtifactUris(
      Date.now(),
      CONVERSATION_ARTIFACT_GRACE_MS
    )
    if (referenced.has(uri)) return true
    // A succeeded durable child task exposes its result through the task
    // record rather than necessarily through a conversation message. Scan
    // the small task store on every candidate's just-in-time GC check so the
    // record is a canonical retention root. Include the pre-finalization
    // pending ref as well: finalization releases the run pin after this ref
    // is durable, and a crash before terminal promotion must not create a
    // reclaimable-result window. No other child-run artifact is retained.
    const childTasks = await childTaskStore.scan()
    return childTasks.some(
      (task) => task.resultArtifact?.uri === uri || task.pendingResultArtifact?.uri === uri
    )
  },
})
// The immutable, content-addressed skill package store (Task 24, design
// §"Progressive skill runtime"). Mirrors artifactStore's construction above:
// one store per app run, rooted under userData.
const skillPackageStore = new SkillPackageStore(skillPackagesRoot(app.getPath("userData")))
// Durable skill-package lease ledger (Task 25) — one store per app run,
// mirroring skillPackageStore's construction. Threaded into every finalizer
// wiring site below (interactive/background/subagent/recovery) so a
// terminal run releases whatever leases it acquired via activate_skill.
const skillPackageLeaseStore = new SkillPackageLeaseStore(
  skillPackageLeasesFilePath(app.getPath("userData"))
)
// v1 discovery root: only the user's own skill directory. A bound-workspace
// skill root is deliberately not wired here yet — the same gap
// context-snapshot.ts's `skillCatalog` param already has (nothing populates
// it from a real run-setup call site today either); wiring a per-workspace
// root is future work, not a regression introduced by this task. Live
// discovery is bounded/cheap (skill-package-store.ts's own note: "expected
// to hold at most a few dozen small packages"), so re-running it on every
// list_skills/activate_skill call is intentional rather than caching a
// possibly-stale snapshot.
const skillsUserRoot = path.join(app.getPath("userData"), "skills")
const resolveSkillCatalog = () =>
  buildSkillCatalog([{ source: "user", rootDir: skillsUserRoot }], skillPackageStore)
const skillToolSource = new SkillToolSource({
  resolveCatalog: resolveSkillCatalog,
  packageStore: skillPackageStore,
  leaseStore: skillPackageLeaseStore,
  artifactStore,
  runStore: agentRunStore,
  now: Date.now,
})
/** Every packageLeaseId any checkpoint on disk still references — the
 *  startup-reconciliation input skillPackageLeaseStore.reconcileStartup()
 *  needs (see its call site's comment). Scans every run unconditionally
 *  (no status/finalization filter): a lease belonging to an already-
 *  terminal, fully-released run is simply absent from both this set and
 *  the ledger, so including or excluding it changes nothing. */
async function liveSkillPackageLeaseIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const entry of await agentRunStore.scan({})) {
    if (!entry.result.ok) continue
    for (const activation of entry.result.checkpoint.activatedSkills) {
      ids.add(activation.packageLeaseId)
    }
  }
  return ids
}
let accountService: MarketplaceAccountService
let marketplaceTokens: MarketplaceTokenStore | undefined
// External MCP servers feeding tools to the built-in agent (P5). Held at module
// scope so shutdown can disconnect the child processes.
let mcpClients: McpClientManager | null = null
let headlessApprovalServer: HeadlessApprovalServerHandle | null = null
// Long-term memory service, held at module scope so the memory IPC can reach the
// same instance the agent's memory tools use.
let memoryService: MemoryService | null = null
let mainWindow: BrowserWindow | null = null
// Auto-update orchestration (electron-updater). Constructed during IPC setup.
let updateService: UpdateService | null = null
// A `.syn` path from an OS "open with" before the plugin host finished
// initializing — replayed once init completes. Also guards against handling
// the same import twice concurrently.
let pendingSynapseImport: string | null = null
let synapseImportInFlight = false
// Tracks whether quit was explicitly requested through the tray menu, so
// the main-window close handler can distinguish "user clicked X" (hide)
// from "user picked Quit" (let the close go through).
let quitRequested = false
const capabilityPromptLifecycleBound = new WeakSet<WebContents>()

/** Whether the title-bar overlay should render its dimmed variant right now
 *  — set by the renderer via `window:set-title-bar-dimmed` whenever any
 *  modal dialog is open (see useAnyModalOpen in the renderer), since the
 *  native overlay buttons sit outside the web content's stacking context
 *  and never dim along with a dialog's own backdrop otherwise. */
let titleBarDimmed = false

function bindCapabilityPromptLifecycle(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const { webContents } = win
  if (capabilityPromptLifecycleBound.has(webContents)) return
  capabilityPromptLifecycleBound.add(webContents)
  attachCapabilityPromptLifecycle(webContents, () => {
    approvalRegistry.retireRecipient(webContents)
  })
}

function registerIpc(): void {
  ipcMain.handle("launcher:search", (event, query: unknown) => {
    if (!isTrustedIpcSender(event)) return []
    return launcher.search(typeof query === "string" ? query : "")
  })

  ipcMain.handle("launcher:launch", async (event, id: unknown) => {
    if (!isTrustedIpcSender(event) || typeof id !== "string") return false
    const ok = await launcher.launchById(id)
    if (ok) hideSearchWindow()
    return ok
  })

  ipcMain.handle("launcher:refresh", (event) => {
    if (!isTrustedIpcSender(event)) return []
    return launcher.refreshApps()
  })

  ipcMain.handle("launcher:frequent", (event, limit: unknown) => {
    if (!isTrustedIpcSender(event)) return []
    return launcher.getFrequentApps(typeof limit === "number" ? limit : undefined)
  })

  ipcMain.handle("launcher:remove-frequent", (event, id: unknown) => {
    if (!isTrustedIpcSender(event) || typeof id !== "string") return
    return launcher.removeFrequentApp(id)
  })

  ipcMain.handle("launcher:pause-hotkey", (event) => {
    if (!isTrustedIpcSender(event)) return
    suspendGlobalShortcut()
  })

  ipcMain.handle("launcher:resume-hotkey", (event) => {
    if (!isTrustedIpcSender(event)) return false
    return resumeGlobalShortcut(() => toggleSearchWindow(searchWindowDeps()))
  })

  ipcMain.handle("launcher:hide", (event) => {
    if (!isTrustedIpcSender(event)) return
    hideSearchWindow()
  })

  ipcMain.handle("system:open-external", async (event, url: unknown) => {
    if (!isTrustedIpcSender(event) || typeof url !== "string") return false
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return false
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return false
    await shell.openExternal(target.toString())
    return true
  })

  ipcMain.handle("system:write-clipboard", async (event, content: unknown) => {
    if (!isTrustedIpcSender(event) || !isClipboardContent(content)) return false
    writeClipboardContent(content)
    return true
  })

  ipcMain.handle("window:set-title-bar-dimmed", (event, dimmed: unknown) => {
    if (!isTrustedIpcSender(event)) return
    titleBarDimmed = dimmed === true
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) applyTitleBarScheme(win, launcher.getSettings().themeMode)
  })

  ipcMain.on("launcher:ready", (event) => {
    if (!isTrustedIpcSender(event)) return
    markSearchWindowReady(event.sender)
  })

  ipcMain.handle("floating-ball:toggle-menu", (event) => {
    if (!isTrustedIpcSender(event)) return
    toggleFloatingBallMenu()
  })

  ipcMain.handle("floating-ball:open-feature", (event, feature: unknown) => {
    if (!isTrustedIpcSender(event)) return
    if (feature === "appLauncher") {
      openFloatingBallFeature(feature)
    }
  })

  ipcMain.handle("floating-ball:hide", async (event) => {
    if (!isTrustedIpcSender(event)) return
    await disableFloatingBall()
  })

  ipcMain.handle("floating-ball:move-by", (event, delta: unknown) => {
    if (!isTrustedIpcSender(event)) return
    if (!delta || typeof delta !== "object") return
    const value = delta as Record<string, unknown>
    if (typeof value.x !== "number" || typeof value.y !== "number") return
    moveFloatingBallBy({ x: value.x, y: value.y })
  })

  ipcMain.handle("settings:get", (event) => {
    if (!isTrustedIpcSender(event)) return undefined
    return launcher.getSettings()
  })

  ipcMain.handle("settings:update", async (event, patch: unknown) => {
    if (!isTrustedIpcSender(event)) return undefined
    const previous = launcher.getSettings()
    let next = await launcher.updateSettings(coercePatch(patch))

    if (next.hotkey !== previous.hotkey && !rebindHotkey(next.hotkey)) {
      next = await launcher.updateSettings({ hotkey: previous.hotkey })
    }
    if (next.lanEnabled !== previous.lanEnabled) {
      next = await syncLanEnabled(next, previous)
    }

    refreshTrayMenu(trayActions())
    syncFloatingBallWindow(floatingBallDeps())
    broadcastSettingsChanged(next)
    if (next.themeMode !== previous.themeMode && mainWindow) {
      applyTitleBarScheme(mainWindow, next.themeMode)
    }
    if (next.allowAgentShell !== previous.allowAgentShell && mcpClients) {
      void mcpClients.notifyAllRootsChanged()
    }
    return next
  })

  ipcMain.handle("ai:list-execution-workspaces", (event, workspaceId: unknown) => {
    if (!isTrustedIpcSender(event)) return []
    return agent.listWorkspaceRoots(typeof workspaceId === "string" ? workspaceId : "default")
  })

  registerPluginIpc(ipcMain, plugins, {
    isTrustedSender: isTrustedIpcSender,
    onRegistryChanged: broadcastPluginRegistryChanged,
    pickPackageFile: pickSynapsePackageFile,
  })
  registerCapabilitiesIpc(ipcMain, capabilityService, {
    isTrustedSender: isTrustedIpcSender,
  })
  registerHostResourcesIpc(ipcMain, hostResourceIpcService, {
    isTrustedSender: isTrustedIpcSender,
  })
  registerCredentialsIpc(ipcMain, () => plugins, {
    isTrustedSender: isTrustedIpcSender,
  })
  registerTriggersIpc(ipcMain, new TriggerIpcService(() => plugins), {
    isTrustedSender: isTrustedIpcSender,
  })
  registerAiIpc(ipcMain, agent, { isTrustedSender: isTrustedIpcSender })
  registerMcpOnboardingIpc(ipcMain, {
    isTrustedSender: isTrustedIpcSender,
    isPackaged: () => app.isPackaged,
    userDataDir: () => app.getPath("userData"),
    workspaces: new WorkspaceStore(path.join(app.getPath("userData"), "ai")),
    spawnConnectionTest: (descriptor) => runMcpConnectionTest(descriptor, 10_000),
  })
  registerRunsIpc(
    ipcMain,
    runTraceDir(app.getPath("userData")),
    {
      runStore: agentRunStore,
      eventStore: agentEventStore,
      recovery: agentRunRecoveryService,
      continueRun: (runId) => continueAnyRun(runId),
      artifactStore,
      childTaskStore,
      childTaskScheduler,
    },
    { isTrustedSender: isTrustedIpcSender }
  )
  if (memoryService)
    registerMemoryIpc(ipcMain, memoryService, { isTrustedSender: isTrustedIpcSender })
  updateService = setupAutoUpdates()
  registerUpdatesIpc(ipcMain, updateService, { isTrustedSender: isTrustedIpcSender })
  registerMarketplaceIpc(ipcMain, accountService, plugins, {
    isTrustedSender: isTrustedIpcSender,
    onLoginPrompt: broadcastMarketLoginPrompt,
  })
  registerLanIpc(ipcMain, lan, {
    isTrustedSender: isTrustedIpcSender,
    onDevicesChanged: broadcastLanDevicesChanged,
    onStatusChanged: broadcastLanStatusChanged,
    onPairingsChanged: broadcastLanPairingsChanged,
    onTransfersChanged: broadcastLanTransfersChanged,
    selectSendFile: async () => {
      const result = await dialog.showOpenDialog({ properties: ["openFile"] })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    selectSaveFile: async (suggestedName) => {
      const result = await dialog.showSaveDialog({ defaultPath: suggestedName })
      return result.canceled ? null : (result.filePath ?? null)
    },
  })
}

// Open a native picker filtered to `.syn` packages. Returns the chosen
// absolute path, or null when the user cancels.
async function pickSynapsePackageFile(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Import Synapse Plugin",
    properties: ["openFile"],
    filters: [{ name: "Synapse Plugin", extensions: ["syn"] }],
  }
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow
  const result =
    parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

async function pickWorkspaceRootDirectory(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a workspace root folder",
    properties: ["openDirectory"],
  }
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow
  const result =
    parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

// First `.syn` path found in a process argv list (OS "open with" passes the
// file as a launch argument on Windows/Linux). Ignores Electron's own flags.
function findSynapseArg(argv: string[]): string | null {
  return argv.find((arg) => !arg.startsWith("-") && arg.toLowerCase().endsWith(".syn")) ?? null
}

// Install a `.syn` opened from the OS (file association / drag-to-icon).
// Confirms first, then installs through the host and surfaces the result.
async function importSynapseFromOs(filePath: string): Promise<void> {
  if (!plugins) {
    pendingSynapseImport = filePath
    return
  }
  if (synapseImportInFlight) return
  synapseImportInFlight = true
  try {
    showMainWindow()
    const confirm = await dialog.showMessageBox({
      type: "question",
      buttons: ["Install", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: "Install this Synapse plugin?",
      detail: filePath,
    })
    if (confirm.response !== 0) return
    const entry = await plugins.installPackage(filePath)
    await dialog.showMessageBox({
      type: "info",
      message: "Plugin installed",
      detail: entry.manifest?.name ?? entry.pluginId,
    })
  } catch (err) {
    dialog.showErrorBox("Plugin import failed", err instanceof Error ? err.message : String(err))
  } finally {
    synapseImportInFlight = false
  }
}

function isTrustedIpcSender(event: Pick<IpcMainInvokeEvent, "senderFrame" | "sender">): boolean {
  const url = event.senderFrame?.url || event.sender.getURL()
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }

  // The production renderer is served from the custom `app://app` scheme;
  // isSameOrigin handles that scheme's "null" origin (see window-security).
  if (isSameOrigin(target, APP_ORIGIN)) return true
  if (rendererDevUrl && isSameOrigin(target, new URL(rendererDevUrl).origin)) return true
  return false
}

function isClipboardContent(value: unknown): value is ClipboardContent {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  if (record.type === "text") return typeof record.text === "string"
  if (record.type === "image") {
    return typeof record.dataUrl === "string" && typeof record.mimeType === "string"
  }
  if (record.type === "file") {
    return Array.isArray(record.paths) && record.paths.every((item) => typeof item === "string")
  }
  return false
}

function writeClipboardContent(content: ClipboardContent): void {
  if (content.type === "text") {
    clipboard.writeText(content.text)
    return
  }
  if (content.type === "image") {
    clipboard.writeImage(nativeImage.createFromDataURL(content.dataUrl))
    return
  }
  clipboard.writeText(content.paths.join("\n"))
}

function broadcastPluginRegistryChanged(entries: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("plugins:registry-changed", entries)
    }
  }
}

function broadcastSettingsChanged(settings: ReturnType<typeof launcher.getSettings>): void {
  // Notify every renderer (main shell + long-lived launcher window) so
  // they can re-apply theme/hotkey state without reloading. Skip
  // destroyed windows defensively to avoid sending to torn-down webContents.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("settings:changed", settings)
    }
  }
}

function broadcastLanDevicesChanged(devices: LanDevice[]): void {
  broadcast("lan:devices-changed", devices)
}

function broadcastLanStatusChanged(status: LanStatus): void {
  broadcast("lan:status-changed", status)
}

function broadcastLanPairingsChanged(pairings: LanPairing[]): void {
  broadcast("lan:pairings-changed", pairings)
}

function broadcastLanTransfersChanged(transfers: LanTransfer[]): void {
  broadcast("lan:transfers-changed", transfers)
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/** Real-time push side of the subscribeRun channel (P1-2). Every window
 *  receives every run's events;
 *  the renderer filters by runId client-side. */
function broadcastRunEvent(event: unknown): void {
  broadcast("runs:event", event)
}

// Build the auto-update service around electron-updater's singleton. Manual
// flow: we surface "available"/"downloaded" to the renderer and only download
// or restart on the user's request. State changes stream on `updates:event`.
function setupAutoUpdates(): UpdateService {
  const { autoUpdater } = electronUpdater
  autoUpdater.autoInstallOnAppQuit = true
  return new UpdateService({
    updater: autoUpdater as unknown as AutoUpdaterPort,
    currentVersion: app.getVersion(),
    onChange: (state) => broadcast("updates:event", state),
  })
}

function broadcastMarketLoginPrompt(prompt: unknown): void {
  broadcast("market:login-prompt", prompt)
}

function marketplaceTokenStore(): MarketplaceTokenStore {
  marketplaceTokens ??= new MarketplaceTokenStore({
    filePath: marketplaceTokenFilePath(app.getPath("userData")),
    protector: osSecretProtector(),
  })
  return marketplaceTokens
}

function createMarketplaceAccountService(): MarketplaceAccountService {
  const api = createMarketplaceApi({
    fetch: (url, init) => net.fetch(url, init),
    getToken: () => marketplaceTokenStore().get(),
  })
  return new MarketplaceAccountService({
    api,
    store: marketplaceTokenStore(),
    openBrowser: (url) => {
      void shell.openExternal(url)
    },
  })
}

function osSecretProtector(): SecretProtector {
  return {
    encrypt: (plainText) => {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("OS-backed encryption is unavailable.")
      }
      return safeStorage.encryptString(plainText).toString("base64")
    },
    decrypt: (encryptedText) => safeStorage.decryptString(Buffer.from(encryptedText, "base64")),
  }
}

function coercePatch(value: unknown): Partial<{
  hotkey: string
  themeMode: "light" | "dark" | "system"
  accent: "neutral" | "blue" | "green" | "rose" | "violet"
  floatingBallEnabled: boolean
  floatingBallFeatures: "appLauncher"[]
  lanEnabled: boolean
  trustedSourcePolicy: "official-marketplace" | "any-url" | "local-syn"
  allowAgentShell?: boolean
}> {
  if (!value || typeof value !== "object") return {}
  const v = value as Record<string, unknown>
  const out: ReturnType<typeof coercePatch> = {}
  if (typeof v.hotkey === "string") out.hotkey = v.hotkey
  if (v.themeMode === "light" || v.themeMode === "dark" || v.themeMode === "system") {
    out.themeMode = v.themeMode
  }
  if (
    v.accent === "neutral" ||
    v.accent === "blue" ||
    v.accent === "green" ||
    v.accent === "rose" ||
    v.accent === "violet"
  ) {
    out.accent = v.accent
  }
  if (typeof v.floatingBallEnabled === "boolean") out.floatingBallEnabled = v.floatingBallEnabled
  if (Array.isArray(v.floatingBallFeatures)) {
    out.floatingBallFeatures = v.floatingBallFeatures.filter(
      (feature): feature is "appLauncher" => feature === "appLauncher"
    )
  }
  if (typeof v.lanEnabled === "boolean") out.lanEnabled = v.lanEnabled
  if (
    v.trustedSourcePolicy === "official-marketplace" ||
    v.trustedSourcePolicy === "any-url" ||
    v.trustedSourcePolicy === "local-syn"
  ) {
    out.trustedSourcePolicy = v.trustedSourcePolicy
  }
  if (typeof v.allowAgentShell === "boolean") out.allowAgentShell = v.allowAgentShell
  return out
}

async function syncLanEnabled(
  next: ReturnType<typeof launcher.getSettings>,
  previous: ReturnType<typeof launcher.getSettings>
): Promise<ReturnType<typeof launcher.getSettings>> {
  try {
    if (next.lanEnabled) {
      await lan.start()
    } else {
      await lan.stop()
    }
    return next
  } catch (err) {
    logger.child("synapse").error("failed to update LAN discovery state", { err })
    return launcher.updateSettings({ lanEnabled: previous.lanEnabled })
  }
}

function searchWindowDeps(): SearchWindowDeps {
  return { rendererDevUrl, appOrigin: APP_ORIGIN }
}

function broadcastCredentialConnectPrompt(prompt: unknown): void {
  broadcast("credentials:connect-prompt", prompt)
}

function broadcastApprovalSettled(
  id: string,
  kind: import("./approvals/approval-registry").ApprovalKind,
  outcome: import("./approvals/types").ApprovalResult,
  recipients: readonly WebContents[]
): void {
  const payload = {
    id,
    kind,
    outcome: outcome.allow
      ? ("allowed" as const)
      : "outcomeReason" in outcome
        ? outcome.outcomeReason
        : ("denied" as const),
  }
  for (const wc of recipients) {
    if (!wc.isDestroyed()) wc.send("approvals:settled", payload)
  }
}

function initPluginHost(): PluginHost {
  const userDataDir = app.getPath("userData")
  const workspaceRootStore = new WorkspaceRootStore(path.join(userDataDir, "ai"))
  const workspaces = new WorkspaceStore(path.join(userDataDir, "ai"))
  const grants = new GrantStore(grantStoreFilePath(userDataDir))
  const audit = createCapabilityAudit(
    createFileSink(path.join(userDataDir, "logs"), { fileName: "audit.log" })
  )
  const hostResourceAudit = createHostResourceAudit(
    createFileSink(path.join(userDataDir, "logs"), { fileName: "host-resource-audit.log" })
  )

  approvalRegistry = new ApprovalRegistry({
    onSettled: (id, kind, outcome, recipients) =>
      broadcastApprovalSettled(id, kind, outcome, recipients),
  })

  capabilityService = new CapabilityIpcService(
    () => plugins,
    createCapabilityPromptSender(broadcast, showMainWindow),
    approvalRegistry
  )

  hostResourceIpcService = new HostResourceIpcService(
    {
      ...createHostResourcePromptSender(broadcast, showMainWindow),
      audit: hostResourceAudit,
    },
    approvalRegistry
  )

  let hostRef: PluginHost | undefined
  const host = new PluginHost({
    fetch: (url, init) => net.fetch(url, init),
    marketplaceGetToken: () => marketplaceTokenStore().get(),
    userDataDir,
    resourcesDir: pluginResourcesDir(),
    // __dirname here is this actual entry chunk's own folder (out/main/) —
    // plugin-sandbox.ts can't safely compute this itself, since shared code
    // can end up bundled into a different chunk with a different __dirname.
    sandboxEntryScriptPath: path.join(__dirname, "plugin-runtime-entry.js"),
    adapters: createElectronPluginAdapters(userDataDir, {
      onNotificationAction: (notificationId, actionId) => {
        void hostRef?.bridge
          .handleNotificationAction(notificationId, actionId)
          .catch((err) => logger.child("plugin-host").warn("notification action failed", { err }))
      },
    }),
    hotkeyAdapter: createHotkeyAdapter({
      reservedAccelerators: () => [launcher.getSettings().hotkey],
    }),
    runtime: () => {
      const settings = launcher.getSettings()
      return {
        locale: app.getLocale(),
        theme: {
          mode: settings.themeMode === "dark" ? "dark" : "light",
          accent: settings.accent,
        },
      }
    },
    capabilityGovernance: {
      userDataDir,
      grants,
      audit,
      prompt: capabilityService.grantPrompt,
      approve: capabilityService.capabilityApprover,
    },
    backgroundAgentProvider: () => agent.createBackgroundAgentProvider(),
    estimatorQuarantine: () => estimatorQuarantine,
    memoryTools: () => sharedMemoryTools,
    executionTools: () => sharedExecutionTools,
    runStore: agentRunStore,
    budgetStore: agentBudgetStore,
    upsertTrace: (input) => upsertRunTrace(runTraceDir(userDataDir), input),
    artifactStore,
    skillPackageLeases: skillPackageLeaseStore,
    workspaceRoots: workspaceRootStore,
    workspaces,
    reservedAccelerators: () => [launcher.getSettings().hotkey],
    credentialBroker: new CredentialBroker({
      userDataDir,
      safeStorage: {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plainText) => safeStorage.encryptString(plainText),
        decryptString: (encrypted) => safeStorage.decryptString(encrypted),
      },
      secretPrompt: createElectronSecretPrompt(
        () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0],
        BrowserWindow
      ),
      audit,
      grants,
      onOAuthConnectPrompt: (prompt) => broadcastCredentialConnectPrompt(prompt),
      openBrowser: async (url) => {
        await shell.openExternal(url)
      },
    }),
  })
  hostRef = host
  return host
}

function pluginResourcesDir(): string {
  return path.join(app.getAppPath(), "resources")
}

async function createAgentService(): Promise<AgentService> {
  const userDataDir = app.getPath("userData")
  const credentials = new AiCredentialStore({
    filePath: aiCredentialFilePath(userDataDir),
    protector: osSecretProtector(),
  })
  const workspaceRootStore = new WorkspaceRootStore(path.join(userDataDir, "ai"))
  const existingDefaultRoots = await workspaceRootStore.listForWorkspace("default")
  const legacySettingsRaw = (await readJsonFile(settingsFilePath(userDataDir))) as {
    agentShellRoots?: unknown
  } | null
  const legacyRoots = Array.isArray(legacySettingsRaw?.agentShellRoots)
    ? legacySettingsRaw.agentShellRoots.filter((root): root is string => typeof root === "string")
    : []
  const allowAgentShell = launcher.getSettings().allowAgentShell
  await migrateAgentShellRoots(workspaceRootStore, legacyRoots, allowAgentShell)
  const migratedLegacyRoots =
    allowAgentShell && legacyRoots.length > 0 && existingDefaultRoots.length === 0

  const mcpConfigStore = new McpServerConfigStore(
    aiMcpServersFilePath(userDataDir),
    osSecretProtector()
  )
  if (migratedLegacyRoots) {
    try {
      const configs = await mcpConfigStore.list()
      for (const config of configs) {
        if (!config.exposedExecutionRootIds || config.exposedExecutionRootIds.length === 0) continue
        await mcpConfigStore.save({ ...config, exposedExecutionRootIds: undefined })
      }
    } catch (err) {
      logger.child("synapse").warn("failed to clear MCP exposed roots after migration", { err })
    }
  }

  const manager = new McpClientManager(createMcpClient, () => workspaceRootStore.listAll())
  mcpClients = manager

  // Built-in long-term memory: embeds with the user's OpenAI key (falls back to
  // lexical recall when none is set).
  const memory = new MemoryService(
    new MemoryStore(aiMemoryFilePath(userDataDir)),
    new OpenAiEmbeddingProvider({ getApiKey: () => credentials.get("openai") })
  )
  memoryService = memory

  const pluginNote = (pluginId: string): string | undefined => {
    const entry = plugins.get(pluginId)
    return entry?.manifest
      ? profileToAgentText(derivePluginProfile({ manifest: entry.manifest }))
      : undefined
  }

  const introspectionSource = new PluginIntrospectionToolSource((pluginId) =>
    capabilityService.getCapabilityProfile(pluginId).then(
      (profile) => profile,
      () => undefined
    )
  )

  const executionLog = new ExecutionLogStore(executionLogFilePath(userDataDir))
  // artifactStore is the module-level singleton declared near agentRunStore
  // (shared with initPluginHost()'s background-agent path) — not
  // re-constructed here.
  const executionSource = new ExecutionToolHostSource({
    workspaceRoots: workspaceRootStore,
    log: executionLog,
    isAllowed: () => launcher.getSettings().allowAgentShell,
    artifactStore,
  })
  await executionSource.refresh()
  sharedExecutionTools = executionSource
  const executionApprovalResolver = new ExecutionApprovalResolver({ log: executionLog })

  // Host-owned, read-only read_artifact (Task 19). Resolves a model-supplied
  // artifact:// uri directly via artifactStore.resolve(runId, artifactId,
  // caller) — a by-id lookup (Task 19 follow-up) that needs no caller
  // -supplied ref and no checkpoint involvement at all, so it works
  // uniformly for every artifact ever captured (including run_command's
  // Task-18 stdout/stderr captures, which never touch
  // ChatContentBlock.tool_result.artifact) and stays correct even once a
  // future context-compression pass evicts old checkpoint messages.
  const artifactSource = new ArtifactToolSource({ store: artifactStore })

  const runsDir = runTraceDir(userDataDir)
  const planRegistry = new RunPlanRegistry()
  const planSource = new PlanToolSource({
    registry: planRegistry,
    emitPlan: (runId, steps) => emitPlanForRun(runId, steps),
  })

  let agentTools!: AiToolRegistry
  const subagentSource = new SpawnSubagentToolSource({
    parentTools: () => agentTools,
    runSubagent: async (inp) => {
      const { provider, model } = await makeSubagentProvider()
      return new SubagentRunner({
        provider,
        model,
        runStore: agentRunStore,
        budgetStore: agentBudgetStore,
        upsertTrace: (input) => upsertRunTrace(runsDir, input),
        estimatorQuarantine,
        artifactStore,
        skillPackageLeases: skillPackageLeaseStore,
      }).run(inp)
    },
  })
  const childTaskSource = new ChildTaskToolSource({
    scheduler: () => childTaskScheduler,
    runStore: agentRunStore,
    parentTools: () => agentTools,
  })

  // The model sees one flat tool list: local plugin tools, external MCP tools
  // (`mcp:<id>/<tool>`), built-in memory tools (`memory:…`), and optionally
  // sandboxed local execution (`execution:…`). Invocations route by ownership.
  const aiSettings = new AiSettingsStore(aiSettingsFilePath(userDataDir), DEFAULT_PROVIDER_ID)
  estimatorQuarantine = new EstimatorQuarantineStore(estimatorQuarantineFilePath(userDataDir))
  // Live circuit-breaker tuning (P3). Held in a mutable holder the host reads
  // afresh per new breaker; setToolResilience updates it and resets breakers so
  // the change takes effect immediately. Seeded from persisted settings below.
  let toolResilience: ToolResilienceSettings = { ...DEFAULT_TOOL_RESILIENCE }

  // Wrap the flat tool surface in a per-tool circuit breaker + timeout so one
  // hung/dead source (crashed MCP server, wedged plugin) can't stall or keep
  // punching the agent loop. Execution and subagent tools are legitimately
  // long-running, so they opt out of the timeout; everything else uses the
  // configured timeout. Held in a variable so its health snapshots can be
  // surfaced to the renderer.
  const memoryToolSource = new MemoryToolSource(memory)
  sharedMemoryTools = memoryToolSource
  const resilientToolHost = new ResilientToolHost(
    new CompositeToolHost([
      introspectionSource,
      executionSource,
      artifactSource,
      planSource,
      subagentSource,
      childTaskSource,
      skillToolSource,
      asFallbackSource(
        plugins,
        (fqName) =>
          fqName.startsWith(MCP_FQ_PREFIX) ||
          fqName.startsWith(MEMORY_FQ_PREFIX) ||
          fqName.startsWith(PLUGIN_INTROSPECT_PREFIX) ||
          fqName.startsWith(EXECUTION_FQ_PREFIX) ||
          fqName.startsWith(ARTIFACT_FQ_PREFIX) ||
          fqName.startsWith(PLAN_FQ_PREFIX) ||
          fqName.startsWith(SUBAGENT_FQ_PREFIX) ||
          fqName.startsWith(SKILL_FQ_PREFIX)
      ),
      manager,
      memoryToolSource,
    ]),
    {
      breaker: () => ({
        failureThreshold: toolResilience.failureThreshold,
        recoveryMs: toolResilience.recoveryMs,
      }),
      timeoutMs: (fqName) =>
        fqName.startsWith(EXECUTION_FQ_PREFIX) || fqName.startsWith(SUBAGENT_FQ_PREFIX)
          ? undefined
          : toolResilience.timeoutMs,
    }
  )
  agentTools = new AiToolRegistry(resilientToolHost, pluginNote)
  // Seed live tuning from persisted settings; reset breakers so any created
  // before the async load reflect the persisted config.
  void aiSettings.get().then((loaded) => {
    if (loaded.toolResilience) {
      toolResilience = loaded.toolResilience
      resilientToolHost.resetBreakers()
    }
  })

  // conversations/artifactStore are the module-level singletons declared
  // near agentRunStore — not re-constructed here.

  agentRunRecoveryService = new AgentRunRecoveryService({
    runStore: agentRunStore,
    now: Date.now,
    finalize: async (runId, input) => {
      const finalized = await finalizeRun(
        {
          runStore: agentRunStore,
          conversation: conversations,
          upsertTrace: (upsertInput) => upsertRunTrace(runsDir, upsertInput),
          releaseResources: (plan, context) =>
            releaseArtifactRunResources(artifactStore, plan, context),
          releaseSkillPackageLeases: (leaseIds) =>
            releaseSkillPackageLeases(skillPackageLeaseStore, leaseIds),
          now: Date.now,
        },
        runId,
        input
      )
      // abandon() (and resume()'s mark_failed path) reach a real terminal
      // checkpoint through this finalize() call WITHOUT ever going through
      // continueBackgroundOrSubagentRun's onTerminal hook — the only other
      // place a ChildTaskRecord gets reconciled. Without this, a child task
      // abandoned via the existing human-review recovery panel (e.g. a
      // crash classified requires_review: unknown-tool-outcome) would stay
      // "running" forever in ChildTaskStore, permanently leaking its
      // concurrency slot on every future recoverAtStartup() scan. Best-
      // effort: a bookkeeping failure here must never make an otherwise-
      // successful abandon/resume appear to fail. Harmless no-op for every
      // checkpoint that isn't a child task's run.
      await childTaskScheduler.handleRunTerminal(finalized).catch((err) => {
        logger.child("runs").warn("failed to reconcile child task after recovery finalize", {
          runId,
          err,
        })
      })
      return finalized
    },
    buildAbandonTrace: (checkpoint) => buildTraceFromCheckpoint(checkpoint, "aborted"),
    buildFailureTrace: (checkpoint) => buildTraceFromCheckpoint(checkpoint, "error"),
    buildAbandonResourcePlan: (checkpoint) => ({
      budgetOperationIds: [],
      skillPackageLeaseIds: checkpoint.activatedSkills.map((a) => a.packageLeaseId),
      // abandon() drives the exact same finalization protocol as a normal
      // completion, with desired status "cancelled" — always a genuine
      // terminal outcome for this run.
      releaseArtifactRunPin: true,
      adoptionLeaseIds: [],
    }),
    reconcileCorruptRun: (runId) => agentBudgetStore.reconcileAbandonedRun(runId),
    buildClassifierInput: async (checkpoint) => {
      const conversationExists = checkpoint.identity.conversationId
        ? (await conversations.get(checkpoint.identity.conversationId)) !== undefined
        : undefined
      const currentWorkspaceRootSetHash = checkpoint.identity.workspaceId
        ? rootSetHashFor(await workspaceRootStore.listForWorkspace(checkpoint.identity.workspaceId))
        : undefined
      const revokedAuthority = () =>
        freezeAuthoritySnapshot({
          // Deliberately different from every frozen source principal: this
          // makes a vanished source block before any continuation can run.
          principal: { kind: "revoked-source", actor: "background" },
          capabilities: [],
          tools: [],
        })
      const currentAuthorityFor = async (
        candidate: typeof checkpoint,
        seen = new Set<string>()
      ): Promise<typeof checkpoint.config.authority> => {
        if (seen.has(candidate.identity.runId)) return revokedAuthority()
        const ancestry = new Set(seen).add(candidate.identity.runId)

        if (candidate.identity.origin === "interactive") {
          return freezeAuthoritySnapshot({
            principal: { kind: "interactive", actor: "user" },
            capabilities: [],
            tools: agentTools.listWithDescriptors().map(({ schema, descriptor }) => ({
              descriptor,
              safeName: schema.name,
              modelSchema: schema,
            })),
          })
        }

        if (candidate.identity.origin === "background-agent") {
          return (await plugins.currentBackgroundRecoveryAuthority(candidate)) ?? revokedAuthority()
        }

        // An external MCP request has no local agent continuation to replay.
        // Its frozen principal is the authoritative provenance until startup
        // safely finalizes an interrupted request as aborted below.
        if (candidate.identity.origin === "mcp") return candidate.config.authority

        const parentRunId = candidate.identity.parentRunId
        if (!parentRunId) return revokedAuthority()
        const parentResult = await agentRunStore.load(parentRunId)
        if (!parentResult.ok) return revokedAuthority()
        const parentCurrentAuthority = await currentAuthorityFor(parentResult.checkpoint, ancestry)
        if (parentCurrentAuthority.principal.kind === "revoked-source") return revokedAuthority()
        // The subagent's own principal is stable (it is an execution role,
        // not a grant source). Its tools and capabilities instead derive
        // recursively from the parent's current authority, then intersect
        // with the child's immutable creation-time ceiling.
        return withFrozenAuthorityCapabilities(
          rebuildRecoveryAuthority(
            candidate,
            agentTools,
            parentResult.checkpoint,
            [],
            candidate.config.authority.principal,
            parentCurrentAuthority
          ),
          parentCurrentAuthority.capabilities
        )
      }
      const currentAuthority = await currentAuthorityFor(checkpoint)
      return {
        currentAuthority,
        conversationExists,
        currentWorkspaceRootSetHash,
        now: Date.now(),
      }
    },
  })

  const agentService = new AgentService({
    credentials,
    tools: agentTools,
    runStore: agentRunStore,
    budgetStore: agentBudgetStore,
    upsertTrace: (input) => upsertRunTrace(runsDir, input),
    eventStore: agentEventStore,
    onRunEvent: broadcastRunEvent,
    getToolHealth: () => resilientToolHost.snapshots(),
    onToolResilienceChange: (cfg) => {
      toolResilience = cfg
      resilientToolHost.resetBreakers()
    },
    getExecutionWorkspaces: (workspaceId) => workspaceRootStore.listForWorkspace(workspaceId),
    workspaceRoots: workspaceRootStore,
    onWorkspaceRootsChanged: () => {
      void executionSource.refresh()
    },
    pickWorkspaceRootDirectory: () => pickWorkspaceRootDirectory(),
    isAgentShellAllowed: () => launcher.getSettings().allowAgentShell,
    approvalResolver: (ctx) =>
      executionApprovalResolver.decide({
        conversationId: ctx.conversationId,
        fqName: ctx.fqName,
        input: ctx.input,
      }),
    conversations,
    artifactStore,
    skillPackageLeases: skillPackageLeaseStore,
    workspaces: new WorkspaceStore(path.join(userDataDir, "ai")),
    providers: defaultProviderCatalog(),
    settings: aiSettings,
    estimatorQuarantine,
    approvals: new ApprovalStore(aiApprovalsFilePath(userDataDir)),
    getLatestPlan: (conversationId) => getLatestPlan(runsDir, conversationId),
    planRegistry,
    mcp: {
      // Encrypt env/header secrets at rest with the OS keychain.
      configs: mcpConfigStore,
      manager,
    },
  })

  emitPlanForRun = (runId, steps) => agentService.emitPlanForRun(runId, steps)
  makeSubagentProvider = () => agentService.createBackgroundAgentProvider()

  // Resolves a checkpoint's own frozen providerId to a live provider — never
  // today's live-settings provider, matching continueBackgroundOrSubagentRun's
  // own resume contract (a resume replays what the run already committed to).
  // Shared between continueAnyRun's generic background/subagent branch below
  // and the async child-task scheduler (Task 26), which drives every child
  // run through that exact same generic path.
  const buildProviderForRun = async (providerId: string): Promise<ChatProvider> => {
    const apiKey = await credentials.get(providerId)
    if (!apiKey) throw new AgentMissingKeyError()
    const descriptor = defaultProviderCatalog().find((p) => p.id === providerId)
    if (!descriptor) throw new Error(`Unknown provider: ${providerId}`)
    return descriptor.create(apiKey)
  }

  // Durable async child-task kernel (Task 26, design §"Durable async child
  // tasks"). One store/scheduler per app run, mirroring skillPackageStore's
  // construction above.
  //
  // dispatchRun is deliberately `continueAnyRun` itself (assigned below,
  // referenced here only through this closure so construction order doesn't
  // matter) — NOT a direct continueBackgroundOrSubagentRun call. This closes
  // a real startup double-dispatch race a spec review caught: index.ts's
  // generic autoResumeRecoverableRuns scan drives ANY non-terminal
  // automatic-recovery subagent checkpoint unconditionally, including a
  // `queued` child task's — nothing at the checkpoint level distinguishes
  // "never dispatched" from "genuinely in flight". Without a shared dedup,
  // that scan and childTaskScheduler.recoverAtStartup() could both start an
  // independent drive of the same runId, and the checkpoint store's per-runId
  // CAS mutex only bounds the damage (one loses with a StaleRevisionError on
  // its first write) — it doesn't stop the loser's tool calls already
  // in-flight before that write. Routing every dispatch through
  // continueAnyRun's existing continuingAnyRuns map means whichever caller
  // reaches it first is the only one that ever drives it.
  childTaskStore = new ChildTaskStore(path.join(userDataDir, "ai", "child-tasks"))
  childTaskScheduler = new ChildTaskScheduler({
    store: childTaskStore,
    runStore: agentRunStore,
    budgetStore: agentBudgetStore,
    dispatchRun: (runId) => continueAnyRun(runId),
    artifactStore,
    onDispatchError: (taskId, err) =>
      logger.child("runs").warn("child task dispatch failed", { taskId, err }),
    onTaskUpdated: async (task) => {
      const emitter = await createRunEventEmitter(
        agentEventStore,
        {
          runId: task.originRunId,
          rootRunId: task.rootRunId,
          conversationId: task.conversationId,
        },
        Date.now,
        undefined,
        broadcastRunEvent
      )
      await emitter.emit({ type: "child_task_updated", child: toAgentChildTaskSummary(task) })
    },
  })

  continueAnyRun = (runId: string): Promise<void> => {
    const existing = continuingAnyRuns.get(runId)
    if (existing) return existing.ownership
    let establishOwnership!: () => void
    let rejectOwnership!: (reason: unknown) => void
    const ownership = new Promise<void>((resolve, reject) => {
      establishOwnership = resolve
      rejectOwnership = reject
    })
    const entry: ContinuingAnyRun = {
      ownership,
      completion: Promise.resolve(),
    }
    const completion = (async () => {
      let result: Awaited<ReturnType<typeof agentRunStore.load>>
      try {
        result = await agentRunStore.load(runId)
      } catch (err) {
        logger.child("runs").warn("continueAnyRun: failed to load checkpoint", { runId, err })
        rejectOwnership(err)
        return
      }
      if (!result.ok) {
        establishOwnership()
        return
      }
      const checkpoint = result.checkpoint
      try {
        if (checkpoint.identity.origin === "interactive") {
          // AgentService owns the conversation lease barrier. Joining it
          // here keeps this process-wide map authoritative for every origin.
          await agentService.continueRunThroughOwnership(runId)
          establishOwnership()
          await agentService.continueRun(runId)
        } else if (checkpoint.identity.origin === "mcp") {
          // The GUI is not the owner of an external stdio MCP request. A
          // non-terminal checkpoint may represent a host call still running
          // in another process, so leave it untouched; only stdio startup can
          // reclaim an owner it has proved stale and dead.
          establishOwnership()
        } else {
          // Inserting this entry before any await is the execution ownership
          // barrier for background/subagent runs, which have no conversation
          // lease. Never allow a second Resume to start another driver.
          establishOwnership()
          // A task already durably cancelled (ChildTaskScheduler.cancel())
          // but never dispatched must not take a real model/tool step just
          // because this shared dedup path happens to be the one that ends
          // up driving it — pre-abort so it finalizes to "cancelled" on its
          // very first loop check instead. Harmless (and cheap: one local
          // scan) for every checkpoint that isn't a child task's run.
          const cancelledChildTask = await childTaskStore.findByRunId(runId)
          const controller = new AbortController()
          if (cancelledChildTask?.status === "cancelled") controller.abort()
          // Registered before the drive starts (not inside the scheduler,
          // which has no idea this generic path exists) so a child task
          // resumed here — rather than via the scheduler's own dispatch —
          // is still reachable by ChildTaskScheduler.cancel(); onTerminal is
          // a harmless no-op for every checkpoint that isn't a child task's
          // run (ChildTaskStore.findByRunId returns undefined for those).
          childTaskScheduler.registerLiveController(runId, controller)
          try {
            await continueBackgroundOrSubagentRun(
              {
                runStore: agentRunStore,
                budgetStore: agentBudgetStore,
                eventStore: agentEventStore,
                upsertTrace: (input) => upsertRunTrace(runsDir, input),
                tools: resilientToolHost,
                onEvent: broadcastRunEvent,
                estimatorQuarantine,
                artifactStore,
                beforeFinalize: (checkpoint, input) =>
                  childTaskScheduler.prepareResultBeforeFinalization(checkpoint, input),
                skillPackageLeases: skillPackageLeaseStore,
                buildProvider: buildProviderForRun,
                onTerminal: (cp) => childTaskScheduler.handleRunTerminal(cp),
              },
              checkpoint,
              controller.signal
            )
          } finally {
            childTaskScheduler.unregisterLiveController(runId)
          }
        }
      } catch (err) {
        rejectOwnership(err)
        logger.child("runs").warn("continueAnyRun: run failed to resume", {
          runId,
          origin: checkpoint.identity.origin,
          err,
        })
      }
    })()
    entry.completion = completion.finally(() => {
      if (continuingAnyRuns.get(runId) === entry) continuingAnyRuns.delete(runId)
    })
    continuingAnyRuns.set(runId, entry)
    // Completion is intentionally detached; callers only await durable
    // execution ownership so app startup never waits for provider latency.
    void entry.completion.catch(() => {})
    return ownership
  }

  // Rehydrate/admit child tasks first. This synchronously reconstructs every
  // running slot and changes only scheduler-admitted queued tasks to running
  // before the generic scan is allowed to inspect them. The generic scan
  // below explicitly excludes still-queued child tasks, so a checkpoint that
  // has never owned a scheduler slot cannot bypass either child-task cap.
  const childTaskStartupRecovery = childTaskScheduler.recoverAtStartup()
  void childTaskStartupRecovery.catch((err) =>
    logger.child("runs").warn("failed to recover child tasks at startup", { err })
  )

  // Kick off the startup recovery scan now, without blocking app readiness on
  // it — chat() internally awaits this same promise before starting any new
  // turn, so a stale/terminalizing conversation lease from a prior process
  // can never be raced by a fresh interactive turn arriving right after
  // launch. The scan itself now also drives real recovery, not just
  // classification: every run classified "automatic" gets resumed AND
  // continued (P1-1) — reconcileRunsAtStartup's own listRecoverable() plumbing
  // is repurposed to run that whole sequence, so chat() still only ever waits
  // for this (fast) dispatch phase, never for the continuations it kicks off.
  void agentService.reconcileRunsAtStartup({
    listRecoverable: async () => {
      // The GUI never owns an external stdio MCP request. It may reclaim only
      // a phase-complete checkpoint left between finalization and purge; a
      // non-terminal MCP checkpoint stays for the owning stdio process to
      // recover after it has fenced a stale, dead owner lease.
      await purgeFinalizedMcpRuns({ runStore: agentRunStore, leaseStore: mcpRunLeaseStore })
      await childTaskStartupRecovery
      await autoResumeRecoverableRuns({
        recovery: {
          // A queued child checkpoint is deliberately durable before it is
          // dispatched, but only ChildTaskScheduler may admit it. Letting
          // this generic automatic-recovery scan resume it would make it a
          // second, uncapped admission path. Running child tasks remain here
          // and continue through the shared per-run ownership map.
          listRecoverable: async () => {
            // The GUI never owns an external stdio MCP lifecycle. Exclude it
            // before AgentRunRecoveryService performs its classification CAS,
            // so even terminalizing-but-incomplete MCP work is neither
            // reclassified nor fed to autoResumeRecoverableRuns.abandon().
            const summaries = await agentRunRecoveryService.listRecoverable({
              excludeOrigins: ["mcp"],
            })
            const eligible = []
            for (const summary of summaries) {
              if (summary.origin !== "subagent") {
                eligible.push(summary)
                continue
              }
              const child = await childTaskStore.findByRunId(summary.runId)
              if (child?.status !== "queued") eligible.push(summary)
            }
            return eligible
          },
          resume: (runId) => agentRunRecoveryService.resume(runId),
          abandon: (runId) => agentRunRecoveryService.abandon(runId),
        },
        runStore: agentRunStore,
        continueRun: async (checkpoint) => {
          await continueAnyRun(checkpoint.identity.runId)
        },
        onError: (runId, err) =>
          logger.child("runs").warn("failed to auto-resume run", { runId, err }),
      })
      return []
    },
  })

  return agentService
}

function floatingBallDeps() {
  return {
    rendererDevUrl,
    appOrigin: APP_ORIGIN,
    getSettings: () => launcher.getSettings(),
    getLocale: () => app.getLocale(),
    onOpenFeature: (feature: "appLauncher") => {
      if (feature === "appLauncher") showSearchWindow(searchWindowDeps())
    },
    onDisable: () => {
      void disableFloatingBall()
    },
  }
}

async function disableFloatingBall(): Promise<void> {
  const next = await launcher.updateSettings({ floatingBallEnabled: false })
  hideFloatingBallWindow()
  refreshTrayMenu(trayActions())
  broadcastSettingsChanged(next)
}

/** Re-themes an existing window's native title bar overlay — called on
 *  settings:update (explicit theme change), on OS theme change while in
 *  "system" mode, and on any dimmed-state change, so the min/maximize/close
 *  buttons never get stuck on a stale scheme or dimming state. */
function applyTitleBarScheme(win: BrowserWindow, themeMode: "light" | "dark" | "system"): void {
  if (win.isDestroyed()) return
  const base = titleBarOverlayForScheme(resolveTitleBarScheme(themeMode))
  const overlay = titleBarDimmed ? dimTitleBarOverlay(base) : base
  win.setTitleBarOverlay(overlay)
  win.setBackgroundColor(overlay.color)
}

function createMainWindow(): BrowserWindow {
  const initialOverlay = titleBarOverlayForScheme(
    resolveTitleBarScheme(launcher.getSettings().themeMode)
  )
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    title: lanSimulation ? `Synapse - ${lanSimulation.deviceName}` : "Synapse",
    show: false, // launcher app stays in tray; window is shown on demand
    backgroundColor: initialOverlay.color,
    // Hide the native (light, OS-themed) title bar so the app's own themed
    // header can extend to the top of the window, matching the rest of the
    // UI instead of a jarring OS-default caption bar. The native min/
    // maximize/close buttons stay (as an "overlay") so window controls still
    // feel native; only their color is themed, and it's kept in sync with
    // the app's light/dark setting via applyTitleBarScheme. The renderer's
    // header must mark itself `-webkit-app-region: drag` (with `no-drag` on
    // any interactive children) to keep the window draggable without a real
    // title bar — see app-shell.tsx.
    titleBarStyle: "hidden",
    titleBarOverlay: initialOverlay,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  // Closing the main window should hide it, not quit the app — quitting is
  // reserved for the tray menu.
  win.on("close", (event) => {
    if (!quitRequested) {
      event.preventDefault()
      win.hide()
    }
  })

  if (rendererDevUrl) {
    void win.loadURL(rendererDevUrl)
    attachWindowSecurity(win, new URL(rendererDevUrl).origin)
    win.webContents.openDevTools({ mode: "detach" })
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`)
    attachWindowSecurity(win, APP_ORIGIN)
  }

  bindCapabilityPromptLifecycle(win)

  return win
}

function showMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return mainWindow
}

function rebindHotkey(accelerator: string): boolean {
  const ok = bindGlobalShortcut(accelerator, () => toggleSearchWindow(searchWindowDeps()))
  if (!ok) {
    logger.child("synapse").warn("failed to register global shortcut", { accelerator })
  }
  return ok
}

/**
 * Startup-only variant of {@link rebindHotkey}. Registration can fail
 * transiently right after an electron-vite dev hot-restart — the previous
 * process may still be tearing down (reaping plugin utilityProcess
 * children) when the new process starts, so the OS briefly still reports
 * the accelerator as owned by it. Retrying a few times clears this up
 * without the user having to manually re-capture the hotkey. Runs
 * fire-and-forget so a slow retry sequence never delays tray/window setup.
 */
async function rebindHotkeyAtStartup(accelerator: string): Promise<void> {
  const ok = await bindGlobalShortcutWithRetry(accelerator, () =>
    toggleSearchWindow(searchWindowDeps())
  )
  if (!ok) {
    logger.child("synapse").warn("failed to register global shortcut", { accelerator })
  }
}

function trayActions() {
  return {
    onOpenSearch: () => showSearchWindow(searchWindowDeps()),
    onShowMainWindow: showMainWindow,
    onRefreshApps: () => {
      void launcher.refreshApps()
    },
    onQuit: () => {
      quitRequested = true
      setSearchWindowQuitting(true)
      app.quit()
    },
    getHotkey: () => launcher.getSettings().hotkey,
    shouldIgnoreOpenSearch: consumeSearchWindowTrayOpenSuppression,
    getLocale: () => app.getLocale(),
  }
}

async function initLan(enabled: boolean): Promise<void> {
  try {
    await lan.init(enabled)
  } catch (err) {
    if (!lanSimulation || !(err instanceof LanCredentialLoadError)) throw err
    logger.child("synapse").warn("resetting unreadable LAN simulation credentials", { err })
    await resetDevLanSimulationCredentials(lanSimulation)
    await lan.init(enabled)
  }
}

// `Synapse --mcp-stdio` is the friendly way to launch the MCP server, but a
// spawned Electron GUI process on Windows never receives piped stdin (which the
// MCP transport reads), so an in-process GUI server silently hangs. Instead,
// re-exec this binary as plain Node (ELECTRON_RUN_AS_NODE) pointed at the
// headless entry, inheriting stdio so the Node child speaks MCP straight to the
// caller. The heavy Electron/GUI init never runs in this mode.
function reExecMcpStdioAsNode(): void {
  const entry = path.join(__dirname, "mcp-stdio.js")
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      SYNAPSE_MCP_PARENT_PID: String(process.pid),
    },
  })
  child.on("exit", (code) => app.exit(code ?? 0))
  child.on("error", (err) => {
    logger.child("synapse:mcp").error("failed to launch the stdio entry", { err })
    app.exit(1)
  })
}

// Single-instance lock: focusing the existing packaged app is friendlier than
// silently launching a duplicate process that fights for the same resources.
// In dev, skip the lock so stale Electron processes do not steal restarts and
// leave the visible window stuck on only the BrowserWindow background.
const shouldUseSingleInstanceLock = app.isPackaged
if (isMcpStdioMode) {
  reExecMcpStdioAsNode()
} else {
  const gotLock = !shouldUseSingleInstanceLock || app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    // macOS delivers "open with" through this event, possibly before the app is
    // ready — importSynapseFromOs queues until the plugin host exists.
    app.on("open-file", (event, filePath) => {
      event.preventDefault()
      if (filePath.toLowerCase().endsWith(".syn")) void importSynapseFromOs(filePath)
    })

    if (shouldUseSingleInstanceLock) {
      app.on("second-instance", (_event, argv) => {
        // A second launch carrying a .syn file (Windows/Linux "open with")
        // routes to import; otherwise re-open the launcher rather than steal
        // focus from whatever the user is doing — matches PowerToys behaviour.
        const synapseArg = findSynapseArg(argv)
        if (synapseArg) {
          void importSynapseFromOs(synapseArg)
          return
        }
        showSearchWindow(searchWindowDeps())
      })
    }

    void app.whenReady().then(async () => {
      // Match package.json build.appId so Windows recognises the app
      // identity and the post-install Start Menu shortcut's icon flows
      // through to toast notifications. Without this the OS treats us
      // as "electron.app.Electron" and shows Electron's default logo.
      if (process.platform === "win32") {
        app.setAppUserModelId("com.synapse.desktop")
        void ensureDevAppUserModelShortcut()
      }

      applyCsp()
      registerStaticProtocol()
      registerPluginAssetProtocol()
      // Reconcile only artifacts interrupted by a prior process before any
      // driver or GC can start. This settles manifest-backed captures exactly
      // and removes unmanifested debris; doing it from a normal GC sweep
      // would race live capture reservations.
      await artifactStore.reconcileStartup()
      // Skill packages are ingested via an atomic stage-then-rename (Task
      // 24); the only crash-recoverable debris is a `.tmp-*` staging
      // directory a prior process never finished renaming away. Safe to run
      // unconditionally at startup, before any driver/GC starts, same as
      // artifactStore above.
      await skillPackageStore.reconcileStartup()
      // Releases any skill-package lease left behind by a crash between
      // activate_skill's lease acquisition and its checkpoint commit (Task
      // 25, design §"Progressive disclosure": "an acquired lease without a
      // matching activation is released after reconciliation"). The live
      // set is every packageLeaseId still referenced by any checkpoint on
      // disk — a lease belonging to a fully-finalized run is already absent
      // from the ledger (run-finalizer.ts's resources_released phase
      // removed it), so including it here is a harmless no-op, not a
      // correctness requirement to exclude it.
      await skillPackageLeaseStore.reconcileStartup(await liveSkillPackageLeaseIds())
      plugins = initPluginHost()
      app.on("browser-window-created", (_, win) => {
        bindCapabilityPromptLifecycle(win)
      })
      // Live-follow the OS light/dark switch while the user is on "system" —
      // mirrors use-theme.tsx's matchMedia listener on the renderer side, but
      // this one specifically keeps the native title bar overlay in sync.
      nativeTheme.on("updated", () => {
        if (launcher.getSettings().themeMode === "system" && mainWindow) {
          applyTitleBarScheme(mainWindow, "system")
        }
      })
      for (const win of BrowserWindow.getAllWindows()) {
        bindCapabilityPromptLifecycle(win)
      }
      lan = new LanService({
        userDataDir: app.getPath("userData"),
        adapter: new BonjourLanDiscoveryAdapter(),
        deviceName: lanSimulation?.deviceName,
        protector: {
          encrypt: (plainText) => {
            if (!safeStorage.isEncryptionAvailable()) {
              throw new Error("OS-backed encryption is unavailable for LAN credentials.")
            }
            return safeStorage.encryptString(plainText).toString("base64")
          },
          decrypt: (encryptedText) =>
            safeStorage.decryptString(Buffer.from(encryptedText, "base64")),
        },
      })
      agent = await createAgentService()
      accountService = createMarketplaceAccountService()
      registerIpc()

      headlessApprovalServer = await startHeadlessApprovalServer({
        approveCapability: capabilityService.capabilityApprover,
        approveHostResource: hostResourceIpcService.hostResourceApprover,
        promptForGrant: capabilityService.grantPrompt,
        portFilePath: path.join(app.getPath("userData"), "mcp-approval.json"),
      })

      // Remove the default File/Edit/View… menu bar — the app uses a tray icon
      // and sidebar navigation instead.
      Menu.setApplicationMenu(null)

      let settings = await launcher.init()
      try {
        await initLan(settings.lanEnabled)
      } catch (err) {
        logger.child("synapse").error("failed to initialize LAN discovery", { err })
        settings = await launcher.updateSettings({ lanEnabled: false })
      }
      await plugins.init()

      // Connect external MCP servers in the background — a slow or broken
      // server must not block the launcher coming up.
      void agent
        .startMcpServers()
        .catch((err) => logger.child("synapse").error("failed to start MCP clients", { err }))

      // Replay a queued macOS open-file, or a .syn passed on first launch
      // (Windows/Linux "open with"), now that the plugin host is ready.
      const launchSynapse = pendingSynapseImport ?? findSynapseArg(process.argv.slice(1))
      pendingSynapseImport = null
      if (launchSynapse) void importSynapseFromOs(launchSynapse)

      // Pre-warm both the main window (so the first show is instant) and the
      // app cache (so the first launcher query has results).
      mainWindow = createMainWindow()
      if (lanSimulation) showMainWindow()
      ensureSearchWindow(searchWindowDeps())
      void launcher.refreshApps()

      // Check for updates once on startup — but only where we can actually
      // deliver one: packaged Windows/Linux. macOS is shipped unsigned, and
      // Squirrel.Mac rejects unsigned updates, so we don't offer them there.
      if (shouldAutoCheckOnStartup(process.platform, app.isPackaged)) {
        void updateService
          ?.check()
          .catch((err) => logger.child("synapse").error("update check failed", { err }))
      }

      createTray(defaultTrayIcon(), trayActions())
      void rebindHotkeyAtStartup(settings.hotkey)
      syncFloatingBallWindow(floatingBallDeps())
      showStartupNotification({
        hotkey: settings.hotkey,
        locale: app.getLocale(),
        iconPath: defaultNotificationIcon(),
      })

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createMainWindow()
        }
        showMainWindow()
      })
    })

    app.on("will-quit", () => {
      setSearchWindowQuitting(true)
      destroyFloatingBallWindow()
      void lan
        ?.stop()
        .catch((err) => logger.child("synapse").error("failed to stop LAN discovery", { err }))
      void mcpClients
        ?.dispose()
        .catch((err) => logger.child("synapse").error("failed to stop MCP clients", { err }))
      unbindGlobalShortcut()
      destroyTray()
      approvalRegistry?.disposeAll()
      plugins?.dispose()
    })

    // Plugin storage uses a 250ms throttled tmp+rename flush. Without this
    // hook the user clicks Quit at t=240ms after a `storage.set` and Electron
    // exits before the flush timer fires — the write is dropped. We block
    // before-quit once, run flushAll, then quit again. The `pluginsFlushed`
    // flag ensures the second quit goes through normally instead of looping.
    let pluginsFlushed = false
    app.on("before-quit", () => {
      void headlessApprovalServer?.close()
    })
    app.on("before-quit", (event) => {
      quitRequested = true
      setSearchWindowQuitting(true)
      if (pluginsFlushed || !plugins) return
      event.preventDefault()
      void plugins
        .flush()
        .catch((err) =>
          logger.child("synapse").error("plugin flush failed during shutdown", { err })
        )
        .finally(() => {
          pluginsFlushed = true
          app.quit()
        })
    })

    // Tray-resident launcher: do NOT quit when all windows are closed.
    // Subscribing with a no-op handler suppresses Electron's default
    // "quit when last window closes" behaviour on Windows/Linux.
    app.on("window-all-closed", () => {
      // intentionally empty
    })
  }
}
