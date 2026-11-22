import path from 'path'
import os from 'os'
import type { ProjectRow } from '../../../desktop-db'
import { V2ToolError } from './envelope'
import type { Translate } from './lang'

/**
 * Global refs: one string names any entity across projects.
 *
 *   project-scoped: `<kind>:<projectSlug>/<id>`   e.g. `run:shop-api/8f3c…`, `spec:shop-api/142`
 *   app-global:     `<kind>:<id>`                 e.g. `mission:c_91…`, `inbox:item-7`
 *
 * Any action accepts a ref without `project`; a bare id needs `project` or the
 * session default. Ids with characters outside `[A-Za-z0-9._~:@-]` are
 * percent-encoded, so a ref never contains a second `/` or whitespace.
 */

export const REF_KINDS = {
  project: 'global',
  run: 'project',
  spec: 'project',
  delivery: 'project',
  chain: 'project',
  milestone: 'project',
  rail: 'project',
  intent: 'project',
  addendum: 'project',
  attachment: 'project',
  repository: 'project',
  mission: 'global',
  chat: 'global',
  inbox: 'global',
  blueprint: 'global',
  loop: 'global',
  profile: 'global',
  plugin: 'global',
} as const

export type RefKind = keyof typeof REF_KINDS
/** The serialized ref string. */
export type Ref = string

export interface ParsedRef {
  kind: RefKind
  /** Project slug (or id) of a project-scoped ref; absent for app-global kinds. */
  project?: string
  id: string
}

const SAFE_ID = /^[A-Za-z0-9._~:@-]+$/
const encodeId = (id: string) => SAFE_ID.test(id) ? id : encodeURIComponent(id)

export function isRefKind(value: string): value is RefKind {
  return Object.prototype.hasOwnProperty.call(REF_KINDS, value)
}

/** `formatRef('run', '8f3c', 'shop')` → `run:shop/8f3c`. A project-scoped kind requires the project. */
export function formatRef(kind: RefKind, id: string | number, project?: string | null): Ref {
  const value = encodeId(String(id))
  if (REF_KINDS[kind] === 'global') return `${kind}:${value}`
  if (!project) throw new Error(`formatRef(${kind}) needs a project slug.`)
  return `${kind}:${encodeId(project)}/${value}`
}

/** Parsed ref, or null when the string is not a ref (a bare id). */
export function parseRef(value: unknown): ParsedRef | null {
  if (typeof value !== 'string') return null
  const match = /^([a-z]+):(.+)$/.exec(value.trim())
  if (!match || !isRefKind(match[1])) return null
  const kind = match[1]
  const rest = match[2]
  if (REF_KINDS[kind] === 'global') {
    if (rest.includes('/')) return null
    return { kind, id: decodeURIComponent(rest) }
  }
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1 || rest.indexOf('/', slash + 1) !== -1) return null
  return { kind, project: decodeURIComponent(rest.slice(0, slash)), id: decodeURIComponent(rest.slice(slash + 1)) }
}

// ── Project resolution ──────────────────────────────────────────────────────

export interface ProjectChoice { project: Ref; id: string; slug: string; name: string }

const choiceOf = (row: ProjectRow): ProjectChoice => ({ project: formatRef('project', row.slug), id: row.id, slug: row.slug, name: row.name })
const normalizePath = (value: string) => path.resolve(value.replace(/^~(?=$|\/)/, os.homedir())).replace(/\/+$/, '')

/**
 * Fuzzy project selector: exact id, slug, `project:<slug>` ref, name
 * (case-insensitive) or path; then a unique prefix/substring of slug or name.
 * Several matches → `ambiguous` with `choices`; none → `not_found` with choices.
 */
export function resolveProjectSelector(rows: readonly ProjectRow[], selector: string, translate: Translate): ProjectRow {
  const raw = selector.trim()
  const asRef = parseRef(raw)
  const needle = asRef?.kind === 'project' ? asRef.id : raw
  const lower = needle.toLowerCase()
  const exact = rows.find((row) => row.id === needle || row.slug === needle)
    ?? rows.find((row) => row.name.toLowerCase() === lower)
    ?? (/[/\\~]/.test(needle) ? rows.find((row) => normalizePath(row.path) === normalizePath(needle)) : undefined)
  if (exact) return exact
  const partial = rows.filter((row) => row.slug.toLowerCase().startsWith(lower) || row.name.toLowerCase().startsWith(lower))
  const candidates = partial.length ? partial : rows.filter((row) => row.slug.toLowerCase().includes(lower) || row.name.toLowerCase().includes(lower))
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    throw new V2ToolError('ambiguous', translate('core.error.ambiguous_project', { selector: raw }), { choices: candidates.slice(0, 10).map(choiceOf) })
  }
  throw new V2ToolError('not_found', translate('core.error.unknown_project', { selector: raw }), { choices: rows.slice(0, 10).map(choiceOf) })
}

export interface ScopeInput {
  /** `ref` argument (a ref or a bare id). */
  ref?: unknown
  /** `project` argument. */
  project?: unknown
  /** Mission pin (verified in-app capability): wins over the session default. */
  pinnedProjectId?: string | null
  /** `projects(select)` default of this MCP session. */
  sessionProjectId?: string | null
}

export interface Target {
  kind: RefKind
  id: string
  /** Null for app-global kinds. */
  project: ProjectRow | null
  /** The canonical ref (slug form). */
  ref: Ref
}

/** The project a call targets: explicit `project`, else the pin, else the session default; null when none. */
export function resolveProject(rows: readonly ProjectRow[], input: Pick<ScopeInput, 'project' | 'pinnedProjectId' | 'sessionProjectId'>, translate: Translate): ProjectRow | null {
  if (typeof input.project === 'string' && input.project.trim()) return resolveProjectSelector(rows, input.project, translate)
  const fallback = input.pinnedProjectId ?? input.sessionProjectId ?? null
  if (!fallback) return null
  return rows.find((row) => row.id === fallback) ?? resolveProjectSelector(rows, fallback, translate)
}

/** `resolveProject`, failing with `ambiguous` + choices when no project applies. */
export function requireProjectRow(rows: readonly ProjectRow[], input: Pick<ScopeInput, 'project' | 'pinnedProjectId' | 'sessionProjectId'>, translate: Translate): ProjectRow {
  const row = resolveProject(rows, input, translate)
  if (!row) throw new V2ToolError('ambiguous', translate('core.error.no_project'), { choices: rows.slice(0, 10).map(choiceOf) })
  return row
}

/**
 * The entity a call addresses. `ref` may be a full ref (its project wins over
 * every default; `project`, when also given, must agree) or a bare id of
 * `defaultKind` scoped by `project` / pin / session default. `kinds` restricts
 * the accepted kinds.
 */
export function resolveTarget(rows: readonly ProjectRow[], input: ScopeInput & { defaultKind: RefKind; kinds?: readonly RefKind[]; label: string }, translate: Translate): Target {
  const raw = typeof input.ref === 'number' ? String(input.ref) : input.ref
  if (typeof raw !== 'string' || !raw.trim()) throw new V2ToolError('invalid_input', translate('core.error.missing_fields', { label: input.label, missing: translate('core.error.missing_list', { fields: '"ref"' }), takes: 'ref' }))
  const parsed = parseRef(raw)
  if (!parsed && /^[a-z]+:/.test(raw.trim()) && isRefKind(raw.trim().split(':')[0])) {
    throw new V2ToolError('invalid_input', translate('core.error.bad_ref', { ref: raw }))
  }
  const kind = parsed?.kind ?? input.defaultKind
  const allowed = input.kinds ?? [input.defaultKind]
  if (!allowed.includes(kind)) throw new V2ToolError('invalid_input', translate('core.error.wrong_ref_kind', { label: input.label, expected: allowed.join('/'), kind }))
  const id = parsed?.id ?? raw.trim()
  if (REF_KINDS[kind] === 'global') return { kind, id, project: null, ref: formatRef(kind, id) }
  const project = parsed?.project
    ? resolveProjectSelector(rows, parsed.project, translate)
    : requireProjectRow(rows, input, translate)
  if (parsed?.project && typeof input.project === 'string' && input.project.trim()) {
    const explicit = resolveProjectSelector(rows, input.project, translate)
    if (explicit.id !== project.id) throw new V2ToolError('invalid_input', `ref ${raw} belongs to ${project.slug}, not ${explicit.slug}.`)
  }
  return { kind, id, project, ref: formatRef(kind, id, project.slug) }
}
