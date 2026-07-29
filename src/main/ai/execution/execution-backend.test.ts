import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { afterEach, describe, expect, it } from "vitest"
import {
  createLocalPolicyExecutionBackend,
  describeIsolation,
  LOCAL_POLICY_BACKEND_DESCRIPTOR,
} from "./execution-backend"
import { WorkspacePolicy } from "./workspace-policy"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-exec-backend-"))
  tempDirs.push(root)
  return root
}

describe("localPolicyBackendDescriptor — honest reality labels", () => {
  it("declares no isolation and full host filesystem/network access", () => {
    expect(LOCAL_POLICY_BACKEND_DESCRIPTOR.isolation).toBe("none")
    expect(LOCAL_POLICY_BACKEND_DESCRIPTOR.hostFilesystemAccess).toBe("full")
    expect(LOCAL_POLICY_BACKEND_DESCRIPTOR.hostNetworkAccess).toBe("full")
    expect(LOCAL_POLICY_BACKEND_DESCRIPTOR.replayGuarantee).toBe("none")
  })

  it("describeIsolation never claims 'sandbox' for a non-isolated descriptor", () => {
    const text = describeIsolation(LOCAL_POLICY_BACKEND_DESCRIPTOR)
    expect(text.toLowerCase()).not.toContain("sandbox")
    expect(text.toLowerCase()).toContain("non-isolated")
  })

  it("describeIsolation labels an isolated descriptor without the word 'non-isolated'", () => {
    const text = describeIsolation({ ...LOCAL_POLICY_BACKEND_DESCRIPTOR, isolation: "container" })
    expect(text.toLowerCase()).not.toContain("non-isolated")
    expect(text.toLowerCase()).not.toContain("sandbox")
  })
})

describe("createLocalPolicyExecutionBackend", () => {
  // Real powershell.exe spawn — see command-runner.test.ts for why this
  // needs an explicit timeoutMs (below the outer test timeout, so
  // runCommand always self-terminates cleanly) plus margin + retry.
  it(
    "actually runs the command through the same runCommand path",
    { timeout: 20_000, retry: 2 },
    async () => {
      const root = await makeWorkspace()
      const policy = new WorkspacePolicy([{ id: "repo", root }])
      const backend = createLocalPolicyExecutionBackend()
      const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"

      const result = await backend.invoke(
        { invocationId: "inv-1", rootId: "repo", command, timeoutMs: 10_000 },
        policy
      )
      expect(result.exitCode).toBe(0)
      expect(result.legacyStdout).toContain("ok")
    }
  )

  it("always reports unknown for recoverInvocation — an invocation id alone proves nothing", async () => {
    const backend = createLocalPolicyExecutionBackend()
    expect(await backend.recoverInvocation("inv-1")).toEqual({ status: "unknown" })
    expect(await backend.recoverInvocation("never-happened")).toEqual({ status: "unknown" })
  })
})
