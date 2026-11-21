/**
 * The action elements a settled PR decision card composes into its rows: the
 * single primary per state, the review packet entry, local-result inspection,
 * recover-and-retry, "Fix CI" and the ONE "More actions" overflow menu, plus
 * Dismiss / Mark done / Refine and the PR link.
 */
import { GitBranch, GitMerge, GitPullRequest, ExternalLink, FolderOpen, Loader2, RotateCcw, Wrench } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import { FEATURE_MISSION_RAIL_CARDS, FEATURE_REVIEW_PACKET } from '../../../../lib/feature-flags'
import { prDeliveryCheckoutBranch } from '../../../delivery/lib/pr-delivery'
import { OverflowActions, type OverflowActionItem } from '../../../../components/ui/overflow-actions'
import type { AgentPrDecisionAction } from '../../lib/agent-api'
import { PRIMARY_ACTION, RunPrimaryButton } from '../run-primary'
import { ReviewPacketEntry } from './ReviewPacketEntry'
import type { PrDecisionCardModel } from './usePrDecisionCardModel'

export function useSettledActionElements(model: PrDecisionCardModel) {
  const { t, envelope, prUrl, presentation, hasRepositoryDeliveries, inRouterContext, runtime, actionableRun, ciShown, openPr, displayedPrNumber } = model
  const { busy, checkingOut, act, checkoutPrBranch, inspectLocalResult } = model.actions
  const { setConfirmingRecoverAndRetry, setConfirmingMergeLocal, setConfirmingDiscardLocal, setConfirmingDismiss, setConfirmingDiscard, setConfirmingNoChangesDone, setConfirmingRefine, refining } = model.confirms
  const { relaunch, relaunchAccepted } = model.controls
  const { runtimeBusy, resumeAction, relaunchBlocked, flowSpecRun } = model.buttons
  const { ciStarting, fixCi, canFixCi } = model.ci

  const primaryBtn = PRIMARY_ACTION
  const ghostBtn = cn(
    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-60',
    'border-border/60 text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive',
  )

  const outlineBtn = 'inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-surface/60 disabled:cursor-default disabled:opacity-60'
  const anyBusy = busy !== null || checkingOut || envelope.operation != null
  const spinner = <Loader2 className="h-3 w-3 animate-spin" />

  // Create PR / Publish / Reopen reach other people: the strip only points at them.
  const primaryAction = (action: AgentPrDecisionAction, label: string) => !hasRepositoryDeliveries && (
    <RunPrimaryButton primary={{ id: action, label, kind: action === 'poll-merge' ? 'local' : 'outward', rank: 1 }}
      onClick={() => void act(action)} disabled={anyBusy} data-agent-interactive className={primaryBtn}>
      {busy === action && spinner}
      {label}
    </RunPrimaryButton>
  )

  // Entry into the plain-language review packet (nontech-review-experience).
  // The card keeps its precise git actions; this offers the readable surface to
  // whoever would rather judge the work than the plumbing.
  const reviewPacketAction = FEATURE_REVIEW_PACKET && inRouterContext && !presentation.terminal
    ? <ReviewPacketEntry prDeliveryId={envelope.prDeliveryId} projectId={envelope.projectId} />
    : null

  const checkoutBranch = prDeliveryCheckoutBranch(envelope)
  const inspectLocalResultAction = presentation.recoveryWorktreePaths.length > 0 && (
    <button
      type="button"
      onClick={() => void inspectLocalResult()}
      disabled={anyBusy}
      data-testid="agent-pr-inspect-local-result"
      data-agent-interactive
      title={t('prCard.inspectLocalResultTooltip')}
      className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-caption font-medium text-muted-foreground transition-colors hover:border-accent-primary/40 hover:bg-accent-primary/10 disabled:pointer-events-none disabled:opacity-50"
    >
      <FolderOpen className="h-3 w-3" aria-hidden />
      {t('prCard.inspectLocalResult')}
    </button>
  )

  const recoveryIsRecheck = presentation.recoveryRecheck
  const recoverAndRetryAction = (presentation.manualRecovery || recoveryIsRecheck) && (recoveryIsRecheck ? (
    <button
      type="button"
      onClick={() => setConfirmingRecoverAndRetry(true)}
      disabled={anyBusy}
      data-testid="agent-pr-recheck-recovery"
      data-agent-interactive
      className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-caption font-medium text-muted-foreground transition-colors hover:border-accent-primary/40 hover:bg-accent-primary/10 disabled:pointer-events-none disabled:opacity-50"
    >
      {busy === 'recover-and-retry' ? spinner : <RotateCcw className="h-3 w-3" aria-hidden />}
      {t('prCard.recheckRecovery')}
    </button>
  ) : (
    // Retrying delivers the work: outward, the strip only points at it.
    <RunPrimaryButton
      primary={{ id: 'recover-and-retry', label: t('prCard.recoverAndRetry'), kind: 'outward', rank: 1 }}
      onClick={() => setConfirmingRecoverAndRetry(true)}
      disabled={anyBusy}
      data-testid="agent-pr-recover-and-retry"
      data-agent-interactive
      className={primaryBtn}
    >
      {busy === 'recover-and-retry' ? spinner : <RotateCcw className="h-3 w-3" aria-hidden />}
      {t('prCard.recoverAndRetry')}
    </RunPrimaryButton>
  ))

  // Secondary actions live behind ONE "More actions" menu: the card keeps a single
  // primary button (and at most the review packet as a quiet secondary).
  // Failed implementation: approve / recover / relaunch are real, but not the first thing to press.
  const implementationFailedLead: OverflowActionItem[] = []
  if (FEATURE_MISSION_RAIL_CARDS && actionableRun) {
    if (actionableRun.pendingApproval) implementationFailedLead.push({ id: 'approve', testId: 'mission-run-approve', label: t('runCard.actions.approve'), onSelect: () => void runtime.act(actionableRun, 'approve'), disabled: runtimeBusy || busy !== null })
    if (actionableRun.recoverableSteps.length > 0) implementationFailedLead.push({ id: 'recover', testId: 'mission-run-recover', label: t('runCard.actions.recover'), onSelect: () => void runtime.act(actionableRun, 'recover'), disabled: runtimeBusy || busy !== null })
  }
  if (FEATURE_MISSION_RAIL_CARDS && !flowSpecRun && resumeAction) {
    implementationFailedLead.push({ id: 'relaunch', testId: 'mission-run-relaunch', label: t('runCard.actions.relaunch'), hint: relaunchBlocked ? t('runCard.relaunchBlockedActive') : undefined, onSelect: () => void relaunch(), disabled: runtimeBusy || busy !== null || relaunchBlocked || relaunchAccepted })
  }

  const moreActions = (opts: { merge?: boolean; lead?: readonly OverflowActionItem[]; discardLocal?: boolean } = {}) => {
    const items: OverflowActionItem[] = [...(opts.lead ?? [])]
    if (checkoutBranch && !hasRepositoryDeliveries) {
      items.push({
        id: 'checkout', testId: 'agent-pr-checkout', label: t('prCard.checkout'),
        hint: t('prCard.checkoutTooltip', { branch: checkoutBranch }),
        icon: checkingOut ? spinner : <GitBranch className="h-3 w-3" />,
        onSelect: () => void checkoutPrBranch(), disabled: anyBusy,
      })
    }
    // Remote-less acceptance (no PR exists yet): merge into the base locally.
    if (opts.merge && !hasRepositoryDeliveries) {
      items.push({
        id: 'merge-local', testId: 'agent-pr-merge-local', label: t('prCard.mergeLocal'),
        hint: t('prCard.mergeLocalTooltip', { base: envelope.baseBranch }),
        icon: busy === 'merge-local' ? spinner : <GitMerge className="h-3 w-3" />,
        onSelect: () => setConfirmingMergeLocal(true), disabled: anyBusy,
      })
    }
    items.push(opts.discardLocal
      ? { id: 'discard-local', testId: 'agent-pr-discard-local', label: t('prCard.discardLocalResult'), onSelect: () => setConfirmingDiscardLocal(true), disabled: anyBusy, destructive: true }
      : presentation.continuation
      ? { id: 'dismiss', testId: 'agent-pr-dismiss', label: t('prCard.dismiss'), onSelect: () => setConfirmingDismiss(true), disabled: anyBusy }
      : { id: 'discard', testId: 'agent-pr-discard', label: t('prCard.discard'), onSelect: () => setConfirmingDiscard(true), disabled: anyBusy, destructive: true })
    const overflow = <OverflowActions label={t('prCard.moreActions')} items={items} disabled={anyBusy} testId="agent-pr-more" />
    if (!canFixCi) return overflow
    // "Fix CI" is a visible button, never buried in the menu: the main action
    // when the PR's CI is not green (or it has merge conflicts) and nothing else leads the row.
    const ciLeads = (ciShown === 'red' || ciShown === 'conflict') && hasRepositoryDeliveries
    return (
      <>
        <button type="button" data-agent-interactive data-testid="agent-pr-fix-ci" title={t('prCi.fixCiTooltip')}
          onClick={() => void fixCi()} disabled={anyBusy || ciStarting}
          className={ciLeads ? primaryBtn : outlineBtn}>
          {ciStarting ? spinner : <Wrench className="h-3 w-3" aria-hidden />}
          {envelope.statusCode === 'ci_needs_attention' ? t('prCi.retry') : t('prCi.fixCi')}
        </button>
        {overflow}
      </>
    )
  }

  const dismissAction = (
    <button type="button" onClick={() => setConfirmingDismiss(true)} disabled={anyBusy} data-agent-interactive className={ghostBtn}>
      {busy === 'dismiss' && spinner}
      {t('prCard.dismiss')}
    </button>
  )

  const acknowledgeNoChangesAction = !hasRepositoryDeliveries && (
    <RunPrimaryButton primary={{ id: 'acknowledge-no-changes', label: t('prCard.markDone'), kind: 'local', rank: 1 }}
      onClick={() => setConfirmingNoChangesDone(true)} disabled={anyBusy} data-agent-interactive className={primaryBtn}>
      {busy === 'acknowledge-no-changes' && spinner}
      {t('prCard.markDone')}
    </RunPrimaryButton>
  )

  const refineAction = (
    <button type="button" onClick={() => setConfirmingRefine(true)} disabled={anyBusy} data-agent-interactive className={ghostBtn}>
      {refining && spinner}
      {t('prCard.refine')}
    </button>
  )

  const prLink = prUrl && (
    <a
      href={prUrl}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => openPr(e, prUrl)}
      title={prUrl}
      data-agent-interactive
      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 font-mono text-caption text-accent-info transition-colors hover:border-accent-info/50 hover:bg-accent-info/10"
    >
      <GitPullRequest className="h-3 w-3" />
      {displayedPrNumber ?? t('prCard.openPr')}
      <ExternalLink className="h-2.5 w-2.5 opacity-60" />
    </a>
  )

  return {
    primaryBtn, anyBusy, spinner, primaryAction, reviewPacketAction, inspectLocalResultAction,
    recoveryIsRecheck, recoverAndRetryAction, implementationFailedLead, moreActions,
    dismissAction, acknowledgeNoChangesAction, refineAction, prLink,
  }
}

export type SettledActionElements = ReturnType<typeof useSettledActionElements>
