import { describe, expect, it } from 'vitest'
import { claudePlan, initialUsage, normalizeClaude, normalizeClaudeSpend, normalizeCodex, timestamp } from './domain'
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

describe('Enterprise consumption observations', () => {
  const now = Date.parse('2026-10-03T05:56:00Z')
  const payload = { five_hour: null, seven_day: null, extra_usage: { is_enabled: true, monthly_limit: 100000, used_credits: 2078, currency: 'USD', utilization: 2 } }
  it('detects plans and normalizes the supplied monthly spend example in minor units', () => {
    expect(claudePlan('claude_enterprise')).toBe('enterprise')
    expect(claudePlan('default_claude_max_20x')).toBe('max')
    expect(claudePlan('unknown')).toBeNull()
    expect(normalizeClaudeSpend(payload, 'enterprise', now)).toEqual({ kind: 'enterprise-on-demand', usedAmount: 20.78, limitAmount: 1000, currency: 'USD', limitStatus: 'limited', usedPercent: 2, resetsAt: '2026-11-01T00:00:00.000Z' })
  })
  it.each(['pro', 'max', 'team', 'free', null])('does not turn %s extra usage into Enterprise consumption', plan => {
    expect(normalizeClaudeSpend(payload, plan, now)).toBeNull()
  })
  it('keeps traditional Enterprise windows including measured zero', () => {
    expect(normalizeClaudeSpend({ ...payload, five_hour: { utilization: 0 } }, 'enterprise', now)).toBeNull()
    expect(normalizeClaudeSpend({ ...payload, seven_day: { resets_at: '2026-10-10T00:00:00Z' } }, 'enterprise', now)).toBeNull()
    expect(normalizeClaudeSpend({ ...payload, five_hour: { utilization: null, resets_at: null } }, 'enterprise', now)).not.toBeNull()
  })
  it('distinguishes unknown, unlimited and zero amounts and derives percentages only from known values', () => {
    const normalize = (extra_usage: unknown) => normalizeClaudeSpend({ extra_usage }, 'enterprise', now)
    expect(normalize({ used_credits: 0, monthly_limit: 100000 })).toMatchObject({ usedAmount: 0, limitAmount: 1000, usedPercent: 0 })
    expect(normalize({ used_credits: 2078, monthly_limit: null, is_enabled: true })).toMatchObject({ usedAmount: 20.78, limitStatus: 'unlimited', usedPercent: null })
    expect(normalize({ used_credits: 2078 })).toMatchObject({ limitAmount: null, limitStatus: 'unknown', usedPercent: null })
    expect(normalize({ used_credits: null, monthly_limit: 100000 })).toMatchObject({ usedAmount: null, usedPercent: null })
    expect(normalize({ used_credits: 0, monthly_limit: 0, is_enabled: false })).toMatchObject({ usedAmount: 0, limitAmount: 0, usedPercent: null })
    expect(normalize({ used_credits: null, monthly_limit: null })).toBeNull()
    expect(normalize({ used_credits: -1, monthly_limit: Infinity })).toBeNull()
    expect(normalize({ used_credits: '2078', monthly_limit: '100000' })).toBeNull()
    expect(normalize({ used_credits: 2078, currency: 'invalid' })).toBeNull()
  })
  it('preserves currency, fractional minor units and over-budget spending', () => {
    expect(normalizeClaudeSpend({ extra_usage: { used_credits: 31402.5, monthly_limit: 10000, currency: 'EUR' } }, 'enterprise', now)).toMatchObject({ usedAmount: 314.025, limitAmount: 100, usedPercent: 314.025, currency: 'EUR' })
    expect(normalizeClaudeSpend({ extra_usage: { used_credits: 1234, monthly_limit: 10000, currency: 'JPY' } }, 'enterprise', now)).toMatchObject({ usedAmount: 1234, limitAmount: 10000, currency: 'JPY' })
  })
  it('uses provider resets and marks passed spend observations stale without clearing money', () => {
    const spend = normalizeClaudeSpend({ ...payload, extra_usage: { ...payload.extra_usage, resets_at: '2026-10-03T05:55:00Z' } }, 'enterprise', now)
    const row = { ...initialUsage('claude', 'g'), spend, observedAt: '2026-10-03T05:54:00Z' }
    expect(withFreshness(row, now)).toMatchObject({ freshness: 'stale', spend: { usedAmount: 20.78 } })
    expect(normalizeClaudeSpend(payload, 'enterprise', Date.parse('2026-12-31T23:59:00Z'))?.resetsAt).toBe('2027-01-01T00:00:00.000Z')
  })
})
