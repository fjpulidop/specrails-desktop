import { localizeStatusDetail } from '../../../lib/pr-status-detail'
import { RunStateDot } from '../../../components/ui/run-state/run-state-dot'
import { runStateLook, type RunState } from '../../../components/ui/run-state/run-state'
import { deliveryLook } from '../lib/delivery-run-state'
import { getApiBase } from '../../../lib/api'
import { FEATURE_PR_CI_CARD } from '../../../lib/feature-flags'
import { postPrCiLaunch, prCiFixable, usePrCiAvailability } from '../lib/pr-ci'
import { HelpHint } from '../../../components/HelpHint'
import { RailTrack } from '../../../components/brand/RailTrack'
import { TechnicalDetail } from '../../../components/ui/technical-detail'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { FEATURE_REVIEW_PACKET } from '../../../lib/feature-flags'
import { toast } from 'sonner'
import { GitPullRequest, GitMerge, ExternalLink, Loader2, Eye, GitBranch, ScrollText, CheckCircle2, RotateCcw, Play, FolderOpen, MoreHorizontal, type LucideIcon } from 'lucide-react'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu'
import type { RailPrDecision, RailPrDecisionAction, RailPrStateSnapshot } from '../../../types'
import type { RailPrActResult, RailPrCheckoutResult } from '../context/RailPrDecisionContext'
import { derivePrDeliveryPresentation, isInterruptedPrDeliveryOperation, isKnownPrDeliveryStatusCode, prDeliveryCheckoutBranch } from '../lib/pr-delivery'
import { isTauri, revealItemInDir } from '../../../lib/tauri-shell'
import { DeliveryArrival } from '../../../components/brand/DeliveryArrival'
import { RepositoryDeliveries } from './RepositoryDeliveries'
import { TopRiskLine } from './TopRiskLine'
import { MergePreviewLine } from './MergePreviewLine'
import { FLOW_SPEC_LOOP_ID, LoopChip, useLoopLabel } from './LoopChip'
import { useRuntimeRuns } from '../../jobs/components/job-run/useRuntimeRuns'
import { useContinueRemedies } from '../../recovery/hooks/useContinueRemedies'
import { useAttemptChain } from '../../recovery/hooks/useAttemptChain'
import { useRunDiagnosis } from '../../recovery/hooks/useRunDiagnosis'
import { useDiagnosisText } from '../../recovery/components/FailureDiagnosisCard'
import type { FailureDiagnosis } from '../../recovery/lib/failure-diagnosis'
import { SafetyArchiveNotice } from './SafetyArchiveNotice'
import { useDesktop } from '../../../hooks/useDesktop'
import { useStackedHeadDeliveryIds } from '../../builder/hooks/useMilestoneProgress'

import { notifyError } from '../../../lib/notify-error'
interface RailPrDecisionStripProps {
  decision: RailPrStateSnapshot
  density: 'normal' | 'compact'
  /** POSTs /rails/pr-decision for this rail (bound to railIndex upstream). */
  act: (
    action: RailPrDecisionAction,
    expectedDecision: RailPrDecision,
    expectedPrDeliveryId: string,
    repositoryId?: string,
  ) => Promise<RailPrActResult>
  /** Checks out this delivery's PR branch in the user's main repo. */
  checkout?: (expectedPrDeliveryId: string, repositoryId?: string) => Promise<RailPrCheckoutResult>
}

type ConfirmationKind = 'merge-local' | 'discard' | 'dismiss' | 'discard-local' | 'no-changes-done' | 'refine' | 'recover-and-retry'

interface PendingConfirmation {
  kind: ConfirmationKind
  prDeliveryId: string
  expectedDecision: RailPrDecision
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
  const { activeProjectId: stripProjectId } = useDesktop()
  const stackedHeads = useStackedHeadDeliveryIds(stripProjectId)
  const [inFlight, setInFlight] = useState<RailPrDecisionAction | null>(null)
  // Refine runs the `discard` action: remember which button started it so only that one shows the spinner.
  const [inFlightKind, setInFlightKind] = useState<ConfirmationKind | null>(null)
  const pendingKindRef = useRef<ConfirmationKind | null>(null)
  const [relaunching, setRelaunching] = useState(false)
  const [checkingOut, setCheckingOut] = useState(false)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const currentDeliveryIdRef = useRef(decision.prDeliveryId)
  currentDeliveryIdRef.current = decision.prDeliveryId
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => {
    // Rail rows are reused. A dialog or pending request opened for generation A
    // must disappear when generation B replaces it on the same rail.
    setConfirmation(null)
    setInFlight(null)
    setCheckingOut(false)
  }, [decision.prDeliveryId])

  const d = decision.decision
  const hasRepositoryDeliveries = Boolean(decision.repositoryDeliveries?.length)
  const presentation = derivePrDeliveryPresentation(decision)
  // A failed attempt may be resumable. Ask the runtime for that one run only while the strip is in that
  // state (the same cheap per-run poll the mission card uses); never for any other decision.
  const failedRunId = decision.runIds?.[0] ?? null
  // A person stopped the run before it delivered: information, not a failure.
  const runStopped = d === 'implementation_failed' && decision.statusCode === 'run_stopped'
  const implementationFailedStrip = d === 'implementation_failed' && presentation.implementationFailed && decision.statusCode !== 'review_changes_requested'
  const runtimeRuns = useRuntimeRuns(stripProjectId, { jobId: failedRunId ?? undefined, enabled: implementationFailedStrip && !!failedRunId })
  const failedRun = runtimeRuns.runs.find((run) => run.runId === failedRunId) ?? null
  // The reason the run stopped, in the run window's own words (its failure card's headline).
  const failureDiagnosis = useRunDiagnosis(stripProjectId, failedRunId, implementationFailedStrip && !runStopped && !!failedRunId, decision.statusCode)
  const canResume = failedRun !== null && failedRun.canResume && !failedRun.active
  const relaunchBlocked = failedRun !== null && (failedRun.active || failedRun.status === 'running' || failedRun.status === 'paused')
  // A settled definition run continues where it failed or stopped, keeping its work (never a relaunch
  // from the base). The runtime list omits settled runs, so the run's own record says whether it can.
  const continuity = useAttemptChain(stripProjectId, implementationFailedStrip ? failedRunId : null, decision.statusCode)
  const continuable = !canResume && !relaunchBlocked && decision.loopId !== FLOW_SPEC_LOOP_ID
    && (failedRun ? failedRun.engineVersion === 2 && !failedRun.forkSuccessor : continuity.continuable)
  const continueRemedies = useContinueRemedies(stripProjectId, continuable ? failedRunId : null, null, { enabled: implementationFailedStrip && continuable })
  const continueRun = continueRemedies.continue ?? null
  // An Intent session → Spec run relaunches from its Intent (mission card): the rail relaunch refuses that loop.
  const flowSpecRun = decision.loopId === FLOW_SPEC_LOOP_ID
  const loopLabel = useLoopLabel(decision.loopId, decision.loopName)
  const interruptedOperationDetail = isInterruptedPrDeliveryOperation(decision.statusCode, decision.statusDetail)
  const statusDetail = localizeStatusDetail(decision.statusDetail, t('railPr.failed.generic'))
  const recoveredInterruptedOperation = decision.operation == null && interruptedOperationDetail
  // The status-code chip repeats the state pill when both say the same thing.
  const statusRepeatsPill =
    (decision.decision === 'on_review' && decision.statusCode === 'ready_for_review') ||
    (decision.decision === 'pr_ready' && decision.statusCode === 'pr_ready') ||
    (decision.decision === 'pr_draft' && decision.statusCode === 'pr_draft_ready') ||
    (decision.decision === 'implementation_failed' && decision.statusCode === 'implementation_failed') ||
    runStopped
  const statusLabel = isKnownPrDeliveryStatusCode(decision.statusCode) && !statusRepeatsPill
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
                  ? t(runStopped ? 'railPr.runStopped' : 'railPr.implementationFailed')
                  : null
  const existingPrIteration = d === 'building' && decision.prState === 'pr-created' && Boolean(decision.branch)
  if ((d === 'building' && !existingPrIteration) || d === 'merged' || d === 'discarded' || d === 'completed' || d === 'superseded') return null

  const compact = density === 'compact'

  const confirmationIsOpen = (kind: ConfirmationKind): boolean => (
    !(hasRepositoryDeliveries && (kind === 'merge-local' || kind === 'no-changes-done')) &&
    confirmation?.kind === kind && confirmation.prDeliveryId === decision.prDeliveryId
  )
  const openConfirmation = (kind: ConfirmationKind): void => {
    setConfirmation({ kind, prDeliveryId: decision.prDeliveryId, expectedDecision: d })
  }
  const closeConfirmation = (): void => setConfirmation(null)
  const confirmAction = (kind: ConfirmationKind, action: RailPrDecisionAction): void => {
    const captured = confirmation
    setConfirmation(null)
    if (
      !mountedRef.current ||
      !captured ||
      captured.kind !== kind ||
      captured.prDeliveryId !== decision.prDeliveryId ||
      captured.prDeliveryId !== currentDeliveryIdRef.current
    ) return
    pendingKindRef.current = kind
    void run(action, captured.expectedDecision, captured.prDeliveryId)
  }

  async function run(
    action: RailPrDecisionAction,
    expected: RailPrDecision,
    expectedDeliveryId = decision.prDeliveryId,
    repositoryId?: string,
  ) {
    if (hasRepositoryDeliveries && !repositoryId && ['create-pr', 'merge-local', 'publish', 'poll-merge', 'reopen', 'acknowledge-no-changes'].includes(action)) return
    if (
      !mountedRef.current ||
      expectedDeliveryId !== decision.prDeliveryId ||
      expectedDeliveryId !== currentDeliveryIdRef.current ||
      inFlight || checkingOut || decision.operation
    ) return
    const repository = decision.repositoryDeliveries?.find((item) => item.repositoryId === repositoryId)
    const targetBase = repository?.integrationBranch ?? repository?.baseBranch ?? decision.baseBranch
    setInFlightKind(pendingKindRef.current)
    pendingKindRef.current = null
    setInFlight(action)
    try {
      const res = await (repositoryId ? act(action, expected, expectedDeliveryId, repositoryId) : act(action, expected, expectedDeliveryId))
      if (!mountedRef.current || currentDeliveryIdRef.current !== expectedDeliveryId) return
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
        if (res.error === 'merge_local_blocked' && (res.reason === 'dirty' || res.reason === 'wrong_branch')) {
          toast.warning(res.reason === 'dirty'
            ? t('railPr.mergeLocalBlockedDirty', { base: res.base ?? targetBase })
            : t('railPr.mergeLocalBlockedBranch', { base: res.base ?? targetBase, current: res.current ?? '?' }))
          return
        }
        // A concurrent answer (other surface / other client) won — the
        // broadcast reconciles the strip; just say so, neutrally.
        if (res.error === 'stale_decision') {
          toast.info(t('railPr.alreadyResolved'))
        } else {
          notifyError(t('railPr.actionFailed'), { detail: res.detail ?? res.error })
        }
        return
      }
      if (res.status === 502) {
        if (res.error === 'merge_failed') {
          notifyError(t('railPr.mergeLocalFailed'), { detail: res.detail ?? '' })
          return
        }
        notifyError(t('railPr.ghFailed'), { detail: res.detail ?? res.error ?? '' })
        return
      }
      if (!res.ok) {
        notifyError(t('railPr.actionFailed'))
        return
      }
      if (res.snapshot && res.snapshotApplication && res.snapshotApplication !== 'accepted') {
        // The HTTP operation may have succeeded for generation A after this
        // rail already advanced to B. Never celebrate A as B's result.
        toast.info(t('railPr.alreadyResolved'))
        return
      }
      if (action === 'poll-merge' && res.merged === false && res.decision !== 'pr_closed' && res.deliveryVerified == null) {
        toast.info(t('railPr.notMergedYet'))
      }
      if (action === 'merge-local' && res.decision === 'merged') {
        const tickets = decision.ticketIds.map((id) => `#${id}`).join(', ')
        const stash = res.localChanges
        const agent = !!decision.originConversationId
        if (stash?.state === 'restored') toast.success(t('railPr.mergedLocallyRestored', { tickets }))
        else if (stash?.state === 'needs_attention' && agent) toast.warning(t('railPr.mergedLocallyStashConflict', { tickets }), { description: stash.stashName })
        else if (stash?.state === 'needs_attention' || stash?.state === 'saved') toast.warning(t('railPr.mergedLocallyStashKept', { tickets }), { description: stash.stashName })
        else toast.success(t('railPr.mergedLocally', { base: targetBase }))
      }
      if (action === 'recover-and-retry') {
        if (res.deliveryVerified) {
          const sha = (res.verifiedSha ?? res.snapshot?.deliverySha ?? '').slice(0, 8)
          toast.success(t('railPr.recoverAndRetryVerified', { sha }))
        } else if (res.recoveryUnavailable || res.snapshot?.statusCode === 'recovery_unavailable') {
          toast.info(t('railPr.recoveryUnavailable'), { description: t('railPr.recoveryUnavailableBody') })
        } else {
          toast.warning(t('railPr.recoveryStillBlocked'), { description: res.detail ?? undefined })
        }
        return
      }
      if (action === 'create-pr' && presentation.retryablePush && res.deliveryVerified) {
        const sha = (res.verifiedSha ?? res.snapshot?.deliverySha ?? decision.deliverySha ?? '').slice(0, 8)
        toast.success(t(res.pushed ? 'railPr.retryPushVerified' : 'railPr.commitAlreadyVerified', { sha }))
        return
      }
      // create-pr can succeed as an HTTP call yet land on pr_failed (retryable
      // delivery failure) — say so, carrying the underlying git/gh detail when
      // the server relayed one; the broadcast flips the strip to Retry.
      if (action === 'create-pr' && res.decision === 'pr_failed') {
        notifyError(t('railPr.prFailed'), { detail: res.detail })
        return
      }
      // …or land on a DEGRADED pr_draft (pushed / local-only — no PR exists):
      // surface WHY (the git stderr detail) so the user knows what to fix
      // before hitting Retry instead of a silent pill flip.
      if (action === 'create-pr' && res.decision === 'pr_draft' && !res.prUrl && res.detail) {
        notifyError(t('railPr.createDegraded', { detail: res.detail }))
      }
      if (action === 'poll-merge' && res.deliveryVerified === false) {
        toast.warning(t('railPr.commitMissingRetry'))
        return
      }
      if (action === 'poll-merge' && res.deliveryVerified && res.merged === false) {
        const sha = (res.verifiedSha ?? res.snapshot?.deliverySha ?? decision.deliverySha ?? '').slice(0, 8)
        toast.success(t('railPr.prVerifiedWaiting', { sha }))
        return
      }
      // Success state changes arrive via the rail.pr_state broadcast.
    } finally {
      if (mountedRef.current && currentDeliveryIdRef.current === expectedDeliveryId) setInFlight(null)
    }
  }

  /** Run the failed attempt again on its rail. The server re-resolves the source delivery and validates limits. */
  async function relaunch(): Promise<void> {
    if (relaunching || inFlight || checkingOut || decision.operation) return
    let base: string
    try { base = getApiBase() } catch { return }
    setRelaunching(true)
    try {
      const res = await fetch(`${base}/rails/${decision.railIndex}/relaunch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: decision.prDeliveryId }),
      })
      if (res.status === 202) { toast.success(t('railPr.relaunchSent')); return }
      const body = await res.json().catch(() => ({})) as { error?: string; detail?: string }
      notifyError(t('railPr.relaunchFailed'), { detail: body.detail ?? body.error, retry: () => void relaunch() })
    } catch (e) {
      notifyError(t('railPr.relaunchFailed'), { detail: e instanceof Error ? e.message : undefined, retry: () => void relaunch() })
    } finally {
      if (mountedRef.current) setRelaunching(false)
    }
  }

  async function runCheckout(repositoryId?: string) {
    if (hasRepositoryDeliveries && !repositoryId) return
    if (!mountedRef.current || !checkout || inFlight || checkingOut || decision.operation) return
    const expectedDeliveryId = decision.prDeliveryId
    setCheckingOut(true)
    try {
      const res = await (repositoryId ? checkout(expectedDeliveryId, repositoryId) : checkout(expectedDeliveryId))
      if (!mountedRef.current || currentDeliveryIdRef.current !== expectedDeliveryId) return
      if (!res.ok) {
        if (res.status === 409 && res.error === 'project_recovery_in_progress') {
          toast.info(t('common:prRecovery.inProgress'))
          return
        }
        if (res.error === 'checkout_dirty') {
          toast.warning(t('railPr.checkoutDirtyTitle'), { description: t('railPr.checkoutDirtyBody') })
          return
        }
        if (res.error === 'checkout_not_deliverable') {
          toast.warning(t('railPr.checkoutNotDeliverableTitle'), { description: t('railPr.checkoutNotDeliverableBody') })
          return
        }
        if (res.error === 'checkout_safety_unknown') {
          toast.warning(t('railPr.checkoutSafetyUnknownTitle'), { description: t('railPr.checkoutSafetyUnknownBody') })
          return
        }
        toast.warning(t('railPr.checkoutFailed'), { description: res.detail ?? res.error })
        return
      }
      toast.success(t('railPr.checkoutSuccess', { branch: res.branch ?? prDeliveryCheckoutBranch(decision) ?? '' }))
      if (res.cleanupWarnings?.length) {
        toast.warning(t('railPr.cleanupIncomplete', { count: res.cleanupWarnings.length }), { description: res.cleanupWarnings.join('\n') })
      }
    } finally {
      if (mountedRef.current && currentDeliveryIdRef.current === expectedDeliveryId) setCheckingOut(false)
    }
  }

  async function inspectLocalResult() {
    const paths = presentation.recoveryWorktreePaths
    if (paths.length === 0) {
      toast.info(t('railPr.localResultUnavailableHere'))
      return
    }
    const value = paths.join('\n')
    let copied = false
    try {
      await navigator.clipboard.writeText(value)
      copied = true
    } catch { /* the preserved path remains visible in the fallback toast */ }
    try {
      if (isTauri()) await revealItemInDir(paths[0])
    } catch { /* reveal is best-effort and independent from clipboard access */ }
    if (copied) {
      toast.success(t('railPr.localResultPathCopied'), { description: value })
    } else {
      toast.info(t('railPr.localResultPath'), { description: value })
    }
  }

  // ── shared bits ─────────────────────────────────────────────────────────────
  const pillBase = `inline-flex items-center gap-1 rounded-pill font-medium border text-caption ${
    compact ? 'px-2 py-1' : 'px-2.5 py-1'
  }`
  const primaryBtn = `inline-flex items-center gap-1 rounded-control font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
    compact ? 'px-2 py-1 text-label' : 'px-2.5 py-1 text-label'
  }`
  const secondaryBtn = `inline-flex items-center gap-1 rounded-control font-medium border border-border/60 text-muted-foreground hover:border-accent-primary/40 hover:bg-accent-primary/10 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
    compact ? 'px-2 py-1 text-label' : 'px-2.5 py-1 text-label'
  }`
  const ghostBtn = `inline-flex items-center gap-1 rounded-control text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
    compact ? 'px-2 py-1 text-label' : 'px-2.5 py-1 text-label'
  }`
  const iconCls = compact ? 'w-2.5 h-2.5' : 'w-3 h-3'
  /** A state pill in the run-state vocabulary: the state's tone, and its glyph —
   *  or the object's (an open PR, a branch) in that tone. Running is the info lamp. */
  const statePill = (
    state: RunState,
    label: React.ReactNode,
    opts: { objectIcon?: LucideIcon | null; title?: string; hint?: string | null; testId?: string } = {},
  ) => {
    const look = runStateLook(state)
    const Icon = opts.objectIcon ?? look.icon
    return (
      <span className={`${pillBase} ${look.text} ${look.border}`} title={opts.title} data-testid={opts.testId} data-run-state={state}>
        {Icon ? <Icon className={iconCls} aria-hidden /> : <RunStateDot state={state} />}
        {label}
        {opts.hint ? <span className="sr-only"> ({opts.hint})</span> : null}
      </span>
    )
  }
  const spinner = <Loader2 className={`${iconCls} animate-spin`} aria-hidden />
  const busy = inFlight !== null || checkingOut || relaunching || runtimeRuns.busy !== null || decision.operation != null
  // A later milestone chunk was stacked on this delivery (premium-milestone-
  // progress): discarding it pauses the chain — say so before the click.
  const isStackedHead = stackedHeads.has(decision.prDeliveryId)
  const discardTitle = d === 'implementation_failed' ? t('railPr.implementationFailedDiscardTooltip') : t('railPr.discardTooltip')

  const plainLinkChip = decision.prUrl ? (
    <a
      href={decision.prUrl}
      target="_blank"
      rel="noreferrer"
      data-testid="rail-pr-link"
      title={t('railPr.openPrTitle')}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 rounded-md font-mono border border-accent-info/30 bg-accent-info/10 text-accent-info hover:bg-accent-info/20 hover:border-accent-info/60 transition-colors ${
        compact ? 'px-1 py-0.5 text-caption' : 'px-1.5 py-0.5 text-caption'
      }`}
    >
      {decision.prNumber != null ? `#${decision.prNumber}` : t('railPr.prLinkFallback')}
      <ExternalLink className={compact ? 'w-2 h-2' : 'w-2.5 h-2.5'} aria-hidden />
    </a>
  ) : null
  // Peak: a PR that awaits review gets the arrival (once per delivery).
  const linkChip = decision.prUrl && (d === 'pr_draft' || d === 'pr_ready') && !presentation.partial ? (
    <DeliveryArrival
      deliveryId={decision.prDeliveryId}
      prNumber={decision.prNumber}
      prUrl={decision.prUrl}
      onOpen={(e) => e.stopPropagation()}
      linkTestId="rail-pr-link"
      compact
    />
  ) : plainLinkChip
  const branchChip = decision.branch ? (
    <span
      data-testid="rail-pr-branch"
      className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-md font-mono border border-border/60 bg-surface/60 text-muted-foreground ${
        compact ? 'px-1 py-0.5 text-caption' : 'px-1.5 py-0.5 text-caption'
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
      onClick={(e) => { e.stopPropagation(); openConfirmation('discard') }}
      className={ghostBtn}
    >
      {inFlight === 'discard' && inFlightKind !== 'refine' ? spinner : null}
      {t('railPr.discard')}
    </button>
  )

  // Remote-less acceptance: integrate the delivered branches into the base
  // branch locally. Offered wherever no real PR exists yet (on_review,
  // degraded draft, pr_failed) — the GitHub-less journey's way to say "yes".
  const mergeLocalBtn = !hasRepositoryDeliveries && (
    <button
      type="button"
      data-testid="rail-pr-merge-local"
      disabled={busy}
      title={t('railPr.mergeLocalTooltip', { base: decision.baseBranch })}
      onClick={(e) => { e.stopPropagation(); openConfirmation('merge-local') }}
      className={`inline-flex items-center gap-1 rounded-control font-medium border border-accent-success/40 bg-accent-success/10 text-accent-success hover:bg-accent-success/20 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
        compact ? 'px-1.5 py-0.5 text-label' : 'px-2 py-0.5 text-label'
      }`}
    >
      {inFlight === 'merge-local' ? spinner : <GitMerge className={iconCls} aria-hidden />}
      {t('railPr.mergeLocal')}
    </button>
  )

  // pr-ci-loop: "Fix CI" — watch and fix the attached PR's CI (Core-run loop).
  const ciAvailable = usePrCiAvailability(FEATURE_PR_CI_CARD ? stripProjectId : null)
  const [ciStarting, setCiStarting] = useState(false)
  const ciInFlight = useRef(false)
  const canFixCi = ciAvailable && prCiFixable({ decision: decision.decision, prUrl: decision.prUrl, repositoryDeliveries: decision.repositoryDeliveries })
  async function fixCi(): Promise<void> {
    if (!stripProjectId || ciInFlight.current || busy) return
    ciInFlight.current = true
    setCiStarting(true)
    const outcome = await postPrCiLaunch(stripProjectId, decision.railIndex, { prDeliveryId: decision.prDeliveryId })
    if (outcome.kind === 'started') toast.success(t('railPr.fixCiStarted'))
    else notifyError(t('railPr.fixCiFailed'), { detail: outcome.detail || undefined, retry: () => void fixCi() })
    ciInFlight.current = false
    if (mountedRef.current) setCiStarting(false)
  }
  const fixCiButton = canFixCi && (
    <button type="button" data-testid="rail-pr-fix-ci" disabled={busy || ciStarting} title={t('railPr.fixCiTooltip')}
      onClick={(e) => { e.stopPropagation(); void fixCi() }} className={secondaryBtn}>
      {t('railPr.fixCi')}
    </button>
  )

  const actionButton = (
    action: RailPrDecisionAction,
    expected: RailPrDecision,
    label: string,
    testId: string,
    title?: string,
    icon?: React.ReactNode,
    /** `outline` when another button on the strip already carries the primary call to action. */
    tone: 'primary' | 'outline' = 'primary',
  ) => !hasRepositoryDeliveries && (
    <button
      type="button"
      data-testid={testId}
      disabled={busy}
      title={title}
      onClick={(e) => { e.stopPropagation(); void run(action, expected) }}
      className={tone === 'outline' ? secondaryBtn : primaryBtn}
    >
      {inFlight === action ? spinner : icon}
      {label}
    </button>
  )

  // Entry point into the plain-language review packet (nontech-review-experience).
  // Rendered before the git-shaped actions so the readable surface is the first
  // thing offered; the fine-grained buttons stay for technical users.
  const reviewPacketBtn = FEATURE_REVIEW_PACKET ? (
    <button
      type="button"
      data-testid="rail-pr-open-packet"
      title={t('railPr.openReviewTooltip')}
      onClick={(e) => { e.stopPropagation(); navigate(`/review/${decision.prDeliveryId}`) }}
      className={`inline-flex items-center gap-1 rounded-md font-medium border border-accent-primary/40 bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-colors ${
        compact ? 'px-1.5 py-0.5 text-caption' : 'px-2 py-0.5 text-caption'
      }`}
    >
      <Eye className={iconCls} aria-hidden />
      {t('railPr.openReview')}
    </button>
  ) : null

  const checkoutBranch = prDeliveryCheckoutBranch(decision)
  const checkoutBtn = checkout && checkoutBranch && !hasRepositoryDeliveries ? (
    <button
      type="button"
      data-testid="rail-pr-checkout"
      disabled={busy}
      title={t('railPr.checkoutTooltip', { branch: checkoutBranch })}
      onClick={(e) => { e.stopPropagation(); void runCheckout() }}
      className={`inline-flex items-center gap-1 rounded-control font-medium border border-border/60 text-muted-foreground hover:border-accent-primary/40 hover:bg-accent-primary/10 disabled:opacity-50 disabled:pointer-events-none transition-colors ${
        compact ? 'px-1.5 py-0.5 text-label' : 'px-2 py-0.5 text-label'
      }`}
    >
      {checkingOut ? spinner : <GitBranch className={iconCls} aria-hidden />}
      {t('railPr.checkout')}
    </button>
  ) : null

  const inspectLocalResultBtn = presentation.recoveryWorktreePaths.length > 0 ? (
    <button
      type="button"
      data-testid="rail-pr-inspect-local-result"
      disabled={busy}
      onClick={(event) => { event.stopPropagation(); void inspectLocalResult() }}
      className={secondaryBtn}
      title={t('railPr.inspectLocalResultTooltip')}
    >
      <FolderOpen className={iconCls} aria-hidden />
      {t('railPr.inspectLocalResult')}
    </button>
  ) : null

  const recoveryIsRecheck = presentation.recoveryRecheck
  const recoverAndRetryBtn = presentation.manualRecovery || recoveryIsRecheck ? (
    <button
      type="button"
      data-testid={recoveryIsRecheck ? 'rail-pr-recheck-recovery' : 'rail-pr-recover-and-retry'}
      disabled={busy}
      onClick={(event) => { event.stopPropagation(); openConfirmation('recover-and-retry') }}
      className={recoveryIsRecheck ? secondaryBtn : primaryBtn}
    >
      {inFlight === 'recover-and-retry' ? spinner : <RotateCcw className={iconCls} aria-hidden />}
      {t(recoveryIsRecheck ? 'railPr.recheckRecovery' : 'railPr.recoverAndRetry')}
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
        compact ? 'px-1 py-0.5 text-caption' : 'px-1.5 py-0.5 text-caption'
      }`}
    >
      <ScrollText className={iconCls} aria-hidden />
      {decision.ticketIds[index] != null ? `#${decision.ticketIds[index]}` : runId.slice(0, 8)}
    </button>
  ))

  // One status pill: per-unit evidence folds into its tooltip. A unit that
  // failed or is blocked stays visible as its own chip — never hidden.
  const unitState = (unit: NonNullable<typeof decision.units>[number]) => {
    const failed = unit.implementationOutcome === 'failed' || (unit.implementationOutcome == null && !unit.succeeded)
    const blocked = unit.deliveryOutcome === 'blocked'
    const noChanges = unit.deliveryOutcome === 'no_changes' || unit.changed === false
    return { failed, blocked, label: t(failed ? 'railPr.unit.failed' : blocked ? 'railPr.unit.blocked' : noChanges ? 'railPr.unit.noChanges' : 'railPr.unit.succeeded') }
  }
  const unitSummary = (decision.units ?? []).map((unit) => `#${unit.ticketId} · ${unitState(unit).label}`).join('\n')
  // A failed implementation's one unit only repeats the pill: per-unit evidence speaks there when several specs share it.
  const unitEvidence = d === 'implementation_failed' && (decision.units ?? []).length < 2 ? [] : (decision.units ?? []).flatMap((unit) => {
    const { failed, blocked, label } = unitState(unit)
    if (!failed && !blocked) return []
    return [(
      <span
        key={`${unit.ticketId}-${unit.runId ?? unit.branch}`}
        data-testid="rail-pr-unit-evidence"
        title={unit.failureCode ?? unit.branch}
        data-run-state={failed ? 'failed' : 'blocked'}
        className={`${pillBase} ${runStateLook(failed ? 'failed' : 'blocked').text} ${runStateLook(failed ? 'failed' : 'blocked').border}`}
      >
        #{unit.ticketId} · {label}
      </span>
    )]
  })

  const dismissBtn = (
    <button
      type="button"
      data-testid="rail-pr-dismiss"
      disabled={busy}
      onClick={(event) => { event.stopPropagation(); openConfirmation('dismiss') }}
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
      onClick={(event) => { event.stopPropagation(); openConfirmation('discard-local') }}
      className={ghostBtn}
    >
      {inFlight === 'discard' && inFlightKind !== 'refine' ? spinner : null}
      {t('railPr.discardLocalResult')}
    </button>
  )

  const acknowledgeNoChangesBtn = !hasRepositoryDeliveries && (
    <button
      type="button"
      data-testid="rail-pr-no-changes-done"
      disabled={busy}
      onClick={(event) => { event.stopPropagation(); openConfirmation('no-changes-done') }}
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
      onClick={(event) => { event.stopPropagation(); openConfirmation('refine') }}
      className={ghostBtn}
    >
      {inFlight === 'discard' && inFlightKind === 'refine' ? spinner : null}
      {t('railPr.refine')}
    </button>
  )

  // ── overflow menu: secondary actions live behind one trigger ──────────────
  const itemCls = compact ? 'text-caption' : ''
  const checkoutItem = checkoutBtn && (
    <DropdownMenuItem
      key="checkout"
      data-testid="rail-pr-checkout"
      disabled={busy}
      title={t('railPr.checkoutTooltip', { branch: checkoutBranch })}
      className={itemCls}
      onSelect={() => { void runCheckout() }}
    >
      {checkingOut ? spinner : <GitBranch className={iconCls} aria-hidden />}
      {t('railPr.checkout')}
    </DropdownMenuItem>
  )
  const mergeLocalItem = mergeLocalBtn && (
    <DropdownMenuItem
      key="merge-local"
      data-testid="rail-pr-merge-local"
      disabled={busy}
      title={t('railPr.mergeLocalTooltip', { base: decision.baseBranch })}
      className={itemCls}
      onSelect={() => openConfirmation('merge-local')}
    >
      {inFlight === 'merge-local' ? spinner : <GitMerge className={iconCls} aria-hidden />}
      {t('railPr.mergeLocal')}
    </DropdownMenuItem>
  )
  const endItem = presentation.continuation ? (
    <DropdownMenuItem
      key="dismiss"
      data-testid="rail-pr-dismiss"
      disabled={busy}
      destructive
      className={itemCls}
      onSelect={() => openConfirmation('dismiss')}
    >
      {inFlight === 'dismiss' ? spinner : null}
      {t('railPr.dismiss')}
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem
      key="discard"
      data-testid="rail-pr-discard"
      disabled={busy}
      destructive
      title={discardTitle}
      className={itemCls}
      onSelect={() => openConfirmation('discard')}
    >
      {inFlight === 'discard' && inFlightKind !== 'refine' ? spinner : null}
      {t('railPr.discard')}
    </DropdownMenuItem>
  )
  /** Checkout / integrate locally / discard behind "More actions". A lone
   *  discard stays a plain button so the only way out is never hidden. */
  const runLogItems = (decision.runIds ?? []).map((runId, index) => {
    const ref = decision.ticketIds[index] != null ? `#${decision.ticketIds[index]}` : runId.slice(0, 8)
    return (
      <DropdownMenuItem
        key={`run-${runId}`}
        data-testid="rail-pr-run-log"
        className={itemCls}
        onSelect={() => navigate(`/jobs/${runId}`)}
      >
        <ScrollText className={iconCls} aria-hidden />
        {t('railPr.viewRunLog', { ref })}
      </DropdownMenuItem>
    )
  })
  // True once the "More actions" menu is on screen: the run log and the loop
  // label then live behind it instead of adding more controls to the strip.
  let menuRendered = false
  const secondary = (withCheckout: boolean, withMerge: boolean) => {
    if (!(withCheckout && checkoutItem) && !(withMerge && mergeLocalItem) && runLogItems.length === 0) {
      return presentation.continuation ? dismissBtn : discardBtn
    }
    menuRendered = true
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="rail-pr-more"
          aria-label={t('railPr.moreActions')}
          title={t('railPr.moreActions')}
          onClick={(e) => e.stopPropagation()}
          className={`inline-flex items-center justify-center rounded-control border border-border/60 text-muted-foreground hover:text-foreground hover:bg-accent-primary/10 transition-colors ${compact ? 'h-5 w-5' : 'h-6 w-6'}`}
        >
          <MoreHorizontal className={iconCls} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {withCheckout && checkoutItem}
          {withMerge && mergeLocalItem}
          {runLogItems}
          {endItem}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // ── per-state pill + actions ────────────────────────────────────────────────
  let pill: React.ReactNode = null
  let actions: React.ReactNode = null
  // The pill's explanation, readable without hovering (the tooltip keeps it too).
  let detailLine: string | null = null
  let reasonDiagnosis: FailureDiagnosis | null = null

  if (existingPrIteration) {
    pill = statePill('working', t('railPr.iteratingPr'))
    actions = (
      <>
        {linkChip}
        {branchChip}
      </>
    )
  } else if (presentation.noChanges) {
    pill = statePill(deliveryLook('no_changes').state, t('railPr.noChanges'))
    actions = <>{decision.prUrl ? linkChip : null}{presentation.continuation ? dismissBtn : <>{acknowledgeNoChangesBtn}{refineBtn}</>}</>
  } else if (presentation.partial && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && !presentation.closed) {
    // Some repositories delivered, others did not: blocked until they do.
    pill = statePill('blocked', t('railPr.partial', { succeeded: presentation.succeededCount, total: presentation.totalCount }))
    if (d === 'pr_draft' && decision.prUrl) {
      actions = (
        <>
          {linkChip}
          {actionButton('publish', 'pr_draft', t('railPr.publish'), 'rail-pr-publish', t('railPr.publishTooltip'))}
          {fixCiButton}
          {secondary(true, false)}
        </>
      )
    } else if (d === 'pr_ready') {
      actions = (
        <>
          {linkChip}
          {actionButton('poll-merge', 'pr_ready', t('railPr.verifyPr'), 'rail-pr-poll', t('railPr.verifyPrTooltip'))}
          {fixCiButton}
          {secondary(true, false)}
        </>
      )
    } else if (d === 'on_review' || (d === 'pr_draft' && !decision.prUrl)) {
      actions = (
        <>
          {actionButton('create-pr', d, t('railPr.createPartialPr', { count: presentation.deliverableCount }), 'rail-pr-create-partial')}
          {secondary(true, false)}
        </>
      )
    } else {
      actions = <>{linkChip}{secondary(true, false)}</>
    }
  } else if (presentation.deliveryBlocked) {
    pill = statePill('blocked', t('railPr.deliveryBlocked'), { title: decision.statusDetail ?? undefined })
    actions = <>
      {linkChip}
      {inspectLocalResultBtn}
      {recoverAndRetryBtn}
      {presentation.continuation
        ? (presentation.hasDiscardableRecoveryResult ? discardLocalBtn : dismissBtn)
        : discardBtn}
    </>
  } else if (presentation.retryablePush) {
    pill = statePill('blocked', t('railPr.updateFailed'), { title: decision.statusDetail ?? undefined })
    actions = (
      <>
        {linkChip}
        {actionButton('create-pr', d, t('railPr.retryPush'), 'rail-pr-retry-push')}
        {secondary(true, false)}
      </>
    )
  } else if (presentation.retryablePrCreation) {
    // A retryable PR creation: blocked, not a failure.
    pill = statePill('blocked', presentation.localOnly
      ? t('railPr.localOnly')
      : decision.prState === 'pushed'
        ? t('railPr.branchPushed')
        : t('railPr.prFailed'), { title: decision.statusDetail ?? undefined })
    actions = (
      <>
        {actionButton('create-pr', d, t('railPr.retryPr'), 'rail-pr-create')}
        {secondary(true, true)}
      </>
    )
  } else if (presentation.closed) {
    // Closed without merging: stopped (it can be reopened).
    pill = statePill(deliveryLook('pr_closed').state, t('railPr.prClosed'), { objectIcon: deliveryLook('pr_closed').objectIcon })
    actions = (
      <>
        {linkChip}
        {actionButton('reopen', 'pr_closed', t('railPr.reopen'), 'rail-pr-reopen', undefined, <RotateCcw className={iconCls} aria-hidden />)}
        {secondary(true, false)}
      </>
    )
  } else if (d === 'on_review') {
    pill = statePill(deliveryLook('on_review').state, t('railPr.readyForReview'), { objectIcon: deliveryLook('on_review').objectIcon })
    actions = (
      <>
        {reviewPacketBtn}
        {actionButton('create-pr', 'on_review', t('railPr.createPr'), 'rail-pr-create', t('railPr.createPrTooltip', { base: decision.baseBranch }), <GitPullRequest className={iconCls} aria-hidden />, FEATURE_REVIEW_PACKET ? 'outline' : 'primary')}
        {secondary(true, true)}
      </>
    )
  } else if (d === 'pr_draft' && decision.prUrl) {
    pill = statePill(deliveryLook('pr_draft').state, t('railPr.draftPr'), { objectIcon: deliveryLook('pr_draft').objectIcon })
    actions = (
      <>
        {linkChip}
        {actionButton('publish', 'pr_draft', t('railPr.publish'), 'rail-pr-publish', t('railPr.publishTooltip'))}
          {fixCiButton}
        {secondary(true, false)}
      </>
    )
  } else if (d === 'pr_draft') {
    // Degraded delivery: branch pushed (or kept local) but no PR exists — the
    // only ways forward are retrying the failed stage or discarding.
    pill = statePill('blocked', presentation.localOnly ? t('railPr.localOnly') : t('railPr.branchPushed'), { title: t('railPr.branchPushedHint'), hint: t('railPr.branchPushedHint') })
    actions = (
      <>
        {actionButton('create-pr', 'pr_draft', t('railPr.retryPr'), 'rail-pr-create', t('railPr.createPrTooltip', { base: decision.baseBranch }))}
        {secondary(true, true)}
      </>
    )
  } else if (d === 'pr_ready') {
    // The open PR waits for the person's decision: review, never the merge glyph.
    pill = statePill(deliveryLook('pr_ready').state, t('railPr.prReady'), { objectIcon: deliveryLook('pr_ready').objectIcon })
    actions = (
      <>
        {linkChip}
        {actionButton('poll-merge', 'pr_ready', t('railPr.verifyPr'), 'rail-pr-poll', t('railPr.verifyPrTooltip'))}
          {fixCiButton}
        {secondary(true, false)}
      </>
    )
  } else if (d === 'pr_failed') {
    pill = statePill(deliveryLook('pr_failed').state, t('railPr.prFailed'))
    actions = (
      <>
        {linkChip}
        {actionButton('create-pr', 'pr_failed', t('railPr.retry'), 'rail-pr-create', t('railPr.createPrTooltip', { base: decision.baseBranch }))}
        {secondary(true, !decision.prUrl)}
      </>
    )
  } else if (d === 'implementation_failed' && decision.statusCode === 'review_changes_requested') {
    // Intent → Spec still needs changes: its Intent worktree is kept for "Back to
    // Intent" / "Relaunch" on the mission card — never discarded from here.
    detailLine = decision.statusDetail ? null : t('railPr.reviewChangesRequestedHint')
    const changes = deliveryLook(d, 'changes')
    pill = statePill(changes.state, t('railPr.reviewChangesRequested'), {
      objectIcon: changes.objectIcon,
      title: decision.statusDetail ?? t('railPr.reviewChangesRequestedHint'),
      hint: decision.statusDetail ?? t('railPr.reviewChangesRequestedHint'),
      testId: 'rail-pr-review-changes',
    })
    actions = null
  } else if (d === 'implementation_failed' && presentation.implementationFailed) {
    const hint = t(runStopped ? 'railPr.runStoppedHint' : 'railPr.implementationFailedHint')
    // One headline (the pill), one reason (the run's diagnosis when known), one set of actions.
    detailLine = runStopped || !failureDiagnosis ? hint : null
    reasonDiagnosis = runStopped ? null : failureDiagnosis
    pill = runStopped
      ? statePill(deliveryLook(d, 'stopped').state, t('railPr.runStopped'), { title: hint, hint, testId: 'rail-pr-run-stopped' })
      : statePill(deliveryLook('implementation_failed').state, t('railPr.implementationFailed'), { title: hint, hint })
    actions = (
      <>
        {/* One primary: continue a settled run, resume a paused one, else run the attempt again (never for a continuation or an Intent session run). */}
        {continueRun ? (
          <button type="button" data-testid="rail-pr-continue" disabled={busy || continueRun.busy || continueRun.disabled} title={t('railPr.continueHint')} onClick={(event) => { event.stopPropagation(); continueRun.run() }} className={primaryBtn}>
            {continueRun.busy ? spinner : <Play className={iconCls} aria-hidden />}
            {t('railPr.continue')}
          </button>
        ) : canResume ? (
          <button type="button" data-testid="rail-pr-resume" disabled={busy} onClick={(event) => { event.stopPropagation(); void runtimeRuns.act(failedRun, 'resume') }} className={primaryBtn}>
            {runtimeRuns.busy !== null ? spinner : <Play className={iconCls} aria-hidden />}
            {t('railPr.resume')}
          </button>
        ) : !presentation.continuation && !flowSpecRun && (
          <button type="button" data-testid="rail-pr-relaunch" disabled={busy || relaunchBlocked} title={relaunchBlocked ? t('railPr.relaunchBlocked') : undefined} onClick={(event) => { event.stopPropagation(); void relaunch() }} className={primaryBtn}>
            {relaunching ? spinner : <RotateCcw className={iconCls} aria-hidden />}
            {t('railPr.relaunch')}
          </button>
        )}
        {presentation.continuation ? dismissBtn : discardBtn}
      </>
    )
  }

  // Status pill tooltip: its own detail, the producing loop and every unit.
  const loopTooltip = menuRendered && d !== 'building' && (decision.loopId || decision.loopName) ? loopLabel.label : ''
  const pillTooltip = [
    React.isValidElement(pill) ? (pill.props as { title?: string }).title : undefined,
    loopTooltip,
    unitSummary,
  ].filter(Boolean).join('\n')
  // The spec number stays visible inside the pill ("#15 · Ready for review") so
  // two rails never read identically; the detail remains in the tooltip.
  const specRef = (decision.ticketIds ?? []).filter((id) => id != null).map((id) => `#${id}`).join(', ')
  const pillWithEvidence = React.isValidElement(pill)
    ? React.cloneElement(
        pill as React.ReactElement<{ title?: string; children?: React.ReactNode }>,
        {
          ...(pillTooltip ? { title: pillTooltip } : {}),
          ...(specRef
            ? {
                children: (
                  <>
                    <span data-testid="rail-pr-spec-ref" className="tabular-nums">{specRef}</span>
                    <span aria-hidden>·</span>
                    {(pill.props as { children?: React.ReactNode }).children}
                  </>
                ),
              }
            : {}),
        },
      )
    : pill

  return (
    <div
      data-testid="rail-pr-strip"
      data-decision={d}
      className={`flex items-center flex-wrap u-enter-down ${compact ? 'gap-1' : 'gap-1.5'}`}
      onClick={(e) => e.stopPropagation()}
    >
      {announcement && <span role="status" aria-live="polite" aria-label={announcement} className="sr-only" />}
      <RepositoryDeliveries deliveryId={decision.prDeliveryId} repositories={decision.repositoryDeliveries} busy={busy}
        onAct={(action, repositoryId) => run(action, decision.decision, decision.prDeliveryId, repositoryId)}
        onCheckout={checkout ? runCheckout : undefined} />
      {pillWithEvidence}
      {/* Which loop produced this delivery (the rail's current loop may differ).
          Behind the status pill's tooltip whenever the menu is on screen. */}
      {d !== 'building' && !menuRendered && (decision.loopId || decision.loopName) ? <LoopChip loopId={decision.loopId} loopName={decision.loopName} /> : null}
      {decision.operation && (
        <span className={`${pillBase} border-accent-info/30 bg-accent-info/10 text-accent-info`} data-testid="rail-pr-operation">
          <RailTrack running className="w-8 shrink-0" />
          {t(`railPr.operation.${decision.operation}`)}
        </span>
      )}
      {actions}
      <HelpHint topic="prDecision" />
      {detailLine && <p className="basis-full text-caption text-muted-foreground" data-testid="rail-pr-detail-line">{detailLine}</p>}
      {reasonDiagnosis && <FailureReasonLine diagnosis={reasonDiagnosis} />}
      {/* A failed implementation delivered nothing: its recorded commit is the base it started from. */}
      {decision.deliverySha && d !== 'implementation_failed' && (
        <span
          className={`${pillBase} ${decision.deliveryOutcome === 'delivered' ? 'border-accent-success/30 bg-accent-success/10 text-accent-success' : 'border-border/60 bg-surface/60 text-muted-foreground'} font-mono`}
          data-testid="rail-pr-delivery-sha"
          title={decision.deliverySha}
        >
          <CheckCircle2 className={iconCls} aria-hidden />
          {t('railPr.deliveryCommit', { sha: decision.deliverySha.slice(0, 8) })}
        </span>
      )}
      {menuRendered ? null : runLogChips}
      {unitEvidence}
      {!compact && d !== 'building' ? <TopRiskLine summary={decision.riskSummary} className="basis-full" /> : null}
      {/* Conflicts with the current base / sibling deliveries, base lead (merge-tree, no checkout). */}
      <MergePreviewLine deliveryId={decision.prDeliveryId} className="basis-full" />
      {statusLabel && (
        <span className={`${pillBase} border-border/60 bg-surface/60 text-muted-foreground`} data-testid="rail-pr-status-code">
          {statusLabel}
        </span>
      )}

      {(recoveredInterruptedOperation || presentation.recoveryUnavailable ||
        (!interruptedOperationDetail && decision.statusDetail && !presentation.recoveryUnavailable) ||
        presentation.cleanupWarnings.length > 0) && (
        <div className={`basis-full rounded-md border border-accent-warning/30 bg-accent-warning/10 text-accent-warning ${compact ? 'px-1.5 py-1 text-caption' : 'px-2 py-1.5 text-caption'}`} data-testid="rail-pr-delivery-detail">
          {recoveredInterruptedOperation && (
            <p className="flex items-start gap-1.5" data-testid="rail-pr-recovery-interrupted">
              <RotateCcw className={`${iconCls} mt-px shrink-0`} aria-hidden />
              <span>{t('common:prRecovery.interrupted')}</span>
            </p>
          )}
          {presentation.recoveryUnavailable && (
            <p data-testid="rail-pr-recovery-unavailable">{t('railPr.recoveryUnavailableBody')}</p>
          )}
          {presentation.recoveryUnavailable && decision.statusDetail && !interruptedOperationDetail && (
            <details className="mt-1 text-muted-foreground" data-testid="rail-pr-recovery-technical-detail">
              <summary className="cursor-pointer font-medium text-muted-foreground">{t('railPr.recoveryDetailSummary')}</summary>
              <p className="mt-1 break-words">{decision.statusDetail}</p>
            </details>
          )}
          {!interruptedOperationDetail && statusDetail && !presentation.recoveryUnavailable && <p>{statusDetail.text}</p>}
          {!interruptedOperationDetail && statusDetail?.raw && !presentation.recoveryUnavailable && (
            <TechnicalDetail summary={t('railPr.recoveryDetailSummary')} className="mt-1" testId="rail-pr-status-technical-detail">{statusDetail.raw}</TechnicalDetail>
          )}
          {presentation.cleanupWarnings.length > 0 && (
            <div className={recoveredInterruptedOperation || (!interruptedOperationDetail && decision.statusDetail) ? 'mt-1' : undefined}>
              <p className="font-medium">{t('railPr.cleanupIncomplete', { count: presentation.cleanupWarnings.length })}</p>
              <ul className="mt-0.5 list-disc pl-4 text-muted-foreground">
                {presentation.cleanupWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {presentation.safetyArchives.length > 0 && (
        <SafetyArchiveNotice projectId={stripProjectId} paths={presentation.safetyArchives} compact={compact} testId="rail-pr-safety-archives" />
      )}

      {/* Merge-local confirmation — it writes merge commits into the user's
          checkout of the base branch. Constructive but repo-touching. */}
      <ConfirmDialog
        open={confirmationIsOpen('merge-local')}
        onOpenChange={(open) => { if (!open) closeConfirmation() }}
        tone="default"
        testId="rail-pr-merge-local-confirm"
        confirmTestId="rail-pr-merge-local-confirm-btn"
        title={t('railPr.mergeLocalConfirmTitle')}
        description={t('railPr.mergeLocalConfirmBody', { base: decision.baseBranch })}
        confirmLabel={t('railPr.mergeLocal')}
        confirmDisabled={busy}
        onConfirm={() => confirmAction('merge-local', 'merge-local')}
      />

      {/* Fresh discard is consequence-specific: failed implementations keep
          recoverable local work for inspection and clean up only safe state. */}
      <ConfirmDialog
        open={confirmationIsOpen('discard')}
        onOpenChange={(open) => { if (!open) closeConfirmation() }}
        tone="destructive"
        testId="rail-pr-discard-confirm"
        confirmTestId="rail-pr-discard-confirm-btn"
        title={t(d === 'implementation_failed' ? 'railPr.implementationFailedDiscardTitle' : 'railPr.discardConfirmTitle')}
        description={t(d === 'implementation_failed' ? 'railPr.implementationFailedDiscardBody' : 'railPr.discardConfirmBody')}
        confirmLabel={t('railPr.discard')}
        confirmDisabled={busy}
        onConfirm={() => confirmAction('discard', 'discard')}
      >
        {isStackedHead && (
          <p className="rounded-md border border-accent-warning/40 bg-accent-warning/10 px-2 py-1.5 text-xs text-accent-warning" data-testid="rail-pr-discard-stacked-note">
            {t('railPr.discardStackedNote')}
          </p>
        )}
      </ConfirmDialog>

      {/* A continuation borrows the user's existing PR. Dismiss only clears
          this follow-up generation; it does not close/delete external state. */}
      <ConfirmDialog
        open={confirmationIsOpen('dismiss')}
        onOpenChange={(open) => { if (!open) closeConfirmation() }}
        tone="default"
        testId="rail-pr-dismiss-confirm"
        confirmTestId="rail-pr-dismiss-confirm-btn"
        title={t('railPr.dismissConfirmTitle')}
        description={t('railPr.dismissConfirmBody')}
        confirmLabel={t('railPr.dismiss')}
        confirmDisabled={busy}
        onConfirm={() => confirmAction('dismiss', 'dismiss')}
      />

      {/* Blocked work can contain the only recoverable local result. Name that
          consequence separately from dismissing a clean continuation. */}
      <ConfirmDialog
        open={confirmationIsOpen('discard-local')}
        onOpenChange={(open) => { if (!open) closeConfirmation() }}
        tone="destructive"
        testId="rail-pr-discard-local-confirm"
        confirmTestId="rail-pr-discard-local-confirm-btn"
        title={t('railPr.discardLocalConfirmTitle')}
        description={t('railPr.discardLocalConfirmBody')}
        confirmLabel={t('railPr.discardLocalResult')}
        confirmDisabled={busy}
        onConfirm={() => confirmAction('discard-local', 'discard')}
      />
      <ConfirmDialog
        open={confirmationIsOpen('no-changes-done')}
        onOpenChange={(open) => { if (!open) closeConfirmation() }}
        tone="default"
        testId="rail-pr-no-changes-done-confirm"
        confirmTestId="rail-pr-no-changes-done-confirm-btn"
        title={t('railPr.markDoneConfirmTitle')}
        description={t('railPr.markDoneConfirmBody')}
        confirmLabel={t('railPr.markDone')}
        confirmDisabled={busy}
        onConfirm={() => confirmAction('no-changes-done', 'acknowledge-no-changes')}
      />
      <ConfirmDialog
        open={confirmationIsOpen('refine')}
        onOpenChange={(open) => { if (!open) closeConfirmation() }}
        tone="destructive"
        testId="rail-pr-refine-confirm"
        confirmTestId="rail-pr-refine-confirm-btn"
        title={t('railPr.refineConfirmTitle')}
        description={t('railPr.refineConfirmBody')}
        confirmLabel={t('railPr.refine')}
        confirmDisabled={busy}
        onConfirm={() => confirmAction('refine', 'discard')}
      />
      <ConfirmDialog
        open={confirmationIsOpen('recover-and-retry')}
        onOpenChange={(open) => { if (!open) closeConfirmation() }}
        tone="default"
        testId="rail-pr-recover-and-retry-confirm"
        confirmTestId="rail-pr-recover-and-retry-confirm-btn"
        title={t(recoveryIsRecheck ? 'railPr.recheckRecoveryConfirmTitle' : 'railPr.recoverAndRetryConfirmTitle')}
        description={t(recoveryIsRecheck ? 'railPr.recheckRecoveryConfirmBody' : 'railPr.recoverAndRetryConfirmBody', { branch: decision.branch ?? '' })}
        confirmLabel={t(recoveryIsRecheck ? 'railPr.recheckRecovery' : 'railPr.recoverAndRetry')}
        confirmDisabled={busy}
        onConfirm={() => confirmAction('recover-and-retry', 'recover-and-retry')}
      >
        {recoveryIsRecheck && (
          <TechnicalDetail summary={t('railPr.recoveryDetailSummary')} testId="rail-pr-recheck-technical">{t('railPr.recheckRecoveryConfirmTechnical', { branch: decision.branch ?? '' })}</TechnicalDetail>
        )}
      </ConfirmDialog>
    </div>
  )
}

/** A failed run's reason on the rail card: the run window's failure headline, once. */
function FailureReasonLine({ diagnosis }: { diagnosis: FailureDiagnosis }) {
  const { headline } = useDiagnosisText(diagnosis)
  return <p className="basis-full text-caption text-muted-foreground" data-testid="rail-pr-failure-reason">{headline}</p>
}
