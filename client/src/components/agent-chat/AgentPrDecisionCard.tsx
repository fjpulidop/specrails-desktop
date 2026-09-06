import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { useStackedHeadDeliveryIds } from '../../hooks/useMilestoneProgress'
import { useTranslation } from 'react-i18next'
import { useInRouterContext, useNavigate } from 'react-router-dom'
import { FEATURE_REVIEW_PACKET } from '../../lib/feature-flags'
import { toast } from 'sonner'
import { motion } from 'motion/react'
import {
  GitBranch, GitMerge, GitPullRequest, AlertTriangle, XCircle,
  ExternalLink, Loader2, CheckCircle2, Ticket, ScrollText, Play, Square, RotateCcw, FolderOpen, Eye,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { RepositoryDeliveries } from '../RepositoryDeliveries'
import { useDesktop } from '../../hooks/useDesktop'
import { useWebViewModal } from '../../context/WebViewModalContext'
import { useAgentRefActions } from '../../hooks/useAgentRefActions'
import { useRunVitals, formatRunElapsed } from '../../hooks/useRunVitals'
import {
  postRailPrDecision,
  postRailPrCheckout,
  agentEnvelopeFromSnapshot,
  type AgentPrDecisionAction,
  type AgentPrDecisionEnvelope,
} from '../../lib/agent-api'
import { derivePrDeliveryPresentation, isInterruptedPrDeliveryOperation, isKnownPrDeliveryStatusCode, prDeliveryCheckoutBranch } from '../../lib/pr-delivery'
import { cancelJob } from '../../lib/cancel-job'
import { isTauri, revealItemInDir } from '../../lib/tauri-shell'
import { useAgentChat } from '../../context/AgentChatContext'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/dialog'
import { Button } from '../ui/button'
import { AgentRefChip } from './AgentRefChip'
import { notifyGitChanged } from '../../lib/git-refresh'
import { forceProjectRoute } from '../../lib/route-memory'

// Only loads when a run-log chip is actually clicked — keeps the card chunk
// free of the log-explorer stack (same pattern as AgentConversationView's
// job-ref chips; the modal itself portals to document.body at z-[65]).
const JobDetailModal = lazy(() =>
  import('../JobDetailModal').then((m) => ({ default: m.JobDetailModal })),
)

/**
 * Inline PR-decision card (safe-pr-review-flow, Option B): rendered in place of
 * a `system`-role message whose content is a pr_decision envelope. A pure
 * view/controller over the authoritative `rail_pr_deliveries` row — buttons
 * POST the same `/rails/pr-decision` endpoint the dashboard uses (scoped to the
 * CARD's project, never the active one) and the card re-renders from the next
 * `agent_pr_decision` broadcast, which updates the same envelope in place.
 */

const HEADER_ICON: Record<AgentPrDecisionEnvelope['decision'], typeof GitBranch> = {
  building: GitBranch,
  on_review: GitBranch,
  pr_draft: GitPullRequest,
  pr_ready: GitPullRequest,
  no_changes: CheckCircle2,
  completed: CheckCircle2,
  pr_closed: XCircle,
  superseded: GitPullRequest,
  implementation_failed: AlertTriangle,
  pr_failed: AlertTriangle,
  merged: GitMerge,
  discarded: XCircle,
}

const HEADER_ICON_TONE: Record<AgentPrDecisionEnvelope['decision'], string> = {
  building: 'text-accent-primary/70',
  on_review: 'text-accent-primary',
  pr_draft: 'text-accent-info',
  pr_ready: 'text-accent-info',
  no_changes: 'text-accent-success',
  completed: 'text-accent-success',
  pr_closed: 'text-accent-warning',
  superseded: 'text-foreground/40',
  implementation_failed: 'text-destructive',
  pr_failed: 'text-destructive',
  merged: 'text-accent-success',
  discarded: 'text-foreground/40',
}

function OutcomeEvidence({ envelope }: { envelope: AgentPrDecisionEnvelope }) {
  const { t } = useTranslation('agent')
  const presentation = derivePrDeliveryPresentation(envelope)
  if (presentation.units.length === 0 && !presentation.partial) return null
  return (
    <div className="mt-2 space-y-1.5" data-testid="agent-pr-unit-evidence">
      {presentation.partial && (
        <p className="text-[11px] font-medium text-accent-warning">
          {t('prCard.partialSummary', {
            succeeded: presentation.succeededCount,
            failed: presentation.failedCount,
            total: presentation.totalCount,
          })}
        </p>
      )}
      {presentation.units.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {presentation.units.map((unit) => {
            const failed = unit.implementationOutcome === 'failed' || (unit.implementationOutcome == null && !unit.succeeded)
            const noChanges = unit.deliveryOutcome === 'no_changes' || unit.changed === false
            const blocked = unit.deliveryOutcome === 'blocked'
            const label = failed
              ? t('prCard.unit.failed')
              : blocked
                ? t('prCard.unit.blocked')
                : noChanges
                  ? t('prCard.unit.noChanges')
                  : t('prCard.unit.succeeded')
            return (
              <span
                key={`${unit.ticketId}-${unit.runId ?? unit.branch}`}
                title={unit.failureCode ?? unit.branch}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]',
                  failed
                    ? 'border-destructive/35 bg-destructive/10 text-destructive'
                    : blocked
                      ? 'border-accent-warning/35 bg-accent-warning/10 text-accent-warning'
                      : 'border-accent-success/30 bg-accent-success/10 text-accent-success',
                )}
              >
                #{unit.ticketId} · {label}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Route entry into the plain-language review packet. Split out so the parent
 *  card can stay renderable without a Router (see inRouterContext there). */
function ReviewPacketEntry({ prDeliveryId, projectId }: { prDeliveryId: string; projectId: string }) {
  const { t } = useTranslation('agent')
  const navigate = useNavigate()
  const { activeProjectId, setActiveProjectId } = useDesktop()
  return (
    <button
      type="button"
      onClick={() => {
        const route = `/review/${prDeliveryId}`
        // Review packets use the active project's API. Pin route memory before
        // switching so the app cannot restore a different page over this one.
        if (activeProjectId !== projectId) {
          forceProjectRoute(projectId, route)
          setActiveProjectId(projectId)
        }
        navigate(route)
      }}
      data-testid="agent-pr-open-packet"
      data-agent-interactive
      title={t('prCard.openReviewTooltip')}
      className="inline-flex items-center gap-1 rounded-md border border-accent-primary/40 bg-accent-primary/10 px-2 py-1 text-[11px] font-medium text-accent-primary transition-colors hover:bg-accent-primary/20"
    >
      <Eye className="h-3 w-3" />
      {t('prCard.openReview')}
    </button>
  )
}

function prNumberFromUrl(prUrl: string): string | null {
  const m = /\/pull\/(\d+)/.exec(prUrl)
  return m ? `#${m[1]}` : null
}

/**
 * One per-run "View log" chip: the run's ticket ref + live vitals (elapsed ·
 * cost — REAL accumulated totals only, never an estimate; cost hidden until it
 * is > 0). Rendered in EVERY card state: live-ticking while the rail builds,
 * frozen at the final authoritative totals on settled/terminal cards. Click
 * opens the run's JobDetailModal scoped to the CARD's project.
 */
function RunLogChip({
  projectId, runId, ticketLabel, live, onOpen, onVitals,
}: {
  projectId: string
  runId: string
  /** `#38` (or `#4 #7` for a single all-scope run); null → short run id. */
  ticketLabel: string | null
  live: boolean
  onOpen: (runId: string) => void
  onVitals?: (runId: string, vitals: { paused: boolean; pausedReason: string | null }) => void
}) {
  const { t } = useTranslation('agent')
  const vitals = useRunVitals(projectId, runId, { live })
  const label = ticketLabel ?? runId.slice(0, 8)
  const elapsed = vitals.elapsedMs != null ? formatRunElapsed(vitals.elapsedMs) : null
  const showCost = vitals.costUsd != null && vitals.costUsd > 0
  const dot = <span aria-hidden className="opacity-40">·</span>
  useEffect(() => {
    onVitals?.(runId, { paused: vitals.paused, pausedReason: vitals.pausedReason })
  }, [onVitals, runId, vitals.paused, vitals.pausedReason])
  return (
    <button
      type="button"
      data-agent-interactive
      data-testid="pr-run-log-chip"
      onClick={(e) => {
        e.stopPropagation()
        onOpen(runId)
      }}
      title={t('prCard.viewLog', { ref: label })}
      aria-label={t('prCard.viewLog', { ref: label })}
      className={cn(
        'inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border px-1.5 py-px align-baseline font-mono text-[0.82em] leading-[1.45] transition-all',
        vitals.paused
          ? 'border-accent-warning/45 bg-accent-warning/10 text-accent-warning hover:-translate-y-px hover:border-accent-warning/65 hover:bg-accent-warning/15 hover:shadow-sm'
          : 'border-accent-info/35 bg-accent-info/10 text-accent-info hover:-translate-y-px hover:border-accent-info/60 hover:bg-accent-info/15 hover:shadow-sm',
      )}
    >
      {(vitals.paused || (vitals.running && live)) && (
        <span
          aria-hidden
          className={cn('h-1.5 w-1.5 shrink-0 animate-pulse rounded-full', vitals.paused ? 'bg-accent-warning' : 'bg-accent-info')}
        />
      )}
      <span className="max-w-[160px] truncate">{label}</span>
      {dot}
      <ScrollText className="h-3 w-3 shrink-0 opacity-70" />
      {elapsed && (
        <>
          {dot}
          <span className="tabular-nums" aria-label={t('prCard.runElapsedAria', { elapsed })}>{elapsed}</span>
        </>
      )}
      {showCost && (
        <>
          {dot}
          <span
            className="tabular-nums"
            aria-label={t('prCard.runCostAria', { cost: `$${vitals.costUsd!.toFixed(2)}` })}
          >
            ${vitals.costUsd!.toFixed(2)}
          </span>
        </>
      )}
    </button>
  )
}

export function AgentPrDecisionCard({ envelope: envelopeProp }: { envelope: AgentPrDecisionEnvelope }) {
  const { t } = useTranslation('agent')
  // The card is deliberately Router-OPTIONAL (it is unit-rendered bare in dozens
  // of tests and mounted inside the app Router in production). useNavigate would
  // throw outside a Router, so the route entry is gated on this non-throwing
  // probe and the hook itself lives in the child that only mounts inside one.
  const inRouterContext = useInRouterContext()
  const { projects } = useDesktop()
  const { applyPrDecisionSnapshot } = useAgentChat()
  const { openWebView, canOpenWebView } = useWebViewModal()
  // Ticket chips resolve against the CARD's project (never the active one) —
  // same scoping rule as the card's decision POSTs.
  const { openRef } = useAgentRefActions()
  const [busy, setBusy] = useState<AgentPrDecisionAction | null>(null)
  const [checkingOut, setCheckingOut] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [confirmingDismiss, setConfirmingDismiss] = useState(false)
  const [confirmingDiscardLocal, setConfirmingDiscardLocal] = useState(false)
  const [confirmingMergeLocal, setConfirmingMergeLocal] = useState(false)
  const [confirmingNoChangesDone, setConfirmingNoChangesDone] = useState(false)
  const [confirmingRefine, setConfirmingRefine] = useState(false)
  const [confirmingRecoverAndRetry, setConfirmingRecoverAndRetry] = useState(false)
  // HTTP action snapshots render immediately; the persisted message/WS update
  // replaces this override and keeps pinning/history placement authoritative.
  const [localEnvelope, setLocalEnvelope] = useState<AgentPrDecisionEnvelope | null>(null)
  const envelope = localEnvelope ?? envelopeProp
  // Stacked head (milestone chain): a later chunk builds on this delivery.
  const stackedHeads = useStackedHeadDeliveryIds(envelope.projectId)
  const isStackedHead = stackedHeads.has(envelope.prDeliveryId)
  // A clicked run-log chip → the run's JobDetailModal (portals to body).
  const [logRunId, setLogRunId] = useState<string | null>(null)
  const [pausedRuns, setPausedRuns] = useState<Record<string, { paused: boolean; pausedReason: string | null }>>({})
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)

  const { decision, prUrl, prState } = envelope
  const hasRepositoryDeliveries = Boolean(envelope.repositoryDeliveries?.length)
  const presentation = derivePrDeliveryPresentation(envelope)
  const interruptedOperationDetail = isInterruptedPrDeliveryOperation(envelope.statusCode, envelope.statusDetail)
  const recoveredInterruptedOperation = envelope.operation == null && interruptedOperationDetail
  const projectName = projects.find((p) => p.id === envelope.projectId)?.name ?? envelope.projectId
  const degradedDraft = decision === 'pr_draft' && !prUrl
  const existingPrContinuation = decision === 'building' && prState === 'pr-created' && Boolean(envelope.branch)
  const displayedPrNumber = envelope.prNumber ? `#${envelope.prNumber}` : prUrl ? prNumberFromUrl(prUrl) : null
  const terminal = presentation.terminal
  const statusLabel = isKnownPrDeliveryStatusCode(envelope.statusCode)
    ? t(`common:prDeliveryStatus.${envelope.statusCode}`)
    : null
  const partialCreatePending = presentation.partial && presentation.deliverableCount > 0 && (
    decision === 'on_review' || (decision === 'pr_draft' && !prUrl)
  )

  useEffect(() => { setLocalEnvelope(null) }, [envelopeProp])

  // A broadcast moved the envelope on (this surface or the other one answered):
  // reconcile any local in-flight/confirm state to the fresh decision.
  useEffect(() => {
    setBusy(null)
    setConfirmingDiscard(false)
    setConfirmingDismiss(false)
    setConfirmingDiscardLocal(false)
    setConfirmingMergeLocal(false)
    setConfirmingNoChangesDone(false)
    setConfirmingRefine(false)
    setConfirmingRecoverAndRetry(false)
  }, [decision, prUrl, envelope.prDeliveryId])

  const onRunVitals = useCallback((runId: string, vitals: { paused: boolean; pausedReason: string | null }) => {
    setPausedRuns((prev) => {
      const current = prev[runId]
      if (current?.paused === vitals.paused && current?.pausedReason === vitals.pausedReason) return prev
      return { ...prev, [runId]: vitals }
    })
  }, [])

  const stopPausedRun = async (runId: string) => {
    if (stoppingRunId) return
    setStoppingRunId(runId)
    try {
      const outcome = await cancelJob({ projectId: envelope.projectId, jobId: runId, kind: 'loop-run' })
      if (outcome.ok) {
        toast.info(t('prCard.stopExecutionSent'))
      } else {
        toast.error(t('prCard.stopExecutionFailed'), { description: outcome.error })
      }
    } finally {
      setStoppingRunId(null)
    }
  }

  const act = async (action: AgentPrDecisionAction, repositoryId?: string) => {
    if (checkingOut || busy || envelope.operation) return
    if (hasRepositoryDeliveries && !repositoryId && ['create-pr', 'merge-local', 'publish', 'poll-merge', 'reopen', 'acknowledge-no-changes'].includes(action)) return
    const repository = envelope.repositoryDeliveries?.find((item) => item.repositoryId === repositoryId)
    const targetBase = repository?.integrationBranch ?? repository?.baseBranch ?? envelope.baseBranch
    setBusy(action)
    try {
      const r = await postRailPrDecision(envelope.projectId, {
        prDeliveryId: envelope.prDeliveryId,
        action,
        expectedDecision: decision,
        ...(repositoryId ? { repositoryId } : {}),
      })
      let snapshotApplication: ReturnType<typeof applyPrDecisionSnapshot> | null = null
      if (r.snapshot) {
        const next = agentEnvelopeFromSnapshot(envelope, r.snapshot)
        snapshotApplication = applyPrDecisionSnapshot(next)
        if (snapshotApplication !== 'stale') setLocalEnvelope(next)
      }
      if (snapshotApplication === 'stale') {
        // Another generation already superseded this card while its HTTP
        // request was in flight. Never resurrect its controls or celebrate an
        // outcome that is no longer the active delivery.
        toast.info(t('prCard.alreadyResolved'))
        return
      }
      if (r.kind === 'recovering') {
        toast.info(t('common:prRecovery.inProgress'))
      } else if (r.kind === 'busy') {
        toast.info(t(`prCard.operation.${r.operation ?? 'inProgress'}`))
      } else if (r.kind === 'stale') {
        // Neutral: the row was already resolved elsewhere — the next
        // agent_pr_decision broadcast re-renders this card to the real state.
        toast.info(t('prCard.alreadyResolved'))
      } else if (r.kind === 'blocked') {
        // merge-local precondition — user-fixable, name exactly what to fix.
        toast.warning(r.reason === 'dirty'
          ? t('prCard.mergeLocalBlockedDirty', { base: r.base || targetBase })
          : t('prCard.mergeLocalBlockedBranch', { base: r.base || targetBase, current: r.current ?? '?' }))
      } else if (r.kind === 'failed') {
        toast.error(t('prCard.actionFailed'), { description: r.detail })
      } else if (r.kind === 'ok' && action === 'recover-and-retry') {
        if (r.deliveryVerified) {
          const sha = (r.verifiedSha ?? r.snapshot?.deliverySha ?? '').slice(0, 8)
          toast.success(t('prCard.recoverAndRetryVerified', { sha }))
        } else if (r.recoveryUnavailable || r.snapshot?.statusCode === 'recovery_unavailable') {
          toast.info(t('prCard.recoveryUnavailable'), { description: t('prCard.recoveryUnavailableBody') })
        } else {
          toast.warning(t('prCard.recoveryStillBlocked'), { description: r.detail ?? undefined })
        }
      } else if (r.kind === 'ok' && action === 'create-pr' && presentation.retryablePush && r.deliveryVerified) {
        const sha = (r.verifiedSha ?? r.snapshot?.deliverySha ?? envelope.deliverySha ?? '').slice(0, 8)
        toast.success(t(r.pushed ? 'prCard.retryPushVerified' : 'prCard.commitAlreadyVerified', { sha }))
      } else if (r.kind === 'ok' && action === 'create-pr' && r.detail) {
        // Successful HTTP can still mean a retryable/degraded delivery. Keep the
        // stable localized card title primary and expose the raw detail second.
        toast.error(t('prCard.deliveryNeedsAttention'), { description: r.detail })
      } else if (r.kind === 'ok' && action === 'poll-merge' && r.deliveryVerified === false) {
        toast.warning(t('prCard.commitMissingRetry'))
      } else if (r.kind === 'ok' && action === 'poll-merge' && r.deliveryVerified && !r.merged) {
        const sha = (r.verifiedSha ?? r.snapshot?.deliverySha ?? envelope.deliverySha ?? '').slice(0, 8)
        toast.success(t('prCard.prVerifiedWaiting', { sha }))
      } else if (action === 'poll-merge' && !r.merged && r.decision !== 'pr_closed') {
        toast.info(t('prCard.notMergedYet'))
      } else if (action === 'merge-local' && r.kind === 'ok' && r.decision === 'merged') {
        toast.success(t('prCard.mergedLocally', { base: targetBase }))
      }
      // Repo-mutating decisions (branch created/pushed, branches deleted,
      // local merge commit) → git-state surfaces refresh immediately.
      if (r.kind === 'ok' && (action === 'create-pr' || action === 'discard' || action === 'merge-local' || action === 'recover-and-retry')) {
        notifyGitChanged(envelope.projectId)
      }
    } catch (e) {
      toast.error(t('prCard.actionFailed'), { description: e instanceof Error ? e.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  const checkoutPrBranch = async (repositoryId?: string) => {
    if (hasRepositoryDeliveries && !repositoryId) return
    if (busy || checkingOut || envelope.operation) return
    setCheckingOut(true)
    try {
      const r = await (repositoryId ? postRailPrCheckout(envelope.projectId, envelope.prDeliveryId, repositoryId) : postRailPrCheckout(envelope.projectId, envelope.prDeliveryId))
      if (r.kind === 'ok') {
        toast.success(t('prCard.checkoutSuccess', { branch: r.branch ?? prDeliveryCheckoutBranch(envelope) ?? '' }))
        if (r.cleanupWarnings.length > 0) {
          toast.warning(t('prCard.cleanupIncomplete', { count: r.cleanupWarnings.length }), { description: r.cleanupWarnings.join('\n') })
        }
        // The main checkout just moved to the PR branch — git-state surfaces
        // (AgentGitBar branch strip) must reflect it immediately.
        notifyGitChanged(envelope.projectId)
      } else if (r.kind === 'recovering') {
        toast.info(t('common:prRecovery.inProgress'))
      } else if (r.error === 'checkout_dirty') {
        toast.warning(t('prCard.checkoutDirtyTitle'), { description: t('prCard.checkoutDirtyBody') })
      } else if (r.error === 'checkout_not_deliverable') {
        toast.warning(t('prCard.checkoutNotDeliverableTitle'), { description: t('prCard.checkoutNotDeliverableBody') })
      } else if (r.error === 'checkout_safety_unknown') {
        toast.warning(t('prCard.checkoutSafetyUnknownTitle'), { description: t('prCard.checkoutSafetyUnknownBody') })
      } else {
        toast.warning(t('prCard.checkoutFailed'), { description: r.detail })
      }
    } catch (e) {
      toast.error(t('prCard.checkoutFailed'), { description: e instanceof Error ? e.message : undefined })
    } finally {
      setCheckingOut(false)
    }
  }

  const inspectLocalResult = async () => {
    const paths = presentation.recoveryWorktreePaths
    if (paths.length === 0) {
      toast.info(t('prCard.localResultUnavailableHere'))
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
    } catch { /* revealing is best-effort; copying still succeeds independently */ }
    if (copied) {
      toast.success(t('prCard.localResultPathCopied'), { description: value })
    } else {
      toast.info(t('prCard.localResultPath'), { description: value })
    }
  }

  const openPr = (e: React.MouseEvent, url: string) => {
    if (canOpenWebView) {
      e.preventDefault()
      e.stopPropagation()
      openWebView(url)
    }
  }

  // Ticket refs rendered as the same clickable chips agent messages use —
  // the user asked for the spec NUMBERS to be visible on the card itself.
  const ticketChips = envelope.ticketIds.length > 0 && (
    <>
      {envelope.ticketIds.map((id) => (
        <AgentRefChip
          key={id}
          refTarget={{ kind: 'ticket', ticketId: id }}
          onOpen={(ref) => void openRef(envelope.projectId, ref)}
        >
          #{id}
        </AgentRefChip>
      ))}
    </>
  )

  // Per-run "View log" chips (runIds land right after allocation, in ticket
  // order; a single all-scope run covers every ticket). Visible in EVERY state:
  // live vitals while building, frozen totals on settled/terminal cards.
  // Defensive ?? []: coercePrDecisionEnvelope always fills runIds, but a card
  // handed an untyped legacy object must degrade to "no chips", never crash.
  const runIds = envelope.runIds ?? []
  const runTicketLabel = (i: number): string | null => {
    if (runIds.length === 1 && envelope.ticketIds.length > 1) {
      return envelope.ticketIds.map((id) => `#${id}`).join(' ')
    }
    return envelope.ticketIds[i] != null ? `#${envelope.ticketIds[i]}` : null
  }
  const pausedRunId = runIds.find((rid) => pausedRuns[rid]?.paused) ?? null
  const pausedReason = pausedRunId ? pausedRuns[pausedRunId]?.pausedReason ?? null : null
  const runChips = runIds.length > 0 && (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="pr-run-log-chips">
      {runIds.map((rid, i) => (
        <RunLogChip
          key={rid}
          projectId={envelope.projectId}
          runId={rid}
          ticketLabel={runTicketLabel(i)}
          live={decision === 'building'}
          onOpen={setLogRunId}
          onVitals={onRunVitals}
        />
      ))}
    </div>
  )
  const buildingPaused = decision === 'building' && pausedRunId !== null
  const pausedRunLabel = pausedRunId ? runTicketLabel(runIds.indexOf(pausedRunId)) ?? pausedRunId.slice(0, 8) : null

  // Mounted by BOTH render branches (building early-return + settled card).
  const logModal = logRunId && (
    <Suspense fallback={null}>
      <JobDetailModal jobId={logRunId} projectId={envelope.projectId} onClose={() => setLogRunId(null)} />
    </Suspense>
  )

  // The launch card lands in `building` from second zero: say what is actually
  // happening (isolated-worktree run) and that the PR question comes at settle.
  if (decision === 'building') {
    return (
      <div
        data-testid="agent-pr-decision-card"
        className="rounded-xl border border-border/60 bg-card/80 px-3.5 py-2.5 text-xs text-foreground/60 shadow-lg backdrop-blur-xl"
      >
        <div className="flex items-center gap-2">
          {buildingPaused
            ? <AlertTriangle className="h-3.5 w-3.5 text-accent-warning" />
            : existingPrContinuation
              ? <GitPullRequest className="h-3.5 w-3.5 text-accent-info" />
              : <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-primary/70" />}
          <span className={cn(!existingPrContinuation && !buildingPaused && 'animate-pulse', buildingPaused && 'text-accent-warning')}>
            {buildingPaused
              ? t('prCard.title.paused')
              : existingPrContinuation
                ? t('prCard.title.buildingExistingPr')
                : t('prCard.title.building')}
          </span>
        </div>
        {ticketChips && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[22px]">{ticketChips}</div>
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
                className="inline-flex items-center gap-1 rounded-full border border-accent-info/40 bg-accent-info/10 px-2 py-0.5 font-mono text-[11px] text-accent-info transition-colors hover:border-accent-info/60 hover:bg-accent-info/15"
              >
                <GitPullRequest className="h-3 w-3" />
                {displayedPrNumber ?? t('prCard.openPr')}
                <ExternalLink className="h-2.5 w-2.5 opacity-60" />
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-accent-info/40 bg-accent-info/10 px-2 py-0.5 font-mono text-[11px] text-accent-info">
                <GitPullRequest className="h-3 w-3" />
                {displayedPrNumber ?? t('prCard.existingPr')}
              </span>
            )}
            <span
              title={t('git.branch')}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 font-mono text-[11px] text-foreground/70"
            >
              <GitBranch className="h-3 w-3 shrink-0 text-accent-primary/70" />
              <span className="truncate">{envelope.branch}</span>
            </span>
          </div>
        )}
        {buildingPaused && pausedRunId && (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-accent-warning/35 bg-accent-warning/10 px-2 py-1.5 text-[11px] text-accent-warning" data-testid="pr-run-paused-actions">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={pausedReason ?? undefined}>
              {pausedRunLabel ? t('prCard.pausedForRun', { ref: pausedRunLabel }) : t('prCard.paused')}
              {pausedReason ? `: ${pausedReason}` : ''}
            </span>
            <button
              type="button"
              data-agent-interactive
              onClick={(e) => {
                e.stopPropagation()
                setLogRunId(pausedRunId)
              }}
              className="inline-flex items-center gap-1 rounded-md border border-accent-warning/40 bg-surface/70 px-2 py-0.5 font-medium text-accent-warning transition-colors hover:bg-accent-warning/15"
            >
              <Play className="h-3 w-3" />
              {t('prCard.resume')}
            </button>
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
        <p className="mt-1 pl-[22px] text-[11px] leading-4 text-foreground/40">
          {existingPrContinuation ? t('prCard.buildingExistingPrHint') : t('prCard.buildingHint')}
        </p>
        {logModal}
      </div>
    )
  }

  const Icon = HEADER_ICON[decision]
  const title = presentation.superseded
    ? t('prCard.title.superseded')
    : presentation.noChanges
      ? t('prCard.title.no_changes')
      : presentation.deliveryBlocked
      ? t('prCard.title.delivery_blocked')
      : presentation.retryablePush
        ? t('prCard.title.update_failed')
        : presentation.closed
          ? t('prCard.title.pr_closed')
          : presentation.partial
            ? t('prCard.title.partial')
            : envelope.statusCode === 'existing_pr_updated'
                ? t('prCard.title.existing_pr_updated')
                : degradedDraft ? t('prCard.title.pr_draft_degraded') : t(`prCard.title.${decision}`)

  const primaryBtn =
    'inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-primary/90 disabled:cursor-default disabled:opacity-60'
  const ghostBtn = cn(
    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-60',
    'border-border/60 text-foreground/70 hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive',
  )

  const anyBusy = busy !== null || checkingOut || envelope.operation != null
  const shouldAnnounce = Boolean(envelope.operation) || recoveredInterruptedOperation || presentation.partial || presentation.deliveryBlocked || presentation.retryablePush || presentation.retryablePrCreation || presentation.closed || presentation.implementationFailed
  const spinner = <Loader2 className="h-3 w-3 animate-spin" />

  const primaryAction = (action: AgentPrDecisionAction, label: string) => !hasRepositoryDeliveries && (
    <button type="button" onClick={() => void act(action)} disabled={anyBusy} data-agent-interactive className={primaryBtn}>
      {busy === action && spinner}
      {label}
    </button>
  )

  // Entry into the plain-language review packet (nontech-review-experience).
  // The card keeps its precise git actions; this offers the readable surface to
  // whoever would rather judge the work than the plumbing.
  const reviewPacketAction = FEATURE_REVIEW_PACKET && inRouterContext && !presentation.terminal
    ? <ReviewPacketEntry prDeliveryId={envelope.prDeliveryId} projectId={envelope.projectId} />
    : null

  const checkoutBranch = prDeliveryCheckoutBranch(envelope)
  const checkoutAction = checkoutBranch && !hasRepositoryDeliveries && (
    <button
      type="button"
      onClick={() => void checkoutPrBranch()}
      disabled={anyBusy}
      data-testid="agent-pr-checkout"
      data-agent-interactive
      title={t('prCard.checkoutTooltip', { branch: checkoutBranch })}
      className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-foreground/70 transition-colors hover:border-accent-primary/40 hover:bg-accent-primary/10 disabled:pointer-events-none disabled:opacity-50"
    >
      {checkingOut ? spinner : <GitBranch className="h-3 w-3" />}
      {t('prCard.checkout')}
    </button>
  )

  const inspectLocalResultAction = presentation.recoveryWorktreePaths.length > 0 && (
    <button
      type="button"
      onClick={() => void inspectLocalResult()}
      disabled={anyBusy}
      data-testid="agent-pr-inspect-local-result"
      data-agent-interactive
      title={t('prCard.inspectLocalResultTooltip')}
      className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-foreground/70 transition-colors hover:border-accent-primary/40 hover:bg-accent-primary/10 disabled:pointer-events-none disabled:opacity-50"
    >
      <FolderOpen className="h-3 w-3" aria-hidden />
      {t('prCard.inspectLocalResult')}
    </button>
  )

  const recoveryIsRecheck = presentation.recoveryRecheck
  const recoverAndRetryAction = (presentation.manualRecovery || recoveryIsRecheck) && (
    <button
      type="button"
      onClick={() => setConfirmingRecoverAndRetry(true)}
      disabled={anyBusy}
      data-testid={recoveryIsRecheck ? 'agent-pr-recheck-recovery' : 'agent-pr-recover-and-retry'}
      data-agent-interactive
      className={recoveryIsRecheck
        ? 'inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-foreground/70 transition-colors hover:border-accent-primary/40 hover:bg-accent-primary/10 disabled:pointer-events-none disabled:opacity-50'
        : primaryBtn}
    >
      {busy === 'recover-and-retry' ? spinner : <RotateCcw className="h-3 w-3" aria-hidden />}
      {t(recoveryIsRecheck ? 'prCard.recheckRecovery' : 'prCard.recoverAndRetry')}
    </button>
  )

  // Remote-less acceptance (no PR exists yet): merge into the base locally.
  const mergeLocalAction = !hasRepositoryDeliveries && (
    <button
      type="button"
      onClick={() => setConfirmingMergeLocal(true)}
      disabled={anyBusy}
      data-testid="agent-pr-merge-local"
      data-agent-interactive
      title={t('prCard.mergeLocalTooltip', { base: envelope.baseBranch })}
      className="inline-flex items-center gap-1 rounded-md border border-accent-success/40 bg-accent-success/10 px-2 py-1 text-[11px] font-medium text-accent-success transition-colors hover:bg-accent-success/20 disabled:pointer-events-none disabled:opacity-50"
    >
      {busy === 'merge-local' && spinner}
      {t('prCard.mergeLocal')}
    </button>
  )

  const discardAction = (
    <button type="button" onClick={() => setConfirmingDiscard(true)} disabled={anyBusy} data-agent-interactive className={ghostBtn}>
      {busy === 'discard' && spinner}
      {t('prCard.discard')}
    </button>
  )

  const dismissAction = (
    <button type="button" onClick={() => setConfirmingDismiss(true)} disabled={anyBusy} data-agent-interactive className={ghostBtn}>
      {busy === 'dismiss' && spinner}
      {t('prCard.dismiss')}
    </button>
  )

  const discardLocalAction = (
    <button type="button" onClick={() => setConfirmingDiscardLocal(true)} disabled={anyBusy} data-agent-interactive className={ghostBtn}>
      {busy === 'discard' && spinner}
      {t('prCard.discardLocalResult')}
    </button>
  )

  const acknowledgeNoChangesAction = !hasRepositoryDeliveries && (
    <button type="button" onClick={() => setConfirmingNoChangesDone(true)} disabled={anyBusy} data-agent-interactive className={primaryBtn}>
      {busy === 'acknowledge-no-changes' && spinner}
      {t('prCard.markDone')}
    </button>
  )

  const refineAction = (
    <button type="button" onClick={() => setConfirmingRefine(true)} disabled={anyBusy} data-agent-interactive className={ghostBtn}>
      {busy === 'discard' && spinner}
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
      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 font-mono text-[11px] text-accent-info transition-colors hover:border-accent-info/50 hover:bg-accent-info/10"
    >
      <GitPullRequest className="h-3 w-3" />
      {displayedPrNumber ?? t('prCard.openPr')}
      <ExternalLink className="h-2.5 w-2.5 opacity-60" />
    </a>
  )

  return (
    <div
      data-testid="agent-pr-decision-card"
      className={cn(
        'rounded-xl border border-border/60 bg-card/80 px-3.5 py-3 shadow-lg backdrop-blur-xl',
        decision === 'merged' && 'border-accent-success/30',
        decision === 'completed' && 'border-accent-success/30',
        decision === 'discarded' && 'opacity-70',
      )}
    >
      {shouldAnnounce && (
        <span
          role="status"
          aria-live="polite"
          aria-label={envelope.operation
            ? t(`prCard.operation.${envelope.operation}`)
            : recoveredInterruptedOperation ? t('common:prRecovery.interrupted') : title}
          className="sr-only"
        />
      )}
      {/* Header: state icon + title + project + rail badge */}
      <div className="flex items-center gap-2">
        <Icon className={cn('h-4 w-4 shrink-0', HEADER_ICON_TONE[decision])} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        <span className="max-w-[140px] shrink-0 truncate text-[11px] text-foreground/50" title={projectName}>
          {projectName}
        </span>
        <span className="shrink-0 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground/60">
          {t('prCard.rail', { index: envelope.railIndex + 1 })}
        </span>
      </div>

      <RepositoryDeliveries deliveryId={envelope.prDeliveryId} repositories={envelope.repositoryDeliveries}
        busy={!!busy || checkingOut || !!envelope.operation} onAct={act} onCheckout={checkoutPrBranch} />

      {/* Body: base-branch chip + spec count + PR link */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {!hasRepositoryDeliveries && <span
          title={t('prCard.base')}
          className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 font-mono text-[11px] text-foreground/70"
        >
          <GitBranch className="h-3 w-3 text-accent-primary/70" />
          {'→ '}
          {envelope.baseBranch}
        </span>}
        <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 text-[11px] text-foreground/70">
          <Ticket className="h-3 w-3 text-accent-secondary/80" />
          {t('prCard.specCount', { count: envelope.ticketIds.length })}
        </span>
        {ticketChips}
        {prLink}
        {envelope.deliverySha && (
          <span
            data-testid="agent-pr-delivery-sha"
            title={envelope.deliverySha}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px]',
              envelope.deliveryOutcome === 'delivered'
                ? 'border-accent-success/35 bg-accent-success/10 text-accent-success'
                : 'border-border/60 bg-surface/60 text-foreground/65',
            )}
          >
            <CheckCircle2 className="h-3 w-3" />
            {t('prCard.deliveryCommit', { sha: envelope.deliverySha.slice(0, 8) })}
          </span>
        )}
      </div>

      {/* Per-run log chips — frozen vitals once the rail settled. */}
      {runChips}

      {envelope.operation && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-accent-info" data-testid="agent-pr-operation">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {t(`prCard.operation.${envelope.operation}`)}
        </p>
      )}

      {recoveredInterruptedOperation && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-accent-info" data-testid="agent-pr-recovery-interrupted">
          <RotateCcw className="mt-px h-3 w-3 shrink-0" aria-hidden />
          <span>{t('common:prRecovery.interrupted')}</span>
        </p>
      )}

      <OutcomeEvidence envelope={envelope} />

      {statusLabel && (
        <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-foreground/45" data-testid="agent-pr-status-code">
          {statusLabel}
        </p>
      )}

      {!terminal && presentation.deliveryBlocked && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-accent-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>
            {presentation.recoveryUnavailable
              ? t('prCard.recoveryUnavailableBody')
              : t(presentation.partial ? 'prCard.partialDeliveryBlockedNote' : 'prCard.deliveryBlockedNote')}
            {envelope.statusDetail && !interruptedOperationDetail && !presentation.recoveryUnavailable
              ? <span className="mt-0.5 block text-foreground/50">{envelope.statusDetail}</span>
              : null}
          </span>
        </p>
      )}

      {!terminal && presentation.recoveryUnavailable && envelope.statusDetail && !interruptedOperationDetail && (
        <details className="mt-1.5 text-[10px] leading-4 text-foreground/55" data-testid="agent-pr-recovery-technical-detail">
          <summary className="cursor-pointer font-medium text-foreground/65">{t('prCard.recoveryDetailSummary')}</summary>
          <p className="mt-1 break-words">{envelope.statusDetail}</p>
        </details>
      )}

      {!terminal && presentation.retryablePush && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-accent-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>
            {t('prCard.retryPushNote')}
            {envelope.statusDetail && !interruptedOperationDetail ? <span className="mt-0.5 block text-foreground/50">{envelope.statusDetail}</span> : null}
          </span>
        </p>
      )}

      {envelope.statusDetail && !interruptedOperationDetail && !presentation.deliveryBlocked && !presentation.retryablePush && (
        <p className="mt-1 text-[10px] leading-4 text-foreground/45" data-testid="agent-pr-status-detail">
          {envelope.statusDetail}
        </p>
      )}

      {/* Degraded delivery: pushed / assembled-locally but no PR yet. */}
      {!terminal && !prUrl && (prState === 'pushed' || prState === 'local-only') && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-accent-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          {prState === 'local-only' ? t('prCard.degraded.localOnly') : t('prCard.degraded.pushed')}
        </p>
      )}

      {presentation.cleanupWarnings.length > 0 && (
        <div className="mt-2 rounded-md border border-accent-warning/35 bg-accent-warning/10 px-2 py-1.5 text-[11px] text-accent-warning" data-testid="agent-pr-cleanup-warning">
          <p className="font-medium">{t('prCard.cleanupIncomplete', { count: presentation.cleanupWarnings.length })}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-foreground/60">
            {presentation.cleanupWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
          </ul>
        </div>
      )}

      {presentation.safetyArchives.length > 0 && (
        <details
          className="mt-2 rounded-md border border-accent-info/25 bg-accent-info/5 px-2 py-1.5 text-[11px] text-foreground/65"
          data-agent-interactive
          data-testid="agent-pr-safety-archives"
        >
          <summary className="cursor-pointer font-medium text-accent-info">
            {t('prCard.safetyArchiveTitle', { count: presentation.safetyArchives.length })}
          </summary>
          <p className="mt-1 leading-4">{t('prCard.safetyArchiveHint')}</p>
          <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-foreground/50">
            {presentation.safetyArchives.map((archive) => (
              <li key={archive} className="break-all">{archive}</li>
            ))}
          </ul>
        </details>
      )}

      {/* Replace actions immediately when the authoritative state changes.
          Delaying the swap for an exit animation could briefly retain a stale,
          unsafe action after a blocked-delivery snapshot lands. */}
      <motion.div
        key={`${decision}-${prUrl ?? ''}`}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="mt-2.5"
      >
          {presentation.noChanges && !terminal && (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-accent-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {presentation.continuation ? t('prCard.noChangesExisting') : t('prCard.noChangesNote')}
              </p>
              <div className="flex items-center gap-1.5">
                {presentation.continuation ? dismissAction : <>{acknowledgeNoChangesAction}{refineAction}</>}
              </div>
            </div>
          )}
          {!terminal && presentation.deliveryBlocked && (
            <div className="flex flex-wrap items-center gap-1.5">
              {inspectLocalResultAction}
              {recoverAndRetryAction}
              {presentation.continuation
                ? (presentation.hasDiscardableRecoveryResult ? discardLocalAction : dismissAction)
                : discardAction}
            </div>
          )}
          {!terminal && presentation.retryablePush && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('create-pr', t('prCard.retryPush'))}
              {presentation.continuation ? dismissAction : discardAction}
            </div>
          )}
          {!terminal && presentation.retryablePrCreation && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('create-pr', t('prCard.retryPr'))}
              {mergeLocalAction}
              {presentation.continuation ? dismissAction : discardAction}
            </div>
          )}
          {!terminal && presentation.closed && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('reopen', t('prCard.reopen'))}
              {presentation.continuation ? dismissAction : discardAction}
            </div>
          )}
          {!terminal && partialCreatePending && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('create-pr', t('prCard.createPartialPr', { count: presentation.deliverableCount }))}
              {presentation.continuation ? dismissAction : discardAction}
            </div>
          )}
          {decision === 'on_review' && !presentation.noChanges && !presentation.partial && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
            <div className="flex items-center gap-1.5">
              {reviewPacketAction}
              {checkoutAction}
              {primaryAction('create-pr', t('prCard.createPr'))}
              {mergeLocalAction}
              {presentation.continuation ? dismissAction : discardAction}
            </div>
          )}
          {decision === 'pr_draft' && !degradedDraft && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('publish', t('prCard.publish'))}
              {presentation.continuation ? dismissAction : discardAction}
            </div>
          )}
          {degradedDraft && !partialCreatePending && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('create-pr', t('prCard.retryPr'))}
              {mergeLocalAction}
              {presentation.continuation ? dismissAction : discardAction}
            </div>
          )}
          {decision === 'pr_ready' && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('poll-merge', t('prCard.verifyPr'))}
              {presentation.continuation ? dismissAction : discardAction}
            </div>
          )}
          {decision === 'pr_failed' && !presentation.deliveryBlocked && !presentation.retryablePush && !presentation.retryablePrCreation && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('create-pr', t('prCard.retry'))}
              {!prUrl && mergeLocalAction}
              {presentation.continuation ? dismissAction : discardAction}
            </div>
          )}
          {decision === 'implementation_failed' && presentation.implementationFailed && (
            <div className="space-y-2">
              <p className="flex items-start gap-1.5 text-[11px] leading-4 text-destructive">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {t('prCard.implementationFailedNote')}
              </p>
              <div className="flex items-center gap-1.5">
                {presentation.continuation ? dismissAction : discardAction}
              </div>
            </div>
          )}
          {decision === 'merged' && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-accent-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('prCard.mergedNote')}
            </p>
          )}
          {decision === 'discarded' && (
            <p className="flex items-center gap-1.5 text-xs text-foreground/50">
              <XCircle className="h-3.5 w-3.5" />
              {t('prCard.discardedNote')}
            </p>
          )}
          {decision === 'completed' && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-accent-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('prCard.completedNote')}
            </p>
          )}
          {decision === 'superseded' && (
            <p className="flex items-center gap-1.5 text-xs text-foreground/50">
              <GitPullRequest className="h-3.5 w-3.5" />
              {t('prCard.supersededNote')}
            </p>
          )}
      </motion.div>
      <Dialog open={!hasRepositoryDeliveries && confirmingMergeLocal} onOpenChange={setConfirmingMergeLocal}>
        <DialogContent className="max-w-sm" data-testid="agent-pr-merge-local-confirm">
          <DialogHeader>
            <DialogTitle>{t('prCard.confirm.mergeLocalTitle')}</DialogTitle>
            <DialogDescription>{t('prCard.confirm.mergeLocalBody', { base: envelope.baseBranch })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmingMergeLocal(false)}>{t('common:actions.cancel')}</Button>
            <Button size="sm" disabled={anyBusy} data-testid="agent-pr-merge-local-confirm-btn" onClick={() => { setConfirmingMergeLocal(false); void act('merge-local') }}>
              {t('prCard.mergeLocal')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmingRecoverAndRetry} onOpenChange={setConfirmingRecoverAndRetry}>
        <DialogContent className="max-w-sm" data-testid="agent-pr-recover-and-retry-confirm">
          <DialogHeader>
            <DialogTitle>{t(recoveryIsRecheck ? 'prCard.confirm.recheckRecoveryTitle' : 'prCard.confirm.recoverAndRetryTitle')}</DialogTitle>
            <DialogDescription>{t(recoveryIsRecheck ? 'prCard.confirm.recheckRecoveryBody' : 'prCard.confirm.recoverAndRetryBody', { branch: envelope.branch ?? '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmingRecoverAndRetry(false)}>{t('common:actions.cancel')}</Button>
            <Button size="sm" disabled={anyBusy} data-testid="agent-pr-recover-and-retry-confirm-btn" onClick={() => { setConfirmingRecoverAndRetry(false); void act('recover-and-retry') }}>
              {t(recoveryIsRecheck ? 'prCard.recheckRecovery' : 'prCard.recoverAndRetry')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <DialogContent className="max-w-sm" data-testid="agent-pr-discard-confirm">
          <DialogHeader>
            <DialogTitle>{t(decision === 'implementation_failed'
              ? 'prCard.confirm.implementationFailedDiscardTitle'
              : 'prCard.confirm.freshDiscardTitle')}</DialogTitle>
            <DialogDescription>{t(decision === 'implementation_failed'
              ? 'prCard.confirm.implementationFailedDiscardBody'
              : 'prCard.confirm.freshDiscardBody')}</DialogDescription>
            {isStackedHead && (
              <p className="mt-2 rounded-md border border-accent-warning/40 bg-accent-warning/10 px-2 py-1.5 text-xs text-accent-warning" data-testid="agent-pr-discard-stacked-note">
                {t('prCard.discardStackedNote')}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmingDiscard(false)}>{t('common:actions.cancel')}</Button>
            <Button variant="destructive" size="sm" disabled={anyBusy} data-testid="agent-pr-discard-confirm-btn" onClick={() => { setConfirmingDiscard(false); void act('discard') }}>
              {t('prCard.discard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmingDismiss} onOpenChange={setConfirmingDismiss}>
        <DialogContent className="max-w-sm" data-testid="agent-pr-dismiss-confirm">
          <DialogHeader>
            <DialogTitle>{t('prCard.confirm.dismissTitle')}</DialogTitle>
            <DialogDescription>{t('prCard.confirm.dismissBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmingDismiss(false)}>{t('common:actions.cancel')}</Button>
            <Button size="sm" disabled={anyBusy} data-testid="agent-pr-dismiss-confirm-btn" onClick={() => { setConfirmingDismiss(false); void act('dismiss') }}>
              {t('prCard.dismiss')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmingDiscardLocal} onOpenChange={setConfirmingDiscardLocal}>
        <DialogContent className="max-w-sm" data-testid="agent-pr-discard-local-confirm">
          <DialogHeader>
            <DialogTitle>{t('prCard.confirm.discardLocalTitle')}</DialogTitle>
            <DialogDescription>{t('prCard.confirm.discardLocalBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmingDiscardLocal(false)}>{t('common:actions.cancel')}</Button>
            <Button variant="destructive" size="sm" disabled={anyBusy} data-testid="agent-pr-discard-local-confirm-btn" onClick={() => { setConfirmingDiscardLocal(false); void act('discard') }}>
              {t('prCard.discardLocalResult')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!hasRepositoryDeliveries && confirmingNoChangesDone} onOpenChange={setConfirmingNoChangesDone}>
        <DialogContent className="max-w-sm" data-testid="agent-pr-no-changes-done-confirm">
          <DialogHeader>
            <DialogTitle>{t('prCard.confirm.noChangesDoneTitle')}</DialogTitle>
            <DialogDescription>{t('prCard.confirm.noChangesDoneBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmingNoChangesDone(false)}>{t('common:actions.cancel')}</Button>
            <Button size="sm" disabled={anyBusy} data-testid="agent-pr-no-changes-done-confirm-btn" onClick={() => { setConfirmingNoChangesDone(false); void act('acknowledge-no-changes') }}>
              {t('prCard.markDone')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmingRefine} onOpenChange={setConfirmingRefine}>
        <DialogContent className="max-w-sm" data-testid="agent-pr-refine-confirm">
          <DialogHeader>
            <DialogTitle>{t('prCard.confirm.refineTitle')}</DialogTitle>
            <DialogDescription>{t('prCard.confirm.refineBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmingRefine(false)}>{t('common:actions.cancel')}</Button>
            <Button variant="destructive" size="sm" disabled={anyBusy} data-testid="agent-pr-refine-confirm-btn" onClick={() => { setConfirmingRefine(false); void act('discard') }}>
              {t('prCard.refine')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {logModal}
    </div>
  )
}
