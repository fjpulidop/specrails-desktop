import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { v1EquivalentOf } from '../tools/actions'
import type { McpToolContext, McpToolSpec } from '../tools/types'
import { createCatalog, registerV2Tool, type V2Catalog } from './core/registry'
import type { TextMode } from './core/envelope'
import { V2_TOOLS } from './tools'
import { hideTools, registerLegacyTools } from './legacy'

export { isMcpV2Enabled, MCP_V2_KEY } from './flag'
export { V2_INSTRUCTIONS } from './instructions'

let catalog: V2Catalog | null = null

/** The v2 catalog (15 tools + policy lookup), built once. */
export function v2Catalog(): V2Catalog {
  catalog ??= createCatalog(V2_TOOLS)
  return catalog
}

/**
 * Registers the v2 surface on a session's server: the 15 v2 tools (advertised)
 * and the v1 catalog as hidden aliases (legacy.ts). Returns the advertised tool
 * count. Call after resources/prompts are registered or before; tool listing is
 * patched last.
 */
export function registerV2Surface(server: McpServer, ctx: McpToolContext, v1Specs: readonly McpToolSpec[], options: { inApp: boolean; textMode?: TextMode }): number {
  const built = v2Catalog()
  const v2Names = new Set<string>(built.tools.map((tool) => tool.name))
  const { delegates, hidden } = registerLegacyTools(server, ctx, v1Specs, { v2Names, inApp: options.inApp })
  for (const def of built.tools) {
    registerV2Tool(server, ctx, def, { catalog: built, textMode: options.textMode, legacy: delegates.get(def.name), legacyEquivalent: v1EquivalentOf })
  }
  hideTools(server, hidden)
  return built.tools.length + (options.inApp ? v1Specs.filter((spec) => !hidden.has(spec.name) && !v2Names.has(spec.name)).length : 0)
}
