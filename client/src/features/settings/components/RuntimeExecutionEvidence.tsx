import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { repositoryApiBase } from '../../projects/lib/project-repositories'
import type { RuntimeEfficiencySummary } from '../lib/runtime-efficiency'
import { Button } from '../../../components/ui/button'
interface Source { id: string; displayPath: string }
interface Check { id: string; label: string; repositoryId: string; status: string; disposition: string; planHash: string; candidateHash: string; sources: Source[]; origin?: string[]; reuseReason?: string; reusedFrom?: string }
interface Page { available: boolean; items?: Check[]; text?: string; nextCursor?: string; truncated: boolean }

/** Shared by Board and Mission through AgentRuntimeRuns; each pane owns its scrolling. */
export function RuntimeExecutionEvidence({ projectId, runId, summary, historical = false }: { projectId: string; runId: string; summary?: RuntimeEfficiencySummary; historical?: boolean }) {
  const { t } = useTranslation('agentRuntime')
  const [open, setOpen] = useState(false)
  const [checks, setChecks] = useState<Check[]>([])
  const [nextList, setNextList] = useState<string>()
  const [selected, setSelected] = useState<{ id: string; section: string; sourceId?: string }>()
  const [page, setPage] = useState<Page>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const endpoint = `${repositoryApiBase(projectId)}/agent-runtime/runs/${encodeURIComponent(runId)}/evidence`
  const currentEndpoint = useRef(endpoint)
  currentEndpoint.current = endpoint
  useEffect(() => () => { currentEndpoint.current = '' }, [])
  async function read(query: Record<string, string> = {}, signal?: AbortSignal): Promise<Page> {
    const response = await fetch(`${endpoint}?${new URLSearchParams(query)}`, { cache: 'no-store', signal })
    const data = await response.json()
    if (!response.ok || data.schemaVersion !== 1 || !data.available) throw new Error(t('evidence.unavailable'))
    return data
  }
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setBusy(true); setError(''); setChecks([]); setNextList(undefined); setPage(undefined); setSelected(undefined)
    read({}, controller.signal).then(data => { if (!controller.signal.aborted) { setChecks(data.items ?? []); setNextList(data.nextCursor) } })
      .catch(() => { if (!controller.signal.aborted) setError(t('evidence.unavailable')) })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
    // Opening or a new persisted measurement replaces the previous result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, endpoint, summary?.checks.executed, summary?.checks.reused, summary?.currentEvidenceIds.join(',')])
  async function view(selection: NonNullable<typeof selected>, cursor?: string) {
    setBusy(true); setError(''); setSelected(selection)
    try { const result = await read({ ...selection, ...(cursor ? { cursor } : {}) }); if (currentEndpoint.current === endpoint) setPage(result) }
    catch { if (currentEndpoint.current === endpoint) { setPage(undefined); setError(t('evidence.unavailable')) } }
    finally { if (currentEndpoint.current === endpoint) setBusy(false) }
  }
  return <details className="min-h-0 rounded-md border border-border" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{t('evidence.title')}</summary>
    <div className="max-h-96 min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3" tabIndex={0} aria-label={t('evidence.title')}>
      {summary && <div className="space-y-2 text-xs">
        <p>{t('evidence.acceptance')}: {t(`evidence.acceptanceStatus.${summary.technicalAcceptance}`)}</p>
        <p>{t('evidence.calls')}: {summary.invocations.complete ? summary.invocations.total : t('evidence.unknown')} · {t('evidence.executed')}: {summary.checks.executed ?? t('evidence.unknown')} · {t('evidence.reused')}: {summary.checks.reused ?? t('evidence.unknown')}</p>
        {summary.roles.map(role => <p key={role.role}>{t(`roles.${role.role}`)} · {t('evidence.requested')}: {role.provider ?? t('evidence.unknown')} / {role.model ?? t('efficiency.providerDefault')} · {role.effort ?? t('efficiency.providerDefault')} · {t(`evidence.origins.${role.origin}`, { defaultValue: role.origin })} {role.tier === 'escalation' && `(${t('efficiency.escalationModel')})`} · {t('evidence.reported')}: {role.observedModel ?? t('evidence.unknown')} / {role.observedEffort ?? t('evidence.unknown')}</p>)}
        {summary.escalations?.map(route => <p key={route.attemptId} className="text-muted-foreground">{t(`roles.${route.role}`)} → {route.model ?? t('efficiency.providerDefault')}: {t(`efficiency.triggers.${route.role}`)}</p>)}
      </div>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {busy && <p role="status" className="text-xs">{t('loading')}</p>}
      {checks.map(check => <div key={check.id} className="space-y-2 border-t pt-2 text-xs">
        <p className="break-words font-medium">{check.repositoryId} · {check.label}</p>
        <p>{t(`evidence.status.${check.status}`, { defaultValue: check.status })} · {t(`evidence.disposition.${check.disposition}`, { defaultValue: check.disposition })} · {!historical && summary && summary.currentEvidenceIds.includes(check.id) && check.planHash === summary.planHash && check.candidateHash === summary.candidateHash ? t('evidence.current') : t('evidence.historical')}</p>
        {check.origin && <p>{t('evidence.origin')}: {check.origin.map(origin => t(`evidence.origins.${origin}`, { defaultValue: origin })).join(', ')}</p>}
        {check.reuseReason && <p className="text-muted-foreground">{t(check.reuseReason === 'reuse-never' ? 'evidence.reuseDisabled' : check.reuseReason === 'snapshot-local-identities-match' ? 'evidence.reuseConfirmed' : check.reuseReason === 'snapshot-inputs-changed-during-verification' ? 'evidence.inputsChanged' : 'evidence.reuseUnproven')}</p>}
        <div className="flex flex-wrap gap-1">
          {check.reusedFrom && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void view({ id: check.reusedFrom!, section: 'stdout' })}>{t('evidence.original')}</Button>}
          {(['stdout', 'stderr'] as const).map(section => <Button key={section} size="sm" variant="ghost" disabled={busy} onClick={() => void view({ id: check.id, section })}>{section}</Button>)}
          {check.sources?.map(source => <Button key={source.id} size="sm" variant="ghost" disabled={busy} onClick={() => void view({ id: check.id, section: 'source', sourceId: source.id })}>{source.displayPath}</Button>)}
        </div>
      </div>)}
      {nextList && <Button size="sm" disabled={busy} onClick={async () => {
        setBusy(true)
        try { const data = await read({ cursor: nextList }); if (currentEndpoint.current === endpoint) { setChecks(current => [...new Map([...current, ...(data.items ?? [])].map(check => [check.id, check])).values()]); setNextList(data.nextCursor) } }
        catch { if (currentEndpoint.current === endpoint) setError(t('evidence.unavailable')) }
        finally { if (currentEndpoint.current === endpoint) setBusy(false) }
      }}>{t('evidence.moreChecks')}</Button>}
      {page && <div className="min-h-0 space-y-2 border-t pt-2">
        <pre className="max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs" tabIndex={0} aria-label={t('evidence.output')}>{page.text || t('evidence.empty')}</pre>
        {page.truncated && <p className="text-xs text-muted-foreground">{t('evidence.truncated')}</p>}
        {page.nextCursor && selected && <Button size="sm" disabled={busy} onClick={() => void view(selected, page.nextCursor)}>{t('evidence.nextPage')}</Button>}
      </div>}
    </div>
  </details>
}
