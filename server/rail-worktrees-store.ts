/**
 * CRUD for the `rail_worktrees` ledger (migration 35) — one row per (rail launch,
 * ticket) tracking the worktree/branch/overlay and its merge state, so the engine
 * can reconcile orphaned worktrees after a crash and the UI can render integration
 * progress. Pure data access; the worktree/merge plumbing lives in
 * worktree-manager / merge-manager.
 */
import type { DbInstance } from './db'

/** building → built → merging → {merged | needs-review | failed | released}. */
export type MergeState = 'building' | 'built' | 'merging' | 'merged' | 'needs-review' | 'failed' | 'released'

/** States after which the worktree is done (eligible for cleanup/reconciliation). */
export const TERMINAL_MERGE_STATES: ReadonlySet<MergeState> = new Set(['merged', 'needs-review', 'failed', 'released'])

export function isTerminalMergeState(s: string): boolean {
  return TERMINAL_MERGE_STATES.has(s as MergeState)
}

export interface RailWorktreeRow {
  id: string
  rail_index: number
  ticket_id: number
  run_id: string | null
  branch: string
  worktree_path: string
  overlay_path: string | null
  merge_state: MergeState
  created_at: string
  updated_at: string
}

export interface CreateRailWorktreeInput {
  id: string
  railIndex: number
  ticketId: number
  runId?: string | null
  branch: string
  worktreePath: string
  overlayPath?: string | null
  mergeState?: MergeState
}

export function createRailWorktree(db: DbInstance, input: CreateRailWorktreeInput): RailWorktreeRow {
  db.prepare(
    `INSERT INTO rail_worktrees (id, rail_index, ticket_id, run_id, branch, worktree_path, overlay_path, merge_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.railIndex,
    input.ticketId,
    input.runId ?? null,
    input.branch,
    input.worktreePath,
    input.overlayPath ?? null,
    input.mergeState ?? 'building'
  )
  return getRailWorktree(db, input.id)!
}

export function getRailWorktree(db: DbInstance, id: string): RailWorktreeRow | undefined {
  return db.prepare('SELECT * FROM rail_worktrees WHERE id = ?').get(id) as RailWorktreeRow | undefined
}

export function updateRailWorktreeState(db: DbInstance, id: string, state: MergeState): boolean {
  return (
    db
      .prepare(`UPDATE rail_worktrees SET merge_state = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(state, id).changes > 0
  )
}

export function setRailWorktreeRunId(db: DbInstance, id: string, runId: string): boolean {
  return (
    db
      .prepare(`UPDATE rail_worktrees SET run_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(runId, id).changes > 0
  )
}

export function listRailWorktrees(db: DbInstance, railIndex?: number): RailWorktreeRow[] {
  if (railIndex === undefined) {
    return db.prepare('SELECT * FROM rail_worktrees ORDER BY rail_index, ticket_id').all() as RailWorktreeRow[]
  }
  return db
    .prepare('SELECT * FROM rail_worktrees WHERE rail_index = ? ORDER BY ticket_id')
    .all(railIndex) as RailWorktreeRow[]
}

/** Non-terminal rows — used at startup to detect worktrees left behind by a dead
 *  process (mark failed + sweep). */
export function listNonTerminalRailWorktrees(db: DbInstance): RailWorktreeRow[] {
  return db
    .prepare(`SELECT * FROM rail_worktrees WHERE merge_state NOT IN ('merged','needs-review','failed','released') ORDER BY rail_index, ticket_id`)
    .all() as RailWorktreeRow[]
}

export function deleteRailWorktree(db: DbInstance, id: string): boolean {
  return db.prepare('DELETE FROM rail_worktrees WHERE id = ?').run(id).changes > 0
}

/** Every rail allocation ever made for a ticket, newest first — the recovery
 *  input for create-pr's pre-flight: when a delivery row records a branch that
 *  no longer exists, any OTHER branch a rail allocated for the same ticket that
 *  still exists with commits ahead of base is the real carrier of the work. */
export function listRailWorktreesForTicket(db: DbInstance, ticketId: number): RailWorktreeRow[] {
  return db
    .prepare('SELECT * FROM rail_worktrees WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(ticketId) as RailWorktreeRow[]
}

/** True when a prior rail allocation for this ticket used exactly this branch —
 *  i.e. an existing branch of that name is OURS to resume (partial work from a
 *  stopped run), not a foreign collision to suffix away from. */
export function railWorktreeBranchExistsForTicket(db: DbInstance, ticketId: number, branch: string): boolean {
  return (
    db.prepare('SELECT 1 FROM rail_worktrees WHERE ticket_id = ? AND branch = ? LIMIT 1').get(ticketId, branch) !==
    undefined
  )
}
