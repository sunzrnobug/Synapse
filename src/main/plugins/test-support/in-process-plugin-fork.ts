import type { HostToChildMessage } from "../plugin-ipc-protocol"
import type { ChildProcessHandle } from "../plugin-process-host"
import type { RuntimePort } from "../plugin-runtime-entry"
import { createPluginRuntime } from "../plugin-runtime-entry"

/**
 * A `forkProcess` factory for tests: runs the real `plugin-runtime-entry.ts`
 * logic in the same process (a real `require()` of the plugin's compiled
 * code) instead of forking an actual `utilityProcess` — Electron's
 * `utilityProcess` doesn't exist under Vitest. The host <-> child message
 * exchange is wired as two plain function-call "pipes" rather than real OS
 * IPC, so it settles synchronously.
 *
 * This is what lets every test that builds a real `PluginHost`/`PluginSandbox`
 * keep exercising actual plugin code (written to a temp file) exactly like
 * the pre-migration `node:vm` sandbox did — only the transport changed.
 *
 * What this fake can't simulate: killing the "child" is a no-op (there's no
 * real process to reap), so a plugin's own `setTimeout`/`setInterval` calls
 * keep running in the test process after `abortPluginCapability`/`unloadPlugin`
 * — unlike production, where the OS process actually dies. Tests that need to
 * prove background work truly stops belong against `plugin-process-host.ts`
 * directly (see its `abortPluginCapability` tests) or a real Electron
 * dogfooding pass, not this fake.
 */
export function createInProcessPluginFork(): (
  entryScriptPath: string,
  pluginId: string
) => ChildProcessHandle {
  return () => {
    let toHost: ((message: unknown) => void) | undefined
    let toChild: ((message: HostToChildMessage) => void) | undefined

    const childPort: RuntimePort = {
      postMessage: (message) => toHost?.(message),
      onMessage: (listener) => {
        toChild = listener
      },
    }
    createPluginRuntime(childPort)

    return {
      postMessage: (message) => toChild?.(message),
      onMessage: (listener) => {
        toHost = listener
      },
      onExit: () => {
        // No real process exists to exit — nothing to simulate here today.
      },
      kill: () => {
        // No real process to kill; see the module docs above.
      },
    }
  }
}
