// @vitest-environment node
import type { CredentialHelper } from "./credential-helper/types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fileCredentialStore } from "./credentials-store"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "syn-cred-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function fakeHelper(available: boolean | (() => boolean) = true): CredentialHelper {
  const secrets = new Map<string, string>()
  return {
    name: "linux",
    async isAvailable() {
      return typeof available === "function" ? available() : available
    },
    async store(key: string, value: string) {
      secrets.set(key, value)
    },
    async retrieve(key: string) {
      return secrets.get(key)
    },
    async erase(key: string) {
      secrets.delete(key)
    },
  }
}

describe("fileCredentialStore", () => {
  it("stores, reads, and clears tokens per server via the credential helper", async () => {
    const helper = fakeHelper()
    const store = fileCredentialStore({ dir, helper })
    expect(await store.get("https://a.test")).toBeUndefined()

    await store.set("https://a.test", "token-a")
    await store.set("https://b.test", "token-b")
    expect(await store.get("https://a.test")).toBe("token-a")
    expect(await store.get("https://b.test")).toBe("token-b")

    await store.clear("https://a.test")
    expect(await store.get("https://a.test")).toBeUndefined()
    expect(await store.get("https://b.test")).toBe("token-b")
  })

  it("persists metadata across store instances (same dir) without re-storing the secret", async () => {
    const helper = fakeHelper()
    await fileCredentialStore({ dir, helper }).set("https://a.test", "token-a")
    // A fresh store instance, same backing helper (simulates a real OS
    // keychain that outlives the process) and same on-disk metadata.
    const reopened = fileCredentialStore({ dir, helper })
    expect(await reopened.get("https://a.test")).toBe("token-a")
  })

  it("never writes the token itself into the metadata file on disk", async () => {
    const helper = fakeHelper()
    const store = fileCredentialStore({ dir, helper })
    await store.set("https://a.test", "super-secret-token")
    const raw = await fs.readFile(path.join(dir, "config.json"), "utf-8")
    expect(raw).not.toContain("super-secret-token")
  })

  it("fails closed (throws) on set() when no credential helper is available — never falls back to plaintext", async () => {
    const helper = fakeHelper(false)
    const store = fileCredentialStore({ dir, helper })
    await expect(store.set("https://a.test", "token-a")).rejects.toThrow()
    // Confirm nothing was written at all, plaintext or otherwise.
    await expect(fs.access(path.join(dir, "config.json"))).rejects.toThrow()
  })

  it("get() returns undefined (not logged in) when no credential helper is available", async () => {
    const helper = fakeHelper(false)
    const store = fileCredentialStore({ dir, helper })
    expect(await store.get("https://a.test")).toBeUndefined()
  })

  it("clear() is a no-op for a server that was never stored", async () => {
    const helper = fakeHelper()
    const store = fileCredentialStore({ dir, helper })
    await expect(store.clear("https://never.test")).resolves.toBeUndefined()
  })

  it("clear() throws and keeps the metadata entry when the helper is unavailable, rather than silently orphaning the still-stored secret", async () => {
    let available = true
    const helper = fakeHelper(() => available)
    const store = fileCredentialStore({ dir, helper })
    await store.set("https://a.test", "token-a")

    available = false
    await expect(store.clear("https://a.test")).rejects.toThrow()

    // The metadata entry must still point at the (still-present, now
    // temporarily unreachable) secret — losing that mapping here would mean
    // no later `clear()` could ever erase it, even once the helper is back.
    available = true
    expect(await store.get("https://a.test")).toBe("token-a")
  })

  it("tolerates a missing or corrupt metadata file", async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "config.json"), "not json")
    const helper = fakeHelper()
    const store = fileCredentialStore({ dir, helper })
    expect(await store.get("https://a.test")).toBeUndefined()
  })

  it("never stores a secret for a brand-new login if writing the metadata fails first, so there's nothing to roll back at all", async () => {
    // Occupy config.json's path with a directory so fs.writeFile(configFile, ...)
    // deterministically fails with EISDIR, without needing OS-specific
    // permission/locking tricks.
    await fs.mkdir(path.join(dir, "config.json"))
    const helper = fakeHelper()
    const storeSpy = vi.spyOn(helper, "store")

    const store = fileCredentialStore({ dir, helper })
    await expect(store.set("https://a.test", "token-a")).rejects.toThrow()

    // The metadata write happens before the secret is ever stored, so a
    // config-write failure can never leave a stored-but-unreferenced
    // secret needing (possibly-failing) cleanup — it simply never gets
    // stored in the first place.
    expect(storeSpy).not.toHaveBeenCalled()
  })

  it("writes the metadata before storing the secret, proving a config-write failure can never orphan an already-stored credential", async () => {
    let configReferencedCredentialWhenStoreWasCalled = false
    const helper: CredentialHelper = {
      name: "linux",
      isAvailable: async () => true,
      store: async (key) => {
        const raw = await fs.readFile(path.join(dir, "config.json"), "utf-8").catch(() => "{}")
        const parsed = JSON.parse(raw) as { servers?: Record<string, { credentialId: string }> }
        configReferencedCredentialWhenStoreWasCalled = Object.values(parsed.servers ?? {}).some(
          (entry) => entry.credentialId === key
        )
      },
      retrieve: async () => undefined,
      erase: async () => {},
    }
    const store = fileCredentialStore({ dir, helper })

    await store.set("https://a.test", "token-a")

    expect(configReferencedCredentialWhenStoreWasCalled).toBe(true)
  })

  it("restores the previous credentialId mapping if store() fails during a repeat login, preserving access to the untouched old secret", async () => {
    const secrets = new Map<string, string>()
    let failNextStore = false
    const helper: CredentialHelper = {
      name: "linux",
      isAvailable: async () => true,
      store: async (key, value) => {
        if (failNextStore) throw new Error("keyring is locked")
        secrets.set(key, value)
      },
      retrieve: async (key) => secrets.get(key),
      erase: async (key) => void secrets.delete(key),
    }
    const store = fileCredentialStore({ dir, helper })
    await store.set("https://a.test", "old-token") // establish a working login first

    failNextStore = true
    await expect(store.set("https://a.test", "new-token")).rejects.toThrow()

    // The old, still-good credential must remain reachable — a failed
    // repeat login must not corrupt or lose access to it.
    expect(await store.get("https://a.test")).toBe("old-token")
  })

  it("does not lose access to a previous entry recorded under a different credentialId scheme when store() fails and the rollback write also fails", async () => {
    // Simulate an existing config entry using a credentialId scheme other
    // than what credentialIdFor() computes today (e.g. a historical scheme
    // change) — defensive: this can't happen with the current, unchanged
    // credentialIdFor(), but the store must not assume it never will.
    const configFile = path.join(dir, "config.json")
    const secrets = new Map<string, string>([["old-scheme:https://a.test", "old-token"]])
    let breakConfigWrites = false
    const helper: CredentialHelper = {
      name: "linux",
      isAvailable: async () => true,
      store: async (key, value) => {
        if (breakConfigWrites) {
          // The metadata write that follows this call must fail too — as
          // if the disk/permissions problem that broke the login attempt
          // affects both operations, not just the helper call.
          await fs.chmod(configFile, 0o444)
          throw new Error("keyring is locked")
        }
        secrets.set(key, value)
      },
      retrieve: async (key) => secrets.get(key),
      erase: async (key) => void secrets.delete(key),
    }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      configFile,
      JSON.stringify({
        servers: { "https://a.test": { credentialId: "old-scheme:https://a.test" } },
      })
    )

    const store = fileCredentialStore({ dir, helper })
    expect(await store.get("https://a.test")).toBe("old-token")

    breakConfigWrites = true
    try {
      await expect(store.set("https://a.test", "new-token")).rejects.toThrow()
    } finally {
      await fs.chmod(configFile, 0o666)
    }

    // The old, still-good credential — under its own, different id — must
    // remain reachable; the failed re-login must not have severed it.
    expect(await store.get("https://a.test")).toBe("old-token")
  })

  it("does not erase the credential on a repeat login when the metadata write fails, since the on-disk config still points at it", async () => {
    const helper = fakeHelper()
    const store = fileCredentialStore({ dir, helper })
    await store.set("https://a.test", "token-a") // first, successful login

    // Make config.json read-only so a second login's write fails (EPERM)
    // while the *read* that determines `hadExistingEntry` still succeeds —
    // the on-disk config genuinely still references this credentialId.
    // credentialIdFor() is deterministic, so store() below reuses that
    // exact same credentialId.
    const configFile = path.join(dir, "config.json")
    await fs.chmod(configFile, 0o444)
    const eraseSpy = vi.spyOn(helper, "erase")

    try {
      await expect(store.set("https://a.test", "token-a-2")).rejects.toThrow()
    } finally {
      await fs.chmod(configFile, 0o666)
    }

    // Erasing here would destroy a credential the (unchanged) on-disk
    // config still legitimately references — this must not happen just
    // because a repeat login's metadata write failed.
    expect(eraseSpy).not.toHaveBeenCalled()
  })

  describe("legacy plaintext migration", () => {
    async function writeLegacyCredentials(tokens: Record<string, string>): Promise<string> {
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, "credentials.json")
      await fs.writeFile(file, JSON.stringify({ tokens }, null, 2))
      return file
    }

    it("migrates an existing user's plaintext credentials.json into the helper-backed store", async () => {
      const legacyFile = await writeLegacyCredentials({ "https://a.test": "old-plaintext-token" })
      const helper = fakeHelper()

      const store = fileCredentialStore({ dir, helper })
      expect(await store.get("https://a.test")).toBe("old-plaintext-token")

      // The secret now lives behind the helper, not in the plaintext file.
      await expect(fs.access(legacyFile)).rejects.toThrow()
    })

    it("deletes the plaintext file even when nothing could be migrated (no helper available)", async () => {
      const legacyFile = await writeLegacyCredentials({ "https://a.test": "old-plaintext-token" })
      const helper = fakeHelper(false)

      const store = fileCredentialStore({ dir, helper })
      // Can't migrate without a helper, so the token is simply gone — but the
      // plaintext copy must not be left sitting on disk either way.
      expect(await store.get("https://a.test")).toBeUndefined()
      await expect(fs.access(legacyFile)).rejects.toThrow()
    })

    it("does not clobber a server already present in the new config", async () => {
      const helper = fakeHelper()
      await fileCredentialStore({ dir, helper }).set("https://a.test", "new-token")
      await writeLegacyCredentials({ "https://a.test": "stale-plaintext-token" })

      const store = fileCredentialStore({ dir, helper })
      expect(await store.get("https://a.test")).toBe("new-token")
    })

    it("is a no-op when there is no legacy file", async () => {
      const helper = fakeHelper()
      const store = fileCredentialStore({ dir, helper })
      await expect(store.get("https://a.test")).resolves.toBeUndefined()
      await expect(fs.access(path.join(dir, "credentials.json"))).rejects.toThrow()
    })

    it("deletes the plaintext file even when the helper throws migrating one entry (e.g. a locked keyring)", async () => {
      const legacyFile = await writeLegacyCredentials({
        "https://a.test": "old-plaintext-token-a",
        "https://b.test": "old-plaintext-token-b",
      })
      const secrets = new Map<string, string>()
      const helper: CredentialHelper = {
        name: "linux",
        isAvailable: async () => true,
        store: async (key, value) => {
          if (key.includes("a.test")) throw new Error("keyring is locked")
          secrets.set(key, value)
        },
        retrieve: async (key) => secrets.get(key),
        erase: async (key) => void secrets.delete(key),
      }

      const store = fileCredentialStore({ dir, helper })
      // The failed entry simply isn't migrated (the user re-logs-in for that
      // server) — but the plaintext file must be gone either way, and the
      // store must remain fully usable afterward, not permanently wedged.
      expect(await store.get("https://a.test")).toBeUndefined()
      expect(await store.get("https://b.test")).toBe("old-plaintext-token-b")
      await expect(fs.access(legacyFile)).rejects.toThrow()
      await expect(store.set("https://c.test", "token-c")).resolves.toBeUndefined()
    })

    it("deletes the plaintext file even when it contains corrupt JSON", async () => {
      await fs.mkdir(dir, { recursive: true })
      const legacyFile = path.join(dir, "credentials.json")
      await fs.writeFile(legacyFile, "{ not valid json, has-a-token: abc123")
      const helper = fakeHelper()

      const store = fileCredentialStore({ dir, helper })
      await expect(store.get("https://a.test")).resolves.toBeUndefined()
      await expect(fs.access(legacyFile)).rejects.toThrow()
      // The store must remain usable, not permanently wedged by the bad file.
      await expect(store.set("https://a.test", "token-a")).resolves.toBeUndefined()
    })

    it("rolls back migrated credentials if writing the metadata fails during migration", async () => {
      await writeLegacyCredentials({ "https://a.test": "old-plaintext-token" })
      // Occupy config.json's path with a directory so writeConfig()
      // deterministically fails during the migration attempt.
      await fs.mkdir(path.join(dir, "config.json"))
      const helper = fakeHelper()
      const eraseSpy = vi.spyOn(helper, "erase")

      const store = fileCredentialStore({ dir, helper })
      await store.get("https://a.test")

      expect(eraseSpy).toHaveBeenCalledWith("synapse-cli:https://a.test")
    })

    it("keeps the legacy plaintext file when writing the migrated config fails, so a later attempt can retry", async () => {
      const legacyFile = await writeLegacyCredentials({ "https://a.test": "old-plaintext-token" })
      // Occupy config.json's path with a directory so writeConfig()
      // deterministically fails during the migration attempt.
      await fs.mkdir(path.join(dir, "config.json"))
      const helper = fakeHelper()

      const store = fileCredentialStore({ dir, helper })
      await store.get("https://a.test")

      // This migration attempt didn't complete — deleting the plaintext
      // file now would destroy the only remaining copy of a token that
      // ended up nowhere (not in the on-disk config, and rolled back out
      // of the helper). Keep it so a later attempt (e.g. once whatever
      // caused the write failure clears) can retry from scratch.
      await expect(fs.access(legacyFile)).resolves.toBeUndefined()
    })

    it("retries the failed migration attempt itself (not just file deletion) on a later access within the same store instance", async () => {
      const legacyFile = await writeLegacyCredentials({ "https://a.test": "old-plaintext-token" })
      const configFile = path.join(dir, "config.json")
      await fs.mkdir(configFile) // block writeConfig for the first attempt
      const helper = fakeHelper()

      const store = fileCredentialStore({ dir, helper })
      // First attempt: migration can't persist, nothing migrated yet.
      expect(await store.get("https://a.test")).toBeUndefined()

      // Clear the obstruction — a later access on the SAME store instance
      // must retry the whole migration attempt, not just the file
      // deletion step, or this token can never be recovered without
      // restarting the process.
      await fs.rm(configFile, { recursive: true, force: true })
      expect(await store.get("https://a.test")).toBe("old-plaintext-token")
      await expect(fs.access(legacyFile)).rejects.toThrow()
    })

    it("does eventually delete the legacy file once a later attempt succeeds after an earlier migration-write failure", async () => {
      const legacyFile = await writeLegacyCredentials({ "https://a.test": "old-plaintext-token" })
      await fs.mkdir(path.join(dir, "config.json"))
      const helper = fakeHelper()

      const store = fileCredentialStore({ dir, helper })
      await store.get("https://a.test") // first attempt: writeConfig fails, file kept

      // Clear the obstruction and retry with a fresh store instance (a new
      // `synapse-plugin` process would get a fresh migration attempt too).
      await fs.rm(path.join(dir, "config.json"), { recursive: true, force: true })
      const retryStore = fileCredentialStore({ dir, helper })
      expect(await retryStore.get("https://a.test")).toBe("old-plaintext-token")

      await expect(fs.access(legacyFile)).rejects.toThrow()
    })

    it("keeps retrying legacy-file deletion on later access when an earlier attempt failed, instead of silently accepting it as permanent", async () => {
      const legacyFile = await writeLegacyCredentials({ "https://a.test": "old-plaintext-token" })
      const helper = fakeHelper()
      let attempts = 0
      const deleteLegacyFile = vi.fn(async (filePath: string) => {
        attempts += 1
        if (attempts === 1) {
          const err = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException
          err.code = "EBUSY"
          throw err
        }
        await fs.rm(filePath)
      })

      const store = fileCredentialStore({ dir, helper, deleteLegacyFile })
      await store.get("https://a.test")
      // First deletion attempt failed — the file must still be there, not
      // silently treated as cleaned up.
      await expect(fs.access(legacyFile)).resolves.toBeUndefined()

      await store.get("https://a.test")
      // Second attempt (same store instance) succeeds.
      await expect(fs.access(legacyFile)).rejects.toThrow()
      expect(deleteLegacyFile).toHaveBeenCalledTimes(2)
    })
  })
})
