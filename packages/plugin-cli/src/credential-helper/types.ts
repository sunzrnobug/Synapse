/**
 * A thin wrapper around whatever secret store the current OS already ships
 * with (macOS Keychain, Windows DPAPI, Linux Secret Service) — no compiled
 * native Node addon, no bundled binary. `key` is a non-secret, deterministic
 * identifier (e.g. `synapse-cli:https://marketplace.example.com`); `value`
 * is the actual secret and is always passed via stdin to the shelled-out
 * tool, never as an argv/env value, so it never appears in a process list.
 */
export interface CredentialHelper {
  readonly name: "macos" | "windows" | "linux"
  /** Whether the underlying OS tool this helper shells out to is present. */
  isAvailable: () => Promise<boolean>
  store: (key: string, value: string) => Promise<void>
  /** Returns undefined if the key was never stored (not an error). */
  retrieve: (key: string) => Promise<string | undefined>
  /** A missing key is not an error — erasing an already-absent entry is a no-op. */
  erase: (key: string) => Promise<void>
}
