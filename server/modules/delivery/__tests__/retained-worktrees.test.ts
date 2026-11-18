import { describe, expect, it } from 'vitest'
import {
  RETAINED_WORKTREE_GRACE_MS, escapeRefGlob, evaluateRetainedWorktree, idleDays, parsePorcelainZ,
  type RetainedWorktreeEvidence,
} from '../domain/retained-worktrees'

const NOW = Date.UTC(2026, 10, 18, 12)
const DAY = 24 * 60 * 60 * 1000

function evidence(overrides: Partial<RetainedWorktreeEvidence> & { git?: Partial<RetainedWorktreeEvidence['git']> } = {}): RetainedWorktreeEvidence {
  return {
    kind: 'rail',
    runActive: false,
    delivery: null,
    lastActivityAt: NOW - 3 * DAY,
    ...overrides,
    git: {
      head: 'a'.repeat(40),
      trackedChanges: 0,
      untrackedFiles: 0,
      ignoredAtRisk: [],
      branchExists: true,
      unpushedCommits: 0,
      ...overrides.git,
    },
  }
}

describe('evaluateRetainedWorktree', () => {
  it('says nothing to lose when every fact is known and clean', () => {
    expect(evaluateRetainedWorktree(evidence(), NOW)).toEqual({
      label: 'nothing-to-lose', reasons: [], removable: true, removeBlocker: null, branchDeletable: true,
    })
  })

  it('treats unknown Git evidence as a blocker, never as clean', () => {
    for (const git of [{ head: null }, { trackedChanges: null }, { untrackedFiles: null }, { ignoredAtRisk: null }]) {
      const result = evaluateRetainedWorktree(evidence({ git }), NOW)
      expect(result.removable).toBe(false)
      expect(result.removeBlocker).toBe('git-unknown')
      expect(result.label).toBe('waiting-for-you')
    }
  })

  it('blocks removal for changes and at-risk ignored files, in priority order', () => {
    const result = evaluateRetainedWorktree(evidence({ git: { trackedChanges: 2, ignoredAtRisk: ['.env.local'] } }), NOW)
    expect(result.reasons).toEqual(['uncommitted-changes', 'ignored-files'])
    expect(result.removeBlocker).toBe('uncommitted-changes')
    expect(result.branchDeletable).toBe(false)
  })

  it('lets a clean worktree go while protecting a branch with unique commits', () => {
    const result = evaluateRetainedWorktree(evidence({ git: { unpushedCommits: 3 } }), NOW)
    expect(result).toMatchObject({ label: 'waiting-for-you', reasons: ['unpushed-commits'], removable: true, branchDeletable: false })
  })

  it('does not count commits of a merged delivery as unpushed (squash or rebase merges)', () => {
    const result = evaluateRetainedWorktree(evidence({ delivery: { decision: 'merged', operationActive: false }, git: { unpushedCommits: 3 } }), NOW)
    expect(result.label).toBe('nothing-to-lose')
  })

  it('keeps the branch of an open delivery and blocks a running decision entirely', () => {
    expect(evaluateRetainedWorktree(evidence({ delivery: { decision: 'on_review', operationActive: false } }), NOW))
      .toMatchObject({ reasons: ['open-delivery'], removable: true, branchDeletable: false })
    expect(evaluateRetainedWorktree(evidence({ delivery: { decision: 'pr_ready', operationActive: true } }), NOW).removeBlocker).toBe('run-active')
    expect(evaluateRetainedWorktree(evidence({ delivery: { decision: 'building', operationActive: false } }), NOW).removeBlocker).toBe('run-active')
  })

  it('waits during the grace period after recent activity', () => {
    const result = evaluateRetainedWorktree(evidence({ lastActivityAt: NOW - RETAINED_WORKTREE_GRACE_MS + 1000 }), NOW)
    expect(result.removeBlocker).toBe('recently-active')
    expect(evaluateRetainedWorktree(evidence({ lastActivityAt: NOW - RETAINED_WORKTREE_GRACE_MS }), NOW).removable).toBe(true)
  })

  it('never removes an Intent-owned worktree from here', () => {
    expect(evaluateRetainedWorktree(evidence({ kind: 'intent' }), NOW)).toMatchObject({ removable: false, removeBlocker: 'intent-owned' })
  })

  it('reports an unreadable branch, and a deleted branch as nothing to lose', () => {
    expect(evaluateRetainedWorktree(evidence({ git: { branchExists: null } }), NOW).reasons).toEqual(['branch-unknown'])
    expect(evaluateRetainedWorktree(evidence({ git: { unpushedCommits: null } }), NOW).reasons).toEqual(['branch-unknown'])
    expect(evaluateRetainedWorktree(evidence({ git: { branchExists: false, unpushedCommits: null } }), NOW))
      .toMatchObject({ label: 'nothing-to-lose', branchDeletable: false })
  })
})

describe('parsePorcelainZ', () => {
  it('counts tracked, untracked and ignored entries and skips rename sources', () => {
    expect(parsePorcelainZ(' M a.ts\0R  new.ts\0old.ts\0?? b.ts\0!! .env\0!! dist/\0')).toEqual({ tracked: 2, untracked: 1, ignored: ['.env', 'dist/'] })
    expect(parsePorcelainZ('')).toEqual({ tracked: 0, untracked: 0, ignored: [] })
  })

  it('rejects output Git would never print', () => {
    expect(parsePorcelainZ(' M a.ts')).toBeNull()
    expect(parsePorcelainZ('garbage\0')).toBeNull()
  })
})

describe('helpers', () => {
  it('computes whole idle days and escapes glob characters in branch names', () => {
    expect(idleDays(NOW - 2.5 * DAY, NOW)).toBe(2)
    expect(idleDays(null, NOW)).toBeNull()
    expect(escapeRefGlob('feat/a*b?[c]')).toBe('feat/a\\*b\\?\\[c]')
  })
})
