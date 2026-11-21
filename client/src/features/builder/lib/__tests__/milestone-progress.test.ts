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
  chainHeldRail,
  railElapsedMs,
  railHoldAction,
  railHoldKey,
} from '../milestone-progress'

function m(over: Partial<MilestoneProgress> = {}): MilestoneProgress {
  return {
    id: 'm1', n: 1, title: 'Skeleton', storedStatus: 'committed', state: 'committed',
    counts: { total: 8, done: 0, onReview: 0, inProgress: 0, todo: 8, failed: 0 }, rails: [], chain: null, ...over,
  }
}

describe('milestone-progress (client model)', () => {
  it.each([
    ['2026-09-04T10:00:00.000Z', '2026-09-04T10:00:00.000Z'],
    [undefined, null], [null, null], ['', null], ['invalid', null], [42, null],
  ])('normalizes chain creation time %s without losing chain data', (createdAt, expected) => {
    const raw = { id: 'c1', status: 'running', milestoneN: 1, nextChunk: 2, totalChunks: 3, updatedAt: 'later', createdAt }
    const parsed = coerceChain(raw)!
    expect(parsed).toMatchObject({ id: 'c1', status: 'running', milestoneN: 1, nextChunk: 2, totalChunks: 3, updatedAt: 'later', createdAt: expected })
    expect(coerceMilestoneProgress([{ ...m(), chain: raw }])[0].chain).toEqual(parsed)
    expect(parsed).toEqual({ ...coerceChain({ ...raw, createdAt: undefined }), createdAt: expected })
  })

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
    const chain = { id: 'c', milestoneN: 1, mode: 'sequential' as const, autoAdvance: true, status: 'waiting' as const, pauseReason: null, nextChunk: 1, totalChunks: 3, currentRailIndex: null, headBranch: null, launched: [], createdAt: null, updatedAt: '' }
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
      id: 'c', milestoneN: 1, mode: 'sequential' as const, autoAdvance: true, status: 'running' as const, pauseReason: null, nextChunk: 3, totalChunks: 3, currentRailIndex: 5, headBranch: 'b', createdAt: null, updatedAt: '',
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

describe('coerceChainPlan / primaryChainOffer', () => {
  it('keeps known offers in order, defaults `from`, drops malformed entries', async () => {
    const { coerceChain, primaryChainOffer, chainOfferKey, chainOfferParams } = await import('../milestone-progress')
    const chain = coerceChain({
      id: 'c1', status: 'paused', launched: [],
      plan: {
        offers: [
          { kind: 'resume_failed_step', from: 'failed_step', ticketId: 6, title: 'Add the offline computer opponent', runId: 'fork-1' },
          { kind: 'retry_from_start', from: 'start', ticketId: 6 },
          { kind: 'bogus', ticketId: 1 },
          { kind: 'next', from: 'weird', ticketId: 7 },
        ],
        specs: [{ ticketId: 6, state: 'failed', title: null }, { ticketId: 7, state: 'nope' }],
        settled: 2, total: 5, pausedTicketId: 6, pausedSpecSettled: false,
      },
    })!
    expect(chain.plan!.offers.map((o) => [o.kind, o.from])).toEqual([['resume_failed_step', 'failed_step'], ['retry_from_start', 'start'], ['next', 'recommended']])
    expect(chain.plan!.specs).toEqual([{ ticketId: 6, state: 'failed', title: null }])
    const primary = primaryChainOffer(chain)!
    expect(chainOfferKey(primary)).toBe('resume_failed_step:6:fork-1')
    expect(chainOfferParams(primary, chain.plan)).toMatchObject({ spec: '#6', specTitle: '#6 Add the offline computer opponent', paused: '#6' })
    expect(coerceChain({ id: 'c2', status: 'running' })!.plan).toBeNull()
    expect(primaryChainOffer(null)).toBeNull()
  })
})

describe('held rails', () => {
  const started = '2026-11-21T14:52:45.000Z'
  it('coerces a rail hold (only on an active rail) and keeps byYou only for a pause', () => {
    const [m] = coerceMilestoneProgress([{ id: 'm1', n: 1, rails: [
      { railIndex: 3, active: true, runId: 'r', startedAt: started, hold: { kind: 'paused', since: '2026-11-21T15:00:11.000Z', byYou: true, step: 'developer' } },
      { railIndex: 4, active: true, runId: 'q', hold: { kind: 'question', since: 'nope', byYou: true } },
      { railIndex: 5, active: true, runId: 'w', hold: { kind: 'bogus' } },
      { railIndex: 6, active: false, hold: { kind: 'paused' } },
    ] }])
    expect(m.rails.map((r) => r.hold)).toEqual([
      { kind: 'paused', since: '2026-11-21T15:00:11.000Z', byYou: true },
      { kind: 'question', since: null },
      null,
      null,
    ])
  })

  it('keys, actions and the frozen elapsed', () => {
    expect(railHoldKey({ kind: 'paused', since: null, byYou: true })).toBe('pausedByYou')
    expect(railHoldKey({ kind: 'paused', since: null })).toBe('paused')
    expect(railHoldAction({ kind: 'paused', since: null, byYou: true })).toBe('resume')
    expect(railHoldAction({ kind: 'question', since: null })).toBe('answer')
    expect(railHoldAction({ kind: 'provider_limit', since: null })).toBeNull()
    const now = Date.parse(started) + 3_600_000
    expect(railElapsedMs({ active: true, startedAt: started, hold: null }, now)).toBe(3_600_000)
    expect(railElapsedMs({ active: true, startedAt: started, hold: { kind: 'paused', since: '2026-11-21T15:00:11.000Z', byYou: true } }, now)).toBe(446_000)
    expect(railElapsedMs({ active: true, startedAt: started, hold: { kind: 'paused', since: null } }, now)).toBeNull()
  })

  it('chainHeldRail finds the held rail a live chain waits on, falling back to the plan', () => {
    const chain = coerceChain({ id: 'c', status: 'running', nextChunk: 3, totalChunks: 5, plan: { action: { kind: 'resume_run', ticketId: 7, runId: 'r', pauseKind: 'user' }, offers: [], specs: [] } })!
    const rail = { railIndex: 3, name: null, ticketIds: [7], active: true, runId: 'r', startedAt: started, delivery: null, chunkIndex: 3, hold: { kind: 'question' as const, since: null } }
    expect(chainHeldRail(chain, [rail])).toMatchObject({ key: 'question', runId: 'r', chunk: 3 })
    expect(chainHeldRail(chain, [])).toMatchObject({ key: 'pausedByYou', rail: null, chunk: 3 })
    expect(chainHeldRail({ ...chain, plan: { ...chain.plan!, action: { kind: 'adopt_run', ticketId: 7, runId: 'r', pauseKind: null } } }, [{ ...rail, hold: null }])).toBeNull()
    expect(chainHeldRail({ ...chain, status: 'paused' }, [rail])).toBeNull()
  })
})
