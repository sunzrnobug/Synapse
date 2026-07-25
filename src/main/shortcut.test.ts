import { globalShortcut } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  bindGlobalShortcut,
  bindGlobalShortcutWithRetry,
  currentBinding,
  resumeGlobalShortcut,
  suspendGlobalShortcut,
  unbindGlobalShortcut,
} from "./shortcut"

describe("suspendGlobalShortcut / resumeGlobalShortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unbindGlobalShortcut()
  })

  it("does nothing when no accelerator is bound", () => {
    suspendGlobalShortcut()
    expect(globalShortcut.unregister).not.toHaveBeenCalled()
    expect(resumeGlobalShortcut(() => {})).toBe(true)
    expect(globalShortcut.register).not.toHaveBeenCalled()
  })

  it("unregisters the current accelerator without forgetting it", () => {
    bindGlobalShortcut("Control+Space", () => {})
    suspendGlobalShortcut()
    expect(globalShortcut.unregister).toHaveBeenCalledWith("Control+Space")
    expect(currentBinding()).toBe("Control+Space")
  })

  it("re-registers the suspended accelerator on resume", () => {
    const handler = () => {}
    bindGlobalShortcut("Control+Space", handler)
    suspendGlobalShortcut()
    vi.mocked(globalShortcut.isRegistered).mockReturnValue(false)

    const ok = resumeGlobalShortcut(handler)

    expect(ok).toBe(true)
    expect(globalShortcut.register).toHaveBeenCalledWith("Control+Space", handler)
  })

  it("is a no-op resume if the accelerator is already registered", () => {
    bindGlobalShortcut("Control+Space", () => {})
    vi.mocked(globalShortcut.isRegistered).mockReturnValue(true)
    vi.mocked(globalShortcut.register).mockClear()

    expect(resumeGlobalShortcut(() => {})).toBe(true)
    expect(globalShortcut.register).not.toHaveBeenCalled()
  })

  it("returns false if re-registering fails", () => {
    bindGlobalShortcut("Control+Space", () => {})
    suspendGlobalShortcut()
    vi.mocked(globalShortcut.isRegistered).mockReturnValue(false)
    vi.mocked(globalShortcut.register).mockReturnValue(false)

    expect(resumeGlobalShortcut(() => {})).toBe(false)
  })
})

describe("bindGlobalShortcutWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unbindGlobalShortcut()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("succeeds immediately without waiting when the first registration succeeds", async () => {
    vi.mocked(globalShortcut.register).mockReturnValue(true)

    const ok = await bindGlobalShortcutWithRetry("Control+Space", () => {}, {
      retries: 3,
      delayMs: 300,
    })

    expect(ok).toBe(true)
    expect(globalShortcut.register).toHaveBeenCalledTimes(1)
  })

  it("retries with a delay when the OS still holds the accelerator from a just-exited process, and succeeds once released", async () => {
    vi.useFakeTimers()
    vi.mocked(globalShortcut.register)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)

    const resultPromise = bindGlobalShortcutWithRetry("Control+Space", () => {}, {
      retries: 3,
      delayMs: 300,
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(globalShortcut.register).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(300)
    expect(globalShortcut.register).toHaveBeenCalledTimes(3)

    expect(await resultPromise).toBe(true)
  })

  it("gives up and returns false once retries are exhausted", async () => {
    vi.useFakeTimers()
    vi.mocked(globalShortcut.register).mockReturnValue(false)

    const resultPromise = bindGlobalShortcutWithRetry("Control+Space", () => {}, {
      retries: 2,
      delayMs: 300,
    })
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(300)

    expect(await resultPromise).toBe(false)
    expect(globalShortcut.register).toHaveBeenCalledTimes(3)
  })
})
