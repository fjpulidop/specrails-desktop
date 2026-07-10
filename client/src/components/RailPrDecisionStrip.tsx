import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { GitPullRequest, GitMerge, ExternalLink, Loader2, AlertTriangle, Eye, GitBranch, ScrollText, CheckCircle2, RotateCcw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './ui/dialog'
import { Button } from './ui/button'
import type { RailPrDecision, RailPrDecisionAction, RailPrStateSnapshot } from '../types'
import type { RailPrActResult, RailPrCheckoutResult } from '../context/RailPrDecisionContext'
import { derivePrDeliveryPresentation, isInterruptedPrDeliveryOperation, isKnownPrDeliveryStatusCode } from '../lib/pr-delivery'

interface RailPrDecisionStripProps {
  decision: RailPrStateSnapshot
  density: 'normal' | 'compact'
  /** POSTs /rails/pr-decision for this rail (bound to railIndex upstream). */
  act: (action: RailPrDecisionAction, expectedDecision: RailPrDecision) => Promise<RailPrActResult>
  /** Checks out this delivery's PR branch in the user's main repo. */
  checkout?: () => Promise<RailPrCheckoutResult>
}

/**
 * The premium ask-first PR decision bar rendered on a rail row (both density
 * branches) whenever the rail has an active `rail_pr_deliveries` snapshot.
 * State is purely the `decision` prop — buttons disable while a request is in
 * flight and the strip reconciles to the next `rail.pr_state` broadcast (no
 * optimistic writes). Discard is destructive → confirm dialog first.
 */
export function RailPrDecisionStrip({ decision, density, act, checkout }: RailPrDecisionStripProps) {
  const { t } = useTranslation('dashboard')
  const navigate = useNavigate()
  const [inFlight, setInFlight] = useState<RailPrDecisionAction | null>(null)
  const [checkingOut, setCheckingOut] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmMergeLocal, setConfirmMergeLocal] = useState(false)
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const [confirmDiscardLocal, setConfirmDiscardLocal] = useState(false)
  const [confirmNoChangesDone, setConfirmNoChangesDone] = useState(false)
  const [confirmRefine, setConfirmRefine] = useState(false)

  const d = decision.decision
  const presentation = derivePrDeliveryPresentation(decision)
  const interruptedOperationDetail = isInterruptedPrDeliveryOperation(decision.statusCode, decision.statusDetail)
  const recoveredInterruptedOperation = decision.operation == null && interruptedOperationDetail
  const statusLabel = isKnownPrDeliveryStatusCode(decision.statusCode)
    ? t(`common:prDeliveryStatus.${decision.statusCode}`)
    : null
  const announcement = decision.operation
    ? t(`railPr.operation.${decision.operation}`)
    : recoveredInterruptedOperation
      ? t('common:prRecovery.interrupted')
      : presentation.deliveryBlocked
        ? t('railPr.deliveryBlocked')
        : presentation.retryablePush
          ? t('railPr.updateFailed')
          : presentation.retryablePrCreation
            ? presentation.localOnly
              ? t('railPr.localOnly')
              : decision.prState === 'pushed'
                ? t('railPr.branchPushed')
                : t('railPr.prFailed')
            : presentation.closed
              ? t('railPr.prClosed')
              : presentation.partial
                ? t('railPr.partial', { succeeded: presentation.succeededCount, total: presentation.totalCount })
                : presentation.implementationFailed
                  ? t('railPr.implementationFailed')
                  : null
  const existingPrIteration = d === 'building' && decision.prState === 'pr-created' && Boolean(decision.branch)
  if ((d === 'building' && !existingPrIteration) || d === 'merged' || d === 'discarded' || d === 'completed' || d === 'superseded') return null

  const compact = density === 'compact'

  async function run(action: RailPrDecisionAction, expected: RailPrDecision) {
    if (inFlight || checkingOut || decision.operation) return
    setInFlight(action)
    try {
      const res = await act(action, expected)
      if (res.status === 409) {
        if (res.error === 'project_recovery_in_progress') {
          toast.info(t('common:prRecovery.inProgress'))
          return
        }
        if (res.error === 'operation_in_progress' || res.busy) {
          toast.info(t(`railPr.operation.${res.operation ?? 'inProgress'}`))
          return
        }
        // merge-local preconditions are USER-fixable, not a lost race — say
        // exactly what to fix (checkout the base / clean the tree) and stop.
        if (res.error === 'merge_local_blocked') {
          toast.warning(res.reason === 'dirty'
            ? t('railPr.mergeLocalBlockedDirty', { base: res.base ?? decision.baseBranch })
            : t('railPr.mergeLocalBlockedBranch', { base: res.base ?? decision.baseBranch, current: res.current ?? '?' }))
          return
        }
        // A concurrent answer (other surface / other client) won — the
        // broadcast reconciles the strip; just say so, neutrally.
        toast.info(t('railPr.alreadyResolved'))
        return
      }
      if (res.status === 502) {
        if (res.error === 'merge_failed') {
          toast.error(t('railPr.mergeLocalFailed', { detail: res.detail ?? '' }))
          return
        }
        toast.error(t('railPr.ghFailed', { detail: res.detail ?? res.error ?? '' }))
        return
      }
      if (!res.ok) {
        toast.error(t('railPr.actionFailed'))
        return
      }
      if (action === 'poll-merge' && res.merged === false && res.decision !== 'pr_closed') {
        toast.info(t('railPr.notMergedYet'))
      }
      if (action === 'merge-local' && res.decision === 'merged') {
        toast.success(t('railPr.mergedLocally', { base: decision.baseBranch }))
      }
      // create-pr can succeed as an HTTP call yet land on pr_failed (retryable
      // delivery failure) — say so, carrying the underlying git/gh detail when
      // the server relayed one; the broadcast flips the strip to Retry.
      if (action === 'create-pr' && res.decision === 'pr_failed') {
        toast.error(res.detail ? t('railPr.prFailedDetail', { detail: res.detail }) : t('railPr.prFailed'))
        return
      }
      // …or land on a DEGRADED pr_draft (pushed / local-only — no PR exists):
      // surface WHY (the git stderr detail) so the user knows what to fix
      // before hitting Retry instead of a silent pill flip.
      if (action === 'create-pr' && res.decision === 'pr_draft' && !res.prUrl && res.detail) {
        toast.error(t('railPr.createDegraded', { detail: res.detail }))
      }
      // Success state changes arrive via the rail.pr_state broadcast.
    } finally {
      setInFlight(null)
    }
  }

  async function runCheckout() {
    if (!checkout || inFlight || checkingOut || decision.operation) return
    setCheckingOut(true)
    try {
      const res = await checkout()
      if (!res.ok) {
        if (res.status === 409 && res.error === 'project_recovery_in_progress') {
          toast.info(t('common:prRecovery.inProgress'))
          return
        }
        toast.warning(t('railPr.checkoutFailed'), { description: res.detail ?? res.error })
        return
      }
      toast.success(t('railPr.checkoutSuccess', { branch: decision.branch ?? '' }))
    } finally {
      setCheckingOut(false)
    }
  }

  // ── shared bits ─────────────────────────────────────────────────────────────
  const pillBase = `inline-flex items-center gap-1 rounded-full font-medium border ${
    compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
  }`
  const primaryBtn = `inline-flex items-center gap-1 rounded-md font-medium bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
    compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
  }`
  const ghostBtn = `inline-flex items-center gap-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
    compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
  }`
  const iconCls = compact ? 'w-2.5 h-2.5' : 'w-3 h-3'
  const spinner = <Loader2 className={`${iconCls} animate-spin`} aria-hidden />
  const busy = inFlight !== null || checkingOut || decision.operation != null
  const discardTitle = d === 'implementation_failed' ? t('railPr.implementationFailedHint') : t('railPr.discardTooltip')

  const linkChip = decision.prUrl ? (
    <a
      href={decision.prUrl}
      target="_blank"
      rel="noreferrer"
      data-testid="rail-pr-link"
      title={t('railPr.openPrTitle')}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 rounded-md font-mono border border-accent-info/30 bg-accent-info/10 text-accent-info hover:bg-accent-info/20 hover:border-accent-info/60 transition-colors ${
        compact ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'
      }`}
    >
      {decision.prNumber != null ? `#${decision.prNumber}` : t('railPr.prLinkFallback')}
      <ExternalLink className={compact ? 'w-2 h-2' : 'w-2.5 h-2.5'} aria-hidden />
    </a>
  ) : null
  const branchChip = decision.branch ? (
    <span
      data-testid="rail-pr-branch"
      className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-md font-mono border border-border/60 bg-surface/60 text-foreground/70 ${
        compact ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'
      }`}
    >
      <span className="truncate">{decision.branch}</span>
    </span>
  ) : null

  const discardBtn = (
    <button
      type="button"
      data-testid="rail-pr-discard"
      disabled={busy}
      title={discardTitle}
      onClick={(e) => { e.stopPropagation(); setConfirmDiscard(true) }}
      className={ghostBtn}
    >
      {inFlight === 'discard' ? spinner : null}
      {t('railPr.discard')}
    </button>
  )

  // Remote-less acceptance: integrate the delivered branches into the base
  // branch locally. Offered wherever no real PR exists yet (on_review,
  // degraded draft, pr_failed) — the GitHub-less journey's way to say "yes".
  const mergeLocalBtn = (
    <button
      type="button"
      data-testid="rail-pr-merge-local"
      disabled={busy}
      title={t('railPr.mergeLocalTooltip', { base: decision.baseBranch })}
      onClick={(e) => { e.stopPropagation(); setConfirmMergeLocal(true) }}
      className={`inline-flex items-center gap-1 rounded-md font-medium border border-accent-success/40 bg-accent-success/10 text-accent-success hover:bg-accent-success/20 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
        compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
      }`}
    >
      {inFlight === 'merge-local' ? spinner : <GitMerge className={iconCls} aria-hidden />}
      {t('railPr.mergeLocal')}
    </button>
  )

  const actionButton = (
    action: RailPrDecisionAction,
    expected: RailPrDecision,
    label: string,
    testId: string,
    title?: string,
    icon?: React.ReactNode,
  ) => (
    <button
      type="button"
      data-testid={testId}
      disabled={busy}
      title={title}
      onClick={(e) => { e.stopPropagation(); void run(action, expected) }}
      className={primaryBtn}
    >
      {inFlight === action ? spinner : icon}
      {label}
    </button>
  )

  const checkoutBtn = checkout && decision.prUrl && decision.branch ? (
    <button
      type="button"
      data-testid="rail-pr-checkout"
      disabled={busy}
      title={t('railPr.checkoutTooltip', { branch: decision.branch })}
      onClick={(e) => { e.stopPropagation(); void runCheckout() }}
      className={`inline-flex items-center gap-1 rounded-md font-medium border border-border/60 text-foreground/70 hover:border-accent-primary/40 hover:bg-accent-primary/10 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
        compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
      }`}
    >
      {checkingOut ? spinner : <GitBranch className={iconCls} aria-hidden />}
      {t('railPr.checkout')}
    </button>
  ) : null

  const runLogChips = (decision.runIds ?? []).map((runId, index) => (
    <button
      key={runId}
      type="button"
      data-testid="rail-pr-run-log"
      title={t('railPr.viewRunLog', { ref: decision.ticketIds[index] != null ? `#${decision.ticketIds[index]}` : runId.slice(0, 8) })}
      aria-label={t('railPr.viewRunLog', { ref: decision.ticketIds[index] != null ? `#${decision.ticketIds[index]}` : runId.slice(0, 8) })}
      onClick={(event) => { event.stopPropagation(); navigate(`/jobs/${runId}`) }}
      className={`inline-flex items-center gap-1 rounded-md border border-accent-info/30 bg-accent-info/10 font-medium text-accent-info transition-colors hover:border-accent-info/55 hover:bg-accent-info/15 ${
        compact ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'
      }`}
    >
      <ScrollText className={iconCls} aria-hidden />
      {decision.ticketIds[index] != null ? `#${decision.ticketIds[index]}` : runId.slice(0, 8)}
    </button>
  ))

  const unitEvidence = (decision.units ?? []).map((unit) => {
    const failed = unit.implementationOutcome === 'failed' || (unit.implementationOutcome == null && !unit.succeeded)
    const blocked = unit.deliveryOutcome === 'blocked'
    const noChanges = unit.deliveryOutcome === 'no_changes' || unit.changed === false
    return (
      <span
        key={`${unit.ticketId}-${unit.runId ?? unit.branch}`}
        data-testid="rail-pr-unit-evidence"
        title={unit.failureCode ?? unit.branch}
        className={`${pillBase} ${
          failed
            ? 'border-destructive/30 bg-destructive/10 text-destructive'
            : blocked
              ? 'border-accent-warning/30 bg-accent-warning/10 text-accent-warning'
              : 'border-accent-success/30 bg-accent-success/10 text-accent-success'
        }`}
      >
        #{unit.ticketId} · {t(failed ? 'railPr.unit.failed' : blocked ? 'railPr.unit.blocked' : noChanges ? 'railPr.unit.noChanges' : 'railPr.unit.succeeded')}
      </span>
    )
  })

  const dismissBtn = (
    <button
      type="button"
      data-testid="rail-pr-dismiss"
      disabled={busy}
      onClick={(event) => { event.stopPropagation(); setConfirmDismiss(true) }}
      className={ghostBtn}
    >
      {inFlight === 'dismiss' ? spinner : null}
      {t('railPr.dismiss')}
    </button>
  )

  const discardLocalBtn = (
    <button
      type="button"
      data-testid="rail-pr-discard-local"
      disabled={busy}
      onClick={(event) => { event.stopPropagation(); setConfirmDiscardLocal(true) }}
      className={ghostBtn}
    >
      {inFlight === 'discard' ? spinner : null}
      {t('railPr.discardLocalResult')}
    </button>
  )

  const acknowledgeNoChangesBtn = (
    <button
      type="button"
      data-testid="rail-pr-no-changes-done"
      disabled={busy}
      onClick={(event) => { event.stopPropagation(); setConfirmNoChangesDone(true) }}
      className={primaryBtn}
    >
      {inFlight === 'acknowledge-no-changes' ? spinner : <CheckCircle2 className={iconCls} aria-hidden />}
      {t('railPr.markDone')}
    </button>
  )

  const refineBtn = (
    <button
      type="button"
      data-testid="rail-pr-refine"
      disabled={busy}
      onClick={(event) => { event.stopPropagation(); setConfirmRefine(true) }}
      className={ghostBtn}
    >
      {inFlight === 'discard' ? spinner : null}
      {t('railPr.refine')}
    </button>
  )

  // ── per-state pill + actions ────────────────────────────────────────────────
  let pill: React.ReactNode = null
  let actions: React.ReactNode = null

  if (existingPrIteration) {
    pill = (
      <span className={`${pillBase} border-accent-info/30 bg-accent-info/10 text-accent-info`}>
        <Loader2 className={`${iconCls} animate-spin`} aria-hidden />
        {t('railPr.iteratingPr')}
      </span>
    )
    actions = (
      <>
        {linkChip}
        {branchChip}
      </>
    )
  } else if (presentation.noChanges) {
    pill = (
      <span className={`${pillBase} border-accent-success/30 bg-accent-success/10 text-accent-success`}>
        <CheckCircle2 className={iconCls} aria-hidden />
        {t('railPr.noChanges')}
      </span>
    )
    actions = <>{decision.prUrl ? linkChip : null}{presentation.continuation ? dismissBtn : <>{acknowledgeNoChangesBtn}{refineBtn}</>}</>
  } else if (presentation.partial && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && !presentation.closed) {
    pill = (
      <span className={`${pillBase} border-accent-warning/30 bg-accent-warning/10 text-accent-warning`}>
        <AlertTriangle className={iconCls} aria-hidden />
        {t('railPr.partial', { succeeded: presentation.succeededCount, total: presentation.totalCount })}
      </span>
    )
    if (d === 'pr_draft' && decision.prUrl) {
      actions = (
        <>
          {linkChip}
          {checkoutBtn}
          {actionButton('publish', 'pr_draft', t('railPr.publish'), 'rail-pr-publish', t('railPr.publishTooltip'))}
          {presentation.continuation ? dismissBtn : discardBtn}
        </>
      )
    } else if (d === 'pr_ready') {
      actions = (
        <>
          {linkChip}
          {checkoutBtn}
          {actionButton('poll-merge', 'pr_ready', t('railPr.checkMerge'), 'rail-pr-poll', t('railPr.checkMergeTooltip'))}
          {presentation.continuation ? dismissBtn : discardBtn}
        </>
      )
    } else if (d === 'on_review' || (d === 'pr_draft' && !decision.prUrl)) {
      actions = (
        <>
          {actionButton('create-pr', d, t('railPr.createPartialPr', { count: presentation.deliverableCount }), 'rail-pr-create-partial')}
          {presentation.continuation ? dismissBtn : discardBtn}
        </>
      )
    } else {
      actions = <>{linkChip}{checkoutBtn}{presentation.continuation ? dismissBtn : discardBtn}</>
    }
  } else if (presentation.deliveryBlocked) {
    pill = (
      <span className={`${pillBase} border-accent-warning/30 bg-accent-warning/10 text-accent-warning`} title={decision.statusDetail ?? undefined}>
        <AlertTriangle className={iconCls} aria-hidden />
        {t('railPr.deliveryBlocked')}
      </span>
    )
    actions = <>{linkChip}{checkoutBtn}{presentation.partialUndeliverable && presentation.continuation ? dismissBtn : discardLocalBtn}</>
  } else if (presentation.retryablePush) {
    pill = (
      <span className={`${pillBase} border-accent-warning/30 bg-accent-warning/10 text-accent-warning`} title={decision.statusDetail ?? undefined}>
        <AlertTriangle className={iconCls} aria-hidden />
        {t('railPr.updateFailed')}
      </span>
    )
    actions = (
      <>
        {linkChip}
        {checkoutBtn}
        {actionButton('create-pr', d, t('railPr.retryPush'), 'rail-pr-retry-push')}
        {presentation.continuation ? dismissBtn : discardBtn}
      </>
    )
  } else if (presentation.retryablePrCreation) {
    pill = (
      <span className={`${pillBase} border-accent-warning/30 bg-accent-warning/10 text-accent-warning`} title={decision.statusDetail ?? undefined}>
        <AlertTriangle className={iconCls} aria-hidden />
        {presentation.localOnly
          ? t('railPr.localOnly')
          : decision.prState === 'pushed'
            ? t('railPr.branchPushed')
            : t('railPr.prFailed')}
      </span>
    )
    actions = (
      <>
        {actionButton('create-pr', d, t('railPr.retryPr'), 'rail-pr-create')}
        {mergeLocalBtn}
        {presentation.continuation ? dismissBtn : discardBtn}
      </>
    )
  } else if (presentation.closed) {
    pill = (
      <span className={`${pillBase} border-accent-warning/30 bg-accent-warning/10 text-accent-warning`}>
        <AlertTriangle className={iconCls} aria-hidden />
        {t('railPr.prClosed')}
      </span>
    )
    actions = (
      <>
        {linkChip}
        {checkoutBtn}
        {actionButton('reopen', 'pr_closed', t('railPr.reopen'), 'rail-pr-reopen', undefined, <RotateCcw className={iconCls} aria-hidden />)}
        {presentation.continuation ? dismissBtn : discardBtn}
      </>
    )
  } else if (d === 'on_review') {
    pill = (
      <span className={`${pillBase} border-accent-warning/30 bg-accent-warning/10 text-accent-warning`}>
        <Eye className={iconCls} aria-hidden />
        {t('railPr.readyForReview')}
      </span>
    )
    actions = (
      <>
        {actionButton('create-pr', 'on_review', t('railPr.createPr'), 'rail-pr-create', t('railPr.createPrTooltip', { base: decision.baseBranch }), <GitPullRequest className={iconCls} aria-hidden />)}
        {mergeLocalBtn}
        {presentation.continuation ? dismissBtn : discardBtn}
      </>
    )
  } else if (d === 'pr_draft' && decision.prUrl) {
    pill = (
      <span className={`${pillBase} border-accent-info/30 bg-accent-info/10 text-accent-info`}>
        <GitPullRequest className={iconCls} aria-hidden />
        {t('railPr.draftPr')}
      </span>
    )
    actions = (
      <>
        {linkChip}
        {checkoutBtn}
        {actionButton('publish', 'pr_draft', t('railPr.publish'), 'rail-pr-publish', t('railPr.publishTooltip'))}
        {presentation.continuation ? dismissBtn : discardBtn}
      </>
    )
  } else if (d === 'pr_draft') {
    // Degraded delivery: branch pushed (or kept local) but no PR exists — the
    // only ways forward are retrying the failed stage or discarding.
    pill = (
      <span className={`${pillBase} border-accent-warning/30 bg-accent-warning/10 text-accent-warning`} title={t('railPr.branchPushedHint')}>
        <AlertTriangle className={iconCls} aria-hidden />
        {presentation.localOnly ? t('railPr.localOnly') : t('railPr.branchPushed')}
      </span>
    )
    actions = (
      <>
        {actionButton('create-pr', 'pr_draft', t('railPr.retryPr'), 'rail-pr-create', t('railPr.createPrTooltip', { base: decision.baseBranch }))}
        {mergeLocalBtn}
        {presentation.continuation ? dismissBtn : discardBtn}
      </>
    )
  } else if (d === 'pr_ready') {
    pill = (
      <span className={`${pillBase} border-accent-success/30 bg-accent-success/10 text-accent-success`}>
        <GitMerge className={iconCls} aria-hidden />
        {t('railPr.prReady')}
      </span>
    )
    actions = (
      <>
        {linkChip}
        {checkoutBtn}
        {actionButton('poll-merge', 'pr_ready', t('railPr.checkMerge'), 'rail-pr-poll', t('railPr.checkMergeTooltip'))}
        {presentation.continuation ? dismissBtn : discardBtn}
      </>
    )
  } else if (d === 'pr_failed') {
    pill = (
      <span className={`${pillBase} border-destructive/30 bg-destructive/10 text-destructive`}>
        <AlertTriangle className={iconCls} aria-hidden />
        {t('railPr.prFailed')}
      </span>
    )
    actions = (
      <>
        {linkChip}
        {checkoutBtn}
        {actionButton('create-pr', 'pr_failed', t('railPr.retry'), 'rail-pr-create', t('railPr.createPrTooltip', { base: decision.baseBranch }))}
        {!decision.prUrl && mergeLocalBtn}
        {presentation.continuation ? dismissBtn : discardBtn}
      </>
    )
  } else if (d === 'implementation_failed' && presentation.implementationFailed) {
    pill = (
      <span className={`${pillBase} border-destructive/30 bg-destructive/10 text-destructive`} title={t('railPr.implementationFailedHint')}>
        <AlertTriangle className={iconCls} aria-hidden />
        {t('railPr.implementationFailed')}
      </span>
    )
    actions = (
      <>
        {presentation.continuation ? dismissBtn : discardBtn}
      </>
    )
  }

  return (
    <div
      data-testid="rail-pr-strip"
      data-decision={d}
      className={`flex items-center flex-wrap animate-in fade-in slide-in-from-top-1 duration-200 ${compact ? 'gap-1' : 'gap-1.5'}`}
      onClick={(e) => e.stopPropagation()}
    >
      {announcement && <span role="status" aria-live="polite" aria-label={announcement} className="sr-only" />}
      {pill}
      {decision.operation && (
        <span className={`${pillBase} border-accent-info/30 bg-accent-info/10 text-accent-info`} data-testid="rail-pr-operation">
          <Loader2 className={`${iconCls} animate-spin`} aria-hidden />
          {t(`railPr.operation.${decision.operation}`)}
        </span>
      )}
      {actions}
      {runLogChips}
      {unitEvidence}
      {statusLabel && (
        <span className={`${pillBase} border-border/60 bg-surface/60 text-foreground/55`} data-testid="rail-pr-status-code">
          {statusLabel}
        </span>
      )}

      {(recoveredInterruptedOperation || (!interruptedOperationDetail && decision.statusDetail) || presentation.cleanupWarnings.length > 0) && (
        <div className={`basis-full rounded-md border border-accent-warning/30 bg-accent-warning/10 text-accent-warning ${compact ? 'px-1.5 py-1 text-[9px]' : 'px-2 py-1.5 text-[10px]'}`} data-testid="rail-pr-delivery-detail">
          {recoveredInterruptedOperation && (
            <p className="flex items-start gap-1.5" data-testid="rail-pr-recovery-interrupted">
              <RotateCcw className={`${iconCls} mt-px shrink-0`} aria-hidden />
              <span>{t('common:prRecovery.interrupted')}</span>
            </p>
          )}
          {!interruptedOperationDetail && decision.statusDetail && <p>{decision.statusDetail}</p>}
          {presentation.cleanupWarnings.length > 0 && (
            <div className={recoveredInterruptedOperation || (!interruptedOperationDetail && decision.statusDetail) ? 'mt-1' : undefined}>
              <p className="font-medium">{t('railPr.cleanupIncomplete', { count: presentation.cleanupWarnings.length })}</p>
              <ul className="mt-0.5 list-disc pl-4 text-foreground/60">
                {presentation.cleanupWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Merge-local confirmation — it writes merge commits into the user's
          checkout of the base branch. Constructive but repo-touching. */}
      <Dialog open={confirmMergeLocal} onOpenChange={setConfirmMergeLocal}>
        <DialogContent className="max-w-sm" data-testid="rail-pr-merge-local-confirm">
          <DialogHeader>
            <DialogTitle>{t('railPr.mergeLocalConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('railPr.mergeLocalConfirmBody', { base: decision.baseBranch })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmMergeLocal(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              data-testid="rail-pr-merge-local-confirm-btn"
              onClick={() => { setConfirmMergeLocal(false); void run('merge-local', d) }}
            >
              {t('railPr.mergeLocal')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fresh discard is consequence-specific: failed implementations keep
          recoverable local work for inspection and clean up only safe state. */}
      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent className="max-w-sm" data-testid="rail-pr-discard-confirm">
          <DialogHeader>
            <DialogTitle>{t(d === 'implementation_failed'
              ? 'railPr.implementationFailedDiscardTitle'
              : 'railPr.discardConfirmTitle')}</DialogTitle>
            <DialogDescription>{t(d === 'implementation_failed'
              ? 'railPr.implementationFailedDiscardBody'
              : 'railPr.discardConfirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDiscard(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              data-testid="rail-pr-discard-confirm-btn"
              onClick={() => { setConfirmDiscard(false); void run('discard', d) }}
            >
              {t('railPr.discard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* A continuation borrows the user's existing PR. Dismiss only clears
          this follow-up generation; it does not close/delete external state. */}
      <Dialog open={confirmDismiss} onOpenChange={setConfirmDismiss}>
        <DialogContent className="max-w-sm" data-testid="rail-pr-dismiss-confirm">
          <DialogHeader>
            <DialogTitle>{t('railPr.dismissConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('railPr.dismissConfirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDismiss(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              data-testid="rail-pr-dismiss-confirm-btn"
              onClick={() => { setConfirmDismiss(false); void run('dismiss', d) }}
            >
              {t('railPr.dismiss')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Blocked work can contain the only recoverable local result. Name that
          consequence separately from dismissing a clean continuation. */}
      <Dialog open={confirmDiscardLocal} onOpenChange={setConfirmDiscardLocal}>
        <DialogContent className="max-w-sm" data-testid="rail-pr-discard-local-confirm">
          <DialogHeader>
            <DialogTitle>{t('railPr.discardLocalConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('railPr.discardLocalConfirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDiscardLocal(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              data-testid="rail-pr-discard-local-confirm-btn"
              onClick={() => { setConfirmDiscardLocal(false); void run('discard', d) }}
            >
              {t('railPr.discardLocalResult')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmNoChangesDone} onOpenChange={setConfirmNoChangesDone}>
        <DialogContent className="max-w-sm" data-testid="rail-pr-no-changes-done-confirm">
          <DialogHeader>
            <DialogTitle>{t('railPr.markDoneConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('railPr.markDoneConfirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmNoChangesDone(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              data-testid="rail-pr-no-changes-done-confirm-btn"
              onClick={() => { setConfirmNoChangesDone(false); void run('acknowledge-no-changes', d) }}
            >
              {t('railPr.markDone')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRefine} onOpenChange={setConfirmRefine}>
        <DialogContent className="max-w-sm" data-testid="rail-pr-refine-confirm">
          <DialogHeader>
            <DialogTitle>{t('railPr.refineConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('railPr.refineConfirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmRefine(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              data-testid="rail-pr-refine-confirm-btn"
              onClick={() => { setConfirmRefine(false); void run('discard', d) }}
            >
              {t('railPr.refine')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
