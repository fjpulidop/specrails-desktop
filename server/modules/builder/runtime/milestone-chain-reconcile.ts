// Milestone chain reconciliation (pure): the ONE place that decides what a
// Blueprint launch chain does next.
//
// A chain used to trust its own bookkeeping (frozen chunks, `retry_chunk`, the
// head branch it recorded). Anything the person did outside it — resuming a
// failed run from the run page, running a spec manually, merging or discarding
// a delivery — left the chain blind: Resume re-ran a spec that was already
// merged. Reconciliation re-derives every spec's real state from the durable
// rows (ticket store, deliveries, runs — the chain's AND manual ones) and
// returns the next action, the base the next rail stacks on, and the offers the
// surfaces render. The chain manager executes the action; the chain snapshot
// carries the plan so the chain row, the resume menu, the toast and the
// milestone pill all show the same recommendation. No I/O here.
//
// Casuistry: docs/internals/project-builder.md#chain-reconciliation.

export interface ReconcileTicket {
  id: number
  status: string
  labels: string[]
  title?: string | null
  prerequisites?: number[]
  executionOrder?: number | null
}

export interface ReconcileDeliveryUnit {
  ticketId?: number | null
  branch?: string | null
  succeeded?: boolean
  implementationOutcome?: string | null
  deliveryOutcome?: string | null
}

export interface ReconcileDelivery {
  id: string
  railIndex: number
  ticketIds: number[]
  decision: string
  implementationOutcome?: string | null
  branch: string | null
  units?: ReconcileDeliveryUnit[]
  runIds?: string[]
  createdAt: string
}

/** `pauseReason` is the run row's `restart_reason` (user_paused / budget_paused /
 *  limit_paused / restart); null on a paused run = a question or an approval. */
export interface ReconcileRun {
  id: string
  ticketIds: number[]
  railIndex: number | null
  status: string
  outcome: string | null
  pauseReason: string | null
  forkOf: string | null
  engineVersion: number | null
  startedAt: string | null
}

export interface ReconcileLaunched {
  chunk: number
  railIndex: number
  ticketIds: number[]
  runIds: string[]
  deliveryId: string | null
}

export interface ReconcileChain {
  milestoneN: number
  status: string
  chunks: number[][]
  launched: ReconcileLaunched[]
  retryChunk: number | null
  headBranch: string | null
  integrationBranch: string | null
  /** Why the chain paused, and the delivery it was integrating (a refused
   *  integration — e.g. a merge conflict — changes what Resume should offer). */
  pauseReason?: string | null
  currentDeliveryId?: string | null
}

export interface ReconcileInput {
  chain: ReconcileChain
  tickets: ReconcileTicket[]
  deliveries: ReconcileDelivery[]
  runs: ReconcileRun[]
  /** Production chains integrate every delivery (guarded merge-local) before
   *  the next rail; legacy adapters stack the next rail on the last branch. */
  integrates: boolean
}

export type ChainSpecState = 'done' | 'integrated' | 'delivered' | 'running' | 'paused' | 'failed' | 'pending'
export type ChainRunPauseKind = 'user' | 'restart' | 'budget' | 'limit' | 'decision'

export interface ChainPlanSpec {
  ticketId: number
  title: string | null
  state: ChainSpecState
  deliveryId: string | null
  runId: string | null
  railIndex: number | null
  branch: string | null
  pauseKind: ChainRunPauseKind | null
  /** Failed spec: the newest run of its lineage that can continue from the failed step. */
  resumableRunId: string | null
  /** Pending spec whose newest attempt failed (its delivery was discarded). */
  lastAttemptFailed: boolean
}

export type ChainNextAction =
  | { kind: 'complete' }
  | { kind: 'launch'; ticketId: number; retry: boolean }
  | { kind: 'adopt_run'; ticketId: number; runId: string | null; deliveryId: string | null; railIndex: number | null }
  | { kind: 'resume_run'; ticketId: number; runId: string; deliveryId: string | null; railIndex: number | null; pauseKind: ChainRunPauseKind }
  | { kind: 'answer_run'; ticketId: number; runId: string; deliveryId: string | null; railIndex: number | null }
  | { kind: 'integrate'; ticketId: number; deliveryId: string; railIndex: number }
  | { kind: 'resume_failed'; ticketId: number; runId: string; deliveryId: string | null; railIndex: number | null }

/** What a Resume offer does (sent back as `from`). `recommended` executes the
 *  plan's action; `failed_step`/`start` pick between the two failed-spec paths. */
export type ChainResumeFrom = 'recommended' | 'failed_step' | 'start'

export type ChainOfferKind =
  | 'complete' | 'next' | 'launch' | 'retry' | 'resume_failed_step' | 'retry_from_start'
  | 'resume_run' | 'follow_run' | 'answer_run' | 'integrate' | 'rebuild'

export interface ChainOffer {
  kind: ChainOfferKind
  from: ChainResumeFrom
  ticketId: number | null
  title: string | null
  runId: string | null
  /** For `next`/`integrate`: the spec after the one being integrated or skipped. */
  nextTicketId?: number | null
}

export interface ChainPlan {
  /** Launch order (ticket ids), recomputed from the live milestone. */
  order: number[]
  specs: ChainPlanSpec[]
  /** What Resume / Launch next does. */
  action: ChainNextAction
  /** What an automatic advance (auto-advance, settle, restart) does: an action,
   *  or a pause with an honest reason (a failed spec is never retried silently). */
  auto: { kind: 'proceed'; action: ChainNextAction } | { kind: 'pause'; reason: string; ticketId: number }
  /** Ordered: the first is the recommended next step. */
  offers: ChainOffer[]
  /** The branch the next launched rail stacks on (null = the integration branch). */
  baseBranch: string | null
  /** Deliveries settled before the action spec, in order (multi-repository stacking). */
  baseDeliveryIds: string[]
  /** Specs settled (done / integrated / delivered-without-integration). */
  settled: number
  total: number
  /** The spec the chain last ran (its rail), and whether it is already settled. */
  pausedTicketId: number | null
  pausedSpecSettled: boolean
}

/**
 * Launch order for a milestone's specs: a stable topological order over the
 * specs' `prerequisites` (edges to specs outside the set — already done or in
 * another milestone — are ignored), ties broken by `execution_order` (unset
 * last) and then id. A dependency cycle cannot block the milestone: the
 * remaining specs follow in tie order.
 */
export function orderChainTickets(tickets: ReadonlyArray<Pick<ReconcileTicket, 'id' | 'prerequisites' | 'executionOrder'>>): number[] {
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const rank = (a: number, b: number): number => {
    const ea = byId.get(a)?.executionOrder ?? Number.POSITIVE_INFINITY
    const eb = byId.get(b)?.executionOrder ?? Number.POSITIVE_INFINITY
    return ea !== eb ? (ea < eb ? -1 : 1) : a - b
  }
  const pending = new Map<number, Set<number>>()
  for (const t of tickets) {
    pending.set(t.id, new Set((t.prerequisites ?? []).filter((id) => id !== t.id && byId.has(id))))
  }
  const order: number[] = []
  while (pending.size > 0) {
    const ready = [...pending.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort(rank)
    // Cycle: take the best-ranked remaining spec so the chain still progresses.
    const next = ready[0] ?? [...pending.keys()].sort(rank)[0]
    order.push(next)
    pending.delete(next)
    for (const deps of pending.values()) deps.delete(next)
  }
  return order
}

const SUCCESS_DECISIONS: ReadonlySet<string> = new Set(['on_review', 'no_changes', 'pr_draft', 'pr_ready'])
const FAILED_DECISIONS: ReadonlySet<string> = new Set(['implementation_failed', 'pr_failed', 'pr_closed'])
const MERGED_DECISIONS: ReadonlySet<string> = new Set(['merged', 'completed'])
const TERMINAL_DECISIONS: ReadonlySet<string> = new Set(['merged', 'completed', 'discarded', 'superseded'])

function implementationFailed(d: ReconcileDelivery, ticketId: number): boolean {
  if (d.decision === 'implementation_failed') return true
  if (d.implementationOutcome === 'failed' || d.implementationOutcome === 'partially_succeeded') return true
  const unit = d.units?.find((u) => u.ticketId === ticketId)
  if (!unit) return false
  if (unit.implementationOutcome === 'failed' || unit.deliveryOutcome === 'blocked') return true
  return unit.implementationOutcome == null && unit.succeeded === false
}

function deliveryBranch(d: ReconcileDelivery, ticketId: number): string | null {
  return d.branch ?? d.units?.find((u) => u.ticketId === ticketId && u.succeeded && u.branch)?.branch
    ?? d.units?.find((u) => u.succeeded && u.branch)?.branch ?? null
}

function pauseKindOf(run: ReconcileRun): ChainRunPauseKind {
  switch (run.pauseReason) {
    case 'user_paused': return 'user'
    case 'budget_paused': return 'budget'
    case 'limit_paused': return 'limit'
    case 'restart': return 'restart'
    default: return 'decision'
  }
}

const newestFirst = <T extends { createdAt?: string | null; startedAt?: string | null }>(a: T, b: T): number => {
  const ka = a.createdAt ?? a.startedAt ?? ''
  const kb = b.createdAt ?? b.startedAt ?? ''
  return ka < kb ? 1 : ka > kb ? -1 : 0
}

/** Derive one spec's real state (see the casuistry table, §1). */
export function deriveChainSpec(
  ticket: ReconcileTicket,
  deliveries: ReconcileDelivery[],
  runs: ReconcileRun[],
): ChainPlanSpec {
  const base: ChainPlanSpec = {
    ticketId: ticket.id, title: ticket.title ?? null, state: 'pending', deliveryId: null, runId: null,
    railIndex: null, branch: null, pauseKind: null, resumableRunId: null, lastAttemptFailed: false,
  }
  if (ticket.status === 'done') return { ...base, state: 'done' }
  const mine = [...deliveries].sort(newestFirst)
  const myRuns = [...runs].sort((a, b) => newestFirst(a, b))
  const live = myRuns.find((r) => r.status === 'running' || r.status === 'paused')
  const owning = (runId: string): ReconcileDelivery | undefined => mine.find((d) => !TERMINAL_DECISIONS.has(d.decision) && (d.runIds ?? []).includes(runId))
  if (live) {
    const d = owning(live.id) ?? mine.find((x) => x.decision === 'building')
    return {
      ...base,
      state: live.status === 'paused' ? 'paused' : 'running',
      runId: live.id,
      deliveryId: d?.id ?? null,
      railIndex: live.railIndex ?? d?.railIndex ?? null,
      pauseKind: live.status === 'paused' ? pauseKindOf(live) : null,
    }
  }
  const active = mine.find((d) => !TERMINAL_DECISIONS.has(d.decision))
  if (active && SUCCESS_DECISIONS.has(active.decision) && !implementationFailed(active, ticket.id)) {
    return { ...base, state: 'delivered', deliveryId: active.id, railIndex: active.railIndex, branch: deliveryBranch(active, ticket.id) }
  }
  const merged = mine.find((d) => MERGED_DECISIONS.has(d.decision))
  if (merged) return { ...base, state: 'integrated', deliveryId: merged.id, railIndex: merged.railIndex, branch: deliveryBranch(merged, ticket.id) }
  if (active && active.decision === 'building') {
    return { ...base, state: 'running', deliveryId: active.id, railIndex: active.railIndex, runId: active.runIds?.at(-1) ?? null }
  }
  if (active && (FAILED_DECISIONS.has(active.decision) || implementationFailed(active, ticket.id))) {
    const lastRunId = active.runIds?.at(-1) ?? null
    const lastRun = lastRunId ? runs.find((r) => r.id === lastRunId) : undefined
    const resumable = lastRun && lastRun.engineVersion === 2 && lastRun.status === 'completed'
      && lastRun.outcome !== 'success' && !runs.some((r) => r.forkOf === lastRun.id)
    return {
      ...base, state: 'failed', deliveryId: active.id, railIndex: active.railIndex, runId: lastRunId,
      resumableRunId: resumable ? lastRun.id : null, lastAttemptFailed: true,
    }
  }
  if (ticket.status === 'on_review') return { ...base, state: 'delivered' }
  const newest = mine[0]
  const newestRun = myRuns[0]
  const lastAttemptFailed = newest ? implementationFailed(newest, ticket.id) || (newestRun ? newestRun.outcome !== null && newestRun.outcome !== 'success' : false) : false
  return { ...base, lastAttemptFailed }
}

/** The chain's scope: its launched chunks plus specs labelled `M<n>` since. */
function chainScope(input: ReconcileInput): { order: number[]; tickets: Map<number, ReconcileTicket> } {
  const label = `M${input.chain.milestoneN}`
  const byId = new Map(input.tickets.map((t) => [t.id, t]))
  const inScope = new Map<number, ReconcileTicket>()
  for (const id of input.chain.chunks.flat()) {
    const t = byId.get(id)
    // Removed from the milestone (deleted, cancelled, label dropped): out of the plan.
    if (!t || t.status === 'cancelled' || !Array.isArray(t.labels) || !t.labels.includes(label)) continue
    inScope.set(id, t)
  }
  for (const t of input.tickets) {
    if (inScope.has(t.id) || !Array.isArray(t.labels) || !t.labels.includes(label)) continue
    // Only new pending work joins: a spec already on review or done when it
    // was added is the person's, not the chain's to integrate.
    if (t.status !== 'todo' && t.status !== 'in_progress') continue
    inScope.set(t.id, t)
  }
  return { order: orderChainTickets([...inScope.values()]), tickets: inScope }
}

function settledFor(spec: ChainPlanSpec, integrates: boolean): boolean {
  if (spec.state === 'done' || spec.state === 'integrated') return true
  // Integration mode: a delivery under review still has to be integrated; a
  // spec on review without a delivery row (bare job) has nothing to integrate.
  if (spec.state === 'delivered') return !integrates || spec.deliveryId === null
  return false
}

function actionFor(spec: ChainPlanSpec, integrates: boolean): ChainNextAction {
  switch (spec.state) {
    case 'running':
      return { kind: 'adopt_run', ticketId: spec.ticketId, runId: spec.runId, deliveryId: spec.deliveryId, railIndex: spec.railIndex }
    case 'paused':
      return spec.pauseKind === 'decision'
        ? { kind: 'answer_run', ticketId: spec.ticketId, runId: spec.runId!, deliveryId: spec.deliveryId, railIndex: spec.railIndex }
        : { kind: 'resume_run', ticketId: spec.ticketId, runId: spec.runId!, deliveryId: spec.deliveryId, railIndex: spec.railIndex, pauseKind: spec.pauseKind ?? 'user' }
    case 'delivered':
      if (integrates && spec.deliveryId && spec.railIndex !== null) return { kind: 'integrate', ticketId: spec.ticketId, deliveryId: spec.deliveryId, railIndex: spec.railIndex }
      return { kind: 'complete' }
    case 'failed':
      return spec.resumableRunId
        ? { kind: 'resume_failed', ticketId: spec.ticketId, runId: spec.resumableRunId, deliveryId: spec.deliveryId, railIndex: spec.railIndex }
        : { kind: 'launch', ticketId: spec.ticketId, retry: true }
    default:
      return { kind: 'launch', ticketId: spec.ticketId, retry: spec.lastAttemptFailed }
  }
}

/** Reconcile a chain against the live rows: next action, base and offers. */
export function reconcileMilestoneChain(input: ReconcileInput): ChainPlan {
  const { order, tickets } = chainScope(input)
  // Every delivery and run relevant to a spec: by its own ticket ids, and by
  // the chain's launched entries (a delivery row that lost its ticket ids still
  // belongs to the spec the chain launched it for).
  const launchedDelivery = new Map<string, number>()
  for (const entry of input.chain.launched) {
    if (entry.deliveryId && entry.ticketIds.length === 1) launchedDelivery.set(entry.deliveryId, entry.ticketIds[0])
  }
  const specs = order.map((id) => deriveChainSpec(
    tickets.get(id)!,
    input.deliveries.filter((d) => d.ticketIds.includes(id) || launchedDelivery.get(d.id) === id),
    input.runs.filter((r) => r.ticketIds.includes(id)),
  ))

  const firstOpen = specs.find((s) => !settledFor(s, input.integrates)) ?? null
  const action: ChainNextAction = firstOpen ? actionFor(firstOpen, input.integrates) : { kind: 'complete' }

  // Base: integration mode stacks on the integration branch (every earlier spec
  // is integrated by construction); legacy stacks on the newest delivered,
  // unmerged branch before the action spec.
  const before = firstOpen ? specs.slice(0, specs.indexOf(firstOpen)) : specs
  let baseBranch: string | null = null
  if (!input.integrates) {
    for (const s of before) if (s.state === 'delivered' && s.branch) baseBranch = s.branch
  }
  const baseDeliveryIds = before.flatMap((s) => (s.state === 'delivered' || s.state === 'integrated') && s.deliveryId ? [s.deliveryId] : [])

  // The spec the chain stopped on: the failed chunk it remembers, else its last launch.
  const launched = [...input.chain.launched].sort((a, b) => a.chunk - b.chunk)
  const pausedEntry = input.chain.retryChunk !== null
    ? launched.find((l) => l.chunk === input.chain.retryChunk! + 1) ?? launched.at(-1)
    : launched.at(-1)
  const pausedTicketId = pausedEntry?.ticketIds[0] ?? null
  const pausedSpec = pausedTicketId !== null ? specs.find((s) => s.ticketId === pausedTicketId) : undefined
  const pausedSpecSettled = pausedTicketId !== null && (!pausedSpec || settledFor(pausedSpec, input.integrates))

  const auto: ChainPlan['auto'] = action.kind === 'resume_failed' || (action.kind === 'launch' && action.retry)
    ? { kind: 'pause', reason: 'chunk_failed', ticketId: action.ticketId }
    : action.kind === 'resume_run' || action.kind === 'answer_run'
      // A paused run is live: the chain adopts it and waits, never resumes it on its own.
      ? { kind: 'proceed', action: { kind: 'adopt_run', ticketId: action.ticketId, runId: action.runId, deliveryId: action.deliveryId, railIndex: action.railIndex } }
      : { kind: 'proceed', action }

  const title = (id: number | null): string | null => (id === null ? null : tickets.get(id)?.title ?? null)
  const nextAfter = (id: number): number | null => {
    const i = specs.findIndex((s) => s.ticketId === id)
    return specs.slice(i + 1).find((s) => !settledFor(s, input.integrates) || s.state === 'delivered')?.ticketId ?? null
  }
  const offer = (kind: ChainOfferKind, from: ChainResumeFrom, ticketId: number | null, runId: string | null = null, extra: Partial<ChainOffer> = {}): ChainOffer =>
    ({ kind, from, ticketId, title: title(ticketId), runId, ...extra })
  const offers: ChainOffer[] = []
  switch (action.kind) {
    case 'complete': offers.push(offer('complete', 'recommended', null)); break
    case 'launch':
      if (action.retry) offers.push(offer('retry', 'recommended', action.ticketId))
      else offers.push(offer(pausedTicketId !== null && pausedTicketId !== action.ticketId && pausedSpecSettled ? 'next' : 'launch', 'recommended', action.ticketId))
      break
    case 'resume_failed':
      offers.push(offer('resume_failed_step', 'failed_step', action.ticketId, action.runId))
      offers.push(offer('retry_from_start', 'start', action.ticketId))
      break
    case 'resume_run': offers.push(offer('resume_run', 'recommended', action.ticketId, action.runId)); break
    case 'answer_run': offers.push(offer('answer_run', 'recommended', action.ticketId, action.runId)); break
    case 'adopt_run': offers.push(offer('follow_run', 'recommended', action.ticketId, action.runId)); break
    case 'integrate':
      // Its integration was refused (a conflict with what was integrated since):
      // the useful step is a new run on the updated base; integrating again
      // stays available once the person resolved it.
      if (input.chain.status === 'paused' && input.chain.pauseReason?.startsWith('integration_failed') && input.chain.currentDeliveryId === action.deliveryId) {
        offers.push(offer('rebuild', 'start', action.ticketId))
      }
      offers.push(offer('integrate', 'recommended', action.ticketId, null, { nextTicketId: nextAfter(action.ticketId) }))
      break
  }

  return {
    order,
    specs,
    action,
    auto,
    offers,
    baseBranch,
    baseDeliveryIds,
    settled: specs.filter((s) => settledFor(s, input.integrates)).length,
    total: specs.length,
    pausedTicketId,
    pausedSpecSettled,
  }
}
