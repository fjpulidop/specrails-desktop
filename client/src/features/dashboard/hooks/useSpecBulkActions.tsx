import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LaunchAllDialog } from '../../rails/components/LaunchAllDialog'
import type { RailState } from '../../rails/components/RailsBoard'
import { useLaunchBudgetGuard } from '../../../hooks/useLaunchBudgetGuard'
import type { ForecastQuery } from '../../../lib/launch-forecast'
import { jiraApi } from '../../integrations/lib/jira-api'
import type { BulkResult } from '../../specs/hooks/useTickets'
import type { SpecBulkHandlers } from '../../specs/lib/bulk-actions'
import { planBulkLaunch, type BulkLaunchGates, type BulkLaunchPlan } from '../../specs/lib/bulk-launch'
import { reportBulk } from '../../specs/lib/bulk-report'
import { moveJiraSpecToStatus } from '../../specs/lib/ticket-status-moves'
import type { LocalTicket, TicketPriority } from '../../../types'

/** Terminal outcome of one rail launch (mirrors the dashboard's per-rail launch). */
export type BulkLaunchOutcome = 'launched' | 'failed' | 'pendingDecision' | 'skipped' | 'budget' | 'reviewLimit' | 'noCommits'

interface Deps {
  rails: RailState[]
  jiraConnected: boolean
  allLabels: readonly string[]
  /** Bulk mutations of the ticket store (they run the per-spec handlers and push ONE grouped Undo). */
  store: {
    bulkDelete: (ids: readonly number[]) => Promise<BulkResult>
    bulkUpdateStatus: (ids: readonly number[], status: LocalTicket['status']) => Promise<BulkResult>
    bulkUpdatePriority: (ids: readonly number[], priority: LocalTicket['priority']) => Promise<BulkResult>
    bulkUpdateLabels: (ids: readonly number[], change: { add?: readonly string[]; remove?: readonly string[] }) => Promise<BulkResult>
  }
  /** The board's own "Move to rail" (drag / popover); returns whether the spec moved. */
  moveToRail: (ticketId: number, railId: string, opts?: { quiet?: boolean }) => boolean
  /** The rail's own launch path (ticket sync, POST launch, admission), run silently with the rail as it will be. */
  launchRail: (railId: string, rail: RailState) => Promise<BulkLaunchOutcome>
  gates: BulkLaunchGates
  /** Forecast query of a rail, for the budget guard (null when the rail has none). */
  forecastQueryOf: (rail: RailState) => ForecastQuery | null
}

/**
 * Bulk actions of the specs board for the dashboard. Every member reuses a
 * handler the single-spec UI already has — the ticket store's status / label /
 * priority / delete (each spec through the same function, one grouped Undo),
 * the Jira "Move to" outbox call, the board's Move to rail — and "Launch all"
 * starts one rail per spec through LaunchAllDialog, the budget guard and the
 * rail's normal launch (spawn reservation and admission stay server-side).
 */
export function useSpecBulkActions(deps: Deps): { handlers: SpecBulkHandlers; dialogs: ReactNode } {
  const { t } = useTranslation('specs')
  const { t: tDashboard } = useTranslation('dashboard')
  const { t: tJira } = useTranslation('jira')
  const { rails, jiraConnected, allLabels, store, moveToRail, launchRail, gates, forecastQueryOf } = deps
  const [pending, setPending] = useState<BulkLaunchPlan | null>(null)

  const firstRail = pending ? rails.find((r) => r.id === pending.assignments[0]?.railId) : undefined
  const guard = useLaunchBudgetGuard(firstRail ? forecastQueryOf(firstRail) : null)

  const onStatus = useCallback<SpecBulkHandlers['onStatus']>(async (ids, target) => {
    if (ids.length === 0) return
    if (target.kind === 'local') {
      const r = await store.bulkUpdateStatus(ids, target.status)
      reportBulk(t, 'moved', { ok: r.ok.length, failed: r.failed.length, undoable: r.undoable })
      return
    }
    // Jira-backed specs move through the board's real workflow: each one queues an
    // outbox transition (the same call as the spec's "Move to"); there is nothing to undo locally.
    let ok = 0
    let failed = 0
    for (const id of ids) {
      if (await moveJiraSpecToStatus(id, target.status, tJira, { quiet: true })) ok += 1
      else failed += 1
    }
    reportBulk(t, 'moved', { ok, failed })
  }, [store, t, tJira])

  const onLabel = useCallback<SpecBulkHandlers['onLabel']>(async (ids, label, mode) => {
    const r = await store.bulkUpdateLabels(ids, mode === 'add' ? { add: [label] } : { remove: [label] })
    reportBulk(t, 'labeled', { ok: r.ok.length, failed: r.failed.length, undoable: r.undoable })
  }, [store, t])

  const onPriority = useCallback(async (ids: number[], priority: TicketPriority) => {
    const r = await store.bulkUpdatePriority(ids, priority)
    reportBulk(t, 'prioritized', { ok: r.ok.length, failed: r.failed.length, undoable: r.undoable })
  }, [store, t])

  const onDelete = useCallback(async (ids: number[]) => {
    const r = await store.bulkDelete(ids)
    reportBulk(t, 'deleted', { ok: r.ok.length, failed: r.failed.length, undoable: r.undoable })
  }, [store, t])

  const onMoveToRail = useCallback((ids: number[], railId: string) => {
    let ok = 0
    let failed = 0
    for (const id of ids) {
      if (moveToRail(id, railId, { quiet: true })) ok += 1
      else failed += 1
    }
    reportBulk(t, 'railed', { ok, failed })
  }, [moveToRail, t])

  const onLaunch = useCallback((ids: number[]) => {
    const plan = planBulkLaunch(ids, rails, gates)
    if (plan.assignments.length === 0) {
      toast.info(t('bulk.launch.none'), { description: skipSummary(plan, t) })
      return
    }
    setPending(plan)
  }, [rails, gates, t])

  const runLaunch = useCallback(async (plan: BulkLaunchPlan) => {
    setPending(null)
    const placed = plan.assignments.filter((a) => moveToRail(a.ticketId, a.railId, { quiet: true }))
    const settled = await Promise.allSettled(placed.map((a) => {
      const rail = rails.find((r) => r.id === a.railId)
      return rail ? launchRail(a.railId, { ...rail, ticketIds: [a.ticketId] }) : Promise.resolve<BulkLaunchOutcome>('failed')
    }))
    const tally = { launched: 0, failed: placed.length === plan.assignments.length ? 0 : plan.assignments.length - placed.length, budget: 0, pendingDecision: 0, skipped: 0, reviewLimit: 0, noCommits: 0 }
    for (const s of settled) {
      const v: BulkLaunchOutcome = s.status === 'fulfilled' ? s.value : 'failed'
      if (v === 'launched') tally.launched += 1
      else if (v === 'budget') tally.budget += 1
      else if (v === 'pendingDecision') tally.pendingDecision += 1
      else if (v === 'skipped') tally.skipped += 1
      else if (v === 'reviewLimit') tally.reviewLimit += 1
      else if (v === 'noCommits') tally.noCommits += 1
      else tally.failed += 1
    }
    const parts: string[] = []
    const skip = skipSummary(plan, t)
    if (skip) parts.push(skip)
    if (tally.pendingDecision > 0) parts.push(tDashboard('launchAll.skipPendingDecision', { count: tally.pendingDecision }))
    if (tally.reviewLimit > 0) parts.push(tDashboard('launchAll.skipReviewLimit', { count: tally.reviewLimit }))
    if (tally.skipped > 0) parts.push(tDashboard('launchAll.skipInFlight', { count: tally.skipped }))
    if (tally.budget > 0) parts.push(tDashboard('launchAll.skipBudget', { count: tally.budget }))
    if (tally.noCommits > 0) parts.push(tDashboard('toasts.launchRepositoryHasNoCommits'))
    if (tally.failed > 0) parts.push(tDashboard('launchAll.failedCount', { count: tally.failed }))
    const description = parts.length > 0 ? parts.join(' · ') : undefined
    if (tally.launched > 0) toast.success(tDashboard('toasts.launchAllSummary', { count: tally.launched }), description ? { description } : undefined)
    else toast.error(tDashboard('toasts.launchAllFailed'), description ? { description } : undefined)
  }, [moveToRail, rails, launchRail, t, tDashboard])

  const handlers = useMemo<SpecBulkHandlers>(() => ({
    jiraConnected,
    loadJiraStatuses: async () => (await jiraApi.listStatuses()).statuses.map((s) => s.name),
    allLabels,
    onStatus,
    onLabel,
    onPriority,
    onMoveToRail,
    onLaunch,
    onDelete,
  }), [jiraConnected, allLabels, onStatus, onLabel, onPriority, onMoveToRail, onLaunch, onDelete])

  const dialogs = (
    <>
      <LaunchAllDialog
        open={pending !== null}
        railCount={pending?.assignments.length ?? 0}
        specCount={pending?.assignments.length ?? 0}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const plan = pending
          if (plan) guard.guard(() => { void runLaunch(plan) })
        }}
      />
      {guard.dialog}
    </>
  )

  return { handlers, dialogs }
}

/** "2 can't launch now · 1 has no free rail" (empty when nothing was skipped). */
function skipSummary(plan: BulkLaunchPlan, t: (key: string, options?: Record<string, unknown>) => string): string | undefined {
  const count = (reason: BulkLaunchPlan['skipped'][number]['reason']) => plan.skipped.filter((s) => s.reason === reason).length
  const parts: string[] = []
  if (count('blocked') > 0) parts.push(t('bulk.launch.skipBlocked', { count: count('blocked') }))
  if (count('noRail') > 0) parts.push(t('bulk.launch.skipNoRail', { count: count('noRail') }))
  if (count('reviewLimit') > 0) parts.push(t('bulk.launch.skipReviewLimit', { count: count('reviewLimit') }))
  return parts.length > 0 ? parts.join(' · ') : undefined
}
