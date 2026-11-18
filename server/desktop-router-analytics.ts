/**
 * Cross-project read models: `/state`, `/analytics` and `/recent-jobs`.
 */
import type { Router } from 'express'
import type { ProjectRegistry } from './project-registry'
import { listProjects } from './desktop-db'
import { getDesktopAnalytics, getDesktopTodayStats, getDesktopRecentJobs } from './modules/accounting/runtime/desktop-analytics'
import type { AnalyticsOpts, AnalyticsPeriod } from './types'

export function registerAnalyticsRoutes(router: Router, deps: { registry: ProjectRegistry }): void {
  const { registry } = deps
  // GET /api/state — app-level state summary
  router.get('/state', (_req, res) => {
    const projects = listProjects(registry.desktopDb)
    const todayStats = getDesktopTodayStats(registry)
    res.json({
      projects,
      projectCount: projects.length,
      ...todayStats,
    })
  })

  // GET /api/analytics?period= — cross-project aggregated analytics
  router.get('/analytics', (req, res) => {
    const period = (req.query.period as AnalyticsPeriod | undefined) ?? '7d'
    const from = req.query.from as string | undefined
    const to = req.query.to as string | undefined
    const opts: AnalyticsOpts = { period, from, to }
    const result = getDesktopAnalytics(registry, opts)
    res.json(result)
  })

  // GET /api/recent-jobs?limit= — last N jobs across all projects
  router.get('/recent-jobs', (req, res) => {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? '10', 10) || 10, 1), 50)
    const jobs = getDesktopRecentJobs(registry, limit)
    res.json({ jobs })
  })
}
