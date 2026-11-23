/**
 * Cross-project read models: `/state`, `/analytics`, `/recent-jobs` and `/runs`.
 */
import type { Router } from 'express'
import type { ProjectRegistry } from './project-registry'
import { listProjects } from './desktop-db'
import { getDesktopAnalytics, getDesktopTodayStats, getDesktopRecentJobs } from './modules/accounting/runtime/desktop-analytics'
import type { AnalyticsOpts, AnalyticsPeriod } from './types'
import { listRunsAcross, type RunSequenceKey } from './modules/execution/runtime/job-listing'
import { readRunHolds, runHoldSources } from './modules/loops/runtime/loop-run-hold'
import { activeRuntimeContinuationIds, isRuntimeContinuationActive } from './modules/agent-runtime/runtime/agent-runtime-controls-router'

/** The opaque `after` of `/runs` (base64url JSON of the sequence key); null when absent or malformed. */
export function decodeRunsAfter(value: unknown): RunSequenceKey | null {
  if (typeof value !== 'string' || !value || value.length > 600) return null
  try {
    const key = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if ((key.tier !== 0 && key.tier !== 1) || typeof key.at !== 'string' || typeof key.projectId !== 'string' || typeof key.id !== 'string') return null
    return { tier: key.tier, at: key.at, projectId: key.projectId, id: key.id }
  } catch {
    return null
  }
}

export const encodeRunsAfter = (key: RunSequenceKey): string => Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')

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

  // GET /api/runs?limit=&after=&status=&from= — the app-wide run sequence over the
  // loaded projects: live runs (with their hold) first, then history, newest
  // first, paged with `after`. Projects still warming up are counted in
  // `notLoaded`, never loaded here.
  router.get('/runs', (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '25'), 10) || 25, 100))
    const status = typeof req.query.status === 'string' && /^[a-z_]{3,30}$/.test(req.query.status) ? req.query.status : undefined
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined
    const after = decodeRunsAfter(req.query.after)
    if (req.query.after !== undefined && !after) { res.status(400).json({ error: 'after is not a cursor from /runs' }); return }
    const contexts = registry.listContexts()
    const byId = new Map(contexts.map((ctx) => [ctx.project.id, ctx]))
    const page = listRunsAcross(contexts.map((ctx) => ({ projectId: ctx.project.id, db: ctx.db, activeRuntimeIds: () => activeRuntimeContinuationIds(ctx) })), { limit, after, status, from })
    // Holds only for the page's running rows, one read per project on the page.
    const holds = new Map<string, unknown>()
    const running = new Map<string, string[]>()
    for (const run of page.runs) if (run.status === 'running') running.set(run.projectId, [...(running.get(run.projectId) ?? []), run.id])
    for (const [projectId, ids] of running) {
      const ctx = byId.get(projectId)
      if (!ctx) continue
      try {
        for (const [id, hold] of readRunHolds(ctx.db, ids.filter((id) => !isRuntimeContinuationActive(ctx, id)), runHoldSources(ctx))) holds.set(`${projectId}/${id}`, hold)
      } catch { /* an unreadable hold leaves the run plainly running */ }
    }
    const registered = listProjects(registry.desktopDb).length
    res.json({
      runs: page.runs.map(({ tier: _tier, sortAt: _sortAt, ...run }) => ({ ...run, ...(holds.get(`${run.projectId}/${run.id}`) ? { hold: holds.get(`${run.projectId}/${run.id}`) } : {}) })),
      next: page.next ? encodeRunsAfter(page.next) : null,
      projects: { loaded: contexts.length, notLoaded: Math.max(0, registered - contexts.length), failed: page.failed },
    })
  })

  // GET /api/recent-jobs?limit= — last N jobs across all projects
  router.get('/recent-jobs', (req, res) => {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? '10', 10) || 10, 1), 50)
    const jobs = getDesktopRecentJobs(registry, limit)
    res.json({ jobs })
  })
}
