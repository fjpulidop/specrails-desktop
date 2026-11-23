import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchLaunchPreflight, type PreflightReport } from './launch-preflight'
import { chipHint, chipText } from '../components/LaunchPreflightChips'

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

/**
 * The Launch-all checks for a launch without a dialog (a rail's Play, a mission's
 * Launch): resolves to what failed, worded like the dialog's chips, or null when
 * nothing blocks. A check that cannot run never blocks: the launch reports its own errors.
 */
export function useLaunchGuard(): (projectId: string, providers: readonly string[]) => Promise<{ message: string; failed: string[] } | null> {
  const { t, i18n } = useTranslation('providerQuota')
  return useCallback(async (projectId, providers) => {
    let report: PreflightReport | null = null
    try { report = await fetchLaunchPreflight(projectId, providers.length ? providers : ['']) } catch { return null }
    if (!report?.blocking) return null
    // Outside the dialog there is no tooltip: each failed check says its state, then what to do.
    const tr = (key: string, options?: Record<string, unknown>) => String(t(key, options))
    const failed = report.chips.filter((chip) => chip.state === 'fail').map((chip) => {
      const hint = chipHint(chip, tr, i18n.language)
      return hint ? `${chipText(chip, tr, i18n.language)}. ${hint}` : chipText(chip, tr, i18n.language)
    })
    return { message: String(t('preflight.blocking')), failed }
  }, [t, i18n.language])
}
