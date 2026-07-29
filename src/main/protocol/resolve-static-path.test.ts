import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  getContentType,
  resolveSafePluginAssetPath,
  resolveStaticPath,
} from "./resolve-static-path"

const ROOT = path.resolve("/app/out/renderer")

describe("resolveStaticPath", () => {
  it("rewrites root to /index.html", () => {
    const result = resolveStaticPath("/", ROOT)
    expect(result).toEqual({ kind: "ok", filePath: path.join(ROOT, "index.html") })
  })

  it("rewrites empty pathname to /index.html", () => {
    const result = resolveStaticPath("", ROOT)
    expect(result).toEqual({ kind: "ok", filePath: path.join(ROOT, "index.html") })
  })

  it("resolves nested asset paths under root", () => {
    const result = resolveStaticPath("/assets/index-abc123.js", ROOT)
    expect(result).toEqual({
      kind: "ok",
      filePath: path.join(ROOT, "assets", "index-abc123.js"),
    })
  })

  it("decodes percent-encoded characters in the pathname", () => {
    const result = resolveStaticPath("/foo%20bar.txt", ROOT)
    expect(result).toEqual({ kind: "ok", filePath: path.join(ROOT, "foo bar.txt") })
  })

  it("rejects parent-directory traversal via ..", () => {
    const result = resolveStaticPath("/../etc/passwd", ROOT)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("rejects encoded parent-directory traversal", () => {
    const result = resolveStaticPath("/%2e%2e/secret.json", ROOT)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("rejects malformed percent-encoding", () => {
    const result = resolveStaticPath("/%E0%A4%A", ROOT)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("allows the root directory itself", () => {
    const result = resolveStaticPath("/", ROOT)
    expect(result.kind).toBe("ok")
  })
})

describe("getContentType", () => {
  it.each([
    ["index.html", "text/html; charset=utf-8"],
    ["chunk.js", "application/javascript; charset=utf-8"],
    ["chunk.mjs", "application/javascript; charset=utf-8"],
    ["styles.css", "text/css; charset=utf-8"],
    ["data.json", "application/json; charset=utf-8"],
    ["icon.svg", "image/svg+xml"],
    ["logo.png", "image/png"],
    ["font.woff2", "font/woff2"],
    ["icon.ico", "image/x-icon"],
    ["module.wasm", "application/wasm"],
  ])("maps %s to %s", (file, expected) => {
    expect(getContentType(file)).toBe(expected)
  })

  it("falls back to octet-stream for unknown extensions", () => {
    expect(getContentType("blob.xyz")).toBe("application/octet-stream")
  })

  it("matches the extension case-insensitively", () => {
    expect(getContentType("PHOTO.JPEG")).toBe("image/jpeg")
  })
})

describe("resolveSafePluginAssetPath", () => {
  let root: string
  let outside: string
  // Not every environment can create symlinks (e.g. Windows without
  // Developer Mode or admin rights) — probed once so the affected tests can
  // skip cleanly rather than fail on an environment limitation unrelated to
  // the behavior under test.
  let symlinksSupported = false

  beforeAll(async () => {
    const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "syn-symlink-probe-"))
    try {
      await fs.writeFile(path.join(probeDir, "target"), "x")
      await fs.symlink(path.join(probeDir, "target"), path.join(probeDir, "link"))
      symlinksSupported = true
    } catch {
      symlinksSupported = false
    } finally {
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  })

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "syn-asset-root-"))
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "syn-asset-outside-"))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  it("resolves a real image file inside root", async () => {
    await fs.writeFile(path.join(root, "icon.png"), "fake-png-bytes")
    const result = await resolveSafePluginAssetPath("/icon.png", root)
    expect(result.kind).toBe("ok")
  })

  it("rejects a path with a non-image extension, even though it's otherwise a safe file inside root", async () => {
    await fs.writeFile(path.join(root, "notes.txt"), "hello")
    const result = await resolveSafePluginAssetPath("/notes.txt", root)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("rejects parent-directory traversal (delegates to resolveStaticPath's lexical check)", async () => {
    const result = await resolveSafePluginAssetPath("/../etc/passwd.png", root)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("rejects a path that doesn't exist", async () => {
    const result = await resolveSafePluginAssetPath("/missing.png", root)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("rejects a directory named like an image file", async () => {
    await fs.mkdir(path.join(root, "icon.png"))
    const result = await resolveSafePluginAssetPath("/icon.png", root)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("rejects a symlink whose target escapes root — the actual vulnerability this function closes", async () => {
    if (!symlinksSupported) return
    await fs.writeFile(path.join(outside, "secret.png"), "outside-bytes")
    await fs.symlink(path.join(outside, "secret.png"), path.join(root, "icon.png"))

    const result = await resolveSafePluginAssetPath("/icon.png", root)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("accepts a symlink whose target is safely inside root", async () => {
    if (!symlinksSupported) return
    await fs.writeFile(path.join(root, "real-icon.png"), "real-bytes")
    await fs.symlink(path.join(root, "real-icon.png"), path.join(root, "icon.png"))

    const result = await resolveSafePluginAssetPath("/icon.png", root)
    expect(result.kind).toBe("ok")
  })
})
