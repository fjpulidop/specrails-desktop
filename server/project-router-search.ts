// ⌘K scoped search endpoints for one project (CD6): `#` specs and `log:` job
// logs. Missions (`@`) stay on the Desktop-wide `/api/agents/search`, files
// (`f:`) on the code explorer's `/code/find`, docs (`?`) on `/api/docs/search`.
// Registered on the shared router by createProjectRouter.
import type { Request, Response } from 'express'
import { searchJobs, JOB_SEARCH_DEFAULT_LIMIT, JOB_SEARCH_MAX_LIMIT } from './db'
import { readStore } from './modules/specs/runtime/ticket-store'
import { searchSpecs, SPEC_SEARCH_DEFAULT_LIMIT, SPEC_SEARCH_MAX_LIMIT } from './modules/specs/runtime/spec-search'
import type { ProjectRoutesDeps } from './project-router-helpers'

const MAX_QUERY_LENGTH = 200

function parseQuery(req: Request, res: Response): string | null {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (!q) {
    res.status(400).json({ error: 'q is required' })
    return null
  }
  if (q.length > MAX_QUERY_LENGTH || /[\r\n]/.test(q)) {
    res.status(400).json({ error: `q must be a single line of at most ${MAX_QUERY_LENGTH} characters` })
    return null
  }
  return q
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback
}

export function registerSearchRoutes({ router, ctx, ticketPath }: ProjectRoutesDeps): void {
  router.get('/:projectId/search/specs', (req: Request, res: Response) => {
    const q = parseQuery(req, res)
    if (q === null) return
    try {
      const store = readStore(ticketPath(req))
      const limit = parseLimit(req.query.limit, SPEC_SEARCH_DEFAULT_LIMIT, SPEC_SEARCH_MAX_LIMIT)
      res.json({ results: searchSpecs(Object.values(store.tickets), q, limit) })
    } catch (err) {
      console.error('[project-router] spec search error:', err)
      res.status(500).json({ error: 'Failed to search specs' })
    }
  })

  router.get('/:projectId/search/jobs', (req: Request, res: Response) => {
    const q = parseQuery(req, res)
    if (q === null) return
    try {
      const limit = parseLimit(req.query.limit, JOB_SEARCH_DEFAULT_LIMIT, JOB_SEARCH_MAX_LIMIT)
      res.json({ results: searchJobs(ctx(req).db, q, limit) })
    } catch (err) {
      console.error('[project-router] job search error:', err)
      res.status(500).json({ error: 'Failed to search job logs' })
    }
  })
}
