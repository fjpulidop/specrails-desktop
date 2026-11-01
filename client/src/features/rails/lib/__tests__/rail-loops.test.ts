import { describe, it, expect } from 'vitest'
import { factoryIdForMode, deriveRailMode, effectiveLoopId, adoptedSelectedLoopId, offeredRecommendation, migratedRailLoopId, isRetiredRailLoopId, RETIRED_RAIL_LOOP_IDS, FACTORY_LOOP_ID, FACTORY_RAIL_LOOPS } from '../rail-loops'

describe('rail-loops helpers', () => {
  it('maps each legacy mode to its factory loop id', () => {
    expect(factoryIdForMode('implement')).toBe('factory:implement')
    expect(factoryIdForMode('loop')).toBe('') // custom loops have no factory id
    expect(FACTORY_LOOP_ID.implement).toBe('factory:implement')
  })

  it('derives the legacy mode from a chosen loop id', () => {
    expect(deriveRailMode('factory:implement')).toBe('implement')
    // Removed Batch loop: saved selections run as Implement.
    expect(deriveRailMode('factory:batch')).toBe('implement')
    // Retired built-ins (Freestyle, Quick SDD and its aliases) fall back to Implement.
    for (const id of RETIRED_RAIL_LOOP_IDS) expect(deriveRailMode(id), id).toBe('implement')
    expect(deriveRailMode('some-custom-id')).toBe('loop')
    expect(deriveRailMode(null)).toBe('loop')
  })

  it('defaults addenda to Implement while preserving explicit selections', () => {
    expect(effectiveLoopId('factory:implement', 'implement', true)).toBe('factory:implement')
    expect(effectiveLoopId(null, 'implement', true)).toBe('factory:implement')
    expect(effectiveLoopId(null, 'loop', true)).toBe('factory:implement')
    expect(effectiveLoopId('custom', 'loop', true)).toBe('custom')
    expect(effectiveLoopId('factory:revision', 'loop')).toBe('factory:implement')
  })

  it('reads a persisted pick on a retired built-in as Implement and leaves everything else alone', () => {
    for (const id of RETIRED_RAIL_LOOP_IDS) {
      expect(isRetiredRailLoopId(id), id).toBe(true)
      expect(migratedRailLoopId(id), id).toBe('factory:implement')
      expect(effectiveLoopId(id, 'loop'), id).toBe('factory:implement')
    }
    expect(migratedRailLoopId('factory:batch')).toBe('factory:implement')
    expect(migratedRailLoopId('factory:implement')).toBe('factory:implement')
    expect(migratedRailLoopId('3f2a9c1e')).toBe('3f2a9c1e')
    expect(migratedRailLoopId(null)).toBeNull()
    expect(migratedRailLoopId(undefined)).toBeUndefined()
    expect(isRetiredRailLoopId('factory:implement')).toBe(false)
    expect(isRetiredRailLoopId(null)).toBe(false)
  })

  it('round-trips mode → factory id → mode', () => {
    expect(deriveRailMode(factoryIdForMode('implement'))).toBe('implement')
  })

  it('effectiveLoopId prefers the explicit pick, else the factory id for the mode', () => {
    expect(effectiveLoopId('custom-x', 'loop')).toBe('custom-x')
    expect(effectiveLoopId(null, 'implement')).toBe('factory:implement')
    expect(effectiveLoopId('', 'loop')).toBe('') // custom mode + no pick → empty (blocks launch)
    expect(effectiveLoopId('factory:batch', 'implement')).toBe('factory:implement') // removed Batch loop
  })

  it('exposes Implement as the only built-in rail loop', () => {
    expect(FACTORY_RAIL_LOOPS.map((f) => f.id)).toEqual(['factory:implement'])
  })
})

describe('adoptedSelectedLoopId', () => {
  it('adopts real user loop ids (uuids), never built-in ids', () => {
    expect(adoptedSelectedLoopId('3f2a9c1e-8b7d-4e6f-a5c4-1b2d3e4f5a6b')).toBe('3f2a9c1e-8b7d-4e6f-a5c4-1b2d3e4f5a6b')
    expect(adoptedSelectedLoopId('factory:implement')).toBeUndefined()
    expect(adoptedSelectedLoopId(undefined)).toBeUndefined()
    expect(adoptedSelectedLoopId('')).toBeUndefined()
  })
})

describe('spec triage recommendation (launch-triage)', () => {
  it('is the fallback after an explicit pick, only on the default mode and after addenda', () => {
    expect(effectiveLoopId(undefined, 'implement', false, 'custom-loop')).toBe('custom-loop')
    expect(effectiveLoopId('factory:implement', 'implement', false, 'custom-loop')).toBe('factory:implement')
    expect(effectiveLoopId(undefined, 'loop', false, 'custom-loop')).toBe('')
    expect(effectiveLoopId(undefined, 'implement', true, 'custom-loop')).toBe('factory:implement')
    expect(effectiveLoopId(undefined, 'implement', false, null)).toBe('factory:implement')
  })

  it('offers only loops the rail picker lists', () => {
    expect(offeredRecommendation('factory:implement')).toBe('factory:implement')
    // Retired built-ins are never preselected, even from a stale stored triage.
    for (const id of RETIRED_RAIL_LOOP_IDS) expect(offeredRecommendation(id), id).toBeNull()
    expect(offeredRecommendation('factory:flow-spec')).toBeNull()
    expect(offeredRecommendation('custom-1', { loopsEnabled: true })).toBe('custom-1')
    expect(offeredRecommendation('custom-1', { loopsEnabled: false })).toBeNull()
    expect(offeredRecommendation(null)).toBeNull()
  })
})
