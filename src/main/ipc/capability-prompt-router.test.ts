import type { WebContents } from "electron"
import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createCapabilityPromptSender,
  createHostResourcePromptSender,
  resetCapabilityPromptTargetsForTests,
  withCapabilityPromptTarget,
} from "./capability-prompt-router"

function mockWebContents(url = "app://app/index.html"): WebContents & EventEmitter {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    on: emitter.on.bind(emitter),
    isDestroyed: () => false,
    getURL: () => url,
    send: vi.fn(),
  }) as unknown as WebContents & EventEmitter
}

function mockWindow(
  webContents: WebContents,
  destroyed = false
): { isDestroyed: () => boolean; webContents: WebContents } {
  return { isDestroyed: () => destroyed, webContents }
}

/** A stub that should never actually be invoked in tests exercising the
 *  targeted/nested-target paths, which never reach the no-visible-window
 *  fallback at all. */
function unusedEnsureVisibleWindow() {
  return vi.fn(() => mockWindow(mockWebContents()))
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  resetCapabilityPromptTargetsForTests()
})

describe("capabilityPromptRouter", () => {
  it("delivers prompts to the active IPC target and returns it as the sole recipient", async () => {
    const launcher = mockWebContents("app://app/index.html#search")
    const broadcast = vi.fn()
    const ensureVisibleWindow = unusedEnsureVisibleWindow()
    const sender = createCapabilityPromptSender(broadcast, ensureVisibleWindow)
    let recipients: unknown

    await withCapabilityPromptTarget(launcher, async () => {
      recipients = sender.sendGrantRequest({ promptId: "cap_1" })
    })

    expect(launcher.send).toHaveBeenCalledWith("capabilities:grant-request", { promptId: "cap_1" })
    expect(broadcast).not.toHaveBeenCalled()
    expect(ensureVisibleWindow).not.toHaveBeenCalled()
    expect(recipients).toEqual([launcher])
  })

  it("shows a window and delivers the prompt directly to it when nothing is currently visible (e.g. the app is running tray-only)", () => {
    const shown = mockWebContents("app://app/index.html")
    const ensureVisibleWindow = vi.fn(() => mockWindow(shown))
    const broadcast = vi.fn()
    const sender = createCapabilityPromptSender(broadcast, ensureVisibleWindow)

    const recipients = sender.sendGrantRequest({ promptId: "cap_hidden" })

    expect(ensureVisibleWindow).toHaveBeenCalledOnce()
    expect(shown.send).toHaveBeenCalledWith("capabilities:grant-request", {
      promptId: "cap_hidden",
    })
    expect(recipients).toEqual([shown])
    // A prompt delivered to a window we just had to show ourselves must
    // never also be silently broadcast to whatever else exists — the
    // whole point is a single, definite delivery the user will actually see.
    expect(broadcast).not.toHaveBeenCalled()
  })

  it("falls back to broadcast if the window ensureVisibleWindow returns isn't actually usable", () => {
    const destroyed = mockWebContents("app://app/index.html")
    const ensureVisibleWindow = vi.fn(() => mockWindow(destroyed, true))
    const broadcast = vi.fn()
    const sender = createCapabilityPromptSender(broadcast, ensureVisibleWindow)

    const recipients = sender.sendApprovalRequest({ promptId: "cap_2" })

    expect(ensureVisibleWindow).toHaveBeenCalledOnce()
    expect(destroyed.send).not.toHaveBeenCalled()
    expect(broadcast).toHaveBeenCalledWith("capabilities:approval-request", { promptId: "cap_2" })
    expect(recipients).toEqual([])
  })

  it("restores the previous target after nested calls", async () => {
    const outer = mockWebContents("app://app/index.html")
    const inner = mockWebContents("app://app/index.html#search")
    const broadcast = vi.fn()
    const ensureVisibleWindow = unusedEnsureVisibleWindow()
    const sender = createCapabilityPromptSender(broadcast, ensureVisibleWindow)
    let innerRecipients: unknown
    let outerRecipients: unknown

    await withCapabilityPromptTarget(outer, async () => {
      await withCapabilityPromptTarget(inner, async () => {
        innerRecipients = sender.sendGrantRequest({ promptId: "inner" })
      })
      outerRecipients = sender.sendGrantRequest({ promptId: "outer" })
    })

    expect(inner.send).toHaveBeenCalledWith("capabilities:grant-request", { promptId: "inner" })
    expect(outer.send).toHaveBeenCalledWith("capabilities:grant-request", { promptId: "outer" })
    expect(broadcast).not.toHaveBeenCalled()
    expect(ensureVisibleWindow).not.toHaveBeenCalled()
    expect(innerRecipients).toEqual([inner])
    expect(outerRecipients).toEqual([outer])
  })
})

describe("createHostResourcePromptSender", () => {
  it("delivers to the active IPC target and returns it as the sole recipient", async () => {
    const target = mockWebContents("app://app/index.html#search")
    const broadcast = vi.fn()
    const ensureVisibleWindow = unusedEnsureVisibleWindow()
    const sender = createHostResourcePromptSender(broadcast, ensureVisibleWindow)
    let recipients: unknown

    await withCapabilityPromptTarget(target, async () => {
      recipients = sender.sendApprovalRequest({ promptId: "host_res_apr_1" })
    })

    expect(target.send).toHaveBeenCalledWith("host-resources:approval-request", {
      promptId: "host_res_apr_1",
    })
    expect(broadcast).not.toHaveBeenCalled()
    expect(recipients).toEqual([target])
  })

  it("shows a window and delivers the prompt directly to it when nothing is currently visible", () => {
    const shown = mockWebContents("app://app/index.html")
    const ensureVisibleWindow = vi.fn(() => mockWindow(shown))
    const broadcast = vi.fn()
    const sender = createHostResourcePromptSender(broadcast, ensureVisibleWindow)

    const recipients = sender.sendApprovalRequest({ promptId: "host_res_hidden" })

    expect(ensureVisibleWindow).toHaveBeenCalledOnce()
    expect(shown.send).toHaveBeenCalledWith("host-resources:approval-request", {
      promptId: "host_res_hidden",
    })
    expect(recipients).toEqual([shown])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it("falls back to broadcast if the window ensureVisibleWindow returns isn't actually usable", () => {
    const destroyed = mockWebContents("app://app/index.html")
    const ensureVisibleWindow = vi.fn(() => mockWindow(destroyed, true))
    const broadcast = vi.fn()
    const sender = createHostResourcePromptSender(broadcast, ensureVisibleWindow)

    const recipients = sender.sendApprovalRequest({ promptId: "host_res_apr_2" })

    expect(destroyed.send).not.toHaveBeenCalled()
    expect(broadcast).toHaveBeenCalledWith("host-resources:approval-request", {
      promptId: "host_res_apr_2",
    })
    expect(recipients).toEqual([])
  })
})
