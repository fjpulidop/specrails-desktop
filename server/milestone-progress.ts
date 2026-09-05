// Server-derived milestone progress (premium-milestone-progress).
//
// The Builder sidebar used to count `status === 'done'` on a board it fetched
// only when its flyout opened — so a delivered M1 read `0/8` forever (every
// ask-first delivery parks its specs at `on_review`; `done` arrives only after a
// merge) and nothing ever updated live. This module is the ONE progress model:
// derived on the server from durable rows only (ticket store, rail_pr_deliveries,
// live rail runs, the launch chain), returned by `GET /:projectId/blueprint`
// and broadcast as `blueprint.milestone_progress` on every relevant mutation.
//
// Honesty contract: every count is a fact from a row. `failed` means "this
// spec is back at todo and its NEWEST delivery unit failed" — never a guess.
// The derived `state` is what surfaces render; the blueprint's stored status is
// a record (persisted `done` once, never auto-reverted).

import type { DbInstance } from './db'
import type { WsMessage } from './types'
import type { Blueprint, MilestoneStatus } from './blueprint-types'
import { readBlueprint, writeBlueprintPair } from './blueprint-render'
import { readStore } from './ticket-store'
import {
  listActivePrDeliveries,
  listTerminalPrDeliveries,
  toPrDeliverySnapshot,
  isTerminalPrDecision,
  type PrDeliverySnapshot,
} from './rail-pr-store'
import { getRails } from './rails-store'
import { getLoopRun, listActiveLoopRuns } from './loop-runs-store'
import { resolveProjectExecution } from './workspace-resolution'
import { workspacePathFor } from './workspace-manager'

// ─── Model ───────────────────────────────────────────────────────────────────

export type MilestoneState = 'planned' | 'committed' | 'running' | 'delivered' | 'done'

export interface MilestoneCounts {
  total: number
  done: number
  onReview: number
  inProgress: number
  todo: number
  /** Specs currently `todo` whose newest delivery unit failed (last attempt). */
  failed: number
}

export interface MilestoneRail {
  railIndex: number
  name: string | null
  /** Milestone tickets this rail carries (run or delivery). */
  ticketIds: number[]
  /** True while a run is live on the rail. */
  active: boolean
  /** The live run id (loop run or queue job) when `active`. */
  runId: string | null
  /** Run start (ISO) when active; the delivery's creation time otherwise. */
  startedAt: string | null
  /** Newest non-terminal delivery for the rail's milestone tickets. */
  delivery: PrDeliverySnapshot | null
  /** 1-based chunk ordinal when the rail was launched by a milestone chain. */
  chunkIndex: number | null
}

/** `awaiting_approval` = a wave checkpoint: the last chunk delivered fine and
 *  the chain waits for the user's go (auto-advance off) — healthy, unlike
 *  `paused`, whose Resume retries the SAME chunk. */
export type MilestoneChainStatus = 'running' | 'waiting' | 'paused' | 'awaiting_approval' | 'completed' | 'cancelled'

export interface MilestoneChainLaunched {
  chunk: number
  railIndex: number
  ticketIds: number[]
  runIds: string[]
  deliveryId: string | null
}

/** Chain snapshot as surfaced to clients (the store row's public projection). */
export interface MilestoneChainSnapshot {
  id: string
  milestoneN: number
  mode: 'sequential' | 'parallel'
  status: MilestoneChainStatus
  pauseReason: string | null
  /** false ⇒ every successful chunk settle parks the chain at a checkpoint. */
  autoAdvance: boolean
  nextChunk: number
  totalChunks: number
  currentRailIndex: number | null
  headBranch: string | null
  launched: MilestoneChainLaunched[]
  updatedAt: string
}

export interface MilestoneProgress {
  id: string
  n: number
  title: string
  storedStatus: MilestoneStatus
  state: MilestoneState
  counts: MilestoneCounts
  rails: MilestoneRail[]
  chain: MilestoneChainSnapshot | null
}

export interface ProgressTicket {
  id: number
  status: string
  labels: string[]
}

export interface ProgressActiveRun {
  runId: string
  railIndex: number
  ticketIds: number[]
  startedAt: string | null
}

export interface ProgressRailInfo {
  railIndex: number
  name: string | null
}

export interface DeriveMilestoneProgressInput {
  blueprint: Blueprint
  tickets: ProgressTicket[]
  /** Every delivery, active AND terminal (order irrelevant — sorted here). */
  deliveries: PrDeliverySnapshot[]
  activeRuns: ProgressActiveRun[]
  rails: ProgressRailInfo[]
  chains: MilestoneChainSnapshot[]
}

export function milestoneLabelFor(n: number): string {
  return `M${n}`
}

function deliveryFailedForTicket(d: PrDeliverySnapshot, ticketId: number): boolean {
  if (d.decision === 'implementation_failed') return true
  const unit = d.units.find((u) => u.ticketId === ticketId)
  if (!unit) return d.implementationOutcome === 'failed'
  if (unit.implementationOutcome === 'failed') return true
  if (unit.deliveryOutcome === 'blocked') return true
  return unit.implementationOutcome == null && unit.succeeded === false
}

/** Pure derivation — see the module header for the semantics. */
export function deriveMilestoneProgress(input: DeriveMilestoneProgressInput): MilestoneProgress[] {
  const deliveries = [...input.deliveries].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  )
  const railNames = new Map(input.rails.map((r) => [r.railIndex, r.name]))

  return input.blueprint.milestones.map((m, index): MilestoneProgress => {
    const n = index + 1
    const label = milestoneLabelFor(n)
    const mine = input.tickets.filter((t) => Array.isArray(t.labels) && t.labels.includes(label))
    const ids = new Set(mine.map((t) => t.id))
    const count = (status: string): number => mine.filter((t) => t.status === status).length
    const counts: MilestoneCounts = {
      total: mine.length,
      done: count('done'),
      onReview: count('on_review'),
      inProgress: count('in_progress'),
      todo: count('todo'),
      failed: 0,
    }
    for (const t of mine) {
      if (t.status !== 'todo') continue
      const newest = deliveries.find((d) => d.ticketIds.includes(t.id))
      if (newest && deliveryFailedForTicket(newest, t.id)) counts.failed += 1
    }

    const chain = input.chains.find((c) => c.milestoneN === n) ?? null
    const chunkByRail = new Map<number, number>()
    for (const l of chain?.launched ?? []) chunkByRail.set(l.railIndex, l.chunk)

    const rails = new Map<number, MilestoneRail>()
    for (const run of input.activeRuns) {
      const carried = run.ticketIds.filter((id) => ids.has(id))
      if (carried.length === 0) continue
      rails.set(run.railIndex, {
        railIndex: run.railIndex,
        name: railNames.get(run.railIndex) ?? null,
        ticketIds: carried,
        active: true,
        runId: run.runId,
        startedAt: run.startedAt,
        delivery: null,
        chunkIndex: chunkByRail.get(run.railIndex) ?? null,
      })
    }
    for (const d of deliveries) {
      if (isTerminalPrDecision(d.decision)) continue
      const carried = d.ticketIds.filter((id) => ids.has(id))
      if (carried.length === 0) continue
      const existing = rails.get(d.railIndex)
      if (existing) {
        if (!existing.delivery) existing.delivery = d
        continue
      }
      rails.set(d.railIndex, {
        railIndex: d.railIndex,
        name: railNames.get(d.railIndex) ?? null,
        ticketIds: carried,
        active: false,
        runId: null,
        startedAt: d.createdAt,
        delivery: d,
        chunkIndex: chunkByRail.get(d.railIndex) ?? null,
      })
    }
    const railList = [...rails.values()].sort((a, b) => {
      const ca = a.chunkIndex ?? Number.MAX_SAFE_INTEGER
      const cb = b.chunkIndex ?? Number.MAX_SAFE_INTEGER
      return ca !== cb ? ca - cb : a.railIndex - b.railIndex
    })

    const chainLive = chain !== null && (chain.status === 'running' || chain.status === 'waiting')
    const state: MilestoneState =
      counts.total > 0 && counts.done === counts.total ? 'done'
        : counts.total > 0 && counts.todo + counts.inProgress === 0 && counts.onReview > 0 ? 'delivered'
          : counts.inProgress > 0 || chainLive ? 'running'
            : counts.total > 0 ? 'committed'
              : m.status

    return {
      id: m.id,
      n,
      title: m.title,
      storedStatus: m.status,
      state,
      counts,
      rails: railList,
      chain,
    }
  })
}

// ─── Reading the durable sources ─────────────────────────────────────────────

/** The workspace holding the blueprint pair (same resolution as the route). */
export function resolveBlueprintWorkspace(project: { slug: string; path: string }): string | null {
  const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
  if (exec.relocated && exec.workspaceDir) return exec.workspaceDir
  return project.slug ? workspacePathFor(project.slug) : null
}

export interface MilestoneProgressSource {
  db: DbInstance
  projectId: string
  workspaceDir: () => string | null
  ticketsPath: () => string
  railJobs?: Map<string, { railIndex: number; ticketIds: number[] }>
  railLoopRuns?: Map<string, { railIndex: number; ticketIds: number[] }>
  /** Active launch chains (wired by the chain manager; absent ⇒ none). */
  chains?: () => MilestoneChainSnapshot[]
}

export interface MilestoneProgressSnapshot {
  blueprint: Blueprint
  progress: MilestoneProgress[]
}

function parseTicketIds(raw: string | undefined): number[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : []
  } catch {
    return []
  }
}

/** Read every durable source and derive; null when the project has no blueprint. */
export function readMilestoneProgress(src: MilestoneProgressSource): MilestoneProgressSnapshot | null {
  const workspace = src.workspaceDir()
  const blueprint = workspace ? readBlueprint(workspace) : null
  if (!blueprint) return null

  let tickets: ProgressTicket[] = []
  try {
    const store = readStore(src.ticketsPath())
    tickets = Object.values(store.tickets).map((t) => ({ id: t.id, status: t.status, labels: t.labels ?? [] }))
  } catch {
    tickets = []
  }

  let deliveries: PrDeliverySnapshot[] = []
  try {
    deliveries = [...listActivePrDeliveries(src.db), ...listTerminalPrDeliveries(src.db)].map(toPrDeliverySnapshot)
  } catch {
    deliveries = []
  }

  const activeRuns: ProgressActiveRun[] = []
  const seenRuns = new Set<string>()
  for (const [runId, meta] of src.railLoopRuns?.entries() ?? []) {
    seenRuns.add(runId)
    let startedAt: string | null = null
    try { startedAt = getLoopRun(src.db, runId)?.started_at ?? null } catch { /* fall through */ }
    activeRuns.push({ runId, railIndex: meta.railIndex, ticketIds: meta.ticketIds, startedAt })
  }
  try {
    for (const run of listActiveLoopRuns(src.db, src.projectId)) {
      if (run.rail_index == null || seenRuns.has(run.id)) continue
      seenRuns.add(run.id)
      const ids = parseTicketIds(run.ticket_ids_json)
      activeRuns.push({
        runId: run.id,
        railIndex: run.rail_index,
        ticketIds: ids.length > 0 ? ids : run.ticket_id != null ? [run.ticket_id] : [],
        startedAt: run.started_at ?? null,
      })
    }
  } catch { /* DB unavailable ⇒ in-memory maps only */ }
  for (const [jobId, meta] of src.railJobs?.entries() ?? []) {
    if (seenRuns.has(jobId)) continue
    activeRuns.push({ runId: jobId, railIndex: meta.railIndex, ticketIds: meta.ticketIds, startedAt: null })
  }

  let rails: ProgressRailInfo[] = []
  try {
    rails = getRails(src.db).map((r) => ({ railIndex: r.railIndex, name: r.name ?? null }))
  } catch {
    rails = []
  }

  let chains: MilestoneChainSnapshot[] = []
  try { chains = src.chains?.() ?? [] } catch { chains = [] }

  return { blueprint, progress: deriveMilestoneProgress({ blueprint, tickets, deliveries, activeRuns, rails, chains }) }
}

/** Persist `status: 'done'` on one milestone (idempotent). Returns the
 *  updated blueprint, or null when nothing was written. */
export function markMilestoneDone(workspaceDir: string | null, milestoneId: string): Blueprint | null {
  if (!workspaceDir) return null
  const blueprint = readBlueprint(workspaceDir)
  if (!blueprint) return null
  const milestone = blueprint.milestones.find((m) => m.id === milestoneId)
  if (!milestone || milestone.status === 'done') return null
  milestone.status = 'done'
  writeBlueprintPair(workspaceDir, blueprint)
  return blueprint
}

// ─── Broadcaster ─────────────────────────────────────────────────────────────

/** WS message types whose arrival means the milestone progress may have
 *  changed. Everything else (log frames, queue ticks…) is ignored. */
export const MILESTONE_PROGRESS_TRIGGERS: ReadonlySet<string> = new Set([
  'ticket_created',
  'ticket_updated',
  'ticket_deleted',
  'rail.pr_state',
  'rail.updated',
  'rail.removed',
  'rail.job_started',
  'rail.job_completed',
  'rail.job_stopped',
  'loop.run_completed',
  'loop.run_stopped',
  'milestone.chain_changed',
])

export const MILESTONE_PROGRESS_DEBOUNCE_MS = 150

export interface MilestoneProgressBroadcasterDeps {
  projectId: string
  read: () => MilestoneProgressSnapshot | null
  broadcast: (msg: WsMessage) => void
  /** Persist a milestone as done; true when a write happened. */
  persistDone: (milestoneId: string) => boolean
  debounceMs?: number
  now?: () => number
}

/**
 * Per-project debounced progress broadcaster. `observe(msg)` is the ONE tap
 * (wired inside the project's bound broadcast): any trigger schedules a flush;
 * a flush re-reads the durable sources, persists newly-completed milestones,
 * and emits `blueprint.milestone_progress` (+ `blueprint.milestone_completed`).
 * A project with no blueprint is remembered as absent so the tap costs nothing
 * on ordinary projects until `invalidate()` (a blueprint commit) resets it.
 */
export class MilestoneProgressBroadcaster {
  private timer: ReturnType<typeof setTimeout> | null = null
  private knownAbsent = false
  private disposed = false

  constructor(private readonly deps: MilestoneProgressBroadcasterDeps) {}

  observe(msg: WsMessage): void {
    if (this.disposed) return
    if (!MILESTONE_PROGRESS_TRIGGERS.has(msg.type)) return
    this.schedule()
  }

  schedule(): void {
    if (this.disposed || this.knownAbsent) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, this.deps.debounceMs ?? MILESTONE_PROGRESS_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  /** Forget the "no blueprint" memo (call after a blueprint lands). */
  invalidate(): void {
    this.knownAbsent = false
  }

  /** Synchronous read + broadcast. Returns the snapshot (null = no blueprint). */
  flush(): MilestoneProgressSnapshot | null {
    if (this.disposed) return null
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    let snapshot: MilestoneProgressSnapshot | null
    try {
      snapshot = this.deps.read()
    } catch (err) {
      console.error('[milestone-progress] read failed:', err)
      return null
    }
    if (!snapshot) {
      this.knownAbsent = true
      return null
    }
    const completed: MilestoneProgress[] = []
    for (const m of snapshot.progress) {
      if (m.state !== 'done' || m.storedStatus === 'done') continue
      let written = false
      try { written = this.deps.persistDone(m.id) } catch (err) { console.error('[milestone-progress] persist done failed:', err) }
      if (written) {
        m.storedStatus = 'done'
        completed.push(m)
      }
    }
    const timestamp = new Date(this.deps.now?.() ?? Date.now()).toISOString()
    try {
      this.deps.broadcast({ type: 'blueprint.milestone_progress', projectId: this.deps.projectId, progress: snapshot.progress, timestamp })
    } catch { /* durable rows are authoritative */ }
    for (const m of completed) {
      try {
        this.deps.broadcast({ type: 'blueprint.milestone_completed', projectId: this.deps.projectId, milestoneId: m.id, n: m.n, title: m.title, timestamp })
      } catch { /* ignore */ }
    }
    return snapshot
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }
}
