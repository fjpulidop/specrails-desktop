import { describe, expect, it } from 'vitest'
import { initialUsage, normalizeClaude, normalizeCodex, timestamp } from './domain'
import { withFreshness } from './application'
describe('subscription window normalization', () => {
  it('preserves zero, missing fields and provider model windows', () => {
    const windows = normalizeClaude({ five_hour: { utilization: 0 }, seven_day: { utilization: 101, resets_at: 'bad' }, seven_day_sonnet: { utilization: 42, resets_at: '2030-01-01T00:00:00Z' }, extra_usage: { utilization: 1 } })
    expect(windows).toHaveLength(3)
    expect(windows[0]).toMatchObject({ usedPercent: 0, durationMinutes: 300, resetsAt: null })
    expect(windows[1]).toMatchObject({ usedPercent: null, resetsAt: null })
    expect(windows[2]).toMatchObject({ model: 'sonnet', scope: 'model', usedPercent: 42 })
  })
  it('ignores breakdown containers while preserving genuinely unknown windows', () => {
    expect(normalizeClaude({ seven_day_breakdown: { models: [] }, seven_day_sonnet: { utilization: null } })).toEqual([expect.objectContaining({ model: 'sonnet', usedPercent: null })])
  })
  it('retains scoped limits without duplicating named windows', () => {
    expect(normalizeClaude({ seven_day_fable: { utilization: 23 }, limits: [{ kind: 'weekly_scoped', percent: 40, scope: { model: { display_name: 'Fable' } } }, { kind: 'weekly_scoped', percent: 60, scope: { model: { display_name: 'Other' } } }] }).map(w => w.model)).toEqual(['fable', 'Other'])
  })
  it('classifies reordered Codex windows and multi-bucket usage by metadata', () => {
    const result = normalizeCodex({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1900000000 }, secondary: { usedPercent: null, windowDurationMins: 300 } }, other: { limitName: 'Model A', primary: { usedPercent: 0 } } } })
    expect(result.map(w => w.label)).toEqual(['weekly', 'session', 'window'])
    expect(result[0].resetsAt).toBe('2030-03-17T17:46:40.000Z')
    expect(result[1].usedPercent).toBeNull()
    expect(result[2]).toMatchObject({ model: 'Model A', usedPercent: 0 })
  })
  it('invalid timestamps remain unknown', () => { expect(timestamp(Infinity)).toBeNull(); expect(timestamp('bad')).toBeNull() })
  it('marks passed resets stale without resetting measured usage', () => {
    const row = { ...initialUsage('claude', 'a'), observedAt: '2030-01-01T00:00:00Z', windows: normalizeClaude({ five_hour: { utilization: 88, resets_at: '2030-01-01T00:01:00Z' } }) }
    expect(withFreshness(row, Date.parse('2030-01-01T00:02:00Z'))).toMatchObject({ freshness: 'stale', windows: [expect.objectContaining({ usedPercent: 88 })] })
  })
})
