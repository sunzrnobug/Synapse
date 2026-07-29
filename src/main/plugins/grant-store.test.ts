import type { GrantIdentity } from "./grant-store"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GrantStore } from "./grant-store"

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-grants-"))
  file = path.join(dir, "grants.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function identity(overrides: Partial<GrantIdentity> = {}): GrantIdentity {
  return {
    pluginId: "com.example.hello",
    publisherId: "unsigned",
    signingKeyFingerprint: "local:user",
    capabilityDeclarationHash: "abc123",
    ...overrides,
  }
}

describe("grantStore", () => {
  it("grants and reports a capability as granted", async () => {
    const store = new GrantStore(file, () => 1000)
    await store.grant(identity(), "clipboard:read", "user")
    expect(await store.isGranted(identity(), "clipboard:read")).toBe(true)
    expect(await store.isGranted(identity(), "clipboard:write")).toBe(false)
  })

  it("revokes a capability", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:read", "install")
    await store.revoke(identity(), "clipboard:read", "user")
    expect(await store.isGranted(identity(), "clipboard:read")).toBe(false)
  })

  it("persists across a fresh store on the same file", async () => {
    await new GrantStore(file).grant(identity(), "clipboard:read", "user")
    expect(await new GrantStore(file).isGranted(identity(), "clipboard:read")).toBe(true)
  })

  it("purgeAllForPluginId removes every grant for that pluginId across every identity (old and new declaration hashes)", async () => {
    const store = new GrantStore(file)
    const oldIdentity = identity({ capabilityDeclarationHash: "old-hash" })
    const newIdentity = identity({ capabilityDeclarationHash: "new-hash" })
    await store.grant(oldIdentity, "clipboard:read", "user")
    await store.grant(newIdentity, "storage:plugin", "user")

    await store.purgeAllForPluginId(oldIdentity.pluginId)

    expect(await store.isGranted(oldIdentity, "clipboard:read")).toBe(false)
    expect(await store.isGranted(newIdentity, "storage:plugin")).toBe(false)
  })

  it("purgeAllForPluginId also clears tombstones, so a reinstall isn't blocked by a stale revoke", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:read", "user")
    await store.revoke(identity(), "clipboard:read", "user")

    await store.purgeAllForPluginId(identity().pluginId)

    // If the tombstone survived the purge, grantAutoIfAllowed would still be
    // coarse-blocked and this would remain false.
    await store.grantAutoIfAllowed(identity(), "clipboard:read")
    expect(await store.isGranted(identity(), "clipboard:read")).toBe(true)
  })

  it("purgeAllForPluginId does not affect grants for a different pluginId", async () => {
    const store = new GrantStore(file)
    const other = identity({ pluginId: "com.example.other" })
    await store.grant(identity(), "clipboard:read", "user")
    await store.grant(other, "clipboard:read", "user")

    await store.purgeAllForPluginId(identity().pluginId)

    expect(await store.isGranted(identity(), "clipboard:read")).toBe(false)
    expect(await store.isGranted(other, "clipboard:read")).toBe(true)
  })

  it("lists a plugin's grants with grantedBy recorded", async () => {
    const store = new GrantStore(file, () => 42)
    await store.grant(identity(), "clipboard:read", "install")
    const records = await store.list(identity())
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      capabilityId: "clipboard:read",
      grantedBy: "install",
      grantedAt: 42,
    })
  })

  it("excludes grants invalidated by an identity change from list()", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:read", "user")
    expect(await store.list(identity())).toHaveLength(1)
    expect(await store.list(identity({ capabilityDeclarationHash: "changed" }))).toHaveLength(0)
  })

  it("invalidates a grant when the declaration hash changes", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:read", "user")
    expect(
      await store.isGranted(identity({ capabilityDeclarationHash: "different" }), "clipboard:read")
    ).toBe(false)
  })

  it("invalidates a grant when publisher or signing key changes", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:read", "user")
    expect(await store.isGranted(identity({ publisherId: "evil" }), "clipboard:read")).toBe(false)
    expect(
      await store.isGranted(identity({ signingKeyFingerprint: "other" }), "clipboard:read")
    ).toBe(false)
  })

  it("revoke writes a tombstone keyed by identity + capabilityId", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    await store.revoke(identity(), "clipboard:watch", "user")
    expect(await store.isGranted(identity(), "clipboard:watch")).toBe(false)
  })

  it("a fresh user grant supersedes a prior tombstone", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    await store.revoke(identity(), "clipboard:watch", "user")
    await store.grant(identity(), "clipboard:watch", "user")
    expect(await store.isGranted(identity(), "clipboard:watch")).toBe(true)
  })

  it("grantAutoIfAllowed is blocked by an exact-identity tombstone", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    await store.revoke(identity(), "clipboard:watch", "user")
    await store.grantAutoIfAllowed(identity(), "clipboard:watch")
    expect(await store.isGranted(identity(), "clipboard:watch")).toBe(false)
  })

  it("auto tombstone blocks re-grant even after the declaration hash changes (same publisher)", async () => {
    const store = new GrantStore(file)
    await store.grant(identity({ capabilityDeclarationHash: "h1" }), "clipboard:watch", "user")
    await store.revoke(identity({ capabilityDeclarationHash: "h1" }), "clipboard:watch", "user")
    await store.grantAutoIfAllowed(identity({ capabilityDeclarationHash: "h2" }), "clipboard:watch")
    expect(
      await store.isGranted(identity({ capabilityDeclarationHash: "h2" }), "clipboard:watch")
    ).toBe(false)
  })

  it("migrates an old bare-array grants file (capability -> capabilityId)", async () => {
    const fs = await import("node:fs/promises")
    await fs.writeFile(
      file,
      JSON.stringify([
        { capability: "notification", grantedAt: 1, grantedBy: "install", identity: identity() },
      ])
    )
    const store = new GrantStore(file)
    expect(await store.isGranted(identity(), "notification")).toBe(true)
  })

  it("serializes concurrent persists without losing grants", async () => {
    const store = new GrantStore(file)
    const id = identity()
    await Promise.all([
      store.grant(id, "clipboard:read", "user"),
      store.grant(id, "clipboard:write", "user"),
      store.grant(id, "storage:plugin", "install"),
      store.grant(id, "notification", "install"),
    ])
    const fresh = new GrantStore(file)
    expect(await fresh.isGranted(id, "clipboard:read")).toBe(true)
    expect(await fresh.isGranted(id, "clipboard:write")).toBe(true)
    expect(await fresh.isGranted(id, "storage:plugin")).toBe(true)
    expect(await fresh.isGranted(id, "notification")).toBe(true)
  })

  it("is not externally preauthorized by default", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    expect(await store.isExternalMcpPreauthorized(identity(), "clipboard:watch")).toBe(false)
  })

  it("sets and reports externalMcpPreauthorized on an existing grant", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    await store.setExternalMcpPreauthorized(identity(), "clipboard:watch", true)
    expect(await store.isExternalMcpPreauthorized(identity(), "clipboard:watch")).toBe(true)
  })

  it("can unset externalMcpPreauthorized", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    await store.setExternalMcpPreauthorized(identity(), "clipboard:watch", true)
    await store.setExternalMcpPreauthorized(identity(), "clipboard:watch", false)
    expect(await store.isExternalMcpPreauthorized(identity(), "clipboard:watch")).toBe(false)
  })

  it("refuses to preauthorize a capability that isn't granted", async () => {
    const store = new GrantStore(file)
    await expect(
      store.setExternalMcpPreauthorized(identity(), "clipboard:watch", true)
    ).rejects.toThrow(/not granted/)
  })

  it("clears externalMcpPreauthorized when the identity's declaration hash rotates", async () => {
    const store = new GrantStore(file)
    await store.grant(identity(), "clipboard:watch", "user")
    await store.setExternalMcpPreauthorized(identity(), "clipboard:watch", true)
    const rotated = identity({ capabilityDeclarationHash: "rotated" })
    expect(await store.isExternalMcpPreauthorized(rotated, "clipboard:watch")).toBe(false)
  })

  it("skips malformed rows in a legacy array without throwing", async () => {
    const fs = await import("node:fs/promises")
    await fs.writeFile(
      file,
      JSON.stringify([
        null,
        42,
        { capability: "notification", grantedAt: 1, grantedBy: "install", identity: identity() },
      ])
    )
    const store = new GrantStore(file)
    expect(await store.isGranted(identity(), "notification")).toBe(true)
    expect(await store.list(identity())).toHaveLength(1)
  })
})
