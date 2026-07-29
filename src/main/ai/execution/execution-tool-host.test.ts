import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_ARTIFACT_QUOTA_LIMITS } from "../artifacts/artifact-quota"
import { ArtifactStore } from "../artifacts/artifact-store"
import { ExecutionLogStore } from "./execution-log-store"
import { ExecutionToolHostSource } from "./execution-tool-host"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-exec-host-"))
  tempDirs.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, content)
  }
  return root
}

interface FakeRoot {
  id: string
  workspaceId: string
  name: string
  root: string
  role: "primary" | "additional"
  createdAt: number
}

function fakeWorkspaceRoots(records: FakeRoot[]) {
  return {
    listAll: async () => records,
    listForWorkspace: async (workspaceId: string) =>
      records.filter((r) => r.workspaceId === workspaceId),
  }
}

async function hostWithRoot(root: string, logFile: string, workspaceId = "w1") {
  const workspaceRoots = fakeWorkspaceRoots([
    { id: "repo", workspaceId, name: "repo", root, role: "primary", createdAt: 1000 },
  ])
  const source = new ExecutionToolHostSource({
    workspaceRoots,
    log: new ExecutionLogStore(logFile),
    isAllowed: () => true,
    now: () => 1000,
  })
  await source.refresh()
  return source
}

describe("executionToolHostSource", () => {
  it("lists no tools when no root exists anywhere, until refresh() sees one", async () => {
    const source = new ExecutionToolHostSource({
      workspaceRoots: fakeWorkspaceRoots([]),
      log: new ExecutionLogStore(path.join(os.tmpdir(), "unused.json")),
      isAllowed: () => true,
    })
    expect(source.listTools()).toEqual([])
    await source.refresh()
    expect(source.listTools()).toEqual([])
  })

  it("lists all five tools once refresh() sees a root, in any workspace", async () => {
    const root = await makeWorkspace()
    const source = await hostWithRoot(root, path.join(root, "log.json"))
    expect(source.listTools().map((tool) => tool.fqName)).toEqual([
      "execution:core/list_files",
      "execution:core/read_file",
      "execution:core/search_files",
      "execution:core/apply_patch",
      "execution:core/run_command",
    ])
  })

  it("lists no tools when isAllowed is false, even if roots exist", async () => {
    const root = await makeWorkspace()
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "w1", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(path.join(root, "log.json")),
      isAllowed: () => false,
    })
    await source.refresh()
    expect(source.listTools()).toEqual([])
  })

  it("denies invokeTool when isAllowed is false", async () => {
    const root = await makeWorkspace({ "a.txt": "hi" })
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "w1", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const logFile = path.join(root, "log.json")
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(logFile),
      isAllowed: () => false,
    })
    await source.refresh()
    const result = await source.invokeTool(
      "execution:core/read_file",
      { rootId: "repo", path: "a.txt" },
      { caller: { kind: "agent", conversationId: "c1", workspaceId: "w1" } }
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain("agent shell is disabled")
    await expect(new ExecutionLogStore(logFile).list()).resolves.toEqual([
      expect.objectContaining({ decision: "deny" }),
    ])
  })

  it("all five tools' schemas require rootId, not workspaceId", async () => {
    const root = await makeWorkspace()
    const source = await hostWithRoot(root, path.join(root, "log.json"))
    for (const tool of source.listTools()) {
      const schema = tool.manifestTool.inputSchema as { required?: string[] }
      expect(schema.required).toContain("rootId")
      expect(schema.required).not.toContain("workspaceId")
    }
  })

  it("reads and searches files inside the caller's own workspace root", async () => {
    const root = await makeWorkspace({ "src/a.ts": "export const FIXME = 1\n" })
    const source = await hostWithRoot(root, path.join(root, "log.json"), "w1")
    const caller = { kind: "agent" as const, conversationId: "c1", workspaceId: "w1" }

    const listed = await source.invokeTool(
      "execution:core/list_files",
      { rootId: "repo", path: "src" },
      { caller }
    )
    expect((listed.content[0] as { text: string }).text).toContain("a.ts")

    const read = await source.invokeTool(
      "execution:core/read_file",
      { rootId: "repo", path: "src/a.ts" },
      { caller }
    )
    expect((read.content[0] as { text: string }).text).toContain("export const FIXME")

    const search = await source.invokeTool(
      "execution:core/search_files",
      { rootId: "repo", query: "FIXME", path: "." },
      { caller }
    )
    expect((search.content[0] as { text: string }).text).toContain("FIXME")
  })

  it("rejects paths outside the workspace", async () => {
    const root = await makeWorkspace()
    const source = await hostWithRoot(root, path.join(root, "log.json"), "w1")
    const result = await source.invokeTool(
      "execution:core/read_file",
      { rootId: "repo", path: "../secret.txt" },
      { caller: { kind: "agent", workspaceId: "w1" } }
    )
    expect(result.isError).toBe(true)
  })

  it("denies forbidden commands at invoke time", async () => {
    const root = await makeWorkspace()
    const logFile = path.join(root, "log.json")
    const source = await hostWithRoot(root, logFile, "w1")
    const result = await source.invokeTool(
      "execution:core/run_command",
      { rootId: "repo", command: "rm -rf /" },
      { caller: { kind: "agent", conversationId: "c1", workspaceId: "w1" } }
    )
    expect(result.isError).toBe(true)
    await expect(new ExecutionLogStore(logFile).list()).resolves.toEqual([
      expect.objectContaining({ decision: "deny" }),
    ])
  })

  it("records approved audit decisions with both workspaceId and rootId", async () => {
    const root = await makeWorkspace({ "src/a.ts": "alpha\nbeta\n" })
    const logFile = path.join(root, "log.json")
    const source = await hostWithRoot(root, logFile, "w1")
    await source.invokeTool(
      "execution:core/apply_patch",
      {
        rootId: "repo",
        patch: `*** Begin Patch
*** Update File: src/a.ts
 alpha
-beta
+gamma
*** End Patch`,
      },
      {
        caller: { kind: "agent", conversationId: "c1", workspaceId: "w1" },
        executionAuditDecision: "approved",
      }
    )
    await expect(new ExecutionLogStore(logFile).list()).resolves.toEqual([
      expect.objectContaining({ decision: "approved", workspaceId: "w1", rootId: "repo" }),
    ])
  })

  it("denies every one of the five tools when caller.workspaceId is missing", async () => {
    const root = await makeWorkspace({ "src/a.ts": "x" })
    const source = await hostWithRoot(root, path.join(root, "log.json"), "w1")
    const caller = { kind: "background-agent" as const }
    const cases: [string, Record<string, unknown>][] = [
      ["execution:core/list_files", { rootId: "repo" }],
      ["execution:core/read_file", { rootId: "repo", path: "src/a.ts" }],
      ["execution:core/search_files", { rootId: "repo", query: "x" }],
      ["execution:core/apply_patch", { rootId: "repo", patch: "*** Begin Patch\n*** End Patch" }],
      ["execution:core/run_command", { rootId: "repo", command: "echo hi" }],
    ]
    for (const [fqName, input] of cases) {
      const result = await source.invokeTool(fqName, input, { caller })
      expect(result.isError).toBe(true)
    }
  })

  it("denies a rootId that belongs to a different workspace, even though it's globally valid", async () => {
    const root = await makeWorkspace()
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "other", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(path.join(root, "log.json")),
      isAllowed: () => true,
      now: () => 1000,
    })
    await source.refresh()
    const result = await source.invokeTool(
      "execution:core/list_files",
      { rootId: "repo" },
      { caller: { kind: "agent", workspaceId: "w1" } }
    )
    expect(result.isError).toBe(true)
  })

  it("a request with no rootId resolves to the caller's workspace's primary root", async () => {
    const root = await makeWorkspace({ "src/a.ts": "x" })
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "w1", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(path.join(root, "log.json")),
      isAllowed: () => true,
      now: () => 1000,
    })
    await source.refresh()
    const result = await source.invokeTool(
      "execution:core/read_file",
      { path: "src/a.ts" },
      { caller: { kind: "agent", workspaceId: "w1" } }
    )
    expect(result.isError).toBeFalsy()
    expect((result.content[0] as { text: string }).text).toContain("x")
  })

  it("a rootless (or primary-less) workspace's caller gets a clear denial, not a generic failure", async () => {
    const source = new ExecutionToolHostSource({
      workspaceRoots: fakeWorkspaceRoots([]),
      log: new ExecutionLogStore(path.join(os.tmpdir(), "unused2.json")),
      isAllowed: () => true,
    })
    await source.refresh()
    const result = await source.invokeTool(
      "execution:core/read_file",
      { path: "a.ts" },
      { caller: { kind: "agent", workspaceId: "w1" } }
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/root not available/i)
  })
})

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

async function makeArtifactsDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-exec-host-artifacts-"))
  tempDirs.push(dir)
  return dir
}

interface RunCommandStreamPayload {
  headPreview: string
  tailPreview: string
  artifactUri: string
  artifactId: string
  capturedBytes: number
  complete: boolean
  truncationReason?: string
}

interface RunCommandPayload {
  exitCode?: number | null
  timedOut?: boolean
  cancelled?: boolean
  error?: string
  stdout?: string | RunCommandStreamPayload
  stderr?: string | RunCommandStreamPayload
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

function payloadOf(result: {
  content: readonly { type: string; text?: string }[]
}): RunCommandPayload {
  return JSON.parse((result.content[0] as { text: string }).text) as RunCommandPayload
}

function asStream(value: string | RunCommandStreamPayload | undefined): RunCommandStreamPayload {
  if (typeof value === "string" || value === undefined) {
    throw new TypeError("expected artifact-backed stream payload, got legacy string/undefined")
  }
  return value
}

describe("executionToolHostSource — run_command artifact-backed capture (Task 18)", () => {
  it("captures stdout/stderr as artifacts and returns bounded head/tail previews when the caller has a runId", async () => {
    const root = await makeWorkspace()
    const logFile = path.join(root, "log.json")
    const artifactsDir = await makeArtifactsDir()
    const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "w1", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(logFile),
      isAllowed: () => true,
      now: () => 1000,
      artifactStore: store,
    })
    await source.refresh()

    const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"
    const result = await source.invokeTool(
      "execution:core/run_command",
      { rootId: "repo", command },
      { caller: { kind: "agent", conversationId: "c1", workspaceId: "w1", runId: "run-1" } }
    )
    expect(result.isError).toBeFalsy()
    const payload = payloadOf(result)
    expect(payload.error).toBeUndefined()
    const stdout = asStream(payload.stdout)
    expect(stdout.complete).toBe(true)
    expect(stdout.headPreview).toContain("ok")
    expect(stdout.tailPreview).toContain("ok")
    expect(stdout.artifactUri).toBe(`artifact://run/run-1/${stdout.artifactId}`)
    expect(typeof stdout.capturedBytes).toBe("number")
    // Real powershell.exe spawn — see command-runner.test.ts for why this
    // needs margin above Vitest's 5s default on a loaded CI runner.
  }, 30_000)

  it("falls back to the legacy in-memory shape when the caller has no runId, even with an artifact store configured", async () => {
    const root = await makeWorkspace()
    const logFile = path.join(root, "log.json")
    const artifactsDir = await makeArtifactsDir()
    const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "w1", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(logFile),
      isAllowed: () => true,
      now: () => 1000,
      artifactStore: store,
    })
    await source.refresh()
    const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"
    const result = await source.invokeTool(
      "execution:core/run_command",
      { rootId: "repo", command },
      { caller: { kind: "agent", conversationId: "c1", workspaceId: "w1" } } // no runId
    )
    const payload = payloadOf(result)
    expect(typeof payload.stdout).toBe("string")
    expect(payload.stdout).toContain("ok")
    expect(payload.error).toBeUndefined()
  }, 30_000)

  it("derives rootRunId from caller.runId when there is no parentRunId (root-level run)", async () => {
    const root = await makeWorkspace()
    const logFile = path.join(root, "log.json")
    const artifactsDir = await makeArtifactsDir()
    const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "w1", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(logFile),
      isAllowed: () => true,
      now: () => 1000,
      artifactStore: store,
    })
    await source.refresh()
    const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"
    const result = await source.invokeTool(
      "execution:core/run_command",
      { rootId: "repo", command },
      { caller: { kind: "agent", workspaceId: "w1", runId: "root-run-2" } }
    )
    const payload = payloadOf(result)
    const stdout = asStream(payload.stdout)
    const manifestPath = path.join(artifactsDir, "root-run-2", stdout.artifactId, "manifest.json")
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"))
    expect(manifest.owner.runId).toBe("root-run-2")
    expect(manifest.owner.rootRunId).toBe("root-run-2")
    expect(manifest.owner.parentRunId).toBeUndefined()
  }, 30_000)

  it("derives rootRunId from caller.parentRunId for a subagent run (no nesting beyond one level)", async () => {
    const root = await makeWorkspace()
    const logFile = path.join(root, "log.json")
    const artifactsDir = await makeArtifactsDir()
    const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "w1", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(logFile),
      isAllowed: () => true,
      now: () => 1000,
      artifactStore: store,
    })
    await source.refresh()
    const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"
    const result = await source.invokeTool(
      "execution:core/run_command",
      { rootId: "repo", command },
      {
        caller: {
          kind: "subagent",
          workspaceId: "w1",
          runId: "sub-run-1",
          parentRunId: "root-run-1",
        },
      }
    )
    const payload = payloadOf(result)
    const stdout = asStream(payload.stdout)
    const manifestPath = path.join(artifactsDir, "sub-run-1", stdout.artifactId, "manifest.json")
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"))
    expect(manifest.owner.runId).toBe("sub-run-1")
    expect(manifest.owner.rootRunId).toBe("root-run-1")
    expect(manifest.owner.parentRunId).toBe("root-run-1")
  }, 30_000)

  it("surfaces a visible output_limit_exceeded signal when a stream is truncated for a hard quota reason", async () => {
    const root = await makeWorkspace()
    const logFile = path.join(root, "log.json")
    const artifactsDir = await makeArtifactsDir()
    const store = new ArtifactStore(artifactsDir, {
      statDiskSpace: ampleDisk,
      quotaLimits: { ...DEFAULT_ARTIFACT_QUOTA_LIMITS, perArtifactBytes: 200 },
    })
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "w1", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(logFile),
      isAllowed: () => true,
      now: () => 1000,
      artifactStore: store,
    })
    await source.refresh()
    const size = 5000
    const command =
      process.platform === "win32"
        ? `Write-Output ('a' * ${size})`
        : `node -e "process.stdout.write('a'.repeat(${size}))"`
    const result = await source.invokeTool(
      "execution:core/run_command",
      { rootId: "repo", command },
      { caller: { kind: "agent", workspaceId: "w1", runId: "run-limit-1" } }
    )
    const payload = payloadOf(result)
    expect(payload.error).toBe("output_limit_exceeded")
    expect(asStream(payload.stdout).complete).toBe(false)
    // Load-bearing, not just a JSON field: resilient-tool-host.ts's circuit
    // breaker only calls recordToolError when isError is true,
    // agent-runtime.ts/run-projection.ts propagate isError into the
    // model/UI's tool_result event, and interactive-run-driver.ts computes
    // the run trace's `ok` as `!result.isError` — all three would silently
    // treat a truncated-output command as a clean success without this.
    expect(result.isError).toBe(true)

    const events = await new ExecutionLogStore(logFile).list()
    expect(events[0]).toMatchObject({ errorPreview: "output_limit_exceeded" })
  }, 30_000)

  it("records backend descriptor and artifact ids in the audit log, without inlining raw output", async () => {
    const root = await makeWorkspace()
    const logFile = path.join(root, "log.json")
    const artifactsDir = await makeArtifactsDir()
    const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
    const workspaceRoots = fakeWorkspaceRoots([
      { id: "repo", workspaceId: "w1", name: "repo", root, role: "primary", createdAt: 1000 },
    ])
    const source = new ExecutionToolHostSource({
      workspaceRoots,
      log: new ExecutionLogStore(logFile),
      isAllowed: () => true,
      now: () => 1000,
      artifactStore: store,
    })
    await source.refresh()
    const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"
    const result = await source.invokeTool(
      "execution:core/run_command",
      { rootId: "repo", command },
      { caller: { kind: "agent", workspaceId: "w1", runId: "run-audit-1" } }
    )
    const payload = payloadOf(result)
    const events = await new ExecutionLogStore(logFile).list()
    expect(events[0]).toMatchObject({
      backendId: "local-policy",
      backendIsolation: "none",
      backendReplayGuarantee: "none",
      stdoutArtifactId: asStream(payload.stdout).artifactId,
      stderrArtifactId: asStream(payload.stderr).artifactId,
    })
    expect(events[0].outputPreview.length).toBeLessThanOrEqual(2000)
  }, 30_000)
})
