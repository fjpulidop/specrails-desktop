// Pure, I/O-free renderer for the read-only "Jira details" panel: turns a raw
// issue field map (fields=*all) + /field metadata into an ordered list of
// populated, non-skipped { label, value, href? } rows. Also normalizes the
// dev-status (PR/branch/commit) payloads. NEVER throws — bad shapes are dropped.

import { adfToText } from './jira-adf'
import { issueUrl } from './jira-materializer'
import type {
  JiraDetailField,
  JiraDevBranch,
  JiraDevCommit,
  JiraDevPullRequest,
  JiraFieldMeta,
} from './types'
import type { JiraDevDetailRaw } from './jira-client'

/** System fields the modal already shows OR that are noise — never rendered. */
export const SKIP_SYSTEM_FIELDS = new Set<string>([
  // already shown by the modal / card
  'summary', 'description', 'status', 'priority', 'labels', 'assignee',
  // identity / housekeeping
  'project', 'key', 'id', 'self', 'expand', 'thumbnail', 'lastViewed',
  'statuscategorychangedate', 'workratio', 'issuerestriction', 'issuekey',
  // aggregates / progress (covered by timetracking)
  'aggregatetimespent', 'aggregatetimeestimate', 'aggregatetimeoriginalestimate',
  'aggregateprogress', 'progress', 'timeoriginalestimate', 'timeestimate', 'timespent',
  // heavy / out-of-scope content blocks
  'comment', 'worklog', 'attachment',
  // footer already shows local created/updated
  'created', 'updated',
])

// Custom-field schema.custom suffixes we recognise (never hardcode customfield_NNN).
const STORY_POINTS = [':float', ':jsw-story-points', ':story-point-estimate']
const EPIC_LINK = 'com.pyxis.greenhopper.jira:gh-epic-link'
const EPIC_NAME = 'com.pyxis.greenhopper.jira:gh-epic-label'
const FLAGGED = [':gh-jira-flag', ':greenhopper-flagged-field']
const TEAM = [':atlassian-team', ':rm-teams-custom-field-team']
const SPRINT = 'com.pyxis.greenhopper.jira:gh-sprint'
const RANK = [':gh-lexo-rank', ':lexorank']

/**
 * Custom-field schema.custom substrings whose VALUE is an internal serialized
 * blob (not human content) — must never render as a "field". The Development
 * summary field is the prime case: its branches/PRs/commits are surfaced in the
 * dedicated Development section via the dev-status API, not as a raw blob row.
 */
const SKIP_CUSTOM_SCHEMA = [
  'jira-development-integration-plugin', // Development summary (devsummary / devsummarycf)
  ':devsummary',
  ':global-rank',
  ':aozoraplugin', // misc internal aggregates seen on some instances
]

function isSkippedCustomSchema(custom?: string): boolean {
  return !!custom && SKIP_CUSTOM_SCHEMA.some((s) => custom.includes(s))
}

/** A populated string value that is actually a serialized object/map blob. */
function looksLikeSerializedBlob(value: string): boolean {
  return /^\s*[{[]/.test(value)
}

export function indexFieldMeta(meta: JiraFieldMeta[]): Map<string, JiraFieldMeta> {
  const m = new Map<string, JiraFieldMeta>()
  for (const f of meta) if (f && typeof f.id === 'string') m.set(f.id, f)
  return m
}

/** Resolve a custom field id by schema.custom suffix OR exact name. null when absent. */
export function resolveCustomFieldId(
  meta: Map<string, JiraFieldMeta>,
  opts: { customEndsWith?: string[]; names?: string[] }
): string | null {
  const names = (opts.names ?? []).map((n) => n.toLowerCase())
  for (const f of meta.values()) {
    const custom = f.schema?.custom
    if (custom && (opts.customEndsWith ?? []).some((s) => custom.endsWith(s) || custom === s)) return f.id
    if (f.name && names.includes(f.name.toLowerCase())) return f.id
  }
  return null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Title-case a field key for the label fallback when /field metadata is missing. */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Render a scalar/object value by schema, or by shape when schema is absent. Returns
 *  the display string, or null when the value is empty/unpopulated. */
function scalarDisplay(raw: unknown, schemaType?: string): string | null {
  if (raw == null) return null
  switch (schemaType) {
    case 'user':
      return userName(raw)
    case 'priority':
    case 'status':
    case 'resolution':
    case 'issuetype':
    case 'securitylevel':
    case 'component':
    case 'version':
      return isPlainObject(raw) ? str(raw.name) : null
    case 'option':
    case 'option-with-child': {
      if (!isPlainObject(raw)) return null
      const base = str(raw.value) ?? str(raw.name)
      const child = isPlainObject(raw.child) ? str(raw.child.value) ?? str(raw.child.name) : null
      return base ? (child ? `${base} / ${child}` : base) : null
    }
    case 'votes':
      return isPlainObject(raw) && typeof raw.votes === 'number' && raw.votes > 0 ? String(raw.votes) : null
    case 'watches':
      return isPlainObject(raw) && typeof raw.watchCount === 'number' && raw.watchCount > 0 ? String(raw.watchCount) : null
    case 'timetracking':
      return timetracking(raw)
    case 'number':
      return typeof raw === 'number' ? String(raw) : null
    case 'date':
    case 'datetime':
      return typeof raw === 'string' && raw.trim() ? raw : null
    case 'string':
      return text(raw)
    default:
      return sniff(raw)
  }
}

/** Shape-sniff a value with no usable schema (covers many custom fields). */
function sniff(raw: unknown): string | null {
  if (typeof raw === 'string') return text(raw)
  if (typeof raw === 'number') return String(raw)
  if (typeof raw === 'boolean') return raw ? 'Yes' : null
  if (Array.isArray(raw)) {
    const parts = raw.map((x) => sniff(x)).filter((x): x is string => !!x)
    return parts.length ? parts.join(', ') : null
  }
  if (isPlainObject(raw)) {
    return str(raw.value) ?? str(raw.name) ?? str(raw.displayName) ?? userName(raw)
  }
  return null
}

function userName(raw: unknown): string | null {
  if (!isPlainObject(raw)) return null
  return str(raw.displayName) ?? str(raw.emailAddress) ?? str(raw.name)
}

function text(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    // ADF rich text (e.g. environment on Cloud).
    if (isPlainObject(raw) && raw.type === 'doc') {
      const t = adfToText(raw).trim()
      return t || null
    }
    return null
  }
  const t = raw.trim()
  return t || null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function timetracking(raw: unknown): string | null {
  if (!isPlainObject(raw)) return null
  const lines: string[] = []
  if (str(raw.originalEstimate)) lines.push(`Original: ${raw.originalEstimate}`)
  if (str(raw.remainingEstimate)) lines.push(`Remaining: ${raw.remainingEstimate}`)
  if (str(raw.timeSpent)) lines.push(`Spent: ${raw.timeSpent}`)
  return lines.length ? lines.join('\n') : null
}

function arrayDisplay(raw: unknown[], itemType?: string): string | null {
  if (raw.length === 0) return null
  let parts: string[]
  switch (itemType) {
    case 'string':
      parts = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      break
    case 'user':
      parts = raw.map(userName).filter((x): x is string => !!x)
      break
    case 'component':
    case 'version':
      parts = raw.map((x) => (isPlainObject(x) ? str(x.name) : null)).filter((x): x is string => !!x)
      break
    case 'option':
      parts = raw.map((x) => (isPlainObject(x) ? str(x.value) ?? str(x.name) : null)).filter((x): x is string => !!x)
      break
    default:
      parts = raw.map((x) => sniff(x)).filter((x): x is string => !!x)
  }
  return parts.length ? parts.join(', ') : null
}

interface Ctx {
  meta: Map<string, JiraFieldMeta>
  baseUrl: string
}

function labelFor(key: string, ctx: Ctx): string {
  return ctx.meta.get(key)?.name ?? humanizeKey(key)
}

/** PURE. Ordered, populated, non-skipped detail rows for the read-only panel. */
export function formatIssueFields(input: {
  fields: Record<string, unknown>
  fieldMeta: JiraFieldMeta[]
  baseUrl: string
  alreadyShown: { hasEpicKey: boolean; hasSprintName: boolean }
}): JiraDetailField[] {
  const f = input.fields ?? {}
  const ctx: Ctx = { meta: indexFieldMeta(input.fieldMeta ?? []), baseUrl: input.baseUrl }
  const rows: JiraDetailField[] = []
  const handled = new Set<string>()

  const push = (key: string, schemaType: string | undefined, opts?: { label?: string }) => {
    handled.add(key)
    const value = scalarDisplay(f[key], schemaType)
    if (value != null) rows.push({ label: opts?.label ?? labelFor(key, ctx), value })
  }
  const pushArray = (key: string, itemType: string | undefined, opts?: { label?: string }) => {
    handled.add(key)
    const v = f[key]
    if (!Array.isArray(v)) return
    const value = arrayDisplay(v, itemType)
    if (value != null) rows.push({ label: opts?.label ?? labelFor(key, ctx), value })
  }

  // ── Ordered system fields ──────────────────────────────────────────────────
  push('issuetype', 'issuetype')
  push('resolution', 'resolution')
  push('reporter', 'user')
  // creator: suppress when identical to reporter.
  handled.add('creator')
  {
    const creator = userName(f.creator)
    const reporter = userName(f.reporter)
    if (creator && creator !== reporter) rows.push({ label: labelFor('creator', ctx), value: creator })
  }
  pushArray('components', 'component')
  pushArray('fixVersions', 'version')
  pushArray('versions', 'version')
  push('environment', 'string')
  // parent: only when it is NOT an epic (epic parent is shown as jira_epic_key).
  handled.add('parent')
  {
    const p = f.parent
    if (isPlainObject(p)) {
      const itype = isPlainObject(p.fields) && isPlainObject(p.fields.issuetype) ? str(p.fields.issuetype.name) : null
      const key = str(p.key)
      if (key && (itype ?? '').toLowerCase() !== 'epic') {
        const summary = isPlainObject(p.fields) ? str(p.fields.summary) : null
        rows.push({ label: labelFor('parent', ctx), value: summary ? `${key} — ${summary}` : key, href: issueUrl(ctx.baseUrl, key) })
      }
    }
  }
  // subtasks: headline count + one linked row each.
  handled.add('subtasks')
  if (Array.isArray(f.subtasks) && f.subtasks.length > 0) {
    rows.push({ label: labelFor('subtasks', ctx), value: `${f.subtasks.length} sub-tasks` })
    for (const s of f.subtasks) {
      if (!isPlainObject(s)) continue
      const key = str(s.key)
      if (!key) continue
      const summary = isPlainObject(s.fields) ? str(s.fields.summary) : null
      rows.push({ label: key, value: summary ?? key, href: issueUrl(ctx.baseUrl, key) })
    }
  }
  // issuelinks: one row per linked issue, labelled by the relationship.
  handled.add('issuelinks')
  if (Array.isArray(f.issuelinks)) {
    for (const link of f.issuelinks) {
      if (!isPlainObject(link) || !isPlainObject(link.type)) continue
      const out = isPlainObject(link.outwardIssue) ? link.outwardIssue : null
      const inw = isPlainObject(link.inwardIssue) ? link.inwardIssue : null
      const rel = out ? str(link.type.outward) : str(link.type.inward)
      const issue = out ?? inw
      if (!issue) continue
      const key = str(issue.key)
      if (!key) continue
      const summary = isPlainObject(issue.fields) ? str(issue.fields.summary) : null
      rows.push({ label: rel ?? labelFor('issuelinks', ctx), value: summary ? `${key} — ${summary}` : key, href: issueUrl(ctx.baseUrl, key) })
    }
  }
  push('duedate', 'date')
  push('resolutiondate', 'datetime')
  push('security', 'securitylevel', { label: labelFor('security', ctx) })
  push('votes', 'votes')
  push('watches', 'watches')
  push('timetracking', 'timetracking')

  // ── Resolved custom fields ──────────────────────────────────────────────────
  const sp = resolveCustomFieldId(ctx.meta, { customEndsWith: STORY_POINTS, names: ['Story Points', 'Story point estimate'] })
  if (sp && typeof f[sp] === 'number') { handled.add(sp); rows.push({ label: ctx.meta.get(sp)?.name ?? 'Story Points', value: String(f[sp]) }) }

  if (!input.alreadyShown.hasEpicKey) {
    const el = resolveCustomFieldId(ctx.meta, { customEndsWith: [EPIC_LINK] })
    if (el && str(f[el])) { handled.add(el); const key = str(f[el])!; rows.push({ label: ctx.meta.get(el)?.name ?? 'Epic Link', value: key, href: issueUrl(ctx.baseUrl, key) }) }
    const en = resolveCustomFieldId(ctx.meta, { customEndsWith: [EPIC_NAME] })
    if (en && str(f[en])) { handled.add(en); rows.push({ label: ctx.meta.get(en)?.name ?? 'Epic Name', value: str(f[en])! }) }
  }
  const flag = resolveCustomFieldId(ctx.meta, { customEndsWith: FLAGGED, names: ['Flagged'] })
  if (flag && Array.isArray(f[flag]) && (f[flag] as unknown[]).length > 0) { handled.add(flag); rows.push({ label: ctx.meta.get(flag)?.name ?? 'Flagged', value: 'Impediment' }) }
  const team = resolveCustomFieldId(ctx.meta, { customEndsWith: TEAM, names: ['Team'] })
  if (team) { handled.add(team); const v = f[team]; const name = isPlainObject(v) ? str(v.name) ?? str(v.title) ?? str(v.value) : str(v); if (name) rows.push({ label: ctx.meta.get(team)?.name ?? 'Team', value: name }) }

  // Mark sprint + rank custom fields handled so the generic sweep skips them.
  for (const id of [
    resolveCustomFieldId(ctx.meta, { customEndsWith: [SPRINT] }),
    resolveCustomFieldId(ctx.meta, { customEndsWith: RANK }),
  ]) if (id) handled.add(id)

  // ── Generic sweep: any remaining populated custom field ─────────────────────
  const sweep: JiraDetailField[] = []
  for (const key of Object.keys(f)) {
    if (handled.has(key) || SKIP_SYSTEM_FIELDS.has(key) || !key.startsWith('customfield_')) continue
    const meta = ctx.meta.get(key)
    const schema = meta?.schema
    // Skip internal serialized-blob custom fields (e.g. the Development summary —
    // its PRs/branches/commits are surfaced in the Development section instead).
    if (isSkippedCustomSchema(schema?.custom)) continue
    const value =
      Array.isArray(f[key]) ? arrayDisplay(f[key] as unknown[], schema?.items)
      : scalarDisplay(f[key], schema?.type)
    // Defensive: a value that is a serialized object/map blob is not human content.
    if (value != null && !looksLikeSerializedBlob(value)) sweep.push({ label: labelFor(key, ctx), value })
  }
  sweep.sort((a, b) => a.label.localeCompare(b.label))
  rows.push(...sweep)

  return rows
}

// ─── Development (dev-status) normalizers ──────────────────────────────────────

function mapCommit(raw: unknown): JiraDevCommit | null {
  if (!isPlainObject(raw)) return null
  const url = str(raw.url)
  if (!url) return null
  return {
    id: str(raw.id) ?? '',
    displayId: str(raw.displayId) ?? (str(raw.id) ?? '').slice(0, 7),
    message: str(raw.message) ?? '',
    url,
    author: isPlainObject(raw.author) ? str(raw.author.name) : null,
    timestamp: str(raw.authorTimestamp) ?? str(raw.timestamp) ?? null,
  }
}

export function normalizePullRequests(detail: JiraDevDetailRaw): JiraDevPullRequest[] {
  const out: JiraDevPullRequest[] = []
  for (const d of detail?.detail ?? []) {
    for (const pr of (isPlainObject(d) && Array.isArray(d.pullRequests) ? d.pullRequests : [])) {
      if (!isPlainObject(pr)) continue
      const url = str(pr.url)
      if (!url) continue
      out.push({
        id: str(pr.id) ?? '',
        title: str(pr.name) ?? str(pr.id) ?? '',
        url,
        status: str(pr.status) ?? 'UNKNOWN',
        sourceBranch: isPlainObject(pr.source) ? str(pr.source.branch) : null,
        destBranch: isPlainObject(pr.destination) ? str(pr.destination.branch) : null,
        author: isPlainObject(pr.author) ? str(pr.author.name) : null,
        lastUpdate: str(pr.lastUpdate) ?? null,
      })
    }
  }
  return out
}

export function normalizeBranches(detail: JiraDevDetailRaw): JiraDevBranch[] {
  const out: JiraDevBranch[] = []
  for (const d of detail?.detail ?? []) {
    for (const b of (isPlainObject(d) && Array.isArray(d.branches) ? d.branches : [])) {
      if (!isPlainObject(b)) continue
      const url = str(b.url)
      if (!url) continue
      out.push({
        name: str(b.name) ?? '',
        url,
        createPullRequestUrl: str(b.createPullRequestUrl) ?? null,
        repo: isPlainObject(b.repository) ? str(b.repository.name) : null,
        repoUrl: isPlainObject(b.repository) ? str(b.repository.url) : null,
        lastCommit: mapCommit(b.lastCommit),
      })
    }
  }
  return out
}

export function normalizeRepositoryCommits(detail: JiraDevDetailRaw): JiraDevCommit[] {
  const out: JiraDevCommit[] = []
  for (const d of detail?.detail ?? []) {
    for (const repo of (isPlainObject(d) && Array.isArray(d.repositories) ? d.repositories : [])) {
      if (!isPlainObject(repo) || !Array.isArray(repo.commits)) continue
      for (const c of repo.commits) {
        const mapped = mapCommit(c)
        if (mapped) out.push(mapped)
        if (out.length >= 50) return out
      }
    }
  }
  return out
}
