import { describe, expect, it } from "vitest"
import { pluginAssetUrl } from "@/lib/plugin-asset-url"

describe("pluginAssetUrl", () => {
  it("builds a plugin-asset url from a plugin id and a relative icon path", () => {
    expect(pluginAssetUrl("com.author.foo", "icon.png")).toBe(
      "plugin-asset://com.author.foo/icon.png"
    )
  })

  it("normalizes a leading slash on the icon path", () => {
    expect(pluginAssetUrl("com.author.foo", "/assets/icon.png")).toBe(
      "plugin-asset://com.author.foo/assets/icon.png"
    )
  })

  // The real traversal defense is resolve-static-path.ts on the main-process
  // side, which rejects any decoded path escaping the plugin's install
  // directory — this function is just URL construction, not a security
  // boundary. It happens that the WHATWG URL parser itself collapses ".."
  // path segments when the pathname is assigned, so a traversal attempt
  // never even reaches the main process as a literal "..": this test pins
  // that (incidental, not load-bearing) behavior rather than asserting a
  // guarantee this function is responsible for.
  it("the URL parser itself collapses a traversal segment when the pathname is assigned", () => {
    expect(pluginAssetUrl("com.author.foo", "../../etc/passwd")).toBe(
      "plugin-asset://com.author.foo/etc/passwd"
    )
  })
})
