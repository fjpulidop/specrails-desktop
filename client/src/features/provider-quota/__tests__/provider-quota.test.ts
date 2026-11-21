import { describe, expect, it, vi } from 'vitest'
import { formatResetIn, formatResetTime, nextCountdownTick } from '../lib/format-reset'
import { quotaEscalations } from '../lib/quota-attention'
import { createQuotaStore } from '../lib/quota-store'
import { parseProviderQuotas, quotaNeedsWarning, sharesQuota, type ProviderQuota } from '../lib/types'
import { parsePreflight } from '../lib/launch-preflight'
import { readLimitPause } from '../lib/limit-pause'
import { parseUsageLimitRow } from '../lib/usage-limit-row'

const quota = (over: Partial<ProviderQuota> = {}): ProviderQuota => ({ providerId: 'claude', level: 'ok', usedPercent: 40, windowId: 'five_hour', rejectedUntil: null, rejectedIndefinitely: false, windows: [], observedAt: null, ...over })

describe('provider quota (client)', () => {
  it('parses the server list tolerantly', () => {
    expect(parseProviderQuotas({ providers: [quota(), { providerId: 'x', level: 'weird' }, null] })).toEqual([quota()])
    expect(parseProviderQuotas('nope')).toEqual([])
    expect(quotaNeedsWarning('warning') && quotaNeedsWarning('rejected') && !quotaNeedsWarning('ok')).toBe(true)
    expect(sharesQuota('claude', 'claude')).toBe(true)
  })

  it('announces each escalation (≥80 %, ≥90 %, refused) once per window episode', () => {
    expect(quotaEscalations([quota()], [quota({ level: 'warning', usedPercent: 82 })])).toEqual([expect.objectContaining({ level: 'warning', key: 'quota:claude:warning:open' })])
    expect(quotaEscalations([quota({ level: 'critical' })], [quota({ level: 'warning' })])).toEqual([])
    const refused = quotaEscalations([quota({ level: 'critical' })], [quota({ level: 'rejected', rejectedUntil: '2026-11-18T14:00:00.000Z' })])
    expect(refused[0]).toMatchObject({ level: 'rejected', key: 'quota:claude:rejected:2026-11-18T14:00:00.000Z' })
    expect(quotaEscalations([], [quota({ level: 'unknown' })])).toEqual([])
  })

  it('formats resets as a local clock time and a countdown that ticks only when its label changes', () => {
    const now = Date.parse('2026-11-18T10:00:30.000Z')
    expect(formatResetIn('2026-11-18T13:54:30.000Z', now)).toBe('3h 54m')
    expect(formatResetIn('2026-11-18T10:47:30.000Z', now)).toBe('47m')
    expect(formatResetIn('2026-11-20T12:00:30.000Z', now)).toBe('2d 2h')
    expect(formatResetIn('2026-11-18T10:00:00.000Z', now)).toBeNull()
    expect(nextCountdownTick(['2026-11-18T10:47:30.500Z'], now)).toBe(501)
    expect(nextCountdownTick([null, '2026-01-01T00:00:00.000Z'], now)).toBeNull()
    expect(formatResetTime('2026-11-18T14:00:00.000Z', 'en', now)).toMatch(/\d/)
  })

  it('loads once and then follows server pushes', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ providers: [quota()] }), { status: 200 }))
    const store = createQuotaStore(request as unknown as typeof fetch)
    const off = store.subscribe(() => {})
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ loaded: true, providers: [quota()] })
    store.accept({ type: 'provider_quota.updated', providers: [quota({ level: 'rejected' })] })
    expect(store.getSnapshot().providers[0]!.level).toBe('rejected')
    off()
  })

  it('reads preflight reports, limit pauses and usage-limit rows defensively', () => {
    expect(parsePreflight({ chips: [{ id: 'disk', kind: 'disk', state: 'warn', freeBytes: 1 }, { id: 'x', state: 'bad' }], blocking: false, checkedAt: 't' })?.chips).toHaveLength(1)
    expect(parsePreflight({})).toBeNull()
    expect(readLimitPause({ providerId: 'claude', pausedAt: 't', resumeAt: 'soon', autoResume: true })).toMatchObject({ resumeAt: null, autoResume: true, switchable: false })
    expect(readLimitPause(null)).toBeNull()
    expect(parseUsageLimitRow(JSON.stringify({ kind: 'usage-limit', provider: 'claude', resumeAt: '2026-11-18T14:00:00.000Z', message: 'm', at: 't' }))).toMatchObject({ provider: 'claude' })
    expect(parseUsageLimitRow('{"kind":"run-failure"}')).toBeNull()
    expect(parseUsageLimitRow('not json')).toBeNull()
  })
})
