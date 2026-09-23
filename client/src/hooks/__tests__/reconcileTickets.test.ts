import { describe, it, expect } from 'vitest'
import { reconcileTickets } from '../../features/specs/hooks/useTickets'
import type { LocalTicket } from '../../types'

/**
 * Build a minimal-but-valid LocalTicket. Callers override fields per case.
 * reconcileTickets compares via JSON.stringify, so only the fields we set here
 * participate in equality — that's exactly what we want to control.
 */
function makeTicket(id: number, overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id,
    title: `Ticket ${id}`,
    description: `Description ${id}`,
    status: 'todo',
    priority: 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'tester',
    source: 'manual',
    ...overrides,
  } as LocalTicket
}

describe('reconcileTickets', () => {
  it('returns the EXACT SAME prev array reference when nothing changed', () => {
    const prev = [makeTicket(1), makeTicket(2), makeTicket(3)]
    // Fetched is a fresh array with fresh objects of identical content.
    const fetched = [makeTicket(1), makeTicket(2), makeTicket(3)]

    const result = reconcileTickets(prev, fetched)

    expect(Object.is(result, prev)).toBe(true)
  })

  it('returns a NEW array when one ticket changed; uses the fetched object for the changed row and keeps prev refs for unchanged rows', () => {
    const prev = [makeTicket(1), makeTicket(2), makeTicket(3)]
    const changed = makeTicket(2, { title: 'Changed title' })
    const fetched = [makeTicket(1), changed, makeTicket(3)]

    const result = reconcileTickets(prev, fetched)

    // New top-level array.
    expect(Object.is(result, prev)).toBe(false)
    // Changed row is the fetched object (not the prev object).
    expect(Object.is(result[1], changed)).toBe(true)
    expect(Object.is(result[1], prev[1])).toBe(false)
    expect(result[1].title).toBe('Changed title')
    // Unchanged rows keep their prev object references.
    expect(Object.is(result[0], prev[0])).toBe(true)
    expect(Object.is(result[2], prev[2])).toBe(true)
  })

  it('handles a new ticket added: new array containing it, existing unchanged rows keep prev refs', () => {
    const prev = [makeTicket(1), makeTicket(2)]
    const added = makeTicket(3)
    const fetched = [makeTicket(1), makeTicket(2), added]

    const result = reconcileTickets(prev, fetched)

    expect(Object.is(result, prev)).toBe(false)
    expect(result).toHaveLength(3)
    // Added row is the fetched object.
    expect(Object.is(result[2], added)).toBe(true)
    expect(result[2].id).toBe(3)
    // Existing unchanged rows reuse prev references.
    expect(Object.is(result[0], prev[0])).toBe(true)
    expect(Object.is(result[1], prev[1])).toBe(true)
  })

  it('handles a removed ticket: drops it, result follows fetched membership and order', () => {
    const prev = [makeTicket(1), makeTicket(2), makeTicket(3)]
    // Ticket 2 removed.
    const fetched = [makeTicket(1), makeTicket(3)]

    const result = reconcileTickets(prev, fetched)

    expect(Object.is(result, prev)).toBe(false)
    expect(result).toHaveLength(2)
    expect(result.map((t) => t.id)).toEqual([1, 3])
    // Surviving unchanged rows still reuse prev references.
    expect(Object.is(result[0], prev[0])).toBe(true) // id 1 → prev[0]
    expect(Object.is(result[1], prev[2])).toBe(true) // id 3 → prev[2]
  })

  it('handles reorder with same content: result follows fetched order, references reused per id', () => {
    const prev = [makeTicket(1), makeTicket(2), makeTicket(3)]
    // Same content, different order.
    const fetched = [makeTicket(3), makeTicket(1), makeTicket(2)]

    const result = reconcileTickets(prev, fetched)

    // Order differs from prev → a new array.
    expect(Object.is(result, prev)).toBe(false)
    // Result follows fetched order.
    expect(result.map((t) => t.id)).toEqual([3, 1, 2])
    // Each row reuses the matching prev object reference (matched by id).
    expect(Object.is(result[0], prev[2])).toBe(true) // id 3
    expect(Object.is(result[1], prev[0])).toBe(true) // id 1
    expect(Object.is(result[2], prev[1])).toBe(true) // id 2
  })
})
