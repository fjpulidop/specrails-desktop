import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { loopsApi, type LoopMigrationReport, type LoopMigrationState } from '../lib/loops-api'

const STATES: LoopMigrationState[] = ['invalid', 'needs_attention', 'convertible', 'running', 'current']

/** Read-only migration check for the app-level loop library. It loads nothing
 * until asked, never converts or (un)publishes, and hands convertible loops to
 * the explicit, reviewable conversion flow. */
export function LoopMigrationPanel({ onConvert }: { onConvert(loopId: string): void }) {
  const { t } = useTranslation('loops')
  const [report, setReport] = useState<LoopMigrationReport | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function check() {
    setBusy(true); setError(''); setReport(null)
    try {
      const next = await loopsApi.migration()
      if (mounted.current) setReport(next)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error && cause.message ? cause.message : t('migration.failed'))
    } finally { if (mounted.current) setBusy(false) }
  }
  const attention = report ? report.loops.filter(loop => loop.state !== 'current') : []
  return <section className="rounded-lg border border-border p-3 space-y-2" aria-label={t('migration.title')}>
    <div className="flex items-center justify-between gap-2">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('migration.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('migration.description')}</p>
      </div>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void check()}>{busy ? t('migration.checking') : t('migration.check')}</Button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {report && <div role="status" className="space-y-2 text-xs">
      <p>{STATES.filter(state => report.summary[state] > 0).map(state => t(`migration.states.${state}`) + ': ' + report.summary[state]).join(' · ') || t('migration.empty')}</p>
      {attention.length === 0 && report.loops.length > 0 && <p className="text-muted-foreground">{t('migration.allCurrent')}</p>}
      <ul className="space-y-1">{attention.map(loop => <li key={loop.id} className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{loop.name}</span>
        <span className="text-muted-foreground">{t(`migration.states.${loop.state}`)}{loop.status === 'published' ? ` · ${t('status.published')}` : ''}</span>
        {loop.issues.slice(0, 3).map((issue, index) => <span key={index} className="text-destructive">{issue.message}</span>)}
        {loop.state === 'convertible' && <Button size="sm" variant="ghost" onClick={() => onConvert(loop.id)}>{t('actions.convert')}</Button>}
      </li>)}</ul>
    </div>}
  </section>
}
