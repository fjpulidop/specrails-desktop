import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { V1_UNALIASED_TOOLS, deprecationTarget } from '../tools/actions'
import { registerTieredTool, tieredToolCallback, type McpToolContext, type McpToolSpec } from '../tools/types'
import { McpToolError, errorEnvelope } from '../tools/envelope'
import { wireInputObject } from '../tools/wire-schema'
import { withDeprecation, type LegacyDelegate } from './core/registry'
import { t } from './core/lang'

/**
 * The v1 catalog while v2 is served (design §10): every v1 tool keeps working
 * with its exact v1 behavior, but is hidden from `tools/list`.
 *
 * - A v1 name that v2 does not reuse is registered as before and hidden; each
 *   result gains `warnings: ["deprecated: use <v2 call>"]`.
 * - A v1 name that v2 reuses (projects, specs, rails, runs, inbox, missions,
 *   settings) becomes a `LegacyDelegate` of the v2 tool: its v1 actions stay
 *   accepted as hidden actions and run the v1 handler until the owning work
 *   package implements the v2 action.
 * - `specrails_mission` (first-party) stays listed for in-app sessions only.
 */
export function registerLegacyTools(server: McpServer, ctx: McpToolContext, v1Specs: readonly McpToolSpec[], options: { v2Names: ReadonlySet<string>; inApp: boolean }): { delegates: Map<string, LegacyDelegate>; hidden: Set<string> } {
  const delegates = new Map<string, LegacyDelegate>()
  const hidden = new Set<string>()
  for (const spec of v1Specs) {
    const hint = (action: string | null) => V1_UNALIASED_TOOLS.has(spec.name) ? null : deprecationTarget(spec.name, action)
    if (options.v2Names.has(spec.name)) {
      const field = spec.inputSchema.action as { options?: unknown } | undefined
      const actions = new Set(Array.isArray(field?.options) ? field.options as string[] : [])
      const callback = tieredToolCallback(ctx, spec)
      const input = wireInputObject(spec)
      delegates.set(spec.name, {
        actions, hint, shape: spec.inputSchema,
        // The SDK validated against the relaxed v2 schema; hold v1 calls to the v1 schema.
        call: async (args, extra) => {
          const parsed = input.safeParse(args)
          if (parsed.success) return callback(parsed.data as Record<string, unknown>, extra)
          const action = typeof args.action === 'string' ? args.action : null
          const message = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')
          const envelope = errorEnvelope(new McpToolError('invalid_input', message), spec.name, action)
          return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }], structuredContent: envelope as unknown as Record<string, unknown>, isError: true }
        },
      })
      continue
    }
    registerTieredTool(server, ctx, spec, {
      alwaysLoad: false,
      wrapCallback: (callback) => async (args, extra) => {
        const result = await callback(args, extra)
        const target = hint(typeof args?.action === 'string' ? args.action : null)
        return target ? withDeprecation(result, t('en', 'core.summary.deprecated', { target })) : result
      },
    })
    if (!(options.inApp && V1_UNALIASED_TOOLS.has(spec.name))) hidden.add(spec.name)
  }
  return { delegates, hidden }
}

type ListHandler = (request: unknown, extra: unknown) => Promise<{ tools: Array<{ name: string }> } & Record<string, unknown>>

/**
 * Removes names from `tools/list` while keeping them callable. Wraps the SDK's
 * own list handler (call after every tool is registered); legacy-surface tests
 * pin this against SDK upgrades.
 */
export function hideTools(server: McpServer, names: ReadonlySet<string>): void {
  if (!names.size) return
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListHandler> })._requestHandlers
  const inner = handlers?.get('tools/list')
  if (!handlers || !inner) throw new Error('hideTools: tools/list handler not found (register tools first).')
  handlers.set('tools/list', async (request, extra) => {
    const listed = await inner(request, extra)
    return { ...listed, tools: listed.tools.filter((tool) => !names.has(tool.name)) }
  })
}
