import { describe, it, expect } from 'vitest'
import { RAIL_SORT_PREFIX, railSortId, isRailSortId, extractRailId, applyRailJobOutcome, type RailState } from '../RailsBoard'

function rail(overrides: Partial<RailState> = {}): RailState {
  return { id: 'rail-1', label: 'Rail 1', ticketIds: [], mode: 'implement', status: 'idle', ...overrides }
}

describe('RailsBoard utilities', () => {
  describe('railSortId', () => {
    it('prefixes a rail id with RAIL_SORT_PREFIX', () => {
      expect(railSortId('rail-1')).toBe(`${RAIL_SORT_PREFIX}rail-1`)
    })
  })

  describe('isRailSortId', () => {
    it('returns true for strings with the prefix', () => {
      expect(isRailSortId(`${RAIL_SORT_PREFIX}rail-1`)).toBe(true)
    })

    it('returns false for strings without the prefix', () => {
      expect(isRailSortId('rail-1')).toBe(false)
    })

    it('returns false for numbers', () => {
      expect(isRailSortId(42)).toBe(false)
    })
  })

  describe('extractRailId', () => {
    it('strips the prefix from a sort id', () => {
      expect(extractRailId(`${RAIL_SORT_PREFIX}my-rail`)).toBe('my-rail')
    })

    it('returns empty string when sort id equals only the prefix', () => {
      expect(extractRailId(RAIL_SORT_PREFIX)).toBe('')
    })
  })

  describe('applyRailJobOutcome', () => {
    it('returns the rail specs to Specs on a failed run (strips job tickets, resets to idle)', () => {
      const rails = [rail({ ticketIds: [5, 7], status: 'running', activeJobId: 'job-1' })]
      const next = applyRailJobOutcome(rails, 0, [5, 7])
      expect(next[0].ticketIds).toEqual([])
      expect(next[0].status).toBe('idle')
      expect(next[0].activeJobId).toBeUndefined()
    })

    it('strips only this job’s ticket on a partial freestyle rail (others stay)', () => {
      const rails = [rail({ ticketIds: [5, 7, 9], status: 'running' })]
      const next = applyRailJobOutcome(rails, 0, [7])
      expect(next[0].ticketIds).toEqual([5, 9])
    })

    it('clears the whole rail when the message carries no ticket ids', () => {
      const rails = [rail({ ticketIds: [5, 7], status: 'running' })]
      const next = applyRailJobOutcome(rails, 0, [])
      expect(next[0].ticketIds).toEqual([])
    })

    it('only touches the target rail', () => {
      const rails = [
        rail({ id: 'rail-1', ticketIds: [1], status: 'running' }),
        rail({ id: 'rail-2', ticketIds: [2], status: 'running' }),
      ]
      const next = applyRailJobOutcome(rails, 1, [2])
      expect(next[0]).toBe(rails[0]) // untouched reference
      expect(next[1].ticketIds).toEqual([])
    })

    it('removes the completed spec on success (it surfaces in the Done column)', () => {
      const rails = [rail({ ticketIds: [5, 7], status: 'running', activeJobId: 'job-1' })]
      const next = applyRailJobOutcome(rails, 0, [5])
      expect(next[0].ticketIds).toEqual([7])
      expect(next[0].status).toBe('idle')
    })
  })
})
