import { useEffect, useState } from 'react'
import {
  budgetOutlook,
  fetchLaunchForecast,
  fetchUsageSnapshot,
  forecastKey,
  isMeteredBilled,
  isPlanBilled,
  peekForecast,
  type ForecastQuery,
  type LaunchForecastData,
} from '../lib/launch-forecast'

/**
 * The forecast for one launch target. `data` stays null until the server
 * answers (or if it cannot): nothing is shown for an unknown, and a previous
 * answer for the same target paints at once while it refreshes (30 s cache).
 */
export function useLaunchForecast(query: ForecastQuery | null): LaunchForecastData | null {
  const projectId = query?.projectId
  const loopId = query?.loopId
  const provider = query?.provider
  const [data, setData] = useState<LaunchForecastData | null>(() => (query ? peekForecast(query) : null))

  useEffect(() => {
    if (!projectId || !loopId || !provider) { setData(null); return }
    const q = { projectId, loopId, provider }
    setData(peekForecast(q))
    const source = fetchLaunchForecast(q)
    if (source.fresh) { setData(source.fresh); return }
    let cancelled = false
    void source.load().then((value) => { if (!cancelled && value) setData(value) })
    return () => { cancelled = true }
  }, [projectId, loopId, provider])

  return data
}

/**
 * Whether `provider` is billed through a subscription plan, or positively
 * metered. `ready` is false until the machine's usage snapshot has answered.
 * Only `metered` licenses a dollar figure: unknown billing shows time only.
 */
export function useProviderBilling(provider: string | null): { ready: boolean; plan: boolean; metered: boolean } {
  const [state, setState] = useState<{ ready: boolean; snapshot: unknown }>(() => {
    const source = fetchUsageSnapshot()
    return { ready: source.fresh !== null, snapshot: source.fresh }
  })

  useEffect(() => {
    const source = fetchUsageSnapshot()
    if (source.fresh) { setState({ ready: true, snapshot: source.fresh }); return }
    let cancelled = false
    // An unreadable snapshot is "unknown": time only, no dollar figure.
    void source.load().then((snapshot) => { if (!cancelled) setState({ ready: true, snapshot }) })
    return () => { cancelled = true }
  }, [])

  return { ready: state.ready, plan: provider ? isPlanBilled(state.snapshot, provider) : false, metered: provider ? isMeteredBilled(state.snapshot, provider) : false }
}

/** Where today's budget stands for this launch target: nothing to say, may pause, or already reached. */
export function useBudgetOutlook(query: ForecastQuery | null): 'none' | 'may-pause' | 'reached' {
  const data = useLaunchForecast(query)
  return data ? budgetOutlook(data) : 'none'
}

export interface BulkForecast {
  /** Runs the batch will start (one per spec). */
  runs: number
  /** Summed cost bands, only when every costed run is positively metered; null otherwise (plan or unknown billing never shows dollars). */
  cost: { lowUsd: number; highUsd: number } | null
  /** Today's (or the tightest) cap would be reached by what is spent plus the top of the whole batch. */
  mayPause: boolean
}

/**
 * The forecast for a whole batch: every run's cost band summed, and the cap
 * checked against `spent + sum` (a batch of cheap runs can still cross it while
 * each run alone would not). `queries` has one entry per run; null entries
 * (no forecast for that rail) count as a run with no band. Null until at
 * least one forecast has answered.
 */
export function useBulkLaunchForecast(queries: readonly (ForecastQuery | null)[]): BulkForecast | null {
  const [forecasts, setForecasts] = useState<ReadonlyMap<string, LaunchForecastData>>(new Map())
  const [snapshot, setSnapshot] = useState<{ ready: boolean; value: unknown }>(() => {
    const source = fetchUsageSnapshot()
    return { ready: source.fresh !== null, value: source.fresh }
  })
  const keys = queries.map((q) => (q ? forecastKey(q) : '')).join(',')

  useEffect(() => {
    const distinct = new Map<string, ForecastQuery>()
    for (const q of queries) if (q) distinct.set(forecastKey(q), q)
    if (distinct.size === 0) { setForecasts(new Map()); return }
    let cancelled = false
    const known = new Map<string, LaunchForecastData>()
    for (const [key, q] of distinct) { const peeked = peekForecast(q); if (peeked) known.set(key, peeked) }
    setForecasts(known)
    for (const [key, q] of distinct) {
      const source = fetchLaunchForecast(q)
      if (source.fresh) { known.set(key, source.fresh); setForecasts(new Map(known)); continue }
      void source.load().then((value) => { if (!cancelled && value) { known.set(key, value); setForecasts(new Map(known)) } })
    }
    return () => { cancelled = true }
    // `keys` stands for the queries' identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])

  useEffect(() => {
    const source = fetchUsageSnapshot()
    if (source.fresh) { setSnapshot({ ready: true, value: source.fresh }); return }
    let cancelled = false
    void source.load().then((value) => { if (!cancelled) setSnapshot({ ready: true, value }) })
    return () => { cancelled = true }
  }, [])

  if (forecasts.size === 0) return null
  let low = 0
  let high = 0
  let costed = 0
  let allMetered = true
  let budget: LaunchForecastData['budget'] = null
  for (const q of queries) {
    if (!q) continue
    const data = forecasts.get(forecastKey(q))
    if (!data) continue
    if (data.budget && (!budget || data.budget.budgetUsd - data.budget.spentUsd < budget.budgetUsd - budget.spentUsd)) budget = data.budget
    if (!data.cost) continue
    costed += 1
    low += data.cost.lowUsd
    high += data.cost.highUsd
    if (!(snapshot.ready && isMeteredBilled(snapshot.value, q.provider))) allMetered = false
  }
  const cents = (usd: number): number => Math.round(usd * 100)
  const mayPause = budget !== null && costed > 0 && cents(budget.spentUsd) + cents(high) >= cents(budget.budgetUsd)
  return { runs: queries.length, cost: costed > 0 && allMetered ? { lowUsd: low, highUsd: high } : null, mayPause }
}
