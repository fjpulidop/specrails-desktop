import { describe, it, expect } from 'vitest'
import {
  SPEND_CATEGORIES, buildCategoryBreakdown, categoryForSurface, isSpendCategory,
  surfacesForCategories, surfacesForCategory,
} from './spend-categories'
import type { SpendSurface } from './ai-invocations'

const EVERY_SURFACE: SpendSurface[] = [
  'job', 'quick-spec', 'explore-spec', 'ai-edit', 'smash', 'file-summary', 'loop',
  'chat-sidebar', 'spec-launcher', 'proposal', 'agent-studio', 'setup', 'flow', 'triage',
  'failure-analysis', 'mission', 'intent',
]

describe('spend categories', () => {
  it('maps every surface to exactly one category', () => {
    const seen = SPEND_CATEGORIES.flatMap((c) => surfacesForCategory(c))
    expect([...seen].sort()).toEqual([...EVERY_SURFACE].sort())
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('assigns the documented categories', () => {
    expect(surfacesForCategory('implementation')).toEqual(['job', 'loop'])
    expect(surfacesForCategory('missions')).toEqual(['mission', 'intent', 'flow'])
    expect(surfacesForCategory('specs')).toEqual(['quick-spec', 'explore-spec', 'ai-edit', 'smash', 'spec-launcher', 'proposal', 'triage'])
    expect(surfacesForCategory('code')).toEqual(['file-summary'])
    expect(surfacesForCategory('support')).toEqual(['failure-analysis', 'setup', 'agent-studio', 'chat-sidebar'])
    expect(categoryForSurface('intent')).toBe('missions')
    expect(categoryForSurface('triage')).toBe('specs')
  })

  it('sends an unknown surface to support instead of dropping it', () => {
    expect(categoryForSurface('brand-new-surface')).toBe('support')
  })

  it('validates category ids and unions their surfaces', () => {
    expect(isSpendCategory('missions')).toBe(true)
    expect(isSpendCategory('nope')).toBe(false)
    expect(isSpendCategory(3)).toBe(false)
    expect(surfacesForCategories(['code', 'implementation'])).toEqual(['job', 'loop', 'file-summary'])
    expect(surfacesForCategories([])).toEqual([])
  })

  it('builds a breakdown sorted by cost with surfaces costliest first', () => {
    const out = buildCategoryBreakdown([
      { surface: 'job', costUsd: 2, estimatedCostUsd: 0, count: 2, tokens: 100, unpricedCount: 0 },
      { surface: 'loop', costUsd: 5, estimatedCostUsd: 1, count: 1, tokens: 50, unpricedCount: 0 },
      { surface: 'mission', costUsd: 1, estimatedCostUsd: 0, count: 3, tokens: 10, unpricedCount: 1 },
      { surface: 'setup', costUsd: 0, estimatedCostUsd: 0, count: 0, tokens: 0, unpricedCount: 0 },
    ])
    expect(out.map((c) => c.category)).toEqual(['implementation', 'missions', 'specs', 'code', 'support'])
    expect(out[0]).toEqual({
      category: 'implementation', costUsd: 7, estimatedCostUsd: 1, count: 3, tokens: 150, unpricedCount: 0,
      surfaces: [
        { surface: 'loop', costUsd: 5, count: 1, tokens: 50 },
        { surface: 'job', costUsd: 2, count: 2, tokens: 100 },
      ],
    })
    expect(out[1]).toMatchObject({ category: 'missions', costUsd: 1, count: 3, unpricedCount: 1 })
    // Empty categories stay listed, with no surfaces.
    expect(out[4]).toMatchObject({ category: 'support', count: 0, surfaces: [] })
  })
})
