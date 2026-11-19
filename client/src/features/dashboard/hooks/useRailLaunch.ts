/**
 * Launching rails: the Play/Stop toggle (with the target-PR confirmation),
 * the single-rail launch path and its refusal toasts, and Launch all — the
 * eligibility plan, its batch confirmation and the one summary toast.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { notifyError } from '../../../lib/notify-error'
import { useLaunchGuard } from '../../provider-quota/lib/useLaunchPreflight'
import { openBudgetPanel } from '../../../lib/app-settings-events'
import { getApiBase } from '../../../lib/api'
import { FEATURE_LOOPS_SECTION } from '../../../lib/feature-flags'
import type { RailState } from '../../rails/components/RailsBoard'
import { effectiveLoopId, deriveRailMode, offeredRecommendation } from '../../rails/lib/rail-loops'
import { recommendedLoopForTickets } from '../../specs/lib/spec-triage'
import { defaultModelForProvider } from '../../loops/lib/loop-run-models'
import { isRolesEngine, reasoningEffortsForProvider } from '../../providers/lib/provider-capabilities'
import { railIndexFromId } from '../../rails/lib/rail-id'
import type { LocalTicket, RailPrStateSnapshot } from '../../../types'
import { dailyBudgetActionMessage, dailyBudgetExceededMessage, readDailyBudgetRejection } from '../../../lib/daily-budget'
import { createInitialCommit, initialCommitErrorMessage } from '../../../lib/initial-commit'
import { railLaunchAddsReviewWip, type PendingReview, readReviewWipRejection, reviewWipActionMessage, reviewWipCapacity, reviewWipRejectionMessage } from '../../../lib/review-wip'
import {
  prDecisionContinuesTickets,
  railProviderOf,
  serverRailIndex,
  ticketHasContinuablePr,
  type LaunchAllSkipReason,
  type LaunchOutcome,
} from '../lib/board-rails'
import type { RailsUpdater } from './useBoardRails'

export function useRailLaunch(args: {
  activeProjectId: string | null
  rails: RailState[]
  tickets: LocalTicket[]
  ticketMap: ReadonlyMap<number, LocalTicket>
  updateRails: RailsUpdater
  railProviders: readonly string[]
  railPrDecisions: ReadonlyMap<number, RailPrStateSnapshot>
  railPrDecisionsHydrated: boolean
  reviewWipLimit: number | null
  pendingReview: readonly PendingReview[]
}) {
  const {
    activeProjectId, rails, tickets, ticketMap, updateRails, railProviders,
    railPrDecisions, railPrDecisionsHydrated, reviewWipLimit, pendingReview,
  } = args
  const { t } = useTranslation('dashboard')
  const launchGuard = useLaunchGuard()
  const railProvider = (r: { aiEngine?: string | null } | undefined) => railProviderOf(r, railProviders)
  // Confirm-before-launch when the rail targets an EXISTING PR (mis-pick must
  // be visible before any work starts on that PR's head branch).
  const [targetPrConfirm, setTargetPrConfirm] = useState<{ railId: string } | null>(null)
  // Launch-all pending its batch confirmation (N parallel AI launches).
  const [launchAllConfirm, setLaunchAllConfirm] = useState(false)

  // ── Launch all (parallel) ────────────────────────────────────────────────────
  // Which rails a "Launch all" would start right now, and why the rest are
  // skipped. Eligible = idle + has specs + no uncontinuable PR delivery + no
  // spec frozen on review without an open PR head. Worktree isolation makes the
  // parallel fan-out safe.
  const launchAllPlan = useMemo(() => {
    const eligible: RailState[] = []
    const skipped: { rail: RailState; reason: LaunchAllSkipReason }[] = []
    let capacity = reviewWipCapacity(reviewWipLimit, pendingReview.length)
    rails.forEach((r, pos) => {
      const idx = railIndexFromId(r.id) ?? pos
      if (r.status === 'running') { skipped.push({ rail: r, reason: 'running' }); return }
      if (r.ticketIds.length === 0) { skipped.push({ rail: r, reason: 'empty' }); return }
      const decision = railPrDecisions.get(idx)
      const continuesAddenda = decision && decision.decision !== 'building'
        && decision.ticketIds.length === r.ticketIds.length
        && r.ticketIds.every((id) => decision.ticketIds.includes(id))
        && r.ticketIds.some((id) => ticketMap.get(id)?.addenda?.some((a) => a.status === 'open'))
      if (decision && !prDecisionContinuesTickets(decision, r.ticketIds) && !continuesAddenda) {
        skipped.push({ rail: r, reason: 'pendingDecision' }); return
      }
      if (r.ticketIds.some((id) => ticketMap.get(id)?.status === 'on_review' && (!railPrDecisionsHydrated || !ticketHasContinuablePr(id, railPrDecisions, tickets)))) {
        skipped.push({ rail: r, reason: 'onReview' }); return
      }
      // Review WIP limit: a rail that would add a NEW delivery takes one slot
      // of the remaining capacity, in board order; the rest wait. A rail
      // continuing its own delivery never takes a slot.
      if (railLaunchAddsReviewWip(idx, railPrDecisions)) {
        if (capacity <= 0) { skipped.push({ rail: r, reason: 'reviewLimit' }); return }
        capacity -= 1
      }
      eligible.push(r)
    })
    return { eligible, skipped }
  }, [rails, railPrDecisions, railPrDecisionsHydrated, ticketMap, tickets, reviewWipLimit, pendingReview.length])

  /** Run the Launch-all preflight for one rail; true (after telling the person why) when a check fails. */
  async function launchBlocked(rail: RailState, retry: () => void): Promise<boolean> {
    if (!activeProjectId) return false
    const blocked = await launchGuard(activeProjectId, [railProvider(rail) ?? ''])
    if (!blocked) return false
    notifyError(blocked.message, { detail: blocked.failed.join(' · ') || null, retry })
    return true
  }

  async function handleToggle(railId: string) {
    const rail = rails.find((r) => r.id === railId)
    const railIndex = serverRailIndex(rails, railId)
    if (!rail || railIndex === -1) return

    if (rail.status === 'running') {
      // Stop via rails API
      try {
        await fetch(`${getApiBase()}/rails/${railIndex}/stop`, { method: 'POST' })
        updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, status: 'idle', activeJobId: undefined } : r)))
        toast.info(t('toasts.railStopped', { rail: rail.label }))
      } catch {
        notifyError(t('toasts.stopFailed'), { retry: () => void handleToggle(railId) })
      }
      return
    }

    if (rail.ticketIds.length === 0) return

    // The same launch checks as Launch all (sign-in, disk): a signed-out provider blocks here, with
    // the same words, instead of failing a moment later inside the run.
    if (await launchBlocked(rail, () => void handleToggle(railId))) return

    // Deliver-into-existing-PR: name the exact PR before launching into it.
    if (rail.targetPr) {
      setTargetPrConfirm({ railId })
      return
    }

    await doLaunchRail(railId)
  }

  // "Create initial commit" from a repository_has_no_commits toast: one empty
  // commit in the primary repository, then the user relaunches.
  function initialCommitAction() {
    const projectId = activeProjectId
    return {
      label: t('common:initialCommit.action'),
      onClick: () => {
        if (!projectId) return
        void createInitialCommit(projectId).then((result) => {
          if (result.ok) toast.success(t('common:initialCommit.createdRelaunch'))
          else notifyError(initialCommitErrorMessage(t, result.code))
        })
      },
    }
  }

  // `rail` (a bulk launch) is the rail as it will be once the spec lands on it: React has not
  // committed that assignment yet, so the closure's `rails` would still show it empty.
  async function doLaunchRail(railId: string, opts?: { silent?: boolean; rail?: RailState }): Promise<LaunchOutcome> {
    const silent = opts?.silent ?? false
    const rail = opts?.rail ?? rails.find((r) => r.id === railId)
    const railIndex = serverRailIndex(rails, railId)
    if (!rail || railIndex === -1) return 'failed'
    if (rail.ticketIds.length === 0) return 'skipped'

    // On-review specs are frozen unless they already have a draft/published PR
    // head that this launch can continue.
    if (rail.ticketIds.some((id) => tickets.find((tk) => tk.id === id)?.status === 'on_review' && (!railPrDecisionsHydrated || !ticketHasContinuablePr(id, railPrDecisions, tickets)))) {
      if (!silent) toast.info(t('toasts.onReviewNotLaunchable'))
      return 'skipped'
    }

    // rails-as-loops: every rail launches a Loop. Factory modes resolve to their
    // built-in loop; a custom (loop) rail needs an explicit pick.
    // Spec triage (launch-triage): the same recommendation the rail header
    // preselects (first triaged spec, only when the picker offers it).
    const recommendedLoopId = offeredRecommendation(
      recommendedLoopForTickets(rail.ticketIds.map((id) => ticketMap.get(id))),
      { loopsEnabled: FEATURE_LOOPS_SECTION },
    )
    const launchLoopId = effectiveLoopId(rail.selectedLoopId, rail.mode, rail.ticketIds.some((id) => ticketMap.get(id)?.addenda?.some((a) => a.status === 'open')), recommendedLoopId)
    if (!launchLoopId) {
      if (!silent) notifyError(t('railControls.pickLoop'))
      return 'failed'
    }
    // Hybrid per-role engines: the server resolves every role itself, so the
    // launch carries NO model / effort / profile / provider override from the rail.
    const launchMode = deriveRailMode(launchLoopId)
    const rolesLaunch = isRolesEngine(rail.aiEngine)
    const launchProvider = railProvider(rail)
    const launchLoopModel = rail.loopModel ?? defaultModelForProvider(launchProvider)
    const launchEfforts = reasoningEffortsForProvider(launchProvider, launchLoopModel)
    const launchEffort = rail.reasoningEffort && launchEfforts.includes(rail.reasoningEffort)
      ? rail.reasoningEffort
      : null

    // M24: capture the API base ONCE up front. getApiBase() is a module-level
    // store that flips on project switch; evaluating it on both sides of the
    // await below let a mid-flight switch (e.g. desktop.project_added auto-activation,
    // a minimized-chat restore) send the ticket sync to project A but the launch
    // POST to project B — spawning a --dangerously-skip-permissions pipeline on the
    // wrong repo. Pinning the base keeps both calls on the project the user aimed at.
    const base = getApiBase()

    // Sync ticket assignments to server before launching
    try {
      await fetch(`${base}/rails/${railIndex}/tickets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketIds: rail.ticketIds }),
      })
    } catch {
      if (!silent) notifyError(t('toasts.syncTicketsFailed'), { retry: () => void doLaunchRail(railId, opts) })
      return 'failed'
    }

    // Launch via rails API — server handles job tracking + rail.job_completed events
    try {
      const res = await fetch(`${base}/rails/${railIndex}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: launchMode,
          ...(rail.workspaceSelection ? { workspaceSelection: rail.workspaceSelection } : {}),
          ...(!rolesLaunch && (rail.aiEngine != null || launchMode === 'loop' && (rail.loopModel || launchEffort)) ? { runtimeProviderOverride: { provider: launchProvider, ...(launchMode === 'loop' && rail.loopModel ? { model: rail.loopModel } : {}), ...(launchMode === 'loop' && launchEffort ? { effort: launchEffort } : {}) } } : {}),
          // rail.profileName can be a string (explicit), null (force legacy),
          // or undefined (let server fall back to stored rail profile or defaults).
          ...(!rolesLaunch && rail.profileName !== undefined ? { profileName: rail.profileName } : {}),
          // rail.aiEngine: explicit per-rail engine override; undefined → server
          // falls back to the stored rail engine or the project primary.
          ...(rail.aiEngine != null ? { aiEngine: rail.aiEngine } : {}),
          // Loop model picker — only meaningful for custom loop launches.
          ...(!rolesLaunch && launchMode === 'loop' && rail.loopModel ? { model: rail.loopModel } : {}),
          // rails-as-loops: always send the chosen Loop. The server maps a
          // factory loop → its legacy mode; a custom loop runs the loop engine.
          loopId: launchLoopId,
          ...(!rolesLaunch && launchMode === 'loop' && launchEffort ? { reasoning_effort: launchEffort } : {}),
          // Explicit delivery target (deliver-rail-into-existing-pr): the run
          // continues this open PR's head branch; settle pushes into it.
          ...(rail.targetPr ? { targetPrNumber: rail.targetPr.number } : {}),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: '' }))
        // Launch collision: this rail still has an unresolved PR decision — the
        // user must Create PR / Approve / Discard it before relaunching.
        if (res.status === 409 && data.error === 'pr_decision_pending') {
          if (!silent) toast.info(t('railPr.decisionPendingOnRail', { rail: typeof data.railIndex === 'number' ? data.railIndex + 1 : railIndex + 1 }), { description: t('railPr.decisionPendingAction') })
          return 'pendingDecision'
        }
        // A ticket of this rail is already being worked by an active run
        // (concurrent-launch guard) — treat as skipped, not failed.
        if (res.status === 409 && data.error === 'tickets_in_flight') {
          if (!silent) toast.info(t('toasts.launchTicketsInFlight'))
          return 'skipped'
        }
        // Daily budget exhausted (project or app-wide): nothing spawned.
        const budget = res.status === 409 ? readDailyBudgetRejection(data) : null
        if (budget) {
          if (!silent) {
            notifyError(dailyBudgetExceededMessage(t, budget), {
              detail: dailyBudgetActionMessage(t, budget),
              duration: 10000,
              action: { label: t('common:budget.raiseCap'), onClick: openBudgetPanel },
            })
          }
          return 'budget'
        }
        // Review WIP limit reached: nothing spawned; decide a delivery first.
        const wip = res.status === 409 ? readReviewWipRejection(data) : null
        if (wip) {
          if (!silent) notifyError(reviewWipRejectionMessage(t, wip), { detail: reviewWipActionMessage(t), duration: 10000 })
          return 'reviewLimit'
        }
        // Unborn HEAD in a repository the launch must isolate: nothing spawned.
        if (res.status === 409 && data.error === 'repository_has_no_commits') {
          if (!silent) notifyError(t('toasts.launchRepositoryHasNoCommits'), { duration: 10000, action: initialCommitAction() })
          return 'noCommits'
        }
        // The active Core runs only definitions (Core 7): the loop must be converted.
        if (res.status === 409 && data.error === 'legacy_engine_unavailable') {
          if (!silent) notifyError(t('toasts.launchLegacyEngineUnavailable'), { duration: 10000 })
          return 'failed'
        }
        // Per-rail spec cap: the rail carries more specs than a single launch
        // may take — the user must split them across rails (max 3 per rail).
        if (res.status === 400 && data.error === 'rail_ticket_cap_exceeded') {
          if (!silent) {
            notifyError(t('toasts.launchTicketCap', {
              max: (data as { max?: number }).max ?? 3,
              count: (data as { ticketCount?: number }).ticketCount ?? 0,
            }))
          }
          return 'failed'
        }
        // Explicit-target validation failed server-side (fail-closed — no
        // fallback launch happened). Surface the exact reason; keep the
        // selection so the user can fix or clear it.
        const targetCodes = ['invalid_target_pr', 'target_pr_requires_pr_mode', 'target_pr_not_found', 'target_pr_not_open', 'target_pr_fork', 'target_pr_invalid', 'target_pr_unfetchable']
        if (typeof data.error === 'string' && targetCodes.includes(data.error)) {
          if (!silent) {
            notifyError(t(`targetPr.errors.${data.error}`), {
              detail: (data as { detail?: string }).detail,
              duration: 10000,
            })
          }
          return 'failed'
        }
        if (!silent) notifyError(t('toasts.launchFailed'), { detail: data.error, retry: () => void doLaunchRail(railId, opts) })
        return 'failed'
      }
      // Implement/freestyle return { jobId }; loop mode returns { loopRunIds }.
      // A loop run IS backed by a job (id === loopRunId), so set activeJobId to
      // the first run id → "View Log" → /jobs/:id streams the live session.
      const data = await res.json() as { jobId?: string; loopRunIds?: string[]; isolationUnavailable?: string; isolationUnavailableDetail?: string }
      // Suppressed in silent (batch) mode — a non-git repo would fire one toast
      // per rail; the launch itself still proceeds on the shared cwd.
      if (!silent && data.isolationUnavailable === 'no-git') {
        toast.info(t('toasts.railWorktreesNoGit'))
      } else if (!silent && data.isolationUnavailable === 'no-commits') {
        toast.info(t('toasts.railWorktreesNoCommits'))
      } else if (!silent && data.isolationUnavailable === 'error') {
        // Isolation THREW → the run proceeds on the shared cwd WITHOUT the
        // ask-first PR flow (no delivery row → no implementation card). Must be
        // loud + carry the server's reason, or the missing card is undebuggable.
        toast.warning(t('toasts.railWorktreesError'), {
          description: data.isolationUnavailableDetail,
          duration: 12000,
        })
      }
      const activeJobId = data.jobId ?? data.loopRunIds?.[0]
      // targetPr is a ONE-SHOT designation: consumed by this launch (the
      // delivery row now owns the PR link); the next launch defaults to New PR.
      updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, status: 'running', activeJobId, targetPr: null } : r)))
      if (!silent) {
        toast.success(t('toasts.railLaunched', { rail: rail.label }), {
          description: t('toasts.launchDescription', { mode: rail.mode, count: rail.ticketIds.length }),
        })
      }
      return 'launched'
    } catch {
      if (!silent) notifyError(t('toasts.launchNetworkError'), { retry: () => void doLaunchRail(railId, opts) })
      return 'failed'
    }
  }

  // ── Launch all: confirm → parallel fan-out → one summary toast ─────────────
  function handleLaunchAll() {
    // At the review limit the dialog itself explains why nothing launches.
    if (launchAllPlan.eligible.length === 0 && !launchAllPlan.skipped.some((s) => s.reason === 'reviewLimit')) {
      toast.info(t('toasts.launchAllNoneEligible'))
      return
    }
    setLaunchAllConfirm(true)
  }

  async function runLaunchAll() {
    setLaunchAllConfirm(false)
    const { eligible, skipped } = launchAllPlan
    if (eligible.length === 0) {
      toast.info(t('toasts.launchAllNoneEligible'))
      return
    }
    // Parallel fan-out of the SAME per-rail launch path the Play button uses
    // (ticket sync → POST launch). Safe to run concurrently: each launch
    // isolates its work in per-ticket git worktrees server-side.
    const settled = await Promise.allSettled(
      eligible.map((r) => doLaunchRail(r.id, { silent: true })),
    )
    let launched = 0
    let failed = 0
    let pendingDecision = 0
    let skippedLate = 0
    let overBudget = 0
    let overReviewLimit = 0
    let noCommits = 0
    for (const s of settled) {
      const v: LaunchOutcome = s.status === 'fulfilled' ? s.value : 'failed'
      if (v === 'launched') launched++
      else if (v === 'pendingDecision') pendingDecision++
      else if (v === 'skipped') skippedLate++
      else if (v === 'budget') overBudget++
      else if (v === 'reviewLimit') overReviewLimit++
      else if (v === 'noCommits') noCommits++
      else failed++
    }
    // One compact summary toast: launched count + per-reason skip breakdown.
    const counts = new Map<LaunchAllSkipReason, number>()
    for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
    if (pendingDecision > 0) counts.set('pendingDecision', (counts.get('pendingDecision') ?? 0) + pendingDecision)
    if (overReviewLimit > 0) counts.set('reviewLimit', (counts.get('reviewLimit') ?? 0) + overReviewLimit)
    const reasonKey: Record<LaunchAllSkipReason, string> = {
      running: 'launchAll.skipRunning',
      empty: 'launchAll.skipEmpty',
      pendingDecision: 'launchAll.skipPendingDecision',
      onReview: 'launchAll.skipOnReview',
      reviewLimit: 'launchAll.skipReviewLimit',
    }
    const parts: string[] = []
    for (const [reason, count] of counts) {
      if (count > 0) parts.push(t(reasonKey[reason], { count }))
    }
    if (skippedLate > 0) parts.push(t('launchAll.skipInFlight', { count: skippedLate }))
    if (overBudget > 0) parts.push(t('launchAll.skipBudget', { count: overBudget }))
    if (noCommits > 0) parts.push(t('toasts.launchRepositoryHasNoCommits'))
    if (failed > 0) parts.push(t('launchAll.failedCount', { count: failed }))
    const description = parts.length > 0 ? parts.join(' · ') : undefined
    const action = noCommits > 0 ? { action: initialCommitAction() } : {}
    if (launched > 0) {
      toast.success(t('toasts.launchAllSummary', { count: launched }), description || noCommits > 0 ? { description, ...action } : undefined)
    } else {
      notifyError(t('toasts.launchAllFailed'), { detail: description, ...(noCommits > 0 ? action : { retry: () => void runLaunchAll() }) })
    }
  }

  /** Confirmation of a launch into an existing PR: launches the rail it was asked for. */
  function confirmTargetPrLaunch() {
    const id = targetPrConfirm?.railId
    setTargetPrConfirm(null)
    if (id) void doLaunchRail(id)
  }

  return {
    launchAllPlan,
    handleToggle,
    doLaunchRail,
    handleLaunchAll,
    runLaunchAll,
    launchAllConfirm,
    cancelLaunchAll: () => setLaunchAllConfirm(false),
    targetPrConfirm,
    cancelTargetPrLaunch: () => setTargetPrConfirm(null),
    confirmTargetPrLaunch,
  }
}
