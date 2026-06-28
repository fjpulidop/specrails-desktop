/**
 * CRUD for the `rail_worktrees` ledger (migration 35) — one row per (rail launch,
 * ticket) tracking the worktree/branch/overlay and its merge state, so the engine
 * can reconcile orphaned worktrees after a crash and the UI can render integration
 * progress. Pure data access; the worktree/merge plumbing lives in
 * worktree-manager / merge-manager.
 */
import type { DbInstance } from './db'

/** building → built → merging → {merged | needs-review | failed}. */
export type MergeState = 'building' | 'built' | 'merging' | 'merged' | 'needs-review' | 'failed'

/** States after which the worktree is done (eligible for cleanup/reconciliation). */
export const TERMINAL_MERGE_STATES: ReadonlySet<MergeState> = new Set(['merged', 'needs-review', 'failed'])

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
    .prepare(`SELECT * FROM rail_worktrees WHERE merge_state NOT IN ('merged','needs-review','failed') ORDER BY rail_index, ticket_id`)
    .all() as RailWorktreeRow[]
}

export function deleteRailWorktree(db: DbInstance, id: string): boolean {
  return db.prepare('DELETE FROM rail_worktrees WHERE id = ?').run(id).changes > 0
}
