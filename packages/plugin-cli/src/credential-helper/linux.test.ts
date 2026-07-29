import type { ExecResult } from "./exec"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLinuxCredentialHelper, SECRET_TOOL_PATH_ENV } from "./linux"

function fakeExec(impl: (command: string, args: string[], stdin?: string) => ExecResult) {
  return vi.fn(async (command: string, args: string[], stdin?: string) =>
    impl(command, args, stdin)
  )
}

const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  originalEnv[SECRET_TOOL_PATH_ENV] = process.env[SECRET_TOOL_PATH_ENV]
  delete process.env[SECRET_TOOL_PATH_ENV]
})

afterEach(() => {
  if (originalEnv[SECRET_TOOL_PATH_ENV] === undefined) delete process.env[SECRET_TOOL_PATH_ENV]
  else process.env[SECRET_TOOL_PATH_ENV] = originalEnv[SECRET_TOOL_PATH_ENV]
})

describe("createLinuxCredentialHelper", () => {
  it("resolves secret-tool via a pure filesystem check on a fixed candidate path", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    expect(await helper.isAvailable()).toBe(true)
    // Never shells out to resolve availability — no PATH search of any kind.
    expect(exec).not.toHaveBeenCalled()
  })

  it("prefers an explicit SYNAPSE_SECRET_TOOL_PATH override when it exists", async () => {
    process.env[SECRET_TOOL_PATH_ENV] = "/opt/custom/secret-tool"
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const fileExists = vi.fn(async (p: string) => p === "/opt/custom/secret-tool")
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await helper.store("k", "v")
    expect(exec).toHaveBeenCalledWith(
      "/opt/custom/secret-tool",
      expect.arrayContaining(["store"]),
      "v"
    )
  })

  it("ignores an explicit override that doesn't actually exist, falling back to fixed candidates", async () => {
    process.env[SECRET_TOOL_PATH_ENV] = "/opt/does-not-exist/secret-tool"
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await helper.store("k", "v")
    expect(exec).toHaveBeenCalledWith(
      "/usr/bin/secret-tool",
      expect.arrayContaining(["store"]),
      "v"
    )
  })

  // Regression test: fileExists() resolves a bare name relative to the
  // process's cwd (fs.access has no concept of PATH), but spawn() resolves
  // a bare command name (no path separator) via a PATH search regardless
  // (execvp semantics) — so accepting a non-absolute override here would
  // let it "pass" a filesystem check yet still end up spawned via PATH,
  // reintroducing the exact PATH-hijack (CWE-426) this design closes.
  it("rejects a non-absolute SYNAPSE_SECRET_TOOL_PATH override, even if fileExists would resolve it", async () => {
    process.env[SECRET_TOOL_PATH_ENV] = "secret-tool"
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    // Simulate the override "resolving" via a cwd-relative fs.access hit —
    // it must still be rejected for not being an absolute path.
    const fileExists = vi.fn(
      async (p: string) => p === "secret-tool" || p === "/usr/bin/secret-tool"
    )
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await helper.store("k", "v")
    expect(exec).toHaveBeenCalledWith(
      "/usr/bin/secret-tool",
      expect.arrayContaining(["store"]),
      "v"
    )
  })

  // Regression test: an earlier version fell back to `exec("which", ["secret-tool"])`
  // and trusted whatever path it returned. That's still a PATH search — a
  // malicious `which` (or a hijacked `secret-tool` that `which` legitimately
  // finds first on a poisoned PATH) could intercept the token. This helper
  // must never shell out to search PATH at all; an unresolvable secret-tool
  // fails closed instead.
  it("never falls back to a PATH search (no `which`/`where` call) when no fixed candidate or override exists", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "/usr/bin/secret-tool", stderr: "" }))
    const fileExists = vi.fn(async () => false)
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    expect(await helper.isAvailable()).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it("reports unavailable when secret-tool is not installed anywhere (not every distro ships libsecret-tools)", async () => {
    const fileExists = vi.fn(async () => false)
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    expect(await helper.isAvailable()).toBe(false)
  })

  it("stores a secret via stdin, never as an argv value", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await helper.store("synapse-cli:https://m.test", "secret-token")
    expect(exec).toHaveBeenCalledWith(
      "/usr/bin/secret-tool",
      [
        "store",
        "--label",
        "Synapse CLI",
        "service",
        "synapse-cli",
        "account",
        "synapse-cli:https://m.test",
      ],
      "secret-token"
    )
  })

  it("throws a clear error when the store call fails", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "no keyring daemon" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await expect(helper.store("k", "v")).rejects.toThrow(/secret-tool store failed/i)
  })

  it("retrieves a stored secret from stdout", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const exec = fakeExec(() => ({ code: 0, stdout: "secret-token\n", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    expect(await helper.retrieve("synapse-cli:https://m.test")).toBe("secret-token")
  })

  it("returns undefined for a key that was never stored", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    expect(await helper.retrieve("missing")).toBeUndefined()
  })

  it("erase succeeds whether or not the entry existed", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await expect(helper.erase("missing")).resolves.toBeUndefined()
  })

  it("throws from store when secret-tool can't be resolved at all", async () => {
    const fileExists = vi.fn(async () => false)
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await expect(helper.store("k", "v")).rejects.toThrow(/secret-tool/i)
  })
})
