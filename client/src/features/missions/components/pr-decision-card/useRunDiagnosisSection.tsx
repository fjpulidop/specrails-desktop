/**
 * Failure recovery cockpit of a PR decision card: the run's diagnosis with the
 * remedies this card really has, and "repeat from the failed step" (a Core
 * fork at that exact attempt, keeping the work before it).
 */
import type { MutableRefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw } from 'lucide-react'
import { FEATURE_MISSION_RAIL_CARDS } from '../../../../lib/feature-flags'
import { FailureDiagnosisCard } from '../../../recovery/components/FailureDiagnosisCard'
import { useRunDiagnosis } from '../../../recovery/hooks/useRunDiagnosis'
import type { RemedyHandlers } from '../../../recovery/lib/failure-diagnosis'
import { useTicketDetailModal } from '../../../specs/context/TicketDetailModalContext'
import { useLastFailedStep } from '../../../loops/lib/failed-step'
import { useDefinitionFork } from '../../../loops/hooks/useDefinitionFork'
import type { RuntimeRun } from '../../../settings/lib/agent-runtime'
import type { useRuntimeRuns } from '../../../jobs/components/job-run/useRuntimeRuns'
import type { AgentPrDecisionAction, AgentPrDecisionEnvelope } from '../../lib/agent-api'
import { RunFailureBlock } from './RunFailureBlock'
import type { MissionRunStatus } from './run-status'

export function useRunDiagnosisSection(args: {
  envelope: AgentPrDecisionEnvelope
  runFailure: NonNullable<AgentPrDecisionEnvelope['runtime']>['failure'] | null
  runStatus: MissionRunStatus
  flowSpecRun: boolean
  runtime: ReturnType<typeof useRuntimeRuns>
  actionableRun: RuntimeRun | null
  busy: AgentPrDecisionAction | null
  relaunchBlocked: boolean
  relaunching: boolean
  runtimeBusy: boolean
  relaunch: () => Promise<void>
  setLogRunId: (runId: string | null) => void
  anyBusyRef: MutableRefObject<boolean>
}) {
  const {
    envelope, runFailure, runStatus, flowSpecRun, runtime, actionableRun, busy,
    relaunchBlocked, relaunching, runtimeBusy, relaunch, setLogRunId, anyBusyRef,
  } = args
  const { decision } = envelope
  const { t } = useTranslation('agent')
  // ── failure recovery cockpit: the run's diagnosis, with the remedies this card really has ──
  const { openTicketDetailInProject } = useTicketDetailModal()
  const { t: tRecovery } = useTranslation('recovery')
  const diagnosisRunIds = envelope.runIds ?? []
  const diagnosisRunId = diagnosisRunIds[diagnosisRunIds.length - 1] ?? null
  // A person stopped the run: not a failure to diagnose.
  const runStopped = envelope.statusCode === 'run_stopped'
  const failedRunForDiagnosis = FEATURE_MISSION_RAIL_CARDS && !flowSpecRun && (
    Boolean(runFailure) || decision === 'implementation_failed' || runStatus === 'failed' || runStatus === 'stalled'
  ) && !runStopped
  const diagnosis = useRunDiagnosis(envelope.projectId, diagnosisRunId, failedRunForDiagnosis && runStatus !== 'running' && runStatus !== 'paused', envelope.updatedAt ?? null)
  const diagnosisHandlers: RemedyHandlers = {}
  if (actionableRun?.canResume && actionableRun.recoverableSteps.length === 0) {
    diagnosisHandlers.resume = { run: () => void runtime.act(actionableRun, 'resume'), busy: runtime.busy !== null, disabled: busy !== null }
  }
  if (!relaunchBlocked) diagnosisHandlers.retry = { run: () => void relaunch(), busy: relaunching, disabled: runtimeBusy || busy !== null }
  if (envelope.ticketIds.length > 0) diagnosisHandlers['edit-spec'] = { run: () => openTicketDetailInProject(envelope.projectId, envelope.ticketIds[0]) }
  if (diagnosisRunId) diagnosisHandlers['open-logs'] = { run: () => setLogRunId(diagnosisRunId) }
  // #14: when the diagnosis card renders its remedies, it owns the retry/resume
  // primary; the implementation_failed branch below must not add a second one.
  const diagnosisOwnsPrimary = !!diagnosis && (!!diagnosisHandlers.retry || !!diagnosisHandlers.resume)
  // Repeat from the step that failed (a Core fork at that exact attempt): the
  // work before it is kept, unlike "Run again" from the start.
  const failedStep = useLastFailedStep(envelope.projectId, diagnosisRunId,
    failedRunForDiagnosis && decision === 'implementation_failed' && runStatus !== 'running' && runStatus !== 'paused')
  const stepFork = useDefinitionFork(diagnosisRunId ?? undefined, envelope.projectId)
  const repeatStepRow = failedStep ? (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-label" data-testid="mission-run-repeat-step">
      <button type="button" data-agent-interactive data-testid="mission-run-repeat-step-button"
        disabled={stepFork.busy || !!stepFork.created || anyBusyRef.current}
        onClick={() => void stepFork.fork(failedStep.segment)}
        title={t('runCard.repeatFromStepHint', { step: failedStep.title })}
        className="inline-flex items-center gap-1.5 rounded-md border border-accent-primary/40 bg-accent-primary/10 px-2.5 py-1 text-xs font-medium text-accent-primary transition-colors hover:bg-accent-primary/20 disabled:cursor-default disabled:opacity-60">
        {stepFork.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RotateCcw className="h-3 w-3" aria-hidden />}
        {t('runCard.repeatFromStep', { step: failedStep.title })}
      </button>
      <span className="text-muted-foreground">
        {stepFork.created ? t('runCard.repeatFromStepSent', { step: failedStep.title }) : t('runCard.repeatFromStepNote', { step: failedStep.title })}
      </span>
      {stepFork.error && <p role="alert" className="w-full text-destructive">{stepFork.error}</p>}
    </div>
  ) : null
  const diagnosisCard = diagnosis ? (
    <div className="mt-3 space-y-1.5" data-testid="mission-run-diagnosis">
      <FailureDiagnosisCard diagnosis={diagnosis} handlers={diagnosisHandlers} />
      <details>
        <summary className="cursor-pointer text-caption text-muted-foreground hover:text-foreground">{tRecovery('technicalDetails')}</summary>
        <RunFailureBlock envelope={envelope} />
      </details>
    </div>
  ) : null

  return { runStopped, diagnosis, diagnosisOwnsPrimary, diagnosisCard, repeatStepRow }
}
