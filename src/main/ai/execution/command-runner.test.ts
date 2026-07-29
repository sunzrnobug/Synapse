import type { CommandRunResult } from "./command-runner"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_ARTIFACT_QUOTA_LIMITS } from "../artifacts/artifact-quota"
import { ArtifactStore } from "../artifacts/artifact-store"
import { runCommand } from "./command-runner"
import { WorkspacePolicy } from "./workspace-policy"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-cmd-"))
  tempDirs.push(root)
  return root
}

async function makeArtifactsDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-cmd-artifacts-"))
  tempDirs.push(dir)
  return dir
}

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

function owner(runId = "run-1") {
  return { runId, rootRunId: runId, principal: { kind: "internal-agent" as const } }
}

async function writeScript(dir: string, name: string, source: string): Promise<string> {
  const file = path.join(dir, name)
  await fs.writeFile(file, source)
  return file
}

describe("runCommand — legacy in-memory path (no artifacts option)", () => {
  // Real powershell.exe spawns. Vitest's default 5s test timeout has no
  // margin for one. Two things matter here, not just one:
  // 1. An explicit runCommand `timeoutMs` well below the outer Vitest
  //    timeout, so runCommand's OWN kill logic always fires first. Without
  //    this, a slow/contended CI moment can make Vitest abandon the test
  //    before runCommand's (30s-default) internal timer ever fires — and
  //    Vitest never kills the underlying child process on its own, so the
  //    orphan keeps running and holds a Windows-exclusive file lock inside
  //    its temp workspace, corrupting every later test's fs.rm() cleanup
  //    with EBUSY/ENOTEMPTY. Bounding runCommand's own timeout guarantees a
  //    clean, timely return (timedOut:true in the worst case) instead of an
  //    orphan, regardless of how contended the runner is.
  // 2. retry (the standard mitigation for CI-load-sensitive real-process
  //    tests), for the rare case (1) still produces a slow-but-not-hung
  //    result that fails this test's assertions.
  it("runs a simple command with exit code 0", { timeout: 20_000, retry: 2 }, async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"
    const result = await runCommand(policy, { rootId: "repo", command, timeoutMs: 10_000 })
    expect(result.exitCode).toBe(0)
    expect(result.legacyStdout).toContain("ok")
    expect(result.stdout).toBeUndefined()
  })

  it("returns non-zero exit codes", { timeout: 20_000, retry: 2 }, async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const command = process.platform === "win32" ? "exit 3" : "exit 3"
    const result = await runCommand(policy, { rootId: "repo", command, timeoutMs: 5_000 })
    expect(result.exitCode).not.toBe(0)
  })

  it("times out long-running commands", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5"
    const result = await runCommand(policy, {
      rootId: "repo",
      command,
      timeoutMs: 200,
    })
    expect(result.timedOut).toBe(true)
  }, 30_000)

  it("cancels via AbortSignal", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const controller = new AbortController()
    const command = process.platform === "win32" ? "ping -n 60 127.0.0.1 >nul" : "sleep 60"
    const pending = runCommand(
      policy,
      { rootId: "repo", command, timeoutMs: 60_000 },
      controller.signal
    )
    controller.abort()
    const result = await pending
    expect(result.cancelled).toBe(true)
  }, 30_000)
})

describe("runCommand — artifact-backed capture path", () => {
  it(
    "captures stdout as a durable, complete artifact with bounded head/tail previews",
    { timeout: 20_000, retry: 2 },
    async () => {
      const root = await makeWorkspace()
      const policy = new WorkspacePolicy([{ id: "repo", root }])
      const artifactsDir = await makeArtifactsDir()
      const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
      const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"

      const result = await runCommand(policy, {
        rootId: "repo",
        command,
        timeoutMs: 10_000,
        artifacts: { store, owner: owner() },
      })

      expect(result.exitCode).toBe(0)
      expect(result.legacyStdout).toBeUndefined()
      expect(result.stdout?.artifact.complete).toBe(true)
      expect(result.stdout?.artifact.truncationReason).toBeUndefined()
      expect(result.stdout?.headPreview).toContain("ok")
      expect(result.stdout?.tailPreview).toContain("ok")
      expect(result.stdout?.artifact.uri).toBe(
        `artifact://run/run-1/${result.stdout?.artifact.artifactId}`
      )
      expect(result.stderr?.artifact.complete).toBe(true)
    }
  )

  it(
    "captures output above the legacy preview cap but below artifact limits, and survives a store restart",
    { timeout: 20_000, retry: 2 },
    async () => {
      const root = await makeWorkspace()
      const policy = new WorkspacePolicy([{ id: "repo", root }])
      const artifactsDir = await makeArtifactsDir()
      const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
      const size = 40_000 // > legacy 32,000-char cap, << the 64 MiB artifact ceiling
      const command =
        process.platform === "win32"
          ? `Write-Output ('a' * ${size})`
          : `node -e "process.stdout.write('a'.repeat(${size}))"`

      const result = await runCommand(policy, {
        rootId: "repo",
        command,
        timeoutMs: 10_000,
        artifacts: { store, owner: owner() },
      })

      expect(result.stdout?.artifact.complete).toBe(true)
      expect(result.stdout?.artifact.capturedBytes).toBeGreaterThanOrEqual(size)

      // Simulate a full process restart: a fresh ArtifactStore instance
      // pointed at the same baseDir must still be able to read the complete
      // artifact back, byte-for-byte and hash-for-hash.
      const restarted = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
      const ref = result.stdout!.artifact
      const bytes = await restarted.read(ref, { start: 0 }, { ...owner() })
      expect(bytes.length).toBe(ref.capturedBytes)
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.sha256)
    }
  )

  it("kills the entire process tree when stdout exceeds its artifact quota, without deadlocking stderr's undrained pipe", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const artifactsDir = await makeArtifactsDir()
    // A generous-relative-to-the-writes-but-still-small ceiling: stdout
    // writes a single ~500KB burst (blows straight through it), while
    // stderr trickles a handful of bytes on an interval and can never,
    // even over its full bounded run, approach this ceiling on its own.
    const store = new ArtifactStore(artifactsDir, {
      statDiskSpace: ampleDisk,
      quotaLimits: { ...DEFAULT_ARTIFACT_QUOTA_LIMITS, perArtifactBytes: 200_000 },
    })
    const scriptDir = await makeArtifactsDir()
    const script = await writeScript(
      scriptDir,
      "burst.js",
      [
        "process.stdout.write('O'.repeat(500000))",
        "let n = 0",
        "const t = setInterval(() => {",
        "  process.stderr.write('E'.repeat(5))",
        "  n += 1",
        "  if (n > 2000) clearInterval(t)",
        "}, 5)",
      ].join("\n")
    )
    const command = `node "${script}"`

    const TIMEOUT_SENTINEL = Symbol("deadlock-sentinel")
    const race = await Promise.race([
      runCommand(policy, {
        rootId: "repo",
        command,
        timeoutMs: 15_000,
        artifacts: { store, owner: owner() },
      }),
      new Promise((resolve) => setTimeout(resolve, 5_000, TIMEOUT_SENTINEL)),
    ])

    // A real deadlock would have left this Promise.race hanging on the
    // sentinel instead of resolving via runCommand's own result — this is
    // an active proof of no-deadlock within a bounded window, not a
    // reliance on Vitest's own (much longer) test timeout as the only
    // safety net.
    expect(race).not.toBe(TIMEOUT_SENTINEL)
    const result = race as CommandRunResult

    expect(result.stdout?.artifact.complete).toBe(false)
    expect(["artifact-limit", "run-limit"]).toContain(result.stdout?.artifact.truncationReason)

    // The crux of the coordination fix: stderr never came close to its
    // own quota, yet it must NOT report complete: true — it was cut off
    // by its sibling's abort, not by exhausting its own source normally.
    expect(result.stderr?.artifact.complete).toBe(false)
    expect(result.stderr?.artifact.truncationReason).toBe("producer-aborted")
  }, 20_000)

  it("marks both stdout and stderr artifacts producer-aborted when the command times out mid-stream", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const artifactsDir = await makeArtifactsDir()
    const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
    const scriptDir = await makeArtifactsDir()
    // Writes continuously to both streams for far longer than the
    // timeoutMs below, so the capture is genuinely cut off mid-flight —
    // not just racing a process that was about to finish anyway.
    const script = await writeScript(
      scriptDir,
      "trickle.js",
      [
        "let i = 0",
        "function loop() {",
        "  if (i++ < 100000) {",
        "    process.stdout.write('o'.repeat(200))",
        "    process.stderr.write('e'.repeat(200))",
        "    setImmediate(loop)",
        "  }",
        "}",
        "loop()",
      ].join("\n")
    )
    const command = `node "${script}"`

    // Generous enough for node.exe's own startup (which can itself take
    // well over 100ms) to complete and several setImmediate iterations to
    // flow before the timeout fires. The tight, uncapped setImmediate
    // loop above (as opposed to a slow interval) keeps a steady backlog
    // of unconsumed chunks queued on both streams at essentially any
    // instant, so whenever the kill/abort actually lands, capture()'s
    // per-chunk producer.signal check gets a real chance to observe it —
    // a timeout racing a source that's already gone idle (nothing left
    // to check the signal against before EOF) can't reliably distinguish
    // "correctly marked producer-aborted" from capture()'s own signal
    // check simply never getting invoked again.
    const result = await runCommand(policy, {
      rootId: "repo",
      command,
      timeoutMs: 600,
      artifacts: { store, owner: owner() },
    })

    expect(result.timedOut).toBe(true)
    expect(result.stdout?.artifact.complete).toBe(false)
    expect(result.stdout?.artifact.truncationReason).toBe("producer-aborted")
    expect(result.stderr?.artifact.complete).toBe(false)
    expect(result.stderr?.artifact.truncationReason).toBe("producer-aborted")
  }, 30_000)

  it("marks both stdout and stderr artifacts producer-aborted when cancelled via AbortSignal mid-stream", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const artifactsDir = await makeArtifactsDir()
    const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
    const scriptDir = await makeArtifactsDir()
    const script = await writeScript(
      scriptDir,
      "trickle.js",
      [
        "let i = 0",
        "function loop() {",
        "  if (i++ < 100000) {",
        "    process.stdout.write('o'.repeat(200))",
        "    process.stderr.write('e'.repeat(200))",
        "    setImmediate(loop)",
        "  }",
        "}",
        "loop()",
      ].join("\n")
    )
    const command = `node "${script}"`
    const controller = new AbortController()

    const pending = runCommand(
      policy,
      { rootId: "repo", command, timeoutMs: 60_000, artifacts: { store, owner: owner() } },
      controller.signal
    )
    // Give the child real time to spawn and flow several chunks before
    // cancelling — aborting immediately (before any chunk has arrived)
    // would race the same known zero-chunk gap noted above, rather than
    // exercising the mid-stream cancellation path this test targets.
    // Empirically, node.exe's own cold-start through the powershell -Command
    // wrapper on this platform can itself take several hundred ms, so a
    // short delay here reliably observed zero captured bytes rather than a
    // genuine mid-stream cut — 600ms matches the timeout test's margin.
    await new Promise((resolve) => setTimeout(resolve, 600))
    controller.abort()
    const result = await pending

    expect(result.cancelled).toBe(true)
    expect(result.stdout?.artifact.complete).toBe(false)
    expect(result.stdout?.artifact.truncationReason).toBe("producer-aborted")
    expect(result.stderr?.artifact.complete).toBe(false)
    expect(result.stderr?.artifact.truncationReason).toBe("producer-aborted")
  }, 30_000)
})
