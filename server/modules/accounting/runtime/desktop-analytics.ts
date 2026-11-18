import type { ProjectRegistry } from '../../../project-registry'
import type { AnalyticsOpts } from '../../../types'
import { localDayWindow } from '../../../util/local-day'
import type { DbInstance } from '../../../db'
import { agentLedgerSurface } from './spending'
import { buildCategoryBreakdown, type CategoryBreakdownEntry, type SurfaceSpendAggregate } from './spend-categories'
import type { SpendSurface } from './ai-invocations'

/** `projectBreakdown` id of the app-level row: agent-ledger turns pinned to no
 *  loaded project (Home missions, Blueprint / Builder chats). */
export const APP_LEDGER_ROW_ID = 'app:home-blueprint'

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
  /** 'app' = the Home & Blueprint row (agent turns of no loaded project); absent = a project. */
  kind?: 'project' | 'app'
  /** Agent-ledger turns (missions, Intent) counted in this row's cost. */
  agentTurns?: number
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
  /** The window's spend in the five categories (same mapping as the project page). */
  byCategory: CategoryBreakdownEntry[]
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

/** A date-only bound covers its whole day (`to` is inclusive); an exact
 *  instant (it has a time, e.g. a local midnight) is used as is (`to` exclusive). */
function upperBound(to: string): string {
  if (to.includes('T')) return new Date(to).toISOString()
  return new Date(new Date(to).getTime() + 86400000).toISOString().slice(0, 10)
}
const lowerBound = (from: string) => (from.includes('T') ? new Date(from).toISOString() : from)

function buildWhere(bounds: DateBounds): { clause: string; params: unknown[] } {
  if (!bounds.from && !bounds.to) return { clause: '', params: [] }
  if (bounds.from && bounds.to) {
    return { clause: 'WHERE started_at >= ? AND started_at < ?', params: [lowerBound(bounds.from), upperBound(bounds.to)] }
  }
  if (bounds.from) return { clause: 'WHERE started_at >= ?', params: [lowerBound(bounds.from)] }
  return { clause: 'WHERE started_at < ?', params: [upperBound(bounds.to!)] }
}

/** Today on this machine (the person's clock); shared with db/stats.ts. */
export { localDayWindow }

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
// mirroring server/modules/accounting/runtime/spending.ts's summary — a killed/failed run's estimated
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

// ─── App ledger (desktop.sqlite `agent_invocations`) ─────────────────────────
//
// Mission / Agent-Chat and Intent turns record to the APP-level ledger with the
// pinned project's id (NULL for Home, Blueprint and Builder chats). It is
// disjoint from every project's `ai_invocations`, so folding it in never double
// counts. Rows are counted exactly like project rows — priced / unpriced /
// estimated, per day and per category — and attributed to their project when it
// is loaded, else to the app-level "Home & Blueprint" row. The same window
// clause applies (it previously had a lower bound only).

interface AgentLedgerAgg {
  projectId: string | null
  surface: string | null
  date: string
  costUsd: number
  estimatedCostUsd: number
  pricedRuns: number
  unpricedRuns: number
  count: number
  tokens: number
}

/** Defensive: a desktop DB without the table (older schema / stubbed registry) yields no rows. */
function queryAgentLedger(registry: ProjectRegistry, clause: string, params: unknown[]): AgentLedgerAgg[] {
  try {
    const ddb = registry.desktopDb
    if (!ddb || typeof ddb.prepare !== 'function') return []
    return ddb.prepare(`
      SELECT project_id AS projectId, surface,
        strftime('%Y-%m-%d', started_at) AS date,
        COALESCE(SUM(total_cost_usd), 0) AS costUsd,
        COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) AS estimatedCostUsd,
        COUNT(total_cost_usd) AS pricedRuns,
        SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedRuns,
        COUNT(*) AS count,
        COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) + COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_create, 0)), 0) AS tokens
      FROM agent_invocations ${clause}
      GROUP BY project_id, surface, date
    `).all(...params) as AgentLedgerAgg[]
  } catch {
    return []
  }
}

// Per-surface spend of one project's ledger, for the category split.
function queryProjectSurfaces(db: DbInstance, clause: string, params: unknown[]): SurfaceSpendAggregate[] {
  return db.prepare(`
    SELECT surface,
      COALESCE(SUM(total_cost_usd), 0) AS costUsd,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) AS estimatedCostUsd,
      COUNT(*) AS count,
      COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) + COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_create, 0)), 0) AS tokens,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedCount
    FROM ai_invocations ${clause}
    GROUP BY surface
  `).all(...params) as SurfaceSpendAggregate[]
}

function addSurface(into: Map<string, SurfaceSpendAggregate>, agg: SurfaceSpendAggregate): void {
  const acc = into.get(agg.surface) ?? { surface: agg.surface, costUsd: 0, estimatedCostUsd: 0, count: 0, tokens: 0, unpricedCount: 0 }
  acc.costUsd += agg.costUsd
  acc.estimatedCostUsd += agg.estimatedCostUsd
  acc.count += agg.count
  acc.tokens += agg.tokens
  acc.unpricedCount += agg.unpricedCount ?? 0
  into.set(agg.surface, acc)
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

  // "Today" is the local day, the same basis as the spend caps.
  const localToday = localDayWindow()
  const todayClause = 'WHERE started_at >= ? AND started_at < ?'
  const todayParams = [localToday.from, localToday.to]

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
  const rowsById = new Map<string, DesktopProjectStats>()
  const timelineMap = new Map<string, { costUsd: number; estimatedCostUsd: number; unpricedCount: number }>()
  const surfaces = new Map<string, SurfaceSpendAggregate>()
  const addDay = (date: string, costUsd: number, estimated: number, unpriced: number): void => {
    const acc = timelineMap.get(date) ?? { costUsd: 0, estimatedCostUsd: 0, unpricedCount: 0 }
    acc.costUsd += costUsd
    acc.estimatedCostUsd += estimated
    acc.unpricedCount += unpriced ?? 0
    timelineMap.set(date, acc)
  }

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

    const row: DesktopProjectStats = {
      projectId: ctx.project.id,
      projectName: ctx.project.name,
      totalCostUsd: kpi.totalCostUsd,
      estimatedCostUsd: kpi.estimatedCostUsd,
      pricedRuns: kpi.pricedRuns,
      unpricedRuns: kpi.unpricedRuns,
      totalJobs: kpi.totalJobs,
      successRate: kpi.totalJobs > 0 ? kpi.successCount / kpi.totalJobs : 0,
      avgDurationMs: kpi.avgDurationMs,
      kind: 'project',
      agentTurns: 0,
    }
    projectBreakdown.push(row)
    rowsById.set(ctx.project.id, row)

    for (const day of timeline) addDay(day.date, day.costUsd, day.estimatedCostUsd, day.unpricedCount)
    for (const agg of queryProjectSurfaces(ctx.db, clause, params)) addSurface(surfaces, agg)
  }

  // App ledger: every agent turn of the window counts in the KPIs, the timeline
  // and the categories; its cost lands on the pinned project's row, or on the
  // app-level row when no loaded project owns it.
  let appRow: DesktopProjectStats | null = null
  for (const agg of queryAgentLedger(registry, clause, params)) {
    totalCostUsd += agg.costUsd
    estimatedCostUsd += agg.estimatedCostUsd
    pricedRuns += agg.pricedRuns
    unpricedRuns += agg.unpricedRuns ?? 0
    addDay(agg.date, agg.costUsd, agg.estimatedCostUsd, agg.unpricedRuns)
    const surface: SpendSurface = agentLedgerSurface(agg.surface)
    addSurface(surfaces, { surface, costUsd: agg.costUsd, estimatedCostUsd: agg.estimatedCostUsd, count: agg.count, tokens: agg.tokens, unpricedCount: agg.unpricedRuns ?? 0 })
    let row = agg.projectId ? rowsById.get(agg.projectId) : undefined
    if (!row) {
      appRow ??= {
        projectId: APP_LEDGER_ROW_ID, projectName: 'Home & Blueprint', kind: 'app', agentTurns: 0,
        totalCostUsd: 0, estimatedCostUsd: 0, pricedRuns: 0, unpricedRuns: 0, totalJobs: 0, successRate: 0, avgDurationMs: null,
      }
      row = appRow
    }
    row.totalCostUsd += agg.costUsd
    row.estimatedCostUsd += agg.estimatedCostUsd
    row.pricedRuns = (row.pricedRuns ?? 0) + agg.pricedRuns
    row.unpricedRuns = (row.unpricedRuns ?? 0) + (agg.unpricedRuns ?? 0)
    row.agentTurns = (row.agentTurns ?? 0) + agg.count
  }
  if (appRow) projectBreakdown.push(appRow)

  for (const agg of queryAgentLedger(registry, todayClause, todayParams)) {
    costToday += agg.costUsd
    estimatedCostToday += agg.estimatedCostUsd
    pricedTodayRuns += agg.pricedRuns
    unpricedTodayRuns += agg.unpricedRuns ?? 0
  }

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
    byCategory: buildCategoryBreakdown([...surfaces.values()]),
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
export function getDesktopTodayStats(registry: ProjectRegistry, now: Date = new Date()): DesktopTodayStats {
  // The local day — same basis as the spend caps and getDesktopAnalytics'
  // "today" KPI (it used to be the UTC calendar day).
  const day = localDayWindow(now)
  const clause = 'WHERE started_at >= ? AND started_at < ?'
  const params = [day.from, day.to]

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

  // App-level agent turns (desktop.sqlite), counted like every other row.
  for (const agg of queryAgentLedger(registry, clause, params)) {
    costToday += agg.costUsd
    estimatedCostToday += agg.estimatedCostUsd
    pricedRuns += agg.pricedRuns
    unpricedRuns += agg.unpricedRuns ?? 0
  }

  return {
    costToday,
    estimatedCostToday,
    includesEstimated: estimatedCostToday > 0,
    jobsToday,
    pricedRuns,
    unpricedRuns,
  }
}
