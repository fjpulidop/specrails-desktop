import { useEffect, useState } from 'react'
import { API_ORIGIN } from '../../../lib/origin'
import { readAttemptChain, type AttemptChain } from '../lib/attempt-chain'

/**
 * The attempt chain a run belongs to (`GET /loop-runs/:id/attempts`); null for a
 * run that nothing continued and that continued nothing. `refreshKey` re-reads
 * it (the run's status), so a new attempt shows up when this one settles.
 */
export function useAttemptChain(projectId: string | null | undefined, runId: string | null | undefined, refreshKey?: string | null): AttemptChain | null {
  const [chain, setChain] = useState<AttemptChain | null>(null)
  useEffect(() => {
    setChain(null)
    if (!projectId || !runId) return
    let live = true
    void fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/loop-runs/${encodeURIComponent(runId)}/attempts`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() as Promise<{ chain?: unknown }> : null))
      .then((body) => { if (live) setChain(readAttemptChain(body?.chain ?? null)) })
      .catch(() => { /* no lineage line; the run still shows */ })
    return () => { live = false }
  }, [projectId, runId, refreshKey])
  return chain
}
