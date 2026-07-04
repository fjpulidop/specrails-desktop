/**
 * Conventional naming for the safe-pr-review-flow's user-facing git surface:
 * branch names and PR titles. Pure string logic (no git/db IO) so the whole
 * matrix is unit-testable; callers thread ticket data (title/labels/jira key)
 * in and run the collision predicate against their own branch listing.
 *
 * Branch conventions:
 *   per-unit  →  `<type>/<ref>-<kebab-title>`   e.g. feat/SKILLS-101-add-dark-mode
 *   batch     →  `<type>/<primary-ref>-batch-<n>-tickets`
 *
 * PR title conventions:
 *   single    →  `[<ref>]<type> - <change>`      e.g. [SKILLS-101]feat - darkmode added
 *   batch     →  `[<ref> +<n-1>]<type> - <loop-level summary>`
 *
 * `<ref>` is the ticket's Jira key when Jira-linked (JIRA ALWAYS PREVAILS —
 * resolved by the caller from the authoritative `jira_links` row first, the
 * ticket's `jira_key` field second), else the local ticket number.
 *
 * `<type>` heuristic (labels checked before the title; first match wins):
 *   bug | bugfix | fix | hotfix            → fix
 *   chore | refactor | cleanup | clean-up  → chore
 *   docs | doc | documentation            → docs
 *   anything else                          → feat
 */
import { isValidBranchName } from './integration-branch'

export interface TicketNamingInput {
  ticketId: number
  title?: string | null
  labels?: string[] | null
  /** Resolved Jira key (jira_links row wins over the ticket field), null when unlinked. */
  jiraKey?: string | null
}

export type ChangeType = 'feat' | 'fix' | 'chore' | 'docs'

const TYPE_PATTERNS: Array<{ type: ChangeType; re: RegExp }> = [
  { type: 'fix', re: /(^|[^a-z0-9])(bug|bugfix|fix|fixes|fixed|hotfix)([^a-z0-9]|$)/i },
  { type: 'chore', re: /(^|[^a-z0-9])(chore|refactor|refactoring|cleanup|clean-up|maintenance)([^a-z0-9]|$)/i },
  { type: 'docs', re: /(^|[^a-z0-9])(docs|doc|documentation)([^a-z0-9]|$)/i },
]

/** The documented `<type>` heuristic: labels take precedence over the title. */
export function classifyChangeType(t: TicketNamingInput): ChangeType {
  const labels = (t.labels ?? []).filter((l): l is string => typeof l === 'string')
  for (const { type, re } of TYPE_PATTERNS) {
    if (labels.some((l) => re.test(l))) return type
  }
  const title = typeof t.title === 'string' ? t.title : ''
  for (const { type, re } of TYPE_PATTERNS) {
    if (re.test(title)) return type
  }
  return 'feat'
}

/** Batch type: `feat` unless EVERY ticket maps to the same other type. */
export function batchChangeType(tickets: TicketNamingInput[]): ChangeType {
  if (tickets.length === 0) return 'feat'
  const types = new Set(tickets.map(classifyChangeType))
  if (types.size === 1) {
    const only = [...types][0]
    return only
  }
  return 'feat'
}

/** Display ref: the Jira key when linked (Jira always prevails), else the local id. */
export function ticketRef(t: TicketNamingInput): string {
  const key = t.jiraKey?.trim()
  return key ? key : String(t.ticketId)
}

/**
 * Branch-safe form of the ref. Jira keys (`PROJ-123`) are already ref-safe;
 * anything unusual is folded to the safe subset, and an unusable key falls
 * back to the local ticket number.
 */
function refSlug(t: TicketNamingInput): string {
  const key = t.jiraKey?.trim()
  if (key) {
    const safe = key
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[-.]+|[-.]+$/g, '')
    if (safe && !/\.lock$/i.test(safe)) return safe
  }
  return String(t.ticketId)
}

/**
 * ASCII-folded kebab of a ticket title: NFKD fold + strip diacritics, lowercase,
 * everything outside [a-z0-9] collapsed to single dashes, ~40 char cap, never a
 * leading/trailing dash. Emoji/symbol-only titles fold to '' (caller omits).
 */
export function kebabTitle(raw: string | null | undefined, maxLen = 40): string {
  if (typeof raw !== 'string' || !raw) return ''
  const folded = raw
    .replace(/\u00df/g, 'ss') // no NFKD decomposition \u2014 fold explicitly
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
  let kebab = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (kebab.length > maxLen) {
    kebab = kebab.slice(0, maxLen)
    // Prefer cutting at a word boundary when one exists in the tail.
    const lastDash = kebab.lastIndexOf('-')
    if (lastDash > maxLen / 2) kebab = kebab.slice(0, lastDash)
    kebab = kebab.replace(/-+$/g, '')
  }
  return kebab
}

/**
 * Conventional per-unit branch name: `<type>/<ref>-<kebab-title>` (the kebab is
 * omitted when the title folds to nothing). Guaranteed to pass
 * `isValidBranchName` — a pathological input degrades to `<type>/<ticketId>`.
 */
export function ticketBranchName(t: TicketNamingInput): string {
  const type = classifyChangeType(t)
  const ref = refSlug(t)
  const kebab = kebabTitle(t.title)
  const name = kebab ? `${type}/${ref}-${kebab}` : `${type}/${ref}`
  return isValidBranchName(name) ? name : `${type}/${t.ticketId}`
}

/**
 * Conventional batch branch name (N>1 assembled delivery):
 * `<type>/<primary-ref>-batch-<n>-tickets`.
 */
export function batchBranchNameFor(tickets: TicketNamingInput[]): string {
  const type = batchChangeType(tickets)
  const primary = tickets[0]
  const ref = primary ? refSlug(primary) : '0'
  const name = `${type}/${ref}-batch-${tickets.length}-tickets`
  return isValidBranchName(name) ? name : `${type}/batch-${tickets.length}-tickets`
}

export interface CollisionOpts {
  /** Existence predicate against the caller's branch listing / ledger. */
  taken: (name: string) => boolean
  /** Names that can never be used (e.g. the integration branch). */
  reserved?: readonly string[]
  /** Bounded suffix attempts (default 20: preferred, -2 … -20). */
  maxAttempts?: number
}

/**
 * Bounded collision resolution: the preferred name, else `-2`, `-3`, … up to
 * `maxAttempts`. Reserved names (the integration branch) are NEVER returned.
 * `null` when exhausted — the caller picks its own fallback.
 */
export function resolveCollisionFreeName(preferred: string, opts: CollisionOpts): string | null {
  const reserved = new Set(opts.reserved ?? [])
  const max = Math.max(1, opts.maxAttempts ?? 20)
  for (let i = 1; i <= max; i++) {
    const name = i === 1 ? preferred : `${preferred}-${i}`
    if (reserved.has(name)) continue
    if (!opts.taken(name)) return name
  }
  return null
}

const TITLE_CHANGE_MAX = 72
const TITLE_MAX = 100

/**
 * One short sentence derived from the ticket title: control chars stripped,
 * whitespace collapsed, trailing periods dropped, first letter lowercased
 * unless the leading word reads as an acronym / proper CamelCase identifier.
 */
export function titleChangeSummary(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim()
  s = s.replace(/[.\s]+$/g, '')
  if (!s) return ''
  s = decapitalizeFirst(s)
  if (s.length > TITLE_CHANGE_MAX) s = `${s.slice(0, TITLE_CHANGE_MAX - 1).trimEnd()}…`
  return s
}

function decapitalizeFirst(s: string): string {
  const m = /^[A-Za-z][A-Za-z0-9']*/.exec(s)
  if (!m) return s
  const word = m[0]
  // All-caps acronym (MCP, OTEL) or CamelCase identifier (JobDetailPage) → keep.
  if (word.length > 1 && /[A-Z]/.test(word.slice(1))) return s
  return s[0].toLowerCase() + s.slice(1)
}

/**
 * Conventional PR title.
 *   1 ticket  → `[<ref>]<type> - <change>`
 *   N tickets → `[<primary-ref> +<n-1>]<type> - <loop-level summary>`
 * The per-ticket `<type>` uses the SAME heuristic as the branch name, so the
 * two stay consistent for a given ticket.
 */
export function buildPrTitle(tickets: TicketNamingInput[], opts: { loopName?: string | null } = {}): string {
  if (tickets.length === 0) {
    // Defensive — deliveries always carry ≥1 succeeded ticket.
    return truncateTitle(titleChangeSummary(opts.loopName) || 'specrails delivery')
  }
  if (tickets.length === 1) {
    const t = tickets[0]
    const change = titleChangeSummary(t.title) || `implement ${ticketRef(t)}`
    return truncateTitle(`[${ticketRef(t)}]${classifyChangeType(t)} - ${change}`)
  }
  const primary = tickets[0]
  const type = batchChangeType(tickets)
  const loop = titleChangeSummary(opts.loopName)
  const summary = loop ? `${loop} batch of ${tickets.length} tickets` : `batch of ${tickets.length} tickets`
  return truncateTitle(`[${ticketRef(primary)} +${tickets.length - 1}]${type} - ${summary}`)
}

function truncateTitle(s: string): string {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1).trimEnd()}…` : s
}
