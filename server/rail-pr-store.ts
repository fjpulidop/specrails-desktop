/**
 * CRUD for the `rail_pr_deliveries` ledger (migration 36) — one row per isolated
 * rail LAUNCH tracking the ask-first PR decision lifecycle. This is the single
 * authoritative server-side state both decision surfaces (the rail row on the
 * dashboard and the launching agent-chat conversation) read and write, so the
 * two surfaces never desync and a refresh/restart never loses a pending
 * decision. Pure data access; the PR plumbing lives in rail-pr-delivery /
 * pr-publisher and the launch wiring in rail-isolated-launch.
 */
import type { DbInstance } from './db'
import type { PrDecisionCardEnvelope, RailPrStateMessage } from './types'
import { newId } from './ids'

/**
 * building → on_review → pr_draft → pr_ready → merged, with discarded reachable
 * from every non-terminal state. `pr_failed` is the retryable create-PR failure;
 * `implementation_failed` is the pre-delivery job/loop failure state.
 */
export type PrDecision =
  | 'building'
  | 'on_review'
  | 'pr_draft'
  | 'pr_ready'
  | 'merged'
  | 'discarded'
  | 'implementation_failed'
  | 'pr_failed'

/** How far a Create-PR attempt got (the pr-publisher degradation ladder), independent of `decision`. */
export type PrDeliveryState = 'none' | 'local-only' | 'pushed' | 'pr-created'

/** Which surface launched the rail; `agent-chat` rows carry an origin_conversation_id. */
export type PrOriginSurface = 'dashboard' | 'agent-chat'

/** Per-unit branch record captured at build-settle (mirrors rail-pr-delivery's DeliverBranch). */
export interface DeliverBranchRecord {
  ticketId: number
  branch: string
  succeeded: boolean
}

/** States after which the delivery is closed (no further decision possible). */
export const TERMINAL_PR_DECISIONS: ReadonlySet<PrDecision> = new Set(['merged', 'discarded'])

/** States in which the delivery still awaits (or is executing) a user decision. */
export const ACTIVE_PR_DECISIONS: ReadonlySet<PrDecision> = new Set([
  'building',
  'on_review',
  'pr_draft',
  'pr_ready',
  'implementation_failed',
  'pr_failed',
])

export function isTerminalPrDecision(s: string): boolean {
  return TERMINAL_PR_DECISIONS.has(s as PrDecision)
}

export interface RailPrDeliveryRow {
  id: string
  rail_index: number
  loop_id: string | null
  rail_key: string
  /** JSON number[] — every ticket covered by the launch. */
  ticket_ids: string
  base_branch: string
  /** The assembled/delivered head branch (once a Create-PR ran). */
  branch: string | null
  pr_url: string | null
  pr_number: number | null
  pr_state: PrDeliveryState
  decision: PrDecision
  /** JSON DeliverBranchRecord[] — per-unit source branches captured at settle. */
  branches: string
  loop_name: string
  /** JSON string[] — rail_worktrees ledger ids, for discard cleanup. */
  worktree_ids: string
  /** JSON string[] — the launch's loop-run ids (order matches ticket order;
   *  one entry for scope='all'). Patched right after allocation so the PR
   *  decision surfaces can link each run's log + live vitals (migration 38). */
  run_ids: string
  origin_surface: PrOriginSurface
  origin_conversation_id: string | null
  created_at: string
  updated_at: string
}

export interface CreatePrDeliveryInput {
  /** Row uuid; generated when omitted. */
  id?: string
  railIndex: number
  loopId?: string | null
  railKey: string
  ticketIds: number[]
  baseBranch: string
  loopName: string
  originSurface: PrOriginSurface
  originConversationId?: string | null
}

/**
 * Insert a new delivery row for a rail launch. The row starts at
 * decision='building', pr_state='none' with empty branches/worktree_ids —
 * settle patches those via transitionDecision.
 */
export function createPrDelivery(db: DbInstance, input: CreatePrDeliveryInput): RailPrDeliveryRow {
  const id = input.id ?? newId()
  db.prepare(
    `INSERT INTO rail_pr_deliveries (
       id, rail_index, loop_id, rail_key, ticket_ids, base_branch,
       loop_name, origin_surface, origin_conversation_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.railIndex,
    input.loopId ?? null,
    input.railKey,
    JSON.stringify(input.ticketIds),
    input.baseBranch,
    input.loopName,
    input.originSurface,
    input.originConversationId ?? null
  )
  return getPrDelivery(db, id)!
}

export function getPrDelivery(db: DbInstance, id: string): RailPrDeliveryRow | undefined {
  return db.prepare('SELECT * FROM rail_pr_deliveries WHERE id = ?').get(id) as RailPrDeliveryRow | undefined
}

/**
 * The newest non-terminal delivery for a rail slot (a slot can be relaunched;
 * older terminal rows are history). Used by the relaunch-collision guard and
 * the GET /rails snapshot.
 */
export function getActivePrDeliveryByRail(db: DbInstance, railIndex: number): RailPrDeliveryRow | undefined {
  return db
    .prepare(
      `SELECT * FROM rail_pr_deliveries
       WHERE rail_index = ? AND decision NOT IN ('merged','discarded')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(railIndex) as RailPrDeliveryRow | undefined
}

/** Every non-terminal delivery — hydrates the GET /rails prDeliveries snapshot. */
export function listActivePrDeliveries(db: DbInstance): RailPrDeliveryRow[] {
  return db
    .prepare(
      `SELECT * FROM rail_pr_deliveries
       WHERE decision NOT IN ('merged','discarded')
       ORDER BY rail_index, created_at DESC, rowid DESC`
    )
    .all() as RailPrDeliveryRow[]
}

/**
 * Recover implementation cards stranded at `building` after the loop process
 * already settled all associated run ids without a success. This covers server
 * restarts and the settle gap where loop_runs/worktrees mark failure but the
 * PR-delivery row never receives its final card state.
 */
export function reconcileFailedBuildingPrDeliveries(db: DbInstance): RailPrDeliveryRow[] {
  const rows = db
    .prepare(`SELECT * FROM rail_pr_deliveries WHERE decision = 'building' ORDER BY created_at ASC, rowid ASC`)
    .all() as RailPrDeliveryRow[]
  const reconciled: RailPrDeliveryRow[] = []

  for (const row of rows) {
    const runIds = parseJsonArray<string>(row.run_ids ?? '[]')
    if (runIds.length === 0) continue
    const uniqueRunIds = [...new Set(runIds)]
    const placeholders = uniqueRunIds.map(() => '?').join(',')
    const runs = db
      .prepare(`SELECT id, status, final_outcome FROM loop_runs WHERE id IN (${placeholders})`)
      .all(...uniqueRunIds) as Array<{ id: string; status: string; final_outcome: string | null }>
    if (runs.length !== uniqueRunIds.length) continue
    if (runs.some((run) => run.status !== 'completed')) continue
    if (runs.some((run) => run.final_outcome === 'success')) continue

    if (transitionDecision(db, row.id, 'building', 'implementation_failed')) {
      const updated = getPrDelivery(db, row.id)
      if (updated) reconciled.push(updated)
    }
  }

  return reconciled
}

/** Optional column updates riding a decision transition. */
export interface PrDeliveryPatch {
  branch?: string | null
  prUrl?: string | null
  prNumber?: number | null
  prState?: PrDeliveryState
  branches?: DeliverBranchRecord[]
  worktreeIds?: string[]
  runIds?: string[]
}

// Column allow-list — patch keys are interpolated into the SET clause, so gate
// them to prevent any future caller injecting SQL via an object key (values
// are always parameterized). Mirrors loop-runs-store's COUNTER_COLUMNS.
const PATCH_COLUMNS: Record<keyof PrDeliveryPatch, string> = {
  branch: 'branch',
  prUrl: 'pr_url',
  prNumber: 'pr_number',
  prState: 'pr_state',
  branches: 'branches',
  worktreeIds: 'worktree_ids',
  runIds: 'run_ids',
}

function patchValue(key: keyof PrDeliveryPatch, patch: PrDeliveryPatch): string | number | null {
  const raw = patch[key]
  if (key === 'branches' || key === 'worktreeIds' || key === 'runIds') return JSON.stringify(raw)
  return raw as string | number | null
}

/**
 * COMPARE-AND-SET decision transition: one atomic
 * `UPDATE … WHERE id = ? AND decision = ?` (no read-modify-write), so two
 * surfaces racing on the same delivery cannot both win. Returns `false` (row
 * untouched) when `expected` is stale — the caller maps that to a 409.
 * `patch` may set delivery columns alongside the transition; `updated_at` is
 * always bumped.
 */
export function transitionDecision(
  db: DbInstance,
  id: string,
  expected: PrDecision,
  next: PrDecision,
  patch: PrDeliveryPatch = {}
): boolean {
  const keys = (Object.keys(patch) as (keyof PrDeliveryPatch)[]).filter((k) => patch[k] !== undefined)
  const patchClause = keys.map((k) => `, ${PATCH_COLUMNS[k]} = ?`).join('')
  const values = keys.map((k) => patchValue(k, patch))
  return (
    db
      .prepare(
        `UPDATE rail_pr_deliveries
         SET decision = ?, updated_at = datetime('now')${patchClause}
         WHERE id = ? AND decision = ?`
      )
      .run(next, ...values, id, expected).changes > 0
  )
}

/**
 * The camelCase wire shape of a delivery row (JSON arrays parsed) — what the
 * rail.pr_state broadcast and the GET /rails prDeliveries record carry.
 */
export interface PrDeliverySnapshot {
  id: string
  railIndex: number
  loopId: string | null
  railKey: string
  ticketIds: number[]
  baseBranch: string
  branch: string | null
  prUrl: string | null
  prNumber: number | null
  prState: PrDeliveryState
  decision: PrDecision
  branches: DeliverBranchRecord[]
  loopName: string
  worktreeIds: string[]
  /** The launch's loop-run ids, in ticket order (per-run log link + vitals). */
  runIds: string[]
  originSurface: PrOriginSurface
  originConversationId: string | null
  createdAt: string
  updatedAt: string
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export function toPrDeliverySnapshot(row: RailPrDeliveryRow): PrDeliverySnapshot {
  return {
    id: row.id,
    railIndex: row.rail_index,
    loopId: row.loop_id,
    railKey: row.rail_key,
    ticketIds: parseJsonArray<number>(row.ticket_ids),
    baseBranch: row.base_branch,
    branch: row.branch,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    prState: row.pr_state,
    decision: row.decision,
    branches: parseJsonArray<DeliverBranchRecord>(row.branches),
    loopName: row.loop_name,
    worktreeIds: parseJsonArray<string>(row.worktree_ids),
    runIds: parseJsonArray<string>(row.run_ids ?? '[]'),
    originSurface: row.origin_surface,
    originConversationId: row.origin_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Build the durable `rail.pr_state` broadcast payload from a delivery snapshot
 * — the ONE message shape every mutation of the row re-broadcasts (launch
 * insert, build-settle, decision-endpoint transitions), so both decision
 * surfaces converge on the same state.
 */
export function toRailPrStateMessage(projectId: string, snap: PrDeliverySnapshot): RailPrStateMessage {
  return {
    type: 'rail.pr_state',
    projectId,
    railIndex: snap.railIndex,
    prDeliveryId: snap.id,
    railKey: snap.railKey,
    ticketIds: snap.ticketIds,
    baseBranch: snap.baseBranch,
    branch: snap.branch,
    prUrl: snap.prUrl,
    prNumber: snap.prNumber,
    prState: snap.prState,
    decision: snap.decision,
    runIds: snap.runIds,
    originConversationId: snap.originConversationId,
  }
}

/**
 * Build the agent-chat PR-decision card envelope from a delivery snapshot —
 * the ONE mapper both card writers (rail-isolated-launch's origin-card sync
 * and rail-pr-decision's finalizeTransition) share, so the persisted card and
 * the `agent_pr_decision` broadcast can never drift between the two sites.
 */
export function toPrDecisionCardEnvelope(projectId: string, snap: PrDeliverySnapshot): PrDecisionCardEnvelope {
  return {
    kind: 'pr_decision',
    prDeliveryId: snap.id,
    railIndex: snap.railIndex,
    projectId,
    baseBranch: snap.baseBranch,
    ticketIds: snap.ticketIds,
    decision: snap.decision,
    prUrl: snap.prUrl,
    prNumber: snap.prNumber,
    prState: snap.prState,
    branch: snap.branch,
    runIds: snap.runIds,
  }
}
