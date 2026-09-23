import { describe, it, expect } from 'vitest'
import {
  defaultBootScope, tierFromScope, submitAccentForTier,
  estimateInputTokens, estimateCostUsd,
  timeHintForTier, quickHintForScope,
} from '../context-scope'

describe('context-scope client helpers', () => {
  describe('defaultBootScope', () => {
    it('Quick boots: specrails ON, full/mcp/contractRefine OFF', () => {
      expect(defaultBootScope('quick')).toEqual({
        specrails: true, openspec: false, full: false, mcp: false, contractRefine: false, userMcp: false,
      })
    })

    it('Explore boots: specrails+full ON, mcp/contractRefine OFF (no project defaults)', () => {
      expect(defaultBootScope('explore')).toEqual({
        specrails: true, openspec: false, full: true, mcp: false, contractRefine: false, userMcp: false,
      })
    })
  })

  describe('tierFromScope', () => {
    it('all OFF → Light', () => {
      expect(tierFromScope({ specrails: false, openspec: false, full: false, mcp: false, contractRefine: false })).toBe('Light')
    })

    it('only specrails → Medium', () => {
      expect(tierFromScope({ specrails: true, openspec: false, full: false, mcp: false, contractRefine: false })).toBe('Medium')
    })

    it('specrails + openspec → Heavy', () => {
      expect(tierFromScope({ specrails: true, openspec: true, full: false, mcp: false, contractRefine: false })).toBe('Heavy')
    })

    it('only full → Heavy', () => {
      expect(tierFromScope({ specrails: false, openspec: false, full: true, mcp: false, contractRefine: false })).toBe('Heavy')
    })

    it('all ON → Deep', () => {
      expect(tierFromScope({ specrails: true, openspec: true, full: true, mcp: true, contractRefine: true })).toBe('Deep')
    })
  })

  describe('submitAccentForTier', () => {
    it('maps each tier to a unique theme token', () => {
      const classes = (['Light', 'Medium', 'Heavy', 'Deep'] as const).map(submitAccentForTier)
      const heads = classes.map((c) => c.split(' ')[0])
      expect(new Set(heads).size).toBe(4)
      expect(heads[0]).toContain('accent-success')
      expect(heads[1]).toContain('accent-info')
      expect(heads[2]).toContain('accent-warning')
      expect(heads[3]).toContain('accent-secondary')
    })
  })

  describe('estimateInputTokens', () => {
    const budget = {
      specrailsTicketsTokens: 1800,
      openspecSpecsTokens: 7200,
      codebaseFileCount: 100,
      codebaseEstimatedTokens: 95_000,
      mcpServers: [],
    }
    it('all OFF → 0', () => {
      expect(estimateInputTokens({ specrails: false, openspec: false, full: false, mcp: false, contractRefine: false }, budget)).toBe(0)
    })
    it('sums selected', () => {
      expect(estimateInputTokens({ specrails: true, openspec: true, full: false, mcp: false, contractRefine: false }, budget))
        .toBe(9000)
    })
    it('caps codebase contribution at 50k', () => {
      expect(estimateInputTokens({ specrails: false, openspec: false, full: true, mcp: false, contractRefine: false }, budget))
        .toBe(50_000)
    })
  })

  describe('estimateCostUsd', () => {
    const budget = {
      specrailsTicketsTokens: 1000, openspecSpecsTokens: 0,
      codebaseFileCount: 0, codebaseEstimatedTokens: 0, mcpServers: [],
    }
    it('returns 0 when nothing selected', () => {
      expect(estimateCostUsd({ specrails: false, openspec: false, full: false, mcp: false, contractRefine: false }, budget, 'sonnet')).toBe(0)
    })
    it('uses model price', () => {
      const cost = estimateCostUsd({ specrails: true, openspec: false, full: false, mcp: false, contractRefine: false }, budget, 'sonnet')
      expect(cost).toBeCloseTo(0.003, 6)
    })
    it('falls back when model unknown', () => {
      const cost = estimateCostUsd({ specrails: true, openspec: false, full: false, mcp: false, contractRefine: false }, budget, 'unknown-model')
      expect(cost).toBeGreaterThan(0)
    })
  })

  describe('timeHintForTier + quickHintForScope', () => {
    it('time hints', () => {
      expect(timeHintForTier('Light')).toBe('~15s')
      expect(timeHintForTier('Medium')).toBe('~30s')
      expect(timeHintForTier('Heavy')).toBe('~60s')
      expect(timeHintForTier('Deep')).toBe('~120s')
    })
    it('quick hint flips with full', () => {
      expect(quickHintForScope({ specrails: false, openspec: false, full: false, mcp: false, contractRefine: false })).toBe('~15s')
      expect(quickHintForScope({ specrails: false, openspec: false, full: true, mcp: false, contractRefine: false })).toBe('~45s')
    })
  })
})
