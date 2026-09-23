import type { DbInstance } from '../../../db/types'
import type { BudgetSnapshot } from '../application/enforce-budget'

export function createQueueBudgetStorage(db: DbInstance) {
  return {
    project(projectId: string | null, dayStart: () => string): BudgetSnapshot | null {
      const row = db.prepare(`SELECT value FROM queue_state WHERE key = 'config.daily_budget_usd'`).get() as { value: string } | undefined
      if (!row || !projectId) return null
      const budget = parseFloat(row.value)
      if (!(budget > 0)) return null
      const spend = db.prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM ai_invocations
             WHERE project_id = ? AND total_cost_usd IS NOT NULL AND started_at >= ?`).get(projectId, dayStart()) as { total: number }
      return { budget, totalSpend: spend.total }
    },
    pause() {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
    },
  }
}
