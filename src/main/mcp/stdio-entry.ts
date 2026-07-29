import type {
  CapabilityApprover,
  CapabilityRequest,
  GrantPromptPort,
} from "../plugins/capability-gate"
import type { PluginBridgeAdapters } from "../plugins/plugin-bridge"
import { spawn } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { RootBudgetLedgerStore } from "../ai/budget/root-budget-ledger"
import { asFallbackSource, CompositeToolHost } from "../ai/composite-tool-host"
import { MEMORY_FQ_PREFIX, MemoryToolSource } from "../ai/memory/memory-tools"
import { runTraceDir, upsertRunTrace } from "../ai/run-trace-store"
import { AgentRunStore } from "../ai/runs/agent-run-store"
import { WorkspaceRootStore } from "../ai/workspace/workspace-root-store"
import { WorkspaceStore } from "../ai/workspace/workspace-store"
import { createFileSink } from "../logging/file-sink"
import { buildGrantIdentity } from "../plugins/capability-governance"
import { PluginHost } from "../plugins/plugin-host"
import { createGuiApprovalPort } from "./gui-approval-client"
import { createHeadlessMemoryService } from "./headless-memory"
import { createHostResourceAccessAudit } from "./host-resource-audit"
import {
  createMcpDurableRunAdapter,
  reconcileMcpRunsAtStartup,
  scheduleMcpLeaseMaintenance,
} from "./mcp-durable-run"
import { McpRunLeaseStore } from "./mcp-run-lease"
import { resolveMcpWorkspaceBinding } from "./mcp-workspace-binding"
import { startParentWatchdog } from "./parent-watchdog"
import { resolveStdioUserDataDir } from "./stdio-paths"
import { runSynapseMcpStdioServer } from "./synapse-mcp-server"
import { createWorkspaceInstructionsResourcePort } from "./workspace-instructions-resource"

// Headless entry for the Synapse-as-MCP-server (`tools/list` + `tools/call`
// over stdio), consumed by external agents such as Claude Desktop.
//
// MUST run as plain Node (ELECTRON_RUN_AS_NODE=1): a spawned Electron GUI
// process on Windows never receives piped stdin, which the MCP stdio transport
// reads — so the previous `electron … --mcp-stdio` GUI path silently hangs.
// This module therefore imports NO Electron GUI API and writes NOTHING to
// stdout (the transport owns stdout; logs go to stderr).

// Read-only plugin tools (the only ones exposed by default) don't touch the
// desktop surface, so the OS adapters are stubbed to fail loudly rather than
// drag Electron in.
function headlessAdapters(): PluginBridgeAdapters {
  const unavailable = (feature: string) => async (): Promise<never> => {
    throw new Error(`${feature} is unavailable in headless MCP stdio mode`)
  }
  return {
    clipboard: { read: unavailable("clipboard.read"), write: unavailable("clipboard.write") },
    notifications: { show: unavailable("notifications.show") },
    system: {
      openUrl: unavailable("system.openUrl"),
      openPath: unavailable("system.openPath"),
      captureScreen: unavailable("system.captureScreen"),
    },
  }
}

function stripSignal(request: CapabilityRequest): Omit<CapabilityRequest, "signal"> {
  const { signal: _signal, ...rest } = request
  return rest
}

/** Relaunches the packaged app WITHOUT ELECTRON_RUN_AS_NODE, so it comes up
 *  as the normal GUI. If a GUI instance is already running, Electron's own
 *  requestSingleInstanceLock() handling (see createMainWindow's caller in
 *  src/main/index.ts) makes this spawn immediately hand off to the existing
 *  instance and exit — the net effect is "focus the existing window" for
 *  free, no separate focus-vs-launch branch needed here. */
function spawnGuiProcess(): void {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(process.execPath, [], { env, detached: true, stdio: "ignore" }).unref()
}

async function main(): Promise<void> {
  const userDataDir = resolveStdioUserDataDir(process.env, process.platform, os.homedir())
  // In the built bundle this file is out/main/mcp-stdio.js, so ../../resources
  // points at the app's resources dir (where builtin-plugins would live).
  const resourcesDir =
    process.env.SYNAPSE_RESOURCES_DIR?.trim() || path.join(__dirname, "..", "..", "resources")

  const approvalPortFilePath = path.join(userDataDir, "mcp-approval.json")
  const guiApprovalPort = createGuiApprovalPort({
    portFilePath: approvalPortFilePath,
    spawnGui: spawnGuiProcess,
  })
  const workspaceStore = new WorkspaceStore(path.join(userDataDir, "ai"))
  const workspaceRootStore = new WorkspaceRootStore(path.join(userDataDir, "ai"))
  const hostResourceAccessAudit = createHostResourceAccessAudit(
    createFileSink(path.join(userDataDir, "logs"), { fileName: "host-resource-audit.log" })
  )
  const workspaceInstructions = createWorkspaceInstructionsResourcePort({
    workspaces: workspaceStore,
    workspaceRoots: workspaceRootStore,
    approve: (input) => guiApprovalPort.requestHostResourceApproval(input),
    recordAccess: hostResourceAccessAudit,
  })
  const approve: CapabilityApprover = ({ identity, request }) =>
    guiApprovalPort.requestApproval({
      identity,
      request: stripSignal(request),
      signal: request.signal,
    })
  // Without this, CapabilityGovernance's own default (capability-governance.ts)
  // auto-allows every first-time JIT grant whenever no GUI is attached to
  // answer it — silently defeating "no silent auto-allow" for exactly the
  // unattended, headless-server case that most needs the fail-closed default.
  const prompt: GrantPromptPort = ({ identity, request, tier }) =>
    guiApprovalPort.requestPrompt({
      identity,
      request: stripSignal(request),
      tier,
      signal: request.signal,
    })

  // "tools-only" mode skips trigger registration, so no background-agent run
  // is ever dispatched here — these are supplied only because
  // PluginHostOptions requires them uniformly across every mode.
  const runsDir = runTraceDir(userDataDir)
  const mcpRunsDir = path.join(userDataDir, "ai", "runs")
  const runStore = new AgentRunStore(mcpRunsDir)
  const leaseStore = new McpRunLeaseStore(mcpRunsDir)
  // A hard process death can land either after finalization (before purge) or
  // while a host invocation is still in flight. Reclaim the former and
  // terminalize the latter as aborted from its frozen canonical operation
  // before accepting any new external call in this independent stdio process.
  await reconcileMcpRunsAtStartup({
    runStore,
    leaseStore,
    upsertTrace: (input) => upsertRunTrace(runsDir, input),
  })
  const mcpLeaseMaintenance = await scheduleMcpLeaseMaintenance({
    runStore,
    leaseStore,
    upsertTrace: (input) => upsertRunTrace(runsDir, input),
    onError: (error) => {
      process.stderr.write(
        `[synapse:mcp] deferred lease reconciliation failed: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }\n`
      )
    },
  })
  const durableRuns = createMcpDurableRunAdapter({
    runStore,
    leaseStore,
    upsertTrace: (input) => upsertRunTrace(runsDir, input),
    requestMaintenance: mcpLeaseMaintenance.request,
  })
  const pluginHost = new PluginHost({
    userDataDir,
    resourcesDir,
    adapters: headlessAdapters(),
    fetch: (url, init) => globalThis.fetch(url, init),
    runtime: () => ({ locale: "en", theme: { mode: "light", accent: "neutral" } }),
    capabilityGovernance: { userDataDir, approve, prompt },
    runStore,
    budgetStore: new RootBudgetLedgerStore(path.join(userDataDir, "ai", "budget")),
    upsertTrace: (input) => upsertRunTrace(runsDir, input),
    workspaceRoots: workspaceRootStore,
    mode: "tools-only",
    // __dirname here is this actual entry chunk's own folder (out/main/) —
    // a sibling build output, same pattern as src/main/index.ts's own
    // reference to this file (mcp-stdio.js) from the "index" entry.
    sandboxEntryScriptPath: path.join(__dirname, "plugin-runtime-entry.js"),
  })

  await pluginHost.init()
  const memory = createHeadlessMemoryService(userDataDir)
  const host = new CompositeToolHost([
    asFallbackSource(pluginHost, (fqName) => fqName.startsWith(MEMORY_FQ_PREFIX)),
    new MemoryToolSource(memory),
  ])

  const binding = resolveMcpWorkspaceBinding(process.env)
  const server = await runSynapseMcpStdioServer(host, {
    version: process.env.npm_package_version,
    workspaceBinding: binding,
    workspaces: workspaceStore,
    workspaceId: binding.kind === "bound" ? binding.workspaceId : undefined,
    onUnboundWarning: () => {
      process.stderr.write(
        "This Synapse MCP configuration is missing SYNAPSE_MCP_WORKSPACE.\n" +
          "Open Synapse → Settings → Workspaces → Connect an MCP client,\n" +
          "copy the generated configuration, then restart your MCP client.\n"
      )
    },
    memory: {
      list: (limit, scope) => memory.list(limit, scope),
      get: (id, scope) => memory.get(id, scope),
    },
    workspaceInstructions,
    exposure: pluginHost.mcpExposure,
    identityForPlugin: (pluginId) => {
      const entry = pluginHost.get(pluginId)
      return entry?.manifest
        ? buildGrantIdentity(pluginId, entry.manifest, entry.source.kind)
        : undefined
    },
    durableRuns,
  })

  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    mcpLeaseMaintenance.stop()
    void Promise.resolve(pluginHost.dispose()).finally(() => process.exit(0))
  }
  server.onclose = shutdown
  const parentPidEnv = process.env.SYNAPSE_MCP_PARENT_PID?.trim()
  const parentPid = parentPidEnv ? Number(parentPidEnv) : undefined
  if (parentPid !== undefined && Number.isInteger(parentPid) && parentPid > 0) {
    startParentWatchdog({ parentPid, onParentGone: shutdown })
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  process.stderr.write(
    `[synapse:mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  )
  process.exit(1)
})
