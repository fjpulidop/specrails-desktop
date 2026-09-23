import { describe, it, expect } from 'vitest'
import { factoryIdForMode, deriveRailMode, effectiveLoopId, FACTORY_LOOP_ID, FACTORY_RAIL_LOOPS } from '../rail-loops'

describe('rail-loops helpers', () => {
  it('maps each legacy mode to its factory loop id', () => {
    expect(factoryIdForMode('implement')).toBe('factory:implement')
    expect(factoryIdForMode('batch-implement')).toBe('factory:batch')
    expect(factoryIdForMode('freestyle')).toBe('factory:freestyle')
    expect(factoryIdForMode('loop')).toBe('') // custom loops have no factory id
    expect(FACTORY_LOOP_ID.implement).toBe('factory:implement')
  })

  it('derives the legacy mode from a chosen loop id', () => {
    expect(deriveRailMode('factory:implement')).toBe('implement')
    expect(deriveRailMode('factory:batch')).toBe('batch-implement')
    expect(deriveRailMode('factory:freestyle')).toBe('freestyle')
    // Graph-native factory loops run through the loop engine like custom loops.
    expect(deriveRailMode('factory:sdd-quick-openspec')).toBe('loop')
    expect(deriveRailMode('factory:openspec')).toBe('loop')
    expect(deriveRailMode('some-custom-id')).toBe('loop')
    expect(deriveRailMode(null)).toBe('loop')
  })

  it('round-trips mode → factory id → mode', () => {
    for (const mode of ['implement', 'batch-implement', 'freestyle'] as const) {
      expect(deriveRailMode(factoryIdForMode(mode))).toBe(mode)
    }
  })

  it('effectiveLoopId prefers the explicit pick, else the factory id for the mode', () => {
    expect(effectiveLoopId('custom-x', 'loop')).toBe('custom-x')
    expect(effectiveLoopId(null, 'implement')).toBe('factory:implement')
    expect(effectiveLoopId(undefined, 'freestyle')).toBe('factory:freestyle')
    expect(effectiveLoopId('', 'loop')).toBe('') // custom mode + no pick → empty (blocks launch)
  })

  it('exposes the built-in rail loops with a Freestyle capability requirement', () => {
    expect(FACTORY_RAIL_LOOPS.map((f) => f.id)).toEqual(['factory:implement', 'factory:batch', 'factory:freestyle', 'factory:sdd-quick-openspec'])
    expect(FACTORY_RAIL_LOOPS.find((f) => f.id === 'factory:freestyle')?.requiresFreestyle).toBe(true)
    // Graph-native built-in: only offered while the Loops feature is enabled.
    expect(FACTORY_RAIL_LOOPS.find((f) => f.id === 'factory:sdd-quick-openspec')?.requiresLoops).toBe(true)
  })
})
