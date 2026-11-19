import { useEffect, useState } from 'react'
import { API_ORIGIN } from '../../../lib/origin'
import { readAttemptChain, type AttemptChain } from '../lib/attempt-chain'

export interface RunContinuity {
  /** The chain the run belongs to; null for a run that nothing continued and that continued nothing. */
  chain: AttemptChain | null
  /** Continue applies: a settled or paused definition run that no later attempt took over. */
  continuable: boolean
}

const NONE: RunContinuity = { chain: null, continuable: false }

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
      .then((response) => (response.ok ? response.json() as Promise<{ chain?: unknown; continuable?: unknown }> : null))
      .then((body) => { if (live) setState({ chain: readAttemptChain(body?.chain ?? null), continuable: body?.continuable === true }) })
      .catch(() => { /* no lineage line; the run still shows */ })
    return () => { live = false }
  }, [projectId, runId, refreshKey])
  return state
}
