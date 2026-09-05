// Durable milestone launch chains (premium-milestone-progress, migration 58).
//
// One row per "Launch Milestone" in sequential mode: the chunk plan, the
// chunk currently in flight (rail / runs / delivery), the branch the next
// chunk stacks on, and a compare-and-set status so a settle is never advanced
// twice. Replaces the browser-local localStorage plan that died with the
// window and never stacked chunks.

import type { DbInstance } from './db'
import type { MilestoneChainSnapshot, MilestoneChainLaunched, MilestoneChainStatus } from './milestone-progress'

export type MilestoneChainMode = 'sequential' | 'parallel'

export interface MilestoneChainRow {
  id: string
  milestone_n: number
  milestone_id: string
  mode: MilestoneChainMode
  /** JSON number[][] — the chunk plan, ≤3 ticket ids each. */
  chunks: string
  /** Index of the NEXT chunk to launch (= number of chunks launched). */
  next_chunk: number
  current_rail_index: number | null
  /** JSON string[] — the in-flight chunk's run ids. */
  current_run_ids: string
  current_delivery_id: string | null
  integration_branch: string | null
  /** The branch the next chunk stacks on (last delivered chunk's branch). */
  head_branch: string | null
  status: MilestoneChainStatus
  pause_reason: string | null
  /** JSON MilestoneChainLaunched[] — every chunk launched so far. */
  launched: string
  /** Outcome the engine reported for the in-flight run (fallback hook). */
  last_run_outcome: string | null
  /** 1 = launch the next chunk on success; 0 = stop at a checkpoint. */
  auto_advance: number
  /** Set when the chain paused because a chunk FAILED: the 0-based index of
   *  that chunk, so Resume retries IT instead of skipping to the next one. */
  retry_chunk: number | null
  created_at: string
  updated_at: string
}

export const ACTIVE_CHAIN_STATUSES: ReadonlySet<MilestoneChainStatus> = new Set(['running', 'waiting', 'paused', 'awaiting_approval'])

export function isActiveChainStatus(status: string): boolean {
  return ACTIVE_CHAIN_STATUSES.has(status as MilestoneChainStatus)
}

export interface CreateChainInput {
  id: string
  milestoneN: number
  milestoneId: string
  mode: MilestoneChainMode
  chunks: number[][]
  integrationBranch: string | null
  status?: MilestoneChainStatus
  /** Default true (API callers); the UI sends the user's stored preference. */
  autoAdvance?: boolean
  nowMs?: number
}

function iso(nowMs?: number): string {
  return new Date(nowMs ?? Date.now()).toISOString()
}

export function createChain(db: DbInstance, input: CreateChainInput): MilestoneChainRow {
  const ts = iso(input.nowMs)
  db.prepare(`
    INSERT INTO milestone_launch_chains
      (id, milestone_n, milestone_id, mode, chunks, next_chunk, current_run_ids, integration_branch, status, launched, auto_advance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, '[]', ?, ?, '[]', ?, ?, ?)
  `).run(input.id, input.milestoneN, input.milestoneId, input.mode, JSON.stringify(input.chunks), input.integrationBranch, input.status ?? 'running', input.autoAdvance === false ? 0 : 1, ts, ts)
  return getChain(db, input.id)!
}

export function getChain(db: DbInstance, id: string): MilestoneChainRow | undefined {
  return db.prepare('SELECT * FROM milestone_launch_chains WHERE id = ?').get(id) as MilestoneChainRow | undefined
}

/** Non-terminal chains (running / waiting / paused / awaiting_approval), oldest first. */
export function listActiveChains(db: DbInstance): MilestoneChainRow[] {
  return db.prepare(`
    SELECT * FROM milestone_launch_chains
     WHERE status IN ('running','waiting','paused','awaiting_approval')
     ORDER BY created_at ASC, rowid ASC
  `).all() as MilestoneChainRow[]
}

/** Every chain, newest first (progress projection picks the newest per milestone). */
export function listChains(db: DbInstance): MilestoneChainRow[] {
  return db.prepare('SELECT * FROM milestone_launch_chains ORDER BY created_at DESC, rowid DESC').all() as MilestoneChainRow[]
}

export function parseChunks(row: MilestoneChainRow): number[][] {
  try {
    const parsed = JSON.parse(row.chunks)
    return Array.isArray(parsed) ? parsed.filter((c): c is number[] => Array.isArray(c)) : []
  } catch {
    return []
  }
}

export function parseLaunched(row: MilestoneChainRow): MilestoneChainLaunched[] {
  try {
    const parsed = JSON.parse(row.launched)
    return Array.isArray(parsed) ? (parsed as MilestoneChainLaunched[]) : []
  } catch {
    return []
  }
}

export function parseRunIds(row: MilestoneChainRow): string[] {
  try {
    const parsed = JSON.parse(row.current_run_ids)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Chains whose launched chunks include this delivery (any status). */
export function listChainsTouchingDelivery(db: DbInstance, deliveryId: string): MilestoneChainRow[] {
  return listChains(db).filter((row) => parseLaunched(row).some((l) => l.deliveryId === deliveryId))
}

export interface ChainPatch {
  nextChunk?: number
  currentRailIndex?: number | null
  currentRunIds?: string[]
  currentDeliveryId?: string | null
  headBranch?: string | null
  status?: MilestoneChainStatus
  pauseReason?: string | null
  launched?: MilestoneChainLaunched[]
  lastRunOutcome?: string | null
  autoAdvance?: boolean
  retryChunk?: number | null
}

const PATCH_COLUMNS: Record<keyof ChainPatch, string> = {
  nextChunk: 'next_chunk',
  currentRailIndex: 'current_rail_index',
  currentRunIds: 'current_run_ids',
  currentDeliveryId: 'current_delivery_id',
  headBranch: 'head_branch',
  status: 'status',
  pauseReason: 'pause_reason',
  launched: 'launched',
  lastRunOutcome: 'last_run_outcome',
  autoAdvance: 'auto_advance',
  retryChunk: 'retry_chunk',
}

function patchValue(key: keyof ChainPatch, patch: ChainPatch): unknown {
  const raw = patch[key]
  if (key === 'currentRunIds' || key === 'launched') return JSON.stringify(raw ?? [])
  if (key === 'autoAdvance') return raw ? 1 : 0
  return raw ?? null
}

/**
 * Compare-and-set update: applies only while the row's status is one of
 * `expected` (a string or a list). Returns true when a row changed.
 */
export function updateChain(
  db: DbInstance,
  id: string,
  expected: MilestoneChainStatus | MilestoneChainStatus[],
  patch: ChainPatch,
  nowMs?: number,
): boolean {
  const keys = (Object.keys(patch) as (keyof ChainPatch)[]).filter((k) => patch[k] !== undefined)
  const setClause = keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).concat('updated_at = ?').join(', ')
  const values = keys.map((k) => patchValue(k, patch))
  const expectedList = Array.isArray(expected) ? expected : [expected]
  const placeholders = expectedList.map(() => '?').join(', ')
  return db.prepare(`UPDATE milestone_launch_chains SET ${setClause} WHERE id = ? AND status IN (${placeholders})`)
    .run(...values, iso(nowMs), id, ...expectedList).changes > 0
}

export function toChainSnapshot(row: MilestoneChainRow): MilestoneChainSnapshot {
  return {
    id: row.id,
    milestoneN: row.milestone_n,
    mode: row.mode,
    status: row.status,
    pauseReason: row.pause_reason,
    autoAdvance: row.auto_advance !== 0,
    nextChunk: row.next_chunk,
    totalChunks: parseChunks(row).length,
    currentRailIndex: row.current_rail_index,
    headBranch: row.head_branch,
    launched: parseLaunched(row),
    updatedAt: row.updated_at,
  }
}

/**
 * A delivery that a chain's later chunks build on was discarded by the user:
 * pause every active chain whose launched chunks include it, and rewind the
 * head to the previous launched chunk's delivery (`resolveBranch`), else null
 * (= the integration branch). Returns the rows it paused.
 */
export function pauseChainsForDiscardedHead(
  db: DbInstance,
  deliveryId: string,
  resolveBranch: (deliveryId: string) => string | null,
  nowMs?: number,
): MilestoneChainRow[] {
  const paused: MilestoneChainRow[] = []
  for (const row of listActiveChains(db)) {
    const launched = parseLaunched(row)
    const idx = launched.findIndex((l) => l.deliveryId === deliveryId)
    if (idx < 0) continue
    let previous: string | null = null
    for (let i = idx - 1; i >= 0; i--) {
      const id = launched[i].deliveryId
      if (!id) continue
      previous = resolveBranch(id)
      if (previous) break
    }
    if (updateChain(db, row.id, row.status, { status: 'paused', pauseReason: 'head_discarded', headBranch: previous }, nowMs)) {
      const fresh = getChain(db, row.id)
      if (fresh) paused.push(fresh)
    }
  }
  return paused
}
