import { describe, it, expect } from 'vitest'
import i18n from '../i18n'
import type { RailPrStateSnapshot } from '../../types'
import {
  REVIEW_WIP_DECISIONS, parseReviewWipLimitInput, pendingReviewFromDecisions, railLaunchAddsReviewWip, readReviewWipRejection,
  reviewWipActionMessage, reviewWipCapacity, reviewWipReached, reviewWipRejectionMessage,
} from '../review-wip'

const t = i18n.t.bind(i18n)
const ALL = ['building', 'on_review', 'no_changes', 'pr_draft', 'pr_ready', 'pr_closed', 'completed', 'merged', 'discarded', 'superseded', 'implementation_failed', 'pr_failed'] as const

function snap(railIndex: number, decision: RailPrStateSnapshot['decision'], createdAt = `2026-10-21 10:0${railIndex}:00`): RailPrStateSnapshot {
  return { prDeliveryId: `d${railIndex}`, railIndex, railKey: `${railIndex}-k`, ticketIds: [railIndex + 10], baseBranch: 'main', branch: null, prUrl: null, prNumber: null, prState: 'none', decision, createdAt } as RailPrStateSnapshot
}

describe('review WIP mirror (review-wip-limit)', () => {
  it('counts exactly the server vocabulary: building, on_review, pr_draft, pr_ready', () => {
    expect([...REVIEW_WIP_DECISIONS].sort()).toEqual(['building', 'on_review', 'pr_draft', 'pr_ready'])
    const decisions = new Map(ALL.map((decision, index) => [index, snap(index, decision)]))
    const pending = pendingReviewFromDecisions(decisions)
    expect(pending.map((p) => p.deliveryId)).toEqual(['d0', 'd1', 'd3', 'd4'])
    expect(pending[0]).toEqual({ deliveryId: 'd0', railIndex: 0, ticketIds: [10], since: '2026-10-21 10:00:00' })
  })

  it('rails with an active delivery never add review work; capacity and reached follow the limit', () => {
    const decisions = new Map([[2, snap(2, 'pr_closed')]])
    expect(railLaunchAddsReviewWip(2, decisions)).toBe(false)
    expect(railLaunchAddsReviewWip(0, decisions)).toBe(true)
    expect(reviewWipReached(null, 99)).toBe(false)
    expect(reviewWipReached(2, 2)).toBe(true)
    expect(reviewWipCapacity(null, 3)).toBe(Number.POSITIVE_INFINITY)
    expect(reviewWipCapacity(5, 3)).toBe(2)
    expect(reviewWipCapacity(2, 4)).toBe(0)
  })

  it('parses only the 409 review_wip_limit_reached body', () => {
    expect(readReviewWipRejection({ error: 'daily_budget_exceeded', limit: 2 })).toBeNull()
    expect(readReviewWipRejection(null)).toBeNull()
    expect(readReviewWipRejection({ error: 'review_wip_limit_reached', limit: 'x' })).toBeNull()
    expect(readReviewWipRejection({ error: 'review_wip_limit_reached', limit: 2, pending: [{ deliveryId: 'a', railIndex: 1, ticketIds: [3, 'x'], since: 's' }, { bogus: true }] }))
      .toEqual({ limit: 2, pending: [{ deliveryId: 'a', railIndex: 1, ticketIds: [3], since: 's' }] })
  })

  it('renders the refusal and the remedy', () => {
    const one = { limit: 1, pending: [{ deliveryId: 'a', railIndex: 0, ticketIds: [1], since: '' }] }
    expect(reviewWipRejectionMessage(t, one)).toBe('Review limit reached: 1 delivery is waiting for review (limit 1). Nothing was launched.')
    expect(reviewWipRejectionMessage(t, { limit: 2, pending: [...one.pending, ...one.pending] })).toContain('2 deliveries are waiting')
    expect(reviewWipActionMessage(t)).toContain('Project settings ▸ Review limit')
  })

  it('validates the settings input', () => {
    expect(parseReviewWipLimitInput('')).toBeNull()
    expect(parseReviewWipLimitInput(' 5 ')).toBe(5)
    for (const bad of ['0', '101', '2.5', '-1', 'abc']) expect(parseReviewWipLimitInput(bad)).toBeUndefined()
  })
})
