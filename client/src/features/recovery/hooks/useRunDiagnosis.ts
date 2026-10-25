import { useEffect, useState } from 'react'
import { API_ORIGIN } from '../../../lib/origin'
import { readFailureDiagnosis, type FailureDiagnosis } from '../lib/failure-diagnosis'

/**
 * The diagnosis of ONE run in ONE project (`GET /loop-runs/:id` carries it for
 * a run that failed, stalled or was blocked). Fetched only while `enabled`, and
 * again when `version` moves (the card's own state changed). A run without a
 * diagnosis, a disabled loops feature or a network error all read as `null`:
 * the surface then keeps whatever failure text it already shows.
 */
export function useRunDiagnosis(projectId: string | null | undefined, runId: string | null | undefined, enabled: boolean, version: string | number | null = null): FailureDiagnosis | null {
  const [diagnosis, setDiagnosis] = useState<{ key: string; value: FailureDiagnosis | null } | null>(null)
  const key = `${projectId ?? ''}:${runId ?? ''}`
  useEffect(() => {
    if (!enabled || !projectId || !runId) return
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/loop-runs/${encodeURIComponent(runId)}`, { signal: controller.signal })
        if (!res.ok) { setDiagnosis({ key, value: null }); return }
        const body = (await res.json()) as { loopRun?: { failureDiagnosis?: unknown } }
        if (!controller.signal.aborted) setDiagnosis({ key, value: readFailureDiagnosis(body.loopRun?.failureDiagnosis) })
      } catch { if (!controller.signal.aborted) setDiagnosis({ key, value: null }) }
    })()
    return () => controller.abort()
  }, [enabled, projectId, runId, key, version])
  // Never show another run's diagnosis while this one loads.
  return enabled && diagnosis?.key === key ? diagnosis.value : null
}
