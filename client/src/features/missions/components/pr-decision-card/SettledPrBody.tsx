/**
 * Body of a settled PR decision card (the delivery phase): header, risk line
 * and arrival, the base/spec/PR chip row, status and failure notes, CI state,
 * local-changes and safety notices, the action row and its confirmations.
 */
import { AlertTriangle, CheckCircle2, GitBranch, RotateCcw, Ticket } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import { FEATURE_MISSION_RAIL_CARDS } from '../../../../lib/feature-flags'
import { TechnicalDetail } from '../../../../components/ui/technical-detail'
import { RailTrack } from '../../../../components/brand/RailTrack'
import { DeliveryArrival } from '../../../../components/brand/DeliveryArrival'
import { RunCapChoiceDialog } from '../../../../components/RunCapChoiceDialog'
import { RepositoryDeliveries } from '../../../delivery/components/RepositoryDeliveries'
import { TopRiskLine } from '../../../delivery/components/TopRiskLine'
import { LocalStashNotice } from '../../../delivery/components/LocalStashNotice'
import { LoopChip } from '../../../delivery/components/LoopChip'
import { AgentFlowReviewBlock, AgentFlowReturnedNote } from '../AgentFlowReviewBlock'
import { OutcomeEvidence } from './OutcomeEvidence'
import { RunFailureBlock } from './RunFailureBlock'
import { PrCardHeader } from './PrCardHeader'
import { PrCardCiStatus } from './PrCardCiStatus'
import { PrCardCleanupWarnings, PrCardSafetyArchives } from './PrCardSafetyNotices'
import { SettledActionRows } from './SettledActionRows'
import { PrCardConfirmDialogs } from './PrCardConfirmDialogs'
import { useSettledActionElements } from './useSettledActionElements'
import type { PrDecisionCardModel } from './usePrDecisionCardModel'

export function SettledPrBody({ model }: { model: PrDecisionCardModel }) {
  const {
    t, envelope, conversationId, decision, prUrl, prState, presentation, terminal, hasRepositoryDeliveries,
    runFailure, flowOutcome, returnedAfterFailure, flowFailureView, RunCardActions,
    interruptedOperationDetail, recoveredInterruptedOperation, showArrival, displayedPrNumber, openPr,
    statusDetail, statusLabel, ticketChips, runChips, ciShown, ciLive, runtimeError, logModal,
  } = model
  const { busy, checkingOut, act, checkoutPrBranch, localAction, runLocalChangesAction } = model.actions
  const { runCapPrompt, setRunCapPrompt, resumingBudgetRunId, resumeBudgetPausedRun } = model.controls
  const { runStopped, diagnosisCard, repeatStepRow } = model.section
  const el = useSettledActionElements(model)
  const { anyBusy, prLink } = el
  const shouldAnnounce = Boolean(envelope.operation) || recoveredInterruptedOperation || presentation.partial || presentation.deliveryBlocked || presentation.retryablePush || presentation.retryablePrCreation || presentation.closed || presentation.implementationFailed
  const announceExtra = envelope.operation
    ? t(`prCard.operation.${envelope.operation}`)
    : recoveredInterruptedOperation ? t('common:prRecovery.interrupted') : ''

  // mission-rail-cards: failed / auto-closed deliveries show their failure as
  // text (code + detail + per-unit codes) instead of a hover title. When this
  // block renders, the older status-detail paragraph is skipped (no double).
  // pr-ci-loop: the CI outcome the last CI loop recorded on this PR.
  const ciOutcome = ciShown !== null
  const failureBlockShown = FEATURE_MISSION_RAIL_CARDS && flowOutcome === null && !runStopped && (
    !!runFailure
    || decision === 'implementation_failed'
    || (decision === 'discarded' && (!!envelope.statusDetail || envelope.statusCode === 'delivery_failed'))
  )

  return (
    <>
      {/* The dialog is portalled but React still bubbles its events to this card. */}
      <div style={{ display: 'contents' }} onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
        <RunCapChoiceDialog
          info={runCapPrompt?.budget ?? null}
          busy={resumingBudgetRunId !== null}
          onDismiss={() => setRunCapPrompt(null)}
          onChoose={(choice) => {
            const prompt = runCapPrompt
            setRunCapPrompt(null)
            if (prompt) void resumeBudgetPausedRun(prompt.runId, choice)
          }}
        />
      </div>
      {shouldAnnounce && announceExtra && (
        // Live regions announce CONTENT mutations: the text is the child (keyed
        // to the state), not an aria-label on an empty node.
        <span role="status" aria-live="polite" className="sr-only" data-testid="agent-pr-decision-live">
          {announceExtra}
        </span>
      )}
      <PrCardHeader model={model} shouldAnnounce={shouldAnnounce} announceExtra={announceExtra} />

      <RepositoryDeliveries deliveryId={envelope.prDeliveryId} repositories={envelope.repositoryDeliveries}
        busy={!!busy || checkingOut || !!envelope.operation} onAct={act} onCheckout={checkoutPrBranch} ciStates={ciLive?.byPrUrl}
        settled={presentation.terminal} />

      {/* Reviewer risk brief: the single top risk (absent without a brief). */}
      <TopRiskLine summary={envelope.riskSummary} className="mt-2" />

      {showArrival && prUrl && (
        <DeliveryArrival
          deliveryId={envelope.prDeliveryId}
          prNumber={displayedPrNumber}
          prUrl={prUrl}
          onOpen={(e) => openPr(e, prUrl)}
          className="mt-2"
        />
      )}

      {/* Body: base-branch chip + spec count + PR link */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {!hasRepositoryDeliveries && <span
          title={t('prCard.base')}
          className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 font-mono text-caption text-muted-foreground"
        >
          <GitBranch className="h-3 w-3 text-accent-primary" />
          {'→ '}
          {envelope.baseBranch}
        <span className="sr-only"> ({t('prCard.base')})</span></span>}
        <LoopChip loopId={envelope.loopId} loopName={envelope.loopName} />
        <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 text-caption text-muted-foreground">
          <Ticket className="h-3 w-3 text-accent-secondary" />
          {t('prCard.specCount', { count: envelope.ticketIds.length })}
        </span>
        {ticketChips}
        {!showArrival && prLink}
        {runChips}
        {envelope.deliverySha && !hasRepositoryDeliveries && (
          <span
            data-testid="agent-pr-delivery-sha"
            title={envelope.deliverySha}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-caption',
              envelope.deliveryOutcome === 'delivered'
                ? 'border-accent-success/35 bg-accent-success/10 text-accent-success'
                : 'border-border/60 bg-surface/60 text-muted-foreground',
            )}
          >
            <CheckCircle2 className="h-3 w-3" />
            {t('prCard.deliveryCommit', { sha: envelope.deliverySha.slice(0, 8) })}
          </span>
        )}
      </div>

      {envelope.operation && (
        <p className="mt-2 flex items-center gap-1.5 text-label font-medium text-accent-info" data-testid="agent-pr-operation">
          <RailTrack running className="w-16 shrink-0" />
          {t(`prCard.operation.${envelope.operation}`)}
        </p>
      )}

      {recoveredInterruptedOperation && (
        <p className="mt-2 flex items-start gap-1.5 text-label leading-4 text-accent-info" data-testid="agent-pr-recovery-interrupted">
          <RotateCcw className="mt-px h-3 w-3 shrink-0" aria-hidden />
          <span>{t('common:prRecovery.interrupted')}</span>
        </p>
      )}

      {/* A failure block below already names what failed: no duplicate red unit chip. */}
      {/* A CI loop outcome speaks for the PR below; a per-unit "ready" chip would contradict it. */}
      {!ciOutcome && <OutcomeEvidence envelope={envelope} hideFailedUnits={flowOutcome !== null || failureBlockShown} />}

      {failureBlockShown && (diagnosisCard ?? <RunFailureBlock envelope={envelope} />)}
      {failureBlockShown && repeatStepRow}
      {flowFailureView}
      {flowOutcome === 'changes' && (
        <AgentFlowReviewBlock review={envelope.flowReview ?? { reason: 'review', summary: envelope.statusDetail ?? null, issues: [], issuesOmitted: 0, score: null, failingChecks: [] }}>
          {RunCardActions && (
            <RunCardActions projectId={envelope.projectId} prDeliveryId={envelope.prDeliveryId} conversationId={conversationId ?? null}
              decision={decision} statusCode={envelope.statusCode ?? null} busy={busy !== null || envelope.operation != null} />
          )}
        </AgentFlowReviewBlock>
      )}
      {flowOutcome === 'returned' && !returnedAfterFailure && <AgentFlowReturnedNote />}
      {runtimeError}

      {/* The title and the failure block / CI note already say it: no third label. */}
      {statusLabel && flowOutcome === null && !failureBlockShown && !ciOutcome && (
        <p className="mt-2 text-label text-muted-foreground" data-testid="agent-pr-status-code">
          {statusLabel}
        </p>
      )}

      {!terminal && presentation.deliveryBlocked && flowOutcome === null && (
        <p className="mt-2 flex items-start gap-1.5 text-label leading-4 text-accent-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>
            {presentation.recoveryUnavailable
              ? t('prCard.recoveryUnavailableBody')
              : t(presentation.partial ? 'prCard.partialDeliveryBlockedNote' : 'prCard.deliveryBlockedNote')}
            {envelope.statusDetail && !interruptedOperationDetail && !presentation.recoveryUnavailable
              ? <span className="mt-0.5 block text-muted-foreground">{statusDetail?.text}</span>
              : null}
          </span>
        </p>
      )}

      <PrCardCiStatus model={model} />

      {!terminal && presentation.recoveryUnavailable && envelope.statusDetail && !interruptedOperationDetail && (
        <details className="mt-1.5 text-label leading-4 text-muted-foreground" data-testid="agent-pr-recovery-technical-detail">
          <summary className="cursor-pointer font-medium text-muted-foreground">{t('prCard.recoveryDetailSummary')}</summary>
          <p className="mt-1 break-words">{envelope.statusDetail}</p>
        </details>
      )}

      {!terminal && presentation.retryablePush && (
        <p className="mt-2 flex items-start gap-1.5 text-label leading-4 text-accent-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>
            {t('prCard.retryPushNote')}
            {envelope.statusDetail && !interruptedOperationDetail ? <span className="mt-0.5 block text-muted-foreground">{statusDetail?.text}</span> : null}
          </span>
        </p>
      )}

      {envelope.statusDetail && !interruptedOperationDetail && !presentation.deliveryBlocked && !presentation.retryablePush && !failureBlockShown && flowOutcome === null && !ciOutcome && (
        <p className="mt-1 text-label leading-4 text-muted-foreground" data-testid="agent-pr-status-detail">
          {statusDetail?.text}
        </p>
      )}

      {statusDetail?.raw && !interruptedOperationDetail && !presentation.recoveryUnavailable && flowOutcome === null && !ciOutcome && (
        <TechnicalDetail summary={t('prCard.recoveryDetailSummary')} className="mt-1 text-label leading-4" testId="agent-pr-status-technical-detail">{statusDetail.raw}</TechnicalDetail>
      )}

      {/* Degraded delivery: pushed / assembled-locally but no PR yet. */}
      {!terminal && !prUrl && (prState === 'pushed' || prState === 'local-only') && (
        <p className="mt-2 flex items-start gap-1.5 text-label leading-4 text-accent-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          {prState === 'local-only' ? t('prCard.degraded.localOnly') : t('prCard.degraded.pushed')}
        </p>
      )}

      <PrCardCleanupWarnings model={model} />

      <LocalStashNotice
        stash={envelope.localStash}
        onRestore={() => void runLocalChangesAction('restore')}
        onBringBack={() => void runLocalChangesAction('bring-back')}
        onDiscardBranch={() => void runLocalChangesAction('discard-branch')}
        pendingAction={localAction}
        disabled={anyBusy}
      />

      <PrCardSafetyArchives model={model} />

      <SettledActionRows model={model} el={el} />
      <PrCardConfirmDialogs model={model} anyBusy={anyBusy} recoveryIsRecheck={el.recoveryIsRecheck} />
      {logModal}
    </>
  )
}
