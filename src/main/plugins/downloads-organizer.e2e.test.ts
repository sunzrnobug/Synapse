import type {
  ChatContentBlock,
  ChatMessage,
  ChatProvider,
  ProviderToolSchema,
} from "../ai/providers/types"
import type { FsWatchAdapter } from "./fs-watch-adapter"
import type { PluginBridgeAdapters } from "./plugin-bridge"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { rootIdForPattern } from "@synapse/plugin-manifest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RootBudgetLedgerStore } from "../ai/budget/root-budget-ledger"
import { emptyUsage } from "../ai/providers/types"
import { upsertRunTrace } from "../ai/run-trace-store"
import { AgentRunStore } from "../ai/runs/agent-run-store"
import { modelToolName } from "../ai/tool-registry"
import { createHeadlessHotkeyAdapter } from "./headless-trigger-adapters"
import { PluginHost } from "./plugin-host"
import { createInProcessPluginFork } from "./test-support/in-process-plugin-fork"

let dir: string
let home: string
let previousHome: string | undefined
let hostForCleanup: PluginHost | undefined
let supportForCleanup: ReturnType<typeof runsSupport> | undefined

function runsSupport(
  baseDir: string,
  onTrace?: (
    input: Parameters<ConstructorParameters<typeof PluginHost>[0]["upsertTrace"]>[0]
  ) => void
): {
  runStore: AgentRunStore
  budgetStore: RootBudgetLedgerStore
  upsertTrace: ConstructorParameters<typeof PluginHost>[0]["upsertTrace"]
  hasFinalization: () => boolean
  waitForFinalization: () => Promise<void>
} {
  const runsDir = path.join(baseDir, "ai-runs")
  const runStore = new AgentRunStore(runsDir)
  const finalizations: Promise<void>[] = []
  return {
    runStore,
    budgetStore: new RootBudgetLedgerStore(path.join(baseDir, "ai-budget")),
    upsertTrace: (input) => {
      const receipt = upsertRunTrace(runsDir, input)
      if (onTrace) {
        const finalization = notifyAfterTerminal(runStore, input, onTrace)
        finalizations.push(finalization)
        void finalization.catch(() => {})
      }
      return receipt
    },
    hasFinalization: () => finalizations.length > 0,
    waitForFinalization: async () => {
      await Promise.all(finalizations)
    },
  }
}

async function notifyAfterTerminal(
  runStore: AgentRunStore,
  input: Parameters<ConstructorParameters<typeof PluginHost>[0]["upsertTrace"]>[0],
  onTrace: (
    input: Parameters<ConstructorParameters<typeof PluginHost>[0]["upsertTrace"]>[0]
  ) => void
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const loaded = await runStore.load(input.runId)
    if (!loaded.ok) throw new Error(`background run ${input.runId} is ${loaded.reason}`)
    if (
      ["completed", "failed", "cancelled"].includes(loaded.checkpoint.status) &&
      loaded.checkpoint.finalization?.phase === "complete"
    ) {
      onTrace(input)
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`background run ${input.runId} did not reach terminal finalization`)
}

const CLASSIFY_AND_MOVE_TOOL_NAME = modelToolName({
  fqName: "com.synapse.downloads-organizer/classifyAndMove",
  provenance: "plugin",
})

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-downloads-organizer-"))
  home = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-home-"))
  previousHome = process.env.HOME
  process.env.HOME = home
  hostForCleanup = undefined
  supportForCleanup = undefined
})

afterEach(async () => {
  await hostForCleanup?.killAllBackground()
  if (supportForCleanup?.hasFinalization()) await supportForCleanup.waitForFinalization()
  process.env.HOME = previousHome
  await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(home, { recursive: true, force: true })
})

describe("downloadsOrganizer", () => {
  it("classifies a settled download, moves it, and rolls back from notification Undo", async () => {
    const rootId = rootIdForPattern("~/Downloads/**")
    await fs.mkdir(path.join(home, "Downloads"), { recursive: true })
    await fs.writeFile(path.join(home, "Downloads", "report.pdf"), "pdf", "utf8")

    const fires: Record<string, Parameters<FsWatchAdapter["register"]>[3]> = {}
    const fsWatchAdapter: FsWatchAdapter = {
      register: (pluginId, triggerId, _scope, fire) => {
        fires[`${pluginId}:${triggerId}`] = fire
        return () => {}
      },
    }
    const notifications: Array<Parameters<PluginBridgeAdapters["notifications"]["show"]>[0]> = []
    const adapters: PluginBridgeAdapters = {
      clipboard: { read: async () => undefined, write: async () => {} },
      notifications: {
        show: async (options) => {
          notifications.push(options)
        },
      },
      system: {
        openUrl: async () => {},
        openPath: async () => {},
        captureScreen: async () => ({ path: "" }),
      },
    }
    const seenTools: ProviderToolSchema[][] = []
    const seenMessages: ChatMessage[][] = []
    const provider = fakeProvider(seenTools, seenMessages, {
      sourceRootId: rootId,
      sourceRel: "report.pdf",
      category: "documents",
      reason: "pdf document",
    })
    // recordRun fires only after the durable run's finalization (checkpoint
    // completion, trace upsert, resource release) has fully settled — unlike
    // the tool/file assertions below, waiting on this ensures the run's async
    // fs writes are done before afterEach removes the temp dir.
    const runRecorded = vi.fn()
    const support = runsSupport(dir, runRecorded)
    supportForCleanup = support
    const host = new PluginHost({
      userDataDir: dir,
      resourcesDir: path.resolve("resources"),
      adapters,
      hotkeyAdapter: createHeadlessHotkeyAdapter(),
      fsWatchAdapter,
      storageFlushMs: 0,
      workspaceRoots: { listForWorkspace: async () => [] },
      sandboxForkProcess: createInProcessPluginFork(),
      ...support,
      backgroundAgentProvider: async () => ({ provider, model: "fake-model" }),
      capabilityGovernance: {
        userDataDir: dir,
        approve: async () => ({ allow: true }),
        prompt: async () => ({ allow: true }),
      },
    })
    hostForCleanup = host

    await host.init()
    expect(host.get("com.synapse.downloads-organizer")?.status).toBe("active")
    await host.createTriggerInstance("com.synapse.downloads-organizer", "downloads", "default")
    expect(fires["com.synapse.downloads-organizer:downloads"]).toBeTypeOf("function")
    fires["com.synapse.downloads-organizer:downloads"]?.({
      rootId,
      relativePath: "report.pdf",
      kind: "create",
      timestamp: 1,
      size: 3,
      ext: "pdf",
    })
    await vi.waitFor(() => expect(seenTools.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(seenMessages.length).toBeGreaterThan(1))
    const toolResult = seenMessages
      .at(-1)
      ?.flatMap((message) => message.content)
      .find((block) => block.type === "tool_result")
    if (toolResult?.type === "tool_result" && toolResult.isError) {
      throw new Error(toolResult.content)
    }
    expect(toolResult).toMatchObject({ type: "tool_result", isError: false })

    await vi.waitFor(async () => {
      await expect(
        fs.readFile(path.join(home, "Downloads", "Documents", "report.pdf"), "utf8")
      ).resolves.toBe("pdf")
    })
    await expect(fs.access(path.join(home, "Downloads", "report.pdf"))).rejects.toThrow()
    expect(notifications[0]?.actions?.[0]?.title).toBe("Undo")

    const firstToolList = seenTools[0]?.map((tool) => tool.name) ?? []
    expect(firstToolList).toContain(CLASSIFY_AND_MOVE_TOOL_NAME)
    expect(firstToolList.some((tool) => tool.includes("fs_write"))).toBe(false)

    await host.bridge.handleNotificationAction(
      notifications[0]!.notificationId,
      notifications[0]!.actions![0]!.actionId
    )

    expect(await fs.readFile(path.join(home, "Downloads", "report.pdf"), "utf8")).toBe("pdf")
    await expect(
      fs.access(path.join(home, "Downloads", "Documents", "report.pdf"))
    ).rejects.toThrow()

    await vi.waitFor(() => expect(support.hasFinalization()).toBe(true), { timeout: 5000 })
    await support.waitForFinalization()
    await host.waitForBackgroundIdle()
    expect(runRecorded).toHaveBeenCalledTimes(1)
  })
})

function fakeProvider(
  seenTools: ProviderToolSchema[][],
  seenMessages: ChatMessage[][],
  input: unknown
): ChatProvider {
  let turn = 0
  return {
    // A real catalogued provider id (Task 23): setupBackgroundRun now
    // resolves a real capability profile at run creation and rejects a
    // finite runBudgetTokens/maxTokensPerRun the resolved profile's own
    // estimator cannot back — a synthetic "fake" id would fall back to the
    // never-finite-budget-eligible unknown-model profile. The manifest
    // configures a finite maxTokensPerRun; durable admission (at first
    // dispatch) also fails closed for a finite-budget run whose provider
    // can't guarantee an upper bound.
    id: "anthropic",
    estimateRequestUpperBound: () => ({
      estimatorId: "fake",
      estimatorVersion: "1",
      inputUpperBoundTokens: 0,
      maxOutputTokens: 100,
    }),
    async *stream(req) {
      seenTools.push(req.tools)
      seenMessages.push(req.messages)
      const content: ChatContentBlock[] =
        turn++ === 0
          ? [
              {
                type: "tool_use",
                id: "tool-1",
                name: CLASSIFY_AND_MOVE_TOOL_NAME,
                input,
              },
            ]
          : [{ type: "text", text: "done" }]
      yield {
        type: "message",
        message: { role: "assistant", content },
        usage: emptyUsage(),
        stopReason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
      }
    },
  }
}
