import { useEffect, useState } from 'react'
import { API_ORIGIN } from '../../../lib/origin'
import { readAttemptChain, type AttemptChain } from '../lib/attempt-chain'
import { readChainResolution, type ChainResolution } from '../lib/resolution'
import { readSettledProviderSwitch, type SettledProviderSwitch } from '../../provider-quota/lib/limit-pause'

export interface RunContinuity {
  /** The chain the run belongs to; null for a run that nothing continued and that continued nothing. */
  chain: AttemptChain | null
  /** Continue applies: a settled or paused definition run that no later attempt took over. */
  continuable: boolean
  /** The chain's spend up to this run and whether it keeps stopping for the same cause. */
  resolution: ChainResolution | null
  /** A run that settled on a provider's usage limit: where its next attempt may continue instead. */
  providerSwitch: SettledProviderSwitch | null
}

const NONE: RunContinuity = { chain: null, continuable: false, resolution: null, providerSwitch: null }

/**
 * A run's place in its attempt chain and whether it can be continued
 * (`GET /loop-runs/:id/attempts`). `refreshKey` re-reads it (the run's status),
 * so a new attempt shows up when this one settles.
 */
export function useAttemptChain(projectId: string | null | undefined, runId: string | null | undefined, refreshKey?: string | null): RunContinuity {
  const [state, setState] = useState<RunContinuity>(NONE)
  useEffect(() => {
    setState(NONE)
    if (!projectId || !runId) return
    let live = true
    void fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/loop-runs/${encodeURIComponent(runId)}/attempts`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() as Promise<{ chain?: unknown; continuable?: unknown; resolution?: unknown; providerSwitch?: unknown }> : null))
      .then((body) => { if (live) setState({ chain: readAttemptChain(body?.chain ?? null), continuable: body?.continuable === true, resolution: readChainResolution(body?.resolution ?? null),
        providerSwitch: body?.continuable === true ? readSettledProviderSwitch(body?.providerSwitch ?? null) : null }) })
      .catch(() => { /* no lineage line; the run still shows */ })
    return () => { live = false }
  }, [projectId, runId, refreshKey])
  return state
}
