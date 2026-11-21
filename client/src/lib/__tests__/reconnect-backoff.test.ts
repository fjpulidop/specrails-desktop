import { describe, it, expect } from 'vitest'
import { RECONNECT_BACKOFF_CAP_MS, RECONNECT_BACKOFF_MS, reconnectDelay } from '../reconnect-backoff'

describe('reconnectDelay', () => {
  it('follows the plain schedule, then the 30 s cap, when the jitter draw is 0', () => {
    const schedule = Array.from({ length: 8 }, (_, attempt) => reconnectDelay(attempt, () => 0))
    expect(schedule).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })

  it('shortens each step by at most 20 % at the top of the jitter range', () => {
    const schedule = Array.from({ length: 7 }, (_, attempt) => reconnectDelay(attempt, () => 0.999999))
    expect(schedule).toEqual([800, 1600, 3200, 6400, 12800, 24000, 24000])
  })

  it('scales linearly with the random draw and never exceeds the plain step', () => {
    expect(reconnectDelay(2, () => 0.5)).toBe(3600)
    for (let attempt = 0; attempt < 10; attempt++) {
      const base = RECONNECT_BACKOFF_MS[attempt] ?? RECONNECT_BACKOFF_CAP_MS
      for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
        const delay = reconnectDelay(attempt, () => r)
        expect(delay).toBeLessThanOrEqual(base)
        expect(delay).toBeGreaterThanOrEqual(base * 0.8)
      }
    }
  })

  it('clamps an out-of-range random source', () => {
    expect(reconnectDelay(0, () => -1)).toBe(1000)
    expect(reconnectDelay(0, () => 5)).toBe(800)
  })

  it('gives two windows with different draws different delays (no lockstep)', () => {
    expect(reconnectDelay(4, () => 0.1)).not.toBe(reconnectDelay(4, () => 0.6))
  })
})
