import type { Visibility } from "@synapsepkg/marketplace-types"
import type { PluginManifest } from "@synapsepkg/plugin-manifest"
import type { CredentialStore } from "./credentials-store"
import type { MarketplaceClient } from "./marketplace-client"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import process from "node:process"
import { MarketplaceApiError } from "./marketplace-client"

/** Side-effecting capabilities the commands need, injected for testability. */
export interface CommandIo {
  log: (message: string) => void
  openBrowser: (url: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export interface AccountDeps {
  client: MarketplaceClient
  store: CredentialStore
  baseUrl: string
  io: CommandIo
  /** A token supplied directly for this invocation (e.g. `--token-stdin`).
   *  Takes priority over SYNAPSE_TOKEN and the persisted store — neither is
   *  even consulted when this is set. */
  token?: string
}

/**
 * Token resolution order for a single command invocation: an explicitly
 * supplied token (e.g. `--token-stdin`) > the SYNAPSE_TOKEN env var (keeps
 * existing automation scripts working) > the persisted credential store.
 * Only the last of these round-trips through a system credential helper.
 */
async function resolveToken(deps: AccountDeps): Promise<string | undefined> {
  if (deps.token) return deps.token
  if (process.env.SYNAPSE_TOKEN) return process.env.SYNAPSE_TOKEN
  return deps.store.get(deps.baseUrl)
}

/** Build a plugin into a `.syn` package — injected so publish stays unit-testable. */
export type BuildFn = (
  projectDir: string
) => Promise<{ manifest: PluginManifest; packagePath: string }>

class NotLoggedInError extends Error {
  constructor() {
    super("Not logged in. Run `synapse-plugin login` first.")
    this.name = "NotLoggedInError"
  }
}

/** Device-authorization login: open the browser, poll until authorized. */
export async function runLogin(deps: AccountDeps): Promise<void> {
  const { client, store, baseUrl, io } = deps
  const grant = await client.deviceStart()

  io.log("To sign in, authorize in your browser:")
  io.log(`  ${grant.verificationUri}`)
  io.log(`  (verification code: ${grant.userCode})`)
  await io.openBrowser(grant.verificationUri)

  const expiresAt = Date.parse(grant.expiresAt)
  while (io.now() < expiresAt) {
    await io.sleep(grant.interval * 1000)
    let poll
    try {
      poll = await client.devicePoll(grant.deviceCode)
    } catch (err) {
      if (err instanceof MarketplaceApiError && err.status === 410) {
        throw new Error("Login expired before it was authorized. Run `synapse-plugin login` again.")
      }
      throw err
    }
    if (poll.status === "authorized") {
      await store.set(baseUrl, poll.accessToken)
      io.log(`Logged in as ${poll.user.handle}.`)
      return
    }
  }
  throw new Error("Login timed out. Run `synapse-plugin login` again.")
}

/** Print the authenticated user. */
export async function runWhoami(deps: AccountDeps): Promise<void> {
  const { client, io } = deps
  const token = await resolveToken(deps)
  if (!token) throw new NotLoggedInError()
  try {
    const { user } = await client.session(token)
    io.log(`${user.handle} (${user.role})`)
  } catch (err) {
    if (err instanceof MarketplaceApiError && err.status === 401) {
      throw new Error("Session expired. Run `synapse-plugin login` again.")
    }
    throw err
  }
}

/** Forget the stored token for this server. */
export async function runLogout(deps: AccountDeps): Promise<void> {
  await deps.store.clear(deps.baseUrl)
  deps.io.log("Logged out.")
}

export interface PublishDeps extends AccountDeps {
  projectDir: string
  visibility: Visibility
  build: BuildFn
}

/** Build the plugin and publish it to the marketplace. */
export async function runPublish(deps: PublishDeps): Promise<void> {
  const { client, io, projectDir, visibility, build } = deps
  const token = await resolveToken(deps)
  if (!token) throw new NotLoggedInError()

  const built = await build(projectDir)
  const bytes = await fs.readFile(built.packagePath)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const filename = built.packagePath.split(/[/\\]/).pop() ?? "plugin.syn"

  const result = await client.publish(
    token,
    { visibility, sha256, sizeBytes: bytes.byteLength, manifest: built.manifest },
    Buffer.from(bytes),
    filename
  )
  io.log(`Published ${result.plugin.id}@${result.version.version} (${visibility}).`)
}
