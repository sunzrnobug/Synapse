import type { Buffer as NodeBuffer } from "node:buffer"
import { spawn } from "node:child_process"
import { promises as fs, constants as fsConstants } from "node:fs"

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Whether `filePath` exists and is executable — a pure filesystem check,
 * never a process spawn or a PATH search. Used to resolve credential-helper
 * binaries by trusted absolute path instead of a bare command name (which
 * `spawn()` would resolve via PATH, letting an earlier, attacker-planted
 * binary of the same name run instead — CWE-426).
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Runs a command with `args` (never a shell — no string is ever re-parsed),
 * optionally writing `stdinInput` to its stdin. Secrets flow through here,
 * not through argv or env, so they never show up in a process listing.
 */
export function runWithStdin(
  command: string,
  args: string[],
  stdinInput?: string
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: NodeBuffer) => {
      stdout += chunk.toString("utf-8")
    })
    child.stderr.on("data", (chunk: NodeBuffer) => {
      stderr += chunk.toString("utf-8")
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    if (stdinInput !== undefined) {
      child.stdin.write(stdinInput)
    }
    child.stdin.end()
  })
}
