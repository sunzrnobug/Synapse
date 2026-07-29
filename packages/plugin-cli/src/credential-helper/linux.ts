import type { CredentialHelper } from "./types"
import * as path from "node:path"
import process from "node:process"
import { fileExists as defaultFileExists, runWithStdin } from "./exec"

const SERVICE = "synapse-cli"

/** Lets a user point at their actual secret-tool install when it isn't at
 *  one of the fixed candidate paths below — an explicit, user-controlled
 *  choice, not something resolved from an untrusted PATH search. */
export const SECRET_TOOL_PATH_ENV = "SYNAPSE_SECRET_TOOL_PATH"

// Unlike macOS/Windows, Linux has no single guaranteed install location for
// secret-tool — distro packaging (and Nix, flatpak, etc.) can put it
// elsewhere. Check the common fixed locations by absolute path.
const CANDIDATE_PATHS = ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool", "/bin/secret-tool"]

export type ExecFn = typeof runWithStdin

/**
 * Shells out to `secret-tool` (the `libsecret-tools` package — GNOME/most
 * desktop Linux distros, but not guaranteed present). `secret-tool store`
 * reads the secret from stdin, so it never appears in argv. When the tool
 * can't be resolved, `isAvailable()` reports false and the metadata store
 * fails closed (no plaintext fallback) rather than silently degrading.
 *
 * Resolution never trusts PATH (CWE-426): it checks `SYNAPSE_SECRET_TOOL_PATH`
 * (an explicit, user-controlled choice) and then a short list of fixed
 * absolute candidates, each via a pure filesystem check — no process spawn,
 * no `which`/`where` search at all. An earlier version fell back to a
 * one-time `which secret-tool` search when no fixed candidate existed; that
 * is still a PATH search an attacker-planted `which` or `secret-tool` could
 * intercept, so it was removed rather than narrowed.
 */
export function createLinuxCredentialHelper(
  exec: ExecFn = runWithStdin,
  options: { fileExists?: (path: string) => Promise<boolean> } = {}
): CredentialHelper {
  const fileExists = options.fileExists ?? defaultFileExists
  let resolved: string | undefined

  async function resolvePath(): Promise<string | undefined> {
    if (resolved) return resolved
    const override = process.env[SECRET_TOOL_PATH_ENV]
    // Must be absolute: fileExists() (fs.access) resolves a bare/relative
    // name against the process's cwd, but spawn() resolves a bare command
    // name (no path separator) via a PATH search regardless (execvp
    // semantics) — accepting anything less than an absolute path here
    // would let an override "pass" this check yet still run via PATH,
    // reintroducing the exact PATH-hijack (CWE-426) this design closes.
    if (override && path.isAbsolute(override) && (await fileExists(override))) {
      resolved = override
      return resolved
    }
    for (const candidate of CANDIDATE_PATHS) {
      if (await fileExists(candidate)) {
        resolved = candidate
        return resolved
      }
    }
    return undefined
  }

  return {
    name: "linux",
    async isAvailable() {
      return (await resolvePath()) !== undefined
    },
    async store(key, value) {
      const bin = await resolvePath()
      if (!bin) throw new Error("secret-tool is not available on this system")
      const result = await exec(
        bin,
        ["store", "--label", "Synapse CLI", "service", SERVICE, "account", key],
        value
      )
      if (result.code !== 0) {
        throw new Error(
          `secret-tool store failed: ${result.stderr.trim() || `exit ${result.code}`}`
        )
      }
    },
    async retrieve(key) {
      const bin = await resolvePath()
      if (!bin) return undefined
      const result = await exec(bin, ["lookup", "service", SERVICE, "account", key])
      if (result.code !== 0) return undefined
      return result.stdout.replace(/\n$/, "")
    },
    async erase(key) {
      const bin = await resolvePath()
      if (!bin) return
      // secret-tool clear exits 0 whether or not the entry existed.
      const result = await exec(bin, ["clear", "service", SERVICE, "account", key])
      if (result.code !== 0) {
        throw new Error(
          `secret-tool clear failed: ${result.stderr.trim() || `exit ${result.code}`}`
        )
      }
    },
  }
}
