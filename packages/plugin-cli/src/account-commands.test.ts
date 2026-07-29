// @vitest-environment node
import type { PluginManifest } from "@synapsepkg/plugin-manifest"
import type { CommandIo } from "./account-commands"
import type { CredentialStore } from "./credentials-store"
import type { MarketplaceClient, PublishMetadata } from "./marketplace-client"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runLogin, runLogout, runPublish, runWhoami } from "./account-commands"
import { MarketplaceApiError } from "./marketplace-client"

const BASE = "https://market.test"

function memoryStore(initial: Record<string, string> = {}): CredentialStore {
  const tokens = new Map(Object.entries(initial))
  return {
    get: async (url) => tokens.get(url),
    set: async (url, token) => void tokens.set(url, token),
    clear: async (url) => void tokens.delete(url),
  }
}

function makeIo(): CommandIo & { logs: string[]; opened: string[] } {
  const logs: string[] = []
  const opened: string[] = []
  let current = Date.now()
  return {
    logs,
    opened,
    log: (m) => void logs.push(m),
    openBrowser: async (url) => void opened.push(url),
    sleep: async (ms) => {
      current += ms // advance the clock so login loops terminate
    },
    now: () => current,
  }
}

const USER = {
  id: "u1",
  handle: "alice",
  displayName: "Alice",
  role: "developer" as const,
  createdAt: new Date().toISOString(),
}

function startResponse() {
  return {
    deviceCode: "dev-code",
    userCode: "ABCD-2345",
    verificationUri: "https://github.com/login/oauth/authorize?state=ABCD-2345",
    interval: 5,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function fakeClient(overrides: Partial<MarketplaceClient> = {}): MarketplaceClient {
  return {
    deviceStart: async () => startResponse(),
    devicePoll: async () => ({ status: "pending" }),
    session: async () => ({ user: USER }),
    publish: async () => {
      throw new Error("not implemented")
    },
    ...overrides,
  }
}

describe("runLogin", () => {
  it("polls until authorized and stores the token", async () => {
    const store = memoryStore()
    const io = makeIo()
    let polls = 0
    const client = fakeClient({
      devicePoll: async () => {
        polls += 1
        return polls < 2
          ? { status: "pending" }
          : { status: "authorized", accessToken: "tok-123", expiresAt: USER.createdAt, user: USER }
      },
    })

    await runLogin({ client, store, baseUrl: BASE, io })

    expect(await store.get(BASE)).toBe("tok-123")
    expect(io.opened).toContain("https://github.com/login/oauth/authorize?state=ABCD-2345")
    expect(io.logs.some((l) => l.includes("alice"))).toBe(true)
  })

  it("throws when the grant expires before approval", async () => {
    const io = makeIo()
    const client = fakeClient({
      devicePoll: async () => {
        throw new MarketplaceApiError(410, "gone", "expired")
      },
    })
    await expect(runLogin({ client, store: memoryStore(), baseUrl: BASE, io })).rejects.toThrow(
      /expired/i
    )
  })

  it("times out if it stays pending past expiry", async () => {
    const io = makeIo()
    const client = fakeClient({ devicePoll: async () => ({ status: "pending" }) })
    await expect(runLogin({ client, store: memoryStore(), baseUrl: BASE, io })).rejects.toThrow(
      /timed out/i
    )
  })
})

describe("runWhoami", () => {
  it("prints the user when logged in", async () => {
    const io = makeIo()
    await runWhoami({
      client: fakeClient(),
      store: memoryStore({ [BASE]: "tok" }),
      baseUrl: BASE,
      io,
    })
    expect(io.logs.join("\n")).toContain("alice (developer)")
  })

  it("rejects when not logged in", async () => {
    const io = makeIo()
    await expect(
      runWhoami({ client: fakeClient(), store: memoryStore(), baseUrl: BASE, io })
    ).rejects.toThrow(/not logged in/i)
  })

  it("maps a 401 to a re-login hint", async () => {
    const io = makeIo()
    const client = fakeClient({
      session: async () => {
        throw new MarketplaceApiError(401, "unauthorized", "bad token")
      },
    })
    await expect(
      runWhoami({ client, store: memoryStore({ [BASE]: "stale" }), baseUrl: BASE, io })
    ).rejects.toThrow(/session expired/i)
  })

  it("prefers the SYNAPSE_TOKEN env var over the persisted store", async () => {
    const originalEnv = process.env.SYNAPSE_TOKEN
    process.env.SYNAPSE_TOKEN = "env-token"
    try {
      const io = makeIo()
      const sessionCalls: string[] = []
      const client = fakeClient({
        session: async (token) => {
          sessionCalls.push(token)
          return { user: USER }
        },
      })
      // A store that would throw if actually consulted — proves the env var
      // short-circuits it rather than merely happening to agree with it.
      const store: CredentialStore = {
        get: async () => {
          throw new Error("store.get should not be called when SYNAPSE_TOKEN is set")
        },
        set: async () => {},
        clear: async () => {},
      }
      await runWhoami({ client, store, baseUrl: BASE, io })
      expect(sessionCalls).toEqual(["env-token"])
    } finally {
      // Assigning `undefined` to a process.env key coerces it to the string
      // "undefined" rather than deleting it — restore properly or this leaks
      // a truthy SYNAPSE_TOKEN into every later test in this file.
      if (originalEnv === undefined) delete process.env.SYNAPSE_TOKEN
      else process.env.SYNAPSE_TOKEN = originalEnv
    }
  })

  it("prefers an explicit deps.token (e.g. --token-stdin) over SYNAPSE_TOKEN and the store", async () => {
    const originalEnv = process.env.SYNAPSE_TOKEN
    process.env.SYNAPSE_TOKEN = "env-token"
    try {
      const io = makeIo()
      const sessionCalls: string[] = []
      const client = fakeClient({
        session: async (token) => {
          sessionCalls.push(token)
          return { user: USER }
        },
      })
      await runWhoami({
        client,
        store: memoryStore({ [BASE]: "stored-token" }),
        baseUrl: BASE,
        io,
        token: "stdin-token",
      })
      expect(sessionCalls).toEqual(["stdin-token"])
    } finally {
      // Assigning `undefined` to a process.env key coerces it to the string
      // "undefined" rather than deleting it — restore properly or this leaks
      // a truthy SYNAPSE_TOKEN into every later test in this file.
      if (originalEnv === undefined) delete process.env.SYNAPSE_TOKEN
      else process.env.SYNAPSE_TOKEN = originalEnv
    }
  })
})

describe("runLogout", () => {
  it("clears the stored token", async () => {
    const store = memoryStore({ [BASE]: "tok" })
    await runLogout({ client: fakeClient(), store, baseUrl: BASE, io: makeIo() })
    expect(await store.get(BASE)).toBeUndefined()
  })
})

describe("runPublish", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "syn-pub-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const manifest = {
    id: "com.alice.foo",
    version: "1.0.0",
  } as unknown as PluginManifest

  it("builds, hashes, and publishes with the right metadata", async () => {
    const bytes = Buffer.from("a synapse package")
    const packagePath = path.join(dir, "com.alice.foo-1.0.0.syn")
    await fs.writeFile(packagePath, bytes)

    const captured: { meta?: PublishMetadata; size?: number } = {}
    const client = fakeClient({
      publish: async (_token, meta, pkg) => {
        captured.meta = meta
        captured.size = pkg.byteLength
        return {
          plugin: { id: "com.alice.foo", latestVersion: "1.0.0" } as never,
          version: { version: "1.0.0" } as never,
        }
      },
    })
    const io = makeIo()

    await runPublish({
      client,
      store: memoryStore({ [BASE]: "tok" }),
      baseUrl: BASE,
      io,
      projectDir: dir,
      visibility: "public",
      build: async () => ({ manifest, packagePath }),
    })

    expect(captured.meta?.visibility).toBe("public")
    expect(captured.meta?.sizeBytes).toBe(bytes.byteLength)
    expect(captured.size).toBe(bytes.byteLength)
    expect(captured.meta?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(io.logs.join("\n")).toContain("com.alice.foo@1.0.0")
  })

  it("rejects publishing when not logged in", async () => {
    const io = makeIo()
    await expect(
      runPublish({
        client: fakeClient(),
        store: memoryStore(),
        baseUrl: BASE,
        io,
        projectDir: dir,
        visibility: "private",
        build: vi.fn(),
      })
    ).rejects.toThrow(/not logged in/i)
  })
})
