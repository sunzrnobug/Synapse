import type { Plugin } from "vite"
import { copyFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

function copyCredentialSecretPromptHtml(): Plugin {
  const src = resolve(__dirname, "src/main/plugins/credential-secret-prompt.html")
  const dest = resolve(__dirname, "out/main/credential-secret-prompt.html")
  return {
    name: "copy-credential-secret-prompt-html",
    closeBundle() {
      mkdirSync(resolve(__dirname, "out/main"), { recursive: true })
      copyFileSync(src, dest)
    },
  }
}

// electron-vite produces three independent bundles:
//   out/main/index.js        ← main process (Node, CommonJS)
//   out/preload/index.js     ← preload (sandboxed, CommonJS)
//   out/renderer/index.html  ← renderer (browser, ESM)
//
// In dev, the renderer is served at process.env.ELECTRON_RENDERER_URL
// (e.g. http://localhost:5173) and the main process loads that URL.
// In production, the main process loads the built renderer via the
// custom `app://` scheme registered in src/main/index.ts.

export default defineConfig({
  main: {
    // @synapse/plugin-manifest is a workspace package with runtime code (zod
    // schema). Bundle it from source instead of externalizing it so the app
    // needs no prior `pnpm build:manifest` in dev/build — mirrors how the SDK
    // is aliased to source for tsc/vitest. zod stays externalized (real dep).
    // @synapse/agent-protocol has no runtime dependency of its own (pure
    // types + pure functions), so it is always safe to bundle from source.
    // @synapse/marketplace-types is the same story as plugin-manifest (zod
    // schemas marketplace-api.ts parses responses with at runtime) — and,
    // unlike the other three, isn't even a declared root dependency, so it
    // has no real node_modules entry at all; this alias is the only thing
    // that makes the import specifier below resolve, in dev or in a build.
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@synapse/plugin-manifest",
          "@synapse/agent-protocol",
          "@synapse/marketplace-types",
        ],
      }),
      copyCredentialSecretPromptHtml(),
    ],
    resolve: {
      alias: {
        "@synapse/plugin-manifest": resolve(__dirname, "packages/plugin-manifest/src/index.ts"),
        "@synapse/plugin-sdk": resolve(__dirname, "packages/plugin-sdk/src/index.ts"),
        "@synapse/agent-protocol": resolve(__dirname, "packages/agent-protocol/src/index.ts"),
        "@synapse/marketplace-types": resolve(__dirname, "packages/marketplace-types/src/index.ts"),
      },
    },
    build: {
      rollupOptions: {
        // `index` is the Electron app; `mcp-stdio` is a headless Node entry for
        // Synapse-as-MCP-server. The latter is launched with
        // ELECTRON_RUN_AS_NODE=1 so it actually receives piped stdin (a spawned
        // Electron GUI process on Windows does not) — see src/main/mcp/stdio-entry.ts.
        // `plugin-runtime-entry` is loaded via `utilityProcess.fork()` (Critical
        // #1 sandbox migration) — one child process per loaded plugin. Referenced
        // as a sibling build output (`__dirname`-relative, same pattern as the
        // `mcp-stdio.js` reference above) — computed by each real main-process
        // entry itself (src/main/index.ts, src/main/mcp/stdio-entry.ts) and
        // passed down, since plugin-sandbox.ts's own `__dirname` is unreliable
        // once it's bundled into a chunk shared across multiple entries.
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "mcp-stdio": resolve(__dirname, "src/main/mcp/stdio-entry.ts"),
          "plugin-runtime-entry": resolve(__dirname, "src/main/plugins/plugin-runtime-entry.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          "credential-secret-prompt": resolve(__dirname, "src/preload/credential-secret-prompt.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@synapse/plugin-sdk": resolve(__dirname, "packages/plugin-sdk/src/index.ts"),
        "@synapse/agent-protocol": resolve(__dirname, "packages/agent-protocol/src/index.ts"),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
})
