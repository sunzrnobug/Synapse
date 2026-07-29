import type { CredentialHelper } from "./types"
import { fileExists as defaultFileExists, runWithStdin } from "./exec"

const SERVICE = "synapse-cli"

/** Fixed, SIP-protected location — every Mac ships `security` exactly here. */
const SECURITY_PATH = "/usr/bin/security"

export type ExecFn = typeof runWithStdin

/**
 * Shells out to the `security` CLI (macOS Keychain), present on every Mac —
 * no compiled native addon. Always invoked by its trusted absolute path
 * rather than a bare command name: `spawn("security", ...)` would resolve
 * through PATH, letting an earlier, attacker-planted `security` binary run
 * instead (CWE-426) — a real risk for a helper that receives a marketplace
 * session token as an argument (see the note on `store` below).
 *
 * NOTE: `security add-generic-password` has no stdin option for the
 * password itself (unlike `secret-tool` on Linux), so the value briefly
 * appears as an argv on this call only — a real but transient tradeoff of
 * avoiding a native binary, and strictly better than a permanent plaintext
 * file on disk.
 */
export function createMacosCredentialHelper(
  exec: ExecFn = runWithStdin,
  options: { fileExists?: (path: string) => Promise<boolean> } = {}
): CredentialHelper {
  const fileExists = options.fileExists ?? defaultFileExists

  return {
    name: "macos",
    async isAvailable() {
      return fileExists(SECURITY_PATH)
    },
    async store(key, value) {
      const result = await exec(SECURITY_PATH, [
        "add-generic-password",
        "-a",
        key,
        "-s",
        SERVICE,
        "-w",
        value,
        "-U",
      ])
      if (result.code !== 0) {
        throw new Error(
          `macOS Keychain store failed: ${result.stderr.trim() || `exit ${result.code}`}`
        )
      }
    },
    async retrieve(key) {
      const result = await exec(SECURITY_PATH, [
        "find-generic-password",
        "-a",
        key,
        "-s",
        SERVICE,
        "-w",
      ])
      if (result.code !== 0) return undefined
      return result.stdout.trim()
    },
    async erase(key) {
      const result = await exec(SECURITY_PATH, [
        "delete-generic-password",
        "-a",
        key,
        "-s",
        SERVICE,
      ])
      // A missing key exits non-zero; erasing an already-absent entry is a no-op, not an error.
      if (result.code !== 0 && !/could not be found/i.test(result.stderr)) {
        throw new Error(
          `macOS Keychain erase failed: ${result.stderr.trim() || `exit ${result.code}`}`
        )
      }
    },
  }
}
