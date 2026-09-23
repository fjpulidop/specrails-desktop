import { RuntimeExecutionEvidence } from './RuntimeExecutionEvidence'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Button } from '../../../components/ui/button'
import { AgentRuntimeMetrics } from './AgentRuntimeMetrics'
import { useRuntimeRuns } from '../../jobs/components/job-run/useRuntimeRuns'

/**
 * Settings "Saved executions" list (and the legacy contextual rail card). The
 * job-detail surfaces no longer mount this — they render the same runs through
 * `JobRunHeader`, which consumes the SAME `useRuntimeRuns` hook.
 * Explicit continuation keeps frozen scope; it never starts a fresh delivery.
 */
export function AgentRuntimeRuns({ projectId, onViewLog, jobId, railIndex, contextual = false }: { projectId: string; onViewLog?: () => void; jobId?: string; railIndex?: number; contextual?: boolean }) {
  const { t } = useTranslation('agentRuntime')
  const { runs, error, busy, answers, setAnswer, act, refresh } = useRuntimeRuns(projectId, { jobId, railIndex })

  if (contextual && !runs.length && !error) return null
  return <section className="space-y-3 border-t border-border p-3" aria-label={t(contextual ? 'runs.implementation' : 'runs.title')} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{t(contextual ? 'runs.implementation' : 'runs.title')}</h3><Button size="sm" variant="ghost" onClick={refresh}>{t('runs.refresh')}</Button></div>
    {!contextual && <p className="text-xs text-muted-foreground">{t('runs.hint')}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!runs.length && !error && <p className="text-xs text-muted-foreground">{t('runs.empty')}</p>}
    {runs.map((run) => <div key={run.runId} className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">{!contextual && <code className="break-all text-xs">{run.runId}</code>}<span className="text-xs font-medium">{t(`runs.status.${run.active ? 'running' : run.status}`, { defaultValue: run.status })}</span></div>
      {run.historical && <p className="text-xs text-muted-foreground">{t('evidence.historical')}</p>}
      {run.nextStep && <p className="text-xs">{t('runs.phase', { phase: t(`roles.${run.nextStep}`, { defaultValue: run.nextStep }) })}</p>}
      {run.canResume && <p className="text-xs text-muted-foreground">{t('runs.preserveProgress')}</p>}
      {run.status === 'succeeded' && <p className="text-xs text-muted-foreground">{t('runs.reviewDelivery')}</p>}
      {run.error && <p className="text-xs text-destructive">{run.error}</p>}
      {run.metrics && <AgentRuntimeMetrics metrics={run.metrics} />}
      <RuntimeExecutionEvidence projectId={projectId} runId={run.runId} summary={run.efficiencySummary} historical={run.historical} />
      {run.pendingApproval?.reason && <p className="text-xs text-muted-foreground">{run.pendingApproval.reason}</p>}
      {run.pendingQuestion && <div className="space-y-2">
        <p className="text-xs font-medium">{t('runs.question')}</p>
        <p className="whitespace-pre-wrap text-xs">{run.pendingQuestion.question}</p>
        {run.canResume && !run.recoverableSteps.length && <label className="block space-y-1 text-xs">{t('runs.answerLabel')}
          <textarea className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1 text-sm" maxLength={20000} placeholder={t('runs.answerPlaceholder')} value={answers[run.runId] ?? ''} onChange={(event) => setAnswer(run.runId, event.target.value)} />
        </label>}
      </div>}
      <div className="flex flex-wrap gap-2">
        {!jobId && <Link className="inline-flex items-center rounded-md border border-border px-3 py-1 text-xs hover:bg-muted" to={`/jobs/${encodeURIComponent(run.runId)}`} onClick={onViewLog}>{t('runs.viewLog')}</Link>}
        {run.canResume && (run.pendingQuestion && !run.recoverableSteps.length
          ? <Button size="sm" disabled={busy !== null || !answers[run.runId]?.trim()} onClick={() => void act(run, 'answer')}>{t('runs.answer')}</Button>
          : <Button size="sm" disabled={busy !== null} onClick={() => void act(run, run.recoverableSteps.length ? 'recover' : run.pendingApproval ? 'approve' : 'resume')}>{run.recoverableSteps.length ? t('runs.recover') : run.pendingApproval ? t('runs.approve') : t('runs.resume')}</Button>)}
        {run.canSettle && <Button size="sm" disabled={busy !== null} onClick={() => void act(run, 'settle')}>{t('runs.prepareDelivery')}</Button>}
        {run.canCancel && <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void act(run, 'cancel')}>{t('runs.cancel')}</Button>}
        {!run.canCancel && run.canDismiss && contextual && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(run, 'dismiss')}>{t('runs.dismiss')}</Button>}
      </div>
    </div>)}
  </section>
}
