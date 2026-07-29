import type { CredentialHelper } from "./types"
import process from "node:process"
import { createLinuxCredentialHelper } from "./linux"
import { createMacosCredentialHelper } from "./macos"
import { createWindowsCredentialHelper } from "./windows"

export type { CredentialHelper } from "./types"

/** Picks the credential helper for the current OS. Returns undefined on an
 *  unrecognized platform — the caller must fail closed, never fall back to
 *  plaintext. */
export function resolveCredentialHelper(
  platform: string = process.platform
): CredentialHelper | undefined {
  switch (platform) {
    case "darwin":
      return createMacosCredentialHelper()
    case "win32":
      return createWindowsCredentialHelper()
    case "linux":
      return createLinuxCredentialHelper()
    default:
      return undefined
  }
}
