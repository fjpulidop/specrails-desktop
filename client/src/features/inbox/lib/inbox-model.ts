/**
 * "Needs you" inbox: client-side model. The server projects the items
 * (GET /api/inbox, a read-model over deliveries, runs and the Jira outbox);
 * this module is everything pure on the client: the item shape, per-viewer
 * Snooze / Done, grouping and where an item leads.
 */
import { JOB_PARAM, MISSION_PARAM, REVIEW_PARAM } from '../../../lib/places'
import { readFailureDiagnosis, type FailureDiagnosis } from '../../recovery/lib/failure-diagnosis'

export type InboxKind = 'review' | 'question' | 'failed' | 'blocked' | 'budget' | 'jira'
export type InboxAction = 'open-review' | 'open-run' | 'resume-run' | 'retry-jira' | 'raise-cap'

/** A spend cap that is reached right now (`raise-cap` items). */
export interface InboxCap {
  scope: 'project' | 'desktop'
  period: 'day' | 'week' | 'month'
  budgetUsd: number
  spentUsd: number
  resetsAt: string
}

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
  /** Why a failed / blocked run stopped (recovery cockpit); null for every other item. */
  diagnosis: FailureDiagnosis | null
  /** Which cap and where it stands; set only on a `raise-cap` item. */
  cap: InboxCap | null
}

export interface InboxSnapshot {
  items: InboxItem[]
  projects: Array<{ projectId: string; projectName: string; count: number }>
  generatedAt: string
}

const KINDS: readonly string[] = ['review', 'question', 'failed', 'blocked', 'budget', 'jira']
const ACTIONS: readonly string[] = ['open-review', 'open-run', 'resume-run', 'retry-jira', 'raise-cap']

function readCap(raw: unknown): InboxCap | null {
  const c = raw as Record<string, unknown> | null
  if (!c || typeof c !== 'object') return null
  if ((c.scope !== 'project' && c.scope !== 'desktop') || (c.period !== 'day' && c.period !== 'week' && c.period !== 'month')) return null
  if (typeof c.budgetUsd !== 'number' || typeof c.spentUsd !== 'number' || !Number.isFinite(c.budgetUsd) || !Number.isFinite(c.spentUsd)) return null
  return { scope: c.scope, period: c.period, budgetUsd: c.budgetUsd, spentUsd: c.spentUsd, resetsAt: typeof c.resetsAt === 'string' ? c.resetsAt : '' }
}

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
      diagnosis: readFailureDiagnosis(v.diagnosis),
      cap: readCap(v.cap),
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

// ── Item versions: what the person has seen, what was announced ─────────────

/** One state of one item: a new `version` is new news (it re-arms Done, unseen and announcements alike). */
export function inboxItemKey(item: Pick<InboxItem, 'id' | 'version'>): string {
  return `${item.id}\u0000${item.version}`
}

/** A version the person has seen (displayed in the open inbox, or opened). */
export interface SeenMark {
  version: string
  /** When it was seen (epoch ms), for pruning. */
  at: number
}
export type SeenMarks = Record<string, SeenMark>

export const SEEN_KEY = 'specrails-desktop:inbox:seen'

function readMarks<T>(key: string, now: number, read: (value: Record<string, unknown>) => T | null, at: (value: T) => number): Record<string, T> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, T> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const mark = read(value as Record<string, unknown>)
      if (mark === null || now - at(mark) > PRUNE_AFTER_MS) continue
      out[id] = mark
    }
    return out
  } catch {
    return {}
  }
}

function writeMarks(key: string, marks: Record<string, unknown>): void {
  try {
    localStorage.setItem(key, JSON.stringify(marks))
  } catch {
    // storage unavailable: the marks last for this session only
  }
}

export function readSeenMarks(now: number = Date.now()): SeenMarks {
  return readMarks<SeenMark>(SEEN_KEY, now, (v) => (typeof v.version === 'string' && typeof v.at === 'number' ? { version: v.version, at: v.at } : null), (m) => m.at)
}

export function writeSeenMarks(marks: SeenMarks): void {
  writeMarks(SEEN_KEY, marks)
}

export function isUnseen(item: InboxItem, marks: SeenMarks): boolean {
  return marks[item.id]?.version !== item.version
}

/** A mark older than this is renewed when its item is still there, so pruning only forgets items that left. */
const RENEW_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** The marks with these items' current versions seen; the same object when nothing changes. */
export function markSeen(marks: SeenMarks, items: readonly InboxItem[], now: number): SeenMarks {
  const changed = items.filter((item) => isUnseen(item, marks) || now - marks[item.id].at > RENEW_AFTER_MS)
  if (changed.length === 0) return marks
  const next = { ...marks }
  for (const item of changed) next[item.id] = { version: item.version, at: now }
  return next
}

/** "Mark as unread": forget that this version was seen. */
export function markUnseen(marks: SeenMarks, item: InboxItem): SeenMarks {
  if (!(item.id in marks)) return marks
  const next = { ...marks }
  delete next[item.id]
  return next
}

/** Unseen items outside muted projects: the Dock badge number. */
export function unseenCount(items: readonly InboxItem[], marks: SeenMarks, mutedProjects: readonly string[] = []): number {
  let count = 0
  for (const item of items) if (isUnseen(item, marks) && !mutedProjects.includes(item.projectId)) count += 1
  return count
}

/**
 * The item versions already announced (or present when the app started),
 * per viewer: key {@link inboxItemKey} → epoch ms. Pruned after 30 days.
 */
export type AnnouncedLedger = Record<string, number>

export const ANNOUNCED_KEY = 'specrails-desktop:inbox:announced'

export function readAnnounced(now: number = Date.now()): AnnouncedLedger {
  return readMarks<number>(ANNOUNCED_KEY, now, (v) => (typeof v.at === 'number' ? v.at : null), (at) => at)
}

export function writeAnnounced(ledger: AnnouncedLedger): void {
  writeMarks(ANNOUNCED_KEY, Object.fromEntries(Object.entries(ledger).map(([key, at]) => [key, { at }])))
}

/**
 * Which items to announce now. `seed`: the first snapshot since the app
 * started — everything already there is recorded silently, so a restart never
 * announces old news. Afterwards, a key never recorded is announced once;
 * `snapshot` (every item, snoozed or done included) is recorded, `visible`
 * (without the snoozed / done ones) is what may be announced.
 */
export function planAnnouncements(
  ledger: AnnouncedLedger,
  snapshot: readonly InboxItem[],
  visible: readonly InboxItem[],
  seed: boolean,
  now: number,
): { announce: InboxItem[]; ledger: AnnouncedLedger } {
  let next = ledger
  const announce: InboxItem[] = []
  const visibleKeys = new Set(visible.map(inboxItemKey))
  for (const item of snapshot) {
    const key = inboxItemKey(item)
    if (key in next) {
      if (now - next[key] > RENEW_AFTER_MS) {
        if (next === ledger) next = { ...ledger }
        next[key] = now
      }
      continue
    }
    if (next === ledger) next = { ...ledger }
    next[key] = now
    if (!seed && visibleKeys.has(key)) announce.push(item)
  }
  return { announce, ledger: next }
}

/** The notification category of an item (Settings ▸ Notifications). */
export function attentionCategoryOf(item: Pick<InboxItem, 'kind' | 'diagnosis'>): 'question' | 'review' | 'failed' | 'budget' {
  if (item.kind === 'question') return 'question'
  if (item.kind === 'review') return 'review'
  if (item.kind === 'budget') return 'budget'
  // A run blocked by the provider's usage limit is a spending signal, like the live provider-limit alert.
  if (item.kind === 'blocked' && item.diagnosis?.kind === 'provider_limit') return 'budget'
  return 'failed'
}
