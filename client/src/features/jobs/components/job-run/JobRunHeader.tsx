import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Loader2, MessageCircleQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../../lib/utils'
import { isLocalEngineId } from '../../../providers/lib/provider-capabilities'
import type { EventRow, JobSummary, PhaseDefinition } from '../../../../types'
import type { PhaseMap } from '../../hooks/usePipeline'
import type { RuntimeRun } from '../../../settings/lib/agent-runtime'
import { Badge } from '../../../../components/ui/badge'
import { Button } from '../../../../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip'
import { PipelineProgress } from '../PipelineProgress'
import { AgentRuntimeMetrics } from '../../../settings/components/AgentRuntimeMetrics'
import { RuntimeExecutionEvidence } from '../../../settings/components/RuntimeExecutionEvidence'
import { RuntimeSteering } from '../../../settings/components/RuntimeSteering'
import { useRuntimeRuns } from './useRuntimeRuns'
import {
  extractModifiedFiles,
  finalMetricsFor,
  formatPipelineCost,
  formatPipelineTokens,
  formatTokens,
  formatWallClock,
  loadJobRunDetailsOpen,
  resolveActivityLabel,
  saveJobRunDetailsOpen,
  useJobActivity,
  type JobRunSurface,
  type PipelineTotals,
} from './job-run-model'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'running' | 'queued' | 'failed' | 'canceled'

const STATUS_BADGE: Record<string, { variant: BadgeVariant; labelKey: string; tooltipKey: string }> = {
  running: { variant: 'running', labelKey: 'statusLabel.running', tooltipKey: 'statusTooltip.running' },
  completed: { variant: 'success', labelKey: 'statusLabel.completed', tooltipKey: 'statusTooltip.completed' },
  failed: { variant: 'failed', labelKey: 'statusLabel.failed', tooltipKey: 'statusTooltip.failed' },
  canceled: { variant: 'canceled', labelKey: 'statusLabel.canceled', tooltipKey: 'statusTooltip.canceled' },
  queued: { variant: 'queued', labelKey: 'statusLabel.queued', tooltipKey: 'statusTooltip.queued' },
  zombie_terminated: { variant: 'failed', labelKey: 'statusLabel.zombie', tooltipKey: 'statusTooltip.zombie' },
  skipped: { variant: 'queued', labelKey: 'statusLabel.skipped', tooltipKey: 'statusTooltip.skipped' },
}

export interface JobRunHeaderProps {
  job: JobSummary
  events: EventRow[]
  phases: PhaseMap
  phaseDefinitions: PhaseDefinition[]
  /** Project whose agent-runtime continuation is polled. Absent ⇒ no runtime
   *  section (the modal without an explicit scope, unit tests). */
  projectId?: string | null
  /** Chrome only (border/background) — never content. */
  variant: JobRunSurface
  pipelineTotals?: PipelineTotals | null
  /** Surface-owned buttons (Cancel / Re-run / Export) rendered on row 1. */
  actions?: ReactNode
}

/**
 * The ONE header both job surfaces render (routed Job Detail page + mission-mode
 * JobDetailModal). Row 1: status · elapsed · phase · activity · steps · actions.
 * Row 2: the pipeline chips, once. A collapsed "Details" disclosure holds every
 * number — only real ones: provider-reported live counters while running, the
 * authoritative totals after exit, the runtime continuation when it exists.
 * Nothing is ever a placeholder or an estimate.
 */
export function JobRunHeader({ job, events, phases, phaseDefinitions, projectId, variant, pipelineTotals, actions }: JobRunHeaderProps) {
  const { t } = useTranslation('jobs')
  const { t: tRuntime } = useTranslation('agentRuntime')
  const isRunning = job.status === 'running'
  const isQueued = job.status === 'queued'
  const isLoopJob = job.command.startsWith('loop:')
  const statusInfo = STATUS_BADGE[job.status] ?? STATUS_BADGE.queued

  // Live wall-clock tick (1 s) while running — the only genuinely live number.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isRunning) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isRunning])
  const elapsed = job.finished_at
    ? formatWallClock(job.started_at, job.finished_at)
    : isRunning
      ? formatWallClock(job.started_at, now)
      : '—'

  const activity = useJobActivity(job.id, events)
  const runtime = useRuntimeRuns(projectId, { jobId: job.id, enabled: !!projectId })
  const run: RuntimeRun | undefined = runtime.runs[0]

  const [detailsOpen, setDetailsOpen] = useState(() => loadJobRunDetailsOpen(variant))
  const toggleDetails = (open: boolean) => { setDetailsOpen(open); saveJobRunDetailsOpen(variant, open) }

  // ── Phase + activity line ──────────────────────────────────────────────
  const runningPhaseLabel = useMemo(() => {
    const def = phaseDefinitions.find((d) => phases[d.key] === 'running')
    return def?.label ?? null
  }, [phases, phaseDefinitions])
  const runtimePhaseLabel = run?.nextStep ? tRuntime(`roles.${run.nextStep}`, { defaultValue: run.nextStep }) : null
  const phaseLabel = runningPhaseLabel ?? runtimePhaseLabel

  const { key: activityKey, arg: activityArg } = resolveActivityLabel(activity, isRunning)
  const activityLabel = activityArg != null
    ? t(`statusPanel.activity.${activityKey}`, { arg: activityArg })
    : t(`statusPanel.activity.${activityKey}`)
  const liveLine = isRunning
    ? (phaseLabel ? t('runHeader.phaseActivity', { phase: phaseLabel, activity: activityLabel }) : activityLabel)
    : run && !run.active && run.nextStep && (run.canResume || run.pendingQuestion || run.pendingApproval)
      ? t('runHeader.phaseActivity', {
          phase: tRuntime(`runs.status.${run.status}`, { defaultValue: run.status }),
          activity: tRuntime('runs.phase', { phase: runtimePhaseLabel }),
        })
      : null

  const stepsLabel = isLoopJob && isRunning && activity.steps > 0 ? t('statusPanel.steps', { count: activity.steps }) : null

  // ── Details content ───────────────────────────────────────────────────
  const final = finalMetricsFor(job)
  const isTerminal = !isRunning && !isQueued
  const modifiedFiles = useMemo(() => (isTerminal ? extractModifiedFiles(events) : []), [events, isTerminal])
  const hasLiveCounters = isRunning && activity.turns > 0
  const runtimeError = runtime.runs.length > 0 ? runtime.error : ''
  const answerable = !!run?.pendingQuestion && !!run.canResume && !run.recoverableSteps.length
  const hasRuntimeDetails = !!run && !!projectId
  const hasDetails = isTerminal || hasLiveCounters || hasRuntimeDetails || !!runtimeError

  // ── Runtime actions (compact, only when the run exposes them) ─────────
  const busy = runtime.busy !== null
  const runtimeActions = run ? (
    <>
      {run.canResume && !answerable && (
        <Button size="sm" className="h-7" disabled={busy} onClick={() => void runtime.act(run, run.recoverableSteps.length ? 'recover' : run.pendingApproval ? 'approve' : 'resume')}>
          {run.recoverableSteps.length ? tRuntime('runs.recover') : run.pendingApproval ? tRuntime('runs.approve') : tRuntime('runs.resume')}
        </Button>
      )}
      {answerable && (
        <Button size="sm" variant="outline" className="h-7 border-accent-warning/40 text-accent-warning hover:bg-accent-warning/10" onClick={() => toggleDetails(true)}>
          <MessageCircleQuestion className="w-3.5 h-3.5 mr-1.5" aria-hidden />
          {t('runHeader.questionPending')}
        </Button>
      )}
      {run.canSettle && (
        <Button size="sm" className="h-7" disabled={busy} onClick={() => void runtime.act(run, 'settle')}>{tRuntime('runs.prepareDelivery')}</Button>
      )}
      {run.canCancel && (
        <Button size="sm" variant="secondary" className="h-7" disabled={busy} onClick={() => void runtime.act(run, 'cancel')}>{tRuntime('runs.cancel')}</Button>
      )}
    </>
  ) : null

  const frameClass = variant === 'glass'
    ? 'border-b border-border/30 bg-surface/30'
    : 'border-b border-border bg-background'

  return (
    <div data-testid="job-run-header" className={cn('shrink-0', frameClass)}>
      {/* Row 1 — status · elapsed · phase · activity · steps · actions */}
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 min-w-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <div><Badge variant={statusInfo.variant}>{t(statusInfo.labelKey)}</Badge></div>
          </TooltipTrigger>
          <TooltipContent>{t(statusInfo.tooltipKey)}</TooltipContent>
        </Tooltip>
        <span
          className={cn('inline-flex items-center gap-1.5 text-xs tabular-nums', isRunning ? 'text-accent-info font-medium' : 'text-muted-foreground')}
          title={isRunning ? t('statusPanel.liveTooltip') : t('statusPanel.duration')}
        >
          {isRunning && <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-info animate-pulse" aria-hidden />}
          {elapsed}
        </span>
        {liveLine && (
          <span className="flex items-center gap-1.5 min-w-0 flex-1 basis-40 text-xs text-muted-foreground">
            {isRunning && <Loader2 className="w-3 h-3 shrink-0 text-accent-info animate-spin" aria-hidden />}
            <span className="truncate" data-testid="job-run-activity">{liveLine}</span>
          </span>
        )}
        {!liveLine && <span className="flex-1" />}
        {stepsLabel && <span className="text-[11px] text-muted-foreground/70 tabular-nums shrink-0">{stepsLabel}</span>}
        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          {runtimeActions}
          {actions}
          {hasDetails && (
            <button
              type="button"
              onClick={() => toggleDetails(!detailsOpen)}
              aria-expanded={detailsOpen}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-surface/60 transition-colors"
            >
              {t('runHeader.details')}
              <ChevronDown className={cn('w-3.5 h-3.5 transition-transform duration-150', detailsOpen && 'rotate-180')} aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* Row 2 — pipeline chips, exactly once */}
      {phaseDefinitions.length > 0 && (
        <div className="px-3 pb-2 overflow-x-auto">
          <PipelineProgress phases={phases} phaseDefinitions={phaseDefinitions} />
        </div>
      )}

      {/* Details — collapsed by default, remembered per surface */}
      {hasDetails && detailsOpen && (
        <div data-testid="job-run-details" className="px-3 pb-3 space-y-3 border-t border-border/20 pt-3 text-xs">
          {hasLiveCounters && (
            <div>
              <div className="grid grid-cols-2 gap-2 max-w-sm">
                <Metric label={t('statusPanel.turns')} value={String(activity.turns)} />
                <Metric label={t('statusPanel.tokens')} value={formatTokens(activity.tokens)} />
              </div>
              <p className="text-[10px] text-muted-foreground/60 mt-1">{t('runHeader.liveReported')}</p>
            </div>
          )}

          {isTerminal && (
            <div className="grid grid-cols-3 gap-2 max-w-lg">
              <Metric
                label={t('statusPanel.cost')}
                value={final.cost}
                valueClass="text-yellow-400 aurora-light:text-accent-warning"
                naCaption={isLocalEngineId(job.provider) ? t('statusPanel.costUnknownLocal') : t('statusPanel.notAvailable')}
                naTooltip={isLocalEngineId(job.provider) ? t('statusPanel.costUnknownLocalTooltip') : undefined}
              />
              <Metric label={t('statusPanel.turns')} value={final.turns} naCaption={t('statusPanel.notAvailable')} />
              <Metric label={t('statusPanel.tokens')} value={final.tokens} naCaption={t('statusPanel.notAvailable')} />
            </div>
          )}

          {isTerminal && pipelineTotals && (
            <div>
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1.5">
                {t('statusPanel.pipelineTotal', { count: pipelineTotals.jobCount })}
              </p>
              <div className="grid grid-cols-2 gap-2 max-w-sm">
                <Metric label={t('statusPanel.totalCost')} value={formatPipelineCost(pipelineTotals)} valueClass="text-yellow-400 aurora-light:text-accent-warning" />
                <Metric label={t('statusPanel.totalTokens')} value={formatPipelineTokens(pipelineTotals)} />
              </div>
              {pipelineTotals.hasNullCost && !pipelineTotals.costUnavailable && (
                <p data-testid="pipeline-partial-hint" className="text-[10px] text-muted-foreground/70 mt-1.5" title={t('statusPanel.pipelinePartialTooltip')}>
                  {t('statusPanel.pipelinePartial', { count: pipelineTotals.nullCostCount ?? 0 })}
                </p>
              )}
              {pipelineTotals.costUnavailable && (
                <p data-testid="pipeline-cost-unavailable" className="text-[10px] text-muted-foreground/70 mt-1.5">{t('statusPanel.pipelineCostUnavailable')}</p>
              )}
              {(pipelineTotals.nullTokenCount ?? 0) > 0 && (
                <p data-testid="pipeline-usage-coverage-hint" className="text-[10px] text-muted-foreground/70 mt-1" title={t('statusPanel.pipelineUsageTooltip')}>
                  {pipelineTotals.tokensUnavailable
                    ? t('statusPanel.pipelineUsageUnavailable')
                    : t('statusPanel.pipelineUsagePartial', { count: pipelineTotals.nullTokenCount ?? 0 })}
                </p>
              )}
            </div>
          )}

          {modifiedFiles.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1.5">{t('statusPanel.filesModified')}</p>
              <div className="flex flex-wrap gap-1.5">
                {modifiedFiles.map((f) => (
                  <code key={f} className="text-[10px] font-mono bg-muted/30 px-2 py-0.5 rounded text-cyan-400/80 aurora-light:text-accent-info">{f}</code>
                ))}
              </div>
            </div>
          )}

          {(run || runtimeError) && projectId && (
            <section aria-label={tRuntime('runs.implementation')} className="space-y-2" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
              {runtimeError && <p role="alert" className="text-destructive">{runtimeError}</p>}
              {run?.historical && <p className="text-muted-foreground">{tRuntime('evidence.historical')}</p>}
              {run?.status === 'succeeded' && <p className="text-muted-foreground">{tRuntime('runs.reviewDelivery')}</p>}
              {run?.canResume && <p className="text-muted-foreground">{tRuntime('runs.preserveProgress')}</p>}
              {run?.error && <p className="text-destructive">{run.error}</p>}
              {run?.pendingApproval?.reason && <p className="text-muted-foreground">{run.pendingApproval.reason}</p>}
              {run?.pendingQuestion && (
                <div className="space-y-2">
                  <p className="font-medium">{tRuntime('runs.question')}</p>
                  <p className="whitespace-pre-wrap">{run.pendingQuestion.question}</p>
                  {answerable && (
                    <>
                      <label className="block space-y-1">{tRuntime('runs.answerLabel')}
                        <textarea
                          className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                          maxLength={20000}
                          placeholder={tRuntime('runs.answerPlaceholder')}
                          value={runtime.answers[run.runId] ?? ''}
                          onChange={(event) => runtime.setAnswer(run.runId, event.target.value)}
                        />
                      </label>
                      <Button size="sm" disabled={busy || !runtime.answers[run.runId]?.trim()} onClick={() => void runtime.act(run, 'answer')}>
                        {tRuntime('runs.answer')}
                      </Button>
                    </>
                  )}
                </div>
              )}
              {run?.metrics && <AgentRuntimeMetrics metrics={run.metrics} />}
              {run && <RuntimeExecutionEvidence projectId={projectId} runId={run.runId} summary={run.efficiencySummary} historical={run.historical} />}
              {run && <RuntimeSteering projectId={projectId} run={run} onAccepted={runtime.refresh} />}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

/** One metric tile. A null value renders an em-dash + an honest caption instead
 *  of a fake 0; never a "calculated later" placeholder. */
function Metric({ label, value, valueClass, naCaption, naTooltip }: {
  label: string
  value: string | null
  valueClass?: string
  naCaption?: string
  naTooltip?: string
}) {
  return (
    <div className="bg-muted/20 rounded-lg px-2.5 py-1.5" title={value == null ? naTooltip : undefined}>
      <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">{label}</p>
      <p className={cn('text-sm font-semibold tabular-nums', value != null ? valueClass : 'text-muted-foreground')}>{value ?? '—'}</p>
      {value == null && naCaption && <p className="text-[10px] text-muted-foreground/40">{naCaption}</p>}
    </div>
  )
}
