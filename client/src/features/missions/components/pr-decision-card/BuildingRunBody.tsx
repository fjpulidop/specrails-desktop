/**
 * Body of a PR decision card while its rail builds: what is actually happening
 * (an isolated-worktree run; the PR question comes at settle), the paused-run
 * controls, the run's chips and the building hint.
 */
import { AlertTriangle, ExternalLink, GitBranch, GitPullRequest, Loader2, Play, Square } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import { FEATURE_MISSION_RAIL_CARDS } from '../../../../lib/feature-flags'
import { PR_CI_LOOP_ID } from '../../../delivery/lib/pr-ci'
import { RailTrack } from '../../../../components/brand/RailTrack'
import { FLOW_SPEC_LOOP_ID, LoopChip } from '../../../delivery/components/LoopChip'
import { RunPrimaryButton } from '../run-primary'
import { MissionRunStatusPill } from './MissionRunStatusPill'
import { RunQuestionCard } from '../../../../components/run-question/RunQuestionCard'
import { RunStateGlyph } from '../../../../components/ui/run-state/run-state-glyph'
import type { PrDecisionCardModel } from './usePrDecisionCardModel'

export function BuildingRunBody({ model }: { model: PrDecisionCardModel }) {
  const {
    t, envelope, prUrl, runOnly, runtime, buildingPaused, existingPrContinuation, displayedPrNumber, runStatus,
    phaseLine, ticketChips, openPr, pausedRunId, pausedReason, pausedRunLabel, pausedResumeStep, pausedOnBudget,
    pausedLive, setLogRunId, runChips, runtimeError, logModal, pausedQuestion,
  } = model
  const { runtimeBusy } = model.buttons
  const { resumingBudgetRunId, resumeBudgetPausedRun, stoppingRunId, stopPausedRun } = model.controls
  return (
    <>
      <div className="flex items-center gap-2">
        {buildingPaused && pausedQuestion
          ? <RunStateGlyph state="needs-input" size="sm" />
          : buildingPaused
          ? <AlertTriangle className="h-3.5 w-3.5 text-accent-warning" />
          : existingPrContinuation
            ? <GitPullRequest className="h-3.5 w-3.5 text-accent-info" />
            : <RailTrack running className="w-16 shrink-0" />}
        <span className={cn('min-w-0 flex-1 truncate', buildingPaused && (pausedQuestion ? 'text-accent-primary' : 'text-accent-warning'))}>
          {buildingPaused && pausedQuestion
            ? t('common:runQuestion.notice')
            : buildingPaused
            ? t('prCard.title.paused')
            : envelope.loopId === PR_CI_LOOP_ID
              ? t('prCard.title.ciBuilding', { pr: displayedPrNumber ?? (envelope.repositoryDeliveries ?? []).flatMap((repository) => repository.prNumber ? [`#${repository.prNumber}`] : []).join(', ') })
            : existingPrContinuation
              ? t('prCard.title.buildingExistingPr')
              : runOnly ? t('prCard.title.buildingInPlace')
                : envelope.loopId === FLOW_SPEC_LOOP_ID ? t('prCard.title.flowSpecBuilding') : t('prCard.title.building')}
        </span>
        {/* A question says "Needs you" in the title; a second "Paused" pill would contradict it. */}
        {FEATURE_MISSION_RAIL_CARDS && !(buildingPaused && pausedQuestion) && <MissionRunStatusPill status={runStatus} />}
        {FEATURE_MISSION_RAIL_CARDS && (
          <span className="shrink-0 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 text-caption font-medium text-muted-foreground">
            {envelope.railName ? envelope.railName : t('prCard.rail', { index: envelope.railIndex + 1 })}
          </span>
        )}
      </div>
      {/* The step a paused run stopped at is a node id; its question card says what it waits for. */}
      {phaseLine && !(buildingPaused && pausedQuestion) && <div className="mt-1 flex items-center pl-[22px]">{phaseLine}</div>}
      {(ticketChips || !runOnly) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[22px]">
          {!runOnly && <LoopChip loopId={envelope.loopId} loopName={envelope.loopName} />}
          {ticketChips}
        </div>
      )}
      {existingPrContinuation && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[22px]">
          {prUrl ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => openPr(e, prUrl)}
              title={prUrl}
              data-agent-interactive
              className="inline-flex items-center gap-1 rounded-full border border-accent-info/40 bg-accent-info/10 px-2 py-0.5 font-mono text-caption text-accent-info transition-colors hover:border-accent-info/60 hover:bg-accent-info/15"
            >
              <GitPullRequest className="h-3 w-3" />
              {displayedPrNumber ?? t('prCard.openPr')}
              <ExternalLink className="h-2.5 w-2.5 opacity-60" />
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-accent-info/40 bg-accent-info/10 px-2 py-0.5 font-mono text-caption text-accent-info">
              <GitPullRequest className="h-3 w-3" />
              {displayedPrNumber ?? t('prCard.existingPr')}
            </span>
          )}
          <span
            title={t('git.branch')}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 font-mono text-caption text-muted-foreground"
          >
            <GitBranch className="h-3 w-3 shrink-0 text-accent-primary" />
            <span className="truncate">{envelope.branch}</span>
          <span className="sr-only"> ({t('git.branch')})</span></span>
        </div>
      )}
      {buildingPaused && pausedRunId && pausedQuestion && (
        // The run needs the person: the question itself, answered here like on every other surface.
        <div className="mt-2 space-y-1.5" data-agent-interactive data-testid="pr-run-question">
          <RunQuestionCard question={pausedQuestion} projectId={envelope.projectId} runId={pausedRunId} runLabel={pausedRunLabel} density="compact" />
          <button
            type="button"
            data-agent-interactive
            disabled={stoppingRunId === pausedRunId}
            onClick={(e) => { e.stopPropagation(); void stopPausedRun(pausedRunId) }}
            className="inline-flex items-center gap-1 text-caption text-muted-foreground underline-offset-2 hover:text-destructive hover:underline disabled:opacity-60"
          >
            {stoppingRunId === pausedRunId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
            {t('prCard.stopExecution')}
          </button>
        </div>
      )}
      {buildingPaused && pausedRunId && !pausedQuestion && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-accent-warning/35 bg-accent-warning/10 px-2 py-1.5 text-label text-accent-warning" data-testid="pr-run-paused-actions">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={pausedReason ?? undefined}>
            {pausedRunLabel ? t('prCard.pausedForRun', { ref: pausedRunLabel }) : t('prCard.paused')}
            {pausedReason ? `: ${pausedReason}` : ''}
          </span>
          <RunPrimaryButton
            primary={{ id: 'resume-paused', label: pausedResumeStep ? t('prCard.resumeFromStep', { step: pausedResumeStep }) : t('prCard.resume'), kind: 'local', rank: 1 }}
            data-agent-interactive
            data-testid="pr-run-paused-resume"
            disabled={runtimeBusy}
            title={pausedResumeStep ? t('prCard.resumeFromStepHint', { step: pausedResumeStep }) : undefined}
            onClick={() => {
              if (pausedOnBudget) void resumeBudgetPausedRun(pausedRunId)
              else if (pausedLive) void runtime.act(pausedLive, pausedLive.recoverableSteps.length ? 'recover' : 'resume')
              else setLogRunId(pausedRunId)
            }}
            className="inline-flex items-center gap-1 rounded-md border border-accent-warning/40 bg-surface/70 px-2 py-0.5 font-medium text-accent-warning transition-colors hover:bg-accent-warning/15 disabled:pointer-events-none disabled:opacity-50"
          >
            {runtime.busy === pausedRunId || resumingBudgetRunId === pausedRunId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {pausedResumeStep ? t('prCard.resumeFromStep', { step: pausedResumeStep }) : t('prCard.resume')}
          </RunPrimaryButton>
          <button
            type="button"
            data-agent-interactive
            disabled={stoppingRunId === pausedRunId}
            onClick={(e) => {
              e.stopPropagation()
              void stopPausedRun(pausedRunId)
            }}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-default disabled:opacity-60"
          >
            {stoppingRunId === pausedRunId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
            {t('prCard.stopExecution')}
          </button>
        </div>
      )}
      {runChips && <div className="pl-[22px]">{runChips}</div>}
      {/* Intent → Spec says what it does in its title; the generic PR hint is noise there. */}
      {envelope.loopId !== FLOW_SPEC_LOOP_ID && (
        <p className="mt-1 pl-[22px] text-label leading-4 text-muted-foreground">
          {runOnly ? t('runCard.noDeliveryHint') : envelope.loopId === PR_CI_LOOP_ID ? t('prCard.ciBuildingHint') : existingPrContinuation ? t('prCard.buildingExistingPrHint') : t('prCard.buildingHint')}
        </p>
      )}
      {runtimeError}
      {logModal}
    </>
  )
}
