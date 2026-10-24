import { useEffect, useState } from 'react'
import {
  fetchLaunchForecast,
  fetchUsageSnapshot,
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
 * Whether `provider` is billed through a subscription plan. `ready` is false
 * until the machine's usage snapshot has answered; the dollar figure waits for
 * it, so it never flashes for a plan user.
 */
export function useProviderBilling(provider: string | null): { ready: boolean; plan: boolean } {
  const [state, setState] = useState<{ ready: boolean; snapshot: unknown }>(() => {
    const source = fetchUsageSnapshot()
    return { ready: source.fresh !== null, snapshot: source.fresh }
  })

  useEffect(() => {
    const source = fetchUsageSnapshot()
    if (source.fresh) { setState({ ready: true, snapshot: source.fresh }); return }
    let cancelled = false
    // An unreadable snapshot is "unknown", which is not a plan: costs may show.
    void source.load().then((snapshot) => { if (!cancelled) setState({ ready: true, snapshot }) })
    return () => { cancelled = true }
  }, [])

  return { ready: state.ready, plan: provider ? isPlanBilled(state.snapshot, provider) : false }
}
