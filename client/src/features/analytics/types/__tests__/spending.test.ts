import { describe, it, expect } from 'vitest'
import {
  SURFACE_LABEL,
  SURFACE_ACCENT,
  NEUTRAL_SURFACE_ACCENT,
  surfaceLabel,
  surfaceAccent,
  SPEND_CATEGORIES,
  categoryForSurface,
  isSpendCategory,
  surfacesForCategory,
} from '../spending'
import type { Surface } from '../spending'

describe('surface maps · tolerance (surface plumbing)', () => {
  it('resolves the five new server surfaces to real (non-neutral) accents', () => {
    const newSurfaces: Surface[] = ['chat-sidebar', 'spec-launcher', 'proposal', 'agent-studio', 'setup']
    for (const s of newSurfaces) {
      expect(SURFACE_ACCENT[s]).toBeDefined()
      expect(SURFACE_ACCENT[s]).not.toBe(NEUTRAL_SURFACE_ACCENT)
      // Label resolves through i18next (falls back to the key/id, never throws).
      expect(typeof SURFACE_LABEL[s]).toBe('string')
      expect(SURFACE_LABEL[s].length).toBeGreaterThan(0)
    }
  })

  it('falls back to a neutral accent for an unknown surface id (never undefined)', () => {
    const accent = surfaceAccent('brand-new-surface-9000')
    expect(accent).toBe(NEUTRAL_SURFACE_ACCENT)
    // A bare index must not throw either — this is what kept the dashboard alive.
    expect(() => (SURFACE_ACCENT as Record<string, unknown>)['brand-new-surface-9000']).not.toThrow()
    expect((SURFACE_ACCENT as Record<string, { dot: string }>)['brand-new-surface-9000'].dot).toBe(
      NEUTRAL_SURFACE_ACCENT.dot,
    )
  })

  it('falls back to the raw id as the label for an unknown surface', () => {
    expect(surfaceLabel('brand-new-surface-9000')).toBe('brand-new-surface-9000')
  })

  it('Object.keys still reports only the known surfaces (iteration unaffected by the proxy)', () => {
    const keys = Object.keys(SURFACE_LABEL)
    expect(keys).toContain('job')
    expect(keys).toContain('flow')
    expect(keys).toContain('triage')
    expect(keys).toContain('setup')
    expect(keys).toContain('mission')
    expect(keys).toContain('intent')
    expect(keys).not.toContain('brand-new-surface-9000')
    expect(keys).toHaveLength(17)
  })

  it('never colours a surface with a lamp token: failure analysis is not a failure', () => {
    for (const surface of Object.keys(SURFACE_LABEL) as Surface[]) {
      const classes = Object.values(SURFACE_ACCENT[surface]).join(' ')
      expect(classes).not.toMatch(/destructive|accent-(info|success|warning|review)/)
    }
    // Surfaces of one category share its accent.
    expect(SURFACE_ACCENT.job).toBe(SURFACE_ACCENT.loop)
  })

  it('gives the virtual agent-ledger surfaces their own accents', () => {
    expect(SURFACE_ACCENT.mission).not.toBe(NEUTRAL_SURFACE_ACCENT)
    expect(SURFACE_ACCENT.intent).not.toBe(NEUTRAL_SURFACE_ACCENT)
  })
})

describe('spend categories (mirror of the server mapping)', () => {
  it('maps every known surface to exactly one category', () => {
    const all = SPEND_CATEGORIES.flatMap((c) => surfacesForCategory(c))
    expect([...all].sort()).toEqual(Object.keys(SURFACE_LABEL).sort())
    expect(new Set(all).size).toBe(all.length)
  })

  it('resolves categories, falling back to support for unknown surfaces', () => {
    expect(categoryForSurface('job')).toBe('implementation')
    expect(categoryForSurface('mission')).toBe('missions')
    expect(categoryForSurface('intent')).toBe('missions')
    expect(categoryForSurface('flow')).toBe('missions')
    expect(categoryForSurface('triage')).toBe('specs')
    expect(categoryForSurface('file-summary')).toBe('code')
    expect(categoryForSurface('chat-sidebar')).toBe('support')
    expect(categoryForSurface('brand-new-surface-9000')).toBe('support')
    expect(isSpendCategory('specs')).toBe(true)
    expect(isSpendCategory('nope')).toBe(false)
  })
})

describe('category colours', () => {
  it('take the chart palette in the canonical category order', async () => {
    const { categoryColors, surfaceColor } = await import('../../lib/category-colors')
    const colors = categoryColors(['c1', 'c2', 'c3', 'c4', 'c5'])
    expect(colors).toEqual({ implementation: 'c1', missions: 'c2', specs: 'c3', code: 'c4', support: 'c5' })
    expect(surfaceColor(colors, 'failure-analysis')).toBe('c5')
    expect(surfaceColor(colors, 'loop')).toBe('c1')
  })
})
