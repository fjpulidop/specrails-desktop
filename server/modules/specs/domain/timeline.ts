/**
 * Spec lifecycle timeline: pure vocabulary and rules.
 *
 * The timeline is a projection (no store of its own) over the spec, its
 * addenda, the missions and runs that touched it, the agent actions audit,
 * the PR deliveries and the reviewer's findings. This file owns the entry
 * shape, ordering, kind filtering, cursor pagination and the cost folding
 * rules. Reading the sources is the runtime adapter's job.
 *
 * Cost semantics (kept from the accounting module): a provider-reported cost
 * is `billed`; a cost derived from the pricing table is `estimated`; a run the
 * provider reported no cost for is simply absent, never zero. The two are
 * never summed into one undifferentiated figure.
 */

export const TIMELINE_KINDS = ['spec_edit', 'addendum', 'mission_turn', 'job', 'phase', 'audit', 'pr_event', 'review'] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]

export function isTimelineKind(value: unknown): value is TimelineKind {
  return typeof value === 'string' && (TIMELINE_KINDS as readonly string[]).includes(value)
}

/** Visual tone; the client maps it to the lamp tokens. */
export type TimelineTone = 'neutral' | 'ok' | 'failure' | 'review'

export interface TimelineActor {
  type: 'user' | 'agent' | 'mcp' | 'system'
  /** Role (`developer`), person label or origin; never an identity secret. */
  label: string
  provider: string | null
}

/** A place the entry leads to. The client turns it into a URL for the current mode. */
export type TimelineLink =
  | { place: 'spec'; id: string }
  | { place: 'mission'; id: string }
  | { place: 'job'; id: string }
  | { place: 'review'; id: string }

export type CostKind = 'billed' | 'estimated'

export interface TimelineSubItem {
  at: string | null
  label: string
  detail: string | null
  tone?: TimelineTone
}

export interface TimelineEntry {
  id: string
  at: string
  kind: TimelineKind
  /** Stable code of the system-generated phrase (`spec.created`, `job.run`, ...); the client localizes it. */
  event: string
  /** Values the phrase interpolates (counts, statuses); never secrets. */
  params: Record<string, string | number | null>
  /** Source text (job name, addendum title, mission title) or the English phrase when the source has none. */
  title: string
  summary: string | null
  actor: TimelineActor | null
  tone: TimelineTone
  provider: string | null
  /** Sum of the provider-priced rows behind the entry; absent when none was priced. */
  costUsd?: number
  /** `estimated` when ANY priced row came from the pricing table. */
  costKind?: CostKind
  /** The estimated share of `costUsd`. */
  costEstimatedUsd?: number
  /** Turns reported by the provider (what a plan user sees instead of dollars). */
  turns?: number | null
  link: TimelineLink | null
  /** External URL (the PR). */
  url?: string | null
  /** Size of the collapsed group this entry stands for. */
  count?: number
  /** Expandable details of a collapsed group, bounded. */
  items?: TimelineSubItem[]
}

export const TIMELINE_DEFAULT_LIMIT = 50
export const TIMELINE_MAX_LIMIT = 200
export const TIMELINE_MAX_ITEMS = 12

/** Newest first; ties broken by id so a cursor is stable. */
export function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

export function sortTimeline(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort(compareTimelineEntries)
}

export function parseKinds(raw: unknown): TimelineKind[] | null {
  if (raw === undefined || raw === '') return []
  if (typeof raw !== 'string') return null
  const kinds: TimelineKind[] = []
  for (const part of raw.split(',')) {
    const value = part.trim()
    if (!value) continue
    if (!isTimelineKind(value)) return null
    if (!kinds.includes(value)) kinds.push(value)
  }
  return kinds
}

export function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === '') return TIMELINE_DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return null
  return Math.min(n, TIMELINE_MAX_LIMIT)
}

/** Opaque cursor: the last delivered (at, id). Returns null for a malformed one. */
export function encodeCursor(entry: Pick<TimelineEntry, 'at' | 'id'>): string {
  return Buffer.from(JSON.stringify([entry.at, entry.id]), 'utf8').toString('base64url')
}

export function decodeCursor(raw: unknown): { at: string; id: string } | null {
  if (typeof raw !== 'string' || !raw || raw.length > 600) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null
    return { at: parsed[0], id: parsed[1] }
  } catch {
    return null
  }
}

export interface TimelinePage {
  entries: TimelineEntry[]
  nextCursor: string | null
  /** Entries per kind across the whole (unfiltered) timeline: the filter chips' counts. */
  counts: Record<TimelineKind, number>
  total: number
}

export function emptyKindCounts(): Record<TimelineKind, number> {
  return { spec_edit: 0, addendum: 0, mission_turn: 0, job: 0, phase: 0, audit: 0, pr_event: 0, review: 0 }
}

/** Filter by kind, then page after the cursor. `all` must already be sorted newest first. */
export function pageTimeline(
  all: readonly TimelineEntry[],
  options: { kinds: readonly TimelineKind[]; limit: number; cursor: { at: string; id: string } | null },
): TimelinePage {
  const counts = emptyKindCounts()
  for (const entry of all) counts[entry.kind] += 1
  const wanted = options.kinds.length > 0 ? new Set<TimelineKind>(options.kinds) : null
  let visible = wanted ? all.filter((entry) => wanted.has(entry.kind)) : [...all]
  const { cursor } = options
  if (cursor) visible = visible.filter((entry) => entry.at < cursor.at || (entry.at === cursor.at && entry.id < cursor.id))
  const entries = visible.slice(0, options.limit)
  const last = entries[entries.length - 1]
  return {
    entries,
    nextCursor: last && visible.length > entries.length ? encodeCursor(last) : null,
    counts,
    total: all.length,
  }
}

// ─── Cost folding ────────────────────────────────────────────────────────────

export interface CostRow {
  provider: string | null
  /** null = the provider reported no cost. */
  costUsd: number | null
  estimated: boolean
  turns: number | null
}

export interface FoldedCost {
  costUsd?: number
  costKind?: CostKind
  costEstimatedUsd?: number
  turns: number | null
}

export function foldCost(rows: readonly CostRow[]): FoldedCost {
  let total = 0
  let estimated = 0
  let priced = 0
  let turns = 0
  let turnsKnown = false
  for (const row of rows) {
    if (row.costUsd !== null) {
      priced += 1
      total += row.costUsd
      if (row.estimated) estimated += row.costUsd
    }
    if (row.turns !== null) { turns += row.turns; turnsKnown = true }
  }
  const out: FoldedCost = { turns: turnsKnown ? turns : null }
  if (priced > 0) {
    out.costUsd = total
    out.costKind = estimated > 0 ? 'estimated' : 'billed'
    if (estimated > 0) out.costEstimatedUsd = estimated
  }
  return out
}

/** `a/b.ts:12-14` style anchor of a finding. */
export function formatLocation(location: { path: string; line?: number; endLine?: number } | null | undefined): string | null {
  if (!location) return null
  if (location.line === undefined) return location.path
  return location.endLine !== undefined && location.endLine !== location.line
    ? `${location.path}:${location.line}-${location.endLine}`
    : `${location.path}:${location.line}`
}

/**
 * SQLite `datetime('now')` yields `YYYY-MM-DD HH:MM:SS` with no zone, and a
 * browser reads that as LOCAL time. The value is UTC, so give it an ISO `T…Z`
 * form before it is compared, sorted or sent to a client. Values that already
 * carry a zone pass through untouched.
 */
export function utc<T>(value: T): T | string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
}

export function oneLine(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
