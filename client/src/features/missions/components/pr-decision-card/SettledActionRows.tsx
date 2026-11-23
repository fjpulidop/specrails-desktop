/**
 * The action row of a settled PR decision card: exactly one row per delivery
 * state (no changes, blocked, retryable push / PR, closed, partial, review,
 * draft, ready, failed, implementation failed) and the settled notes.
 */
import { AlertTriangle, CheckCircle2, GitPullRequest, Play, RotateCcw, Square, Wrench, XCircle } from 'lucide-react'
import { motion } from 'motion/react'
import { FEATURE_MISSION_RAIL_CARDS } from '../../../../lib/feature-flags'
import { PR_CI_LOOP_ID } from '../../../delivery/lib/pr-ci'
import { RunPrimaryButton } from '../run-primary'
import type { PrDecisionCardModel } from './usePrDecisionCardModel'
import type { SettledActionElements } from './useSettledActionElements'

export function SettledActionRows({ model, el }: { model: PrDecisionCardModel; el: SettledActionElements }) {
  const { t, envelope, decision, prUrl, presentation, terminal, degradedDraft, partialCreatePending, flowOutcome } = model
  const { relaunch, relaunching, relaunchAccepted, relaunchError, settlementRunId, retryDelivery, retryingDelivery } = model.controls
  const { canResumeRun, resumeButton, relaunchButton, resumeAction, flowSpecRun, flowRunActions } = model.buttons
  const { runStopped, stoppedContinue, diagnosisCard, diagnosisOwnsPrimary } = model.section
  const { canFixCi, ciError } = model.ci
  const {
    primaryBtn, anyBusy, spinner, primaryAction, reviewPacketAction, inspectLocalResultAction,
    recoveryIsRecheck, recoverAndRetryAction, implementationFailedLead, moreActions,
    dismissAction, acknowledgeNoChangesAction, refineAction,
  } = el
  // Replace actions immediately when the authoritative state changes.
  // Delaying the swap for an exit animation could briefly retain a stale,
  // unsafe action after a blocked-delivery snapshot lands.
  return (
    <motion.div
      key={`${decision}-${prUrl ?? ''}`}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mt-2.5"
    >
        {presentation.noChanges && !terminal && (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-label text-accent-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {presentation.continuation ? t('prCard.noChangesExisting') : t('prCard.noChangesNote')}
            </p>
            <div className="flex items-center gap-1.5">
              {presentation.continuation ? dismissAction : <>{acknowledgeNoChangesAction}{refineAction}</>}
            </div>
          </div>
        )}
        {/* pr-ci-loop: a CI loop generation is never "retried" as a delivery (that
            resumes a finished loop run); running the loop again re-attaches it to its PR. */}
        {!terminal && presentation.deliveryBlocked && envelope.loopId === PR_CI_LOOP_ID && (
          <div className="flex flex-wrap items-center gap-1.5">
            <RunPrimaryButton primary={{ id: 'pr-ci-again', label: t('prCi.retry'), kind: 'outward', rank: 1 }}
              data-agent-interactive data-testid="agent-pr-ci-again" onClick={() => void relaunch()}
              disabled={anyBusy || relaunching || relaunchAccepted} className={primaryBtn}>
              {relaunching ? spinner : <Wrench className="h-3 w-3" aria-hidden />}
              {t('prCi.retry')}
            </RunPrimaryButton>
            {moreActions()}
          </div>
        )}
        {!terminal && presentation.deliveryBlocked && envelope.loopId !== PR_CI_LOOP_ID && (
          <div className="flex flex-wrap items-center gap-1.5">
            {settlementRunId && !presentation.manualRecovery && !recoveryIsRecheck && (
              // Retrying delivers the work: outward, the strip only points at it.
              <RunPrimaryButton
                primary={{ id: 'retry-delivery', label: t('prCard.retryDelivery'), kind: 'outward', rank: 1 }}
                onClick={() => void retryDelivery()}
                disabled={anyBusy || retryingDelivery}
                title={t('prCard.retryDeliveryHint')}
                data-testid="agent-pr-retry-delivery"
                data-agent-interactive
                className="inline-flex items-center gap-1 rounded-md border border-accent-primary/40 bg-accent-primary/10 px-2 py-1 text-label text-accent-primary transition-colors hover:bg-accent-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 disabled:pointer-events-none disabled:opacity-50"
              >
                {retryingDelivery ? spinner : <RotateCcw className="h-3 w-3" aria-hidden />}
                {t('prCard.retryDelivery')}
              </RunPrimaryButton>
            )}
            {inspectLocalResultAction}
            {/* Retry delivery exists only without a manual recovery, so there is one primary either way. */}
            {recoverAndRetryAction}
            {moreActions({ discardLocal: presentation.continuation && presentation.hasDiscardableRecoveryResult })}
          </div>
        )}
        {!terminal && presentation.retryablePush && (
          <div className="flex items-center gap-1.5">
            {primaryAction('create-pr', t('prCard.retryPush'))}
            {moreActions()}
          </div>
        )}
        {!terminal && presentation.retryablePrCreation && (
          <div className="flex items-center gap-1.5">
            {primaryAction('create-pr', t('prCard.retryPr'))}
            {moreActions({ merge: true })}
          </div>
        )}
        {!terminal && presentation.closed && (
          <div className="flex items-center gap-1.5">
            {primaryAction('reopen', t('prCard.reopen'))}
            {moreActions()}
          </div>
        )}
        {!terminal && partialCreatePending && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
          <div className="flex items-center gap-1.5">
            {primaryAction('create-pr', t('prCard.createPartialPr', { count: presentation.deliverableCount }))}
            {moreActions()}
          </div>
        )}
        {decision === 'on_review' && !presentation.noChanges && !presentation.partial && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
          <div className="flex items-center gap-1.5">
            {primaryAction('create-pr', t('prCard.createPr'))}
            {reviewPacketAction}
            {moreActions({ merge: true })}
          </div>
        )}
        {decision === 'pr_draft' && !degradedDraft && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
          <div className="flex items-center gap-1.5">
            {primaryAction('publish', t('prCard.publish'))}
            {moreActions()}
          </div>
        )}
        {degradedDraft && !partialCreatePending && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
          <div className="flex items-center gap-1.5">
            {primaryAction('create-pr', t('prCard.retryPr'))}
            {moreActions({ merge: true })}
          </div>
        )}
        {canFixCi && ciError && <p role="alert" className="mb-1.5 text-xs text-destructive" data-testid="agent-pr-fix-ci-error">{ciError}</p>}
        {decision === 'pr_ready' && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
          <div className="flex items-center gap-1.5">
            {primaryAction('poll-merge', t('prCard.verifyPr'))}
            {moreActions()}
          </div>
        )}
        {decision === 'pr_failed' && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
          <div className="flex items-center gap-1.5">
            {primaryAction('create-pr', t('prCard.retry'))}
            {moreActions({ merge: !prUrl })}
          </div>
        )}
        {decision === 'implementation_failed' && presentation.implementationFailed && flowOutcome === null && (
          <div className="space-y-2">
            {/* The diagnosis card above already explains the failure and its next step. */}
            {runStopped ? (
              <p className="flex items-start gap-1.5 text-label leading-4 text-muted-foreground" data-testid="agent-pr-run-stopped">
                <Square className="mt-px h-3 w-3 shrink-0" aria-hidden />
                {t(stoppedContinue ? 'prCard.runStoppedNote' : 'prCard.runStoppedNoteNoContinue')}
              </p>
            ) : !diagnosisCard && (
              <p className="flex items-start gap-1.5 text-label leading-4 text-destructive">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {t('prCard.implementationFailedNote')}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {/* One primary: resume the run when it can be, else relaunch. The rest wait in the menu.
                  When the diagnosis card above already offers Run again / Resume, it is the single primary. */}
              {stoppedContinue ? (
                <RunPrimaryButton primary={{ id: 'continue', label: t('prCard.continue'), kind: 'outward', rank: 1 }} data-agent-interactive data-testid="mission-run-continue"
                  disabled={anyBusy || stoppedContinue.busy || stoppedContinue.disabled} onClick={() => stoppedContinue.run()} className={primaryBtn}>
                  {stoppedContinue.busy ? spinner : <Play className="h-3 w-3" aria-hidden />}
                  {t('prCard.continue')}
                </RunPrimaryButton>
              ) : !diagnosisOwnsPrimary && (canResumeRun ? resumeButton(true) : relaunchButton(true))}
              {/* A resumable Intent → Spec run keeps its Intent actions (Back to Intent, relaunch from the Intent) beside Resume. */}
              {canResumeRun && flowSpecRun && flowRunActions}
              {/* Continuing a stopped run is primary; starting over from the base waits in the menu, with what it costs. */}
              {moreActions({ lead: stoppedContinue ? [{ id: 'start-over', testId: 'mission-run-start-over', label: t('prCard.startOver'), hint: t('prCard.startOverHint'), onSelect: () => void relaunch(), disabled: anyBusy || relaunching || relaunchAccepted }, ...implementationFailedLead.filter((item) => item.id !== 'relaunch')] : implementationFailedLead })}
            </div>
            {resumeAction && !flowSpecRun && relaunchError && <p role="alert" className="text-xs text-destructive" data-testid="mission-run-relaunch-error">{relaunchError}</p>}
          </div>
        )}
        {FEATURE_MISSION_RAIL_CARDS && decision === 'discarded' && envelope.statusCode === 'delivery_failed' && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="mission-run-discarded-actions">
            {relaunchButton(true)}
          </div>
        )}
        {decision === 'merged' && (
          <p className="flex items-center gap-1.5 text-label text-accent-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t('prCard.mergedNote')}
          </p>
        )}
        {decision === 'discarded' && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <XCircle className="h-3.5 w-3.5" />
            {t('prCard.discardedNote')}
          </p>
        )}
        {decision === 'completed' && (
          <p className="flex items-center gap-1.5 text-label text-accent-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t('prCard.completedNote')}
          </p>
        )}
        {decision === 'superseded' && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GitPullRequest className="h-3.5 w-3.5" />
            {t('prCard.supersededNote')}
          </p>
        )}
    </motion.div>
  )
}
