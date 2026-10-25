import type { DbInstance } from '../../../db/types'
import { dailyBudgetResetsAt, isDailyBudgetExceeded, localDayStartIso, type DailyBudgetRejection, type DailyBudgetScope } from '../domain/daily-budget'
import type { BudgetSnapshot } from '../application/enforce-budget'
import { capRejection, firstExhaustedCap, isCapExceeded, periodResetsAtIso, periodStartIso, tightestCap, type CapPeriod, type CapStatus } from '../domain/spend-caps'
import { createQueueBudgetStorage } from '../adapters/budget-storage'

export interface DailyBudgetGateOptions {
  /** The project's own connection — never another project's. */
  db: DbInstance
  projectId: string
  /** App-wide snapshot; the same function the QueueManager auto-pause reads. */
  desktop?: () => BudgetSnapshot
  /** App-wide weekly/monthly cap with its spend (all projects), for the period containing `at`. */
  desktopPeriod?: (period: Exclude<CapPeriod, 'day'>, at: Date) => BudgetSnapshot
  now?: () => Date
}

/**
 * Every configured cap with its spend, project scope first (day, week, month)
 * then app-wide. THE single read the admission gate, the mid-run pause, the
 * launch forecast, the Budget panel and the inbox all share, so no surface can
 * disagree about which cap is reached.
 */
export function readCapStatuses(options: DailyBudgetGateOptions, at: Date): CapStatus[] {
  const storage = createQueueBudgetStorage(options.db)
  const out: CapStatus[] = []
  const push = (scope: DailyBudgetScope, period: CapPeriod, snapshot: BudgetSnapshot | null): void => {
    if (!snapshot || snapshot.budget == null || !(snapshot.budget > 0)) return
    out.push({
      scope,
      period,
      budgetUsd: snapshot.budget,
      spentUsd: snapshot.totalSpend,
      exhausted: period === 'day' ? isDailyBudgetExceeded(snapshot) : isCapExceeded(snapshot.budget, snapshot.totalSpend),
      resetsAt: period === 'day' ? dailyBudgetResetsAt(scope, at) : periodResetsAtIso(period, at),
    })
  }
  push('project', 'day', storage.project(options.projectId, () => localDayStartIso(at)))
  push('project', 'week', storage.projectPeriod(options.projectId, 'week', () => periodStartIso('week', at)))
  push('project', 'month', storage.projectPeriod(options.projectId, 'month', () => periodStartIso('month', at)))
  push('desktop', 'day', options.desktop?.() ?? null)
  push('desktop', 'week', options.desktopPeriod?.('week', at) ?? null)
  push('desktop', 'month', options.desktopPeriod?.('month', at) ?? null)
  return out
}

/**
 * Admission gate for cost-incurring launches outside the queue (rail loops,
 * loop runs between AI steps). It reads exactly the budget state the queue
 * enforces and returns the 409 body when a cap is exhausted.
 *
 * Fail-open: a budget that cannot be read never blocks work (mirrors the
 * queue's best-effort enforcement); the failure is logged.
 */
export function createDailyBudgetGate(options: DailyBudgetGateOptions): () => DailyBudgetRejection | null {
  const now = options.now ?? (() => new Date())
  return () => {
    try {
      const breach = firstExhaustedCap(readCapStatuses(options, now()))
      return breach ? capRejection(breach) : null
    } catch (error) {
      console.warn('[daily-budget] budget state unavailable; admitting the launch:', error instanceof Error ? error.message : error)
      return null
    }
  }
}

/** What is left of the tightest configured cap (read-only; nothing pauses). */
export interface DailyBudgetHeadroom {
  scope: DailyBudgetScope
  /** Which cap this is. Absent = the daily budget. */
  period?: CapPeriod
  budgetUsd: number
  spentUsd: number
  /** Whether the budget is already spent (a launch would be refused). */
  exhausted: boolean
  resetsAt: string
}

/**
 * Read-only view of the same caps the gate enforces, for surfaces that warn
 * BEFORE a launch (the launch forecast). Picks the cap with the least money
 * left, so one caution covers all of them. Null when no cap is configured or
 * it cannot be read (fail-open, like the gate).
 */
export function createDailyBudgetHeadroom(options: DailyBudgetGateOptions): () => DailyBudgetHeadroom | null {
  const now = options.now ?? (() => new Date())
  return () => {
    try {
      const best = tightestCap(readCapStatuses(options, now()))
      if (!best) return null
      return {
        scope: best.scope,
        ...(best.period === 'day' ? {} : { period: best.period }),
        budgetUsd: best.budgetUsd,
        spentUsd: best.spentUsd,
        exhausted: best.exhausted,
        resetsAt: best.resetsAt,
      }
    } catch (error) {
      console.warn('[daily-budget] budget state unavailable for the forecast:', error instanceof Error ? error.message : error)
      return null
    }
  }
}
