import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import {
  getRails,
  getRail,
  setRailTickets,
  setRailProfile,
  setRailName,
  createRail,
  deleteRail,
  railCount,
  railExists,
  listRailIndices,
  MAX_RAILS,
  BASE_RAIL_COUNT,
} from './rails-store'

let db: DbInstance

beforeEach(() => {
  db = initDb(':memory:')
})

afterEach(() => {
  db.close()
})

describe('getRails', () => {
  it('returns three empty rails by default', () => {
    const rails = getRails(db)
    expect(rails).toHaveLength(3)
    expect(rails.map((r) => r.railIndex)).toEqual([0, 1, 2])
    for (const r of rails) {
      expect(r.ticketIds).toEqual([])
      expect(r.mode).toBe('implement')
      expect(r.profileName).toBeNull()
    }
  })

  it('returns ticket ids in assigned order', () => {
    setRailTickets(db, 0, [10, 20, 30])
    const rails = getRails(db)
    expect(rails[0].ticketIds).toEqual([10, 20, 30])
    expect(rails[1].ticketIds).toEqual([])
  })
})

describe('getRail', () => {
  it('returns empty state for an unassigned rail', () => {
    const rail = getRail(db, 1)
    expect(rail.railIndex).toBe(1)
    expect(rail.ticketIds).toEqual([])
    expect(rail.mode).toBe('implement')
    expect(rail.profileName).toBeNull()
  })

  it('returns assigned tickets in position order', () => {
    setRailTickets(db, 2, [5, 15, 25], 'batch-implement')
    const rail = getRail(db, 2)
    expect(rail.ticketIds).toEqual([5, 15, 25])
    expect(rail.mode).toBe('batch-implement')
  })
})

describe('setRailTickets', () => {
  it('persists mode', () => {
    setRailTickets(db, 0, [1], 'batch-implement')
    expect(getRail(db, 0).mode).toBe('batch-implement')
  })

  it('defaults mode to implement when omitted', () => {
    setRailTickets(db, 0, [1])
    expect(getRail(db, 0).mode).toBe('implement')
  })

  it('replaces tickets entirely (not additive)', () => {
    setRailTickets(db, 0, [1, 2, 3])
    setRailTickets(db, 0, [4, 5])
    expect(getRail(db, 0).ticketIds).toEqual([4, 5])
  })

  it('clears tickets when called with empty array', () => {
    setRailTickets(db, 0, [1, 2, 3])
    setRailTickets(db, 0, [])
    expect(getRail(db, 0).ticketIds).toEqual([])
  })

  it('persists profileName when provided', () => {
    setRailTickets(db, 0, [1, 2], 'implement', 'data-heavy')
    expect(getRail(db, 0).profileName).toBe('data-heavy')
  })

  it('treats undefined profileName as null (legacy)', () => {
    setRailTickets(db, 0, [1, 2])
    expect(getRail(db, 0).profileName).toBeNull()
  })

  it('persists null profileName explicitly', () => {
    setRailTickets(db, 0, [1, 2], 'implement', null)
    expect(getRail(db, 0).profileName).toBeNull()
  })

  it('isolates rails from each other', () => {
    setRailTickets(db, 0, [1, 2])
    setRailTickets(db, 1, [3, 4])
    setRailTickets(db, 2, [5])
    expect(getRail(db, 0).ticketIds).toEqual([1, 2])
    expect(getRail(db, 1).ticketIds).toEqual([3, 4])
    expect(getRail(db, 2).ticketIds).toEqual([5])
  })

  it('returns the new state', () => {
    const out = setRailTickets(db, 1, [7, 8], 'batch-implement', 'security')
    expect(out.railIndex).toBe(1)
    expect(out.ticketIds).toEqual([7, 8])
    expect(out.mode).toBe('batch-implement')
    expect(out.profileName).toBe('security')
  })
})

describe('setRailProfile', () => {
  it('updates profile when rail has tickets', () => {
    setRailTickets(db, 0, [1, 2], 'implement', null)
    setRailProfile(db, 0, 'data-heavy')
    expect(getRail(db, 0).profileName).toBe('data-heavy')
    // Mode + tickets untouched
    expect(getRail(db, 0).mode).toBe('implement')
    expect(getRail(db, 0).ticketIds).toEqual([1, 2])
  })

  it('resets profile to null', () => {
    setRailTickets(db, 0, [1], 'implement', 'data-heavy')
    setRailProfile(db, 0, null)
    expect(getRail(db, 0).profileName).toBeNull()
  })

  it('returns {ticketIds: [], ...} without persisting when the rail is empty', () => {
    const result = setRailProfile(db, 0, 'data-heavy')
    expect(result.ticketIds).toEqual([])
    // Not persisted (no rows to update)
    expect(getRail(db, 0).profileName).toBeNull()
  })

  it('does not affect other rails', () => {
    setRailTickets(db, 0, [1], 'implement', 'default')
    setRailTickets(db, 1, [2], 'implement', 'default')
    setRailProfile(db, 0, 'data-heavy')
    expect(getRail(db, 0).profileName).toBe('data-heavy')
    expect(getRail(db, 1).profileName).toBe('default')
  })
})

describe('dynamic rails (create / delete / materialize)', () => {
  it('exports a sane cap above the base count', () => {
    expect(BASE_RAIL_COUNT).toBe(3)
    expect(MAX_RAILS).toBeGreaterThan(BASE_RAIL_COUNT)
    expect(MAX_RAILS).toBe(12)
  })

  it('createRail allocates the next free index and lists it in getRails', () => {
    const rail = createRail(db)
    expect(rail.railIndex).toBe(3)
    expect(rail.ticketIds).toEqual([])
    expect(rail.mode).toBe('implement')
    const rails = getRails(db)
    expect(rails).toHaveLength(4)
    expect(rails.map((r) => r.railIndex)).toEqual([0, 1, 2, 3])
  })

  it('createRail persists an optional trimmed name (empty → null)', () => {
    expect(createRail(db, '  Backend  ').name).toBe('Backend')
    expect(getRail(db, 3).name).toBe('Backend')
    expect(createRail(db, '   ').name).toBeNull()
  })

  it('sequential creates allocate 3, 4, 5…', () => {
    expect(createRail(db).railIndex).toBe(3)
    expect(createRail(db).railIndex).toBe(4)
    expect(createRail(db).railIndex).toBe(5)
    expect(railCount(db)).toBe(6)
  })

  it('deleteRail removes the rail; indices stay sparse (never re-numbered)', () => {
    createRail(db) // 3
    createRail(db) // 4
    deleteRail(db, 3)
    expect(railExists(db, 3)).toBe(false)
    expect(getRails(db).map((r) => r.railIndex)).toEqual([0, 1, 2, 4])
  })

  it('createRail refills the lowest free index after a middle deletion', () => {
    createRail(db) // 3
    createRail(db) // 4
    deleteRail(db, 3)
    expect(createRail(db).railIndex).toBe(3) // reuse, not 5
  })

  it('deleteRail also clears any leftover ticket rows for the index', () => {
    createRail(db) // 3
    setRailTickets(db, 3, [7, 8])
    deleteRail(db, 3)
    expect(railExists(db, 3)).toBe(false)
    expect(getRail(db, 3).ticketIds).toEqual([])
  })

  it('deleting a BASE rail is mechanism-allowed (guards live in the router)', () => {
    deleteRail(db, 1)
    expect(getRails(db).map((r) => r.railIndex)).toEqual([0, 2])
  })

  it('setRailTickets on an unknown index MATERIALIZES the rail (survives clearing)', () => {
    // A legacy client-local rail-6 syncs tickets at launch → the rail gains
    // durable server identity, even after its tickets are released.
    setRailTickets(db, 5, [1])
    expect(getRails(db).map((r) => r.railIndex)).toEqual([0, 1, 2, 5])
    setRailTickets(db, 5, [])
    expect(getRails(db).map((r) => r.railIndex)).toEqual([0, 1, 2, 5])
  })

  it('setRailName on an unknown index also materializes it (rail_meta upsert)', () => {
    setRailName(db, 4, 'Named')
    expect(railExists(db, 4)).toBe(true)
    expect(getRails(db).find((r) => r.railIndex === 4)?.name).toBe('Named')
  })

  it('listRailIndices always seeds the base rails', () => {
    expect(listRailIndices(db)).toEqual([0, 1, 2])
    expect(railCount(db)).toBe(3)
    expect(railExists(db, 2)).toBe(true)
    expect(railExists(db, 3)).toBe(false)
  })
})

describe('setRailName', () => {
  it('defaults name to null on a fresh rail', () => {
    expect(getRail(db, 0).name).toBeNull()
    expect(getRails(db).every((r) => r.name === null)).toBe(true)
  })

  it('persists a name independent of ticket assignment (even on an empty rail)', () => {
    setRailName(db, 0, 'Backend')
    expect(getRail(db, 0).name).toBe('Backend')
    // Survives via getRails too
    expect(getRails(db)[0].name).toBe('Backend')
    // The rail still has no tickets — name lives in rail_meta, not the rows.
    expect(getRail(db, 0).ticketIds).toEqual([])
  })

  it('keeps the name across ticket reassignment (delete-then-reinsert)', () => {
    setRailName(db, 1, 'Bugfixes')
    setRailTickets(db, 1, [3, 4])
    setRailTickets(db, 1, [5])
    expect(getRail(db, 1).name).toBe('Bugfixes')
  })

  it('trims whitespace and clears to null on empty/whitespace input', () => {
    setRailName(db, 2, '  Spaced  ')
    expect(getRail(db, 2).name).toBe('Spaced')
    setRailName(db, 2, '   ')
    expect(getRail(db, 2).name).toBeNull()
    setRailName(db, 2, 'Again')
    setRailName(db, 2, null)
    expect(getRail(db, 2).name).toBeNull()
  })

  it('upserts (second call overwrites the first)', () => {
    setRailName(db, 0, 'First')
    setRailName(db, 0, 'Second')
    expect(getRail(db, 0).name).toBe('Second')
  })

  it('isolates names per rail', () => {
    setRailName(db, 0, 'A')
    setRailName(db, 1, 'B')
    expect(getRail(db, 0).name).toBe('A')
    expect(getRail(db, 1).name).toBe('B')
    expect(getRail(db, 2).name).toBeNull()
  })

  it('returns the post-mutation state with the new name', () => {
    setRailTickets(db, 0, [9])
    const out = setRailName(db, 0, 'Named')
    expect(out.name).toBe('Named')
    expect(out.ticketIds).toEqual([9])
  })
})
