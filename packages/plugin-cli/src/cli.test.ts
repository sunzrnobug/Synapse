// @vitest-environment node
// cli.ts transitively imports build.ts, which runs esbuild; esbuild's UTF-8
// invariant check fails under jsdom's TextEncoder (same reason build.test.ts
// needs this), so this suite must use the node environment.
import { spawn } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { openBrowser } from "./cli"

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn(async () => {}) }))
vi.mock("open", () => ({ default: openMock }))
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

describe("openBrowser", () => {
  it("opens a url via the cross-platform `open` package", async () => {
    openMock.mockClear()
    await openBrowser("https://example.com/verify?code=ABC123")
    expect(openMock).toHaveBeenCalledWith("https://example.com/verify?code=ABC123")
  })

  // Regression test for the Windows command-injection finding: the old
  // implementation shelled out to `cmd /c start "" <url>`, letting cmd.exe
  // re-parse `&`/`|` as its own command separators. `open` never spawns a
  // shell to interpret the url, so passing a url containing those
  // characters through unmodified is safe (the marketplace-types schema
  // separately rejects such urls before they'd ever reach here — this test
  // proves the CLI's own code path no longer has a shell in the loop at all,
  // as defense in depth).
  it("never spawns a shell (node:child_process.spawn) to open a url", async () => {
    openMock.mockClear()
    vi.mocked(spawn).mockClear()
    await openBrowser("https://example.com/verify?code=ABC123&calc.exe")
    expect(openMock).toHaveBeenCalledWith("https://example.com/verify?code=ABC123&calc.exe")
    expect(spawn).not.toHaveBeenCalled()
  })

  it("does not throw when `open` rejects (best-effort)", async () => {
    openMock.mockClear()
    openMock.mockImplementationOnce(async () => {
      throw new Error("no browser found")
    })
    await expect(openBrowser("https://example.com")).resolves.toBeUndefined()
  })
})
