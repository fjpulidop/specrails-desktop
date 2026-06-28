import { describe, it, expect } from 'vitest'
import { formatElapsed } from '../format-duration'

describe('formatElapsed', () => {
  it('seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(12_400)).toBe('12s')
    expect(formatElapsed(59_000)).toBe('59s')
  })
  it('minutes + seconds', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s')
    expect(formatElapsed(185_000)).toBe('3m 5s')
  })
  it('hours + minutes', () => {
    expect(formatElapsed(3_864_000)).toBe('1h 4m')
  })
  it('guards negative / NaN', () => {
    expect(formatElapsed(-5)).toBe('0s')
    expect(formatElapsed(NaN)).toBe('0s')
  })
})
