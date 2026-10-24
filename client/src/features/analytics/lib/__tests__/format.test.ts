import { describe, it, expect } from 'vitest'
import { formatUsd } from '../format'

describe('formatUsd', () => {
  it('uses two fraction digits from one cent up', () => {
    expect(formatUsd(0.5, 'en')).toBe('$0.50')
    expect(formatUsd(1234.5, 'en')).toBe('$1,234.50')
  })

  it('keeps up to four fraction digits below one cent', () => {
    expect(formatUsd(0.0034, 'en')).toBe('$0.0034')
  })

  it('formats zero without sub-cent precision', () => {
    expect(formatUsd(0, 'en')).toBe('$0.00')
  })

  it('follows the requested locale', () => {
    expect(formatUsd(2.5, 'de')).toMatch(/2,50/)
  })

  it('falls back to English for an invalid locale tag', () => {
    expect(formatUsd(1, 'not a locale!!')).toBe('$1.00')
  })
})
