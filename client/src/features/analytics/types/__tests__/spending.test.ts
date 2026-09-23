import { describe, it, expect } from 'vitest'
import {
  SURFACE_LABEL,
  SURFACE_ACCENT,
  NEUTRAL_SURFACE_ACCENT,
  surfaceLabel,
  surfaceAccent,
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
    expect(keys).toContain('setup')
    expect(keys).not.toContain('brand-new-surface-9000')
    expect(keys).toHaveLength(12)
  })
})
