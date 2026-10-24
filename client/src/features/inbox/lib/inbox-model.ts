/**
 * "Needs you" inbox: client-side model. The server projects the items
 * (GET /api/inbox, a read-model over deliveries, runs and the Jira outbox);
 * this module is everything pure on the client: the item shape, per-viewer
 * Snooze / Done, grouping and where an item leads.
 */
import { JOB_PARAM, MISSION_PARAM, REVIEW_PARAM } from '../../../lib/places'

export type InboxKind = 'review' | 'question' | 'failed' | 'blocked' | 'budget' | 'jira'
export type InboxAction = 'open-review' | 'open-run' | 'resume-run' | 'retry-jira'

export interface InboxItem {
  id: string
  projectId: string
  projectName: string
  kind: InboxKind
  title: string
  detail: string | null
  at: string
  version: string
  action: InboxAction
  subjectId: string
  conversationId: string | null
}

export interface InboxSnapshot {
  items: InboxItem[]
  projects: Array<{ projectId: string; projectName: string; count: number }>
  generatedAt: string
}

const KINDS: readonly string[] = ['review', 'question', 'failed', 'blocked', 'budget', 'jira']
const ACTIONS: readonly string[] = ['open-review', 'open-run', 'resume-run', 'retry-jira']

/** Defensive read of the wire body: anything malformed is dropped, never thrown. */
export function readInboxSnapshot(raw: unknown): InboxSnapshot {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const items = (Array.isArray(body.items) ? body.items : []).flatMap((value): InboxItem[] => {
    if (!value || typeof value !== 'object') return []
    const v = value as Record<string, unknown>
    const str = (k: string): string | null => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : null)
    const id = str('id'), projectId = str('projectId'), title = str('title'), at = str('at'), subjectId = str('subjectId')
    if (!id || !projectId || !title || !at || !subjectId) return []
    if (!KINDS.includes(String(v.kind)) || !ACTIONS.includes(String(v.action))) return []
    return [{
      id, projectId, title, at, subjectId,
      projectName: str('projectName') ?? projectId,
      kind: v.kind as InboxKind,
      detail: str('detail'),
      version: str('version') ?? '',
      action: v.action as InboxAction,
      conversationId: str('conversationId'),
    }]
  })
  const projects = (Array.isArray(body.projects) ? body.projects : []).flatMap((value) => {
    const v = value as Record<string, unknown> | null
    return v && typeof v.projectId === 'string' ? [{ projectId: v.projectId, projectName: typeof v.projectName === 'string' ? v.projectName : v.projectId, count: typeof v.count === 'number' ? v.count : 0 }] : []
  })
  return { items, projects, generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : new Date(0).toISOString() }
}

// ── Snooze / Done (per viewer) ──────────────────────────────────────────────

/**
 * `until`: snoozed until this epoch ms. `done`: dismissed. Both remember the
 * item's `version`: when the underlying state changes the item is new again.
 */
export interface Dismissal {
  version: string
  until: number | null
  /** When the person dismissed it (epoch ms), for pruning. */
  at: number
}
export type Dismissals = Record<string, Dismissal>

export const DISMISSALS_KEY = 'specrails-desktop:inbox:dismissals'
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
export const SNOOZE_HOUR_MS = 60 * 60 * 1000
export type SnoozeChoice = 'hour' | 'tomorrow'

export function readDismissals(now: number = Date.now()): Dismissals {
  try {
    const raw = localStorage.getItem(DISMISSALS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Dismissals = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as Partial<Dismissal> | null
      if (!v || typeof v.version !== 'string' || typeof v.at !== 'number') continue
      if (now - v.at > PRUNE_AFTER_MS) continue
      out[id] = { version: v.version, at: v.at, until: typeof v.until === 'number' ? v.until : null }
    }
    return out
  } catch {
    return {}
  }
}

export function writeDismissals(dismissals: Dismissals): void {
  try {
    localStorage.setItem(DISMISSALS_KEY, JSON.stringify(dismissals))
  } catch {
    // storage unavailable (private window, blocked): the choice lasts for this session only
  }
}

/** 08:00 local time on the next calendar day. */
export function tomorrowMorning(now: number): number {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d.getTime()
}

export function snoozeDismissal(item: InboxItem, choice: SnoozeChoice, now: number): Dismissal {
  return { version: item.version, at: now, until: choice === 'hour' ? now + SNOOZE_HOUR_MS : tomorrowMorning(now) }
}

export function doneDismissal(item: InboxItem, now: number): Dismissal {
  return { version: item.version, at: now, until: null }
}

/** Hidden while the dismissal still applies: same state, and (for a snooze) before it expires. */
export function isDismissed(item: InboxItem, dismissals: Dismissals, now: number): boolean {
  const d = dismissals[item.id]
  if (!d || d.version !== item.version) return false
  return d.until === null || d.until > now
}

/** The next moment a snooze lapses (epoch ms), so the list can come back on time. */
export function nextSnoozeExpiry(dismissals: Dismissals, now: number): number | null {
  let next: number | null = null
  for (const d of Object.values(dismissals)) if (d.until !== null && d.until > now && (next === null || d.until < next)) next = d.until
  return next
}

export interface InboxGroup {
  projectId: string
  projectName: string
  items: InboxItem[]
}

/** Group by project, keeping the (newest first) order of both groups and items. */
export function groupByProject(items: readonly InboxItem[]): InboxGroup[] {
  const groups = new Map<string, InboxGroup>()
  for (const item of items) {
    const group = groups.get(item.projectId)
    if (group) group.items.push(item)
    else groups.set(item.projectId, { projectId: item.projectId, projectName: item.projectName, items: [item] })
  }
  return [...groups.values()]
}

// ── Where an item leads ──────────────────────────────────────────────────────

export interface InboxTarget {
  pathname: string
  search: string
  /** The place param this entry opens (for the router's place-push marker). */
  place: 'review' | 'job'
}

/**
 * The place an "open" action lands on, per UI mode (see `places.ts`): Mission
 * mode keeps the mission and layers `?review=` / `?job=` over it; Board mode
 * uses the routed `/review/:id` and `/jobs/:id`.
 */
export function inboxTarget(item: InboxItem, mode: 'kanban' | 'agent'): InboxTarget {
  const review = item.action === 'open-review'
  if (mode === 'kanban') {
    return review
      ? { pathname: `/review/${encodeURIComponent(item.subjectId)}`, search: '', place: 'review' }
      : { pathname: `/jobs/${encodeURIComponent(item.subjectId)}`, search: '', place: 'job' }
  }
  const params = new URLSearchParams()
  if (item.conversationId) params.set(MISSION_PARAM, item.conversationId)
  params.set(review ? REVIEW_PARAM : JOB_PARAM, item.subjectId)
  return { pathname: '/', search: `?${params.toString()}`, place: review ? 'review' : 'job' }
}
