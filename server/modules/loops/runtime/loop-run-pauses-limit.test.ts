import { describe, expect, it } from 'vitest'
import { LIMIT_RESUME_FLOOR_MS, limitResumeAt } from './loop-run-pauses'

describe('limitResumeAt', () => {
  const now = Date.parse('2026-11-18T22:10:07.000Z')
  it('keeps a reset time that is still ahead', () => {
    expect(limitResumeAt('2026-11-19T02:00:00.000Z', now)).toBe('2026-11-19T02:00:00.000Z')
  })
  it('waits at least the floor when the provider refused after the reset it announced', () => {
    // Observed: resets 22:10:00Z announced, the retry at 22:10:07Z was refused again.
    expect(limitResumeAt('2026-11-18T22:10:00.000Z', now)).toBe(new Date(now + LIMIT_RESUME_FLOOR_MS).toISOString())
    expect(limitResumeAt('2026-11-18T22:10:30.000Z', now)).toBe(new Date(now + LIMIT_RESUME_FLOOR_MS).toISOString())
  })
  it('promises nothing when the provider gave no reset time', () => {
    expect(limitResumeAt(null, now)).toBeNull()
  })
})
