import type { DbInstance } from '../../../db/types'
import { dailyBudgetRejection, evaluateDailyBudgets, localDayStartIso, type BudgetSnapshot, type DailyBudgetRejection } from '..'
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
