// Client model of the server-derived milestone progress (premium-milestone-
// progress). Mirrors `server/modules/builder/runtime/milestone-progress.ts`: every count is a fact from
// a durable row; the derived `state` is what surfaces render. Pure helpers only
// — no fetching, no React.

/** `paused`: a chain owns the milestone but stopped (a pause or a checkpoint). */
export type MilestoneState = 'planned' | 'committed' | 'running' | 'paused' | 'delivered' | 'done'

export interface MilestoneCounts {
  total: number
  done: number
  onReview: number
  inProgress: number
  todo: number
  /** Specs currently pending whose newest delivery unit failed. */
  failed: number
}

/** The delivery fields the milestone surfaces use (a subset of the server snapshot). */
export interface MilestoneDelivery {
  id: string
  railIndex: number
  ticketIds: number[]
  decision: string
  branch: string | null
  baseBranch: string
  prUrl: string | null
  prNumber: number | null
  prState: string
  createdAt: string | null
}

/** Why a live rail run is not working right now (mirrors the server's shared
 *  run hold, `loop-run-hold.ts`). */
export type RailHoldKind = 'restart' | 'interrupted' | 'provider_limit' | 'budget' | 'question' | 'approval' | 'paused' | 'queued'

export interface RailHold {
  kind: RailHoldKind
  /** When the run stopped doing anything (ISO), if known. */
  since: string | null
  /** `paused`: the person's own Pause (only their Resume continues it). */
  byYou?: true
  /** `provider_limit`: when the provider accepts requests again. */
  resumeAt?: string
  /** `queued`: the capacity it waits for, and its place in line. */
  waitingFor?: string
  position?: number
}

export interface MilestoneRail {
  railIndex: number
  name: string | null
  ticketIds: number[]
  /** A run is live on the rail: working, or held (`hold`). */
  active: boolean
  /** The live run's hold; null while it works (or no run is live). */
  hold: RailHold | null
  /** The engine the rail's run uses (provider · model · effort); null when unknown. */
  engine: MilestoneEngine | null
  runId: string | null
  startedAt: string | null
  delivery: MilestoneDelivery | null
  chunkIndex: number | null
}

/** `awaiting_approval` = a wave checkpoint: the last rail delivered fine and
 *  the chain waits for the user's go (auto-advance off). */
export type MilestoneChainStatus = 'running' | 'waiting' | 'paused' | 'awaiting_approval' | 'completed' | 'cancelled'

/** Provider · model · effort a rail runs on (null effort: the provider's default). */
export interface MilestoneEngine {
  provider: string
  model: string
  reasoningEffort: string | null
}

/** Where the next rail's engine comes from: the milestone's own configuration,
 *  the usual one saved since the chain started, or the Launch choice. */
export type MilestoneEngineSource = 'milestone' | 'usual' | 'launch'

export interface MilestoneChainLaunched {
  chunk: number
  railIndex: number
  ticketIds: number[]
  runIds: string[]
  deliveryId: string | null
  /** The engine the rail was launched on; null when not recorded. */
  engine: MilestoneEngine | null
}

export interface MilestoneChainSnapshot {
  id: string
  milestoneN: number
  /** 'parallel' only on historical rows (the Parallel option was removed). */
  mode: 'sequential' | 'parallel'
  status: MilestoneChainStatus
  pauseReason: string | null
  /** false ⇒ every successful rail parks the chain at a checkpoint. */
  autoAdvance: boolean
  nextChunk: number
  totalChunks: number
  currentRailIndex: number | null
  headBranch: string | null
  /** 0-based chunk a paused chain stopped on because it FAILED (Resume can
   *  continue it from the failed step or relaunch it), else null. */
  retryChunk: number | null
  launched: MilestoneChainLaunched[]
  createdAt: string | null
  updatedAt: string
  /** The server's reconciliation (tickets, deliveries and runs, manual ones
   *  included): the recommended next step first. Null when not provided. */
  plan: ChainPlanView | null
  /** The engine the chain's next rail launches on, resolved now; null = the rails' defaults. */
  nextEngine: (MilestoneEngine & { source: MilestoneEngineSource }) | null
}

/** One step the chain can take next (mirrors the server's ChainOffer). */
export type ChainOfferKind =
  | 'complete' | 'next' | 'launch' | 'retry' | 'resume_failed_step' | 'retry_from_start'
  | 'resume_run' | 'follow_run' | 'answer_run' | 'integrate' | 'rebuild'

export interface ChainOffer {
  kind: ChainOfferKind
  from: 'recommended' | 'failed_step' | 'start'
  ticketId: number | null
  title: string | null
  runId: string | null
  nextTicketId: number | null
}

export type ChainSpecState = 'done' | 'integrated' | 'delivered' | 'running' | 'paused' | 'failed' | 'pending'

/** The reconciled next action's kind and the run it acts on (subset of the server's). */
export interface ChainPlanAction {
  kind: 'complete' | 'launch' | 'adopt_run' | 'resume_run' | 'answer_run' | 'integrate' | 'resume_failed'
  ticketId: number | null
  runId: string | null
  /** `resume_run`: why the run is paused (user / budget / limit / restart). */
  pauseKind: string | null
}

export interface ChainPlanView {
  action: ChainPlanAction | null
  offers: ChainOffer[]
  specs: Array<{ ticketId: number; title: string | null; state: ChainSpecState }>
  settled: number
  total: number
  pausedTicketId: number | null
  pausedSpecSettled: boolean
}

const ACTION_KINDS: ReadonlySet<string> = new Set(['complete', 'launch', 'adopt_run', 'resume_run', 'answer_run', 'integrate', 'resume_failed'])

function coerceAction(raw: unknown): ChainPlanAction | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.kind !== 'string' || !ACTION_KINDS.has(o.kind)) return null
  return { kind: o.kind as ChainPlanAction['kind'], ticketId: typeof o.ticketId === 'number' ? o.ticketId : null, runId: typeof o.runId === 'string' ? o.runId : null, pauseKind: typeof o.pauseKind === 'string' ? o.pauseKind : null }
}

const OFFER_KINDS: ReadonlySet<string> = new Set(['complete', 'next', 'launch', 'retry', 'resume_failed_step', 'retry_from_start', 'resume_run', 'follow_run', 'answer_run', 'integrate', 'rebuild'])
const SPEC_STATES: ReadonlySet<string> = new Set(['done', 'integrated', 'delivered', 'running', 'paused', 'failed', 'pending'])

export function coerceChainPlan(raw: unknown): ChainPlanView | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const offers = Array.isArray(o.offers) ? o.offers.flatMap((x): ChainOffer[] => {
    if (!x || typeof x !== 'object') return []
    const e = x as Record<string, unknown>
    if (typeof e.kind !== 'string' || !OFFER_KINDS.has(e.kind)) return []
    const from = e.from === 'failed_step' || e.from === 'start' ? e.from : 'recommended'
    return [{
      kind: e.kind as ChainOfferKind, from,
      ticketId: typeof e.ticketId === 'number' ? e.ticketId : null,
      title: str(e.title), runId: str(e.runId),
      nextTicketId: typeof e.nextTicketId === 'number' ? e.nextTicketId : null,
    }]
  }) : []
  const specs = Array.isArray(o.specs) ? o.specs.flatMap((x) => {
    if (!x || typeof x !== 'object') return []
    const e = x as Record<string, unknown>
    if (typeof e.ticketId !== 'number' || typeof e.state !== 'string' || !SPEC_STATES.has(e.state)) return []
    return [{ ticketId: e.ticketId, title: str(e.title), state: e.state as ChainSpecState }]
  }) : []
  return {
    action: coerceAction(o.action),
    offers, specs, settled: num(o.settled), total: num(o.total),
    pausedTicketId: typeof o.pausedTicketId === 'number' ? o.pausedTicketId : null,
    pausedSpecSettled: o.pausedSpecSettled === true,
  }
}

/** The recommended next step of a stopped chain (null: no plan / nothing to offer). */
export function primaryChainOffer(chain: MilestoneChainSnapshot | null): ChainOffer | null {
  return chain?.plan?.offers[0] ?? null
}

/** Stable identity of the recommended step (a toast updates in place when it moves). */
export function chainOfferKey(offer: ChainOffer | null): string {
  return offer ? `${offer.kind}:${offer.ticketId ?? ''}:${offer.runId ?? ''}` : ''
}

/** i18n params for an offer label: `#7 Animate the tabletop…`. */
export function chainOfferParams(offer: ChainOffer, plan: ChainPlanView | null): Record<string, string | number> {
  const spec = offer.ticketId !== null ? `#${offer.ticketId}` : ''
  const title = offer.title ? truncateTitle(offer.title) : ''
  const next = offer.nextTicketId !== null ? `#${offer.nextTicketId}` : ''
  const paused = plan?.pausedTicketId != null ? `#${plan.pausedTicketId}` : ''
  return { spec, title, next, paused, specTitle: title ? `${spec} ${title}` : spec }
}

function truncateTitle(title: string, max = 40): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title
}

export interface MilestoneProgress {
  id: string
  n: number
  title: string
  storedStatus: 'planned' | 'committed' | 'done'
  state: MilestoneState
  counts: MilestoneCounts
  rails: MilestoneRail[]
  chain: MilestoneChainSnapshot | null
}

export function milestoneLabelFor(n: number): string {
  return `M${n}`
}

// ─── Defensive parsing (REST + WS payloads) ──────────────────────────────────

const STATES: ReadonlySet<string> = new Set(['planned', 'committed', 'running', 'paused', 'delivered', 'done'])
const CHAIN_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting', 'paused', 'awaiting_approval', 'completed', 'cancelled'])

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [])
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function coerceCounts(raw: unknown): MilestoneCounts {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    total: num(o.total), done: num(o.done), onReview: num(o.onReview),
    inProgress: num(o.inProgress), todo: num(o.todo), failed: num(o.failed),
  }
}

function coerceDelivery(raw: unknown): MilestoneDelivery | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  if (!id) return null
  return {
    id,
    railIndex: num(o.railIndex, -1),
    ticketIds: nums(o.ticketIds),
    decision: str(o.decision) ?? 'building',
    branch: str(o.branch),
    baseBranch: str(o.baseBranch) ?? '',
    prUrl: str(o.prUrl),
    prNumber: typeof o.prNumber === 'number' ? o.prNumber : null,
    prState: str(o.prState) ?? 'none',
    createdAt: str(o.createdAt),
  }
}

export function coerceEngine(raw: unknown): MilestoneEngine | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.provider !== 'string' || !o.provider || typeof o.model !== 'string' || !o.model) return null
  return { provider: o.provider, model: o.model, reasoningEffort: typeof o.reasoningEffort === 'string' ? o.reasoningEffort : null }
}

export function sameEngine(a: MilestoneEngine | null | undefined, b: MilestoneEngine | null | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.model === b.model && (a.reasoningEffort ?? null) === (b.reasoningEffort ?? null)
}

const HOLD_KINDS: ReadonlySet<string> = new Set(['restart', 'interrupted', 'provider_limit', 'budget', 'question', 'approval', 'paused', 'queued'])

export function coerceRailHold(raw: unknown): RailHold | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.kind !== 'string' || !HOLD_KINDS.has(o.kind)) return null
  return {
    kind: o.kind as RailHoldKind,
    since: typeof o.since === 'string' && Number.isFinite(Date.parse(o.since)) ? o.since : null,
    ...(o.kind === 'paused' && o.byYou === true ? { byYou: true as const } : {}),
    ...(typeof o.resumeAt === 'string' ? { resumeAt: o.resumeAt } : {}),
    ...(typeof o.waitingFor === 'string' ? { waitingFor: o.waitingFor } : {}),
    ...(typeof o.position === 'number' ? { position: o.position } : {}),
  }
}

function coerceRail(raw: unknown): MilestoneRail | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.railIndex !== 'number') return null
  return {
    railIndex: o.railIndex,
    name: str(o.name),
    ticketIds: nums(o.ticketIds),
    active: o.active === true,
    hold: o.active === true ? coerceRailHold(o.hold) : null,
    engine: coerceEngine(o.engine),
    runId: str(o.runId),
    startedAt: str(o.startedAt),
    delivery: coerceDelivery(o.delivery),
    chunkIndex: typeof o.chunkIndex === 'number' ? o.chunkIndex : null,
  }
}

export function coerceChain(raw: unknown): MilestoneChainSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  const status = str(o.status)
  if (!id || !status || !CHAIN_STATUSES.has(status)) return null
  const launched = Array.isArray(o.launched)
    ? o.launched.flatMap((l): MilestoneChainLaunched[] => {
        if (!l || typeof l !== 'object') return []
        const e = l as Record<string, unknown>
        if (typeof e.chunk !== 'number' || typeof e.railIndex !== 'number') return []
        return [{ chunk: e.chunk, railIndex: e.railIndex, ticketIds: nums(e.ticketIds), runIds: strs(e.runIds), deliveryId: str(e.deliveryId), engine: coerceEngine(e.engine) }]
      })
    : []
  return {
    id,
    milestoneN: num(o.milestoneN, 0),
    mode: o.mode === 'parallel' ? 'parallel' : 'sequential',
    status: status as MilestoneChainStatus,
    pauseReason: str(o.pauseReason),
    autoAdvance: o.autoAdvance !== false,
    nextChunk: num(o.nextChunk),
    totalChunks: num(o.totalChunks),
    currentRailIndex: typeof o.currentRailIndex === 'number' ? o.currentRailIndex : null,
    headBranch: str(o.headBranch),
    retryChunk: typeof o.retryChunk === 'number' && o.retryChunk >= 0 ? o.retryChunk : null,
    launched,
    createdAt: typeof o.createdAt === 'string' && Number.isFinite(Date.parse(o.createdAt)) ? o.createdAt : null,
    updatedAt: str(o.updatedAt) ?? '',
    plan: coerceChainPlan(o.plan),
    nextEngine: (() => {
      const engine = coerceEngine(o.nextEngine)
      if (!engine) return null
      const source = (o.nextEngine as { source?: unknown }).source
      return { ...engine, source: source === 'milestone' || source === 'usual' ? source : 'launch' }
    })(),
  }
}

/**
 * The chain's next-rail engine line: shown while a rail is still to launch.
 * `changed` = it differs from the engine the last launched rail used (the
 * person changed the configuration while the chain is live).
 */
export function chainNextEngine(chain: MilestoneChainSnapshot | null): { engine: MilestoneEngine; source: MilestoneEngineSource; changed: boolean } | null {
  if (!chain?.nextEngine) return null
  if (!['running', 'waiting', 'paused', 'awaiting_approval'].includes(chain.status)) return null
  // A spec not launched yet, or a retry that launches a new rail.
  const pending = chain.launched.length < chain.totalChunks || chain.plan?.action?.kind === 'launch'
  if (!pending) return null
  const { source, ...engine } = chain.nextEngine
  const sorted = [...chain.launched].sort((a, b) => a.chunk - b.chunk)
  const last = sorted[sorted.length - 1]?.engine ?? null
  return { engine, source, changed: last !== null && !sameEngine(last, engine) }
}

export function coerceMilestoneProgress(raw: unknown): MilestoneProgress[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): MilestoneProgress[] => {
    if (!item || typeof item !== 'object') return []
    const o = item as Record<string, unknown>
    const id = str(o.id)
    if (!id || typeof o.n !== 'number') return []
    const state = str(o.state)
    const stored = str(o.storedStatus)
    return [{
      id,
      n: o.n,
      title: str(o.title) ?? '',
      storedStatus: stored === 'done' || stored === 'committed' ? stored : 'planned',
      state: state && STATES.has(state) ? (state as MilestoneState) : 'planned',
      counts: coerceCounts(o.counts),
      rails: Array.isArray(o.rails) ? o.rails.flatMap((r) => { const rail = coerceRail(r); return rail ? [rail] : [] }) : [],
      chain: coerceChain(o.chain),
    }]
  })
}

// ─── Derivations for the surfaces ────────────────────────────────────────────

export type SegmentKey = 'done' | 'onReview' | 'inProgress' | 'failed' | 'todo'

export interface ProgressSegment {
  key: SegmentKey
  count: number
  /** Share of the bar, 0–100. */
  pct: number
}

/** Segmented-bar model: done / in review / in progress / failed / pending.
 *  `failed` specs are a subset of `todo` and are carved out of it. */
export function progressSegments(counts: MilestoneCounts): ProgressSegment[] {
  const total = Math.max(0, counts.total)
  if (total === 0) return []
  const failed = Math.min(counts.failed, counts.todo)
  const raw: Array<[SegmentKey, number]> = [
    ['done', counts.done],
    ['onReview', counts.onReview],
    ['inProgress', counts.inProgress],
    ['failed', failed],
    ['todo', Math.max(0, counts.todo - failed)],
  ]
  return raw
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, count, pct: Math.round((count / total) * 1000) / 10 }))
}

/** Specs that left the backlog through a run and are either merged or awaiting review. */
export function deliveredCount(counts: MilestoneCounts): number {
  return counts.done + counts.onReview
}

// ─── Held rails (a live run that is not working right now) ───────────────────

/** The label/sentence key of a hold: the person's Pause has its own words. */
export type RailHoldKey = Exclude<RailHoldKind, 'paused'> | 'paused' | 'pausedByYou'

export function railHoldKey(hold: RailHold): RailHoldKey {
  return hold.kind === 'paused' && hold.byYou ? 'pausedByYou' : hold.kind
}

/** A hold in the status vocabulary (DESIGN.md › Status vocabulary; same table as jobs). */
export const RAIL_HOLD_RUN_STATE = {
  restart: 'paused',
  interrupted: 'paused',
  provider_limit: 'blocked',
  budget: 'paused',
  question: 'needs-input',
  approval: 'needs-input',
  paused: 'paused',
  queued: 'queued',
} as const satisfies Record<RailHoldKind, 'paused' | 'blocked' | 'needs-input' | 'queued'>

/** What the person can do from the rail row: Resume their own Pause, or open
 *  the run to answer it. Every other hold resumes by itself or from the run. */
export function railHoldAction(hold: RailHold): 'resume' | 'answer' | null {
  if (hold.kind === 'paused' && hold.byYou) return 'resume'
  if (hold.kind === 'question' || hold.kind === 'approval') return 'answer'
  return null
}

/** Run time of a live rail: ticking while it works, frozen at the moment it
 *  stopped while held (null: unknown, e.g. a held run without a stop time). */
export function railElapsedMs(rail: Pick<MilestoneRail, 'active' | 'hold' | 'startedAt'>, now: number): number | null {
  if (!rail.active || !rail.startedAt) return null
  const start = Date.parse(rail.startedAt)
  if (!Number.isFinite(start)) return null
  if (!rail.hold) return Math.max(0, now - start)
  const stopped = rail.hold.since ? Date.parse(rail.hold.since) : Number.NaN
  return Number.isFinite(stopped) ? Math.max(0, stopped - start) : null
}

const PAUSE_KIND_HOLD: Record<string, RailHoldKey> = { user: 'pausedByYou', budget: 'budget', limit: 'provider_limit', restart: 'restart', decision: 'question' }

/**
 * The held rail a live chain is waiting on (the run its reconciled action
 * follows or resumes), with the hold's key; null while that rail works. A
 * chain waits on a held run instead of launching (reconcile: "adopt and wait").
 */
export function chainHeldRail(chain: MilestoneChainSnapshot | null, rails: MilestoneRail[]): { rail: MilestoneRail | null; key: RailHoldKey; runId: string | null; chunk: number } | null {
  if (!chain || !chainIsLive(chain)) return null
  const action = chain.plan?.action ?? null
  const runId = action && (action.kind === 'resume_run' || action.kind === 'answer_run' || action.kind === 'adopt_run') ? action.runId : null
  const rail = (runId ? rails.find((r) => r.active && r.runId === runId) : undefined)
    ?? rails.find((r) => r.active && r.chunkIndex === chain.nextChunk)
    ?? null
  const chunk = rail?.chunkIndex ?? chain.nextChunk
  if (rail?.hold) return { rail, key: railHoldKey(rail.hold), runId: rail.runId, chunk }
  // An older payload without holds: the plan still says the run is paused.
  if (action?.kind === 'resume_run' || action?.kind === 'answer_run') {
    return { rail, key: action.kind === 'answer_run' ? 'question' : PAUSE_KIND_HOLD[action.pauseKind ?? 'user'] ?? 'paused', runId, chunk }
  }
  return null
}

export function chainIsLive(chain: MilestoneChainSnapshot | null): boolean {
  return chain !== null && (chain.status === 'running' || chain.status === 'waiting')
}

/** The chain sits at a wave checkpoint: healthy, waiting for "Launch next rail". */
export function chainAtCheckpoint(chain: MilestoneChainSnapshot | null): boolean {
  return chain !== null && chain.status === 'awaiting_approval'
}

/** A milestone can be (re)launched when specs are pending and no chain is driving it. */
export function isMilestoneLaunchable(p: MilestoneProgress): boolean {
  return p.counts.todo > 0 && !chainIsLive(p.chain) && p.chain?.status !== 'paused' && !chainAtCheckpoint(p.chain)
}

/** Delivery ids that a LATER chunk of a sequential chain was stacked on —
 *  discarding one of these pauses its chain (the decision surfaces warn). */
export function stackedHeadDeliveryIds(progress: MilestoneProgress[]): Set<string> {
  const out = new Set<string>()
  for (const m of progress) {
    const chain = m.chain
    if (!chain || chain.mode !== 'sequential') continue
    const ordered = [...chain.launched].sort((a, b) => a.chunk - b.chunk)
    for (let i = 0; i < ordered.length - 1; i++) {
      const id = ordered[i].deliveryId
      if (id) out.add(id)
    }
  }
  return out
}

/** Split `launch_rejected:<error>` style reasons into an i18n key + detail. */
export function chainPauseReason(reason: string | null): { key: string; detail: string } {
  if (!reason) return { key: 'unknown', detail: '' }
  const idx = reason.indexOf(':')
  if (idx < 0) return { key: reason, detail: '' }
  return { key: reason.slice(0, idx), detail: reason.slice(idx + 1) }
}

/** The delivery a "Review" action should open for a milestone: the newest
 *  reviewable one (on_review first, then draft/ready), null when none. */
export const REVIEWABLE_DECISIONS: ReadonlySet<string> = new Set(['on_review', 'no_changes', 'pr_draft', 'pr_ready', 'pr_failed', 'implementation_failed', 'pr_closed'])

export function reviewableDelivery(p: MilestoneProgress): MilestoneDelivery | null {
  const candidates = p.rails.map((r) => r.delivery).filter((d): d is MilestoneDelivery => d !== null && REVIEWABLE_DECISIONS.has(d.decision))
  if (candidates.length === 0) return null
  const onReview = candidates.find((d) => d.decision === 'on_review')
  return onReview ?? candidates[0]
}

/** What opening a rail row leads to: its live run, else its delivery's review, else nothing of its own. */
export type MilestoneRailOpen =
  | { kind: 'run'; runId: string }
  | { kind: 'review'; deliveryId: string }
  | { kind: 'none' }

export function milestoneRailOpen(rail: Pick<MilestoneRail, 'runId' | 'delivery'>): MilestoneRailOpen {
  if (rail.runId) return { kind: 'run', runId: rail.runId }
  if (rail.delivery) return { kind: 'review', deliveryId: rail.delivery.id }
  return { kind: 'none' }
}
