import { describe, it, expect } from 'vitest'
import {
  clampFontSize,
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_MAX,
} from '../terminal-settings-types'

describe('clampFontSize', () => {
  it('returns the default for non-finite input', () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_SETTINGS.fontSize)
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TERMINAL_SETTINGS.fontSize)
    expect(clampFontSize(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_TERMINAL_SETTINGS.fontSize)
  })

  it('clamps below min to the min', () => {
    expect(clampFontSize(0)).toBe(TERMINAL_FONT_SIZE_MIN)
    expect(clampFontSize(-50)).toBe(TERMINAL_FONT_SIZE_MIN)
  })

  it('clamps above max to the max', () => {
    expect(clampFontSize(999)).toBe(TERMINAL_FONT_SIZE_MAX)
  })

  it('rounds fractional values inside the range', () => {
    expect(clampFontSize(12.4)).toBe(12)
    expect(clampFontSize(12.6)).toBe(13)
  })

  it('returns valid in-range integers unchanged', () => {
    expect(clampFontSize(14)).toBe(14)
  })
})

describe('DEFAULT_TERMINAL_SETTINGS', () => {
  it('has the expected shape and sensible defaults', () => {
    expect(DEFAULT_TERMINAL_SETTINGS.fontSize).toBeGreaterThanOrEqual(TERMINAL_FONT_SIZE_MIN)
    expect(DEFAULT_TERMINAL_SETTINGS.fontSize).toBeLessThanOrEqual(TERMINAL_FONT_SIZE_MAX)
    expect(DEFAULT_TERMINAL_SETTINGS.renderMode).toBe('auto')
    expect(typeof DEFAULT_TERMINAL_SETTINGS.fontFamily).toBe('string')
    expect(typeof DEFAULT_TERMINAL_SETTINGS.shellIntegrationEnabled).toBe('boolean')
  })
})
