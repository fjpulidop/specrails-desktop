/**
 * The confirmations of a settled PR decision card: merge locally,
 * recover-and-retry (or recheck), discard, dismiss, discard the local result,
 * mark done with no changes and refine.
 */
import { TechnicalDetail } from '../../../../components/ui/technical-detail'
import { ConfirmDialog } from '../../../../components/ui/confirm-dialog'
import type { PrDecisionCardModel } from './usePrDecisionCardModel'

export function PrCardConfirmDialogs({ model, anyBusy, recoveryIsRecheck }: {
  model: PrDecisionCardModel
  anyBusy: boolean
  recoveryIsRecheck: boolean
}) {
  const { t, envelope, decision, hasRepositoryDeliveries, confirmLayer, isStackedHead } = model
  const { act } = model.actions
  const {
    confirmingMergeLocal, setConfirmingMergeLocal,
    confirmingRecoverAndRetry, setConfirmingRecoverAndRetry,
    confirmingDiscard, setConfirmingDiscard,
    confirmingDismiss, setConfirmingDismiss,
    confirmingDiscardLocal, setConfirmingDiscardLocal,
    confirmingNoChangesDone, setConfirmingNoChangesDone,
    confirmingRefine, setConfirmingRefine, setRefining,
  } = model.confirms
  return (
    <>
      <ConfirmDialog
        open={!hasRepositoryDeliveries && confirmingMergeLocal}
        onOpenChange={setConfirmingMergeLocal}
        layer={confirmLayer}
        tone="default"
        testId="agent-pr-merge-local-confirm"
        confirmTestId="agent-pr-merge-local-confirm-btn"
        title={t('prCard.confirm.mergeLocalTitle')}
        description={t('prCard.confirm.mergeLocalBody', { base: envelope.baseBranch })}
        confirmLabel={t('prCard.mergeLocal')}
        confirmDisabled={anyBusy}
        onConfirm={() => { setConfirmingMergeLocal(false); void act('merge-local') }}
      />
      <ConfirmDialog
        open={confirmingRecoverAndRetry}
        onOpenChange={setConfirmingRecoverAndRetry}
        layer={confirmLayer}
        tone="default"
        testId="agent-pr-recover-and-retry-confirm"
        confirmTestId="agent-pr-recover-and-retry-confirm-btn"
        title={t(recoveryIsRecheck ? 'prCard.confirm.recheckRecoveryTitle' : 'prCard.confirm.recoverAndRetryTitle')}
        description={t(recoveryIsRecheck ? 'prCard.confirm.recheckRecoveryBody' : 'prCard.confirm.recoverAndRetryBody', { branch: envelope.branch ?? '' })}
        confirmLabel={t(recoveryIsRecheck ? 'prCard.recheckRecovery' : 'prCard.recoverAndRetry')}
        confirmDisabled={anyBusy}
        onConfirm={() => { setConfirmingRecoverAndRetry(false); void act('recover-and-retry') }}
      >
        {recoveryIsRecheck && (
          <TechnicalDetail summary={t('prCard.recoveryDetailSummary')} testId="agent-pr-recheck-technical">{t('prCard.confirm.recheckRecoveryTechnical', { branch: envelope.branch ?? '' })}</TechnicalDetail>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        layer={confirmLayer}
        testId="agent-pr-discard-confirm"
        confirmTestId="agent-pr-discard-confirm-btn"
        title={t(decision === 'implementation_failed'
          ? 'prCard.confirm.implementationFailedDiscardTitle'
          : 'prCard.confirm.freshDiscardTitle')}
        description={t(decision === 'implementation_failed'
          ? 'prCard.confirm.implementationFailedDiscardBody'
          : 'prCard.confirm.freshDiscardBody')}
        confirmLabel={t('prCard.discard')}
        confirmDisabled={anyBusy}
        onConfirm={() => { setConfirmingDiscard(false); void act('discard') }}
      >
        {isStackedHead ? (
          <p className="rounded-md border border-accent-warning/40 bg-accent-warning/10 px-2 py-1.5 text-xs text-accent-warning" data-testid="agent-pr-discard-stacked-note">
            {t('prCard.discardStackedNote')}
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmingDismiss}
        onOpenChange={setConfirmingDismiss}
        layer={confirmLayer}
        tone="default"
        testId="agent-pr-dismiss-confirm"
        confirmTestId="agent-pr-dismiss-confirm-btn"
        title={t('prCard.confirm.dismissTitle')}
        description={t('prCard.confirm.dismissBody')}
        confirmLabel={t('prCard.dismiss')}
        confirmDisabled={anyBusy}
        onConfirm={() => { setConfirmingDismiss(false); void act('dismiss') }}
      />
      <ConfirmDialog
        open={confirmingDiscardLocal}
        onOpenChange={setConfirmingDiscardLocal}
        layer={confirmLayer}
        testId="agent-pr-discard-local-confirm"
        confirmTestId="agent-pr-discard-local-confirm-btn"
        title={t('prCard.confirm.discardLocalTitle')}
        description={t('prCard.confirm.discardLocalBody')}
        confirmLabel={t('prCard.discardLocalResult')}
        confirmDisabled={anyBusy}
        onConfirm={() => { setConfirmingDiscardLocal(false); void act('discard') }}
      />
      <ConfirmDialog
        open={!hasRepositoryDeliveries && confirmingNoChangesDone}
        onOpenChange={setConfirmingNoChangesDone}
        layer={confirmLayer}
        tone="default"
        testId="agent-pr-no-changes-done-confirm"
        confirmTestId="agent-pr-no-changes-done-confirm-btn"
        title={t('prCard.confirm.noChangesDoneTitle')}
        description={t('prCard.confirm.noChangesDoneBody')}
        confirmLabel={t('prCard.markDone')}
        confirmDisabled={anyBusy}
        onConfirm={() => { setConfirmingNoChangesDone(false); void act('acknowledge-no-changes') }}
      />
      <ConfirmDialog
        open={confirmingRefine}
        onOpenChange={setConfirmingRefine}
        layer={confirmLayer}
        testId="agent-pr-refine-confirm"
        confirmTestId="agent-pr-refine-confirm-btn"
        title={t('prCard.confirm.refineTitle')}
        description={t('prCard.confirm.refineBody')}
        confirmLabel={t('prCard.refine')}
        confirmDisabled={anyBusy}
        onConfirm={() => { setConfirmingRefine(false); setRefining(true); void act('discard').finally(() => setRefining(false)) }}
      />
    </>
  )
}
