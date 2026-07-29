// @vitest-environment node
import type { ExecResult } from "./exec"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createWindowsCredentialHelper } from "./windows"

let dir: string
const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "syn-cred-win-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function fakeExec(impl: (command: string, args: string[], stdin?: string) => ExecResult) {
  return vi.fn(async (command: string, args: string[], stdin?: string) =>
    impl(command, args, stdin)
  )
}

// A fake DPAPI: "encrypts" by reversing the string, "decrypts" by reversing
// it back — proves the round trip (Node writes/reads the blob file,
// PowerShell only ever sees the value via stdin) without a real Windows box.
function fakeDpapiExec() {
  return fakeExec((_command, args, stdin = "") => {
    const script = args[args.length - 1] ?? ""
    if (script.includes("Protect(")) {
      return { code: 0, stdout: Buffer.from(stdin).reverse().toString("base64"), stderr: "" }
    }
    return { code: 0, stdout: Buffer.from(stdin, "base64").reverse().toString("utf-8"), stderr: "" }
  })
}

describe("createWindowsCredentialHelper", () => {
  it("reports available via a pure filesystem check on the trusted absolute path — never a PATH search", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const fileExists = vi.fn(async () => true)
    const helper = createWindowsCredentialHelper(exec, {
      dir,
      powershellPath: POWERSHELL_PATH,
      fileExists,
    })
    expect(await helper.isAvailable()).toBe(true)
    expect(fileExists).toHaveBeenCalledWith(POWERSHELL_PATH)
    expect(exec).not.toHaveBeenCalled()
  })

  it("reports unavailable when powershell.exe doesn't exist at the trusted path", async () => {
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "" }))
    const helper = createWindowsCredentialHelper(exec, { dir, fileExists: async () => false })
    expect(await helper.isAvailable()).toBe(false)
  })

  it("invokes the trusted absolute path, never a bare command name PATH could resolve to something else", async () => {
    const exec = fakeDpapiExec()
    const helper = createWindowsCredentialHelper(exec, { dir, powershellPath: POWERSHELL_PATH })
    await helper.store("synapse-cli:https://m.test", "secret-token")
    const call = exec.mock.calls[0] as unknown as [string, string[], string]
    expect(call[0]).toBe(POWERSHELL_PATH)
  })

  it("passes the secret to PowerShell via stdin, never argv/env", async () => {
    const exec = fakeDpapiExec()
    const helper = createWindowsCredentialHelper(exec, { dir, powershellPath: POWERSHELL_PATH })
    await helper.store("synapse-cli:https://m.test", "secret-token")
    const call = exec.mock.calls[0] as unknown as [string, string[], string]
    expect(call[1].join(" ")).not.toContain("secret-token")
    expect(call[2]).toBe("secret-token")
  })

  it("round-trips store -> retrieve through a DPAPI-encrypted blob file", async () => {
    const exec = fakeDpapiExec()
    const helper = createWindowsCredentialHelper(exec, { dir, powershellPath: POWERSHELL_PATH })
    await helper.store("synapse-cli:https://m.test", "secret-token")
    expect(await helper.retrieve("synapse-cli:https://m.test")).toBe("secret-token")
  })

  it("never writes the plaintext secret to the blob file on disk", async () => {
    const exec = fakeDpapiExec()
    const helper = createWindowsCredentialHelper(exec, { dir, powershellPath: POWERSHELL_PATH })
    await helper.store("synapse-cli:https://m.test", "secret-token")
    const files = await fs.readdir(dir)
    expect(files).toHaveLength(1)
    const contents = await fs.readFile(path.join(dir, files[0] as string), "utf-8")
    expect(contents).not.toContain("secret-token")
  })

  it("returns undefined retrieving a key that was never stored", async () => {
    const exec = fakeDpapiExec()
    const helper = createWindowsCredentialHelper(exec, { dir, powershellPath: POWERSHELL_PATH })
    expect(await helper.retrieve("never-stored")).toBeUndefined()
  })

  it("erase removes the blob file so a later retrieve returns undefined", async () => {
    const exec = fakeDpapiExec()
    const helper = createWindowsCredentialHelper(exec, { dir, powershellPath: POWERSHELL_PATH })
    await helper.store("k", "secret-token")
    await helper.erase("k")
    expect(await helper.retrieve("k")).toBeUndefined()
  })

  it("erase is a no-op for an already-absent key", async () => {
    const exec = fakeDpapiExec()
    const helper = createWindowsCredentialHelper(exec, { dir, powershellPath: POWERSHELL_PATH })
    await expect(helper.erase("never-stored")).resolves.toBeUndefined()
  })
})
