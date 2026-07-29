import type { CredentialHelper } from "./types"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { fileExists as defaultFileExists, runWithStdin } from "./exec"

export type ExecFn = typeof runWithStdin

// Reads the secret from stdin as UTF-8, DPAPI-protects it for the current
// Windows user account, and writes the result to stdout as base64. Never
// touches disk itself — Node owns writing the ciphertext blob.
const ENCRYPT_SCRIPT = `
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`

const DECRYPT_SCRIPT = `
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($b64)
$unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($unprotected))
`

/** The built-in Windows PowerShell's fixed, OS-guaranteed location — never
 *  resolved via PATH, so an attacker-planted `powershell.exe` earlier on
 *  PATH can't intercept a call that receives the secret via stdin. */
function defaultPowershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows"
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

/**
 * DPAPI-backed storage: PowerShell (present on every supported Windows
 * version) does the encrypt/decrypt via .NET's ProtectedData, tied to the
 * current user account; Node writes/reads the resulting ciphertext blob to
 * a file. Unlike Windows Credential Manager (whose stored secrets can't be
 * read back out through a CLI — `cmdkey` only lists/deletes), this gives a
 * real store+retrieve round trip without a compiled native addon. The
 * secret itself is always passed via stdin to PowerShell, never argv/env,
 * and PowerShell is always invoked by its trusted absolute path (CWE-426).
 */
export function createWindowsCredentialHelper(
  exec: ExecFn = runWithStdin,
  options: {
    dir?: string
    powershellPath?: string
    fileExists?: (path: string) => Promise<boolean>
  } = {}
): CredentialHelper {
  const dir = options.dir ?? path.join(os.homedir(), ".synapse", "credential-blobs")
  const powershellPath = options.powershellPath ?? defaultPowershellPath()
  const fileExists = options.fileExists ?? defaultFileExists

  function blobPath(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex")
    return path.join(dir, `${digest}.dpapi`)
  }

  return {
    name: "windows",
    async isAvailable() {
      return fileExists(powershellPath)
    },
    async store(key, value) {
      const result = await exec(
        powershellPath,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ENCRYPT_SCRIPT],
        value
      )
      if (result.code !== 0) {
        throw new Error(`DPAPI encrypt failed: ${result.stderr.trim() || `exit ${result.code}`}`)
      }
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(blobPath(key), result.stdout.trim(), "utf-8")
    },
    async retrieve(key) {
      let ciphertext: string
      try {
        ciphertext = await fs.readFile(blobPath(key), "utf-8")
      } catch {
        return undefined
      }
      const result = await exec(
        powershellPath,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DECRYPT_SCRIPT],
        ciphertext
      )
      if (result.code !== 0) return undefined
      return result.stdout
    },
    async erase(key) {
      await fs.rm(blobPath(key), { force: true })
    },
  }
}
