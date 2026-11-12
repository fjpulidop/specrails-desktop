import { describe, expect, it } from 'vitest'
import { formatElapsed } from './format-duration'

describe('formatElapsed', () => {
  it.each([
    [0, '0s'], [45_000, '45s'], [59_999, '59s'], [60_000, '1m'],
    [59 * 60_000, '59m'], [60 * 60_000, '1h 00m'], [125 * 60_000, '2h 05m'],
    [-1, '0s'], [NaN, '0s'], [Infinity, '0s'], [-Infinity, '0s'],
  ])('[spec:milestone-launch-chain/static-total-milestone-elapsed-time] formats %s milliseconds as %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })
})
