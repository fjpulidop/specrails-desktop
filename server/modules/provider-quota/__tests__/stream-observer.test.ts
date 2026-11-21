import { afterEach, describe, expect, it } from 'vitest'
import { observeQuotaLine, observeQuotaFrame } from '../runtime/stream-observer'
import { bindQuotaStore, quotaResumeAt, quotaView, reportProviderRefusal, reportRateLimit } from '../runtime/quota-reports'
import { createQuotaStore, realTimers } from '../runtime/quota-store'
import { claudeFrameRateLimit } from '../adapters/claude-stream'

const RESET = Math.floor(Date.now() / 1000) + 3_600
const frame = (status: string) => ({ type: 'rate_limit_event', session_id: 's', rate_limit_info: { status, resetsAt: RESET, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: status === 'rejected' ? 1 : 0.56, resetsAt: RESET }, seven_day: { utilization: 0.49, resetsAt: 1791550800 } } } })

afterEach(() => bindQuotaStore(null))

describe('Claude stream frames', () => {
  it('normalizes the recorded rate_limit_event like Core does', () => {
    expect(claudeFrameRateLimit(frame('allowed'))).toEqual({
      status: 'allowed', rateLimitType: 'five_hour', resetsAt: new Date(RESET * 1000).toISOString(), utilization: 0.56,
      windows: { five_hour: { utilization: 0.56, resetsAt: new Date(RESET * 1000).toISOString(), windowMinutes: 300 }, seven_day: { utilization: 0.49, resetsAt: new Date(1791550800 * 1000).toISOString(), windowMinutes: 10_080 } },
      overage: { status: 'rejected', inUse: false, disabledReason: 'org_level_disabled', resetsAt: null },
    })
    expect(claudeFrameRateLimit({ type: 'assistant' })).toBeNull()
    expect(claudeFrameRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'weird' } })).toBeNull()
  })
})

describe('live stream observation', () => {
  it('reports Claude frames and Core rate-limit agent events to the bound store', () => {
    const store = createQuotaStore({ timers: realTimers })
    bindQuotaStore(store)
    observeQuotaLine('claude', JSON.stringify(frame('rejected')))
    expect(quotaResumeAt('claude')).toBe(new Date(RESET * 1000).toISOString())
    observeQuotaFrame('claude', { type: 'agent-event', role: 'developer', event: { kind: 'rate-limit', provider: 'codex', rateLimit: { status: 'allowed', rateLimitType: 'codex:primary', resetsAt: null, utilization: 0.91, windows: { 'codex:primary': { utilization: 0.91, resetsAt: null } }, overage: null } } })
    expect(quotaView('codex')).toMatchObject({ level: 'critical' })
    // Ordinary lines cost one substring scan and are never parsed.
    observeQuotaLine('claude', '{"type":"assistant"}')
    observeQuotaLine('claude', 'not json rate_limit_event')
    store.dispose()
  })

  it('drops reports while no store is bound and resolves prose resets', () => {
    expect(reportRateLimit('claude', { status: 'rejected' }, 'session')).not.toBeNull()
    expect(quotaResumeAt('claude')).toBeNull()
    expect(reportProviderRefusal('claude', '2099-01-01T00:00:00Z')).toBe('2099-01-01T00:00:00.000Z')
  })
})
