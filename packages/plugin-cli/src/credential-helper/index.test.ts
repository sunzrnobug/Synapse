import { describe, expect, it } from "vitest"
import { resolveCredentialHelper } from "./index"

describe("resolveCredentialHelper", () => {
  it("picks the macOS helper on darwin", () => {
    expect(resolveCredentialHelper("darwin")?.name).toBe("macos")
  })

  it("picks the Windows helper on win32", () => {
    expect(resolveCredentialHelper("win32")?.name).toBe("windows")
  })

  it("picks the Linux helper on linux", () => {
    expect(resolveCredentialHelper("linux")?.name).toBe("linux")
  })

  it("returns undefined for an unrecognized platform", () => {
    expect(resolveCredentialHelper("freebsd")).toBeUndefined()
  })
})
