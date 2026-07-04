import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import {
  createRailWorktree,
  getRailWorktree,
  railWorktreeBranchExistsForTicket,
  updateRailWorktreeState,
  setRailWorktreeRunId,
  listRailWorktrees,
  listRailWorktreesForTicket,
  listNonTerminalRailWorktrees,
  deleteRailWorktree,
  isTerminalMergeState,
} from './rail-worktrees-store'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

const mk = (id: string, railIndex: number, ticketId: number) =>
  createRailWorktree(db, { id, railIndex, ticketId, branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` })

describe('rail_worktrees ledger', () => {
  it('creates and reads a row with defaults', () => {
    const row = mk('a', 0, 1)
    expect(row).toMatchObject({ id: 'a', rail_index: 0, ticket_id: 1, branch: 'sr/p/ticket-1', merge_state: 'building', run_id: null, overlay_path: null })
    expect(getRailWorktree(db, 'a')?.merge_state).toBe('building')
  })

  it('updates merge state and run id', () => {
    mk('a', 0, 1)
    expect(updateRailWorktreeState(db, 'a', 'merged')).toBe(true)
    expect(getRailWorktree(db, 'a')?.merge_state).toBe('merged')
    expect(setRailWorktreeRunId(db, 'a', 'run-9')).toBe(true)
    expect(getRailWorktree(db, 'a')?.run_id).toBe('run-9')
  })

  it('lists by rail and overall', () => {
    mk('a', 0, 2); mk('b', 0, 1); mk('c', 1, 5)
    expect(listRailWorktrees(db, 0).map((r) => r.ticket_id)).toEqual([1, 2])
    expect(listRailWorktrees(db).map((r) => r.id)).toEqual(['b', 'a', 'c'])
  })

  it('finds non-terminal rows for reconciliation', () => {
    mk('a', 0, 1); mk('b', 0, 2); mk('c', 0, 3)
    updateRailWorktreeState(db, 'a', 'merged')
    updateRailWorktreeState(db, 'b', 'merging')
    // c stays 'building'
    expect(listNonTerminalRailWorktrees(db).map((r) => r.id).sort()).toEqual(['b', 'c'])
  })

  it('classifies terminal states', () => {
    expect(isTerminalMergeState('merged')).toBe(true)
    expect(isTerminalMergeState('needs-review')).toBe(true)
    expect(isTerminalMergeState('failed')).toBe(true)
    expect(isTerminalMergeState('building')).toBe(false)
    expect(isTerminalMergeState('merging')).toBe(false)
  })

  it('deletes a row', () => {
    mk('a', 0, 1)
    expect(deleteRailWorktree(db, 'a')).toBe(true)
    expect(getRailWorktree(db, 'a')).toBeUndefined()
  })

  it('listRailWorktreesForTicket returns ONLY the ticket rows, newest first (recovery scan order)', () => {
    // Insertion order: oldest first — created_at ties (same second) resolve by rowid DESC.
    createRailWorktree(db, { id: 'old', railIndex: 0, ticketId: 7, branch: 'sr/p/ticket-7', worktreePath: '/wt/ticket-7', mergeState: 'failed' })
    createRailWorktree(db, { id: 'new', railIndex: 1, ticketId: 7, branch: 'feat/7-add-x', worktreePath: '/wt/ticket-7', mergeState: 'built' })
    createRailWorktree(db, { id: 'other', railIndex: 0, ticketId: 8, branch: 'feat/8-y', worktreePath: '/wt/ticket-8' })
    expect(listRailWorktreesForTicket(db, 7).map((r) => r.id)).toEqual(['new', 'old'])
    expect(listRailWorktreesForTicket(db, 9)).toEqual([])
  })

  it('railWorktreeBranchExistsForTicket matches only the exact (ticket, branch) pair', () => {
    createRailWorktree(db, { id: 'x', railIndex: 0, ticketId: 7, branch: 'feat/7-add-x', worktreePath: '/wt/7' })
    expect(railWorktreeBranchExistsForTicket(db, 7, 'feat/7-add-x')).toBe(true)
    expect(railWorktreeBranchExistsForTicket(db, 7, 'feat/7-add-x-2')).toBe(false)
    expect(railWorktreeBranchExistsForTicket(db, 8, 'feat/7-add-x')).toBe(false)
  })
})
