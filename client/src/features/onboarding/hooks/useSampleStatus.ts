import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchSampleStatus } from '../lib/sample-api'
import type { SampleStatus } from '../lib/sample-model'

/**
 * The sample-project answer (catalog, current sample, launch readiness). A
 * failed request leaves `status` null: callers degrade to "no sample, not ready"
 * instead of showing an error for something the person never asked for.
 */
export function useSampleStatus(opts: { enabled?: boolean; refreshKey?: unknown } = {}): {
  status: SampleStatus | null
  loading: boolean
  refresh: (options?: { providers?: boolean }) => Promise<SampleStatus | null>
} {
  const { enabled = true, refreshKey } = opts
  const [status, setStatus] = useState<SampleStatus | null>(null)
  const [loading, setLoading] = useState(enabled)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const refresh = useCallback(async (options?: { providers?: boolean }) => {
    try {
      const next = await fetchSampleStatus({ refresh: options?.providers === true })
      if (alive.current) setStatus(next)
      return next
    } catch {
      return null
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) { setLoading(false); return }
    setLoading(true)
    void refresh()
  }, [enabled, refresh, refreshKey])

  return { status, loading, refresh }
}
