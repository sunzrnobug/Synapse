import type { TriggerDeclaration } from "@synapse/plugin-manifest"
import type {
  ClipboardContent,
  LocalizedString,
  PluginModule,
  ToolResult,
  View,
} from "@synapse/plugin-sdk"
import type {
  DiscoveredPlugin,
  ManifestCommand,
  ManifestTool,
  PluginCommandResult,
  PluginEventRequest,
  PluginInvokeRequest,
  PluginManifest,
  PluginRegistryEntry,
  PluginSandboxRuntime,
  RegisteredToolDescriptor,
  ToolInvocationOptions,
} from "./types"
import { EventEmitter } from "node:events"
import { projectModelVisibleTool } from "../ai/guardrails/tool-metadata"
import { fuzzyMatch } from "../launcher/search"
import { logger } from "../logging"
import { CapabilityDenied } from "./capability-gate"
import { PermissionDenied } from "./permissions"
import { PluginCallCancelledError, PluginInvocationTimeoutError } from "./plugin-sandbox"
import { toolFqName } from "./types"

/**
 * Thrown after the registry has marked a plugin crashed and recovered
 * the underlying sandbox error. Lets callers distinguish "the host
 * decided this plugin is now disabled" from a raw `Error` whose
 * message happens to mention "crashed".
 */
export class PluginCrashedError extends Error {
  readonly pluginId: string
  readonly cause?: unknown

  constructor(pluginId: string, cause: unknown) {
    super(`Plugin crashed: ${pluginId}`)
    this.name = "PluginCrashedError"
    this.pluginId = pluginId
    this.cause = cause
  }
}

export interface PluginRegistryEvents {
  changed: [PluginRegistryEntry[]]
}

export interface PluginRegistryOptions {
  sandbox: PluginSandboxRuntime
  now?: () => number
}

interface CommandIndexEntry {
  pluginId: string
  command: ManifestCommand
  /** The plugin manifest's top-level icon, used when the command declares none of its own. */
  manifestIcon?: string
}

interface ToolIndexEntry {
  pluginId: string
  tool: ManifestTool
}

export class PluginRegistry extends EventEmitter<PluginRegistryEvents> {
  private readonly entries = new Map<string, PluginRegistryEntry>()
  private readonly commandIndex = new Map<string, CommandIndexEntry>()
  private readonly toolIndex = new Map<string, ToolIndexEntry>()
  private readonly clipboardChangeListeners = new Set<string>()
  private readonly now: () => number

  constructor(private readonly options: PluginRegistryOptions) {
    super()
    this.now = options.now ?? Date.now
  }

  async load(discovered: DiscoveredPlugin[]): Promise<void> {
    const loadedPluginIds = new Set([...this.entries.values()].map((entry) => entry.pluginId))
    for (const pluginId of loadedPluginIds) {
      try {
        await this.options.sandbox.unloadPlugin(pluginId)
      } catch (err) {
        logger.child("plugin-registry").warn("failed to unload before reload", { pluginId, err })
      }
    }
    this.entries.clear()
    this.commandIndex.clear()
    this.toolIndex.clear()
    this.clipboardChangeListeners.clear()

    for (const plugin of discovered) {
      await this.addDiscoveredPlugin(plugin)
    }

    for (const [fqName, { pluginId, tool }] of this.toolIndex.entries()) {
      const projected = projectModelVisibleTool({
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        provenance: "plugin",
      })
      if (!projected.ok) {
        logger.warn(`tool ${fqName} excluded from model exposure: ${projected.reason}`, {
          pluginId,
        })
      }
    }

    this.emitChanged()
  }

  list(): PluginRegistryEntry[] {
    return [...this.entries.values()]
  }

  get(pluginId: string): PluginRegistryEntry | undefined {
    return this.entries.get(pluginId)
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginRegistryEntry> {
    const entry = this.entries.get(pluginId)
    if (!entry) throw new Error(`Plugin not found: ${pluginId}`)
    if (!entry.manifest || entry.status === "invalid" || entry.status === "shadowed") return entry

    if (!enabled) {
      await this.options.sandbox.unloadPlugin(pluginId)
      this.removeCommands(pluginId)
      this.removeTools(pluginId)
      this.clipboardChangeListeners.delete(pluginId)
      const next = { ...entry, status: "disabled" as const }
      this.entries.set(pluginId, next)
      this.emitChanged()
      return next
    }

    try {
      const loaded = await this.options.sandbox.loadPlugin({
        pluginId,
        rootDir: entry.rootDir,
        source: entry.source,
        status: "valid",
        manifest: entry.manifest,
      })
      validateManifestCommands(entry.manifest.contributes.commands, loaded.module.commands)
      validateManifestTools(entry.manifest.contributes.tools, loaded.module.tools)
      validateManifestTriggers(entry.manifest.triggers, loaded.module.triggers)
      validateActivationEvents(entry.manifest, loaded.module)
      this.indexActivationEvents(entry.manifest, loaded.module)
      const next = { ...entry, status: "active" as const, error: undefined, loadedAt: this.now() }
      this.entries.set(pluginId, next)
      this.indexCommands(next)
      this.indexTools(next)
      this.emitChanged()
      return next
    } catch (err) {
      await this.unloadAfterLoadFailure(pluginId)
      throw err
    }
  }

  searchCommands(query: string, locale = "en", limit = 20): PluginCommandResult[] {
    const trimmed = query.trim()
    const results: PluginCommandResult[] = []
    for (const indexed of this.commandIndex.values()) {
      const candidate = commandSearchText(indexed.command, locale)
      const match = fuzzyMatch(trimmed, candidate)
      if (!match) continue
      results.push({
        kind: "plugin-command",
        pluginId: indexed.pluginId,
        commandId: indexed.command.id,
        title: indexed.command.title,
        subtitle: indexed.command.subtitle,
        icon: indexed.command.icon ?? indexed.manifestIcon,
        mode: indexed.command.mode,
        score: match.score,
        matches: match.matches,
      })
    }
    results.sort((a, b) => b.score - a.score || a.commandId.localeCompare(b.commandId))
    return results.slice(0, limit)
  }

  async invoke(request: PluginInvokeRequest): Promise<View | void> {
    const entry = this.entries.get(request.pluginId)
    if (!entry || entry.status !== "active") {
      throw new Error(`Plugin is not active: ${request.pluginId}`)
    }
    try {
      return await this.options.sandbox.invokeCommand(request)
    } catch (err) {
      // Permission denials are policy decisions, not plugin defects —
      // leave the plugin active and surface the original error so the
      // IPC layer can map it to PLUGIN_PERMISSION_DENIED.
      if (
        err instanceof PermissionDenied ||
        err instanceof CapabilityDenied ||
        err instanceof PluginInvocationTimeoutError ||
        err instanceof PluginCallCancelledError
      )
        throw err
      this.markCrashed(request.pluginId, err)
      throw new PluginCrashedError(request.pluginId, err)
    }
  }

  /** Tools contributed by all currently active plugins. */
  listTools(): RegisteredToolDescriptor[] {
    return [...this.toolIndex.entries()].map(([fqName, { pluginId, tool }]) => ({
      fqName,
      pluginId,
      manifestTool: tool,
      provenance: "plugin" as const,
      ownerVersion: this.entries.get(pluginId)?.manifest?.version ?? "unversioned",
      replayGuarantee: "none" as const,
    }))
  }

  /**
   * Execute a tool on an active plugin. Unlike `invoke`, a fault inside the
   * tool does NOT crash the plugin — the sandbox surfaces it as an error
   * result so the agent can recover. Only `PermissionDenied` and sandbox-level
   * (timeout/cancel) failures propagate.
   */
  async invokeTool(
    pluginId: string,
    toolName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const entry = this.entries.get(pluginId)
    if (!entry || entry.status !== "active") {
      throw new Error(`Plugin is not active: ${pluginId}`)
    }
    const indexed = this.toolIndex.get(toolFqName(pluginId, toolName))
    if (!indexed) throw new Error(`Plugin tool not found: ${toolFqName(pluginId, toolName)}`)

    try {
      return await this.options.sandbox.invokeTool({
        pluginId,
        toolName,
        input,
        capabilities: indexed.tool.capabilities,
        options,
      })
    } catch (err) {
      // sandbox.invokeTool only ever throws for infrastructure failures — a
      // fault inside the tool handler itself already comes back as a
      // resolved isError ToolResult. Permission denials and timeouts are
      // already-classified policy/budget decisions, not plugin defects;
      // anything else (e.g. the plugin's process crashed between calls)
      // means the sandbox and the registry have fallen out of sync, so mark
      // the plugin crashed the same way invoke()/disposeCommand()/
      // dispatchEvent() already do.
      if (
        err instanceof PermissionDenied ||
        err instanceof CapabilityDenied ||
        err instanceof PluginInvocationTimeoutError ||
        err instanceof PluginCallCancelledError
      )
        throw err
      this.markCrashed(pluginId, err)
      throw new PluginCrashedError(pluginId, err)
    }
  }

  async disposeCommand(pluginId: string, commandId: string): Promise<void> {
    try {
      await this.options.sandbox.disposeCommand(pluginId, commandId)
    } catch (err) {
      if (
        err instanceof PermissionDenied ||
        err instanceof CapabilityDenied ||
        err instanceof PluginInvocationTimeoutError ||
        err instanceof PluginCallCancelledError
      )
        throw err
      this.markCrashed(pluginId, err)
      throw new PluginCrashedError(pluginId, err)
    }
  }

  clipboardChangeListenerEntries(): PluginRegistryEntry[] {
    return [...this.clipboardChangeListeners].flatMap((pluginId) => {
      const entry = this.entries.get(pluginId)
      return entry?.status === "active" ? [entry] : []
    })
  }

  async dispatchClipboardChange(
    content: ClipboardContent,
    pluginIds?: readonly string[]
  ): Promise<void> {
    const targetIds = pluginIds ? new Set(pluginIds) : undefined
    const entries = [...this.clipboardChangeListeners].flatMap((pluginId) => {
      if (targetIds && !targetIds.has(pluginId)) return []
      const entry = this.entries.get(pluginId)
      return entry?.status === "active" ? [entry] : []
    })

    await Promise.all(
      entries.map((entry) =>
        this.dispatchEvent({
          pluginId: entry.pluginId,
          event: "clipboard:change",
          payload: { content },
        })
      )
    )
  }

  hasClipboardChangeListeners(): boolean {
    return this.clipboardChangeListeners.size > 0
  }

  hasClipboardChangeListener(pluginId: string): boolean {
    return this.clipboardChangeListeners.has(pluginId)
  }

  revokeCapability(pluginId: string, capability: string): void {
    if (capability !== "clipboard:watch") return
    if (this.clipboardChangeListeners.delete(pluginId)) this.emitChanged()
  }

  private async dispatchEvent(request: PluginEventRequest): Promise<void> {
    const entry = this.entries.get(request.pluginId)
    if (!entry || entry.status !== "active") return
    try {
      await this.options.sandbox.dispatchEvent(request)
    } catch (err) {
      if (
        err instanceof PermissionDenied ||
        err instanceof CapabilityDenied ||
        err instanceof PluginInvocationTimeoutError ||
        err instanceof PluginCallCancelledError
      )
        throw err
      this.markCrashed(request.pluginId, err)
      throw new PluginCrashedError(request.pluginId, err)
    }
  }

  private async addDiscoveredPlugin(plugin: DiscoveredPlugin): Promise<void> {
    if (plugin.status !== "valid" || !plugin.manifest) {
      this.entries.set(registryKey(plugin), {
        pluginId: plugin.pluginId,
        rootDir: plugin.rootDir,
        source: plugin.source,
        status: plugin.status === "shadowed" ? "shadowed" : "invalid",
        manifest: plugin.manifest,
        error: plugin.error,
        shadowedBy: plugin.shadowedBy,
      })
      return
    }

    try {
      const loaded = await this.options.sandbox.loadPlugin(plugin)
      validateManifestCommands(plugin.manifest.contributes.commands, loaded.module.commands)
      validateManifestTools(plugin.manifest.contributes.tools, loaded.module.tools)
      validateManifestTriggers(plugin.manifest.triggers, loaded.module.triggers)
      validateActivationEvents(plugin.manifest, loaded.module)
      this.indexActivationEvents(plugin.manifest, loaded.module)
      const entry: PluginRegistryEntry = {
        pluginId: plugin.pluginId,
        rootDir: plugin.rootDir,
        source: plugin.source,
        status: "active",
        manifest: plugin.manifest,
        loadedAt: this.now(),
      }
      this.entries.set(plugin.pluginId, entry)
      this.indexCommands(entry)
      this.indexTools(entry)
    } catch (err) {
      await this.unloadAfterLoadFailure(plugin.pluginId)
      this.entries.set(plugin.pluginId, {
        pluginId: plugin.pluginId,
        rootDir: plugin.rootDir,
        source: plugin.source,
        status: "crashed",
        manifest: plugin.manifest,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private indexCommands(entry: PluginRegistryEntry): void {
    if (!entry.manifest || entry.status !== "active") return
    for (const command of entry.manifest.contributes.commands) {
      this.commandIndex.set(commandIndexKey(entry.pluginId, command.id), {
        pluginId: entry.pluginId,
        command,
        manifestIcon: entry.manifest.icon,
      })
    }
  }

  private removeCommands(pluginId: string): void {
    for (const [commandId, indexed] of this.commandIndex) {
      if (indexed.pluginId === pluginId) this.commandIndex.delete(commandId)
    }
  }

  private indexTools(entry: PluginRegistryEntry): void {
    if (!entry.manifest || entry.status !== "active") return
    for (const tool of entry.manifest.contributes.tools ?? []) {
      this.toolIndex.set(toolFqName(entry.pluginId, tool.name), {
        pluginId: entry.pluginId,
        tool,
      })
    }
  }

  private removeTools(pluginId: string): void {
    for (const [fqName, indexed] of this.toolIndex) {
      if (indexed.pluginId === pluginId) this.toolIndex.delete(fqName)
    }
  }

  private markCrashed(pluginId: string, err: unknown): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    logger.error("plugin crashed", { pluginId, err })
    this.removeCommands(pluginId)
    this.removeTools(pluginId)
    this.clipboardChangeListeners.delete(pluginId)
    this.entries.set(pluginId, {
      ...entry,
      status: "crashed",
      error: err instanceof Error ? err.message : String(err),
    })
    this.emitChanged()
  }

  private emitChanged(): void {
    this.emit("changed", this.list())
  }

  private async unloadAfterLoadFailure(pluginId: string): Promise<void> {
    this.clipboardChangeListeners.delete(pluginId)
    try {
      await this.options.sandbox.unloadPlugin(pluginId)
    } catch (err) {
      logger.child("plugin-registry").warn("failed to unload after load failure", { pluginId, err })
    }
  }

  private indexActivationEvents(manifest: PluginManifest, module: PluginModule): void {
    this.clipboardChangeListeners.delete(manifest.id)
    if (
      manifest.contributes.activationEvents?.includes("clipboard:change") &&
      module.events?.onClipboardChange
    ) {
      this.clipboardChangeListeners.add(manifest.id)
    }
  }
}

function registryKey(plugin: DiscoveredPlugin): string {
  return plugin.status === "shadowed"
    ? `${plugin.pluginId}#${plugin.source.kind}#${plugin.rootDir}`
    : plugin.pluginId
}

function validateManifestCommands(
  commands: ManifestCommand[],
  exported: Record<string, unknown>
): void {
  for (const command of commands) {
    if (!exported[command.id]) {
      throw new Error(`Manifest command is not exported by plugin module: ${command.id}`)
    }
  }
}

function validateManifestTools(
  tools: ManifestTool[] | undefined,
  exported: Record<string, unknown> | undefined
): void {
  // The sandbox already guarantees any exported tool is a function; here we
  // only confirm every manifest-declared tool is present in the module.
  for (const tool of tools ?? []) {
    if (!exported?.[tool.name]) {
      throw new Error(`Manifest tool is not exported by plugin module: ${tool.name}`)
    }
  }
}

function validateManifestTriggers(
  triggers: TriggerDeclaration[] | undefined,
  exported: Record<string, unknown> | undefined
): void {
  for (const trigger of triggers ?? []) {
    const exportName = trigger.handler.slice("triggers.".length)
    if (typeof exported?.[exportName] !== "function") {
      throw new TypeError(
        `Manifest trigger handler is not exported by plugin module: ${trigger.handler}`
      )
    }
  }
}

function validateActivationEvents(manifest: PluginManifest, module: PluginModule): void {
  if (!manifest.contributes.activationEvents?.includes("clipboard:change")) return
  if (!manifest.capabilities.some((c) => c.id === "clipboard:watch")) {
    throw new Error(
      "Manifest activation event clipboard:change requires clipboard:watch permission"
    )
  }
  const events = module.events
  if (
    !events ||
    typeof events !== "object" ||
    typeof (events as { onClipboardChange?: unknown }).onClipboardChange !== "function"
  ) {
    throw new Error("Manifest activation event clipboard:change requires events.onClipboardChange")
  }
}

function commandSearchText(command: ManifestCommand, locale: string): string {
  return [
    localized(command.title, locale),
    command.subtitle ? localized(command.subtitle, locale) : "",
    ...(command.keywords ?? []),
  ].join(" ")
}

function localized(value: LocalizedString, locale: string): string {
  if (typeof value === "string") return value
  return value[locale] ?? value.en ?? Object.values(value)[0] ?? ""
}

function commandIndexKey(pluginId: string, commandId: string): string {
  return `${pluginId}:${commandId}`
}
