import process from "node:process"

/**
 * The only variables passed through to a workspace command subprocess.
 * Deliberately excludes NODE_OPTIONS/PYTHONPATH/GIT_* and similar
 * behavior-changing variables: even though they aren't secrets, silently
 * inheriting them from a potentially-tainted host environment can change
 * what a spawned node/python/git actually does. An allowlist can't miss an
 * unanticipated secret shape the way the old denylist did.
 */
const ALLOWED_KEYS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "windir",
  // Windows command resolution (cmd.exe/PowerShell) needs this to know which
  // extensions count as executable when a command is invoked by a bare name
  // (e.g. `node` instead of `node.exe`) — without it, spawning a shell that
  // then runs an unqualified command can fail to find it at all.
  "PATHEXT",
  "TEMP",
  "TMP",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LANGUAGE",
  // Windows PowerShell (powershell.exe) startup path/module resolution.
  // None of these are secrets — just standard per-machine system
  // locations — but missing them has been observed causing powershell.exe
  // to hang indefinitely on startup (before it even runs the given
  // command) on some Windows CI images, rather than merely running slowly.
  "PSModulePath",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
])

/**
 * Build a minimized environment for workspace command execution: only
 * allowlisted variables are passed through, everything else is dropped.
 */
export function sandboxCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED_KEYS) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  return env
}
