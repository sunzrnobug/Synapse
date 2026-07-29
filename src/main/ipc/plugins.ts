import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { PluginHost } from "../plugins/plugin-host"
import type { PluginInvokePhase, PluginInvokeRequest } from "../plugins/types"
import { logger } from "../logging"
import { CapabilityDenied } from "../plugins/capability-gate"
import { MarketplaceApiError } from "../plugins/marketplace-api"
import { PermissionDenied } from "../plugins/permissions"
import {
  PluginHostNotImplementedError,
  PluginInstallError,
  PluginPreferenceTypeError,
} from "../plugins/plugin-host"
import { PluginCrashedError } from "../plugins/plugin-registry"
import { PluginCallCancelledError, PluginInvocationTimeoutError } from "../plugins/plugin-sandbox"
import { withCapabilityPromptTarget } from "./capability-prompt-router"

export type PluginIpcErrorCode =
  | "IPC_FORBIDDEN"
  | "IPC_INVALID_PAYLOAD"
  | "MARKETPLACE_ERROR"
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_NOT_ACTIVE"
  | "PLUGIN_PERMISSION_DENIED"
  | "PLUGIN_CRASHED"
  | "PLUGIN_CALL_CANCELLED"
  | "PLUGIN_INVOCATION_TIMEOUT"
  | "PLUGIN_NOT_IMPLEMENTED"
  | "PLUGIN_INSTALL_ERROR"
  | "PLUGIN_IO_ERROR"
  | "UNKNOWN_ERROR"

export interface PluginIpcError {
  code: PluginIpcErrorCode
  message: string
  details?: Record<string, unknown>
}

export type PluginIpcResult<T> = { ok: true; data: T } | { ok: false; error: PluginIpcError }

/**
 * Thrown by the `requireXxx` payload guards below. Distinguishing
 * IPC-layer payload validation errors from `TypeError`s thrown
 * inside plugin code (which `PluginRegistry.invoke` rethrows) is
 * what keeps the IPC mapper from labelling a plugin crash as
 * `IPC_INVALID_PAYLOAD`.
 */
export class PluginIpcInvalidPayloadError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = "PluginIpcInvalidPayloadError"
  }
}

export interface PluginIpcHandlers {
  list: () => unknown
  get: (pluginId: unknown) => unknown
  setEnabled: (payload: unknown) => Promise<unknown>
  setPreference: (payload: unknown) => Promise<void>
  installFolder: (folderPath: unknown) => Promise<unknown>
  installPackage: (zipPath: unknown) => Promise<unknown>
  importFromFile: () => Promise<unknown>
  uninstall: (pluginId: unknown) => Promise<void>
  reload: (pluginId?: unknown) => Promise<unknown>
  searchCommands: (query: unknown) => unknown
  invoke: (payload: unknown) => Promise<unknown>
  disposeCommand: (payload: unknown) => Promise<void>
  listPendingTriggerCapabilities: () => Promise<unknown>
  confirmTriggerCapabilities: (payload: unknown) => Promise<unknown>
  confirmAndEnable: (payload: unknown) => Promise<unknown>
  marketplaceList: () => unknown[] | Promise<unknown[]>
  marketplaceInstall: (payload: unknown) => Promise<unknown>
  marketplaceSearch: (query: unknown) => Promise<unknown>
  marketplaceDetail: (pluginId: unknown) => Promise<unknown>
  marketplaceBackendInstall: (payload: unknown) => Promise<unknown>
}

export interface PluginIpcDeps {
  /**
   * Prompts the user to pick a `.syn` file (Electron file dialog). Returns
   * the chosen absolute path, or null if cancelled. Injected so the IPC layer
   * stays free of Electron's `dialog` and remains unit-testable.
   */
  pickPackageFile?: () => Promise<string | null>
}

export interface RegisterPluginIpcOptions extends PluginIpcDeps {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  onRegistryChanged: (entries: unknown) => void
}

export function createPluginIpcHandlers(
  host: PluginHost,
  deps: PluginIpcDeps = {}
): PluginIpcHandlers {
  return {
    list: () => host.list(),

    get: (pluginId) => host.get(requireString(pluginId, "pluginId")) ?? null,

    setEnabled: (payload) => {
      const value = requireRecord(payload, "plugin:set-enabled payload")
      return host.setEnabled(
        requireString(value.pluginId, "pluginId"),
        requireBoolean(value.enabled, "enabled")
      )
    },

    setPreference(payload) {
      const value = requireRecord(payload, "plugin:set-preference payload")
      return host.setPreference(
        requireString(value.pluginId, "pluginId"),
        requireString(value.key, "key"),
        value.value
      )
    },

    installFolder: (folderPath) => host.installFolder(requireString(folderPath, "folderPath")),

    installPackage: (zipPath) => host.installPackage(requireString(zipPath, "zipPath")),

    async importFromFile() {
      if (!deps.pickPackageFile) {
        throw new PluginHostNotImplementedError("Plugin file import is not available")
      }
      const filePath = await deps.pickPackageFile()
      // User cancelled the file dialog — null is a valid, non-error result.
      if (!filePath) return null
      return host.installPackage(filePath)
    },

    uninstall: (pluginId) => host.uninstall(requireString(pluginId, "pluginId")),

    reload: (pluginId) => {
      if (pluginId === undefined || pluginId === null) return host.reload()
      return host.reload(requireString(pluginId, "pluginId"))
    },

    searchCommands: (query) => {
      if (typeof query === "string") return host.searchCommands(query)
      const value = requireRecord(query, "plugin:search-commands payload")
      const locale = typeof value.locale === "string" ? value.locale : undefined
      const limit = typeof value.limit === "number" ? value.limit : undefined
      return host.searchCommands(requireString(value.query, "query"), locale, limit)
    },

    invoke: (payload) => host.invoke(parseInvokePayload(payload)),

    disposeCommand: (payload) => {
      const value = requireRecord(payload, "plugin:dispose-command payload")
      return host.disposeCommand(
        requireString(value.pluginId, "pluginId"),
        requireString(value.commandId, "commandId")
      )
    },

    listPendingTriggerCapabilities: () => host.listPendingTriggerCapabilityConfirmations(),
    confirmTriggerCapabilities: (payload) => {
      const value = requireRecord(payload, "plugin:confirm-trigger-capabilities payload")
      const pluginId = requireString(value.pluginId, "pluginId")
      if (
        !Array.isArray(value.capabilityIds) ||
        !value.capabilityIds.every((id) => typeof id === "string")
      ) {
        throw new TypeError("capabilityIds must be an array of strings.")
      }
      return host.confirmTriggerCapabilities({
        pluginId,
        capabilityIds: value.capabilityIds as string[],
      })
    },
    confirmAndEnable: (payload) => {
      const value = requireRecord(payload, "plugin:confirm-and-enable payload")
      const pluginId = requireString(value.pluginId, "pluginId")
      if (
        !Array.isArray(value.capabilityIds) ||
        !value.capabilityIds.every((id) => typeof id === "string")
      ) {
        throw new TypeError("capabilityIds must be an array of strings.")
      }
      return host.confirmAndEnablePlugin(pluginId, value.capabilityIds as string[])
    },

    marketplaceList: () => host.listMarketplacePlugins(),

    marketplaceInstall(payload) {
      const value = requireRecord(payload, "marketplace:install payload")
      return host.installMarketplacePlugin(
        requireString(value.id, "id"),
        typeof value.version === "string" ? value.version : undefined
      )
    },

    marketplaceSearch(query) {
      return host.searchMarketplace(typeof query === "string" ? query : undefined)
    },

    marketplaceDetail(pluginId) {
      return host.marketplaceDetail(requireString(pluginId, "pluginId"))
    },

    marketplaceBackendInstall(payload) {
      const value = requireRecord(payload, "marketplace:backend-install payload")
      return host.installFromMarketplace(
        requireString(value.id, "id"),
        requireString(value.version, "version")
      )
    },
  }
}

export function registerPluginIpc(
  ipcMain: IpcMain,
  host: PluginHost,
  options: RegisterPluginIpcOptions
): void {
  const handlers = createPluginIpcHandlers(host, { pickPackageFile: options.pickPackageFile })

  ipcMain.handle("plugin:list", (event) =>
    invokePluginIpcHandler("plugin:list", event, () => handlers.list(), options.isTrustedSender)
  )
  ipcMain.handle("plugin:get", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "plugin:get",
      event,
      () => handlers.get(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:set-enabled", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:set-enabled",
      event,
      () => handlers.setEnabled(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:list-pending-trigger-capabilities", (event) =>
    invokePluginIpcHandler(
      "plugin:list-pending-trigger-capabilities",
      event,
      () => handlers.listPendingTriggerCapabilities(),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:confirm-trigger-capabilities", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:confirm-trigger-capabilities",
      event,
      () => handlers.confirmTriggerCapabilities(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:confirm-and-enable", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:confirm-and-enable",
      event,
      () => handlers.confirmAndEnable(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:set-preference", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:set-preference",
      event,
      () => handlers.setPreference(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:install-folder", (event, folderPath: unknown) =>
    invokePluginIpcHandler(
      "plugin:install-folder",
      event,
      () => handlers.installFolder(folderPath),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:install-package", (event, zipPath: unknown) =>
    invokePluginIpcHandler(
      "plugin:install-package",
      event,
      () => handlers.installPackage(zipPath),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:import-from-file", (event) =>
    invokePluginIpcHandler(
      "plugin:import-from-file",
      event,
      () => handlers.importFromFile(),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:uninstall", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "plugin:uninstall",
      event,
      () => handlers.uninstall(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:reload", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "plugin:reload",
      event,
      () => handlers.reload(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:search-commands", (event, query: unknown) =>
    invokePluginIpcHandler(
      "plugin:search-commands",
      event,
      () => handlers.searchCommands(query),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:invoke", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:invoke",
      event,
      () => withCapabilityPromptTarget(event.sender, () => handlers.invoke(payload)),
      options.isTrustedSender
    )
  )
  ipcMain.handle("plugin:dispose-command", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "plugin:dispose-command",
      event,
      () => handlers.disposeCommand(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("marketplace:list", (event) =>
    invokePluginIpcHandler(
      "marketplace:list",
      event,
      () => handlers.marketplaceList(),
      options.isTrustedSender
    )
  )
  ipcMain.handle("marketplace:install", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "marketplace:install",
      event,
      () => handlers.marketplaceInstall(payload),
      options.isTrustedSender
    )
  )
  ipcMain.handle("marketplace:search", (event, query: unknown) =>
    invokePluginIpcHandler(
      "marketplace:search",
      event,
      () => handlers.marketplaceSearch(query),
      options.isTrustedSender
    )
  )
  ipcMain.handle("marketplace:detail", (event, pluginId: unknown) =>
    invokePluginIpcHandler(
      "marketplace:detail",
      event,
      () => handlers.marketplaceDetail(pluginId),
      options.isTrustedSender
    )
  )
  ipcMain.handle("marketplace:backend-install", (event, payload: unknown) =>
    invokePluginIpcHandler(
      "marketplace:backend-install",
      event,
      () => handlers.marketplaceBackendInstall(payload),
      options.isTrustedSender
    )
  )

  host.registry.on("changed", () => options.onRegistryChanged(host.list()))
}

export async function invokePluginIpcHandler<T>(
  channel: string,
  event: IpcMainInvokeEvent,
  handler: () => T | Promise<T>,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
): Promise<PluginIpcResult<Awaited<T>>> {
  if (!isTrustedSender(event)) {
    logger.child("plugin-ipc").warn("rejected untrusted sender", {
      channel,
      senderUrl: senderUrl(event),
    })
    return {
      ok: false,
      error: {
        code: "IPC_FORBIDDEN",
        message: "Untrusted IPC sender.",
        details: { channel },
      },
    }
  }

  try {
    return { ok: true, data: (await handler()) as Awaited<T> }
  } catch (err) {
    return { ok: false, error: toPluginIpcError(err) }
  }
}

function parseInvokePayload(payload: unknown): PluginInvokeRequest {
  const value = requireRecord(payload, "plugin:invoke payload")
  return {
    pluginId: requireString(value.pluginId, "pluginId"),
    commandId: requireString(value.commandId, "commandId"),
    phase: requirePhase(value.phase),
    payload: value.payload,
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginIpcInvalidPayloadError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginIpcInvalidPayloadError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new PluginIpcInvalidPayloadError(`${label} must be a boolean`)
  }
  return value
}

function requirePhase(value: unknown): PluginInvokePhase {
  if (value === "run" || value === "onSearchChange" || value === "onAction") return value
  throw new PluginIpcInvalidPayloadError("phase must be run, onSearchChange, or onAction")
}

function toPluginIpcError(err: unknown): PluginIpcError {
  if (err instanceof PluginHostNotImplementedError) {
    return {
      code: "PLUGIN_NOT_IMPLEMENTED",
      message: "This plugin feature is not implemented yet.",
    }
  }

  if (err instanceof PluginInstallError) {
    return {
      code: "PLUGIN_INSTALL_ERROR",
      message: err.message,
      details: err.details,
    }
  }

  if (err instanceof MarketplaceApiError) {
    return {
      code: "MARKETPLACE_ERROR",
      message: err.message,
      details: { status: err.status, code: err.code },
    }
  }

  // Order matters here: PluginIpcInvalidPayloadError extends TypeError, but
  // we also want to map PluginPreferenceTypeError (also a TypeError subclass)
  // to IPC_INVALID_PAYLOAD. Plain TypeErrors that bubble out of plugin code
  // via PluginCrashedError.cause never reach this branch — they arrive
  // wrapped in PluginCrashedError below.
  if (err instanceof PluginIpcInvalidPayloadError || err instanceof PluginPreferenceTypeError) {
    return {
      code: "IPC_INVALID_PAYLOAD",
      message: err.message,
    }
  }

  if (err instanceof PermissionDenied) {
    return {
      code: "PLUGIN_PERMISSION_DENIED",
      message: "Plugin permission denied.",
      details: { pluginId: err.pluginId, permission: err.permission },
    }
  }

  if (err instanceof CapabilityDenied) {
    return {
      code: "PLUGIN_PERMISSION_DENIED",
      message: "Plugin capability denied.",
      details: { pluginId: err.pluginId, capability: err.capability, why: err.why },
    }
  }

  if (err instanceof PluginInvocationTimeoutError) {
    return {
      code: "PLUGIN_INVOCATION_TIMEOUT",
      message: "Plugin call timed out.",
      details: { message: err.message },
    }
  }

  if (err instanceof PluginCrashedError) {
    return {
      code: "PLUGIN_CRASHED",
      message: "Plugin crashed.",
      details: { pluginId: err.pluginId },
    }
  }

  // Not a crash: abortPluginCapability/unloadPlugin intentionally cancel any
  // in-flight call when a capability is revoked or the plugin is unloaded
  // mid-call. Callers can use this code to distinguish that expected outcome
  // from PLUGIN_CRASHED / UNKNOWN_ERROR.
  if (err instanceof PluginCallCancelledError) {
    return {
      code: "PLUGIN_CALL_CANCELLED",
      message: "Plugin call was cancelled.",
      details: { pluginId: err.pluginId },
    }
  }

  if (isErrorWithCode(err) && isIoErrorCode(err.code)) {
    return {
      code: "PLUGIN_IO_ERROR",
      message: "Plugin file operation failed.",
    }
  }

  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith("Plugin not found:")) {
    return {
      code: "PLUGIN_NOT_FOUND",
      message: "Plugin was not found.",
      details: { pluginId: message.slice("Plugin not found:".length).trim() },
    }
  }
  if (message.startsWith("Plugin is not active:")) {
    return {
      code: "PLUGIN_NOT_ACTIVE",
      message: "Plugin is not active.",
      details: { pluginId: message.slice("Plugin is not active:".length).trim() },
    }
  }

  return {
    code: "UNKNOWN_ERROR",
    message: "Plugin IPC request failed.",
  }
}

function senderUrl(event: IpcMainInvokeEvent): string | undefined {
  return event.senderFrame?.url || event.sender.getURL()
}

function isErrorWithCode(err: unknown): err is { code: string } {
  return Boolean(
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
  )
}

function isIoErrorCode(code: string): boolean {
  return ["EACCES", "EEXIST", "EISDIR", "ENOENT", "ENOTDIR", "EPERM"].includes(code)
}
