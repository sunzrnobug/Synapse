/** Builds the `plugin-asset://<pluginId>/<relativeIconPath>` url the main
 *  process's plugin-asset protocol handler serves (see src/main/index.ts). */
export function pluginAssetUrl(pluginId: string, relativeIconPath: string): string {
  const url = new URL(`plugin-asset://${pluginId}/`)
  url.pathname = relativeIconPath.startsWith("/") ? relativeIconPath : `/${relativeIconPath}`
  return url.toString()
}
