import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { repositoryApiBase } from '../../lib/project-repositories'
import type { RuntimeRun } from '../../lib/agent-runtime'
import { Button } from '../ui/button'

/** Explicit continuation keeps frozen scope; it never starts a fresh delivery. */
export function AgentRuntimeRuns({ projectId }: { projectId: string }) {
  const { t } = useTranslation('agentRuntime')
  const [runs, setRuns] = useState<RuntimeRun[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const mounted = useRef(true)
  const endpoint = `${repositoryApiBase(projectId)}/agent-runtime/runs`
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const response = await fetch(endpoint, { cache: 'no-store' })
        if (!response.ok) throw new Error()
        const data = await response.json() as { runs?: RuntimeRun[] }
        if (!Array.isArray(data.runs)) throw new Error()
        if (!cancelled) { setRuns(data.runs); setError('') }
      } catch { if (!cancelled) setError(t('runs.loadFailed')) }
      finally { if (!cancelled) timer = setTimeout(() => void refresh(), 10000) }
    }
    void refresh()
    return () => { cancelled = true; mounted.current = false; clearTimeout(timer) }
  }, [endpoint, revision, t])

  async function act(run: RuntimeRun, action: 'resume' | 'approve' | 'recover' | 'answer' | 'cancel') {
    setBusy(run.runId); setError('')
    try {
      const body = action === 'approve' ? { approve: [run.pendingApproval!.stepId] } : action === 'recover' ? { recover: run.recoverableSteps } : action === 'answer' ? { answer: answers[run.runId]!.trim() } : {}
      const response = await fetch(`${endpoint}/${encodeURIComponent(run.runId)}/${action === 'cancel' ? 'cancel' : 'resume'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!response.ok) {
        const data = await response.json() as { message?: string }
        throw new Error(data.message ?? t('runs.actionFailed'))
      }
      if (mounted.current) { if (action === 'answer') setAnswers((value) => ({ ...value, [run.runId]: '' })); setRevision((value) => value + 1) }
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : t('runs.actionFailed')) }
    finally { if (mounted.current) setBusy(null) }
  }

  return <section className="space-y-3 border-t border-border pt-5" aria-label={t('runs.title')}>
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{t('runs.title')}</h3><Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>{t('runs.refresh')}</Button></div>
    <p className="text-xs text-muted-foreground">{t('runs.hint')}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!runs.length && !error && <p className="text-xs text-muted-foreground">{t('runs.empty')}</p>}
    {runs.map((run) => <div key={run.runId} className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><code className="break-all text-xs">{run.runId}</code><span className="text-xs font-medium">{t(`runs.status.${run.active ? 'running' : run.status}`, { defaultValue: run.status })}</span></div>
      {run.nextStep && <p className="text-xs">{t('runs.phase', { phase: t(`roles.${run.nextStep}`, { defaultValue: run.nextStep }) })}</p>}
      {run.error && <p className="text-xs text-destructive">{run.error}</p>}
      {run.pendingApproval?.reason && <p className="text-xs text-muted-foreground">{run.pendingApproval.reason}</p>}
      {run.pendingQuestion && <div className="space-y-2">
        <p className="text-xs font-medium">{t('runs.question')}</p>
        <p className="whitespace-pre-wrap text-xs">{run.pendingQuestion.question}</p>
        {run.canResume && !run.recoverableSteps.length && <label className="block space-y-1 text-xs">{t('runs.answerLabel')}
          <textarea className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1 text-sm" maxLength={20000} placeholder={t('runs.answerPlaceholder')} value={answers[run.runId] ?? ''} onChange={(event) => setAnswers((value) => ({ ...value, [run.runId]: event.target.value }))} />
        </label>}
      </div>}
      <div className="flex flex-wrap gap-2">
        {run.canResume && (run.pendingQuestion && !run.recoverableSteps.length
          ? <Button size="sm" disabled={busy !== null || !answers[run.runId]?.trim()} onClick={() => void act(run, 'answer')}>{t('runs.answer')}</Button>
          : <Button size="sm" disabled={busy !== null} onClick={() => void act(run, run.recoverableSteps.length ? 'recover' : run.pendingApproval ? 'approve' : 'resume')}>{run.recoverableSteps.length ? t('runs.recover') : run.pendingApproval ? t('runs.approve') : t('runs.resume')}</Button>)}
        {run.canCancel && <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void act(run, 'cancel')}>{t('runs.cancel')}</Button>}
      </div>
    </div>)}
  </section>
}
