// Server-durable milestone launch chain (premium-milestone-progress, D3/D4).
//
// "Launch Milestone N": order the milestone's todo specs by their declared
// dependencies (prerequisites, then execution_order), put ONE spec on each
// rail (mode `implement`), launch the first through the ORDINARY rails launch
// route, and integrate each completed delivery through the guarded local decision
// path BEFORE allocating the next worktree from the integration branch. Older
// adapters without integration retain their historical stacking behavior.
// Launches are sequential; auto-continue is on by default. The plan lives in
// SQLite and retains the current delivery through integration and recovery.
// pauses with a typed reason on any failure (never skips a failed spec), and is
// visible/controllable (resume / cancel) from every surface. Every launch,
// advance and Resume is reconciled first (milestone-chain-reconcile.ts): specs
// already delivered, merged or done — by the chain or by the person — are
// skipped, a run already on a spec is adopted instead of duplicated, and the
// snapshot's `plan` names the next step for every surface.

import { logRejection } from '../../../util/log-rejection'
import type { DbInstance } from '../../../db'
import type { WsMessage } from '../../../types'
import type { Blueprint } from './blueprint-types'
import type { PrDeliverySnapshot } from '../../delivery/runtime/rail-pr-store'
import type { MilestoneChainSnapshot, MilestoneChainLaunched, ProgressTicket } from './milestone-progress'
import { milestoneLabelFor } from './milestone-progress'
import {
  createChain,
  getChain,
  listActiveChains,
  listChains,
  parseChunks,
  parseLaunched,
  parseRunIds,
  toChainSnapshot,
  updateChain,
  isActiveChainStatus,
  type MilestoneChainRow,
  type MilestoneChainEngine,
} from './milestone-chain-store'
import { newId } from '../../../ids'
import {
  orderChainTickets,
  reconcileMilestoneChain,
  type ChainNextAction,
  type ChainPlan,
  type ChainResumeFrom,
  type ReconcileDelivery,
  type ReconcileRun,
} from './milestone-chain-reconcile'

/** One spec per rail: every chunk of a milestone chain carries exactly one spec. */
export const MAX_TICKETS_PER_CHAIN_CHUNK = 1

export function chunkTickets(ticketIds: number[], size = MAX_TICKETS_PER_CHAIN_CHUNK): number[][] {
  const chunks: number[][] = []
  for (let i = 0; i < ticketIds.length; i += size) chunks.push(ticketIds.slice(i, i + size))
  return chunks
}

export { orderChainTickets, reconcileMilestoneChain } from './milestone-chain-reconcile'
export type { ChainPlan, ChainNextAction, ChainResumeFrom } from './milestone-chain-reconcile'

/** Builder rails are named after their spec: `M1 · #12`. */
export function chainRailName(n: number, ticketIds: readonly number[]): string {
  const label = milestoneLabelFor(n)
  return ticketIds.length ? `${label} · ${ticketIds.map((id) => `#${id}`).join(' ')}` : label
}

/** A rail name the Project Builder owns (`M<n>` or `M<n> · …`). */
export function isBuilderRailName(name: string | null | undefined): boolean {
  return typeof name === 'string' && /^M\d+(?: · .+)?$/.test(name)
}

/** Pause reason when every rail slot is taken by undecided work. */
export const RAIL_LIMIT_REACHED = 'rail_limit_reached'

export type ChainIoFailure = { ok: false; status: number; error: string; detail?: string }

/** A local integration Git refused because the delivery conflicts with the base. */
export function isIntegrationConflict(failure: ChainIoFailure): boolean {
  return failure.error === 'merge_failed' && /\bCONFLICT\b/.test(failure.detail ?? '')
}
/** Why a conflicted integration paused after the automatic base refresh could not run (the pause detail). */
const CONFLICT_REASON: Record<string, string> = {
  refresh_conflict_unresolved: 'conflict_unresolved',
  refresh_resolver_failed: 'conflict_unresolved',
  refresh_limit_reached: 'conflict_refresh_limit',
}

export interface MilestoneChainIO {
  createRail(name: string): Promise<{ ok: true; railIndex: number } | ChainIoFailure>
  assignTickets(railIndex: number, ticketIds: number[]): Promise<{ ok: true } | ChainIoFailure>
  launch(railIndex: number, body: { mode: 'implement'; baseBranch?: string; baseDeliveryIds?: string[]; aiEngine?: string; model?: string; reasoning_effort?: string | null; requireEngineSelection?: boolean }): Promise<{ ok: true; loopRunIds: string[] } | ChainIoFailure>
  /** Newest non-terminal delivery on the rail (read right after a launch). */
  activeDeliveryForRail(railIndex: number): PrDeliverySnapshot | null
  /** A rail already carrying this chain-rail name (e.g. from a previous chain
   *  of the same milestone), else null — reused when nothing undecided sits on
   *  it, so relaunching a milestone never piles up duplicate "M1 · 1" rails. */
  findRailByName?(name: string): number | null
  /** Every rail slot with its display name (reuse candidates). */
  listRails?(): { railIndex: number; name: string | null }[]
  /** True while a job/loop run is active on the rail. */
  railBusy?(railIndex: number): boolean
  /** Rename a reused rail after the spec it now carries. */
  renameRail?(railIndex: number, name: string): Promise<{ ok: true } | ChainIoFailure>
  getDelivery(deliveryId: string): PrDeliverySnapshot | null
  branchExists(branch: string): Promise<boolean>
  readTickets(): ProgressTicket[]
  readBlueprint(): Blueprint | null
  integrationBranch(): Promise<string | null>
  /** Integrate this verified delivery through the normal guarded decision path. */
  integrateDelivery?(delivery: PrDeliverySnapshot): Promise<{ ok: true } | ChainIoFailure>
  /** Bring the updated base into a delivery whose integration conflicted and verify it again
   *  (a run of its own on the delivery's worktree). Absent ⇒ a conflict pauses at once. */
  refreshDelivery?(delivery: PrDeliverySnapshot): Promise<{ ok: true; runId: string } | ChainIoFailure>
  /** Resume a failed run from the step that stopped it (re-running only the
   *  interrupted steps), on its own worktree and delivery. Absent ⇒ a failed
   *  chunk can only be relaunched from the start. */
  resumeFailedRun?(runId: string): Promise<{ ok: true } | ChainIoFailure>
  /** Resume a PAUSED run in place (the person, a restart, the budget or a
   *  provider limit paused it): the same attempt continues from its next step. */
  resumeRun?(runId: string): Promise<{ ok: true } | ChainIoFailure>
  /** Every delivery (active and terminal) carrying one of these specs —
   *  including the ones the person launched outside the chain. */
  listDeliveriesForTickets?(ticketIds: number[]): PrDeliverySnapshot[]
  /** Recent runs (live and settled) carrying one of these specs, any origin. */
  listRunsForTickets?(ticketIds: number[]): ReconcileRun[]
  /** Loop-run row state for startup recovery: null = row missing. */
  runState(runId: string): { settled: boolean; outcome: string | null } | null
  broadcast(msg: WsMessage): void
  now?(): number
}

export type ChainStartResult =
  | { ok: true; status: 202; chainId: string | null; launched: MilestoneChainLaunched[]; pending: number[][] }
  | { ok: false; status: number; error: string; detail?: string; chainId?: string }

export type ChainControlResult =
  | { ok: true; status: number; chain: MilestoneChainSnapshot }
  | { ok: false; status: number; error: string; detail?: string }

type LaunchedChunk = { ok: true; entry: MilestoneChainLaunched } | ChainIoFailure

const SUCCESS_DECISIONS: ReadonlySet<string> = new Set(['on_review', 'no_changes', 'pr_draft', 'pr_ready', 'completed', 'merged'])

/** Messages after which a paused chain's plan may have moved. */
const PLAN_TRIGGERS: ReadonlySet<string> = new Set([
  'rail.pr_state', 'ticket_updated', 'ticket_created', 'ticket_deleted',
  'loop.run_completed', 'loop.run_stopped', 'loop.run_started', 'loop.run_paused', 'loop.run_resumed', 'rail.job_started', 'rail.job_completed', 'rail.job_stopped',
])

function planSignature(plan: ChainPlan): string {
  return JSON.stringify([plan.action, plan.offers, plan.settled, plan.total, plan.specs.map((s) => [s.ticketId, s.state, s.deliveryId, s.runId])])
}

function adoptOf(action: Extract<ChainNextAction, { kind: 'resume_run' | 'answer_run' }>): Extract<ChainNextAction, { kind: 'adopt_run' }> {
  return { kind: 'adopt_run', ticketId: action.ticketId, runId: action.runId, deliveryId: action.deliveryId, railIndex: action.railIndex }
}

export class MilestoneChainManager {
  private readonly integrating = new Set<string>()
  constructor(
    private readonly db: DbInstance,
    private readonly projectId: string,
    private readonly io: MilestoneChainIO,
  ) {}

  private now(): number {
    return this.io.now?.() ?? Date.now()
  }

  /** Non-terminal chains, each reconciled against the live rows. */
  listActive(): MilestoneChainSnapshot[] {
    return listActiveChains(this.db).map((row) => this.snapshot(row))
  }

  /** Newest chain per milestone, any status (feeds the progress model). */
  listForProgress(): MilestoneChainSnapshot[] {
    const seen = new Set<number>()
    const out: MilestoneChainSnapshot[] = []
    for (const row of listChains(this.db)) {
      if (seen.has(row.milestone_n)) continue
      seen.add(row.milestone_n)
      out.push(this.snapshot(row))
    }
    return out
  }

  get(id: string): MilestoneChainSnapshot | null {
    const row = getChain(this.db, id)
    return row ? this.snapshot(row) : null
  }

  /** The store projection plus the reconciled plan (active chains only). */
  private snapshot(row: MilestoneChainRow): MilestoneChainSnapshot {
    const snap = toChainSnapshot(row)
    if (!isActiveChainStatus(row.status)) return snap
    try { return { ...snap, plan: this.plan(row) } } catch { return { ...snap, plan: null } }
  }

  /**
   * Reconcile the chain against the durable rows: every spec's real state from
   * the ticket store, its deliveries and its runs — the chain's and the ones
   * the person launched by hand. Pure read; safe to call at any time.
   */
  plan(row: MilestoneChainRow): ChainPlan {
    const tickets = this.io.readTickets()
    const label = milestoneLabelFor(row.milestone_n)
    const launched = parseLaunched(row)
    const ids = [...new Set([...parseChunks(row).flat(), ...tickets.filter((t) => Array.isArray(t.labels) && t.labels.includes(label)).map((t) => t.id)])]
    const byId = new Map<string, PrDeliverySnapshot>()
    try { for (const d of this.io.listDeliveriesForTickets?.(ids) ?? []) byId.set(d.id, d) } catch { /* fall back to the launched ones */ }
    for (const entry of launched) {
      if (!entry.deliveryId || byId.has(entry.deliveryId)) continue
      try { const d = this.io.getDelivery(entry.deliveryId); if (d) byId.set(d.id, d) } catch { /* missing row */ }
    }
    let runs: ReconcileRun[] = []
    try { runs = this.io.listRunsForTickets?.(ids) ?? [] } catch { runs = [] }
    const deliveries: ReconcileDelivery[] = [...byId.values()].map((d) => ({
      id: d.id, railIndex: d.railIndex, ticketIds: d.ticketIds, decision: d.decision, implementationOutcome: d.implementationOutcome,
      branch: d.branch, runIds: d.runIds, createdAt: d.createdAt,
      units: d.units.map((u) => ({ ticketId: (u as { ticketId?: number | null }).ticketId ?? null, branch: u.branch ?? null, succeeded: u.succeeded, implementationOutcome: (u as { implementationOutcome?: string | null }).implementationOutcome ?? null, deliveryOutcome: (u as { deliveryOutcome?: string | null }).deliveryOutcome ?? null })),
    }))
    return reconcileMilestoneChain({
      chain: {
        milestoneN: row.milestone_n, status: row.status, chunks: parseChunks(row), launched,
        retryChunk: row.retry_chunk, headBranch: row.head_branch, integrationBranch: row.integration_branch,
        pauseReason: row.pause_reason, currentDeliveryId: row.current_delivery_id,
      },
      tickets: tickets.map((t) => ({ id: t.id, status: t.status, labels: t.labels, title: t.title ?? null, prerequisites: t.prerequisites, executionOrder: t.executionOrder })),
      deliveries,
      runs,
      integrates: Boolean(this.io.integrateDelivery),
    })
  }

  private readonly planSignatures = new Map<string, string>()

  private emit(row: MilestoneChainRow): void {
    try {
      const chain = this.snapshot(row)
      if (chain.plan) this.planSignatures.set(row.id, planSignature(chain.plan))
      this.io.broadcast({
        type: 'milestone.chain_changed',
        projectId: this.projectId,
        chain,
        timestamp: new Date(this.now()).toISOString(),
      })
    } catch { /* durable row is authoritative */ }
  }

  /** A paused chain stays paused (the pause is the person's), but its plan
   *  follows reality: re-emit when a delivery/run/spec change moved it. */
  private refreshPlans(): void {
    for (const row of listActiveChains(this.db)) {
      if (row.status !== 'paused' && row.status !== 'awaiting_approval') continue
      let signature: string
      try { signature = planSignature(this.plan(row)) } catch { continue }
      if (this.planSignatures.get(row.id) === signature) continue
      this.emit(row)
    }
  }

  private todoTicketIds(n: number): number[] {
    const label = milestoneLabelFor(n)
    return orderChainTickets(this.io.readTickets()
      .filter((t) => t.status === 'todo' && Array.isArray(t.labels) && t.labels.includes(label)))
  }

  /** Assign → launch ONE spec on a rail: the retried chunk's previous rail,
   *  else a free builder-owned rail (same name, this chain's, then any builder
   *  rail), else a fresh one. At the rail limit it fails `rail_limit_reached`. */
  private async launchChunk(n: number, chunks: number[][], chunkIndex: number, baseBranch: string | null, reuseRailIndex: number | null = null, baseDeliveryIds?: string[], chain?: MilestoneChainRow): Promise<LaunchedChunk> {
    let engine: MilestoneChainEngine | undefined
    if (chain?.engine_config != null) {
      try {
        engine = JSON.parse(chain.engine_config)
        if (!engine || typeof engine.provider !== 'string' || typeof engine.model !== 'string'
          || (engine.reasoningEffort !== null && typeof engine.reasoningEffort !== 'string')) throw new Error('invalid engine')
      } catch { return { ok: false, status: 409, error: 'milestone_engine_unavailable' } }
    }
    const ticketIds = chunks[chunkIndex]
    let railIndex: number
    const name = chainRailName(n, ticketIds)
    const reused = reuseRailIndex ?? this.freeRailNamed(name) ?? this.freeBuilderRail(chain)
    if (reused !== null) {
      railIndex = reused
      if (this.railName(reused) !== name && this.io.renameRail) {
        // Best effort: a stale label is cosmetic, never a reason to stop.
        try { await this.io.renameRail(reused, name) } catch { /* keep the old label */ }
      }
    } else {
      const rail = await this.io.createRail(name)
      if (!rail.ok) return rail.error === RAIL_LIMIT_REACHED ? { ...rail, status: 409 } : rail
      railIndex = rail.railIndex
    }
    const assigned = await this.io.assignTickets(railIndex, ticketIds)
    if (!assigned.ok) return assigned
    const launched = await this.io.launch(railIndex, {
      mode: 'implement', ...(baseDeliveryIds?.length ? { baseDeliveryIds } : baseBranch ? { baseBranch } : {}),
      ...(engine ? { aiEngine: engine.provider, model: engine.model, reasoning_effort: engine.reasoningEffort, requireEngineSelection: true } : {}),
    })
    if (!launched.ok) return launched
    const delivery = this.io.activeDeliveryForRail(railIndex)
    return {
      ok: true,
      entry: { chunk: chunkIndex + 1, railIndex, ticketIds, runIds: launched.loopRunIds, deliveryId: delivery?.id ?? null },
    }
  }

  /** A rail from an earlier chain that already carries this name and holds no
   *  undecided delivery — reused instead of allocating a duplicate. */
  private freeRailNamed(name: string): number | null {
    try {
      const index = this.io.findRailByName?.(name) ?? null
      if (index === null) return null
      return this.railFree(index) ? index : null
    } catch {
      return null
    }
  }

  private railName(railIndex: number): string | null {
    try { return this.io.listRails?.().find((r) => r.railIndex === railIndex)?.name ?? null } catch { return null }
  }

  /** Nothing undecided, nothing running, and no other active chain mid-flight on it. */
  private railFree(railIndex: number): boolean {
    if (this.io.activeDeliveryForRail(railIndex)) return false
    if (this.io.railBusy?.(railIndex)) return false
    return !listActiveChains(this.db).some((row) => row.current_rail_index === railIndex && (row.current_delivery_id !== null || parseRunIds(row).length > 0))
  }

  /** Before allocating a new rail slot: a rail this chain already used, else
   *  any builder-named rail, that is free (its PR decided or nothing on it). */
  private freeBuilderRail(chain?: MilestoneChainRow): number | null {
    try {
      const own = chain ? parseLaunched(chain).map((l) => l.railIndex) : []
      const builder = (this.io.listRails?.() ?? []).filter((r) => isBuilderRailName(r.name)).map((r) => r.railIndex)
      // An adopted run without a rail (shared checkout) is recorded as -1: never a slot.
      for (const index of [...new Set([...own, ...builder])].filter((i) => i >= 0)) {
        if (this.railFree(index)) return index
      }
      return null
    } catch {
      return null
    }
  }

  /** The rail a retried spec can reuse: its previous attempt's rail when no
   *  undecided delivery still sits there (a failed delivery the user has not
   *  reviewed keeps the rail — the retry then takes a fresh one). */
  private reusableRailFor(_row: MilestoneChainRow, previous: MilestoneChainLaunched): number | null {
    if (previous.railIndex < 0) return null
    try {
      return this.io.activeDeliveryForRail(previous.railIndex) ? null : previous.railIndex
    } catch {
      return null
    }
  }

  /**
   * Launch a milestone. Always sequential: one spec per rail, each stacked on
   * the accumulated integration branch when integration is bound. `autoAdvance` defaults to ON; turning it off
   * parks the chain at a checkpoint after every delivered rail. The first step
   * is reconciled like every other: a spec already running (launched by hand)
   * is adopted, never launched twice.
   */
  async start(n: number, opts: { autoAdvance?: boolean; engine?: MilestoneChainEngine } = {}): Promise<ChainStartResult> {
    const autoAdvance = opts.autoAdvance !== false
    const active = listActiveChains(this.db).find((c) => c.milestone_n === n)
    if (active) return { ok: false, status: 409, error: 'chain_active', chainId: active.id }
    const blueprint = this.io.readBlueprint()
    const milestone = blueprint?.milestones[n - 1]
    if (!blueprint || !milestone) return { ok: false, status: 404, error: 'milestone_not_found' }
    const ticketIds = this.todoTicketIds(n)
    if (ticketIds.length === 0) return { ok: false, status: 400, error: 'no_tickets', detail: `no todo specs labeled ${milestoneLabelFor(n)}` }
    const chunks = chunkTickets(ticketIds)

    const row = createChain(this.db, {
      id: newId(), milestoneN: n, milestoneId: milestone.id, mode: 'sequential', chunks,
      integrationBranch: await this.safeIntegrationBranch(), autoAdvance, engine: opts.engine, nowMs: this.now(),
    })
    const plan = this.plan(row)
    // Launching is the person's explicit go: a failed spec runs again from the
    // start; a paused run is adopted (the person resumes it from the run).
    const action: ChainNextAction = plan.action.kind === 'resume_failed' ? { kind: 'launch', ticketId: plan.action.ticketId, retry: true }
      : plan.action.kind === 'resume_run' || plan.action.kind === 'answer_run' ? adoptOf(plan.action)
        : plan.action
    const first = await this.execute(row, plan, action, null)
    if (!first.ok) {
      // Nothing launched ⇒ no chain remains active (the route relays the guard,
      // including `rail_limit_reached` when every rail holds undecided work).
      updateChain(this.db, row.id, ['running', 'waiting'], { status: 'cancelled', pauseReason: first.error === RAIL_LIMIT_REACHED ? RAIL_LIMIT_REACHED : `launch_rejected:${first.error}` }, this.now())
      return { ok: false, status: first.status, error: first.error, detail: first.detail, chainId: row.id }
    }
    const fresh = getChain(this.db, row.id)
    if (fresh) this.emit(fresh)
    const order = plan.order
    const at = first.entry ? order.indexOf(first.entry.ticketIds[0]) : order.length
    return { ok: true, status: 202, chainId: row.id, launched: first.entry ? [first.entry] : [], pending: order.slice(at + 1).map((id) => [id]) }
  }

  private async safeIntegrationBranch(): Promise<string | null> {
    try { return await this.io.integrationBranch() } catch { return null }
  }

  private recordLaunched(chainId: string, entry: MilestoneChainLaunched, chunks?: number[][]): void {
    const row = getChain(this.db, chainId)
    if (!row) return
    // A retry REPLACES the earlier attempt's entry for that spec (the delivery
    // rows keep the history); a fresh spec appends. Entries follow the
    // reconciled order when the milestone's specs changed.
    const order = (chunks ?? parseChunks(row)).map((c) => c[0])
    const renumber = (l: MilestoneChainLaunched): MilestoneChainLaunched => {
      const at = order.indexOf(l.ticketIds[0])
      return at >= 0 ? { ...l, chunk: at + 1 } : l
    }
    const key = entry.ticketIds.join(',')
    const launched = parseLaunched(row).filter((l) => l.ticketIds.join(',') !== key).map(renumber)
    const next = renumber(entry)
    updateChain(this.db, chainId, row.status, {
      ...(chunks ? { chunks } : {}),
      nextChunk: next.chunk,
      currentRailIndex: next.railIndex,
      currentRunIds: next.runIds,
      currentDeliveryId: next.deliveryId,
      lastRunOutcome: null,
      status: 'running',
      pauseReason: null,
      retryChunk: null,
      launched: [...launched, next].sort((x, y) => x.chunk - y.chunk),
    }, this.now())
  }

  private pause(row: MilestoneChainRow, reason: string, patch: { headBranch?: string | null; retryChunk?: number | null; chunks?: number[][] } = {}): void {
    if (updateChain(this.db, row.id, row.status, { status: 'paused', pauseReason: reason, ...patch }, this.now())) {
      const fresh = getChain(this.db, row.id)
      if (fresh) this.emit(fresh)
    }
  }

  /** The in-flight chunk itself failed (failed / stalled / stopped / provider
   *  limit / lost): pause AND remember that chunk so Resume retries it — never
   *  the next one (run 10dedd5a relaunched tickets 4–6 while 1–3 had failed). */
  private pauseFailedChunk(row: MilestoneChainRow, reason: string): void {
    this.pause(row, reason, { retryChunk: Math.max(0, row.next_chunk - 1) })
  }

  /** The base a launch stacks on: the integration branch once every earlier
   *  spec is integrated (integration mode, from the 2nd rail on), else the
   *  newest delivered branch (legacy stacking). */
  private baseFor(row: MilestoneChainRow, plan: ChainPlan, first: boolean): { baseBranch: string | null; baseDeliveryIds?: string[] } {
    if (this.io.integrateDelivery) return { baseBranch: first ? null : row.integration_branch }
    const multiRepositoryHistory = plan.baseDeliveryIds.some((id) => { try { return Boolean(this.io.getDelivery(id)?.executionManifest) } catch { return false } })
    if (multiRepositoryHistory) return { baseBranch: null, baseDeliveryIds: plan.baseDeliveryIds }
    // A no-changes or merged spec adds no branch: keep the recorded head.
    return { baseBranch: plan.baseBranch ?? (first ? null : row.head_branch) }
  }

  /**
   * Execute one reconciled action. Every path that puts work on a spec checks
   * the plan first, so a spec with a live or resumable run is never launched
   * twice; adopting a run is a CAS on the chain row.
   */
  private async execute(row: MilestoneChainRow, plan: ChainPlan, action: ChainNextAction, first: boolean | null): Promise<{ ok: true; entry: MilestoneChainLaunched | null } | ChainIoFailure> {
    const chunks = plan.order.map((id) => [id])
    const chunkOf = (ticketId: number): number => Math.max(0, plan.order.indexOf(ticketId))
    switch (action.kind) {
      case 'complete': {
        if (updateChain(this.db, row.id, row.status, { status: 'completed', chunks, currentRailIndex: null, currentRunIds: [], currentDeliveryId: null, pauseReason: null, retryChunk: null }, this.now())) {
          const fresh = getChain(this.db, row.id)
          if (fresh) this.emit(fresh)
        }
        return { ok: true, entry: null }
      }
      case 'launch': {
        const idx = chunkOf(action.ticketId)
        const previous = parseLaunched(row).find((l) => l.ticketIds.length === 1 && l.ticketIds[0] === action.ticketId)
        const reuse = previous ? this.reusableRailFor(row, previous) : null
        const base = this.baseFor(row, plan, first ?? parseLaunched(row).length === 0)
        const r = await this.launchChunk(row.milestone_n, chunks, idx, base.baseBranch, reuse, base.baseDeliveryIds, row)
        if (!r.ok) return r
        this.recordLaunched(row.id, r.entry, chunks)
        return { ok: true, entry: r.entry }
      }
      case 'resume_run': {
        if (!this.io.resumeRun) return { ok: false, status: 409, error: 'run_resume_unavailable', detail: 'resume this run from its own page' }
        let resumed: { ok: true } | ChainIoFailure
        try { resumed = await this.io.resumeRun(action.runId) } catch (error) {
          resumed = { ok: false, status: 409, error: 'run_resume_failed', detail: error instanceof Error ? error.message : String(error) }
        }
        if (!resumed.ok) return resumed
        return this.adopt(row, chunks, adoptOf(action))
      }
      case 'answer_run':
        return this.adopt(row, chunks, adoptOf(action))
      case 'adopt_run':
        return this.adopt(row, chunks, action)
      case 'integrate': {
        const snap = this.safeDelivery(action.deliveryId)
        const entry: MilestoneChainLaunched = { chunk: chunkOf(action.ticketId) + 1, railIndex: action.railIndex, ticketIds: [action.ticketId], runIds: snap?.runIds ?? [], deliveryId: action.deliveryId }
        this.recordLaunched(row.id, entry, chunks)
        await this.integrateChunk(row.id)
        return { ok: true, entry }
      }
      case 'resume_failed': {
        const r = await this.resumeFailedSpec(row, chunks, action)
        return r.ok ? { ok: true, entry: null } : { ok: false, status: r.status, error: r.error, ...(r.detail ? { detail: r.detail } : {}) }
      }
    }
  }

  private safeDelivery(id: string | null): PrDeliverySnapshot | null {
    if (!id) return null
    try { return this.io.getDelivery(id) } catch { return null }
  }

  /** Follow a run already working on the spec (the chain's or the person's):
   *  record it as the current rail and wait for its settle. */
  private adopt(row: MilestoneChainRow, chunks: number[][], action: Extract<ChainNextAction, { kind: 'adopt_run' }>): { ok: true; entry: MilestoneChainLaunched } {
    const snap = this.safeDelivery(action.deliveryId)
    const order = chunks.map((c) => c[0])
    const entry: MilestoneChainLaunched = {
      chunk: Math.max(0, order.indexOf(action.ticketId)) + 1,
      railIndex: action.railIndex ?? snap?.railIndex ?? -1,
      ticketIds: [action.ticketId],
      runIds: action.runId ? [action.runId] : snap?.runIds.slice(-1) ?? [],
      deliveryId: action.deliveryId,
    }
    this.recordLaunched(row.id, entry, chunks)
    // The run may have settled between the read and the adoption: replay it.
    const settled = this.safeDelivery(action.deliveryId)
    if (settled && settled.decision !== 'building') this.handleDeliveryState(settled)
    else if (!settled && action.runId) {
      const state = this.io.runState(action.runId)
      if (state?.settled) this.onRunSettled(action.runId, state.outcome ?? 'failed')
    }
    return { ok: true, entry }
  }

  /** Reconcile and take the next automatic step (launch, adopt, integrate,
   *  complete). A failed spec is never retried silently: it pauses. */
  private async advance(chainId: string): Promise<void> {
    const row = getChain(this.db, chainId)
    if (!row || !isActiveChainStatus(row.status)) return
    const plan = this.plan(row)
    if (plan.auto.kind === 'pause') {
      const at = plan.order.indexOf(plan.auto.ticketId)
      this.pause(row, plan.auto.reason, { retryChunk: at >= 0 ? at : null, chunks: plan.order.map((id) => [id]) })
      return
    }
    const action = plan.auto.action
    if (action.kind === 'launch') {
      const base = this.baseFor(row, plan, false)
      if (base.baseBranch && !this.io.integrateDelivery && !(await this.branchExistsSafe(base.baseBranch))) {
        this.pause(row, 'head_missing', { headBranch: base.baseBranch })
        return
      }
      if (!updateChain(this.db, row.id, row.status, { status: 'waiting', headBranch: base.baseBranch ?? row.head_branch, pauseReason: null }, this.now())) return
    }
    const current = getChain(this.db, chainId)
    if (!current || !isActiveChainStatus(current.status)) return
    const r = await this.execute(current, plan, action, false)
    const after = getChain(this.db, chainId)
    if (!after || !isActiveChainStatus(after.status)) return
    if (!r.ok) {
      // Every rail holds undecided work: wait for the user to decide pending
      // PRs, then Resume launches this same spec.
      if (r.error === RAIL_LIMIT_REACHED) this.pause(after, RAIL_LIMIT_REACHED)
      else this.pause(after, `launch_rejected:${r.error}`)
      return
    }
    if (action.kind !== 'complete') this.emit(after)
  }

  /**
   * A chunk settled successfully: advance (launch the next chunk / complete)
   * when auto-advance is on or nothing is left; otherwise park the chain at a
   * WAVE CHECKPOINT (`awaiting_approval`) with the head recorded — the user
   * launches the next rail (resume) or flips auto-advance on.
   */
  private afterChunkSuccess(chainId: string, head: string | null): void {
    const row = getChain(this.db, chainId)
    if (!row) return
    let done = false
    try { done = this.plan(row).action.kind === 'complete' } catch { done = parseChunks(row).length - row.next_chunk <= 0 }
    if (row.auto_advance !== 0 || done) {
      // Deferred: when this success comes from an integration, its re-entry
      // guard is released only after this call returns — advancing inline
      // would make the next integration (a delivery the person already
      // produced) a silent no-op and strand the chain.
      queueMicrotask(() => { void this.advance(chainId).catch(logRejection('milestone chain advance')) })
      return
    }
    if (updateChain(this.db, row.id, row.status, { status: 'awaiting_approval', headBranch: head, pauseReason: null }, this.now())) {
      const fresh = getChain(this.db, row.id)
      if (fresh) this.emit(fresh)
    }
  }

  private async branchExistsSafe(branch: string): Promise<boolean> {
    try { return await this.io.branchExists(branch) } catch { return false }
  }

  private failureReason(row: MilestoneChainRow): string {
    if (row.last_run_outcome === 'provider_limit') return 'provider_limit'
    if (row.last_run_outcome === 'stalled') return 'chunk_stalled'
    if (row.last_run_outcome === 'stopped') return 'chunk_stopped'
    return 'chunk_failed'
  }

  private completeIntegrated(row: MilestoneChainRow): void {
    if (!row.current_delivery_id || !isActiveChainStatus(row.status)) return
    updateChain(this.db, row.id, row.status, { status: 'waiting', currentDeliveryId: null, currentRunIds: [], headBranch: row.integration_branch, pauseReason: 'integration_complete' }, this.now())
    this.afterChunkSuccess(row.id, row.integration_branch)
  }

  /** Keep the delivery attached until its guarded integration is durably confirmed. */
  private async integrateChunk(chainId: string): Promise<void> {
    if (!this.io.integrateDelivery || this.integrating.has(chainId)) return
    const row = getChain(this.db, chainId)
    if (!row?.current_delivery_id || !isActiveChainStatus(row.status)) return
    const snap = this.io.getDelivery(row.current_delivery_id)
    if (!snap) { this.pause(row, 'integration_failed:delivery_missing'); return }
    if (snap.implementationOutcome === 'partially_succeeded' || snap.implementationOutcome === 'failed') { this.pauseFailedChunk(row, 'chunk_failed'); return }
    if (snap.decision === 'merged' || snap.decision === 'completed') { this.completeIntegrated(row); return }
    this.integrating.add(chainId)
    updateChain(this.db, row.id, row.status, { status: 'waiting', pauseReason: 'integration_pending' }, this.now())
    const pending = getChain(this.db, chainId)!
    this.emit(pending)
    try {
      const result = await this.io.integrateDelivery(snap)
      const current = getChain(this.db, chainId)
      if (!current || !isActiveChainStatus(current.status) || current.current_delivery_id !== snap.id) return
      const settled = this.io.getDelivery(snap.id)
      if (settled?.decision === 'merged' || settled?.decision === 'completed') this.completeIntegrated(current)
      else if (!result.ok && isIntegrationConflict(result) && this.io.refreshDelivery) await this.refreshConflicted(current, snap)
      else this.pause(current, 'integration_failed:' + (result.ok ? 'not_confirmed' : result.error))
    } catch {
      const current = getChain(this.db, chainId)
      if (current && isActiveChainStatus(current.status) && current.current_delivery_id === snap.id) this.pause(current, 'integration_failed:unavailable')
    } finally { this.integrating.delete(chainId) }
  }

  /**
   * The delivery conflicts with the base integrated since it was built: before pausing, bring the
   * base into it (an agent step resolves real conflicts) and verify it again. The chain follows that
   * run like any chunk: its settle back to review integrates again, a failure pauses with the
   * failed-spec options. Only a refresh that cannot run pauses here, with its reason.
   */
  private async refreshConflicted(row: MilestoneChainRow, snap: PrDeliverySnapshot): Promise<void> {
    let refreshed: { ok: true; runId: string } | ChainIoFailure
    try { refreshed = await this.io.refreshDelivery!(snap) } catch (error) {
      refreshed = { ok: false, status: 409, error: 'refresh_rejected', detail: error instanceof Error ? error.message : String(error) }
    }
    const current = getChain(this.db, row.id)
    if (!current || !isActiveChainStatus(current.status) || current.current_delivery_id !== snap.id) return
    if (!refreshed.ok) { this.pause(current, `integration_failed:${CONFLICT_REASON[refreshed.error] ?? 'conflict'}`); return }
    if (updateChain(this.db, current.id, current.status, { status: 'running', currentRunIds: [refreshed.runId], pauseReason: null }, this.now())) {
      const fresh = getChain(this.db, current.id)
      if (fresh) this.emit(fresh)
    }
  }

  /** The delivery-settle chokepoint: a `rail.pr_state` for the in-flight chunk. */
  private handleDeliveryState(snap: PrDeliverySnapshot): void {
    for (const row of listActiveChains(this.db)) {
      if (row.current_delivery_id !== snap.id) continue
      if (snap.decision === 'building') continue
      if (this.io.integrateDelivery && SUCCESS_DECISIONS.has(snap.decision)) {
        if (row.status === 'running' || row.status === 'waiting' && row.pause_reason === 'integration_pending') void this.integrateChunk(row.id).catch(logRejection('milestone chain integration'))
        else if (row.pause_reason?.startsWith('integration_') && ['merged', 'completed'].includes(snap.decision)) this.completeIntegrated(row)
        continue
      }
      if (SUCCESS_DECISIONS.has(snap.decision)) {
        const delivered = snap.executionManifest ? null : snap.decision === 'no_changes'
          ? row.head_branch
          : (snap.branch ?? snap.units.find((u) => u.succeeded && u.branch)?.branch ?? row.head_branch)
        if (row.status === 'running') {
          // Detach the settled chunk first so a duplicate broadcast is inert.
          updateChain(this.db, row.id, 'running', { status: 'waiting', currentDeliveryId: null, currentRunIds: [], headBranch: delivered }, this.now())
          this.afterChunkSuccess(row.id, delivered)
        } else {
          // Paused (e.g. head_discarded) while the chunk was in flight: record
          // the head, never auto-advance — Resume is the user's call.
          updateChain(this.db, row.id, row.status, { currentDeliveryId: null, currentRunIds: [], headBranch: delivered }, this.now())
        }
        continue
      }
      if (row.status === 'running') this.pauseFailedChunk(row, this.failureReason(row))
      else updateChain(this.db, row.id, row.status, { currentDeliveryId: null, currentRunIds: [] }, this.now())
    }
  }

  /** Tap for the project's bound broadcast (mirrors MilestoneProgressBroadcaster). */
  observe(msg: WsMessage): void {
    if (msg.type === 'milestone.chain_changed') {
      // A projection made outside the manager (the discard hook) carries no
      // plan: re-emit the reconciled one so every surface offers the right step.
      const chain = (msg as { chain?: { id?: unknown; plan?: unknown } }).chain
      if (chain && typeof chain.id === 'string' && chain.plan === undefined) {
        this.planSignatures.delete(chain.id)
        queueMicrotask(() => { try { this.refreshPlans() } catch { /* best effort */ } })
      }
      return
    }
    if (msg.type === 'rail.pr_state') {
      const id = (msg as { prDeliveryId?: unknown }).prDeliveryId
      if (typeof id === 'string' && listActiveChains(this.db).some((row) => row.current_delivery_id === id)) {
        let snap: PrDeliverySnapshot | null = null
        try { snap = this.io.getDelivery(id) } catch { snap = null }
        if (snap) this.handleDeliveryState(snap)
      }
    }
    if (PLAN_TRIGGERS.has(msg.type)) {
      try { this.refreshPlans() } catch { /* best effort */ }
    }
  }

  /**
   * Engine settle fallback (`onLoopRunFinished`). For an isolated chunk this
   * fires BEFORE the delivery leaves `building` — only the outcome is recorded
   * (it names the pause reason later). A chunk with NO delivery row (shared-cwd
   * fallback) settles here: success advances from the current head (no
   * stacking is possible without a worktree), anything else pauses.
   */
  onRunSettled(runId: string, outcome: string, stallReason?: string): void {
    // A provider usage limit is its own pause reason (the user waits for the
    // reset, then resumes) — never lumped in with a generic stall.
    const recorded = outcome === 'stalled' && stallReason === 'provider_limit' ? 'provider_limit' : outcome
    for (const row of listActiveChains(this.db)) {
      if (!parseRunIds(row).includes(runId)) continue
      updateChain(this.db, row.id, row.status, { lastRunOutcome: recorded }, this.now())
      if (row.current_delivery_id) continue
      if (row.status !== 'running') { updateChain(this.db, row.id, row.status, { currentRunIds: [] }, this.now()); continue }
      if (outcome === 'success') {
        updateChain(this.db, row.id, 'running', { status: 'waiting', currentRunIds: [] }, this.now())
        this.afterChunkSuccess(row.id, row.head_branch)
      } else {
        const fresh = getChain(this.db, row.id)
        if (fresh) this.pauseFailedChunk(fresh, this.failureReason(fresh))
      }
    }
  }

  /**
   * Resume (or "Launch next rail" at a checkpoint): reconcile against the live
   * rows and take the recommended step — continue with the next pending spec
   * when the paused one is already delivered, integrate a delivery the person
   * produced by hand, follow or resume a run already on the spec, or retry a
   * spec that genuinely failed. `from` picks between the two failed-spec paths.
   */
  async resume(id: string, opts: { from?: ChainResumeFrom } = {}): Promise<ChainControlResult> {
    const row = getChain(this.db, id)
    if (!row) return { ok: false, status: 404, error: 'chain_not_found' }
    const plan = this.plan(row)
    // A chain following a run the person paused: Resume resumes that run.
    if (row.status === 'running' && plan.action.kind === 'resume_run') {
      const r = await this.execute(row, plan, plan.action, false)
      if (!r.ok) return { ok: false, status: r.status, error: r.error, ...(r.detail ? { detail: r.detail } : {}) }
      return { ok: true, status: 202, chain: this.snapshot(getChain(this.db, id)!) }
    }
    if (row.status !== 'paused' && row.status !== 'awaiting_approval') return { ok: false, status: 409, error: 'chain_not_paused', detail: `chain is ${row.status}` }
    if (opts.from === 'failed_step') {
      if (plan.action.kind === 'resume_failed') {
        const r = await this.resumeFailedSpec(row, plan.order.map((t) => [t]), plan.action)
        return r
      }
      return this.resumeFailedStep(row)
    }
    if (opts.from !== 'start' && this.io.integrateDelivery && row.current_delivery_id && row.pause_reason?.startsWith('integration_')) {
      await this.integrateChunk(id)
      return { ok: true, status: 202, chain: this.snapshot(getChain(this.db, id)!) }
    }
    // `start`: run the spec again from the start — a failed spec, or a
    // delivery whose integration was refused (rebuilt on the updated base).
    const action: ChainNextAction = opts.from === 'start' && (plan.action.kind === 'resume_failed' || plan.action.kind === 'integrate')
      ? { kind: 'launch', ticketId: plan.action.ticketId, retry: true }
      : plan.action
    if (action.kind === 'launch') {
      const base = this.baseFor(row, plan, false)
      if (base.baseBranch && !this.io.integrateDelivery && !(await this.branchExistsSafe(base.baseBranch))) {
        updateChain(this.db, row.id, row.status, { status: 'paused', pauseReason: 'head_missing', headBranch: base.baseBranch }, this.now())
        const fresh = getChain(this.db, row.id)!
        this.emit(fresh)
        return { ok: false, status: 409, error: 'head_missing', detail: `branch ${base.baseBranch} no longer exists` }
      }
      updateChain(this.db, row.id, row.status, { status: 'waiting', headBranch: base.baseBranch ?? row.head_branch, pauseReason: null }, this.now())
    }
    const current = getChain(this.db, row.id)!
    const r = await this.execute(current, plan, action, false)
    const after = getChain(this.db, row.id)!
    if (!r.ok) {
      if (action.kind === 'launch') {
        // Same contract as an automatic advance: the chain pauses with the guard.
        this.pause(after, r.error === RAIL_LIMIT_REACHED ? RAIL_LIMIT_REACHED : `launch_rejected:${r.error}`)
        return { ok: true, status: 202, chain: this.snapshot(getChain(this.db, row.id)!) }
      }
      return { ok: false, status: r.status, error: r.error, ...(r.detail ? { detail: r.detail } : {}) }
    }
    if (action.kind !== 'complete' && action.kind !== 'integrate') this.emit(after)
    return { ok: true, status: 202, chain: this.snapshot(getChain(this.db, row.id)!) }
  }

  /** Continue a spec that genuinely failed from the step that stopped it: its
   *  newest run resumes in place (same lineage, worktree and delivery). */
  private async resumeFailedSpec(row: MilestoneChainRow, chunks: number[][], action: Extract<ChainNextAction, { kind: 'resume_failed' }>): Promise<ChainControlResult> {
    if (!this.io.resumeFailedRun) return { ok: false, status: 409, error: 'failed_step_unavailable', detail: 'this spec can only be relaunched from the start' }
    const restore = { status: row.status, pauseReason: row.pause_reason, retryChunk: row.retry_chunk, currentRunIds: parseRunIds(row), currentDeliveryId: row.current_delivery_id, currentRailIndex: row.current_rail_index, lastRunOutcome: row.last_run_outcome, launched: parseLaunched(row), chunks: parseChunks(row), nextChunk: row.next_chunk }
    const order = chunks.map((c) => c[0])
    this.recordLaunched(row.id, { chunk: order.indexOf(action.ticketId) + 1, railIndex: action.railIndex ?? -1, ticketIds: [action.ticketId], runIds: [action.runId], deliveryId: action.deliveryId }, chunks)
    let resumed: { ok: true } | ChainIoFailure
    try { resumed = await this.io.resumeFailedRun(action.runId) } catch (error) {
      resumed = { ok: false, status: 409, error: 'run_resume_failed', detail: error instanceof Error ? error.message : String(error) }
    }
    if (!resumed.ok) {
      updateChain(this.db, row.id, 'running', restore, this.now())
      const back = getChain(this.db, row.id)
      if (back) this.emit(back)
      return { ok: false, status: resumed.status, error: resumed.error, ...(resumed.detail ? { detail: resumed.detail } : {}) }
    }
    const fresh = getChain(this.db, row.id)!
    this.emit(fresh)
    return { ok: true, status: 202, chain: this.snapshot(fresh) }
  }

  /**
   * Continue a FAILED chunk from the step that stopped it: the chunk's own run
   * resumes in place (its worktree, its delivery), re-running only the
   * interrupted steps, instead of a fresh run of the whole spec. The chain is
   * marked running first so the resumed run's settle advances it as usual; a
   * rejected resume restores the pause untouched, so Resume from the start
   * stays available.
   */
  private async resumeFailedStep(row: MilestoneChainRow): Promise<ChainControlResult> {
    const failed = row.status === 'paused' && row.retry_chunk !== null
      ? parseLaunched(row).find((entry) => entry.chunk === row.retry_chunk! + 1)
      : undefined
    if (!failed) return { ok: false, status: 409, error: 'no_failed_step', detail: 'the chain is not paused on a failed spec' }
    if (failed.runIds.length !== 1 || !this.io.resumeFailedRun) return { ok: false, status: 409, error: 'failed_step_unavailable', detail: 'this spec can only be relaunched from the start' }
    const runId = failed.runIds[0]
    const restore = { status: 'paused' as const, pauseReason: row.pause_reason, retryChunk: row.retry_chunk, currentRunIds: parseRunIds(row), currentDeliveryId: row.current_delivery_id, currentRailIndex: row.current_rail_index, lastRunOutcome: row.last_run_outcome }
    if (!updateChain(this.db, row.id, row.status, {
      status: 'running', pauseReason: null, retryChunk: null, lastRunOutcome: null,
      currentRailIndex: failed.railIndex, currentRunIds: failed.runIds, currentDeliveryId: failed.deliveryId,
    }, this.now())) return { ok: false, status: 409, error: 'chain_not_paused', detail: 'the chain changed; try again' }
    let resumed: { ok: true } | ChainIoFailure
    try { resumed = await this.io.resumeFailedRun(runId) } catch (error) {
      resumed = { ok: false, status: 409, error: 'run_resume_failed', detail: error instanceof Error ? error.message : String(error) }
    }
    if (!resumed.ok) {
      updateChain(this.db, row.id, 'running', restore, this.now())
      const back = getChain(this.db, row.id)
      if (back) this.emit(back)
      return { ok: false, status: resumed.status, error: resumed.error, ...(resumed.detail ? { detail: resumed.detail } : {}) }
    }
    const fresh = getChain(this.db, row.id)!
    this.emit(fresh)
    return { ok: true, status: 202, chain: this.snapshot(fresh) }
  }

  /**
   * Flip the checkpoint preference on a live chain. Turning it ON while the
   * chain sits at a checkpoint launches the next chunk immediately.
   */
  async setAutoAdvance(id: string, on: boolean): Promise<ChainControlResult> {
    const row = getChain(this.db, id)
    if (!row) return { ok: false, status: 404, error: 'chain_not_found' }
    if (!isActiveChainStatus(row.status)) return { ok: false, status: 409, error: 'chain_terminal', detail: `chain is ${row.status}` }
    updateChain(this.db, row.id, row.status, { autoAdvance: on }, this.now())
    if (on && row.status === 'awaiting_approval') return this.resume(id)
    const fresh = getChain(this.db, row.id)!
    this.emit(fresh)
    return { ok: true, status: 200, chain: this.snapshot(fresh) }
  }

  cancel(id: string): ChainControlResult {
    const row = getChain(this.db, id)
    if (!row) return { ok: false, status: 404, error: 'chain_not_found' }
    if (!isActiveChainStatus(row.status)) return { ok: false, status: 409, error: 'chain_terminal', detail: `chain is ${row.status}` }
    updateChain(this.db, row.id, row.status, { status: 'cancelled' }, this.now())
    const fresh = getChain(this.db, row.id)!
    this.emit(fresh)
    return { ok: true, status: 200, chain: this.snapshot(fresh) }
  }

  /**
   * Startup: a chain whose in-flight chunk settled while the server was down
   * replays that settle exactly once (delivery row first, run rows as the
   * delivery-less fallback); a chunk whose rows vanished pauses `run_lost`.
   * Call only once the HTTP server is listening (advances launch over loopback).
   */
  async recoverOnStartup(): Promise<void> {
    for (const row of listActiveChains(this.db)) {
      if (this.io.integrateDelivery && row.status === 'waiting' && row.pause_reason?.startsWith('integration_')) {
        if (row.current_delivery_id) await this.integrateChunk(row.id)
        else if (row.pause_reason === 'integration_complete') this.afterChunkSuccess(row.id, row.integration_branch)
        continue
      }
      if (row.status !== 'running') continue
      if (row.current_delivery_id) {
        const snap = this.io.getDelivery(row.current_delivery_id)
        if (!snap) { this.pauseFailedChunk(row, 'run_lost'); continue }
        if (snap.decision !== 'building') this.handleDeliveryState(snap)
        continue
      }
      const runIds = parseRunIds(row)
      if (runIds.length === 0) { this.pauseFailedChunk(row, 'run_lost'); continue }
      const states = runIds.map((id) => this.io.runState(id))
      if (states.some((s) => s === null)) { this.pauseFailedChunk(row, 'run_lost'); continue }
      if (states.every((s) => s!.settled)) {
        const outcome = states.every((s) => s!.outcome === 'success') ? 'success' : (states.find((s) => s!.outcome !== 'success')!.outcome ?? 'failed')
        this.onRunSettled(runIds[0], outcome)
      }
    }
  }
}
