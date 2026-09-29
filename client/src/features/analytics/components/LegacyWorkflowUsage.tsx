import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../../../lib/api'

const kinds = ['legacy_loop_traversal', 'queue_manager_slash', 'merge_back'] as const
interface Summary { total: number; byKind: Record<typeof kinds[number], number>; lastAt: string | null }
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function parseSummary(value: unknown): Summary {
  const summary = value as Summary | null
  if (!summary || !count(summary.total) || !summary.byKind || kinds.some(kind => !count(summary.byKind[kind])) ||
    (summary.lastAt !== null && (typeof summary.lastAt !== 'string' || !Number.isFinite(Date.parse(summary.lastAt))))) throw new Error('Invalid telemetry')
  return summary
}

/** Recorded local observations, deliberately separate from rollout acceptance. */
export function LegacyWorkflowUsage({ projectId }: { projectId: string }) {
  const { t } = useTranslation('analytics')
  const cache = useRef(new Map<string, Summary>())
  const [revision, refresh] = useState(0)
  const [state, setState] = useState<{ projectId: string; loading: boolean; error: boolean }>({ projectId, loading: true, error: false })
  useEffect(() => {
    let current = true
    const controller = new AbortController()
    setState({ projectId, loading: true, error: false })
    void (async () => {
      try {
        const response = await fetch(`${getApiBase()}/analytics/legacy-launches`, { signal: controller.signal })
        if (!response.ok) throw new Error('Telemetry unavailable')
        const summary = parseSummary(await response.json())
        if (!current) return
        cache.current.set(projectId, summary)
        setState({ projectId, loading: false, error: false })
      } catch {
        if (current) setState({ projectId, loading: false, error: true })
      }
    })()
    return () => { current = false; controller.abort() }
  }, [projectId, revision])
  const summary = cache.current.get(projectId)
  const loading = state.projectId !== projectId || state.loading
  const failed = state.projectId === projectId && state.error
  return <section className="rounded-xl border border-border/40 bg-card/40 p-4 space-y-3" aria-label={t('legacyUsage.title')}>
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-medium">{t('legacyUsage.title')}</h2>
      <button type="button" disabled={loading} onClick={() => refresh(value => value + 1)} className="text-xs underline disabled:opacity-50">{t('legacyUsage.refresh')}</button>
    </div>
    <p className="text-xs text-muted-foreground">{t('legacyUsage.scope')}</p>
    {failed && <p role="status" className="text-xs text-destructive">{t('legacyUsage.unavailable')}</p>}
    {!summary && loading && <p role="status" className="text-xs text-muted-foreground">{t('legacyUsage.loading')}</p>}
    {summary && <>
      <p className="text-sm">{t('legacyUsage.total', { count: summary.total })}</p>
      <dl className="grid gap-2 text-xs sm:grid-cols-3">
        {kinds.map(kind => <div key={kind}><dt className="text-muted-foreground">{t(`legacyUsage.kinds.${kind}`)}</dt><dd className="font-mono tabular-nums">{summary.byKind[kind]}</dd></div>)}
      </dl>
      {summary.lastAt && <p className="text-xs text-muted-foreground">{t('legacyUsage.last')} <time dateTime={summary.lastAt}>{new Date(summary.lastAt).toLocaleString()}</time></p>}
    </>}
    <p className="text-xs text-muted-foreground">{t('legacyUsage.evidence')}</p>
  </section>
}
