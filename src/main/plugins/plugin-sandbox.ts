import type { ToolResult, View } from "@synapse/plugin-sdk"
import type { PluginBridge } from "./plugin-bridge"
import type { ChildProcessHandle } from "./plugin-process-host"
import type {
  DiscoveredPlugin,
  PluginEventRequest,
  PluginInvokeRequest,
  PluginSandboxModule,
  PluginToolInvokeRequest,
  PluginTriggerDispatch,
} from "./types"
import * as path from "node:path"
import { utilityProcess } from "electron"
import {
  PluginCallCancelledError,
  PluginInvocationTimeoutError,
  PluginProcessHost,
  PluginSandboxError,
} from "./plugin-process-host"

// Re-exported so every existing `import { PluginSandboxError } from
// "./plugin-sandbox"` (and `instanceof` check against it) keeps working
// unchanged — these classes now live in plugin-process-host.ts, the new
// canonical home for sandbox errors.
export { PluginCallCancelledError, PluginInvocationTimeoutError, PluginSandboxError }

export interface PluginSandboxOptions {
  bridge: PluginBridge
  loadTimeoutMs?: number
  invokeTimeoutMs?: number
  /**
   * `run` may await JIT capability prompts — keep this generous so a slow
   * user click does not trip the 5s hook budget used by search/action hooks.
   */
  commandRunTimeoutMs?: number
  /** Tools may run longer than UI command hooks; defaults to 30s. */
  toolInvokeTimeoutMs?: number
  /**
   * Absolute path to the built `plugin-runtime-entry.js` script that
   * `utilityProcess.fork()` loads. The default below (this module's own
   * `__dirname`) is only correct if this module ends up bundled into the
   * SAME Rollup chunk as an actual entry point — true when only one
   * main-process entry uses it, but NOT guaranteed once code is shared
   * across multiple entries (`index.js`/`mcp-stdio.js`), since a shared
   * chunk's `__dirname` is the chunk's own folder under `out/main/chunks/`,
   * not `out/main/`. Real callers (`src/main/index.ts`'s `initPluginHost()`,
   * `src/main/mcp/stdio-entry.ts`) MUST compute this from their OWN
   * `__dirname` and pass it explicitly (via `PluginHostOptions.
   * sandboxEntryScriptPath`) rather than rely on this default — verified by
   * building the app and confirming `entryScriptPath` did NOT resolve
   * correctly through the shared chunk before that fix. Only test code
   * (which always overrides `forkProcess` too, so this value is never
   * actually dereferenced) may safely omit it.
   */
  entryScriptPath?: string
  /** Test seam: replaces the real `utilityProcess.fork()`-backed factory. */
  forkProcess?: (entryScriptPath: string, pluginId: string) => ChildProcessHandle
}

/**
 * Thin, stable-signature wrapper over `PluginProcessHost` (Critical #1,
 * slice 4). Every actual process-isolation / capability-dispatch decision
 * lives in plugin-process-host.ts — see its docs for the design. This class
 * exists purely so `plugin-registry.ts`, `plugin-host.ts`,
 * `plugin-tool-bridge.ts`, and `background-invoker.ts` never had to change a
 * single call site across the `node:vm` → `utilityProcess` migration.
 */
export class PluginSandbox {
  private readonly host: PluginProcessHost

  constructor(options: PluginSandboxOptions) {
    this.host = new PluginProcessHost({
      bridge: options.bridge,
      loadTimeoutMs: options.loadTimeoutMs,
      invokeTimeoutMs: options.invokeTimeoutMs,
      commandRunTimeoutMs: options.commandRunTimeoutMs,
      toolInvokeTimeoutMs: options.toolInvokeTimeoutMs,
      entryScriptPath: options.entryScriptPath ?? path.join(__dirname, "plugin-runtime-entry.js"),
      forkProcess: options.forkProcess ?? forkRealUtilityProcess,
    })
  }

  loadPlugin(entry: DiscoveredPlugin): Promise<PluginSandboxModule> {
    return this.host.loadPlugin(entry)
  }

  unloadPlugin(pluginId: string): Promise<void> {
    return this.host.unloadPlugin(pluginId)
  }

  invokeCommand(request: PluginInvokeRequest): Promise<View | void> {
    return this.host.invokeCommand(request)
  }

  invokeTool(request: PluginToolInvokeRequest): Promise<ToolResult> {
    return this.host.invokeTool(request)
  }

  disposeCommand(pluginId: string, commandId: string): Promise<void> {
    return this.host.disposeCommand(pluginId, commandId)
  }

  dispatchEvent(request: PluginEventRequest): Promise<void> {
    return this.host.dispatchEvent(request)
  }

  dispatchTrigger(request: PluginTriggerDispatch): Promise<void> {
    return this.host.dispatchTrigger(request)
  }

  getLoadedModule(pluginId: string): PluginSandboxModule | undefined {
    return this.host.getLoadedModule(pluginId)
  }

  /**
   * Revoke background work for a loaded plugin after a capability revoke.
   * Kills and transparently reloads the plugin's child process — the only
   * way to guarantee every timer/listener the plugin created is actually
   * gone now that plugin code runs in a real OS process, not a `node:vm`
   * context the host could reach into. See `PluginProcessHost.
   * abortPluginCapability`'s docs for the full rationale.
   */
  abortPluginCapability(pluginId: string, capability: string): void {
    this.host.abortPluginCapability(pluginId, capability)
  }
}

function forkRealUtilityProcess(entryScriptPath: string, pluginId: string): ChildProcessHandle {
  const child = utilityProcess.fork(entryScriptPath, [], {
    serviceName: `synapse-plugin:${pluginId}`,
  })
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on("message", listener),
    onExit: (listener) => child.on("exit", listener),
    kill: () => {
      child.kill()
    },
  }
}
