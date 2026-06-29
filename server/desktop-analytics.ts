import type { ProjectRegistry } from './project-registry'
import type { AnalyticsOpts } from './types'
import type { DbInstance } from './db'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DesktopProjectStats {
  projectId: string
  projectName: string
  totalCostUsd: number
  /** Portion of `totalCostUsd` that is a rate-card estimate (codex/gemini,
   *  `jobs.total_cost_usd_estimated=1`) rather than provider-billed (claude). */
  estimatedCostUsd: number
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
    jobsToday: number
  }
  projectBreakdown: DesktopProjectStats[]
  costTimeline: Array<{ date: string; costUsd: number; estimatedCostUsd: number }>
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
  totalJobs: number
  successCount: number
  avgDurationMs: number | null
}

// BUG-ANALYTICS-28/24/27 (review-corrected): the cost SUM keeps AUTHORITATIVE
// (provider-billed, total_cost_usd_estimated=0) cost on EVERY status — so a
// failed claude job's real billed cost is still counted and the claude path is
// byte-identical to the pre-fix `SUM(total_cost_usd)`. It drops only the
// ESTIMATED rate-card cost of a NON-success terminal job (the misleading
// figure a crashed/canceled codex/gemini run leaves behind). The jobs.status
// vocabulary is queued|running|completed|failed|canceled|zombie_terminated|
// skipped — there is NO 'aborted' status here ('aborted' is an ai_invocations
// value), so we exclude the real terminal-failure trio. estimatedCostUsd is the
// estimated portion that IS counted (non-failed), so the client can footnote it.
function queryProjectKpi(db: DbInstance, clause: string, params: unknown[]): ProjectKpi {
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 AND status IN ('failed','canceled','zombie_terminated') THEN 0 ELSE total_cost_usd END), 0) as totalCostUsd,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 AND status NOT IN ('failed','canceled','zombie_terminated') THEN total_cost_usd ELSE 0 END), 0) as estimatedCostUsd,
      COUNT(*) as totalJobs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successCount,
      AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avgDurationMs
    FROM jobs ${clause}
  `).get(...params) as ProjectKpi
}

interface TimelineRow {
  date: string
  costUsd: number
  estimatedCostUsd: number
}

// BUG-ANALYTICS-26: split the per-day cost into authoritative vs estimated
// (and exclude failed/aborted, consistent with the KPI) so the timeline can
// annotate days that mix billed and rate-card-estimated dollars.
function queryProjectTimeline(db: DbInstance, clause: string, params: unknown[]): TimelineRow[] {
  return db.prepare(`
    SELECT
      strftime('%Y-%m-%d', started_at) as date,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 AND status IN ('failed','canceled','zombie_terminated') THEN 0 ELSE total_cost_usd END), 0) as costUsd,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 AND status NOT IN ('failed','canceled','zombie_terminated') THEN total_cost_usd ELSE 0 END), 0) as estimatedCostUsd
    FROM jobs ${clause}
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
  let totalJobs = 0
  let totalSuccess = 0
  let costToday = 0
  let estimatedCostToday = 0
  let jobsToday = 0

  const projectBreakdown: DesktopProjectStats[] = []
  const timelineMap = new Map<string, { costUsd: number; estimatedCostUsd: number }>()

  // Iterate sequentially to avoid SQLite contention
  for (const ctx of contexts) {
    const kpi = queryProjectKpi(ctx.db, clause, params)
    const todayKpi = queryProjectKpi(ctx.db, todayClause, todayParams)
    const timeline = queryProjectTimeline(ctx.db, clause, params)

    totalCostUsd += kpi.totalCostUsd
    estimatedCostUsd += kpi.estimatedCostUsd
    totalJobs += kpi.totalJobs
    totalSuccess += kpi.successCount
    costToday += todayKpi.totalCostUsd
    estimatedCostToday += todayKpi.estimatedCostUsd
    jobsToday += todayKpi.totalJobs

    projectBreakdown.push({
      projectId: ctx.project.id,
      projectName: ctx.project.name,
      totalCostUsd: kpi.totalCostUsd,
      estimatedCostUsd: kpi.estimatedCostUsd,
      totalJobs: kpi.totalJobs,
      successRate: kpi.totalJobs > 0 ? kpi.successCount / kpi.totalJobs : 0,
      avgDurationMs: kpi.avgDurationMs,
    })

    for (const row of timeline) {
      const acc = timelineMap.get(row.date) ?? { costUsd: 0, estimatedCostUsd: 0 }
      acc.costUsd += row.costUsd
      acc.estimatedCostUsd += row.estimatedCostUsd
      timelineMap.set(row.date, acc)
    }
  }

  // Build sorted cost timeline
  const costTimeline = Array.from(timelineMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, costUsd: v.costUsd, estimatedCostUsd: v.estimatedCostUsd }))

  // Sort projects by cost descending
  projectBreakdown.sort((a, b) => b.totalCostUsd - a.totalCostUsd)

  return {
    period: { label, from: current.from, to: current.to },
    kpi: {
      totalCostUsd,
      estimatedCostUsd,
      includesEstimated: estimatedCostUsd > 0,
      totalJobs,
      successRate: totalJobs > 0 ? totalSuccess / totalJobs : 0,
      costToday,
      estimatedCostToday,
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
}

// BUG-ANALYTICS-27: this feeds the always-visible StatusBar / /api/state
// costToday — the most prominent cost number in the app. Split out the
// estimated portion (and exclude failed/aborted, matching the KPI) so the
// consumer can flag that the figure may include rate-card estimates.
export function getDesktopTodayStats(registry: ProjectRegistry): DesktopTodayStats {
  const today = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const clause = 'WHERE started_at >= ? AND started_at < ?'
  const params = [today, tomorrow]

  let costToday = 0
  let estimatedCostToday = 0
  let jobsToday = 0

  for (const ctx of registry.listContexts()) {
    const row = ctx.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 AND status IN ('failed','canceled','zombie_terminated') THEN 0 ELSE total_cost_usd END), 0) as costToday,
        COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 AND status NOT IN ('failed','canceled','zombie_terminated') THEN total_cost_usd ELSE 0 END), 0) as estimatedCostToday,
        COUNT(*) as jobsToday
      FROM jobs ${clause}
    `).get(...params) as { costToday: number; estimatedCostToday: number; jobsToday: number }
    costToday += row.costToday
    estimatedCostToday += row.estimatedCostToday
    jobsToday += row.jobsToday
  }

  return { costToday, estimatedCostToday, includesEstimated: estimatedCostToday > 0, jobsToday }
}
