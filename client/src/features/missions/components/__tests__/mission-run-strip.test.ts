import { describe, expect, it } from 'vitest'
import {
  deliveryNeedsPerson, deliveryRunTone, heldStripKey, humanizeStepId, missionRunTotals, newlyUrgentKey, pickStripRun,
  type MissionRunCardSummary,
} from '../mission-run-strip'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'

const env = (over: Partial<AgentPrDecisionEnvelope> = {}): AgentPrDecisionEnvelope => ({
  kind: 'pr_decision', prDeliveryId: 'd1', railIndex: 0, projectId: 'p1', baseBranch: 'main', ticketIds: [1],
  decision: 'building', prUrl: null, prNumber: null, prState: 'none', branch: null, runIds: ['r1'], ...over,
})
const card = (over: Partial<MissionRunCardSummary> = {}): MissionRunCardSummary => ({ step: null, paused: false, pausedReason: null, stalled: false, pendingApproval: false, ...over })
const failure = { status: 'failed' as const, currentStep: null, canResume: false, recoverableSteps: [], pendingApproval: false, failure: { code: 'stalled', detail: null, stepId: null }, at: '' }

describe('deliveryRunTone', () => {
  it('building: launching until a step is known, then running; paused, approval and stall win', () => {
    expect(deliveryRunTone(env({ phase: 'launched' }), null)).toBe('launching')
    expect(deliveryRunTone(env({ phase: 'launched' }), card({ step: 'derive' }))).toBe('running')
    expect(deliveryRunTone(env({ phase: 'running' }), card())).toBe('running')
    expect(deliveryRunTone(env(), card({ paused: true }))).toBe('paused')
    expect(deliveryRunTone(env(), card({ pendingApproval: true, paused: true }))).toBe('decision')
    expect(deliveryRunTone(env(), card({ stalled: true }))).toBe('failed')
  })

  it('settled decisions: what needs the person, what failed', () => {
    for (const decision of ['on_review', 'pr_draft', 'no_changes', 'pr_closed'] as const) expect(deliveryRunTone(env({ decision }), null)).toBe('decision')
    expect(deliveryRunTone(env({ decision: 'implementation_failed' }), null)).toBe('failed')
    expect(deliveryRunTone(env({ decision: 'pr_failed' }), null)).toBe('failed')
    // Flow → Spec still needs changes: a decision, not a crash.
    expect(deliveryRunTone(env({ decision: 'implementation_failed', statusCode: 'review_changes_requested' }), null)).toBe('decision')
    expect(deliveryRunTone(env({ decision: 'completed', runtime: failure }), null)).toBe('failed')
  })
})

describe('deliveryNeedsPerson (attention mark)', () => {
  it('only live deliveries that wait for a decision or failed', () => {
    expect(deliveryNeedsPerson(env({ decision: 'on_review' }))).toBe(true)
    expect(deliveryNeedsPerson(env({ decision: 'implementation_failed' }))).toBe(true)
    expect(deliveryNeedsPerson(env({ decision: 'building', phase: 'running' }))).toBe(false)
    expect(deliveryNeedsPerson(env({ decision: 'pr_ready' }))).toBe(false)
    expect(deliveryNeedsPerson(env({ decision: 'discarded', runtime: failure }))).toBe(false)
  })
})

describe('pickStripRun / newlyUrgentKey', () => {
  const runs = [
    { key: 'a', urgency: 'running' as const },
    { key: 'b', urgency: 'paused' as const },
    { key: 'c', urgency: 'failed' as const },
    { key: 'd', urgency: 'decision' as const },
  ]
  it('needs-you › failed › running › paused; ties go to the newest; a live pick holds', () => {
    expect(pickStripRun(runs, null)?.key).toBe('d')
    expect(pickStripRun(runs.slice(0, 3), null)?.key).toBe('c')
    expect(pickStripRun([{ key: 'x', urgency: 'running' }, { key: 'y', urgency: 'running' }], null)?.key).toBe('y')
    expect(pickStripRun(runs, 'b')?.key).toBe('b')
    expect(pickStripRun(runs, 'gone')?.key).toBe('d')
    expect(pickStripRun([], null)).toBeNull()
  })
  it('a run newly waiting for the person (or newly failed) takes over; an unchanged one does not', () => {
    const before = new Map([['a', 'running' as const], ['d', 'decision' as const]])
    expect(newlyUrgentKey(before, [{ key: 'a', urgency: 'failed' }, { key: 'd', urgency: 'decision' }])).toBe('a')
    expect(newlyUrgentKey(before, [{ key: 'a', urgency: 'running' }, { key: 'd', urgency: 'decision' }])).toBeNull()
    expect(newlyUrgentKey(before, [{ key: 'e', urgency: 'decision' }])).toBe('e')
    // Becoming less urgent (decision → failed) is not a takeover.
    expect(newlyUrgentKey(new Map([['d', 'decision' as const]]), [{ key: 'd', urgency: 'failed' }])).toBeNull()
  })
})

describe('missionRunTotals (honest numbers)', () => {
  it('max elapsed, summed billed cost (partial when some runs are unpriced), progress only for several runs', () => {
    const vitals = new Map([
      ['r1', { running: false, loaded: true, status: 'completed', elapsedMs: 60_000, costUsd: 0.5 }],
      ['r2', { running: true, loaded: true, status: 'running', elapsedMs: 90_000, costUsd: null }],
    ])
    expect(missionRunTotals(['r1', 'r2'], vitals)).toEqual({ elapsedMs: 90_000, costUsd: 0.5, costPartial: true, progress: { done: 1, total: 2 } })
    expect(missionRunTotals(['r1'], vitals)).toEqual({ elapsedMs: 60_000, costUsd: 0.5, costPartial: false, progress: null })
    expect(missionRunTotals(['r9'], undefined)).toEqual({ elapsedMs: null, costUsd: null, costPartial: false, progress: null })
  })
})

describe('humanizeStepId', () => {
  it('reads a step id as words', () => {
    expect(humanizeStepId('implement-fix')).toBe('Implement fix')
    expect(humanizeStepId('factory:review_policy')).toBe('Review policy')
  })
})

describe('heldStripKey', () => {
  const live = ['a', 'b', 'c']
  it('is idle (null) when nothing is picked, open or focused', () => {
    expect(heldStripKey(live, { pick: null, open: null, focus: null })).toBeNull()
  })
  it('holds the pick first, then the open panel, then focus', () => {
    expect(heldStripKey(live, { pick: 'b', open: 'c', focus: 'a' })).toBe('b')
    expect(heldStripKey(live, { pick: null, open: 'c', focus: 'a' })).toBe('c')
    expect(heldStripKey(live, { pick: null, open: null, focus: 'a' })).toBe('a')
  })
  it('a hold on a run that left the strip no longer holds', () => {
    expect(heldStripKey(live, { pick: 'gone', open: null, focus: null })).toBeNull()
    expect(heldStripKey(live, { pick: 'gone', open: 'c', focus: null })).toBe('c')
  })
})
