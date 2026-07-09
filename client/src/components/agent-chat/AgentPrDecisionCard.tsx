import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'motion/react'
import {
  GitBranch, GitMerge, GitPullRequest, AlertTriangle, XCircle,
  ExternalLink, Loader2, CheckCircle2, Ticket, ScrollText, Play, Square,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useDesktop } from '../../hooks/useDesktop'
import { useWebViewModal } from '../../context/WebViewModalContext'
import { useAgentRefActions } from '../../hooks/useAgentRefActions'
import { useRunVitals, formatRunElapsed } from '../../hooks/useRunVitals'
import {
  postRailPrDecision,
  postRailPrCheckout,
  type AgentPrDecisionAction,
  type AgentPrDecisionEnvelope,
} from '../../lib/agent-api'
import { cancelJob } from '../../lib/cancel-job'
import { AgentRefChip } from './AgentRefChip'

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
  implementation_failed: 'text-destructive',
  pr_failed: 'text-destructive',
  merged: 'text-accent-success',
  discarded: 'text-foreground/40',
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

export function AgentPrDecisionCard({ envelope }: { envelope: AgentPrDecisionEnvelope }) {
  const { t } = useTranslation('agent')
  const { projects } = useDesktop()
  const { openWebView, canOpenWebView } = useWebViewModal()
  // Ticket chips resolve against the CARD's project (never the active one) —
  // same scoping rule as the card's decision POSTs.
  const { openRef } = useAgentRefActions()
  const [busy, setBusy] = useState<AgentPrDecisionAction | null>(null)
  const [checkingOut, setCheckingOut] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A clicked run-log chip → the run's JobDetailModal (portals to body).
  const [logRunId, setLogRunId] = useState<string | null>(null)
  const [pausedRuns, setPausedRuns] = useState<Record<string, { paused: boolean; pausedReason: string | null }>>({})
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)

  const { decision, prUrl, prState } = envelope
  const projectName = projects.find((p) => p.id === envelope.projectId)?.name ?? envelope.projectId
  const degradedDraft = decision === 'pr_draft' && !prUrl
  const existingPrContinuation = decision === 'building' && prState === 'pr-created' && Boolean(envelope.branch)
  const displayedPrNumber = envelope.prNumber ? `#${envelope.prNumber}` : prUrl ? prNumberFromUrl(prUrl) : null
  const terminal = decision === 'merged' || decision === 'discarded'

  // A broadcast moved the envelope on (this surface or the other one answered):
  // reconcile any local in-flight/confirm state to the fresh decision.
  useEffect(() => {
    setBusy(null)
    setConfirmingDiscard(false)
  }, [decision, prUrl])

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
  }, [])

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

  const act = async (action: AgentPrDecisionAction) => {
    if (checkingOut) return
    setBusy(action)
    try {
      const r = await postRailPrDecision(envelope.projectId, {
        prDeliveryId: envelope.prDeliveryId,
        action,
        expectedDecision: decision,
      })
      if (r.kind === 'stale') {
        // Neutral: the row was already resolved elsewhere — the next
        // agent_pr_decision broadcast re-renders this card to the real state.
        toast.info(t('prCard.alreadyResolved'))
      } else if (r.kind === 'blocked') {
        // merge-local precondition — user-fixable, name exactly what to fix.
        toast.warning(r.reason === 'dirty'
          ? t('prCard.mergeLocalBlockedDirty', { base: r.base || envelope.baseBranch })
          : t('prCard.mergeLocalBlockedBranch', { base: r.base || envelope.baseBranch, current: r.current ?? '?' }))
      } else if (r.kind === 'failed') {
        toast.error(t('prCard.actionFailed'), { description: r.detail })
      } else if (action === 'poll-merge' && !r.merged) {
        toast.info(t('prCard.notMergedYet'))
      } else if (action === 'merge-local' && r.kind === 'ok' && r.decision === 'merged') {
        toast.success(t('prCard.mergedLocally', { base: envelope.baseBranch }))
      }
    } catch (e) {
      toast.error(t('prCard.actionFailed'), { description: e instanceof Error ? e.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  const checkoutPrBranch = async () => {
    if (busy || checkingOut) return
    setCheckingOut(true)
    try {
      const r = await postRailPrCheckout(envelope.projectId, envelope.prDeliveryId)
      if (r.kind === 'ok') {
        toast.success(t('prCard.checkoutSuccess', { branch: envelope.branch ?? '' }))
      } else {
        toast.warning(t('prCard.checkoutFailed'), { description: r.detail })
      }
    } catch (e) {
      toast.error(t('prCard.checkoutFailed'), { description: e instanceof Error ? e.message : undefined })
    } finally {
      setCheckingOut(false)
    }
  }

  const onDiscardClick = () => {
    if (!confirmingDiscard) {
      setConfirmingDiscard(true)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmingDiscard(false), 3000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmingDiscard(false)
    void act('discard')
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
  const title = degradedDraft ? t('prCard.title.pr_draft_degraded') : t(`prCard.title.${decision}`)

  const primaryBtn =
    'inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-primary/90 disabled:cursor-default disabled:opacity-60'
  const ghostBtn = cn(
    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-60',
    confirmingDiscard
      ? 'border-destructive/50 bg-destructive/10 font-medium text-destructive hover:bg-destructive/20'
      : 'border-border/60 text-foreground/70 hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive',
  )

  const anyBusy = busy !== null || checkingOut
  const spinner = <Loader2 className="h-3 w-3 animate-spin" />

  const primaryAction = (action: AgentPrDecisionAction, label: string) => (
    <button type="button" onClick={() => void act(action)} disabled={anyBusy} data-agent-interactive className={primaryBtn}>
      {busy === action && spinner}
      {label}
    </button>
  )

  const checkoutAction = prUrl && envelope.branch && (
    <button
      type="button"
      onClick={() => void checkoutPrBranch()}
      disabled={anyBusy}
      data-testid="agent-pr-checkout"
      data-agent-interactive
      title={t('prCard.checkoutTooltip', { branch: envelope.branch })}
      className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-foreground/70 transition-colors hover:border-accent-primary/40 hover:bg-accent-primary/10 disabled:pointer-events-none disabled:opacity-50"
    >
      {checkingOut ? spinner : <GitBranch className="h-3 w-3" />}
      {t('prCard.checkout')}
    </button>
  )

  // Remote-less acceptance (no PR exists yet): merge into the base locally.
  const mergeLocalAction = (
    <button
      type="button"
      onClick={() => void act('merge-local')}
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
    <button type="button" onClick={onDiscardClick} disabled={anyBusy} data-agent-interactive className={ghostBtn}>
      {busy === 'discard' && spinner}
      {confirmingDiscard ? t('prCard.confirmDiscard') : t('prCard.discard')}
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
        decision === 'discarded' && 'opacity-70',
      )}
    >
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

      {/* Body: base-branch chip + spec count + PR link */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span
          title={t('prCard.base')}
          className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 font-mono text-[11px] text-foreground/70"
        >
          <GitBranch className="h-3 w-3 text-accent-primary/70" />
          {'→ '}
          {envelope.baseBranch}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 text-[11px] text-foreground/70">
          <Ticket className="h-3 w-3 text-accent-secondary/80" />
          {t('prCard.specCount', { count: envelope.ticketIds.length })}
        </span>
        {ticketChips}
        {prLink}
      </div>

      {/* Per-run log chips — frozen vitals once the rail settled. */}
      {runChips}

      {/* Degraded delivery: pushed / assembled-locally but no PR yet. */}
      {!terminal && !prUrl && (prState === 'pushed' || prState === 'local-only') && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-accent-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          {prState === 'local-only' ? t('prCard.degraded.localOnly') : t('prCard.degraded.pushed')}
        </p>
      )}

      {/* Actions / terminal note — cross-fades on every decision transition. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${decision}-${prUrl ?? ''}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="mt-2.5"
        >
          {decision === 'on_review' && (
            <div className="flex items-center gap-1.5">
              {primaryAction('create-pr', t('prCard.createPr'))}
              {mergeLocalAction}
              {discardAction}
            </div>
          )}
          {decision === 'pr_draft' && !degradedDraft && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('publish', t('prCard.publish'))}
              {discardAction}
            </div>
          )}
          {degradedDraft && (
            <div className="flex items-center gap-1.5">
              {primaryAction('create-pr', t('prCard.retryPr'))}
              {mergeLocalAction}
              {discardAction}
            </div>
          )}
          {decision === 'pr_ready' && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('poll-merge', t('prCard.checkMerge'))}
              {discardAction}
            </div>
          )}
          {decision === 'pr_failed' && (
            <div className="flex items-center gap-1.5">
              {checkoutAction}
              {primaryAction('create-pr', t('prCard.retry'))}
              {!prUrl && mergeLocalAction}
              {discardAction}
            </div>
          )}
          {decision === 'implementation_failed' && (
            <div className="space-y-2">
              <p className="flex items-start gap-1.5 text-[11px] leading-4 text-destructive">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {t('prCard.implementationFailedNote')}
              </p>
              <div className="flex items-center gap-1.5">
                {discardAction}
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
        </motion.div>
      </AnimatePresence>
      {logModal}
    </div>
  )
}
