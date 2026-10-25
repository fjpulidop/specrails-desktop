import { getApiBase } from '../../../lib/api'
import { MISSION_PARAM, REVIEW_PARAM, JOB_PARAM, SPEC_PARAM } from '../../../lib/places'

// ─── Wire contract of GET /tickets/:id/timeline (server/modules/specs/domain/timeline.ts) ───

export const TIMELINE_KINDS = ['spec_edit', 'addendum', 'mission_turn', 'job', 'phase', 'audit', 'pr_event', 'review'] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]
export type TimelineTone = 'neutral' | 'ok' | 'failure' | 'review'

export interface TimelineActor { type: 'user' | 'agent' | 'mcp' | 'system'; label: string; provider: string | null }

export type TimelineLink =
  | { place: 'spec'; id: string }
  | { place: 'mission'; id: string }
  | { place: 'job'; id: string }
  | { place: 'review'; id: string }

export interface TimelineSubItem { at: string | null; label: string; detail: string | null; tone?: TimelineTone }

export interface TimelineEntry {
  id: string
  at: string
  kind: TimelineKind
  event: string
  params: Record<string, string | number | null>
  title: string
  summary: string | null
  actor: TimelineActor | null
  tone: TimelineTone
  provider: string | null
  costUsd?: number
  costKind?: 'billed' | 'estimated'
  costEstimatedUsd?: number
  turns?: number | null
  link: TimelineLink | null
  url?: string | null
  count?: number
  items?: TimelineSubItem[]
}

export interface TimelinePage {
  ticketId: number
  entries: TimelineEntry[]
  nextCursor: string | null
  counts: Record<TimelineKind, number>
  total: number
}

export async function fetchSpecTimeline(
  ticketId: number,
  options: { kinds?: readonly TimelineKind[]; cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<TimelinePage> {
  const params = new URLSearchParams()
  if (options.kinds && options.kinds.length > 0) params.set('kinds', options.kinds.join(','))
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.limit) params.set('limit', String(options.limit))
  const query = params.toString()
  const res = await fetch(`${getApiBase()}/tickets/${ticketId}/timeline${query ? `?${query}` : ''}`, { signal: options.signal })
  if (!res.ok) throw new Error(`timeline ${res.status}`)
  return await res.json() as TimelinePage
}

// ─── Presentation rules ──────────────────────────────────────────────────────

/** Local calendar day (`YYYY-MM-DD`) of a timestamp: the grouping key of the day headings. */
export function localDayKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface TimelineDay { key: string; at: string; entries: TimelineEntry[] }

/** Entries arrive newest first; days keep that order. */
export function groupByDay(entries: readonly TimelineEntry[]): TimelineDay[] {
  const days: TimelineDay[] = []
  for (const entry of entries) {
    const key = localDayKey(entry.at)
    const last = days[days.length - 1]
    if (last && last.key === key) last.entries.push(entry)
    else days.push({ key, at: entry.at, entries: [entry] })
  }
  return days
}

/** i18n key (tickets namespace) of the system phrase an entry stands for. */
export function eventKey(entry: Pick<TimelineEntry, 'event' | 'params'>): string {
  if (entry.event === 'review.verdict') return `timeline.events.review_${String(entry.params.verdict ?? 'recorded')}`
  return `timeline.events.${entry.event.replace(/\./g, '_')}`
}

/** Events whose phrase carries a plural count. */
export function eventCount(entry: Pick<TimelineEntry, 'event' | 'params' | 'count'>): number | undefined {
  if (entry.event === 'mission.turns') return Number(entry.params.turns ?? entry.count ?? 0)
  if (entry.event === 'phase.group' || entry.event === 'audit.group') return Number(entry.params.count ?? entry.count ?? 0)
  return undefined
}

/**
 * What the entry shows for money. A provider billed through a plan shows turns,
 * never dollars; a priced entry shows its billed or estimated figure, kept
 * apart; an entry with neither shows nothing (a missing cost is not zero).
 */
export type EntryCost =
  | { kind: 'billed'; usd: number }
  | { kind: 'estimated'; usd: number }
  | { kind: 'turns'; turns: number }

export function entryCost(entry: Pick<TimelineEntry, 'costUsd' | 'costKind' | 'turns' | 'provider'>, planProviders: ReadonlySet<string>): EntryCost | null {
  if (entry.provider && planProviders.has(entry.provider)) {
    return typeof entry.turns === 'number' && entry.turns > 0 ? { kind: 'turns', turns: entry.turns } : null
  }
  if (typeof entry.costUsd === 'number') return { kind: entry.costKind === 'estimated' ? 'estimated' : 'billed', usd: entry.costUsd }
  return null
}

export interface TimelineTarget {
  pathname: string
  search: string
  /** Mission links need Mission mode: the shell switches before navigating. */
  needsAgentMode: boolean
  place: 'mission' | 'job' | 'review'
}

/**
 * The place a link leads to, written the way the current mode writes it
 * (Board: routed `/jobs/:id` and `/review/:id`; Mission mode: `?job=` / `?review=`
 * layered over the current mission). `?spec` is dropped so the spec modal gives way
 * to the destination. A link to the spec itself has no target.
 */
export function timelineTarget(link: TimelineLink | null, mode: 'kanban' | 'agent', currentSearch: string): TimelineTarget | null {
  if (!link || link.place === 'spec') return null
  const params = new URLSearchParams(currentSearch)
  params.delete(SPEC_PARAM)
  if (link.place === 'mission') {
    return { pathname: '/', search: `?${new URLSearchParams({ [MISSION_PARAM]: link.id }).toString()}`, needsAgentMode: mode !== 'agent', place: 'mission' }
  }
  if (mode === 'kanban') {
    return { pathname: link.place === 'review' ? `/review/${encodeURIComponent(link.id)}` : `/jobs/${encodeURIComponent(link.id)}`, search: '', needsAgentMode: false, place: link.place }
  }
  params.delete(link.place === 'review' ? JOB_PARAM : REVIEW_PARAM)
  params.set(link.place === 'review' ? REVIEW_PARAM : JOB_PARAM, link.id)
  return { pathname: '/', search: `?${params.toString()}`, needsAgentMode: false, place: link.place }
}
