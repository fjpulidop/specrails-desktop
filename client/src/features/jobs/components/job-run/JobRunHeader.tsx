import { RuntimeRecovery } from '../../../settings/components/RuntimeRecovery'
import { readRunQuestion } from '../../../../components/run-question/run-question'
import { focusRunQuestion } from './RunQuestionDock'
import { RailTrack } from '../../../../components/brand/RailTrack'
import { useMemo, useState, type ReactNode } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useContinueRemedies, useProviderSwitchContinue, useResolutionActions, type ProviderSwitchContinue } from '../../../recovery/hooks/useContinueRemedies'
import type { RunResolution } from './RunDetailTabs'
import { useAttemptChain } from '../../../recovery/hooks/useAttemptChain'
import { RunLineage } from '../../../recovery/components/RunLineage'
import { StoppedRunCard } from '../../../recovery/components/StoppedRunCard'
import { cn } from '../../../../lib/utils'
import type { EventRow, JobSummary, PhaseDefinition } from '../../../../types'
import type { PhaseMap } from '../../hooks/usePipeline'
import type { RuntimeRun } from '../../../settings/lib/agent-runtime'
import { RunStatePill } from '../../../../components/ui/run-state/run-state-pill'
import { Button } from '../../../../components/ui/button'
import { RunStateDot } from '../../../../components/ui/run-state/run-state-dot'
import { RailMark } from '../../../../components/brand/RailMark'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip'
import { PipelineProgress } from '../PipelineProgress'
import { AgentRuntimeMetrics } from '../../../settings/components/AgentRuntimeMetrics'
import { RuntimeEvidenceChip } from '../../../settings/components/RuntimeExecutionEvidence'
import { RuntimeSteering, RuntimeSteeringChip, steeringAcceptsInstructions } from '../../../settings/components/RuntimeSteering'
import { offersStartOver, logTailLines, openLogsAtFailure, readFailureDiagnosis, type FailureDiagnosis, type RemedyHandlers } from '../../../recovery/lib/failure-diagnosis'
import { useRuntimeRuns, type RuntimeRunsState } from './useRuntimeRuns'
import { useNow } from '../../../../hooks/useNow'
import {
  answerableRun,
  extractModifiedFiles,
  finalMetricsFor,
  formatPipelineCost,
  formatPipelineTokens,
  formatTokens,
  formatWallClock,
  resolveActivityLabel,
  useJobActivity,
  type JobRunSurface,
  type PipelineTotals,
} from './job-run-model'
import { describeJobHold, jobHoldOf, jobStatusLook } from '../../lib/job-run-state'

export interface JobRunDetailsContext {
  diagnosis: FailureDiagnosis | null
  showDiagnosis: boolean
  pendingQuestion: boolean
  diagnosisHandlers: RemedyHandlers
  diagnosisTail: readonly string[]
  /** A run the person stopped: how to continue it (Continue / Start over). Null otherwise. */
  continuityContent: ReactNode
  /** The chain behind a failed run and how a picked resolution continues it. */
  resolution: RunResolution
  /** A run that settled on a provider's usage limit: "Continue with <Provider>". Null otherwise. */
  providerSwitch: ProviderSwitchContinue | null
  hasDetails: boolean
  /** Recorded figures and runtime notes, opened from the Details button. */
  detailsContent: ReactNode
  /** The answerable question, shown in the Failure reasons tab. */
  questionContent: ReactNode
  /** Compact chips beside the tabs: verification evidence, sent instructions
   *  of a settled run. Null when the run recorded neither. */
  metaContent: ReactNode
  /** Run instructions composer, docked under the log while the run accepts them. */
  composer: ReactNode
  detailsRequest: number
  /** The status row, drawn by the run details beside their tabs so the
   *  evidence gets the height: state and time before the tabs, activity and
   *  actions after them. */
  statusLead: ReactNode
  statusTrail: ReactNode
}

export interface JobRunHeaderProps {
  renderRunDetails?(context: JobRunDetailsContext): ReactNode
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
  /**
   * Surface-owned buttons (Cancel / Re-run / Export) rendered on row 1. A function receives
   * `diagnosisOffersRetry`: true while the diagnosis card shows the retry remedy, so the surface
   * does not repeat the same action next to it.
   */
  actions?: ReactNode | ((context: { diagnosisOffersRetry: boolean }) => ReactNode)
  onOpenRun?(runId: string): void
  /** Existing "run again" of the surface; offered as the diagnosis' retry remedy. */
  onRerun?(): void
  rerunBusy?: boolean
  /** Opens the job's spec (its addenda iterate on it); offered as "Edit spec and relaunch". */
  onEditSpec?(): void
  /** Brings the failure into view in the surface's log; defaults to the loop log's last failed step. */
  onOpenLogs?(): void
  /** The surface's runtime continuation state, shared with its composer so an
   *  answer typed in either place is the same draft. Absent ⇒ the header polls its own. */
  runtime?: RuntimeRunsState
}

/**
 * The ONE header both job surfaces render (routed Job Detail page + mission-mode
 * JobDetailModal). Row 1: status · elapsed · phase · activity · steps · actions.
 * Row 2: the pipeline chips, once. The surface renderer receives truthful
 * metrics for its Details popover, the evidence/instruction chips and the
 * run-instructions composer docked under the log.
 */
export function JobRunHeader({ job, events, phases, phaseDefinitions, projectId, variant, pipelineTotals, actions, onOpenRun, onRerun, rerunBusy, onEditSpec, onOpenLogs, renderRunDetails, runtime: sharedRuntime }: JobRunHeaderProps) {
  const { t } = useTranslation('jobs')
  const { t: tRuntime } = useTranslation('agentRuntime')
  const { t: tRecovery } = useTranslation('recovery')
  // A run that stopped without settling keeps its row running (it still owns
  // its tickets and worktree): its hold says why, and nothing here is live.
  const hold = jobHoldOf(job)
  const isRunning = job.status === 'running' && !hold
  const isQueued = job.status === 'queued'
  const isLoopJob = job.command.startsWith('loop:')
  const statusInfo = jobStatusLook(job)

  // Live wall-clock tick (1 s) while running — the only genuinely live number.
  // A held run shows the time it worked until it stopped.
  const now = useNow(1000, isRunning)
  // Held periods before the last resume are excluded (server-summed `heldMs`).
  const heldMs = job.heldMs ?? 0
  const elapsed = job.finished_at
    ? formatWallClock(job.started_at, job.finished_at, heldMs)
    : isRunning
      ? formatWallClock(job.started_at, now, heldMs)
      : hold?.since
        ? formatWallClock(job.started_at, Date.parse(hold.since), heldMs)
        : '—'

  const activity = useJobActivity(job.id, events)
  const ownRuntime = useRuntimeRuns(projectId, { jobId: job.id, enabled: !!projectId && !sharedRuntime })
  const runtime = sharedRuntime ?? ownRuntime
  const run: RuntimeRun | undefined = runtime.runs[0]

  const [detailsRequest] = useState(0)

  // ── Phase + activity line ──────────────────────────────────────────────
  const runningPhaseLabel = useMemo(() => {
    const def = phaseDefinitions.find((d) => phases[d.key] === 'running')
    return def?.label ?? null
  }, [phases, phaseDefinitions])
  // A step the runtime names by a node id (`clarify`, `map[0]/ask`) has no words for the person: show none.
  const runtimePhaseLabel = run?.nextStep ? tRuntime(`roles.${run.nextStep}`, { defaultValue: '' }) || null : null
  const phaseLabel = runningPhaseLabel ?? runtimePhaseLabel

  const { key: activityKey, arg: activityArg } = resolveActivityLabel(activity, isRunning)
  const activityLabel = activityArg != null
    ? t(`statusPanel.activity.${activityKey}`, { arg: activityArg })
    : t(`statusPanel.activity.${activityKey}`)
  // A run waiting on the person says so, not "Working…".
  // The run's hold is the one classification of "needs you": a question or an approval.
  const waitsOnPerson = hold?.kind === 'question' || hold?.kind === 'approval' || !!readRunQuestion(job.question) || !!answerableRun(run)
  // A held run says why (its pill already says "Needs you" for a question); a waiting runtime run says Needs you.
  const liveLine = hold ? describeJobHold(t, hold) : waitsOnPerson ? t('common:runQuestion.notice') : isRunning
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
  const isTerminal = job.status !== 'running' && !isQueued
  const modifiedFiles = useMemo(() => (isTerminal ? extractModifiedFiles(events) : []), [events, isTerminal])
  const hasLiveCounters = isRunning && activity.turns > 0
  const runtimeError = runtime.runs.length > 0 ? runtime.error : ''
  const answerable = !!answerableRun(run)

  // ── Runtime actions (compact, only when the run exposes them) ─────────
  const busy = runtime.busy !== null
  const runtimeActions = run ? (
    <>
      {/* A run that is working right now never offers Continue (the runtime poll can lag the resume). */}
      {/* A run paused on a provider limit has its own card (resume time, Resume now, Don't resume by itself): one Continue, there. */}
      {/* A run the person paused resumes through the surface's own Resume (RunPauseControl): one control, not two. */}
      {run.canResume && !answerable && !isRunning && hold?.kind !== 'provider_limit' && job.pauseControl !== 'resume' && (
        run.engineVersion === 2 && run.recoverableSteps.length > 0 ? <RuntimeRecovery key={`${projectId}:${run.runId}`} run={run} busy={busy} onRecover={attempts => void runtime.act(run, 'recover', attempts)} /> :
        <Button size="sm" className="h-7" disabled={busy} onClick={() => void runtime.act(run, run.recoverableSteps.length ? 'recover' : run.pendingApproval ? 'approve' : 'resume')}>
          {run.recoverableSteps.length ? tRuntime('runs.recover') : run.pendingApproval ? tRuntime('runs.approve') : tRuntime('runs.resume')}
        </Button>
      )}
      {answerable && (
        // The question lives in its card above the log; this takes the person there.
        <Button size="sm" variant="outline" className="h-7 border-accent-primary/40 text-accent-primary hover:bg-accent-primary/10" onClick={() => focusRunQuestion(job.id)}>
          <MessageCircleQuestion className="w-3.5 h-3.5 mr-1.5" aria-hidden />
          {t('common:runQuestion.answer')}
        </Button>
      )}
      {run.canSettle && (
        <Button size="sm" className="h-7" disabled={busy} onClick={() => void runtime.act(run, 'settle')}>{tRuntime('runs.prepareDelivery')}</Button>
      )}
      {/* While the row is running the surface's own Stop / Cancel run ends it: one control, not two. */}
      {run.canCancel && job.status !== 'running' && (
        <Button size="sm" variant="secondary" className="h-7" disabled={busy} onClick={() => void runtime.act(run, 'cancel')}>{tRuntime('runs.cancel')}</Button>
      )}
    </>
  ) : null

  // ── Failure diagnosis: what stopped the run, why, and the remedies this surface can really run ──
  const diagnosis = useMemo(() => readFailureDiagnosis(job.failureDiagnosis), [job.failureDiagnosis])
  const showDiagnosis = !!diagnosis && isTerminal && (job.status === 'failed' || job.status === 'canceled')
  // The chain this run belongs to ("Attempt 3 · continued from the developer step of attempt 2")
  // and whether Continue applies (the runtime list omits settled runs, a stop among them).
  const continuity = useAttemptChain(projectId, job.command.startsWith('loop:') ? job.id : null, job.status)
  // Continue: a settled definition run that no later attempt took over yet.
  const definitionRunId = run?.engineVersion === 2 && !run.forkSuccessor ? run.runId : continuity.continuable ? job.id : null
  const stopped = isTerminal && job.status === 'canceled' && !diagnosis
  const continueRemedies = useContinueRemedies(projectId, definitionRunId, diagnosis, { enabled: isTerminal && (stopped || showDiagnosis), onContinued: onOpenRun })
  // One click on a resolution option (or the person's own instruction) continues a settled definition run.
  const resolutionActions = useResolutionActions(projectId, definitionRunId, { enabled: isTerminal && showDiagnosis, onContinued: onOpenRun })
  const resolution: RunResolution = { chain: continuity.resolution, actions: resolutionActions }
  // A run that settled on a provider's usage limit can continue on another provider instead.
  const providerSwitch = useProviderSwitchContinue(projectId, definitionRunId, continuity.providerSwitch, { enabled: isTerminal && showDiagnosis, onContinued: onOpenRun })
  const diagnosisHandlers: RemedyHandlers = { ...continueRemedies }
  // One continuation at a time: Continue waits while the run continues on another provider.
  if (diagnosisHandlers.continue && (providerSwitch?.busy || providerSwitch?.done)) diagnosisHandlers.continue = { ...diagnosisHandlers.continue, disabled: true }
  // A picked resolution continues the run too: Continue waits for it, never a second continuation.
  if (diagnosisHandlers.continue && (resolutionActions?.busy || resolutionActions?.done)) diagnosisHandlers.continue = { ...diagnosisHandlers.continue, disabled: true }
  // A run this surface can only resume in place (no definition run) still continues that way.
  if (!diagnosisHandlers.continue && run && projectId && run.canResume && !answerable && run.recoverableSteps.length === 0) {
    diagnosisHandlers.continue = { run: () => void runtime.act(run, run.pendingApproval ? 'approve' : 'resume'), busy }
  }
  if (onRerun) diagnosisHandlers.retry = { run: onRerun, busy: !!rerunBusy }
  if (onEditSpec) diagnosisHandlers['edit-spec'] = { run: onEditSpec }
  diagnosisHandlers['open-logs'] = { run: () => { if (onOpenLogs) onOpenLogs(); else if (!openLogsAtFailure()) toast.info(tRecovery('logs.notFound')) } }
  const continuityContent = stopped && (diagnosisHandlers.continue || diagnosisHandlers.retry)
    ? <StoppedRunCard onContinue={diagnosisHandlers.continue} onStartOver={diagnosisHandlers.retry} />
    : null
  // The card (or the stopped card) offers Start over itself, so the surface's own Run again steps aside.
  const diagnosisOffersRetry = (showDiagnosis && !!diagnosis && offersStartOver(diagnosis, diagnosisHandlers)) || (!!continuityContent && !!diagnosisHandlers.retry)
  const diagnosisTail = useMemo(() => (showDiagnosis && diagnosis?.kind === 'unknown' ? logTailLines(events) : []), [showDiagnosis, diagnosis?.kind, events])

  // Details show only what the run actually recorded: no empty metric tiles,
  // no evidence or instructions panels for a run that has none.
  const finalMetrics = isTerminal ? ([
    ['cost', final.cost], ['turns', final.turns], ['tokens', final.tokens],
  ] as const).filter(([, value]) => value != null) : []
  const runError = run?.error && !showDiagnosis ? run.error : null
  // Evidence and instructions have their own chip and composer; the question
  // has the Failure reasons tab while it can be answered.
  const readOnlyQuestion = !!run?.pendingQuestion && !answerable
  const runSectionVisible = !!projectId && (!!runtimeError || !!run && (
    run.historical || run.status === 'succeeded' || run.canResume || !!runError || !!run.pendingApproval?.reason
    || readOnlyQuestion || !!run.metrics))
  const hasDetails = hasLiveCounters || finalMetrics.length > 0 || (isTerminal && !!pipelineTotals) || modifiedFiles.length > 0 || runSectionVisible

  const frameClass = variant === 'glass'
    ? 'border-b border-border/30 bg-surface/30'
    : 'border-b border-border bg-background'

  // A question no one can answer any more (already answered, the run needs recovery first) is shown read-only;
  // an answerable one has its card above the log (RunQuestionDock), never here or under "Failure reasons".
  const question = run?.pendingQuestion && !answerable ? (
    <div className="space-y-1 text-xs">
      <p className="font-medium">{t(`common:runQuestion.asker.run`)}</p>
      <p className="whitespace-pre-wrap">{run.pendingQuestion.question}</p>
    </div>
  ) : null

  const evidenceChip = run && projectId ? <RuntimeEvidenceChip projectId={projectId} run={run} /> : null
  // While the run waits on the person its question card is the one input; instructions come after.
  const acceptsInstructions = !waitsOnPerson && !!run && !!projectId && steeringAcceptsInstructions(run)
  const composer = acceptsInstructions && run && projectId
    ? <RuntimeSteering projectId={projectId} run={run} onAccepted={runtime.refresh} />
    : null
  const steeringChip = run && projectId && !acceptsInstructions ? <RuntimeSteeringChip run={run} /> : null
  const metaContent = evidenceChip || steeringChip ? <>{evidenceChip}{steeringChip}</> : null

  const detailsContent = (
        <div data-testid="job-run-details" className="p-3 space-y-3 text-xs">
          {hasLiveCounters && (
            <div>
              <div className="grid grid-cols-2 gap-2 max-w-sm">
                <Metric label={t('statusPanel.turns')} value={String(activity.turns)} />
                <Metric label={t('statusPanel.tokens')} value={formatTokens(activity.tokens)} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">{t('runHeader.liveReported')}</p>
            </div>
          )}

          {finalMetrics.length > 0 && (
            <div className="grid grid-cols-3 gap-2 max-w-lg">
              {finalMetrics.map(([key, value]) => (
                <Metric key={key} label={t(`statusPanel.${key}`)} value={value} valueClass={key === 'cost' ? 'text-accent-warning' : undefined} />
              ))}
            </div>
          )}

          {isTerminal && pipelineTotals && (
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">
                {t('statusPanel.pipelineTotal', { count: pipelineTotals.jobCount })}
              </p>
              <div className="grid grid-cols-2 gap-2 max-w-sm">
                <Metric label={t('statusPanel.totalCost')} value={formatPipelineCost(pipelineTotals)} valueClass="text-accent-warning" />
                <Metric label={t('statusPanel.totalTokens')} value={formatPipelineTokens(pipelineTotals)} />
              </div>
              {pipelineTotals.hasNullCost && !pipelineTotals.costUnavailable && (
                <p data-testid="pipeline-partial-hint" className="text-xs text-muted-foreground mt-1.5" title={t('statusPanel.pipelinePartialTooltip')}>
                  {t('statusPanel.pipelinePartial', { count: pipelineTotals.nullCostCount ?? 0 })}
                </p>
              )}
              {pipelineTotals.costUnavailable && (
                <p data-testid="pipeline-cost-unavailable" className="text-xs text-muted-foreground mt-1.5">{t('statusPanel.pipelineCostUnavailable')}</p>
              )}
              {(pipelineTotals.nullTokenCount ?? 0) > 0 && (
                <p data-testid="pipeline-usage-coverage-hint" className="text-xs text-muted-foreground mt-1" title={t('statusPanel.pipelineUsageTooltip')}>
                  {pipelineTotals.tokensUnavailable
                    ? t('statusPanel.pipelineUsageUnavailable')
                    : t('statusPanel.pipelineUsagePartial', { count: pipelineTotals.nullTokenCount ?? 0 })}
                </p>
              )}
            </div>
          )}

          {modifiedFiles.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">{t('statusPanel.filesModified')}</p>
              <div className="flex flex-wrap gap-1.5">
                {modifiedFiles.map((f) => (
                  <code key={f} className="text-xs font-mono bg-muted/30 px-2 py-0.5 rounded text-accent-info">{f}</code>
                ))}
              </div>
            </div>
          )}

          {runSectionVisible && (
            <section aria-label={tRuntime('runs.implementation')} className="space-y-2" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
              {runtimeError && <p role="alert" className="text-destructive">{runtimeError}</p>}
              {run?.historical && <p className="text-muted-foreground">{tRuntime('evidence.historical')}</p>}
              {run?.status === 'succeeded' && <p className="text-muted-foreground">{tRuntime('runs.reviewDelivery')}</p>}
              {run?.canResume && <p className="text-muted-foreground">{tRuntime('runs.preserveProgress')}</p>}
              {runError && <p className="text-destructive">{runError}</p>}
              {run?.pendingApproval?.reason && <p className="text-muted-foreground">{run.pendingApproval.reason}</p>}
              {readOnlyQuestion && question}
              {run?.metrics && <AgentRuntimeMetrics metrics={run.metrics} />}
            </section>
          )}
        </div>
  )

  const statusLead = (<>
        <Tooltip>
          <TooltipTrigger asChild>
            <div><RunStatePill state={statusInfo.state} label={t(statusInfo.labelKey)} data-testid="job-status" /></div>
          </TooltipTrigger>
          <TooltipContent>{t(statusInfo.tooltipKey)}</TooltipContent>
        </Tooltip>
        {job.status === 'completed' && elapsed !== '—' ? (
          // Peak: the run arrived. Final, provider-reported numbers only —
          // revealed at exit, never estimated while live. The mark's arrival
          // plays once per mount (static under reduced motion).
          <span data-testid="job-run-outcome" className="inline-flex items-center gap-2.5" title={t('statusPanel.duration')}>
            <RailMark size={34} state="arrive" />
            <RunStateDot state="done" size="sm" />
            <span className="text-display num leading-none text-foreground">{elapsed}</span>
            {final.cost && <span className="text-label num text-muted-foreground">{final.cost}</span>}
          <span className="sr-only"> ({t('statusPanel.duration')})</span></span>
        ) : elapsed === '—' && !isRunning ? null : (
        // A missing figure renders nothing (DESIGN.md: no placeholders).
        <span
          className={cn('inline-flex items-center gap-1.5 text-xs num', isRunning ? 'text-accent-info font-medium' : 'text-muted-foreground')}
          title={isRunning ? t('statusPanel.liveTooltip') : hold ? t('held.stoppedTime') : t('statusPanel.duration')}
          data-testid="job-run-elapsed"
        >
          {isRunning && <RunStateDot state="working" />}
          {elapsed}
        <span className="sr-only"> ({isRunning ? t('statusPanel.liveTooltip') : hold ? t('held.stoppedTime') : t('statusPanel.duration')})</span></span>
        )}
  </>)
  const statusTrail = (<>
        <RunLineage chain={continuity.chain} onOpenRun={onOpenRun} />
        {liveLine && (
          <span className="flex items-center gap-1.5 min-w-0 flex-1 basis-40 text-xs text-muted-foreground">
            {isRunning && <span aria-hidden className="shrink-0"><RailTrack running className="w-8" /></span>}
            <span className="truncate" data-testid="job-run-activity" title={liveLine}>{liveLine}</span>
          </span>
        )}
        {!liveLine && <span className="flex-1" />}
        {stepsLabel && <span className="text-xs text-muted-foreground num shrink-0">{stepsLabel}</span>}
        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          {runtimeActions}
          {typeof actions === 'function' ? actions({ diagnosisOffersRetry }) : actions}
        </div>
  </>)

  return (
    <>
    {(!renderRunDetails || phaseDefinitions.length > 0) && <div data-testid="job-run-header" className={cn('shrink-0', frameClass)}>
      {!renderRunDetails && <div className="flex items-center gap-2 flex-wrap px-3 py-2 min-w-0">{statusLead}{statusTrail}</div>}
      {/* Row 2 — pipeline chips, exactly once */}
      {phaseDefinitions.length > 0 && (
        <div className="px-3 pb-2 pt-2 overflow-x-auto">
          <PipelineProgress phases={phases} phaseDefinitions={phaseDefinitions} held={!!hold} />
        </div>
      )}
    </div>}
    {renderRunDetails?.({ diagnosis, showDiagnosis, pendingQuestion: false, diagnosisHandlers, diagnosisTail, continuityContent, resolution, providerSwitch, hasDetails, detailsContent, questionContent: null, metaContent, composer, detailsRequest, statusLead, statusTrail })}
    </>
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
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-strong num', value != null ? valueClass : 'text-muted-foreground')}>{value ?? '—'}</p>
      {value == null && naCaption && <p className="text-xs text-muted-foreground">{naCaption}</p>}
    </div>
  )
}
