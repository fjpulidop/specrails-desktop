/**
 * Live board: the client model. The server projects every run of every project
 * (GET /api/live-board) and decides each card's column, lane and order; this
 * module is everything pure on the client: the wire shape (read defensively),
 * the filters, the per-viewer layout choice and what a card's action does.
 * How a state LOOKS is the run-state vocabulary's (see `live-board-run-state.ts`).
 */
import { readInboxSnapshot, type InboxItem } from '../../inbox/lib/inbox-model'

export type LiveRunKind = 'rail' | 'loop' | 'intent' | 'job'
export type LiveColumn = 'needs' | 'working' | 'decide' | 'done'
export const LIVE_COLUMNS: readonly LiveColumn[] = ['needs', 'working', 'decide', 'done']
export const LIVE_KINDS: readonly LiveRunKind[] = ['rail', 'loop', 'intent', 'job']

/** The domain status a card carries, as its owning capability names it. */
export type LiveRunStatus =
  | { source: 'job'; status: string }
  | { source: 'loop-run'; status: 'running' | 'paused' | 'completed'; outcome: string | null; restartReason: string | null }
  | { source: 'delivery'; decision: string; statusCode: string | null }
  | { source: 'intent'; state: string }
  | { source: 'attention' }

export interface LiveCard {
  id: string
  projectId: string
  projectName: string
  kind: LiveRunKind | null
  status: LiveRunStatus
  column: LiveColumn
  urgency: number
  at: string
  title: string | null
  phase: string | null
  question: string | null
  steps: { done: number; total: number } | null
  provider: string | null
  model: string | null
  startedAt: string | null
  finishedAt: string | null
  costUsd: number | null
  costEstimated: boolean
  costTodayUsd: number | null
  railIndex: number | null
  ticketIds: number[]
  conversationId: string | null
  jobId: string | null
  deliveryId: string | null
  /** The inbox item that speaks for this card, read with the inbox's own reader. */
  attention: InboxItem | null
  /** A delivery card's last merge preview (server: delivery merge preview); null/absent when none yet. */
  mergePreview?: LiveMergePreview | null
}

export interface LiveMergePreview {
  status: 'clean' | 'conflicts' | 'already_merged' | 'unknown'
  conflictFileCount: number
  siblingConflictCount: number
  baseAdvancedBy: number | null
}

export interface LiveLane {
  conversationId: string | null
  title: string | null
  provider: string | null
  projectIds: string[]
  cardIds: string[]
  todayCostUsd: number | null
  urgency: number
}

export interface LiveBoardTotals {
  needsYou: number
  inProgress: number
  toDecide: number
  doneToday: number
  costTodayUsd: number | null
  costTodayEstimated: boolean
}

export interface LiveBoardSnapshot {
  generatedAt: string
  projects: Array<{ projectId: string; projectName: string; count: number }>
  cards: LiveCard[]
  lanes: LiveLane[]
  totals: LiveBoardTotals
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function readStatus(raw: unknown): LiveRunStatus | null {
  const v = raw as Record<string, unknown> | null
  if (!v || typeof v !== 'object') return null
  switch (v.source) {
    case 'job': return typeof v.status === 'string' ? { source: 'job', status: v.status } : null
    case 'loop-run':
      return v.status === 'running' || v.status === 'paused' || v.status === 'completed'
        ? { source: 'loop-run', status: v.status, outcome: str(v.outcome), restartReason: str(v.restartReason) }
        : null
    case 'delivery': return typeof v.decision === 'string' ? { source: 'delivery', decision: v.decision, statusCode: str(v.statusCode) } : null
    case 'intent': return typeof v.state === 'string' ? { source: 'intent', state: v.state } : null
    case 'attention': return { source: 'attention' }
    default: return null
  }
}

function readCard(raw: unknown): LiveCard | null {
  const v = raw as Record<string, unknown> | null
  if (!v || typeof v !== 'object') return null
  const id = str(v.id), projectId = str(v.projectId), at = str(v.at)
  const status = readStatus(v.status)
  if (!id || !projectId || !at || !status || !LIVE_COLUMNS.includes(v.column as LiveColumn)) return null
  const steps = v.steps as Record<string, unknown> | null
  const attention = v.attention ? readInboxSnapshot({ items: [v.attention] }).items[0] ?? null : null
  return {
    id, projectId, at, status,
    projectName: str(v.projectName) ?? projectId,
    kind: LIVE_KINDS.includes(v.kind as LiveRunKind) ? v.kind as LiveRunKind : null,
    column: v.column as LiveColumn,
    urgency: num(v.urgency) ?? 3,
    title: str(v.title),
    phase: str(v.phase),
    question: str(v.question),
    steps: steps && num(steps.done) !== null && num(steps.total) ? { done: num(steps.done)!, total: num(steps.total)! } : null,
    provider: str(v.provider),
    model: str(v.model),
    startedAt: str(v.startedAt),
    finishedAt: str(v.finishedAt),
    costUsd: num(v.costUsd),
    costEstimated: v.costEstimated === true,
    costTodayUsd: num(v.costTodayUsd),
    railIndex: num(v.railIndex),
    ticketIds: Array.isArray(v.ticketIds) ? v.ticketIds.filter((x): x is number => typeof x === 'number') : [],
    conversationId: str(v.conversationId),
    jobId: str(v.jobId),
    deliveryId: str(v.deliveryId),
    attention,
  }
}

/** Defensive read of the wire body: anything malformed is dropped, never thrown. */
export function readLiveBoardSnapshot(raw: unknown): LiveBoardSnapshot {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const cards = (Array.isArray(body.cards) ? body.cards : []).map(readCard).filter((c): c is LiveCard => c !== null)
  const ids = new Set(cards.map((c) => c.id))
  const lanes = (Array.isArray(body.lanes) ? body.lanes : []).flatMap((value): LiveLane[] => {
    const v = value as Record<string, unknown> | null
    if (!v || typeof v !== 'object' || !Array.isArray(v.cardIds)) return []
    return [{
      conversationId: str(v.conversationId),
      title: str(v.title),
      provider: str(v.provider),
      projectIds: Array.isArray(v.projectIds) ? v.projectIds.filter((x): x is string => typeof x === 'string') : [],
      cardIds: v.cardIds.filter((x): x is string => typeof x === 'string' && ids.has(x)),
      todayCostUsd: num(v.todayCostUsd),
      urgency: num(v.urgency) ?? 3,
    }]
  })
  const t = (body.totals ?? {}) as Record<string, unknown>
  const projects = (Array.isArray(body.projects) ? body.projects : []).flatMap((value) => {
    const v = value as Record<string, unknown> | null
    return v && typeof v.projectId === 'string' ? [{ projectId: v.projectId, projectName: str(v.projectName) ?? v.projectId, count: num(v.count) ?? 0 }] : []
  })
  return {
    generatedAt: str(body.generatedAt) ?? new Date(0).toISOString(),
    projects,
    cards,
    lanes,
    totals: {
      needsYou: num(t.needsYou) ?? 0, inProgress: num(t.inProgress) ?? 0, toDecide: num(t.toDecide) ?? 0, doneToday: num(t.doneToday) ?? 0,
      costTodayUsd: num(t.costTodayUsd), costTodayEstimated: t.costTodayEstimated === true,
    },
  }
}

// ── Filters ────────────────────────────────────────────────────────────────

/** null = all. Filters narrow what is shown; they never reorder it (the server's order holds). */
export interface LiveBoardFilters {
  projectId: string | null
  kind: LiveRunKind | null
  provider: string | null
}

export const NO_FILTERS: LiveBoardFilters = { projectId: null, kind: null, provider: null }

export function matchesFilters(card: LiveCard, filters: LiveBoardFilters): boolean {
  if (filters.projectId && card.projectId !== filters.projectId) return false
  if (filters.kind && card.kind !== filters.kind) return false
  if (filters.provider && card.provider !== filters.provider) return false
  return true
}

/** The engines present on the board, for the engine filter (stable, alphabetical). */
export function providersOf(cards: readonly LiveCard[]): string[] {
  return [...new Set(cards.map((c) => c.provider).filter((p): p is string => !!p))].sort()
}

/** Layout A: the visible cards per column, in the server's order. Inbox items the person snoozed or marked done are left out. */
export function columnsOf(cards: readonly LiveCard[], filters: LiveBoardFilters, dismissed: (item: InboxItem) => boolean = () => false): Record<LiveColumn, LiveCard[]> {
  const out: Record<LiveColumn, LiveCard[]> = { needs: [], working: [], decide: [], done: [] }
  for (const card of cards) {
    if (!matchesFilters(card, filters)) continue
    if (card.attention && dismissed(card.attention)) continue
    out[card.column].push(card)
  }
  return out
}

export interface VisibleLane {
  lane: LiveLane
  cards: LiveCard[]
}

/**
 * Layout B: the lanes holding a visible card, in the server's order (most
 * urgent mission first, "Not from a mission" last). Filtering never reorders
 * the lanes, so a lane does not jump while the person narrows the board. A
 * mission shows every run it launched, a dismissed item included.
 */
export function lanesOf(snapshot: Pick<LiveBoardSnapshot, 'cards' | 'lanes'>, filters: LiveBoardFilters): VisibleLane[] {
  const byId = new Map(snapshot.cards.map((c) => [c.id, c]))
  return snapshot.lanes.flatMap((lane) => {
    const cards = lane.cardIds.map((id) => byId.get(id)).filter((c): c is LiveCard => !!c && matchesFilters(c, filters))
    return cards.length > 0 ? [{ lane, cards }] : []
  })
}

/** A paused loop run or Intent session: open, but nothing moves until the person resumes it. */
export function isPausedCard(card: Pick<LiveCard, 'status'>): boolean {
  const s = card.status
  return (s.source === 'loop-run' && s.status === 'paused') || (s.source === 'intent' && s.state === 'paused')
}

/** The header counts for what is shown: paused runs are open but not "in progress". */
export function countVisible(columns: Record<LiveColumn, LiveCard[]>): { needsYou: number; inProgress: number; paused: number } {
  const paused = columns.working.filter(isPausedCard).length
  return { needsYou: columns.needs.length, inProgress: columns.working.length - paused, paused }
}

// ── Layout (per viewer) ─────────────────────────────────────────────────────

export type LiveBoardLayout = 'status' | 'mission'
export const LAYOUT_KEY = 'specrails-desktop:live-board:layout'

export function readLayout(): LiveBoardLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'mission' ? 'mission' : 'status'
  } catch {
    return 'status'
  }
}

export function writeLayout(layout: LiveBoardLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout)
  } catch {
    // storage unavailable: the choice lasts for this session only
  }
}

// ── What a card does ────────────────────────────────────────────────────────

/**
 * The card's primary action. An inbox item runs the inbox's own primary
 * (Answer, Open review, Resume, Retry, Raise limit); a review-ready card
 * without one opens the review; every other card opens its mission or its run.
 */
export type LivePrimary =
  | { kind: 'inbox'; item: InboxItem }
  | { kind: 'review'; deliveryId: string }
  | { kind: 'open' }
  | { kind: 'none' }

export function primaryOf(card: LiveCard): LivePrimary {
  if (card.attention) return { kind: 'inbox', item: card.attention }
  if (card.column === 'decide' && card.deliveryId) return { kind: 'review', deliveryId: card.deliveryId }
  return canOpen(card) ? { kind: 'open' } : { kind: 'none' }
}

/** A card opens its mission when it has one, else its run detail. */
export function canOpen(card: Pick<LiveCard, 'conversationId' | 'jobId'>): boolean {
  return !!card.conversationId || !!card.jobId
}

/** Message a native board window sends its opener: the opener runs the very same handler. */
export type LiveBoardWindowResult =
  | { action: 'primary'; card: LiveCard }
  | { action: 'open'; card: LiveCard }

export function readLiveBoardWindowResult(value: unknown): LiveBoardWindowResult | null {
  const v = value as { action?: unknown; card?: unknown } | null
  if (!v || (v.action !== 'primary' && v.action !== 'open')) return null
  const card = readCard(v.card)
  return card ? { action: v.action, card } : null
}
