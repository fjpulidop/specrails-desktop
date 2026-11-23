/**
 * Read model behind the Analytics Budget panel (CD5): spend per period with the
 * provider split (so a subscription provider can show turns instead of dollars),
 * the month-end projection and the caps' state. Read-only; the admission gate,
 * the mid-run pause and the inbox read the same caps through `readCapStatuses`.
 *
 * Honest-metrics rules: spend is the recorded `total_cost_usd` (the same sum the
 * gate enforces), its estimated part is reported apart, and the projection is an
 * estimate that is never added to, or shown as, a billed figure.
 */
import type { DbInstance } from '../../../db/types'
import { appLedgerRowsSince, dailySpendPoints, projectDailySpend, type AppLedgerSource } from '../adapters/budget-storage'
import {
  CAP_PERIODS, TRAILING_DAYS, fromCents, periodEnd, periodStart, projectMonthEnd, toCents,
  type CapPeriod, type MonthProjection,
} from '../domain/spend-caps'

export interface SpendSource { db: DbInstance; projectId: string }

export interface ProviderSpend {
  provider: string
  usd: number
  /** The part of `usd` priced from the local rate card rather than reported by the provider. */
  estimatedUsd: number
  invocations: number
  /** Provider-reported turns (a plan provider's meaningful unit instead of dollars). */
  turns: number
}

export interface PeriodSpend {
  startsAt: string
  resetsAt: string
  usd: number
  estimatedUsd: number
  byProvider: ProviderSpend[]
}

export interface ProjectionView {
  /** Always an estimate; never mixed with billed spend. */
  estimate: true
  trailingDays: number
  avgDailyUsd: number
  monthToDateUsd: number
  remainingDays: number
  projectedUsd: number
}

export interface SpendOverview {
  generatedAt: string
  spend: Record<CapPeriod, PeriodSpend>
  projection: ProjectionView | null
}

export function toProjectionView(projection: MonthProjection | null): ProjectionView | null {
  if (!projection) return null
  return {
    estimate: true,
    trailingDays: projection.trailingDays,
    avgDailyUsd: fromCents(projection.avgDailyCents),
    monthToDateUsd: fromCents(projection.monthToDateCents),
    remainingDays: projection.remainingDays,
    projectedUsd: fromCents(projection.projectedCents),
  }
}

function periodSpend(sources: readonly SpendSource[], period: CapPeriod, at: Date, appLedger?: AppLedgerSource): PeriodSpend {
  const since = periodStart(period, at).toISOString()
  const byProvider = new Map<string, ProviderSpend>()
  // Agent turns (missions, Intent) count like any project row, per provider.
  for (const row of appLedgerRowsSince(appLedger, since)) {
    const entry = byProvider.get(row.provider) ?? { provider: row.provider, usd: 0, estimatedUsd: 0, invocations: 0, turns: 0 }
    entry.usd += row.total_cost_usd ?? 0
    if (row.total_cost_usd_estimated === 1) entry.estimatedUsd += row.total_cost_usd ?? 0
    entry.invocations += 1
    entry.turns += row.num_turns ?? 0
    byProvider.set(row.provider, entry)
  }
  for (const { db, projectId } of sources) {
    let rows: Array<{ provider: string; usd: number; est: number; n: number; turns: number }>
    try {
      rows = db.prepare(`SELECT COALESCE(provider, 'claude') AS provider,
          COALESCE(SUM(total_cost_usd), 0) AS usd,
          COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd END), 0) AS est,
          COUNT(*) AS n,
          COALESCE(SUM(num_turns), 0) AS turns
        FROM ai_invocations WHERE project_id = ? AND started_at >= ? GROUP BY COALESCE(provider, 'claude')`).all(projectId, since) as typeof rows
    } catch { continue } // an unreadable project adds nothing (fail-open)
    for (const row of rows) {
      const entry = byProvider.get(row.provider) ?? { provider: row.provider, usd: 0, estimatedUsd: 0, invocations: 0, turns: 0 }
      entry.usd += row.usd; entry.estimatedUsd += row.est; entry.invocations += row.n; entry.turns += row.turns
      byProvider.set(row.provider, entry)
    }
  }
  const providers = [...byProvider.values()].sort((a, b) => b.usd - a.usd || a.provider.localeCompare(b.provider))
  return {
    startsAt: since,
    resetsAt: periodEnd(period, at).toISOString(),
    usd: fromCents(providers.reduce((sum, p) => sum + toCents(p.usd), 0)),
    estimatedUsd: fromCents(providers.reduce((sum, p) => sum + toCents(p.estimatedUsd), 0)),
    byProvider: providers,
  }
}

/** Month-end projection for a set of projects: the trailing burn of all of them combined. */
export function projectSpend(sources: readonly SpendSource[], at: Date, monthToDateCents: number, appLedger?: AppLedgerSource): MonthProjection | null {
  const since = new Date(at.getFullYear(), at.getMonth(), at.getDate() - TRAILING_DAYS).toISOString()
  const byDay = new Map<string, number>()
  const add = (points: ReturnType<typeof dailySpendPoints>): void => { for (const point of points) byDay.set(point.day, (byDay.get(point.day) ?? 0) + point.cents) }
  for (const { db, projectId } of sources) {
    try { add(projectDailySpend(db, projectId, since)) } catch { /* skipped */ }
  }
  add(dailySpendPoints(appLedgerRowsSince(appLedger, since)))
  return projectMonthEnd([...byDay].map(([day, cents]) => ({ day, cents })), at, monthToDateCents)
}

/**
 * `appLedger` adds the app-level agent turns (missions, Intent) in the caller's
 * scope: the turns pinned to the project for a project overview, every turn
 * for the app-wide one — the same scope the caps enforce.
 */
export function readSpendOverview(sources: readonly SpendSource[], at: Date = new Date(), appLedger?: AppLedgerSource): SpendOverview {
  const spend = {} as Record<CapPeriod, PeriodSpend>
  for (const period of CAP_PERIODS) spend[period] = periodSpend(sources, period, at, appLedger)
  return {
    generatedAt: at.toISOString(),
    spend,
    projection: toProjectionView(projectSpend(sources, at, toCents(spend.month.usd), appLedger)),
  }
}
