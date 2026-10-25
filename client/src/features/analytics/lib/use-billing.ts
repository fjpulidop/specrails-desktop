import { useEffect, useState } from 'react'
import { fetchUsageSnapshot, isMeteredBilled } from '../../../lib/launch-forecast'

export interface Billing { ready: boolean; snapshot: unknown }

/** Subscription-usage snapshot: decides which providers may show dollars. Unknown = no dollars. */
export function useBilling(): Billing {
  const [state, setState] = useState<Billing>(() => { const source = fetchUsageSnapshot(); return { ready: source.fresh !== null, snapshot: source.fresh } })
  useEffect(() => {
    const source = fetchUsageSnapshot()
    if (source.fresh) { setState({ ready: true, snapshot: source.fresh }); return }
    let cancelled = false
    void source.load().then((snapshot) => { if (!cancelled) setState({ ready: true, snapshot }) }, () => { if (!cancelled) setState({ ready: true, snapshot: null }) })
    return () => { cancelled = true }
  }, [])
  return state
}

/**
 * True when every provider with spend is plan-billed (not positively metered): the dollar
 * figures are then an API-equivalent estimate, not money that was charged.
 */
export function isPlanBilledSpend(providers: ReadonlyArray<{ provider: string }>, billing: Billing): boolean {
  return providers.length > 0 && providers.every((row) => !isMeteredBilled(billing.snapshot, row.provider))
}
