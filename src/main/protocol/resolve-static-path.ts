import { promises as fs } from "node:fs"
import * as path from "node:path"

export type ResolveResult = { kind: "ok"; filePath: string } | { kind: "forbidden" }

/**
 * Maps a URL pathname (e.g. "/assets/index-abc123.js") to an absolute
 * path inside `root`, with directory-traversal protection.
 *
 * Why: the static-asset handler must serve files relative to the renderer
 * output directory while rejecting any path that escapes that directory
 * via "..", encoded slashes, or absolute symlinks the URL constructor missed.
 */
export function resolveStaticPath(rawPathname: string, root: string): ResolveResult {
  let pathname: string
  try {
    pathname = decodeURIComponent(rawPathname)
  } catch {
    return { kind: "forbidden" }
  }

  if (pathname === "" || pathname === "/") {
    pathname = "/index.html"
  }

  const filePath = path.normalize(path.join(root, pathname))
  const normalizedRoot = path.normalize(root)
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep

  if (filePath !== normalizedRoot && !filePath.startsWith(rootWithSep)) {
    return { kind: "forbidden" }
  }

  return { kind: "ok", filePath }
}

const IMAGE_EXTENSIONS = new Set([
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
])

/**
 * Like {@link resolveStaticPath}, plus two checks needed only for serving
 * untrusted third-party content (a plugin's declared icon), not our own
 * build output: `resolveStaticPath`'s traversal check is purely lexical, so
 * a plugin package that ships a symlink whose target escapes its own
 * install directory would otherwise be served as if it were a normal file
 * (CWE-59) — this resolves symlinks via `fs.realpath` and re-checks the
 * resolved target still lives under `root`. It also restricts the result
 * to a regular file with a known image extension, since this path only
 * ever needs to serve an icon.
 */
export async function resolveSafePluginAssetPath(
  rawPathname: string,
  root: string
): Promise<ResolveResult> {
  const lexical = resolveStaticPath(rawPathname, root)
  if (lexical.kind === "forbidden") return lexical

  if (!IMAGE_EXTENSIONS.has(path.extname(lexical.filePath).toLowerCase())) {
    return { kind: "forbidden" }
  }

  let realFilePath: string
  let realRoot: string
  try {
    ;[realFilePath, realRoot] = await Promise.all([
      fs.realpath(lexical.filePath),
      fs.realpath(root),
    ])
  } catch {
    return { kind: "forbidden" }
  }

  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  if (realFilePath !== realRoot && !realFilePath.startsWith(realRootWithSep)) {
    return { kind: "forbidden" }
  }

  const stat = await fs.stat(realFilePath).catch(() => undefined)
  if (!stat?.isFile()) return { kind: "forbidden" }

  return { kind: "ok", filePath: realFilePath }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
}

export function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return CONTENT_TYPES[ext] ?? "application/octet-stream"
}
