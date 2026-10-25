import type { DbInstance } from '../../../db/types'
import type { BudgetSnapshot } from '../application/enforce-budget'
import { localDayKey, toCents, type CapPeriod, type DailySpendPoint } from '../domain/spend-caps'

/** `queue_state` keys of the project's caps (the daily one predates caps). */
export const PROJECT_CAP_KEYS = {
  day: 'config.daily_budget_usd',
  week: 'config.weekly_budget_usd',
  month: 'config.monthly_budget_usd',
  run: 'config.run_cap_usd',
} as const
export type ProjectCapKey = keyof typeof PROJECT_CAP_KEYS

/** `desktop_settings` keys of the app-wide caps (the daily one predates caps). */
export const DESKTOP_CAP_KEYS = {
  day: 'desktop_daily_budget_usd',
  week: 'desktop_weekly_budget_usd',
  month: 'desktop_monthly_budget_usd',
  run: 'desktop_run_cap_usd',
} as const

export interface CapConfig { day: number | null; week: number | null; month: number | null; run: number | null }

const positive = (raw: string | undefined): number | null => {
  if (raw === undefined) return null
  const value = parseFloat(raw)
  return value > 0 ? value : null
}

/** The project's configured caps; unset, zero or unparseable ⇒ null (no cap). */
export function readProjectCaps(db: DbInstance): CapConfig {
  const read = (key: ProjectCapKey): number | null =>
    positive((db.prepare('SELECT value FROM queue_state WHERE key = ?').get(PROJECT_CAP_KEYS[key]) as { value: string } | undefined)?.value)
  return { day: read('day'), week: read('week'), month: read('month'), run: read('run') }
}

/** The app-wide caps from a `desktop_settings` getter (`getDesktopSetting` bound to the desktop DB). */
export function readDesktopCaps(get: (key: string) => string | null | undefined): CapConfig {
  const read = (key: string): number | null => positive(get(key) ?? undefined)
  return { day: read(DESKTOP_CAP_KEYS.day), week: read(DESKTOP_CAP_KEYS.week), month: read(DESKTOP_CAP_KEYS.month), run: read(DESKTOP_CAP_KEYS.run) }
}

/** Set (number > 0) or clear (null) one project cap. */
export function writeProjectCap(db: DbInstance, key: ProjectCapKey, value: number | null): void {
  if (value === null) db.prepare('DELETE FROM queue_state WHERE key = ?').run(PROJECT_CAP_KEYS[key])
  else db.prepare('INSERT OR REPLACE INTO queue_state (key, value) VALUES (?, ?)').run(PROJECT_CAP_KEYS[key], String(value))
}

/**
 * Provider-reported spend of one project since `sinceIso` (rows without a cost
 * are NOT zero — they are skipped, like the daily budget has always done).
 */
export function projectSpendSince(db: DbInstance, projectId: string, sinceIso: string): number {
  return (db.prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM ai_invocations
         WHERE project_id = ? AND total_cost_usd IS NOT NULL AND started_at >= ?`).get(projectId, sinceIso) as { total: number }).total
}

/** Spend of one project grouped by LOCAL calendar day (cents), for the projection. */
export function projectDailySpend(db: DbInstance, projectId: string, sinceIso: string): DailySpendPoint[] {
  const rows = db.prepare(`SELECT started_at, total_cost_usd FROM ai_invocations
         WHERE project_id = ? AND total_cost_usd IS NOT NULL AND started_at >= ?`).all(projectId, sinceIso) as Array<{ started_at: string; total_cost_usd: number }>
  const byDay = new Map<string, number>()
  for (const row of rows) {
    const at = new Date(row.started_at)
    if (Number.isNaN(at.getTime())) continue
    const key = localDayKey(at)
    byDay.set(key, (byDay.get(key) ?? 0) + row.total_cost_usd)
  }
  // Round once per day: rounding every row would zero out many small calls.
  return [...byDay].map(([day, usd]) => ({ day, cents: toCents(usd) }))
}

export type { CapPeriod }

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
    /** A project's weekly/monthly cap with its spend since the period start. */
    projectPeriod(projectId: string | null, period: Exclude<CapPeriod, 'day'>, periodStart: () => string): BudgetSnapshot | null {
      if (!projectId) return null
      const budget = readProjectCaps(db)[period]
      if (budget === null) return null
      return { budget, totalSpend: projectSpendSince(db, projectId, periodStart()) }
    },
    pause() {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
    },
  }
}
