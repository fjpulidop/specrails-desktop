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
// pauses with a typed reason on any failure (never skips ahead), and is
// visible/controllable (resume / cancel) from every surface.

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
} from './milestone-chain-store'
import { newId } from '../../../ids'

/** One spec per rail: every chunk of a milestone chain carries exactly one spec. */
export const MAX_TICKETS_PER_CHAIN_CHUNK = 1

export function chunkTickets(ticketIds: number[], size = MAX_TICKETS_PER_CHAIN_CHUNK): number[][] {
  const chunks: number[][] = []
  for (let i = 0; i < ticketIds.length; i += size) chunks.push(ticketIds.slice(i, i + size))
  return chunks
}

/**
 * Launch order for a milestone's specs: a stable topological order over the
 * specs' `prerequisites` (edges to specs outside the set — already done or in
 * another milestone — are ignored), ties broken by `execution_order` (unset
 * last) and then id. A dependency cycle cannot block the milestone: the
 * remaining specs follow in tie order.
 */
export function orderChainTickets(tickets: ReadonlyArray<Pick<ProgressTicket, 'id' | 'prerequisites' | 'executionOrder'>>): number[] {
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

export interface MilestoneChainIO {
  createRail(name: string): Promise<{ ok: true; railIndex: number } | ChainIoFailure>
  assignTickets(railIndex: number, ticketIds: number[]): Promise<{ ok: true } | ChainIoFailure>
  launch(railIndex: number, body: { mode: 'implement'; baseBranch?: string; baseDeliveryIds?: string[] }): Promise<{ ok: true; loopRunIds: string[] } | ChainIoFailure>
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

  /** Non-terminal chains. */
  listActive(): MilestoneChainSnapshot[] {
    return listActiveChains(this.db).map(toChainSnapshot)
  }

  /** Newest chain per milestone, any status (feeds the progress model). */
  listForProgress(): MilestoneChainSnapshot[] {
    const seen = new Set<number>()
    const out: MilestoneChainSnapshot[] = []
    for (const row of listChains(this.db)) {
      if (seen.has(row.milestone_n)) continue
      seen.add(row.milestone_n)
      out.push(toChainSnapshot(row))
    }
    return out
  }

  get(id: string): MilestoneChainSnapshot | null {
    const row = getChain(this.db, id)
    return row ? toChainSnapshot(row) : null
  }

  private emit(row: MilestoneChainRow): void {
    try {
      this.io.broadcast({
        type: 'milestone.chain_changed',
        projectId: this.projectId,
        chain: toChainSnapshot(row),
        timestamp: new Date(this.now()).toISOString(),
      })
    } catch { /* durable row is authoritative */ }
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
    const launched = await this.io.launch(railIndex, { mode: 'implement', ...(baseDeliveryIds?.length ? { baseDeliveryIds } : baseBranch ? { baseBranch } : {}) })
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
      for (const index of [...new Set([...own, ...builder])]) {
        if (this.railFree(index)) return index
      }
      return null
    } catch {
      return null
    }
  }

  /** The rail a retried chunk can reuse: its previous attempt's rail when no
   *  undecided delivery still sits there (a failed delivery the user has not
   *  reviewed keeps the rail — the retry then takes a fresh one). */
  private reusableRailFor(row: MilestoneChainRow, chunkIndex: number): number | null {
    const previous = parseLaunched(row).find((l) => l.chunk === chunkIndex + 1)
    if (!previous) return null
    try {
      return this.io.activeDeliveryForRail(previous.railIndex) ? null : previous.railIndex
    } catch {
      return null
    }
  }

  /**
   * Launch a milestone. Always sequential: one spec per rail, each stacked on
   * the accumulated integration branch when integration is bound. `autoAdvance` defaults to ON; turning it off
   * parks the chain at a checkpoint after every delivered rail.
   */
  async start(n: number, opts: { autoAdvance?: boolean } = {}): Promise<ChainStartResult> {
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
      integrationBranch: await this.safeIntegrationBranch(), autoAdvance, nowMs: this.now(),
    })
    const first = await this.launchChunk(n, chunks, 0, null, null, undefined, row)
    if (!first.ok) {
      // Nothing launched ⇒ no chain remains active (the route relays the guard,
      // including `rail_limit_reached` when every rail holds undecided work).
      updateChain(this.db, row.id, 'running', { status: 'cancelled', pauseReason: first.error === RAIL_LIMIT_REACHED ? RAIL_LIMIT_REACHED : `launch_rejected:${first.error}` }, this.now())
      return { ok: false, status: first.status, error: first.error, detail: first.detail, chainId: row.id }
    }
    this.recordLaunched(row.id, first.entry)
    const fresh = getChain(this.db, row.id)
    if (fresh) this.emit(fresh)
    return { ok: true, status: 202, chainId: row.id, launched: [first.entry], pending: chunks.slice(1) }
  }

  private async safeIntegrationBranch(): Promise<string | null> {
    try { return await this.io.integrationBranch() } catch { return null }
  }

  private recordLaunched(chainId: string, entry: MilestoneChainLaunched): void {
    const row = getChain(this.db, chainId)
    if (!row) return
    // A retry REPLACES the failed attempt's entry for that chunk (the delivery
    // rows keep the history); a fresh chunk appends.
    const launched = parseLaunched(row).filter((l) => l.chunk !== entry.chunk)
    updateChain(this.db, chainId, row.status, {
      nextChunk: entry.chunk,
      currentRailIndex: entry.railIndex,
      currentRunIds: entry.runIds,
      currentDeliveryId: entry.deliveryId,
      lastRunOutcome: null,
      status: 'running',
      pauseReason: null,
      retryChunk: null,
      launched: [...launched, entry],
    }, this.now())
  }

  private pause(row: MilestoneChainRow, reason: string, patch: { headBranch?: string | null; retryChunk?: number | null } = {}): void {
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

  /** Launch the next chunk (or complete). Failures pause with `launch_rejected:<error>`. */
  private async advance(chainId: string, head: string | null): Promise<void> {
    const row = getChain(this.db, chainId)
    if (!row || !isActiveChainStatus(row.status)) return
    const chunks = parseChunks(row)
    // A paused chain whose chunk FAILED retries that chunk; otherwise the next.
    const chunkIndex = row.retry_chunk !== null && row.retry_chunk < row.next_chunk ? row.retry_chunk : row.next_chunk
    if (chunkIndex >= chunks.length) {
      if (updateChain(this.db, row.id, row.status, { status: 'completed', headBranch: head, currentRailIndex: null, currentRunIds: [], currentDeliveryId: null, pauseReason: null }, this.now())) {
        const fresh = getChain(this.db, row.id)
        if (fresh) this.emit(fresh)
      }
      return
    }
    const earlierDeliveries = parseLaunched(row).filter((entry) => entry.chunk <= chunkIndex && entry.deliveryId).map((entry) => entry.deliveryId!)
    const multiRepositoryHistory = !this.io.integrateDelivery && earlierDeliveries.some((id) => this.io.getDelivery(id)?.executionManifest)
    if (!multiRepositoryHistory && head && !(await this.branchExistsSafe(head))) {
      this.pause(row, 'head_missing', { headBranch: head })
      return
    }
    updateChain(this.db, row.id, row.status, { status: 'waiting', headBranch: head, pauseReason: null }, this.now())
    const reuse = chunkIndex < row.next_chunk ? this.reusableRailFor(row, chunkIndex) : null
    const r = await this.launchChunk(row.milestone_n, chunks, chunkIndex, head, reuse, multiRepositoryHistory ? earlierDeliveries : undefined, row)
    const current = getChain(this.db, chainId)
    if (!current || !isActiveChainStatus(current.status)) return
    if (!r.ok) {
      // Every rail holds undecided work: wait for the user to decide pending
      // PRs, then Resume launches this same spec.
      if (r.error === RAIL_LIMIT_REACHED) this.pause(current, RAIL_LIMIT_REACHED)
      else this.pause(current, `launch_rejected:${r.error}`)
      return
    }
    this.recordLaunched(chainId, r.entry)
    const fresh = getChain(this.db, chainId)
    if (fresh) this.emit(fresh)
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
    const remaining = parseChunks(row).length - row.next_chunk
    if (row.auto_advance !== 0 || remaining <= 0) {
      void this.advance(chainId, head)
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
      else this.pause(current, 'integration_failed:' + (result.ok ? 'not_confirmed' : result.error))
    } catch {
      const current = getChain(this.db, chainId)
      if (current && isActiveChainStatus(current.status) && current.current_delivery_id === snap.id) this.pause(current, 'integration_failed:unavailable')
    } finally { this.integrating.delete(chainId) }
  }

  /** The delivery-settle chokepoint: a `rail.pr_state` for the in-flight chunk. */
  private handleDeliveryState(snap: PrDeliverySnapshot): void {
    for (const row of listActiveChains(this.db)) {
      if (row.current_delivery_id !== snap.id) continue
      if (snap.decision === 'building') continue
      if (this.io.integrateDelivery && SUCCESS_DECISIONS.has(snap.decision)) {
        if (row.status === 'running' || row.status === 'waiting' && row.pause_reason === 'integration_pending') void this.integrateChunk(row.id)
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
    if (msg.type !== 'rail.pr_state') return
    const id = (msg as { prDeliveryId?: unknown }).prDeliveryId
    if (typeof id !== 'string') return
    if (!listActiveChains(this.db).some((row) => row.current_delivery_id === id)) return
    let snap: PrDeliverySnapshot | null = null
    try { snap = this.io.getDelivery(id) } catch { snap = null }
    if (snap) this.handleDeliveryState(snap)
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

  async resume(id: string): Promise<ChainControlResult> {
    const row = getChain(this.db, id)
    if (!row) return { ok: false, status: 404, error: 'chain_not_found' }
    if (row.status !== 'paused' && row.status !== 'awaiting_approval') return { ok: false, status: 409, error: 'chain_not_paused', detail: `chain is ${row.status}` }
    if (this.io.integrateDelivery && row.current_delivery_id && row.pause_reason?.startsWith('integration_')) {
      await this.integrateChunk(id)
      return { ok: true, status: 202, chain: toChainSnapshot(getChain(this.db, id)!) }
    }
    if (row.head_branch && !(await this.branchExistsSafe(row.head_branch))) {
      updateChain(this.db, row.id, row.status, { status: 'paused', pauseReason: 'head_missing' }, this.now())
      const fresh = getChain(this.db, row.id)!
      this.emit(fresh)
      return { ok: false, status: 409, error: 'head_missing', detail: `branch ${row.head_branch} no longer exists` }
    }
    await this.advance(row.id, row.head_branch)
    const after = getChain(this.db, row.id)!
    return { ok: true, status: 202, chain: toChainSnapshot(after) }
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
    return { ok: true, status: 200, chain: toChainSnapshot(fresh) }
  }

  cancel(id: string): ChainControlResult {
    const row = getChain(this.db, id)
    if (!row) return { ok: false, status: 404, error: 'chain_not_found' }
    if (!isActiveChainStatus(row.status)) return { ok: false, status: 409, error: 'chain_terminal', detail: `chain is ${row.status}` }
    updateChain(this.db, row.id, row.status, { status: 'cancelled' }, this.now())
    const fresh = getChain(this.db, row.id)!
    this.emit(fresh)
    return { ok: true, status: 200, chain: toChainSnapshot(fresh) }
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
