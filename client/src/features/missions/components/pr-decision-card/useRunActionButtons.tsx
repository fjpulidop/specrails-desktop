/**
 * The run's recovery buttons (mission-rail-cards): Resume, Approve, Recover
 * and Relaunch — or, for an Intent → Spec run, the Intent's own actions.
 * Every button disables while ANY action is in flight and re-enables from the
 * next runtime poll / envelope broadcast — no optimistic state.
 */
import { useTranslation } from 'react-i18next'
import { Loader2, Play, RotateCcw, ShieldCheck, Wrench } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import { FEATURE_MISSION_RAIL_CARDS } from '../../../../lib/feature-flags'
import { FLOW_SPEC_LOOP_ID } from '../../../delivery/components/LoopChip'
import { useMissionExtensions } from '../../context/MissionExtensionsContext'
import type { RuntimeRun } from '../../../settings/lib/agent-runtime'
import type { useRuntimeRuns } from '../../../jobs/components/job-run/useRuntimeRuns'
import type { AgentPrDecisionAction, AgentPrDecisionEnvelope } from '../../lib/agent-api'
import { PRIMARY_ACTION, RunPrimaryButton } from '../run-primary'
import type { MissionRunStatus } from './run-status'
import type { useRunControls } from './useRunControls'

export const RUN_ACTION_BTN = 'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-caption font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'

export function useRunActionButtons(args: {
  envelope: AgentPrDecisionEnvelope
  conversationId: string | null | undefined
  runtime: ReturnType<typeof useRuntimeRuns>
  liveRun: RuntimeRun | null
  actionableRun: RuntimeRun | null
  runStatus: MissionRunStatus
  flowOutcome: 'changes' | 'crashed' | 'returned' | null
  busy: AgentPrDecisionAction | null
  controls: ReturnType<typeof useRunControls>
}) {
  const { envelope, conversationId, runtime, liveRun, actionableRun, runStatus, flowOutcome, busy, controls } = args
  const { relaunching, relaunchAccepted, relaunchError, relaunch } = controls
  const { decision } = envelope
  const { t } = useTranslation('agent')
  const { RunCardActions } = useMissionExtensions()
  const runActionBtn = RUN_ACTION_BTN
  const runtimeBusy = runtime.busy !== null || relaunching
  const canResumeRun = Boolean(FEATURE_MISSION_RAIL_CARDS && actionableRun && actionableRun.canResume)
  // `asPrimary`: the card's ONE primary in a failed state wears the shared primary recipe.
  const resumeButton = (asPrimary: boolean) => actionableRun && (
    <RunPrimaryButton primary={{ id: 'resume', label: t('runCard.actions.resume'), kind: 'local', rank: 2 }} data-agent-interactive data-testid="mission-run-resume" disabled={runtimeBusy || busy !== null}
      onClick={() => void runtime.act(actionableRun, 'resume')}
      className={asPrimary ? PRIMARY_ACTION : cn(runActionBtn, 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20')}>
      {runtime.busy === actionableRun.runId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
      {t('runCard.actions.resume')}
    </RunPrimaryButton>
  )
  const resumeAction = canResumeRun && resumeButton(false)
  const approveAction = FEATURE_MISSION_RAIL_CARDS && actionableRun && actionableRun.pendingApproval && (
    <RunPrimaryButton primary={{ id: 'approve', label: t('runCard.actions.approve'), kind: 'outward', rank: 0 }} data-agent-interactive data-testid="mission-run-approve" disabled={runtimeBusy || busy !== null}
      onClick={() => void runtime.act(actionableRun, 'approve')}
      className={cn(runActionBtn, 'border-accent-success/40 bg-accent-success/10 text-accent-success hover:bg-accent-success/20')}>
      <ShieldCheck className="h-3 w-3" />
      {t('runCard.actions.approve')}
    </RunPrimaryButton>
  )
  const recoverAction = FEATURE_MISSION_RAIL_CARDS && actionableRun && actionableRun.recoverableSteps.length > 0 && (
    <RunPrimaryButton primary={{ id: 'recover', label: t('runCard.actions.recover'), kind: 'outward', rank: 3 }} data-agent-interactive data-testid="mission-run-recover" disabled={runtimeBusy || busy !== null}
      onClick={() => void runtime.act(actionableRun, 'recover')}
      className={cn(runActionBtn, 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning hover:bg-accent-warning/20')}>
      <Wrench className="h-3 w-3" />
      {t('runCard.actions.recover')}
    </RunPrimaryButton>
  )
  const runtimeActions = FEATURE_MISSION_RAIL_CARDS && actionableRun && (
    <>
      {resumeAction}
      {approveAction}
      {recoverAction}
    </>
  )
  const relaunchBlocked = Boolean(liveRun?.active) || runStatus === 'running' || runStatus === 'paused'
  // An Intent session → Spec run relaunches from its Intent (same worktree, rail and
  // engine): the plain rail relaunch refuses that loop, so the card offers
  // the Intent's own actions in its place.
  const flowSpecRun = envelope.loopId === FLOW_SPEC_LOOP_ID
  const flowRunActions = flowSpecRun && RunCardActions && decision === 'implementation_failed' && (flowOutcome === null || flowOutcome === 'crashed') ? (
    <RunCardActions projectId={envelope.projectId} prDeliveryId={envelope.prDeliveryId} conversationId={conversationId ?? null}
      decision={decision} statusCode={envelope.statusCode ?? null} busy={busy !== null || envelope.operation != null || runtimeBusy} />
  ) : null
  const relaunchButton = (asPrimary: boolean) => flowSpecRun ? flowRunActions : FEATURE_MISSION_RAIL_CARDS && (
    <>
      <RunPrimaryButton primary={{ id: 'relaunch', label: t('runCard.actions.relaunch'), kind: 'outward', rank: 5 }} data-agent-interactive data-testid="mission-run-relaunch" disabled={runtimeBusy || busy !== null || relaunchBlocked || relaunchAccepted}
        title={relaunchAccepted ? t('runCard.relaunchSent', { index: envelope.railIndex + 1 }) : relaunchBlocked ? t('runCard.relaunchBlockedActive') : undefined}
        onClick={() => void relaunch()}
        className={asPrimary ? PRIMARY_ACTION : cn(runActionBtn, 'border-border/60 text-muted-foreground hover:border-accent-primary/40 hover:bg-accent-primary/10')}>
        {relaunching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
        {t('runCard.actions.relaunch')}
      </RunPrimaryButton>
      {relaunchError && <p role="alert" className="w-full text-xs text-destructive" data-testid="mission-run-relaunch-error">{relaunchError}</p>}
      {/* The toast is transient; the card itself says why its primary went quiet. */}
      {relaunchAccepted && !relaunchError && (
        <p className="flex w-full items-center gap-1.5 text-label text-muted-foreground" data-testid="mission-run-relaunch-sent">
          <RotateCcw className="h-3 w-3 shrink-0" aria-hidden />
          {t('runCard.relaunchSent', { index: envelope.railIndex + 1 })}
        </p>
      )}
    </>
  )
  const relaunchAction = relaunchButton(false)

  return {
    runtimeBusy, canResumeRun, resumeButton, resumeAction, runtimeActions,
    relaunchBlocked, flowSpecRun, flowRunActions, relaunchButton, relaunchAction,
  }
}
