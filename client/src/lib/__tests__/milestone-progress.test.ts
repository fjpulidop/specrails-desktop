import { describe, it, expect } from 'vitest'
import {
  coerceChain,
  coerceMilestoneProgress,
  chainIsLive,
  chainPauseReason,
  deliveredCount,
  isMilestoneLaunchable,
  progressSegments,
  reviewableDelivery,
  stackedHeadDeliveryIds,
  milestoneLabelFor,
  type MilestoneProgress,
  chainAtCheckpoint,
} from '../milestone-progress'

function m(over: Partial<MilestoneProgress> = {}): MilestoneProgress {
  return {
    id: 'm1', n: 1, title: 'Skeleton', storedStatus: 'committed', state: 'committed',
    counts: { total: 8, done: 0, onReview: 0, inProgress: 0, todo: 8, failed: 0 }, rails: [], chain: null, ...over,
  }
}

describe('milestone-progress (client model)', () => {
  it('progressSegments carves failed out of todo and skips zero segments', () => {
    const segs = progressSegments({ total: 8, done: 2, onReview: 3, inProgress: 1, todo: 2, failed: 1 })
    expect(segs.map((s) => [s.key, s.count])).toEqual([['done', 2], ['onReview', 3], ['inProgress', 1], ['failed', 1], ['todo', 1]])
    expect(segs.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100, 0)
    expect(progressSegments({ total: 0, done: 0, onReview: 0, inProgress: 0, todo: 0, failed: 0 })).toEqual([])
    expect(deliveredCount({ total: 8, done: 2, onReview: 3, inProgress: 1, todo: 2, failed: 0 })).toBe(5)
  })

  it('launchable = pending specs and no live/paused chain', () => {
    expect(isMilestoneLaunchable(m())).toBe(true)
    expect(isMilestoneLaunchable(m({ counts: { total: 3, done: 3, onReview: 0, inProgress: 0, todo: 0, failed: 0 } }))).toBe(false)
    const chain = { id: 'c', milestoneN: 1, mode: 'sequential' as const, status: 'waiting' as const, pauseReason: null, nextChunk: 1, totalChunks: 3, currentRailIndex: null, headBranch: null, launched: [], updatedAt: '' }
    expect(isMilestoneLaunchable(m({ chain }))).toBe(false)
    expect(chainIsLive(chain)).toBe(true)
    expect(isMilestoneLaunchable(m({ chain: { ...chain, status: 'paused' } }))).toBe(false)
    expect(isMilestoneLaunchable(m({ chain: { ...chain, status: 'completed' } }))).toBe(true)
    expect(isMilestoneLaunchable(m({ chain: { ...chain, status: 'cancelled' } }))).toBe(true)
  })

  it('a chain at a wave checkpoint is not launchable and coerces autoAdvance (default on, explicit false kept)', () => {
    const base = { id: 'm1', n: 1, title: 't', storedStatus: 'committed' as const, state: 'delivered' as const, counts: { total: 8, done: 0, onReview: 3, inProgress: 0, todo: 5, failed: 0 }, rails: [] }
    const chain = coerceChain({ id: 'c1', milestoneN: 1, mode: 'sequential', status: 'awaiting_approval', pauseReason: null, nextChunk: 1, totalChunks: 3, currentRailIndex: null, headBranch: 'feat/1', launched: [], updatedAt: 'x', autoAdvance: false })!
    expect(chain).toMatchObject({ status: 'awaiting_approval', autoAdvance: false })
    expect(chainAtCheckpoint(chain)).toBe(true)
    expect(chainIsLive(chain)).toBe(false)
    expect(isMilestoneLaunchable({ ...base, chain })).toBe(false)
    expect(coerceChain({ id: 'c2', status: 'running' })!.autoAdvance).toBe(true)
  })

  it('stackedHeadDeliveryIds lists every launched delivery a LATER chunk was built on', () => {
    const chain = {
      id: 'c', milestoneN: 1, mode: 'sequential' as const, status: 'running' as const, pauseReason: null, nextChunk: 3, totalChunks: 3, currentRailIndex: 5, headBranch: 'b', updatedAt: '',
      launched: [
        { chunk: 2, railIndex: 4, ticketIds: [4], runIds: [], deliveryId: 'd2' },
        { chunk: 1, railIndex: 3, ticketIds: [1], runIds: [], deliveryId: 'd1' },
        { chunk: 3, railIndex: 5, ticketIds: [7], runIds: [], deliveryId: 'd3' },
      ],
    }
    expect([...stackedHeadDeliveryIds([m({ chain })])].sort()).toEqual(['d1', 'd2'])
    expect(stackedHeadDeliveryIds([m({ chain: { ...chain, mode: 'parallel' } })]).size).toBe(0)
    expect(stackedHeadDeliveryIds([m()]).size).toBe(0)
  })

  it('chainPauseReason splits launch_rejected:<detail>', () => {
    expect(chainPauseReason('launch_rejected:rail_limit_reached')).toEqual({ key: 'launch_rejected', detail: 'rail_limit_reached' })
    expect(chainPauseReason('chunk_failed')).toEqual({ key: 'chunk_failed', detail: '' })
    expect(chainPauseReason(null)).toEqual({ key: 'unknown', detail: '' })
  })

  it('reviewableDelivery prefers on_review, then any reviewable decision', () => {
    const rail = (id: string, decision: string) => ({ railIndex: 1, name: null, ticketIds: [1], active: false, runId: null, startedAt: null, chunkIndex: null, delivery: { id, railIndex: 1, ticketIds: [1], decision, branch: null, baseBranch: 'main', prUrl: null, prNumber: null, prState: 'none', createdAt: null } })
    expect(reviewableDelivery(m({ rails: [rail('a', 'pr_draft'), rail('b', 'on_review')] }))?.id).toBe('b')
    expect(reviewableDelivery(m({ rails: [rail('a', 'pr_draft')] }))?.id).toBe('a')
    expect(reviewableDelivery(m({ rails: [rail('a', 'building')] }))).toBeNull()
    expect(milestoneLabelFor(3)).toBe('M3')
  })

  it('coerceMilestoneProgress is defensive: drops malformed entries, defaults fields', () => {
    const parsed = coerceMilestoneProgress([
      { id: 'm1', n: 1, title: 'A', storedStatus: 'committed', state: 'delivered', counts: { total: 2, onReview: 2 }, rails: [{ railIndex: 3, active: true, runId: 'r', startedAt: 'x', delivery: { id: 'd', decision: 'building' }, chunkIndex: 1 }, { nope: true }], chain: { id: 'c', status: 'weird' } },
      { id: 'm2', n: 'two' },
      null,
      { id: 'm3', n: 3, state: 'bogus', storedStatus: 'x' },
    ])
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ id: 'm1', state: 'delivered', counts: { total: 2, onReview: 2, done: 0, todo: 0, inProgress: 0, failed: 0 } })
    expect(parsed[0].rails).toHaveLength(1)
    expect(parsed[0].rails[0]).toMatchObject({ railIndex: 3, active: true, runId: 'r', chunkIndex: 1 })
    expect(parsed[0].rails[0].delivery).toMatchObject({ id: 'd', decision: 'building', prState: 'none' })
    expect(parsed[0].chain).toBeNull()
    expect(parsed[1]).toMatchObject({ id: 'm3', state: 'planned', storedStatus: 'planned' })
    expect(coerceMilestoneProgress('x')).toEqual([])
  })

  it('coerceChain keeps only well-formed launched entries', () => {
    const chain = coerceChain({ id: 'c', milestoneN: 1, mode: 'parallel', status: 'paused', pauseReason: 'chunk_failed', nextChunk: 1, totalChunks: 2, currentRailIndex: 2, headBranch: 'feat/1', launched: [{ chunk: 1, railIndex: 2, ticketIds: [1, 'x'], runIds: ['r', 2], deliveryId: 'd' }, { chunk: 'no' }], updatedAt: 'now' })
    expect(chain).toMatchObject({ id: 'c', mode: 'parallel', status: 'paused', pauseReason: 'chunk_failed', totalChunks: 2, headBranch: 'feat/1' })
    expect(chain?.launched).toEqual([{ chunk: 1, railIndex: 2, ticketIds: [1], runIds: ['r'], deliveryId: 'd' }])
    expect(coerceChain(null)).toBeNull()
    expect(coerceChain({ id: 'c', status: 'nope' })).toBeNull()
  })
})
