import type { RequestHandler } from 'express'

/** Keep unknown/disabled API routes out of Express's HTML 404 and the SPA. */
export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'api_route_not_found' })
}
