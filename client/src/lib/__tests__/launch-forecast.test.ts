import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  budgetOutlook,
  fetchLaunchForecast,
  fetchUsageSnapshot,
  forecastMinutes,
  formatUsdBand,
  isMeteredBilled,
  isPlanBilled,
  parseLaunchForecast,
  resetLaunchForecastCache,
  type LaunchForecastData,
} from '../launch-forecast'

const time = { p25Ms: 360_000, medianMs: 450_000, p75Ms: 540_000, sampleCount: 7 }
const cost = { lowUsd: 2.1, highUsd: 3.8, sampleCount: 6 }
const budget = { scope: 'project' as const, budgetUsd: 10, spentUsd: 4, exhausted: false, resetsAt: null }
const forecast = (over: Partial<LaunchForecastData> = {}): LaunchForecastData => ({ time, cost, minSamples: 5, budget: null, ...over })

beforeEach(() => resetLaunchForecastCache())

describe('parseLaunchForecast', () => {
  it('accepts the server shape and keeps "no history" as null, never as zero', () => {
    expect(parseLaunchForecast({ time, cost, minSamples: 5, budget })).toEqual({ time, cost, minSamples: 5, budget: { ...budget, resetsAt: null } })
    expect(parseLaunchForecast({ time: null, cost: null, minSamples: 5, budget: null })).toEqual({ time: null, cost: null, minSamples: 5, budget: null })
  })

  it('drops malformed or zero bands instead of rendering a guess', () => {
    const parsed = parseLaunchForecast({ time: { ...time, p25Ms: 0 }, cost: { lowUsd: 'x', highUsd: 1, sampleCount: 5 }, minSamples: 5, budget: { scope: 'nope', budgetUsd: 1, spentUsd: 0 } })
    expect(parsed).toEqual({ time: null, cost: null, minSamples: 5, budget: null })
  })

  it('rejects bodies that are not a forecast', () => {
    expect(parseLaunchForecast(null)).toBeNull()
    expect(parseLaunchForecast({ error: 'nope' })).toBeNull()
    expect(parseLaunchForecast([])).toBeNull()
  })
})

describe('budgetOutlook', () => {
  it('warns when today\'s spend plus the top of the band reaches the budget, in whole cents', () => {
    expect(budgetOutlook(forecast({ budget }))).toBe('none') // 4.00 + 3.80 < 10
    expect(budgetOutlook(forecast({ budget: { ...budget, spentUsd: 6.2 } }))).toBe('may-pause') // 6.20 + 3.80 = 10.00 exactly
    expect(budgetOutlook(forecast({ budget: { ...budget, spentUsd: 6.19 } }))).toBe('none')
    expect(budgetOutlook(forecast({ budget: { ...budget, spentUsd: 0.1 + 0.2 + 5.9 } }))).toBe('may-pause') // 6.2000000000000002 + 3.8: float drift cannot miss the boundary
  })

  it('does not invent a warning without a cost band', () => {
    expect(budgetOutlook(forecast({ cost: null, budget: { ...budget, spentUsd: 9.9 } }))).toBe('none')
  })

  it('says "reached" when the budget is already spent, with or without a cost band', () => {
    expect(budgetOutlook(forecast({ cost: null, budget: { ...budget, spentUsd: 10 } }))).toBe('reached')
    expect(budgetOutlook(forecast({ budget: { ...budget, exhausted: true } }))).toBe('reached')
  })

  it('is silent with no budget', () => {
    expect(budgetOutlook(forecast())).toBe('none')
  })
})

describe('formatting', () => {
  it('shows whole minutes, never 0', () => {
    expect(forecastMinutes(20_000)).toBe(1)
    expect(forecastMinutes(360_000)).toBe(6)
    expect(forecastMinutes(541_000)).toBe(9)
  })

  it('formats a dollar band without ".00" on whole amounts and collapses an equal band', () => {
    expect(formatUsdBand(2, 4, 'en')).toBe('$2–$4')
    expect(formatUsdBand(2.1, 3.8, 'en')).toBe('$2.10–$3.80')
    expect(formatUsdBand(3, 3, 'en')).toBe('$3')
  })
})

describe('isPlanBilled', () => {
  const row = (over: Record<string, unknown>) => ({ providers: [{ providerId: 'claude', availability: 'available', plan: null, windows: [], spend: null, ...over }] })
  it('is a plan when signed in with a detected plan or usage windows', () => {
    expect(isPlanBilled(row({ plan: 'max' }), 'claude')).toBe(true)
    expect(isPlanBilled(row({ windows: [{ usedPercent: 12 }] }), 'claude')).toBe(true)
  })
  it('is not a plan for API-key auth, signed-out, enterprise on-demand spend, other providers or an unreadable snapshot', () => {
    expect(isPlanBilled(row({ availability: 'unsupported-auth', plan: 'max' }), 'claude')).toBe(false)
    expect(isPlanBilled(row({ availability: 'signed-out' }), 'claude')).toBe(false)
    expect(isPlanBilled(row({ plan: 'enterprise', spend: { kind: 'enterprise-on-demand' } }), 'claude')).toBe(false)
    expect(isPlanBilled(row({ plan: 'max' }), 'gemini')).toBe(false)
    expect(isPlanBilled(row({ plan: null, windows: [{ usedPercent: null }] }), 'claude')).toBe(false)
    expect(isPlanBilled(null, 'claude')).toBe(false)
    expect(isPlanBilled({ providers: 'x' }, 'claude')).toBe(false)
  })
})

describe('isMeteredBilled', () => {
  const row = (over: Record<string, unknown>) => ({ providers: [{ providerId: 'claude', availability: 'available', plan: null, windows: [], spend: null, ...over }] })
  it('is metered only when the provider is positively API-key or on-demand billed', () => {
    expect(isMeteredBilled(row({ availability: 'unsupported-auth' }), 'claude')).toBe(true)
    expect(isMeteredBilled(row({ plan: 'enterprise', spend: { kind: 'enterprise-on-demand' } }), 'claude')).toBe(true)
  })
  it('is not metered when it is a plan, signed out, missing from the snapshot or the snapshot is unreadable (unknown shows time only)', () => {
    expect(isMeteredBilled(row({ plan: 'max' }), 'claude')).toBe(false)
    expect(isMeteredBilled(row({ windows: [{ usedPercent: 12 }] }), 'claude')).toBe(false)
    expect(isMeteredBilled(row({ availability: 'signed-out' }), 'claude')).toBe(false)
    expect(isMeteredBilled(row({ availability: 'unavailable' }), 'claude')).toBe(false)
    expect(isMeteredBilled(row({}), 'claude')).toBe(false)
    expect(isMeteredBilled(row({ availability: 'unsupported-auth' }), 'gemini')).toBe(false)
    expect(isMeteredBilled(null, 'claude')).toBe(false)
    expect(isMeteredBilled({ providers: 'x' }, 'claude')).toBe(false)
  })
})

describe('fetch cache', () => {
  const q = { projectId: 'p 1', loopId: 'factory:implement', provider: 'claude' }
  const ok = (body: unknown) => vi.fn().mockResolvedValue({ ok: true, json: async () => body })

  it('asks the project\'s read-only endpoint once for concurrent callers and reuses a fresh answer', async () => {
    const request = ok({ time, cost, minSamples: 5, budget: null })
    const [a, b] = [fetchLaunchForecast(q, request), fetchLaunchForecast(q, request)]
    await Promise.all([a.load(), b.load()])
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toMatch(/\/api\/projects\/p%201\/launch-forecast\?loopId=factory%3Aimplement&provider=claude$/)
    expect(fetchLaunchForecast(q, request).fresh).toMatchObject({ time })
  })

  it('treats a failed request as "unknown" (null) and does not poison the cache', async () => {
    const failing = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    expect(await fetchLaunchForecast(q, failing).load()).toBeNull()
    expect(fetchLaunchForecast(q, failing).fresh).toBeNull()
    const rejecting = vi.fn().mockRejectedValue(new Error('offline'))
    expect(await fetchLaunchForecast({ ...q, loopId: 'other' }, rejecting).load()).toBeNull()
  })

  it('caches the usage snapshot', async () => {
    const request = ok({ providers: [] })
    await fetchUsageSnapshot(request).load()
    expect(fetchUsageSnapshot(request).fresh).toEqual({ providers: [] })
    expect(request).toHaveBeenCalledTimes(1)
  })
})
