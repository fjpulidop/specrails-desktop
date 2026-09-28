import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { repositoryApiBase } from '../../projects/lib/project-repositories'
interface RetentionReport {
  dryRun: boolean
  runs: Array<{ runId: string; state: string; reasons: string[]; error?: string }>
  packages: string[]
  errors: string[]
}
/** Closed by default: no background maintenance or polling. Keyed by project so
 * neither a draft policy nor a pending response can cross project selection. */
export function RuntimeRetention(props: { projectId: string; onChanged(): void }) {
  return <RetentionForm key={props.projectId} {...props} />
}
function RetentionForm({ projectId, onChanged }: { projectId: string; onChanged(): void }) {
  const { t } = useTranslation('agentRuntime')
  const [open, setOpen] = useState(false), [days, setDays] = useState(''), [saved, setSaved] = useState<string | undefined>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [report, setReport] = useState<RetentionReport | null>(null)
  const mounted = useRef(true), pending = useRef(false)
  const endpoint = `${repositoryApiBase(projectId)}/agent-runtime/retention`
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!open || saved !== undefined) return
    setError('')
    const abort = new AbortController()
    void fetch(endpoint, { signal: abort.signal }).then(async response => {
      const body = await response.json()
      if (!response.ok || !body.policy || body.policy.days !== null && (!Number.isSafeInteger(body.policy.days) || body.policy.days < 1 || body.policy.days > 3650)) throw Error(t('retention.failed'))
      if (!abort.signal.aborted) { const value = body.policy.days === null ? '' : String(body.policy.days); setDays(value); setSaved(value) }
    }).catch(() => { if (!abort.signal.aborted) setError(t('retention.failed')) })
    return () => abort.abort()
  }, [open, saved, endpoint, t])
  const valid = days === '' || /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 3650
  async function action(kind: 'save' | 'preview' | 'collect') {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    // A new inspection supersedes the old one: never offer deletion from a
    // preview that a later preview or collection attempt could not confirm.
    if (kind !== 'save') setReport(null)
    try {
      const response = await fetch(kind === 'save' ? endpoint : `${endpoint}/collect`, {
        method: kind === 'save' ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'save' ? { days: days === '' ? null : Number(days) } : { dryRun: kind !== 'collect' }),
      })
      const body = await response.json()
      if (!response.ok) throw Error(body.message ?? t('retention.failed'))
      if (!mounted.current) return
      if (kind === 'save') { setSaved(days); setReport(null) }
      else {
        if (!Array.isArray(body.runs) || !Array.isArray(body.packages) || !Array.isArray(body.errors) || typeof body.dryRun !== 'boolean') throw Error(t('retention.failed'))
        setReport(body)
        if (kind === 'collect') onChanged()
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t('retention.failed')) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const candidates = report?.runs.filter(run => run.state === 'eligible').length ?? 0
  return <details className="rounded-md border border-border p-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium">{t('retention.title')}</summary>
    {open && <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{t('retention.description')}</p>
      {saved === undefined && !error && <p role="status" className="text-xs">{t('retention.loading')}</p>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={days === ''} disabled={busy || saved === undefined} onChange={event => { setDays(event.target.checked ? '' : '90'); setReport(null) }} />{t('retention.forever')}</label>
      {days !== '' && <label className="flex items-center gap-2 text-sm">{t('retention.days')}<input type="number" min={1} max={3650} className="w-24 rounded border border-input bg-background px-2 py-1" value={days} disabled={busy} onChange={event => { setDays(event.target.value || '0'); setReport(null) }} /></label>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || saved === undefined || saved === days || !valid} onClick={() => void action('save')}>{t('retention.save')}</Button>
        <Button size="sm" variant="secondary" disabled={busy || saved === undefined || saved !== days || days === ''} onClick={() => void action('preview')}>{t('retention.preview')}</Button>
        {report?.dryRun && (candidates > 0 || report.packages.length > 0) && <Button size="sm" variant="destructive" disabled={busy || saved !== days} onClick={() => void action('collect')}>{t('retention.collect')}</Button>}
      </div>
      {report && <div className="space-y-2 text-xs" role="status">
        <p>{t(report.dryRun ? 'retention.previewSummary' : 'retention.collectedSummary', { runs: report.runs.filter(run => ['eligible', 'expired', 'cleanup_pending'].includes(run.state)).length, packages: report.packages.length })}</p>
        <ul className="space-y-1">{report.runs.slice(0, 20).map(run => <li key={run.runId}><code>{run.runId}</code>: {t(`retention.states.${run.state}`, { defaultValue: run.state })}{run.reasons.length > 0 && ` — ${run.reasons.map(reason => t(`retention.reasons.${reason}`, { defaultValue: reason })).join(', ')}`}{run.error && ` — ${run.error}`}</li>)}</ul>
        {report.runs.length > 20 && <p>{t('retention.more', { count: report.runs.length - 20 })}</p>}
        {report.errors.map((message, index) => <p key={index} className="text-destructive">{message}</p>)}
      </div>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>}
  </details>
}
