import { describe, it, expect } from 'vitest'
import { applyWorktreeProgress, clearRailProgress, worktreeSummary } from '../worktree-progress'

describe('applyWorktreeProgress', () => {
  it('records a ticket state immutably', () => {
    const a = applyWorktreeProgress({}, 0, 1, 'merged')
    const b = applyWorktreeProgress(a, 0, 2, 'needs-review')
    expect(b).toEqual({ 0: { 1: 'merged', 2: 'needs-review' } })
    expect(a).toEqual({ 0: { 1: 'merged' } }) // original untouched
  })
  it('keeps rails separate and overwrites a ticket on a newer state', () => {
    let m = applyWorktreeProgress({}, 0, 1, 'building')
    m = applyWorktreeProgress(m, 1, 5, 'merged')
    m = applyWorktreeProgress(m, 0, 1, 'merged')
    expect(m).toEqual({ 0: { 1: 'merged' }, 1: { 5: 'merged' } })
  })
})

describe('clearRailProgress', () => {
  it('drops a rail and is a no-op for an unknown rail', () => {
    const m = applyWorktreeProgress({}, 0, 1, 'merged')
    expect(clearRailProgress(m, 0)).toEqual({})
    expect(clearRailProgress(m, 9)).toBe(m)
  })
})

describe('worktreeSummary', () => {
  it('returns null when nothing reported', () => {
    expect(worktreeSummary(undefined)).toBeNull()
    expect(worktreeSummary({})).toBeNull()
  })
  it('counts merged / needs-review / failed', () => {
    expect(worktreeSummary({ 1: 'merged', 2: 'merged', 3: 'needs-review', 4: 'failed' })).toEqual({
      merged: 2, needsReview: 1, failed: 1, reported: 4,
    })
  })
})
