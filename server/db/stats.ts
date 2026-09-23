import type { DbInstance } from './types'
import type { StatsRow } from '../types'

export function getStats(db: DbInstance): StatsRow {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  // Job-COUNT metrics (totalJobs / failedJobs / jobsToday / avgDurationMs) are
  // genuinely about pipeline jobs, so they stay on the jobs table.
  const totalRow = db.prepare(`
    SELECT
      COUNT(*) as totalJobs,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failedJobs,
      AVG(duration_ms) as avgDurationMs
    FROM jobs
  `).get() as { totalJobs: number; failedJobs: number | null; avgDurationMs: number | null }

  const jobsTodayRow = db.prepare(`
    SELECT COUNT(*) as jobsToday
    FROM jobs
    WHERE strftime('%Y-%m-%d', started_at) = ?
  `).get(today) as { jobsToday: number }

  // MED-8: cost SUMs come from ai_invocations — ALL billable surfaces (job,
  // explore-spec, chat-sidebar, quick-spec, ai-edit, agent-studio, spec-launcher,
  // proposal, setup, smash, file-summary, loop), not just the jobs table — across
  // every status, mirroring server/modules/accounting/runtime/desktop-analytics.ts + server/modules/accounting/runtime/spending.ts so
  // the per-project StatusBar reconciles with /analytics and /budget for the same
  // project. A killed/failed run's rate-card estimate now counts (it billed real
  // tokens) instead of vanishing; estimatedCost* is the portion sourced from the
  // rate card so the StatusBar can badge the total with `~`.
  const costSum = `COALESCE(SUM(total_cost_usd), 0)`
  const estSum = `COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0)`

  const costRow = db.prepare(`
    SELECT
      ${costSum} as totalCostUsd,
      ${estSum} as estimatedCostUsd,
      COUNT(total_cost_usd) as pricedRuns,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) as unpricedRuns
    FROM ai_invocations
  `).get() as {
    totalCostUsd: number
    estimatedCostUsd: number
    pricedRuns: number
    unpricedRuns: number | null
  }

  const costTodayRow = db.prepare(`
    SELECT
      ${costSum} as costToday,
      ${estSum} as estimatedCostToday,
      COUNT(total_cost_usd) as pricedTodayRuns,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) as unpricedTodayRuns
    FROM ai_invocations
    WHERE strftime('%Y-%m-%d', started_at) = ?
  `).get(today) as {
    costToday: number
    estimatedCostToday: number
    pricedTodayRuns: number
    unpricedTodayRuns: number | null
  }

  return {
    totalJobs: totalRow.totalJobs,
    failedJobs: totalRow.failedJobs ?? 0,
    jobsToday: jobsTodayRow.jobsToday,
    totalCostUsd: costRow.totalCostUsd,
    costToday: costTodayRow.costToday,
    estimatedCostUsd: costRow.estimatedCostUsd,
    estimatedCostToday: costTodayRow.estimatedCostToday,
    pricedRuns: costRow.pricedRuns,
    unpricedRuns: costRow.unpricedRuns ?? 0,
    pricedTodayRuns: costTodayRow.pricedTodayRuns,
    unpricedTodayRuns: costTodayRow.unpricedTodayRuns ?? 0,
    avgDurationMs: totalRow.avgDurationMs,
  }
}
