import { z, type ZodRawShape } from 'zod'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { COMMON_FIELD_BRIEFS, TOOL_BRIEFS } from './wire-briefs'
import type { ActionFields } from './actions'

/**
 * The compact `tools/list` form of a tool (what a client's model reads on every
 * turn). Only text changes: the zod validators are the same instances' clones,
 * so the wire schema accepts exactly what the full one accepts.
 *
 * - The tool and field descriptions become their briefs (./wire-briefs.ts).
 * - The `action` field lists the required arguments per action when the tool
 *   declares them (`actionFields`); otherwise the enum speaks for itself.
 * - `$schema` and the ±2^53 bounds zod emits for every integer are dropped from
 *   the advertised JSON; the server still validates them.
 *
 * The complete descriptions stay on the spec for `specrails_describe`,
 * `specrails_search` and the destructive-effect text.
 */

const SAFE = Number.MAX_SAFE_INTEGER

interface WireSpec {
  name: string
  description: string
  inputSchema: ZodRawShape
  actionFields?: Record<string, ActionFields>
  aliases?: Record<string, unknown>
}

/** The outermost `.describe()` text of a field, through optional/default/nullable wrappers. */
export function fieldDescription(field: z.ZodTypeAny): string | undefined {
  let current: z.ZodTypeAny | undefined = field
  for (let depth = 0; current && depth < 8; depth++) {
    if (current.description !== undefined) return current.description
    const inner: z.ZodTypeAny | undefined = (current as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType
    current = inner
  }
  return undefined
}

export function wireToolDescription(spec: Pick<WireSpec, 'name' | 'description'>): string {
  return TOOL_BRIEFS[spec.name]?.description ?? spec.description
}

/** Required arguments per action, grouped: `get, logs: jobId; spawn: command`. */
export function actionRequiredBrief(spec: Pick<WireSpec, 'actionFields' | 'aliases'>, advertised: readonly string[]): string | undefined {
  if (!spec.actionFields) return undefined
  const groups = new Map<string, string[]>()
  for (const action of advertised) {
    const fields = spec.actionFields[action]
    if (!fields) continue
    const parts = [...(fields.required ?? []), ...(fields.oneOf?.length ? [fields.oneOf.join('|')] : [])]
    if (!parts.length) continue
    const key = parts.join(', ')
    groups.set(key, [...(groups.get(key) ?? []), action])
  }
  if (!groups.size) return undefined
  return `Required: ${[...groups].map(([fields, actions]) => `${actions.join(', ')}: ${fields}`).join('; ')}`
}

/** The wire text of one field ('' drops it). */
export function wireFieldBrief(spec: Pick<WireSpec, 'name' | 'actionFields' | 'aliases'>, name: string, field: z.ZodTypeAny): string | undefined {
  if (name === 'action') {
    const options = field instanceof z.ZodEnum ? (field.options as string[]) : []
    const hidden = new Set(Object.keys(spec.aliases ?? {}))
    return actionRequiredBrief(spec, options.filter((action) => !hidden.has(action)))
  }
  const brief = TOOL_BRIEFS[spec.name]?.fields?.[name] ?? COMMON_FIELD_BRIEFS[name] ?? fieldDescription(field)
  return brief ? brief : undefined
}

function safeIntBounds(field: z.ZodTypeAny): Record<string, undefined> {
  try {
    const json = toJsonSchemaCompat(z.object({ field })) as { properties?: Record<string, { minimum?: number; maximum?: number }> }
    const property = json.properties?.field
    return {
      ...(property?.minimum === -SAFE ? { minimum: undefined } : {}),
      ...(property?.maximum === SAFE ? { maximum: undefined } : {}),
    }
  } catch {
    return {}
  }
}

/** Wire input shape: same validators, brief descriptions. */
export function wireInputShape(spec: WireSpec): ZodRawShape {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [name, raw] of Object.entries(spec.inputSchema)) {
    const field = raw as z.ZodTypeAny
    const meta = { ...(field.meta() ?? {}), description: wireFieldBrief(spec, name, field), ...safeIntBounds(field) }
    shape[name] = field.meta(meta as Record<string, unknown>)
  }
  return shape
}

/** Wire input object: the shape without `$schema`, loose for a tool that still accepts moved actions. */
export function wireInputObject(spec: WireSpec) {
  const object = z.object(wireInputShape(spec))
  return (spec.aliases ? object.loose() : object).meta({ $schema: undefined } as Record<string, unknown>)
}

// ── Per-action field docs (specrails_describe(name, action)) ──────────────────

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Actions a field's full description names (`update/commit_draft: …`, `(for get / update)`, `*_addendum`). */
export function actionsNamedBy(description: string | undefined, actions: readonly string[]): string[] {
  if (!description) return []
  return actions.filter((action) => {
    if (new RegExp(`(^|[^a-z0-9_.])${escape(action)}($|[^a-z0-9_])`, 'i').test(description)) return true
    const wildcard = /\*(_[a-z]+)/i.exec(description)
    return wildcard ? action.endsWith(wildcard[1]) : false
  })
}

/**
 * The fields of one action: those `actionFields` declares, those whose full
 * description names it, and the general ones (that name no action at all).
 */
export function fieldsForAction(spec: Pick<WireSpec, 'inputSchema' | 'actionFields'>, actions: readonly string[], action: string): string[] {
  const declared = spec.actionFields?.[action]
  const listed = new Set([...(declared?.required ?? []), ...(declared?.oneOf ?? []), ...(declared?.optional ?? [])])
  return Object.entries(spec.inputSchema).filter(([name, raw]) => {
    if (name === 'action') return false
    if (listed.has(name)) return true
    const named = actionsNamedBy(fieldDescription(raw as z.ZodTypeAny), actions)
    return named.length ? named.includes(action) : true
  }).map(([name]) => name)
}
