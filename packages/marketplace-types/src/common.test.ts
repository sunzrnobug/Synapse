import { describe, expect, it } from "vitest"
import { httpsUrlSchema } from "./common"

describe("httpsUrlSchema", () => {
  it("accepts an ordinary https url", () => {
    expect(httpsUrlSchema.safeParse("https://example.com/verify?code=ABC123").success).toBe(true)
  })

  it("rejects a non-https url", () => {
    expect(httpsUrlSchema.safeParse("http://example.com").success).toBe(false)
  })

  it("rejects a non-url string", () => {
    expect(httpsUrlSchema.safeParse("not a url").success).toBe(false)
  })

  // Regression test: `&` is the standard query-param separator
  // (URLSearchParams.toString() joins with it), and any real multi-param
  // url has one — most notably GitHub's own OAuth authorize url, which is
  // exactly what flows through this schema as a device-code
  // `verificationUri`. An earlier version of this schema rejected `&` as a
  // "shell metacharacter" and broke device-code login outright.
  it("accepts a real multi-param url (e.g. GitHub's OAuth authorize url)", () => {
    const url =
      "https://github.com/login/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fm.test%2Fcallback&scope=read%3Auser&state=XYZ123"
    expect(httpsUrlSchema.safeParse(url).success).toBe(true)
  })

  // Regression test: `;` is a legal URL sub-delimiter per RFC 3986 and can
  // appear in a real, well-formed query string. An earlier version of this
  // schema rejected it (and `|`, backtick, newline) as "shell
  // metacharacters" — that check was removed entirely, since `openBrowser`
  // (plugin-cli/src/cli.ts) uses the `open` package, which never spawns a
  // shell around the url, so there's no injection vector left downstream
  // for a url-shape check to defend against.
  it.each([
    "https://example.com/verify?code=ABC123;more",
    "https://example.com/verify?code=ABC123|more",
  ])(
    "accepts a url containing characters an earlier version rejected as shell metacharacters: %s",
    (url) => {
      expect(httpsUrlSchema.safeParse(url).success).toBe(true)
    }
  )
})
