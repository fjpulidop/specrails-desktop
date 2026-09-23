import { describe, it, expect } from 'vitest'
import { insertAt, resolveDestContainer } from '../dashboard-dnd'

const RAIL_SORT_PREFIX = '__rail:'
const isRailSortId = (id: string | number): id is string =>
  typeof id === 'string' && id.startsWith(RAIL_SORT_PREFIX)
const extractRailId = (id: string) => id.slice(RAIL_SORT_PREFIX.length)

describe('insertAt', () => {
  it('inserts before the matching id', () => {
    expect(insertAt([1, 2, 3], 99, 2)).toEqual([1, 99, 2, 3])
  })

  it('appends when beforeId is not in the array', () => {
    expect(insertAt([1, 2, 3], 99, 42)).toEqual([1, 2, 3, 99])
  })

  it('appends when beforeId is a string (container id)', () => {
    expect(insertAt([1, 2, 3], 99, 'rail-1')).toEqual([1, 2, 3, 99])
  })

  it('is a no-op when dropping an item on itself', () => {
    const arr = [1, 2, 3]
    expect(insertAt(arr, 2, 2)).toBe(arr)
  })

  it('does not mutate the input array on insert', () => {
    const arr = [1, 2, 3]
    const out = insertAt(arr, 99, 2)
    expect(arr).toEqual([1, 2, 3])
    expect(out).not.toBe(arr)
  })
})

describe('resolveDestContainer', () => {
  const containerIds = new Set(['specs', 'done-specs', 'rail-1', 'rail-2'])
  const findTicketContainer = (id: number): string | null => {
    if (id === 10) return 'specs'
    if (id === 20) return 'rail-1'
    return null
  }

  it('returns the container id directly when over.id is a known container', () => {
    expect(
      resolveDestContainer('rail-1', containerIds, findTicketContainer, isRailSortId, extractRailId),
    ).toBe('rail-1')
  })

  it('returns specs / done-specs when over those droppables', () => {
    expect(
      resolveDestContainer('specs', containerIds, findTicketContainer, isRailSortId, extractRailId),
    ).toBe('specs')
    expect(
      resolveDestContainer('done-specs', containerIds, findTicketContainer, isRailSortId, extractRailId),
    ).toBe('done-specs')
  })

  it('unwraps a rail-sort prefixed id back to the underlying rail container', () => {
    expect(
      resolveDestContainer('__rail:rail-2', containerIds, findTicketContainer, isRailSortId, extractRailId),
    ).toBe('rail-2')
  })

  it('returns null when the unwrapped rail does not exist anymore', () => {
    expect(
      resolveDestContainer('__rail:rail-deleted', containerIds, findTicketContainer, isRailSortId, extractRailId),
    ).toBeNull()
  })

  it('resolves a numeric ticket id to its owning container', () => {
    expect(
      resolveDestContainer(10, containerIds, findTicketContainer, isRailSortId, extractRailId),
    ).toBe('specs')
    expect(
      resolveDestContainer(20, containerIds, findTicketContainer, isRailSortId, extractRailId),
    ).toBe('rail-1')
  })

  it('returns null for an unknown ticket id', () => {
    expect(
      resolveDestContainer(999, containerIds, findTicketContainer, isRailSortId, extractRailId),
    ).toBeNull()
  })

  it('returns null for an unknown string id', () => {
    expect(
      resolveDestContainer('mystery', containerIds, findTicketContainer, isRailSortId, extractRailId),
    ).toBeNull()
  })
})
