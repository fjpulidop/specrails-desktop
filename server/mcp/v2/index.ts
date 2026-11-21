import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { v1EquivalentOf } from '../tools/actions'
import type { McpToolContext, McpToolSpec } from '../tools/types'
import { createCatalog, registerV2Tool, type V2Callback, type V2Catalog } from './core/registry'
import { V2ToolError, failure, toCallToolResult, type TextMode } from './core/envelope'
import { V2_TOOLS } from './tools'
import { registerWaitNotifications } from './tools/wait'
import { hideTools, registerLegacyTools } from './legacy'

export { isMcpV2Enabled, MCP_V2_KEY } from './flag'
export { V2_INSTRUCTIONS } from './instructions'

let catalog: V2Catalog | null = null

/** The v2 catalog (15 tools + policy lookup), built once. */
export function v2Catalog(): V2Catalog {
  catalog ??= createCatalog(V2_TOOLS)
  return catalog
}

export interface V2SurfaceOptions {
  inApp: boolean
  textMode?: TextMode
  /** The session's resource subscriptions (resources.ts); journal rows notify through them. */
  resources?: { notify(uri: string): void }
}

export interface V2Surface {
  /** Tools advertised in `tools/list`. */
  toolCount: number
  /** Stops the session's journal notifications (call on session close). */
  dispose: () => void
}

/**
 * Registers the v2 surface on a session's server: the 15 v2 tools (advertised),
 * the v1 catalog as hidden aliases (legacy.ts), `ctx.v2.dispatch` through the
 * registered callbacks, and the journal notifications (`notifications/message`
 * for what needs the person, `resources/updated` for subscribed resources).
 * Register before `connect`; tool listing is patched last.
 */
export function registerV2Surface(server: McpServer, ctx: McpToolContext, v1Specs: readonly McpToolSpec[], options: V2SurfaceOptions): V2Surface {
  const built = v2Catalog()
  const v2Names = new Set<string>(built.tools.map((tool) => tool.name))
  const { delegates, hidden } = registerLegacyTools(server, ctx, v1Specs, { v2Names, inApp: options.inApp })
  const callbacks = new Map<string, V2Callback>()
  const dispatch: NonNullable<Parameters<typeof registerV2Tool>[3]['dispatch']> = async (call, extra) => {
    const callback = callbacks.get(call.tool)
    if (!callback) return toCallToolResult(failure(new V2ToolError('invalid_input', `Unknown tool ${call.tool}.`), call.tool))
    return callback(call.args, extra)
  }
  for (const def of built.tools) {
    callbacks.set(def.name, registerV2Tool(server, ctx, def, { catalog: built, textMode: options.textMode, legacy: delegates.get(def.name), legacyEquivalent: v1EquivalentOf, dispatch }))
  }
  hideTools(server, hidden)
  let dispose = () => {}
  try {
    dispose = registerWaitNotifications(server, ctx, options.resources ? { resources: options.resources } : {})
  } catch { /* the journal is optional: wait answers from the job rows when it is unavailable */ }
  const toolCount = built.tools.length + (options.inApp ? v1Specs.filter((spec) => !hidden.has(spec.name) && !v2Names.has(spec.name)).length : 0)
  return { toolCount, dispose }
}
