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
 * The app-level agent ledger (desktop.sqlite `agent_invocations`: Mission /
 * Agent-Chat and Intent turns). Disjoint from every project's `ai_invocations`.
 * `projectId` scopes it to the turns pinned to one project; omitted, it is every
 * turn (Home, Blueprint and Builder chats included) — the app-wide caps' scope.
 */
export interface AppLedgerSource {
  db: DbInstance
  projectId?: string
}

/** One agent-ledger row as the caps and the Budget panel read it. */
export interface AppLedgerSpendRow {
  started_at: string
  provider: string
  total_cost_usd: number | null
  total_cost_usd_estimated: number
  num_turns: number | null
}

/** Agent-ledger rows since `sinceIso`. Fail-open: an unreadable ledger adds nothing. */
export function appLedgerRowsSince(source: AppLedgerSource | undefined, sinceIso: string): AppLedgerSpendRow[] {
  if (!source?.db || typeof source.db.prepare !== 'function') return []
  try {
    const scoped = source.projectId !== undefined
    return source.db.prepare(`SELECT started_at, COALESCE(provider, 'claude') AS provider, total_cost_usd,
           total_cost_usd_estimated, num_turns
         FROM agent_invocations WHERE started_at >= ?${scoped ? ' AND project_id = ?' : ''}`)
      .all(...(scoped ? [sinceIso, source.projectId] : [sinceIso])) as AppLedgerSpendRow[]
  } catch (error) {
    console.warn('[budget] agent ledger unavailable; caps count the project ledger only:', error instanceof Error ? error.message : error)
    return []
  }
}

/** Recorded agent-ledger spend since `sinceIso` (rows without a cost are skipped). */
export function appLedgerSpendSince(source: AppLedgerSource | undefined, sinceIso: string): number {
  return appLedgerRowsSince(source, sinceIso).reduce((sum, row) => sum + (row.total_cost_usd ?? 0), 0)
}

/**
 * Provider-reported spend of one project since `sinceIso` (rows without a cost
 * are NOT zero — they are skipped, like the daily budget has always done),
 * plus the agent turns pinned to it when the app ledger (`appLedgerDb`) is given.
 */
export function projectSpendSince(db: DbInstance, projectId: string, sinceIso: string, appLedgerDb?: DbInstance): number {
  const own = (db.prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM ai_invocations
         WHERE project_id = ? AND total_cost_usd IS NOT NULL AND started_at >= ?`).get(projectId, sinceIso) as { total: number }).total
  return own + appLedgerSpendSince(pinnedAppLedger(appLedgerDb, projectId), sinceIso)
}

/** The app-ledger turns pinned to one project. */
export function pinnedAppLedger(appLedgerDb: DbInstance | undefined, projectId: string): AppLedgerSource | undefined {
  return appLedgerDb ? { db: appLedgerDb, projectId } : undefined
}

/**
 * App-wide spend since `sinceIso`: every project's ledger plus EVERY agent turn
 * (pinned, Home, Blueprint and Builder chats) — the scope of the app-wide caps.
 * An unreadable project adds nothing (fail-open).
 */
export function appWideSpendSince(projects: ReadonlyArray<{ db: DbInstance; projectId: string }>, appLedgerDb: DbInstance | undefined, sinceIso: string): number {
  let total = 0
  for (const { db, projectId } of projects) {
    try { total += projectSpendSince(db, projectId, sinceIso) } catch { /* fail-open */ }
  }
  return total + appLedgerSpendSince(appLedgerDb ? { db: appLedgerDb } : undefined, sinceIso)
}

/** Spend of one project grouped by LOCAL calendar day (cents), for the projection. */
export function projectDailySpend(db: DbInstance, projectId: string, sinceIso: string, appLedgerDb?: DbInstance): DailySpendPoint[] {
  const rows = db.prepare(`SELECT started_at, total_cost_usd FROM ai_invocations
         WHERE project_id = ? AND total_cost_usd IS NOT NULL AND started_at >= ?`).all(projectId, sinceIso) as Array<{ started_at: string; total_cost_usd: number }>
  return dailySpendPoints([...rows, ...appLedgerRowsSince(pinnedAppLedger(appLedgerDb, projectId), sinceIso)])
}

/** Group costed rows by LOCAL calendar day (cents). */
export function dailySpendPoints(rows: ReadonlyArray<{ started_at: string; total_cost_usd: number | null }>): DailySpendPoint[] {
  const byDay = new Map<string, number>()
  for (const row of rows) {
    if (row.total_cost_usd == null) continue
    const at = new Date(row.started_at)
    if (Number.isNaN(at.getTime())) continue
    const key = localDayKey(at)
    byDay.set(key, (byDay.get(key) ?? 0) + row.total_cost_usd)
  }
  // Round once per day: rounding every row would zero out many small calls.
  return [...byDay].map(([day, usd]) => ({ day, cents: toCents(usd) }))
}

export type { CapPeriod }

/**
 * The project's budget state. `appLedgerDb` (desktop.sqlite) makes the agent
 * turns pinned to the project — mission and Intent spend — count against its caps.
 */
export function createQueueBudgetStorage(db: DbInstance, appLedgerDb?: DbInstance) {
  return {
    project(projectId: string | null, dayStart: () => string): BudgetSnapshot | null {
      const row = db.prepare(`SELECT value FROM queue_state WHERE key = 'config.daily_budget_usd'`).get() as { value: string } | undefined
      if (!row || !projectId) return null
      const budget = parseFloat(row.value)
      if (!(budget > 0)) return null
      return { budget, totalSpend: projectSpendSince(db, projectId, dayStart(), appLedgerDb) }
    },
    /** A project's weekly/monthly cap with its spend since the period start. */
    projectPeriod(projectId: string | null, period: Exclude<CapPeriod, 'day'>, periodStart: () => string): BudgetSnapshot | null {
      if (!projectId) return null
      const budget = readProjectCaps(db)[period]
      if (budget === null) return null
      return { budget, totalSpend: projectSpendSince(db, projectId, periodStart(), appLedgerDb) }
    },
    pause() {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
    },
  }
}
