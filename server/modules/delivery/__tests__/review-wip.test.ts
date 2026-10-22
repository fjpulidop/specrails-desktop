import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb } from '../../../db'
import type { DbInstance } from '../../../db/types'
import {
  REVIEW_WIP_DECISIONS, countPendingReview, evaluateReviewWip, launchAddsReviewWip, listPendingReview, normalizeReviewWipLimit,
  type PrDecision, type ReviewWipDelivery,
} from '..'
import { createPrDelivery, transitionDecision } from '../runtime/rail-pr-store'
import { readReviewWipSnapshot } from '../adapters/review-wip-store'
import { createReviewWipGate } from '../runtime/review-wip-gate'

const ALL_DECISIONS: PrDecision[] = [
  'building', 'on_review', 'no_changes', 'pr_draft', 'pr_ready', 'pr_closed',
  'completed', 'merged', 'discarded', 'superseded', 'implementation_failed', 'pr_failed',
]
const COUNTED = new Set<PrDecision>(['building', 'on_review', 'pr_draft', 'pr_ready'])

function row(id: string, decision: PrDecision, extra: Partial<ReviewWipDelivery> = {}): ReviewWipDelivery {
  return { id, railIndex: 0, ticketIds: [1], decision, parentDeliveryId: null, createdAt: '2026-10-21T10:00:00Z', ...extra }
}

describe('countPendingReview [spec:review-wip-limit/count]', () => {
  it.each(ALL_DECISIONS)('top-level %s counts only when it is review work', (decision) => {
    expect(countPendingReview([row('d', decision)])).toBe(COUNTED.has(decision) ? 1 : 0)
  })

  it('the counted vocabulary is exactly building, on_review, pr_draft and pr_ready', () => {
    expect([...REVIEW_WIP_DECISIONS].sort()).toEqual([...COUNTED].sort())
  })

  it.each(ALL_DECISIONS)('a per-repository child in %s never counts (its group parent does)', (decision) => {
    expect(countPendingReview([row('child', decision, { parentDeliveryId: 'parent' })])).toBe(0)
  })

  it('counts every combination of the full vocabulary across rails, oldest first', () => {
    const rows = ALL_DECISIONS.map((decision, index) => row(`d${index}`, decision, { railIndex: index, createdAt: `2026-10-21T10:${String(59 - index).padStart(2, '0')}:00Z` }))
    const pending = listPendingReview(rows)
    expect(pending.map((item) => item.decision).sort()).toEqual([...COUNTED].sort())
    expect(pending.map((item) => item.since)).toEqual([...pending.map((item) => item.since)].sort())
    const newest = ALL_DECISIONS.indexOf('pr_ready')
    expect(pending[0]).toEqual({ deliveryId: `d${newest}`, railIndex: newest, ticketIds: [1], decision: 'pr_ready', since: expect.any(String) })
  })
})

describe('review WIP admission rule', () => {
  it('normalizes the limit: positive integers only', () => {
    expect(normalizeReviewWipLimit(5)).toBe(5)
    for (const bad of [0, -1, 1.5, Number.NaN, '5', null, undefined]) expect(normalizeReviewWipLimit(bad)).toBeNull()
  })

  it('continuations add no review work; a fresh launch does', () => {
    expect(launchAddsReviewWip({})).toBe(true)
    expect(launchAddsReviewWip({ revisionOfDeliveryId: 'd1' })).toBe(false)
    expect(launchAddsReviewWip({ relaunchOfDelivery: true })).toBe(false)
    expect(launchAddsReviewWip({ targetsExistingPr: true })).toBe(false)
    expect(launchAddsReviewWip({ railHasActiveDelivery: true })).toBe(false)
  })

  it('rejects only a new delivery at or over the limit', () => {
    const pending = listPendingReview([row('a', 'on_review'), row('b', 'pr_draft', { railIndex: 1 })])
    expect(evaluateReviewWip({ limit: null, pending, addsWip: true })).toBeNull()
    expect(evaluateReviewWip({ limit: 3, pending, addsWip: true })).toBeNull()
    expect(evaluateReviewWip({ limit: 3, pending, reserved: 1, addsWip: true })?.error).toBe('review_wip_limit_reached')
    expect(evaluateReviewWip({ limit: 2, pending, addsWip: false })).toBeNull()
    const rejection = evaluateReviewWip({ limit: 2, pending, addsWip: true })
    expect(rejection).toMatchObject({ error: 'review_wip_limit_reached', limit: 2, pending: [{ deliveryId: 'a' }, { deliveryId: 'b' }] })
    expect(Object.keys(rejection!.pending[0]).sort()).toEqual(['deliveryId', 'railIndex', 'since', 'ticketIds'])
  })
})

describe('review WIP SQLite snapshot and gate', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  function seed(railIndex: number, ticketIds: number[]): string {
    return createPrDelivery(db, {
      railIndex, loopId: 'factory:implement', railKey: `${railIndex}-implement`, ticketIds, baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard',
    }).id
  }

  it('reads top-level counted rows with ISO timestamps from one connection', () => {
    const building = seed(0, [1])
    const reviewed = seed(1, [2, 3])
    transitionDecision(db, reviewed, 'building', 'on_review', { implementationOutcome: 'succeeded', deliveryOutcome: 'ready', statusCode: 'ready_for_review' })
    const dropped = seed(2, [4])
    transitionDecision(db, dropped, 'building', 'implementation_failed', { implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: 'implementation_failed' })
    const child = seed(5, [2])
    db.prepare('UPDATE rail_pr_deliveries SET parent_delivery_id = ? WHERE id = ?').run(reviewed, child)
    const snapshot = readReviewWipSnapshot(db)
    expect(snapshot.map((r) => [r.id, r.decision, r.ticketIds])).toEqual([[building, 'building', [1]], [reviewed, 'on_review', [2, 3]]])
    expect(snapshot[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('gate: no limit admits, a limit rejects, continuations pass, release frees the reservation', () => {
    let limit: number | null = null
    const gate = createReviewWipGate({ db, readLimit: () => limit })
    seed(0, [1])
    expect(gate.admit(1, {}).ok).toBe(true)
    limit = 1
    expect(gate.status()).toMatchObject({ limit: 1, pending: [{ railIndex: 0 }], reserved: 0 })
    const refused = gate.admit(1, {})
    expect(refused.ok).toBe(false)
    expect(gate.admit(0, { railHasActiveDelivery: true }).ok).toBe(true)
    limit = 2
    const first = gate.admit(1, {})
    expect(first.ok).toBe(true)
    expect(gate.status().reserved).toBe(1)
    expect(gate.admit(2, {}).ok).toBe(false)
    if (first.ok) { first.release(); first.release() }
    expect(gate.status().reserved).toBe(0)
    expect(gate.admit(2, {}).ok).toBe(true)
  })

  it('gate: a reservation whose delivery row already exists is not counted twice', () => {
    const gate = createReviewWipGate({ db, readLimit: () => 2 })
    const admitted = gate.admit(3, {})
    expect(admitted.ok).toBe(true)
    seed(3, [9])
    expect(gate.status()).toMatchObject({ reserved: 0, pending: [{ railIndex: 3 }] })
    expect(gate.admit(4, {}).ok).toBe(true)
  })

  it('gate fails open when the state cannot be read', () => {
    const gate = createReviewWipGate({ db, readLimit: () => { throw new Error('closed') } })
    expect(gate.admit(0, {}).ok).toBe(true)
    expect(gate.status()).toMatchObject({ limit: null, pending: [] })
  })
})
