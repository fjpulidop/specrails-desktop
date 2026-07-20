import type { ProjectRegistry } from './project-registry'
import type { AnalyticsOpts } from './types'
import type { DbInstance } from './db'
import { sumAgentInvocationsCost } from './desktop-db'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DesktopProjectStats {
  projectId: string
  projectName: string
  totalCostUsd: number
  /** Portion of `totalCostUsd` that is a rate-card estimate (codex/gemini,
   *  `jobs.total_cost_usd_estimated=1`) rather than provider-billed (claude). */
  estimatedCostUsd: number
  /** Invocation-cost coverage; optional for wire compatibility with older clients. */
  pricedRuns?: number
  unpricedRuns?: number
  totalJobs: number
  successRate: number
  avgDurationMs: number | null
}

export interface DesktopAnalyticsResponse {
  period: {
    label: string
    from: string | null
    to: string | null
  }
  kpi: {
    totalCostUsd: number
    /** Portion of `totalCostUsd` that is estimated (codex/gemini). */
    estimatedCostUsd: number
    /** True when any part of the grand total is a rate-card estimate. */
    includesEstimated: boolean
    totalJobs: number
    successRate: number
    costToday: number
    /** Portion of `costToday` that is estimated (codex/gemini). */
    estimatedCostToday: number
    pricedRuns?: number
    unpricedRuns?: number
    pricedTodayRuns?: number
    unpricedTodayRuns?: number
    jobsToday: number
  }
  projectBreakdown: DesktopProjectStats[]
  costTimeline: Array<{
    date: string
    costUsd: number
    estimatedCostUsd: number
    unpricedCount?: number
  }>
}

// ─── Period resolution ────────────────────────────────────────────────────────

interface DateBounds {
  from: string | null
  to: string | null
}

function resolveBounds(opts: AnalyticsOpts): { current: DateBounds; label: string } {
  const now = new Date()
  const toISO = (d: Date) => d.toISOString().slice(0, 10)

  if (opts.period === 'all') {
    return { current: { from: null, to: null }, label: 'All time' }
  }
  if (opts.period === 'custom') {
    // B42: from/to are unvalidated query params. A malformed date flows into
    // buildWhere's `new Date(bounds.to).toISOString()` and throws an unhandled
    // RangeError ("Invalid time value") → 500. Drop any unparseable bound (and
    // fall back to all-time when neither is valid) instead of crashing.
    const validFrom = opts.from && !Number.isNaN(Date.parse(opts.from)) ? opts.from : null
    const validTo = opts.to && !Number.isNaN(Date.parse(opts.to)) ? opts.to : null
    return {
      current: { from: validFrom, to: validTo },
      label: validFrom || validTo ? `${validFrom ?? '…'} to ${validTo ?? '…'}` : 'All time',
    }
  }

  const days = opts.period === '7d' ? 7 : opts.period === '30d' ? 30 : 90
  const from = toISO(new Date(now.getTime() - days * 86400000))
  const to = toISO(now)
  const label = opts.period === '7d' ? 'Last 7 days'
    : opts.period === '30d' ? 'Last 30 days'
    : 'Last 90 days'

  return { current: { from, to }, label }
}

function buildWhere(bounds: DateBounds): { clause: string; params: unknown[] } {
  if (!bounds.from && !bounds.to) return { clause: '', params: [] }
  if (bounds.from && bounds.to) {
    const nextDay = new Date(new Date(bounds.to).getTime() + 86400000).toISOString().slice(0, 10)
    return { clause: 'WHERE started_at >= ? AND started_at < ?', params: [bounds.from, nextDay] }
  }
  if (bounds.from) return { clause: 'WHERE started_at >= ?', params: [bounds.from] }
  const nextDay = new Date(new Date(bounds.to!).getTime() + 86400000).toISOString().slice(0, 10)
  return { clause: 'WHERE started_at < ?', params: [nextDay] }
}

// ─── Per-project query ────────────────────────────────────────────────────────

interface ProjectKpi {
  totalCostUsd: number
  estimatedCostUsd: number
  pricedRuns: number
  unpricedRuns: number
  totalJobs: number
  successCount: number
  avgDurationMs: number | null
}

interface ProjectCost {
  totalCostUsd: number
  estimatedCostUsd: number
  pricedRuns: number
  unpricedRuns: number
}

// MED-8: the app-level cost KPIs must aggregate ALL billable surfaces, not just
// the jobs table. Per-project `ai_invocations` records six additional surfaces
// (explore-spec, quick-spec, ai-edit, smash, file-summary, loop) plus the job
// surface itself, so the cost SUM is sourced HERE (all surfaces, all statuses),
// mirroring server/spending.ts's summary — a killed/failed run's estimated
// fallback cost now counts instead of vanishing. `started_at` exists on both
// tables so the same window clause/params apply unchanged. The job-COUNT fields
// (totalJobs/successRate/avgDuration) stay job-centric and are queried
// separately against the jobs table.
function queryProjectCost(db: DbInstance, clause: string, params: unknown[]): ProjectCost {
  return db.prepare(`
    SELECT
      COALESCE(SUM(total_cost_usd), 0) as totalCostUsd,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) as estimatedCostUsd,
      COUNT(total_cost_usd) as pricedRuns,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) as unpricedRuns
    FROM ai_invocations ${clause}
  `).get(...params) as ProjectCost
}

// Job-count metrics (genuinely about pipeline jobs, not spend) stay on the jobs
// table. Cost fields come from queryProjectCost above.
function queryProjectJobCounts(
  db: DbInstance,
  clause: string,
  params: unknown[]
): { totalJobs: number; successCount: number; avgDurationMs: number | null } {
  return db.prepare(`
    SELECT
      COUNT(*) as totalJobs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successCount,
      AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avgDurationMs
    FROM jobs ${clause}
  `).get(...params) as { totalJobs: number; successCount: number; avgDurationMs: number | null }
}

function queryProjectKpi(db: DbInstance, clause: string, params: unknown[]): ProjectKpi {
  const cost = queryProjectCost(db, clause, params)
  const counts = queryProjectJobCounts(db, clause, params)
  return {
    totalCostUsd: cost.totalCostUsd,
    estimatedCostUsd: cost.estimatedCostUsd,
    pricedRuns: cost.pricedRuns ?? 0,
    unpricedRuns: cost.unpricedRuns ?? 0,
    totalJobs: counts.totalJobs,
    successCount: counts.successCount ?? 0,
    avgDurationMs: counts.avgDurationMs,
  }
}

/**
 * App-level agent-chat (Mission Control) spend lives in desktop.sqlite's
 * `agent_invocations` table (not per-project). MED-8: fold it into the grand
 * cost total. Defensive: a DB without the table (older schema / a stubbed test
 * registry) yields 0 instead of throwing. `sinceIso` is a lower bound only —
 * for windowed periods ending "now" that captures exactly the window; a custom
 * period with a past upper bound may marginally over-count agent spend (the
 * helper offers no upper bound).
 */
function agentCostSince(registry: ProjectRegistry, sinceIso?: string): number {
  try {
    const ddb = registry.desktopDb
    if (!ddb) return 0
    return sumAgentInvocationsCost(ddb, sinceIso)
  } catch {
    return 0
  }
}

interface TimelineRow {
  date: string
  costUsd: number
  estimatedCostUsd: number
  unpricedCount: number
}

// MED-8 + BUG-ANALYTICS-26: per-day cost across ALL billable surfaces
// (ai_invocations, all statuses), split into authoritative vs estimated so the
// timeline can annotate days that mix billed and rate-card-estimated dollars.
// Sourced from ai_invocations (not jobs) to match the KPI's all-surface scope.
function queryProjectTimeline(db: DbInstance, clause: string, params: unknown[]): TimelineRow[] {
  return db.prepare(`
    SELECT
      strftime('%Y-%m-%d', started_at) as date,
      COALESCE(SUM(total_cost_usd), 0) as costUsd,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) as estimatedCostUsd,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) as unpricedCount
    FROM ai_invocations ${clause}
    GROUP BY date
    ORDER BY date ASC
  `).all(...params) as TimelineRow[]
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function getDesktopAnalytics(
  registry: ProjectRegistry,
  opts: AnalyticsOpts
): DesktopAnalyticsResponse {
  const { current, label } = resolveBounds(opts)
  const { clause, params } = buildWhere(current)

  const today = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const todayClause = 'WHERE started_at >= ? AND started_at < ?'
  const todayParams = [today, tomorrow]

  const contexts = registry.listContexts()

  let totalCostUsd = 0
  let estimatedCostUsd = 0
  let pricedRuns = 0
  let unpricedRuns = 0
  let totalJobs = 0
  let totalSuccess = 0
  let costToday = 0
  let estimatedCostToday = 0
  let pricedTodayRuns = 0
  let unpricedTodayRuns = 0
  let jobsToday = 0

  const projectBreakdown: DesktopProjectStats[] = []
  const timelineMap = new Map<string, { costUsd: number; estimatedCostUsd: number; unpricedCount: number }>()

  // Iterate sequentially to avoid SQLite contention
  for (const ctx of contexts) {
    const kpi = queryProjectKpi(ctx.db, clause, params)
    const todayKpi = queryProjectKpi(ctx.db, todayClause, todayParams)
    const timeline = queryProjectTimeline(ctx.db, clause, params)

    totalCostUsd += kpi.totalCostUsd
    estimatedCostUsd += kpi.estimatedCostUsd
    pricedRuns += kpi.pricedRuns
    unpricedRuns += kpi.unpricedRuns
    totalJobs += kpi.totalJobs
    totalSuccess += kpi.successCount
    costToday += todayKpi.totalCostUsd
    estimatedCostToday += todayKpi.estimatedCostUsd
    pricedTodayRuns += todayKpi.pricedRuns
    unpricedTodayRuns += todayKpi.unpricedRuns
    jobsToday += todayKpi.totalJobs

    projectBreakdown.push({
      projectId: ctx.project.id,
      projectName: ctx.project.name,
      totalCostUsd: kpi.totalCostUsd,
      estimatedCostUsd: kpi.estimatedCostUsd,
      pricedRuns: kpi.pricedRuns,
      unpricedRuns: kpi.unpricedRuns,
      totalJobs: kpi.totalJobs,
      successRate: kpi.totalJobs > 0 ? kpi.successCount / kpi.totalJobs : 0,
      avgDurationMs: kpi.avgDurationMs,
    })

    for (const row of timeline) {
      const acc = timelineMap.get(row.date) ?? { costUsd: 0, estimatedCostUsd: 0, unpricedCount: 0 }
      acc.costUsd += row.costUsd
      acc.estimatedCostUsd += row.estimatedCostUsd
      acc.unpricedCount += row.unpricedCount ?? 0
      timelineMap.set(row.date, acc)
    }
  }

  // MED-8: add app-level agent-chat (Mission Control) spend to the grand cost
  // totals. It is not per-project, so it contributes to the KPI headline and
  // costToday only (not the per-project breakdown / per-day timeline).
  totalCostUsd += agentCostSince(registry, current.from ?? undefined)
  costToday += agentCostSince(registry, today)

  // Build sorted cost timeline
  const costTimeline = Array.from(timelineMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      costUsd: v.costUsd,
      estimatedCostUsd: v.estimatedCostUsd,
      ...(v.unpricedCount > 0 ? { unpricedCount: v.unpricedCount } : {}),
    }))

  // Sort projects by cost descending
  projectBreakdown.sort((a, b) => b.totalCostUsd - a.totalCostUsd)

  return {
    period: { label, from: current.from, to: current.to },
    kpi: {
      totalCostUsd,
      estimatedCostUsd,
      includesEstimated: estimatedCostUsd > 0,
      pricedRuns,
      unpricedRuns,
      totalJobs,
      successRate: totalJobs > 0 ? totalSuccess / totalJobs : 0,
      costToday,
      estimatedCostToday,
      pricedTodayRuns,
      unpricedTodayRuns,
      jobsToday,
    },
    projectBreakdown,
    costTimeline,
  }
}

// ─── Recent jobs across all projects ─────────────────────────────────────────

interface DesktopRecentJob {
  id: string
  command: string
  started_at: string
  finished_at: string | null
  status: string
  total_cost_usd: number | null
  projectId: string
  projectName: string
}

export function getDesktopRecentJobs(registry: ProjectRegistry, limit = 10): DesktopRecentJob[] {
  const all: DesktopRecentJob[] = []

  for (const ctx of registry.listContexts()) {
    const rows = ctx.db.prepare(`
      SELECT id, command, started_at, finished_at, status, total_cost_usd
      FROM jobs
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string
      command: string
      started_at: string
      finished_at: string | null
      status: string
      total_cost_usd: number | null
    }>

    for (const row of rows) {
      all.push({ ...row, projectId: ctx.project.id, projectName: ctx.project.name })
    }
  }

  return all
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, limit)
}

// ─── Quick today stats (for /api/state) ────────────────────────────────────

export interface DesktopTodayStats {
  costToday: number
  /** Portion of `costToday` that is a rate-card estimate (codex/gemini). */
  estimatedCostToday: number
  /** True when any part of `costToday` is an estimate. */
  includesEstimated: boolean
  jobsToday: number
  pricedRuns: number
  unpricedRuns: number
}

// BUG-ANALYTICS-27 + MED-8: this feeds the always-visible StatusBar / /api/state
// costToday — the most prominent cost number in the app. The cost SUM is sourced
// from ai_invocations across ALL billable surfaces and statuses (not just the
// jobs table), plus the app-level agent_invocations spend, so Explore /
// quick-spec / ai-edit / file-summary / agent-chat dollars are no longer
// invisible. The estimated portion is split out so the consumer can flag the
// figure. jobsToday stays a jobs-table count.
export function getDesktopTodayStats(registry: ProjectRegistry): DesktopTodayStats {
  const today = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const clause = 'WHERE started_at >= ? AND started_at < ?'
  const params = [today, tomorrow]

  let costToday = 0
  let estimatedCostToday = 0
  let jobsToday = 0
  let pricedRuns = 0
  let unpricedRuns = 0

  for (const ctx of registry.listContexts()) {
    const costRow = ctx.db.prepare(`
      SELECT
        COALESCE(SUM(total_cost_usd), 0) as costToday,
        COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) as estimatedCostToday,
        COUNT(total_cost_usd) as pricedRuns,
        SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) as unpricedRuns
      FROM ai_invocations ${clause}
    `).get(...params) as {
      costToday: number
      estimatedCostToday: number
      pricedRuns: number
      unpricedRuns: number | null
    }
    const jobsRow = ctx.db.prepare(`
      SELECT COUNT(*) as jobsToday FROM jobs ${clause}
    `).get(...params) as { jobsToday: number }
    costToday += costRow.costToday
    estimatedCostToday += costRow.estimatedCostToday
    pricedRuns += costRow.pricedRuns
    unpricedRuns += costRow.unpricedRuns ?? 0
    jobsToday += jobsRow.jobsToday
  }

  // App-level agent-chat spend (desktop.sqlite), added to the headline figure.
  costToday += agentCostSince(registry, today)

  return {
    costToday,
    estimatedCostToday,
    includesEstimated: estimatedCostToday > 0,
    jobsToday,
    pricedRuns,
    unpricedRuns,
  }
}
