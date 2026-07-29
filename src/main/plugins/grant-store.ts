import * as path from "node:path"
import { getCapability } from "@synapse/plugin-manifest"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

// Persisted record of which capabilities the user has granted to which plugin.
// A grant is keyed by a COMPOSITE identity, not just the plugin id: if the
// publisher changes, the signing key rotates, or the declared-capability set
// changes (declaration hash), the grant no longer matches and the capability is
// treated as ungranted — a changed/updated plugin cannot inherit prior trust.

export interface GrantIdentity {
  pluginId: string
  /** From the signed package; "unsigned" until plugin signing lands. */
  publisherId: string
  /** From the signed package; "local:<sourceKind>" until signing lands. */
  signingKeyFingerprint: string
  /** Hash over the plugin's declared-capability set. */
  capabilityDeclarationHash: string
}

export interface GrantRecord {
  capabilityId: string
  grantedAt: number
  grantedBy: "install" | "user" | "migration"
  /** Reserved; never trusted as a restriction (see spec §"Scope honesty"). */
  grantScope?: unknown
  identity: GrantIdentity
  /** When true, external-mcp callers skip the per-call elevated approve() for
   *  this (identity, capabilityId) pair — except reversible:false calls,
   *  which always prompt (see capability-gate.ts). Settable only through
   *  GrantStore.setExternalMcpPreauthorized, never auto-set. */
  externalMcpPreauthorized?: boolean
}

export interface RevocationTombstone {
  capabilityId: string
  revokedAt: number
  revokedBy: "user" | "system"
  identity: GrantIdentity
}

interface GrantState {
  grants: GrantRecord[]
  tombstones: RevocationTombstone[]
}

export function grantStoreFilePath(userDataDir: string): string {
  return path.join(userDataDir, "plugins", "capability-grants.json")
}

export function sameIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.publisherId === b.publisherId &&
    a.signingKeyFingerprint === b.signingKeyFingerprint &&
    a.capabilityDeclarationHash === b.capabilityDeclarationHash
  )
}

// Coarser than sameIdentity: ignores the capability-declaration hash so a user's
// revoke survives a same-publisher plugin update (which rotates the hash).
function sameCoarseIdentity(a: GrantIdentity, b: GrantIdentity): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.publisherId === b.publisherId &&
    a.signingKeyFingerprint === b.signingKeyFingerprint
  )
}

// Old on-disk records used `capability`/`scope`. Map them onto the new field
// names; tolerate records that are already new-shaped.
function migrateRecord(rec: Record<string, unknown>): GrantRecord {
  const { capability, scope, capabilityId, grantScope, ...rest } = rec
  return {
    ...(rest as Omit<GrantRecord, "capabilityId" | "grantScope">),
    capabilityId: (capabilityId ?? capability) as string,
    grantScope: grantScope ?? scope,
  }
}

// Migrate an on-disk array defensively: drop any element that is not a plain
// object (null, primitives) so one corrupt row can't make the store unreadable
// or yield garbage records.
function migrateRecords(raw: unknown[]): GrantRecord[] {
  return raw
    .filter((el): el is Record<string, unknown> => el !== null && typeof el === "object")
    .map(migrateRecord)
}

export class GrantStore {
  private state: GrantState | null = null
  private exclusive: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  async isExternalMcpPreauthorized(
    identity: GrantIdentity,
    capabilityId: string
  ): Promise<boolean> {
    const state = await this.load()
    const record = state.grants.find(
      (r) => r.capabilityId === capabilityId && sameIdentity(r.identity, identity)
    )
    return record?.externalMcpPreauthorized === true
  }

  /** Can only be set on a capability that is already granted — this flag
   *  augments an existing grant, it does not itself grant the base
   *  capability. Throws if there is no matching grant. */
  async setExternalMcpPreauthorized(
    identity: GrantIdentity,
    capabilityId: string,
    value: boolean
  ): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.load()
      const record = state.grants.find(
        (r) => r.capabilityId === capabilityId && sameIdentity(r.identity, identity)
      )
      if (!record) {
        throw new Error(
          `Cannot set externalMcpPreauthorized: "${capabilityId}" is not granted for this identity`
        )
      }
      record.externalMcpPreauthorized = value
      await this.persist(state)
    })
  }

  async isGranted(
    identity: GrantIdentity,
    capabilityId: string,
    requestedScope?: unknown
  ): Promise<boolean> {
    const state = await this.load()
    const record = state.grants.find(
      (r) => r.capabilityId === capabilityId && sameIdentity(r.identity, identity)
    )
    if (!record) return false
    const adapter = getCapability(capabilityId)?.scopeAdapter
    if (!adapter) return requestedScope === undefined
    return requestedScope === undefined ? true : adapter.contains(record.grantScope, requestedScope)
  }

  async grant(
    identity: GrantIdentity,
    capabilityId: string,
    grantedBy: GrantRecord["grantedBy"],
    grantScope?: unknown
  ): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.load()
      state.grants = state.grants.filter(
        (r) => !(r.capabilityId === capabilityId && sameCoarseIdentity(r.identity, identity))
      )
      state.tombstones = state.tombstones.filter(
        (t) => !(t.capabilityId === capabilityId && sameIdentity(t.identity, identity))
      )
      state.grants.push({
        capabilityId,
        grantedAt: this.now(),
        grantedBy,
        grantScope,
        identity,
      })
      await this.persist(state)
    })
  }

  async revoke(
    identity: GrantIdentity,
    capabilityId: string,
    revokedBy: RevocationTombstone["revokedBy"]
  ): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.load()
      state.grants = state.grants.filter(
        (r) => !(r.capabilityId === capabilityId && sameIdentity(r.identity, identity))
      )
      state.tombstones = state.tombstones.filter(
        (t) => !(t.capabilityId === capabilityId && sameIdentity(t.identity, identity))
      )
      state.tombstones.push({ capabilityId, revokedAt: this.now(), revokedBy, identity })
      await this.persist(state)
    })
  }

  /**
   * Removes every grant and tombstone for this pluginId, across every
   * identity (publisher, signing key, declaration hash) that has ever been
   * recorded for it — not just the identity of whichever manifest is
   * currently installed. Used on full uninstall: `revoke()`/`grant()` only
   * ever touch ONE identity at a time, so a plugin that was granted
   * capabilities under an older declaration hash (a previous version, or a
   * dev-linked build) would otherwise keep those grants live forever —
   * reinstalling (or downgrading to) that old version would silently
   * restore them with no re-consent.
   */
  async purgeAllForPluginId(pluginId: string): Promise<void> {
    return this.runExclusive(async () => {
      const state = await this.load()
      state.grants = state.grants.filter((r) => r.identity.pluginId !== pluginId)
      state.tombstones = state.tombstones.filter((t) => t.identity.pluginId !== pluginId)
      await this.persist(state)
    })
  }

  /**
   * Install-time auto grant, blocked by a COARSE-identity tombstone so a user's
   * revoke survives a same-publisher plugin update (declaration-hash change).
   */
  async grantAutoIfAllowed(identity: GrantIdentity, capabilityId: string): Promise<void> {
    const state = await this.load()
    const blocked = state.tombstones.some(
      (t) => t.capabilityId === capabilityId && sameCoarseIdentity(t.identity, identity)
    )
    if (blocked) return
    await this.grant(identity, capabilityId, "install")
  }

  /**
   * Currently-valid grants under this exact identity. Records invalidated by a
   * publisher / signing-key / declaration-hash change are excluded so callers
   * (UI, IPC, migration) never present a stale grant as active.
   */
  async list(identity: GrantIdentity): Promise<GrantRecord[]> {
    const state = await this.load()
    return state.grants.filter((r) => sameIdentity(r.identity, identity))
  }

  private async load(): Promise<GrantState> {
    if (!this.state) {
      const raw = await readJsonFile(this.filePath)
      if (Array.isArray(raw)) {
        // Legacy bare-array shape: migrate to { grants, tombstones }.
        this.state = { grants: migrateRecords(raw), tombstones: [] }
      } else if (raw && typeof raw === "object") {
        const obj = raw as Partial<GrantState>
        this.state = {
          grants: Array.isArray(obj.grants) ? migrateRecords(obj.grants) : [],
          tombstones: Array.isArray(obj.tombstones) ? obj.tombstones : [],
        }
      } else {
        this.state = { grants: [], tombstones: [] }
      }
    }
    return this.state
  }

  private async persist(state: GrantState): Promise<void> {
    this.state = state
    await writeJsonFile(this.filePath, state)
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusive.then(fn)
    this.exclusive = run.then(
      () => {},
      () => {}
    )
    return run
  }
}
