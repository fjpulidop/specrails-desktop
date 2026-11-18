import { z } from 'zod'
import type { McpTier } from '../mcp-tiers'
import { McpToolError } from './envelope'

/**
 * Action-facade plumbing shared by every tool with an `action` enum:
 *
 * - `actionEnum(advertised, hidden)`: the runtime accepts every action, but the
 *   client-facing JSON schema lists only the advertised ones. Hidden actions are
 *   legacy names kept working after an action moved to another tool.
 * - `ActionAlias`: where a hidden action now lives (`tool` + `action`, plus fixed
 *   arguments such as `mode`). `linkAliases` routes the tier, the Intent
 *   exception and the handler to the target, so an alias behaves exactly like
 *   the call it stands for.
 * - `ActionFields`: the arguments each action takes. MCP tool input schemas must
 *   be a single JSON object (a top-level oneOf is rejected by several clients),
 *   so the schema stays a flat union of optional fields and each action is
 *   validated at runtime with an `invalid_input` error naming its fields.
 *
 * Pure module apart from the zod schema it returns.
 */

/** Minimal structural view of a tool spec, so this module does not import types.ts (cycle). */
export interface AliasableSpec {
  name: string
  tier: McpTier | ((args: Record<string, unknown>) => McpTier)
  inputSchema: Record<string, unknown>
  handler: (ctx: never, args: Record<string, unknown>) => unknown
  tierException?: (ctx: never, args: Record<string, unknown>) => boolean
  aliases?: Record<string, ActionAlias>
  actionFields?: Record<string, ActionFields>
  resolveAlias?: (args: Record<string, unknown>) => ResolvedAlias | null
}

export interface ActionAlias {
  tool: string
  action: string
  /** Fixed arguments the alias implies (e.g. `{ mode: 'recover' }`); explicit caller arguments win. */
  args?: Record<string, unknown>
}

export interface ActionFields {
  /** Every listed field must be present. */
  required?: readonly string[]
  /** At least one of these fields must be present. */
  oneOf?: readonly string[]
  optional?: readonly string[]
}

export interface ResolvedAlias {
  spec: AliasableSpec
  args: Record<string, unknown>
}

/**
 * The `action` field: accepts advertised + hidden values, advertises only the
 * former (zod v4 metadata overrides the generated `enum`).
 */
export function actionEnum<const A extends readonly [string, ...string[]]>(advertised: A, hidden: readonly string[] = []) {
  const all = [...advertised, ...hidden.filter((action) => !advertised.includes(action))] as [string, ...string[]]
  return z.enum(all).meta({ enum: [...advertised] }).describe('Operation to perform')
}

/** The advertised actions of a spec (hidden legacy aliases excluded). */
export function advertisedActions(spec: Pick<AliasableSpec, 'inputSchema' | 'aliases'>): string[] {
  const field = spec.inputSchema.action
  if (!(field instanceof z.ZodEnum)) return []
  const hidden = new Set(Object.keys(spec.aliases ?? {}))
  return (field.options as string[]).filter((action) => !hidden.has(action))
}

/** Mapped call for an alias action, or null when `args.action` is not an alias. */
export function aliasCall(spec: AliasableSpec, specs: readonly AliasableSpec[], args: Record<string, unknown>): ResolvedAlias | null {
  const action = typeof args.action === 'string' ? args.action : null
  const alias = action ? spec.aliases?.[action] : undefined
  if (!alias) return null
  const target = specs.find((candidate) => candidate.name === alias.tool)
  if (!target) throw new Error(`Alias ${spec.name}(${action}) points at unknown tool ${alias.tool}.`)
  return { spec: target, args: { ...(alias.args ?? {}), ...args, action: alias.action } }
}

/**
 * Wire every spec's aliases to their targets: tier, Intent exception and
 * handler of an alias action are the target's. Mutates and returns `specs`
 * (called once while building the catalog). Throws on a dangling alias.
 */
export function linkAliases<S extends AliasableSpec>(specs: S[]): S[] {
  for (const spec of specs) {
    if (!spec.aliases || spec.resolveAlias) continue
    for (const [action, alias] of Object.entries(spec.aliases)) {
      const target = specs.find((candidate) => candidate.name === alias.tool)
      if (!target) throw new Error(`Alias ${spec.name}(${action}) points at unknown tool ${alias.tool}.`)
      if (target.aliases?.[alias.action]) throw new Error(`Alias ${spec.name}(${action}) points at another alias.`)
    }
    const own = { tier: spec.tier, handler: spec.handler, tierException: spec.tierException }
    const resolve = (args: Record<string, unknown>) => aliasCall(spec, specs, args)
    spec.resolveAlias = resolve
    spec.tier = (args) => {
      const routed = resolve(args)
      const tier = routed ? routed.spec.tier : own.tier
      const callArgs = routed ? routed.args : args
      return typeof tier === 'function' ? tier(callArgs) : tier
    }
    spec.handler = (ctx, args) => {
      const routed = resolve(args)
      return routed ? routed.spec.handler(ctx, routed.args) : own.handler(ctx, args)
    }
    spec.tierException = (ctx, args) => {
      const routed = resolve(args)
      const exception = routed ? routed.spec.tierException : own.tierException
      return exception ? exception(ctx, routed ? routed.args : args) : false
    }
  }
  return specs
}

const present = (value: unknown) => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())

/** Human list of the fields an action takes, e.g. `jobId (required), limit`. */
export function describeActionFields(fields: ActionFields): string {
  const parts = [
    ...(fields.required ?? []).map((field) => `${field} (required)`),
    ...(fields.oneOf?.length ? [`one of ${fields.oneOf.join('/')}`] : []),
    ...(fields.optional ?? []),
  ]
  return parts.length ? parts.join(', ') : 'no arguments besides projectId'
}

/**
 * Runtime per-action validation. Missing required fields fail with
 * `invalid_input` listing what the action takes; fields the action ignores are
 * tolerated (older clients send them) and simply not forwarded by the handler.
 */
export function validateActionArgs(tool: string, fields: Record<string, ActionFields> | undefined, args: Record<string, unknown>): void {
  const action = typeof args.action === 'string' ? args.action : null
  const spec = action ? fields?.[action] : undefined
  if (!action || !spec) return
  const missing = (spec.required ?? []).filter((field) => !present(args[field]))
  const needsOne = spec.oneOf?.length && !spec.oneOf.some((field) => present(args[field]))
  if (!missing.length && !needsOne) return
  const what = [
    ...(missing.length ? [`missing ${missing.map((field) => `"${field}"`).join(', ')}`] : []),
    ...(needsOne ? [`needs one of ${spec.oneOf!.map((field) => `"${field}"`).join(', ')}`] : []),
  ].join('; ')
  throw new McpToolError('invalid_input', `${tool}(${action}) ${what}. It takes: ${describeActionFields(spec)}.`, {
    next: [{ tool: 'specrails_describe', args: { name: tool }, why: 'Every action with the arguments it takes.' }],
  })
}
