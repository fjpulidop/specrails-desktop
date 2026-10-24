import type { DbInstance } from '../../../db/types'
import { dailyBudgetRejection, dailyBudgetResetsAt, evaluateDailyBudgets, isDailyBudgetExceeded, localDayStartIso, type BudgetSnapshot, type DailyBudgetRejection, type DailyBudgetScope } from '..'
import { createQueueBudgetStorage } from '../adapters/budget-storage'

export interface DailyBudgetGateOptions {
  /** The project's own connection — never another project's. */
  db: DbInstance
  projectId: string
  /** App-wide snapshot; the same function the QueueManager auto-pause reads. */
  desktop?: () => BudgetSnapshot
  now?: () => Date
}

/**
 * Admission gate for cost-incurring launches outside the queue (rail loops,
 * loop runs between AI steps). It reads exactly the budget state the queue
 * enforces and returns the 409 body when a budget is exhausted.
 *
 * Fail-open: a budget that cannot be read never blocks work (mirrors the
 * queue's best-effort enforcement); the failure is logged.
 */
export function createDailyBudgetGate(options: DailyBudgetGateOptions): () => DailyBudgetRejection | null {
  const now = options.now ?? (() => new Date())
  return () => {
    try {
      const storage = createQueueBudgetStorage(options.db)
      const at = now()
      const breach = evaluateDailyBudgets({
        project: () => storage.project(options.projectId, () => localDayStartIso(at)),
        desktop: options.desktop,
      })
      return breach ? dailyBudgetRejection(breach, at) : null
    } catch (error) {
      console.warn('[daily-budget] budget state unavailable; admitting the launch:', error instanceof Error ? error.message : error)
      return null
    }
  }
}

/** What is left of the tightest configured daily budget (read-only; nothing pauses). */
export interface DailyBudgetHeadroom {
  scope: DailyBudgetScope
  budgetUsd: number
  spentUsd: number
  /** Whether the budget is already spent (a launch would be refused). */
  exhausted: boolean
  resetsAt: string
}

/**
 * Read-only view of the same budgets the gate enforces, for surfaces that warn
 * BEFORE a launch (the launch forecast). Picks the scope with the least money
 * left, so one caution covers both budgets. Null when no budget is configured
 * or it cannot be read (fail-open, like the gate).
 */
export function createDailyBudgetHeadroom(options: DailyBudgetGateOptions): () => DailyBudgetHeadroom | null {
  const now = options.now ?? (() => new Date())
  return () => {
    try {
      const storage = createQueueBudgetStorage(options.db)
      const at = now()
      const candidates: { scope: DailyBudgetScope; snapshot: BudgetSnapshot | null }[] = [
        { scope: 'project', snapshot: storage.project(options.projectId, () => localDayStartIso(at)) },
        { scope: 'desktop', snapshot: options.desktop?.() ?? null },
      ]
      let best: DailyBudgetHeadroom | null = null
      for (const { scope, snapshot } of candidates) {
        if (!snapshot || snapshot.budget == null || !(snapshot.budget > 0)) continue
        const left = snapshot.budget - snapshot.totalSpend
        if (best && left >= best.budgetUsd - best.spentUsd) continue
        best = {
          scope,
          budgetUsd: snapshot.budget,
          spentUsd: snapshot.totalSpend,
          exhausted: isDailyBudgetExceeded(snapshot),
          resetsAt: dailyBudgetResetsAt(scope, at),
        }
      }
      return best
    } catch (error) {
      console.warn('[daily-budget] budget state unavailable for the forecast:', error instanceof Error ? error.message : error)
      return null
    }
  }
}
