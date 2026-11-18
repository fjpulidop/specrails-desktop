import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLaunchPreflight, type PreflightReport } from './launch-preflight'

/**
 * The preflight of one dialog session: fetched when the dialog opens (and
 * again only on "Check again"), kept while it stays open.
 */
export function useLaunchPreflight(open: boolean, projectId: string | null | undefined, providers: readonly string[]) {
  const [report, setReport] = useState<PreflightReport | null>(null)
  const [loading, setLoading] = useState(false)
  const key = providers.join(',')
  const controller = useRef<AbortController | null>(null)
  const run = useCallback((fresh: boolean) => {
    if (!projectId) return
    controller.current?.abort()
    const local = new AbortController()
    controller.current = local
    setLoading(true)
    fetchLaunchPreflight(projectId, key.split(','), { fresh, signal: local.signal })
      .then((next) => { if (!local.signal.aborted) setReport(next) })
      .catch(() => { if (!local.signal.aborted) setReport(null) })
      .finally(() => { if (!local.signal.aborted) setLoading(false) })
  }, [projectId, key])
  useEffect(() => {
    if (!open) { controller.current?.abort(); setReport(null); setLoading(false); return }
    run(false)
    return () => controller.current?.abort()
  }, [open, run])
  return { report, loading, recheck: () => run(true) }
}
