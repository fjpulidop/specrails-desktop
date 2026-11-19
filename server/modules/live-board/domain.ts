/**
 * Live board: pure vocabulary. One view of every run across every project,
 * projected from state other capabilities already own (loop runs, PR
 * deliveries, Intent sessions, queue jobs) plus the "Needs you" inbox items,
 * reused as they are. Nothing here reads a database or a clock.
 *
 * The server decides WHERE a card goes (its column, its lane, its order); the
 * client decides how its state LOOKS, through its run-state vocabulary, from
 * the domain status carried in `status` (never a second state table here).
 */

export const LIVE_RUN_KINDS = ['rail', 'loop', 'intent', 'job'] as const
export type LiveRunKind = (typeof LIVE_RUN_KINDS)[number]

/**
 * Layout A columns: what waits for the person (the inbox, reviews included),
 * what moves, what settled today.
 */
export const LIVE_COLUMNS = ['needs', 'working', 'done'] as const
export type LiveColumn = (typeof LIVE_COLUMNS)[number]

/** Urgency rank of a column (lanes and caps order by it): what needs you first. */
const COLUMN_URGENCY: Readonly<Record<LiveColumn, number>> = { needs: 0, working: 1, done: 2 }

/** The domain status a card carries, as its owning capability names it. */
export type LiveRunStatus =
  | { source: 'job'; status: string }
  | { source: 'loop-run'; status: 'running' | 'paused' | 'completed'; outcome: string | null; restartReason: string | null }
  /** `paused`: still building, but its run is paused (a restart, a question, a limit): nothing moves. */
  | { source: 'delivery'; decision: string; statusCode: string | null; paused?: boolean }
  | { source: 'intent'; state: string }
  /** An inbox item with no run on the board (a Jira update, a reached cap, an older failure). */
  | { source: 'attention' }

/**
 * The inbox item fields the board reads. The full item travels unchanged
 * (`attention` on the card), so the client runs the inbox's own handlers on it.
 */
export interface LiveAttentionRef {
  id: string
  projectId: string
  kind: string
  action: string
  subjectId: string
  conversationId: string | null
  title: string
  at: string
  railIndex?: number
}

/** Pipeline progress, when the run has phases (a queue job): done of total, never guessed. */
export interface LiveSteps {
  done: number
  total: number
}

/** What a project source knows about one run. */
export interface LiveRunFacts {
  /** Row id in its own table (job id, loop-run id, delivery id, Intent session id). */
  sourceId: string
  kind: LiveRunKind
  status: LiveRunStatus
  /** Spec / loop / job title; null when only the mission names it (an Intent session). */
  title: string | null
  /** The current step or phase id, as the run reports it (the client humanizes it). */
  phase: string | null
  /** The question a paused run asks, when the runtime recorded it. */
  question: string | null
  steps: LiveSteps | null
  provider: string | null
  model: string | null
  startedAt: string | null
  finishedAt: string | null
  /**
   * Recorded cost of the run (null when unknown). A chain card (an attempt
   * chain) carries the chain's total, every attempt's cost added up, the way
   * analytics counts it; its latest attempt's own cost is on `attempt`.
   * `costEstimated` marks a cost that is, at least in part, a rate-card
   * estimate; `costEstimatedUsd` is that estimated part (equal to `costUsd`
   * when all of it is estimated), so billed and estimated stay apart.
   */
  costUsd: number | null
  costEstimated: boolean
  costEstimatedUsd: number | null
  /** Cost recorded today (the local day) for this run, every attempt of its chain included; null when nothing was recorded. */
  costTodayUsd: number | null
  railIndex: number | null
  ticketIds: number[]
  /** Mission that launched the run, when known. */
  conversationId: string | null
  /** The job/run detail this run opens (a loop run's id is its backing job's id). */
  jobId: string | null
  /** The delivery whose review this card opens, when it is one. */
  deliveryId: string | null
  /** The inbox subject ids that speak for this run (its delivery, or the run itself). */
  subjectIds: string[]
  /** Where this run stands in its attempt chain ("attempt 3"), when it continued an earlier one. */
  attempt?: LiveAttempt | null
}

/** A continued run's place in its chain; the chain is one card showing its latest attempt. */
export interface LiveAttempt {
  number: number
  of: number
  /** The latest attempt's own recorded cost (null when unknown); the card's `costUsd` is the chain's. */
  costUsd: number | null
  costEstimated: boolean
}

export interface LiveCard<A extends LiveAttentionRef = LiveAttentionRef> extends Omit<LiveRunFacts, 'kind' | 'subjectIds' | 'sourceId'> {
  /** `<projectId>:<source>:<sourceId>`; an attention-only card uses its inbox item id. */
  id: string
  projectId: string
  projectName: string
  /** null: an inbox item that is not a run (Jira update, spend cap). */
  kind: LiveRunKind | null
  column: LiveColumn
  /** 0 needs you · 1 in progress · 2 done today. */
  urgency: number
  /** The instant the card is ordered by (waiting since, started, settled). */
  at: string
  /** The inbox item that speaks for this card, unchanged (null when nothing waits on the person). */
  attention: A | null
  /** A delivery card's last merge preview (conflicts with the current base or
   *  with sibling deliveries); null when none was computed yet. */
  mergePreview?: LiveMergePreview | null
}

/** Merge preview summary of a delivery card (computed by the delivery capability). */
export interface LiveMergePreview {
  status: 'clean' | 'conflicts' | 'already_merged' | 'unknown'
  conflictFileCount: number
  siblingConflictCount: number
  baseAdvancedBy: number | null
}

export interface LiveLane {
  /** The mission's conversation id; null for the final "Not from a mission" lane. */
  conversationId: string | null
  title: string | null
  provider: string | null
  /** Projects of the lane's runs (a mission may span projects). */
  projectIds: string[]
  /** Card ids in the lane, most urgent first. */
  cardIds: string[]
  /** The mission's own turns today plus what its runs recorded today; null when nothing is known. */
  todayCostUsd: number | null
  urgency: number
}

export interface LiveMissionFacts {
  title: string | null
  provider: string | null
  /** Mission turns recorded today (its own ledger); null when none. */
  todayCostUsd: number | null
}

export interface LiveBoardTotals {
  /** The Needs you column: the inbox items (reviews included). */
  needsYou: number
  /** The In progress column, paused runs included (they sit there with their paused look). */
  inProgress: number
  doneToday: number
  /** Today's spend across every project (the analytics source); null when it could not be read. */
  costTodayUsd: number | null
  costTodayEstimated: boolean
}

export interface LiveBoardSnapshot<A extends LiveAttentionRef = LiveAttentionRef> {
  generatedAt: string
  /** The local day the "Done today" column covers (ISO instants, `from` inclusive). */
  day: DayWindow
  projects: Array<{ projectId: string; projectName: string; count: number }>
  /** Every card, grouped by column and ordered within it (needs, working, done). */
  cards: LiveCard<A>[]
  /** Layout B: one lane per mission, most urgent first, "Not from a mission" last. */
  lanes: LiveLane[]
  totals: LiveBoardTotals
}

export interface DayWindow {
  from: string
  to: string
}

export const MAX_CARDS_PER_PROJECT = 120

const DONE_JOB_STATUSES = new Set(['completed', 'failed', 'zombie_terminated', 'canceled', 'skipped'])
const LIVE_DELIVERY_DECISIONS = new Set(['building'])
const WAITING_DELIVERY_DECISIONS = new Set(['on_review', 'pr_draft', 'pr_ready'])
const SETTLED_INTENT_STATES = new Set(['delivered', 'discarded', 'closed'])
const OPEN_INTENT_STATES = new Set(['active', 'paused', 'needs-review'])

function ms(value: string | null | undefined): number {
  if (!value) return Number.NaN
  return Date.parse(value)
}

/** Settled inside the local day (`from` inclusive, `to` exclusive). */
export function settledInDay(finishedAt: string | null, day: DayWindow): boolean {
  const at = ms(finishedAt)
  return Number.isFinite(at) && at >= ms(day.from) && at < ms(day.to)
}

/**
 * The column of a run. An inbox item decides first, so a card is never in two
 * columns: every inbox item (a review included) is "Needs you", like the inbox.
 * Without one, live work is "In progress" and work settled today is "Done
 * today"; anything else is history and stays off the board (null).
 */
export function columnOf(status: LiveRunStatus, attention: Pick<LiveAttentionRef, 'kind'> | null, finishedAt: string | null, day: DayWindow): LiveColumn | null {
  if (attention) return 'needs'
  const today = settledInDay(finishedAt, day)
  switch (status.source) {
    case 'job':
      if (status.status === 'queued' || status.status === 'running') return 'working'
      return DONE_JOB_STATUSES.has(status.status) && today ? 'done' : null
    case 'loop-run':
      if (status.status === 'running' || status.status === 'paused') return 'working'
      return today ? 'done' : null
    case 'delivery':
      if (LIVE_DELIVERY_DECISIONS.has(status.decision)) return 'working'
      // The inbox lists every delivery waiting for a decision; one it missed still waits on the person.
      if (WAITING_DELIVERY_DECISIONS.has(status.decision)) return 'needs'
      return today ? 'done' : null
    case 'intent':
      if (OPEN_INTENT_STATES.has(status.state)) return 'working'
      return SETTLED_INTENT_STATES.has(status.state) && today ? 'done' : null
    case 'attention':
      return null
  }
}

export function columnUrgency(column: LiveColumn): number {
  return COLUMN_URGENCY[column]
}

function isQueued(card: Pick<LiveCard, 'status'>): boolean {
  return card.status.source === 'job' && card.status.status === 'queued'
}

/** A paused loop run or Intent session: open, but nothing moves until the person resumes it. */
export function isPausedRun(status: LiveRunStatus): boolean {
  return (status.source === 'loop-run' && status.status === 'paused') || (status.source === 'intent' && status.state === 'paused') || (status.source === 'delivery' && status.paused === true)
}

/** In progress: running first, then queued, then paused (open but not moving). */
function workingRank(card: Pick<LiveCard, 'status'>): number {
  return isPausedRun(card.status) ? 2 : isQueued(card) ? 1 : 0
}

function tieBreak(a: LiveCard, b: LiveCard): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function byInstant(a: string | null, b: string | null, direction: 1 | -1): number {
  const x = ms(a), y = ms(b)
  if (!Number.isFinite(x) && !Number.isFinite(y)) return 0
  if (!Number.isFinite(x)) return 1
  if (!Number.isFinite(y)) return -1
  return (x - y) * direction
}

/**
 * Order inside a column. Needs you: oldest first (what has waited
 * longest on top). In progress: running, then queued, then paused, each oldest first, so a
 * new run joins at the end instead of shuffling the column. Done today: most
 * recent first.
 */
export function compareCards(a: LiveCard, b: LiveCard): number {
  if (a.urgency !== b.urgency) return a.urgency - b.urgency
  if (a.column === 'working') {
    const rank = workingRank(a) - workingRank(b)
    if (rank !== 0) return rank
  }
  const order = byInstant(a.at, b.at, a.column === 'done' ? -1 : 1)
  return order !== 0 ? order : tieBreak(a, b)
}

function sortInstant(column: LiveColumn, facts: Pick<LiveRunFacts, 'startedAt' | 'finishedAt'>, attention: LiveAttentionRef | null, fallback: string): string {
  if (attention) return attention.at
  if (column === 'done') return facts.finishedAt ?? facts.startedAt ?? fallback
  return facts.startedAt ?? facts.finishedAt ?? fallback
}

/** The kind of run an inbox item speaks for when the run itself is not on the board. */
export function attentionKind(item: Pick<LiveAttentionRef, 'action' | 'railIndex'>): LiveRunKind | null {
  if (item.action === 'open-review') return 'rail'
  if (item.action === 'open-run' || item.action === 'resume-run') return typeof item.railIndex === 'number' ? 'rail' : 'loop'
  return null
}

export interface ProjectRead<A extends LiveAttentionRef> {
  projectId: string
  projectName: string
  runs: readonly LiveRunFacts[]
  /** This project's inbox items (already the inbox's own projection). */
  attention: readonly A[]
}

/**
 * Turn one project's runs and inbox items into cards: each inbox item lands on
 * the run it speaks for (or becomes its own card), each run lands in at most
 * one column, and the project is capped (most urgent kept).
 */
export function projectCards<A extends LiveAttentionRef>(read: ProjectRead<A>, day: DayWindow, nowIso: string): LiveCard<A>[] {
  const bySubject = new Map<string, A>()
  for (const item of read.attention) if (item.projectId === read.projectId && !bySubject.has(item.subjectId)) bySubject.set(item.subjectId, item)
  const claimed = new Set<string>()
  const cards: LiveCard<A>[] = []
  const seen = new Set<string>()
  for (const run of read.runs) {
    const id = `${read.projectId}:${run.status.source}:${run.sourceId}`
    if (seen.has(id)) continue
    seen.add(id)
    let attention: A | null = null
    for (const subject of run.subjectIds) {
      const item = bySubject.get(subject)
      if (item && !claimed.has(item.id)) { attention = item; break }
    }
    const column = columnOf(run.status, attention, run.finishedAt, day)
    if (!column) continue
    if (attention) claimed.add(attention.id)
    const { kind, subjectIds: _subjects, sourceId: _source, ...rest } = run
    cards.push({
      ...rest,
      // An item keeps the mission the inbox knows when the run did not say.
      conversationId: run.conversationId ?? attention?.conversationId ?? null,
      id, projectId: read.projectId, projectName: read.projectName, kind, column,
      urgency: columnUrgency(column), at: sortInstant(column, run, attention, nowIso), attention,
    })
  }
  for (const item of read.attention) {
    if (item.projectId !== read.projectId || claimed.has(item.id)) continue
    claimed.add(item.id)
    const column: LiveColumn = 'needs'
    cards.push({
      id: item.id, projectId: read.projectId, projectName: read.projectName,
      kind: attentionKind(item), status: { source: 'attention' }, title: item.title, phase: null, question: null, steps: null,
      provider: null, model: null, startedAt: null, finishedAt: null, costUsd: null, costEstimated: false, costEstimatedUsd: null, costTodayUsd: null,
      railIndex: typeof item.railIndex === 'number' ? item.railIndex : null, ticketIds: [], conversationId: item.conversationId,
      jobId: null, deliveryId: null, column, urgency: columnUrgency(column), at: item.at, attention: item,
    })
  }
  cards.sort(compareCards)
  // The cap drops settled history first: the sort already put it last.
  return cards.slice(0, MAX_CARDS_PER_PROJECT)
}

/** Every card in board order: by column (needs, working, done), then each column's own order. */
export function boardOrder(a: LiveCard, b: LiveCard): number {
  return compareCards(a, b)
}

function latest(card: LiveCard): number {
  let best = Number.NEGATIVE_INFINITY
  for (const value of [card.at, card.startedAt, card.finishedAt]) {
    const at = ms(value)
    if (Number.isFinite(at) && at > best) best = at
  }
  return best
}

/**
 * Layout B: one lane per mission holding every run it launched. Lanes order by
 * urgency (a lane with something that needs you first, then one working, then
 * one done today), then by most recent activity; the runs without
 * a mission close the list in one "Not from a mission" lane.
 */
export function buildLanes(cards: readonly LiveCard[], missions: ReadonlyMap<string, LiveMissionFacts>): LiveLane[] {
  const groups = new Map<string | null, LiveCard[]>()
  for (const card of cards) {
    const key = card.conversationId ?? null
    const list = groups.get(key)
    if (list) list.push(card)
    else groups.set(key, [card])
  }
  const lanes: Array<LiveLane & { recent: number }> = []
  for (const [conversationId, list] of groups) {
    const ordered = [...list].sort(compareCards)
    const mission = conversationId ? missions.get(conversationId) ?? null : null
    let cost: number | null = mission?.todayCostUsd ?? null
    for (const card of ordered) if (card.costTodayUsd !== null) cost = (cost ?? 0) + card.costTodayUsd
    lanes.push({
      conversationId,
      title: mission?.title ?? null,
      provider: mission?.provider ?? ordered.find((card) => card.provider)?.provider ?? null,
      projectIds: [...new Set(ordered.map((card) => card.projectId))],
      cardIds: ordered.map((card) => card.id),
      todayCostUsd: cost,
      urgency: Math.min(...ordered.map((card) => card.urgency)),
      recent: Math.max(...ordered.map(latest)),
    })
  }
  lanes.sort((a, b) => {
    if ((a.conversationId === null) !== (b.conversationId === null)) return a.conversationId === null ? 1 : -1
    if (a.urgency !== b.urgency) return a.urgency - b.urgency
    if (a.recent !== b.recent) return b.recent - a.recent
    return String(a.conversationId) < String(b.conversationId) ? -1 : 1
  })
  return lanes.map(({ recent: _recent, ...lane }) => lane)
}

/** Column counts: each total is the number of cards in its column, so a header never disagrees with the columns. */
export function countColumns(cards: readonly Pick<LiveCard, 'column'>[]): Pick<LiveBoardTotals, 'needsYou' | 'inProgress' | 'doneToday'> {
  const totals = { needsYou: 0, inProgress: 0, doneToday: 0 }
  for (const card of cards) {
    if (card.column === 'needs') totals.needsYou += 1
    else if (card.column === 'working') totals.inProgress += 1
    else totals.doneToday += 1
  }
  return totals
}

/** SQLite `datetime('now')` is UTC without a zone: make it ISO so clients parse it right. */
export function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
  const at = Date.parse(normalized)
  return Number.isNaN(at) ? null : new Date(at).toISOString()
}
