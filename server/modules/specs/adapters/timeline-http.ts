import type { Request, Response, Router } from 'express'
import type { DbInstance } from '../../../db'
import { isReviewPacketEnabled } from '../../../feature-flags'
import { composeDeliveryChanges } from '../../delivery/runtime/delivery-changes'
import { getPrDelivery } from '../../delivery/runtime/rail-pr-store'
import { decodeCursor, pageTimeline, parseKinds, parseLimit } from '../domain/timeline'
import { collectSpecHistory, type DeliveryFact } from '../runtime/spec-history'
import { buildHandoffModel, parseHandoffFormat, parsePlanProviders, renderHandoff, type DeliveryDiffStat } from '../runtime/spec-handoff'
import { readStore, type Ticket } from '../runtime/ticket-store'

export interface SpecTimelineScope {
  db: DbInstance
  project: { path: string }
}

export interface SpecTimelineRouteDeps {
  ctx: (req: Request) => SpecTimelineScope
  ticketPath: (req: Request) => string
}

const TOP_FILES = 8

/** Diff stats come from the repository itself (the review packet's Changes read model), never from the ledger. */
export function createDiffReader(scope: SpecTimelineScope): (delivery: DeliveryFact) => Promise<DeliveryDiffStat | null> {
  return async (delivery) => {
    if (!isReviewPacketEnabled()) return null
    const row = getPrDelivery(scope.db, delivery.id)
    if (!row) return null
    const changes = await composeDeliveryChanges({ row, repoDir: scope.project.path, sourceId: null, repositoryId: null })
    if (!changes.available) return null
    const top = [...changes.files]
      .sort((a, b) => ((b.additions ?? 0) + (b.deletions ?? 0)) - ((a.additions ?? 0) + (a.deletions ?? 0)))
      .slice(0, TOP_FILES)
      .map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions }))
    return { files: changes.totals.files, additions: changes.totals.additions, deletions: changes.totals.deletions, top }
  }
}

/**
 * Spec lifecycle routes (a projection, no store of its own):
 *  - `GET /:projectId/tickets/:ticketId/timeline` — merged, paged timeline.
 *  - `GET /:projectId/tickets/:ticketId/handoff` — Markdown / HTML / PR-description export.
 * Both read this project's own database and ticket file only.
 */
export function registerSpecTimelineRoutes(router: Router, deps: SpecTimelineRouteDeps): void {
  const loadTicket = (req: Request, res: Response): Ticket | null => {
    const raw = String(req.params.ticketId)
    if (!/^\d+$/.test(raw)) { res.status(400).json({ error: 'Invalid ticket ID' }); return null }
    const ticket = readStore(deps.ticketPath(req)).tickets[raw]
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return null }
    return ticket
  }

  router.get('/:projectId/tickets/:ticketId/timeline', (req: Request, res: Response) => {
    const kinds = parseKinds(req.query.kinds)
    if (kinds === null) { res.status(400).json({ error: 'Invalid kinds' }); return }
    const limit = parseLimit(req.query.limit)
    if (limit === null) { res.status(400).json({ error: 'Invalid limit' }); return }
    const cursor = req.query.cursor === undefined || req.query.cursor === '' ? null : decodeCursor(req.query.cursor)
    if (req.query.cursor !== undefined && req.query.cursor !== '' && !cursor) { res.status(400).json({ error: 'Invalid cursor' }); return }
    try {
      const ticket = loadTicket(req, res)
      if (!ticket) return
      const history = collectSpecHistory(deps.ctx(req).db, ticket)
      res.json({ ticketId: ticket.id, ...pageTimeline(history.entries, { kinds, limit, cursor }) })
    } catch (err) {
      console.error('[spec-timeline] projection failed:', err)
      res.status(500).json({ error: 'Failed to build the timeline' })
    }
  })

  router.get('/:projectId/tickets/:ticketId/handoff', async (req: Request, res: Response) => {
    const format = parseHandoffFormat(req.query.format)
    if (!format) { res.status(400).json({ error: 'Invalid format. Must be md, html or pr' }); return }
    try {
      const ticket = loadTicket(req, res)
      if (!ticket) return
      const scope = deps.ctx(req)
      const history = collectSpecHistory(scope.db, ticket)
      const model = await buildHandoffModel({
        ticket, history, planProviders: parsePlanProviders(req.query.planProviders), diffFor: createDiffReader(scope), now: new Date(),
      })
      res.json(renderHandoff(model, format, req.query.locale))
    } catch (err) {
      console.error('[spec-timeline] handoff failed:', err)
      res.status(500).json({ error: 'Failed to build the hand-off' })
    }
  })
}
