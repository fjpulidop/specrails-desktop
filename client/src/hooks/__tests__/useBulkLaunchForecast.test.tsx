import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useBulkLaunchForecast } from '../useLaunchForecast'
import { resetLaunchForecastCache, type ForecastQuery } from '../../lib/launch-forecast'

const time = { p25Ms: 360_000, medianMs: 450_000, p75Ms: 540_000, sampleCount: 7 }
const apiKey = { providers: [{ providerId: 'claude', availability: 'unsupported-auth', plan: null, windows: [], spend: null }, { providerId: 'codex', availability: 'unsupported-auth', plan: null, windows: [], spend: null }] }
const plan = { providers: [{ providerId: 'claude', availability: 'available', plan: 'max', windows: [{ usedPercent: 10 }], spend: null }] }

function mockApi(byProvider: Record<string, unknown>, usage: unknown = apiKey) {
  global.fetch = vi.fn().mockImplementation(async (url: string) => {
    const u = String(url)
    if (u.includes('/launch-forecast')) {
      const provider = new URL(u, 'http://x').searchParams.get('provider') ?? ''
      return { ok: true, json: async () => byProvider[provider] }
    }
    if (u.includes('/api/subscription-usage')) return { ok: true, json: async () => usage }
    return { ok: false, json: async () => ({}) }
  }) as typeof fetch
}
const q = (provider: string): ForecastQuery => ({ projectId: 'p1', loopId: 'factory:implement', provider })
const forecast = (cost: { lowUsd: number; highUsd: number } | null, budget: { budgetUsd: number; spentUsd: number } | null) => ({
  time, cost: cost && { ...cost, sampleCount: 7 }, minSamples: 5,
  budget: budget && { scope: 'project', ...budget, exhausted: false, resetsAt: null },
})

beforeEach(() => resetLaunchForecastCache())
afterEach(() => vi.restoreAllMocks())

describe('useBulkLaunchForecast', () => {
  it('sums every run\'s band across rails (not just the first) and shows dollars for metered engines', async () => {
    mockApi({ claude: forecast({ lowUsd: 2, highUsd: 4 }, null), codex: forecast({ lowUsd: 1, highUsd: 3 }, null) })
    const { result } = renderHook(() => useBulkLaunchForecast([q('claude'), q('claude'), q('codex')]))
    await waitFor(() => expect(result.current?.cost).toEqual({ lowUsd: 5, highUsd: 11 }))
    expect(result.current?.runs).toBe(3)
    expect(result.current?.mayPause).toBe(false)
  })

  it('warns that the batch may pause when spent + the summed top reaches the cap, though each run alone would not', async () => {
    // 6 spent + one run (4) = 10 reaches 10 already; use 3 spent: one run (4) = 7 < 10, three runs (12) = 15 >= 10.
    mockApi({ claude: forecast({ lowUsd: 2, highUsd: 4 }, { budgetUsd: 10, spentUsd: 3 }) })
    const single = renderHook(() => useBulkLaunchForecast([q('claude')]))
    await waitFor(() => expect(single.result.current).not.toBeNull())
    expect(single.result.current?.mayPause).toBe(false)
    const batch = renderHook(() => useBulkLaunchForecast([q('claude'), q('claude'), q('claude')]))
    await waitFor(() => expect(batch.result.current?.mayPause).toBe(true))
  })

  it('never shows dollars on a plan or while billing is unknown, but can still warn about the cap', async () => {
    mockApi({ claude: forecast({ lowUsd: 2, highUsd: 4 }, { budgetUsd: 10, spentUsd: 3 }) }, plan)
    const { result } = renderHook(() => useBulkLaunchForecast([q('claude'), q('claude'), q('claude')]))
    await waitFor(() => expect(result.current?.mayPause).toBe(true))
    expect(result.current?.cost).toBeNull()
  })

  it('is null with no queries or no answer, and a null query counts as a run with no band', async () => {
    mockApi({ claude: forecast({ lowUsd: 2, highUsd: 4 }, null) })
    expect(renderHook(() => useBulkLaunchForecast([])).result.current).toBeNull()
    const { result } = renderHook(() => useBulkLaunchForecast([q('claude'), null]))
    await waitFor(() => expect(result.current?.runs).toBe(2))
    expect(result.current?.cost).toEqual({ lowUsd: 2, highUsd: 4 })
  })
})
