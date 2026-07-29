#!/usr/bin/env node
import type { AccountDeps, CommandIo } from "./account-commands"
import type { BuildResult } from "./build"
import { Buffer } from "node:buffer"
import * as path from "node:path"
import process from "node:process"
import { ManifestValidationError } from "@synapsepkg/plugin-manifest"
import open from "open"
import { runLogin, runLogout, runPublish, runWhoami } from "./account-commands"
import { buildPlugin, PluginBuildError } from "./build"
import { fileCredentialStore } from "./credentials-store"
import { watchPlugin } from "./dev"
import { linkDevPlugin, unlinkDevPlugin } from "./dev-links"
import { readManifest } from "./manifest-io"
import { createMarketplaceClient, MarketplaceApiError } from "./marketplace-client"

const DEFAULT_SERVER = "http://localhost:8787"

interface ParsedArgs {
  command: string | undefined
  positional: string[]
  flags: Map<string, string | boolean>
}

const USAGE = `synapse-plugin — build and develop Synapse plugins

Usage:
  synapse-plugin build    [dir] [--entry src/index.ts] [--out <dir>] [--minify]
  synapse-plugin validate [dir]
  synapse-plugin dev      [dir] [--entry src/index.ts] [--data-dir <dir>] [--no-link]
  synapse-plugin link     [dir] [--data-dir <dir>]
  synapse-plugin unlink   [dir] [--data-dir <dir>]
  synapse-plugin login    [--server <url>]
  synapse-plugin logout   [--server <url>]
  synapse-plugin whoami   [--server <url>] [--token-stdin]
  synapse-plugin publish  [dir] [--public] [--server <url>] [--token-stdin]

Commands:
  build      Bundle the plugin and write an installable <id>-<version>.syn
  validate   Structurally validate synapse.json
  dev        Watch + rebuild and register the project for Synapse dev loading
  link       Register the project in Synapse's dev-plugins.json
  unlink     Remove the project from Synapse's dev-plugins.json
  login      Sign in to the marketplace (GitHub, via the browser)
  logout     Forget the stored marketplace token
  whoami     Show the signed-in marketplace account
  publish    Build and publish the plugin (private by default; --public to list)

Environment:
  SYNAPSE_MARKETPLACE_URL   Marketplace server URL (default ${DEFAULT_SERVER})
  SYNAPSE_TOKEN             Marketplace session token, used instead of persistent login
  SYNAPSE_SECRET_TOOL_PATH  Linux only: explicit path to secret-tool, if not at a standard location

Token resolution order for whoami/publish: --token-stdin > SYNAPSE_TOKEN > the
persisted login from \`synapse-plugin login\` (stored via a system credential
helper — macOS Keychain, Windows DPAPI, or Linux Secret Service; persistent
login isn't available where none of these is present).
`

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)

  if (!args.command || args.flags.has("help") || args.flags.has("h")) {
    process.stdout.write(USAGE)
    return
  }

  const projectDir = path.resolve(str(args.flags.get("cwd")) ?? args.positional[0] ?? process.cwd())
  const dataDir = str(args.flags.get("data-dir"))

  switch (args.command) {
    case "build":
      await runBuild(projectDir, args)
      return
    case "validate":
      await runValidate(projectDir)
      return
    case "dev":
      await runDev(projectDir, dataDir, args)
      return
    case "link": {
      const linked = await linkDevPlugin(projectDir, { dataDir })
      info(`Linked dev plugin: ${linked}`)
      info(`Reload plugins in Synapse to pick it up.`)
      return
    }
    case "unlink": {
      const unlinked = await unlinkDevPlugin(projectDir, { dataDir })
      info(`Unlinked dev plugin: ${unlinked}`)
      return
    }
    case "login":
      await runLogin(await accountDeps(args))
      return
    case "logout":
      await runLogout(await accountDeps(args))
      return
    case "whoami":
      await runWhoami(await accountDeps(args))
      return
    case "publish":
      await runPublish({
        ...(await accountDeps(args)),
        projectDir,
        visibility: args.flags.get("public") ? "public" : "private",
        build: cliBuild,
      })
      return
    default:
      fail(`Unknown command: ${args.command}\n\n${USAGE}`)
  }
}

function resolveBaseUrl(args: ParsedArgs): string {
  return str(args.flags.get("server")) ?? process.env.SYNAPSE_MARKETPLACE_URL ?? DEFAULT_SERVER
}

async function accountDeps(args: ParsedArgs): Promise<AccountDeps> {
  const baseUrl = resolveBaseUrl(args)
  return {
    client: createMarketplaceClient({ baseUrl }),
    store: fileCredentialStore(),
    baseUrl,
    io: realIo(),
    token: args.flags.get("token-stdin") ? (await readStdin()).trim() : undefined,
  }
}

/** Reads all of stdin as UTF-8 — used for `--token-stdin` so a token never
 *  needs to appear as a command argument or in shell history. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf-8")
}

function realIo(): CommandIo {
  return {
    log: info,
    openBrowser: async (url) => openBrowser(url),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
}

/** Opens a url in the OS default browser via the cross-platform `open`
 *  package, never through a shell. The previous implementation shelled out
 *  to `cmd /c start "" <url>` on Windows, and `cmd.exe`'s `start` builtin
 *  re-parses `&`/`|` in its argument as its own command separators — a
 *  command-injection path for a url that ultimately comes from the
 *  marketplace's `verificationUri` response (schema-validated, but this is
 *  the second, structural layer of defense: no shell in the loop at all). */
export async function openBrowser(url: string): Promise<void> {
  try {
    await open(url)
  } catch {
    // best-effort; the user can open the URL manually
  }
}

async function cliBuild(
  projectDir: string
): Promise<{ manifest: BuildResult["manifest"]; packagePath: string }> {
  const result = await buildPlugin({ projectDir })
  return { manifest: result.manifest, packagePath: result.packagePath }
}

async function runBuild(projectDir: string, args: ParsedArgs): Promise<void> {
  const result = await buildPlugin({
    projectDir,
    entry: str(args.flags.get("entry")),
    outDir: str(args.flags.get("out")),
    minify: Boolean(args.flags.get("minify")),
  })
  info(`Built ${result.manifest.id}@${result.manifest.version}`)
  info(`  bundle:  ${path.relative(process.cwd(), result.outFile)}`)
  info(`  package: ${path.relative(process.cwd(), result.packagePath)}`)
  info(`  files:   ${result.files.map((f) => f.archivePath).join(", ")}`)
}

async function runValidate(projectDir: string): Promise<void> {
  const { manifest } = await readManifest(projectDir)
  info(`synapse.json is valid: ${manifest.id}@${manifest.version}`)
  info(`  commands: ${manifest.contributes.commands.map((c) => c.id).join(", ")}`)
  const tools = manifest.contributes.tools ?? []
  if (tools.length > 0) {
    info(`  tools:    ${tools.map((t) => `${manifest.id}/${t.name}`).join(", ")}`)
  }
}

async function runDev(
  projectDir: string,
  dataDir: string | undefined,
  args: ParsedArgs
): Promise<void> {
  const { manifest } = await readManifest(projectDir)

  if (!args.flags.get("no-link")) {
    const linked = await linkDevPlugin(projectDir, { dataDir })
    info(`Linked dev plugin: ${linked}`)
  }

  const outRel = path.relative(process.cwd(), path.resolve(projectDir, manifest.main))
  const watcher = await watchPlugin({
    projectDir,
    entry: str(args.flags.get("entry")),
    onRebuild(errors) {
      if (errors.length > 0) {
        process.stderr.write(`[synapse-plugin] rebuild failed:\n  ${errors.join("\n  ")}\n`)
      } else {
        info(`rebuilt ${manifest.id} → ${outRel}`)
      }
    },
  })
  info(`Watching ${manifest.id}. Reload plugins in Synapse after edits. Ctrl+C to stop.`)

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void watcher.dispose().finally(resolve)
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
  })
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string
    if (token.startsWith("--")) {
      const body = token.slice(2)
      const eq = body.indexOf("=")
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1))
      } else if (body.startsWith("no-")) {
        flags.set(body, true)
      } else {
        const next = rest[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(body, next)
          i++
        } else {
          flags.set(body, true)
        }
      }
    } else {
      positional.push(token)
    }
  }

  return { command, positional, flags }
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function info(message: string): void {
  process.stdout.write(`${message}\n`)
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof ManifestValidationError || err instanceof PluginBuildError) {
    process.stderr.write(`${err.name}: ${err.message}\n`)
    for (const issue of err.issues) process.stderr.write(`  - ${issue}\n`)
    process.exit(1)
  }
  if (err instanceof MarketplaceApiError) {
    process.stderr.write(`Error: ${err.message} (${err.code})\n`)
    process.exit(1)
  }
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
