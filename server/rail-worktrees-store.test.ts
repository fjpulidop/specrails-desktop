import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import {
  createRailWorktree,
  getRailWorktree,
  updateRailWorktreeState,
  setRailWorktreeRunId,
  listRailWorktrees,
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
})
