// Spend enforcement on QueueManager terminal paths: the daily/weekly/monthly
// cap pause (MED-5) and the per-job cost alerts. Both are best-effort and never
// throw into a child 'close'/settle listener. The queue's pause flag stays
// owned by QueueManager and is reached only through the host.
import type { WsMessage } from '../../../types'
import type { DbInstance } from '../../../db'
import { createQueueBudgetStorage } from '../adapters/budget-storage'
import { enforceDailyBudgets, localDayStartIso, type CapStatus } from '..'

export interface QueueBudgetHost {
  db: DbInstance | null
  appLedgerDb: DbInstance | null
  projectId: string | null
  getDesktopDailyBudget: (() => { budget: number | null; totalSpend: number }) | null
  getPeriodCapBreaches: (() => CapStatus[]) | null
  isPaused(): boolean
  /** Sets the in-memory pause flag (durable pause is written by the storage). */
  markPaused(): void
  broadcast(msg: WsMessage): void
  onBudgetExceeded: ((event: string, data: Record<string, unknown>) => void) | null
}

/**
 * Local calendar-day start, expressed as a UTC-ISO instant so it compares
 * correctly against the UTC-ISO `started_at` strings (which sort
 * lexicographically). Fixes the UTC `date('now')` boundary that bucketed spend
 * near local midnight on the wrong day (MED-5). Overridable in tests via the
 * injected clock is unnecessary — it reads the real local day.
 */
function localDayStart(): string {
  return localDayStartIso(new Date())
}

/**
 * Evaluate the per-project and app-level daily budgets and pause the queue when
 * exceeded. Called on every terminal job exit (MED-5). Best-effort: never
 * throws (the DB may have been closed mid-job).
 */
export function enforceQueueBudgets(host: QueueBudgetHost): void {
  const db = host.db
  if (!db) return
  try {
    const storage = createQueueBudgetStorage(db, host.appLedgerDb ?? undefined)
    enforceDailyBudgets({
      project: () => storage.project(host.projectId, () => localDayStart()),
      desktop: host.getDesktopDailyBudget ? () => host.getDesktopDailyBudget!() : undefined,
      exceeded: (scope, { budget, totalSpend }) => {
        const wasPaused = host.isPaused()
        host.markPaused()
        if (!wasPaused) storage.pause()
        if (scope === 'project') {
          host.broadcast({ type: 'daily_budget_exceeded', projectId: '', dailySpend: totalSpend, budget, queuePaused: true })
          try {
            host.onBudgetExceeded?.('daily_budget_exceeded', { dailySpend: totalSpend, budget, queuePaused: true })
          } catch { /* webhook delivery is best-effort */ }
        } else {
          host.broadcast({ type: 'desktop_daily_budget_exceeded', projectId: '', desktopDailySpend: totalSpend, desktopBudget: budget, queuePaused: true })
          try {
            host.onBudgetExceeded?.('desktop_daily_budget_exceeded', { desktopDailySpend: totalSpend, desktopBudget: budget, queuePaused: true })
          } catch { /* webhook delivery is best-effort */ }
        }
      },
    })
    // Weekly/monthly caps: same effect as the daily budget (pause + event),
    // reported with the period so a webhook/UI can say which cap was reached.
    for (const cap of host.getPeriodCapBreaches?.() ?? []) {
      if (!cap.exhausted || cap.period === 'day') continue
      const wasPaused = host.isPaused()
      host.markPaused()
      if (!wasPaused) storage.pause()
      if (cap.scope === 'project') {
        host.broadcast({ type: 'daily_budget_exceeded', projectId: '', dailySpend: cap.spentUsd, budget: cap.budgetUsd, queuePaused: true, period: cap.period })
        try { host.onBudgetExceeded?.('daily_budget_exceeded', { dailySpend: cap.spentUsd, budget: cap.budgetUsd, queuePaused: true, period: cap.period }) } catch { /* webhook delivery is best-effort */ }
      } else {
        host.broadcast({ type: 'desktop_daily_budget_exceeded', projectId: '', desktopDailySpend: cap.spentUsd, desktopBudget: cap.budgetUsd, queuePaused: true, period: cap.period })
        try { host.onBudgetExceeded?.('desktop_daily_budget_exceeded', { desktopDailySpend: cap.spentUsd, desktopBudget: cap.budgetUsd, queuePaused: true, period: cap.period }) } catch { /* webhook delivery is best-effort */ }
      }
    }
  } catch (err) {
    console.error('[queue-manager] daily-budget enforcement failed (db unavailable?):', err)
  }
}

/**
 * Per-job cost alerts (app-level threshold, then per-project threshold),
 * shared by the one-shot exit path and the interactive settle path. The
 * prepared statement touches the DB, which may have been closed mid-job;
 * guarded so a throw never escapes a child 'close'/settle listener.
 */
export function emitJobCostAlerts(
  db: DbInstance | null,
  getCostAlertThreshold: (() => number | null) | null,
  broadcast: (msg: WsMessage) => void,
  jobId: string,
  jobCost: number,
): void {
  if (!db) return
  try {
    const desktopThreshold = getCostAlertThreshold?.() ?? null
    if (desktopThreshold != null && jobCost >= desktopThreshold) {
      broadcast({ type: 'cost_alert', projectId: '', jobId, cost: jobCost, threshold: desktopThreshold })
    }

    // Per-project job cost threshold (alerts independently of app threshold)
    const projectThresholdRow = db.prepare(
      `SELECT value FROM queue_state WHERE key = 'config.job_cost_threshold_usd'`
    ).get() as { value: string } | undefined
    if (projectThresholdRow) {
      const projectThreshold = parseFloat(projectThresholdRow.value)
      if (projectThreshold > 0 && jobCost >= projectThreshold) {
        broadcast({ type: 'cost_alert', projectId: '', jobId, cost: jobCost, threshold: projectThreshold })
      }
    }
  } catch (err) {
    console.error('[queue-manager] cost-alert bookkeeping failed (db unavailable?):', err)
  }
}
