import { describe, it, expect } from 'vitest'
import { planBulkLaunch, type BulkLaunchGates } from '../bulk-launch'

const rails = [
  { id: 'rail-1', status: 'idle', ticketIds: [] as number[] },
  { id: 'rail-2', status: 'running', ticketIds: [] as number[] },
  { id: 'rail-3', status: 'idle', ticketIds: [7] },
  { id: 'rail-4', status: 'idle', ticketIds: [] as number[] },
  { id: 'rail-5', status: 'idle', ticketIds: [] as number[] },
]

function gates(overrides: Partial<BulkLaunchGates> = {}): BulkLaunchGates {
  return { blockerOf: () => null, hasPendingDecision: () => false, takesReviewSlot: () => true, reviewCapacity: Number.POSITIVE_INFINITY, ...overrides }
}

describe('planBulkLaunch', () => {
  it('gives each spec its own free rail (idle, empty, no pending decision), in selection order', () => {
    const plan = planBulkLaunch([10, 11, 12], rails, gates({ hasPendingDecision: (id) => id === 'rail-4' }))
    expect(plan.assignments).toEqual([{ railId: 'rail-1', ticketId: 10 }, { railId: 'rail-5', ticketId: 11 }])
    expect(plan.skipped).toEqual([{ ticketId: 12, reason: 'noRail' }])
  })

  it('skips specs the launch gates block, without spending a rail on them', () => {
    const plan = planBulkLaunch([10, 11], rails, gates({ blockerOf: (id) => (id === 10 ? 'On review' : null) }))
    expect(plan.skipped).toEqual([{ ticketId: 10, reason: 'blocked' }])
    expect(plan.assignments).toEqual([{ railId: 'rail-1', ticketId: 11 }])
  })

  it('holds specs beyond the review WIP capacity, but not rails that continue a delivery', () => {
    const limited = planBulkLaunch([10, 11, 12], rails, gates({ reviewCapacity: 1 }))
    expect(limited.assignments).toHaveLength(1)
    expect(limited.skipped).toEqual([{ ticketId: 11, reason: 'reviewLimit' }, { ticketId: 12, reason: 'reviewLimit' }])
    const free = planBulkLaunch([10, 11], rails, gates({ reviewCapacity: 0, takesReviewSlot: () => false }))
    expect(free.assignments).toHaveLength(2)
  })

  it('plans nothing when no rail is free', () => {
    const plan = planBulkLaunch([10], [{ id: 'r', status: 'running', ticketIds: [] }], gates())
    expect(plan.assignments).toEqual([])
    expect(plan.skipped).toEqual([{ ticketId: 10, reason: 'noRail' }])
  })
})
