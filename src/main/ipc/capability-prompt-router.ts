import type { WebContents } from "electron"
import { BrowserWindow } from "electron"

const promptTargetStack: WebContents[] = []

/**
 * While `fn` runs, capability JIT / approval / host-resource-approval
 * prompts are delivered to this renderer (the IPC caller) instead of
 * every window.
 */
export async function withCapabilityPromptTarget<T>(
  target: WebContents,
  fn: () => T | Promise<T>
): Promise<T> {
  const wc = target.isDestroyed() ? undefined : target
  if (wc) promptTargetStack.push(wc)
  try {
    return await fn()
  } finally {
    if (wc) {
      const index = promptTargetStack.lastIndexOf(wc)
      if (index >= 0) promptTargetStack.splice(index, 1)
    }
  }
}

/** Minimal window shape `deliverPrompt` needs — matches `BrowserWindow`. */
export interface PromptWindow {
  isDestroyed: () => boolean
  webContents: WebContents
}

export function createCapabilityPromptSender(
  broadcast: (channel: string, payload: unknown) => void,
  ensureVisibleWindow: () => PromptWindow
): {
  sendGrantRequest: (payload: unknown) => WebContents[]
  sendApprovalRequest: (payload: unknown) => WebContents[]
} {
  return {
    sendGrantRequest: (payload) =>
      deliverPrompt("capabilities:grant-request", payload, broadcast, ensureVisibleWindow),
    sendApprovalRequest: (payload) =>
      deliverPrompt("capabilities:approval-request", payload, broadcast, ensureVisibleWindow),
  }
}

/**
 * Host-resource approval prompts share the exact same window-selection
 * logic as capability prompts (deliverPrompt below) — verified there is
 * no scenario today where a host-resource request actually arrives inside
 * an active withCapabilityPromptTarget scope (that scope is only pushed
 * around synchronous IPC-handler-invoked work; hostResourceApprover is
 * only ever invoked from headless-approval-server's socket callback,
 * which never runs inside such a scope) — every host-resource prompt
 * falls through to the focused-window / single-visible-window / broadcast
 * chain. The sharing here is implementation reuse, not an active
 * target-scoping scenario.
 */
export function createHostResourcePromptSender(
  broadcast: (channel: string, payload: unknown) => void,
  ensureVisibleWindow: () => PromptWindow
): {
  sendApprovalRequest: (payload: unknown) => WebContents[]
} {
  return {
    sendApprovalRequest: (payload) =>
      deliverPrompt("host-resources:approval-request", payload, broadcast, ensureVisibleWindow),
  }
}

/**
 * Delivers a prompt and reports exactly which webContents actually received
 * it, so callers can feed the result into `ApprovalHandle.markDelivered` —
 * without that, a window that later reloads/crashes/closes has no recipient
 * slot to retire and its prompt would never resolve. The broadcast branch
 * has no per-send acknowledgement (`broadcast` is caller-supplied and
 * returns nothing), so it reports every currently prompt-capable window —
 * the same set `broadcast` is expected to reach.
 */
function deliverPrompt(
  channel: string,
  payload: unknown,
  broadcast: (channel: string, payload: unknown) => void,
  ensureVisibleWindow: () => PromptWindow
): WebContents[] {
  const targeted = currentPromptTarget()
  if (targeted) {
    targeted.send(channel, payload)
    return [targeted]
  }

  const focused = BrowserWindow.getFocusedWindow()
  if (focused && isPromptCapableWebContents(focused.webContents)) {
    focused.webContents.send(channel, payload)
    return [focused.webContents]
  }

  const visible = promptCapableWindows().filter((win) => win.isVisible())
  if (visible.length === 1) {
    visible[0]!.webContents.send(channel, payload)
    return [visible[0]!.webContents]
  }

  if (visible.length === 0) {
    // Nothing is currently visible to show this prompt to — most notably,
    // the app's normal tray-only state (main window created hidden, "shown
    // on demand"). Sending only to hidden renderers would deliver the IPC
    // event but never actually be seen, silently failing the request
    // closed on timeout instead of ever reaching a real user decision.
    // Surface a window now instead of falling through to broadcast.
    const win = ensureVisibleWindow()
    if (!win.isDestroyed() && isPromptCapableWebContents(win.webContents)) {
      win.webContents.send(channel, payload)
      return [win.webContents]
    }
  }

  broadcast(channel, payload)
  return promptCapableWindows().map((win) => win.webContents)
}

function currentPromptTarget(): WebContents | undefined {
  while (promptTargetStack.length > 0) {
    const wc = promptTargetStack[promptTargetStack.length - 1]
    if (!wc || wc.isDestroyed()) {
      promptTargetStack.pop()
      continue
    }
    return wc
  }
  return undefined
}

function isPromptCapableWebContents(webContents: WebContents): boolean {
  if (webContents.isDestroyed()) return false
  return !webContents.getURL().includes("#floating-ball")
}

function promptCapableWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && isPromptCapableWebContents(win.webContents)
  )
}

/** Test seam: reset stack between cases. */
export function resetCapabilityPromptTargetsForTests(): void {
  promptTargetStack.length = 0
}
