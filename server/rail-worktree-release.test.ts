import { describe, expect, it } from 'vitest'
import { initDb } from './db'
import { createRailWorktree, getRailWorktree, updateRailWorktreeState } from './rail-worktrees-store'
import { releaseRailWorktrees } from './rail-worktree-release'
import type { GitRunner } from './worktree-manager'

describe('releaseRailWorktrees', () => {
  it('releases clean durable worktrees once but preserves needs-review recovery data', async () => {
    const db = initDb(':memory:')
    createRailWorktree(db, {
      id: 'clean', railIndex: 0, ticketId: 1, branch: 'feat/clean',
      worktreePath: '/wt/clean', mergeState: 'built',
    })
    createRailWorktree(db, {
      id: 'recoverable', railIndex: 0, ticketId: 2, branch: 'feat/recoverable',
      worktreePath: '/wt/recoverable', mergeState: 'needs-review',
    })
    const calls: string[][] = []
    const git: GitRunner = {
      async run(args) {
        calls.push(args)
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['clean', 'recoverable'],
    })).resolves.toEqual([])

    expect(calls).toEqual([['worktree', 'remove', '--force', '/wt/clean']])
    expect(getRailWorktree(db, 'clean')?.merge_state).toBe('released')
    expect(getRailWorktree(db, 'recoverable')?.merge_state).toBe('needs-review')

    await expect(releaseRailWorktrees({
      db, git, repoDir: '/repo', worktreeIds: ['clean', 'recoverable'],
    })).resolves.toEqual([])
    expect(calls).toEqual([['worktree', 'remove', '--force', '/wt/clean']])
    db.close()
  })

  it('treats a concurrent successful release as idempotent instead of a cleanup warning', async () => {
    const db = initDb(':memory:')
    createRailWorktree(db, {
      id: 'raced', railIndex: 0, ticketId: 1, branch: 'feat/raced',
      worktreePath: '/wt/raced', mergeState: 'built',
    })

    await expect(releaseRailWorktrees({
      db,
      git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      repoDir: '/repo',
      worktreeIds: ['raced'],
      remove: async () => {
        updateRailWorktreeState(db, 'raced', 'released')
        throw new Error('path already removed')
      },
    })).resolves.toEqual([])
    expect(getRailWorktree(db, 'raced')?.merge_state).toBe('released')
    db.close()
  })
})
