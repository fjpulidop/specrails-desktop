import { z } from 'zod'
import { V2ToolError } from './envelope'

/**
 * Views and the common input fields every v2 tool shares (same names, same
 * meaning, ≤ 8 words of description each, so the catalog stays small).
 *
 * - `view: summary` (default) is the lean shape; `detail` adds the sections
 *   named in `fields` (all of them when `fields` is omitted).
 * - Rare arguments go in `options` (documented by `specrails_system(help)`),
 *   never as new top-level fields.
 */

export const VIEWS = ['summary', 'detail'] as const
export type View = (typeof VIEWS)[number]

export function resolveView(args: Record<string, unknown>): View {
  return args.view === 'detail' ? 'detail' : 'summary'
}

/**
 * Detail sections to include: `fields` restricted to `allowed`; every allowed
 * section when `fields` is absent and the view is detail; none for summary.
 * An unknown section fails with the allowed list.
 */
export function resolveFields<F extends string>(args: Record<string, unknown>, allowed: readonly F[]): F[] {
  const requested = Array.isArray(args.fields) ? args.fields.filter((value): value is string => typeof value === 'string') : null
  if (!requested) return resolveView(args) === 'detail' ? [...allowed] : []
  const unknown = requested.filter((field) => !(allowed as readonly string[]).includes(field))
  if (unknown.length) throw new V2ToolError('invalid_input', `Unknown fields ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`)
  return requested as F[]
}

/** The `options` object of a call (rare fields), never null. */
export function optionsOf(args: Record<string, unknown>): Record<string, unknown> {
  const value = args.options
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Control fields the framework consumes; never part of a confirmation binding or forwarded to routes. */
export const CONTROL_FIELDS = ['confirm', 'dryRun', 'lang', 'view', 'fields', 'cursor', 'limit'] as const

/** Shared field definitions. Tools spread the ones they take into their shape. */
export const F = {
  project: z.string().describe('Project id, slug, name or path'),
  ref: z.string().describe('Global ref, e.g. run:shop/8f3c'),
  refs: z.array(z.string()).describe('Global refs'),
  view: z.enum(VIEWS).describe('Default summary'),
  fields: <const T extends readonly [string, ...string[]]>(sections: T) => z.array(z.enum(sections)).describe('Detail sections'),
  cursor: z.string().describe('From page.cursor'),
  limit: z.number().int().min(1).max(100),
  lang: z.string().describe('Reply language code, e.g. es'),
  confirm: z.string().describe('confirmToken from the preview'),
  dryRun: z.boolean().describe('Preview only'),
  options: z.looseObject({}).describe('Rare fields; see specrails_system help'),
  filter: z.looseObject({}),
  /** A free-form object argument (advertised as a bare object). */
  object: () => z.looseObject({}),
} as const

/** The fields of a read/list tool. */
export const READ_FIELDS = { project: F.project, ref: F.ref, view: F.view, cursor: F.cursor, limit: F.limit, lang: F.lang }
/** The fields of a tool with mutating actions (adds confirmation and options). */
export const WRITE_FIELDS = { ...READ_FIELDS, confirm: F.confirm, dryRun: F.dryRun, options: F.options }
