// Spec addenda routes (list/add/edit/remove structured iteration notes) plus
// the spec timeline and hand-off projections. Addenda never touch the spec
// description and are never written back to Jira; edits broadcast the parent
// ticket as ticket_updated.

import type { Request, Response } from 'express'
import { readStore, mutateStore, type Ticket } from './modules/specs/runtime/ticket-store'
import { appendSpecAddendum, buildSpecAddendum, editSpecAddendum, lintSpecAddendum, parseSpecAddendumInput, readSpecAddenda, removeSpecAddendum, setSpecAddendumStatus, SpecAddendumValidationError, type SpecAddendum } from './modules/specs/runtime/spec-addenda'
import type { TicketUpdatedMessage, LocalTicket } from './types'
import { registerSpecTimelineRoutes } from './modules/specs/adapters/timeline-http'
import { requireTicketIdParam } from './project-router-tickets-shared'
import type { ProjectRoutesDeps } from './project-router-helpers'

export function registerTicketAddendaRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx, ticketPath } = deps

  // ── Spec addenda (spec-addenda) ─────────────────────────────────────────
  // Structured iteration notes attached to a spec WITHOUT touching its
  // description. CRUD here; the launch doors claim them (open → in_flight),
  // the completion chokepoints settle them, a discarded delivery reopens them.
  // Never a Jira write-back: addenda are local-only guidance for the run.
  const ADDENDUM_ID_RE = /^[A-Za-z0-9-]{1,64}$/
  const addendumId = (req: Request, res: Response): string | null => {
    const id = req.params.addendumId as string
    if (!ADDENDUM_ID_RE.test(id)) { res.status(400).json({ error: 'Invalid addendum ID' }); return null }
    return id
  }
  const broadcastTicket = (req: Request, ticket: Ticket, revision: number): void => {
    const { broadcast, ticketWatcher } = ctx(req)
    ticketWatcher.notifyDesktopWrite(revision)
    const msg: TicketUpdatedMessage = { type: 'ticket_updated', ticket: ticket as unknown as LocalTicket, projectId: ctx(req).project.id, timestamp: new Date().toISOString() }
    broadcast(msg)
  }
  const addendumEditFailure = (res: Response, failure: 'not_found' | 'in_flight' | 'applied'): void => {
    if (failure === 'not_found') { res.status(404).json({ error: 'addendum_not_found' }); return }
    if (failure === 'in_flight') { res.status(409).json({ error: 'addendum_in_flight', detail: 'the addendum is frozen inside a running job; wait for it to settle' }); return }
    res.status(409).json({ error: 'addendum_applied', detail: 'an applied addendum is history; reopen it or add a new one' })
  }

  // GET /:projectId/tickets/:ticketId/timeline and /handoff — the spec lifecycle projection and its export.
  registerSpecTimelineRoutes(router, { ctx, ticketPath })

  // GET /:projectId/tickets/:id/addenda — list a spec's addenda
  router.get('/:projectId/tickets/:id/addenda', (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (!ticketId) return
    try {
      const store = readStore(ticketPath(req))
      const ticket = store.tickets[ticketId]
      if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return }
      res.json({ addenda: readSpecAddenda(ticket.addenda), revision: store.revision })
    } catch (err) {
      console.error('[project-router] addenda list error:', err)
      res.status(500).json({ error: 'Failed to read addenda' })
    }
  })

  // POST /:projectId/tickets/:id/addenda — add an addendum { kind?, title?, body, originConversationId? }
  router.post('/:projectId/tickets/:id/addenda', (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (!ticketId) return
    let input
    try { input = parseSpecAddendumInput(req.body ?? {}) } catch (err) {
      if (err instanceof SpecAddendumValidationError) { res.status(400).json({ error: 'invalid_addendum', code: err.code, detail: err.message }); return }
      throw err
    }
    const createdBy = typeof req.body?.createdBy === 'string' && /^[a-z-]{1,32}$/.test(req.body.createdBy) ? req.body.createdBy : 'user'
    const originConversationId = typeof req.body?.originConversationId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(req.body.originConversationId) ? req.body.originConversationId : null
    try {
      let created: SpecAddendum | undefined
      let updated: Ticket | undefined
      let capError: SpecAddendumValidationError | null = null
      const store = mutateStore(ticketPath(req), (s) => {
        const ticket = s.tickets[ticketId]
        if (!ticket) return
        try {
          created = appendSpecAddendum(ticket, buildSpecAddendum(input!, { createdBy, originConversationId }))
          updated = ticket
        } catch (err) {
          if (err instanceof SpecAddendumValidationError) { capError = err; return }
          throw err
        }
      })
      if (capError) { const e = capError as SpecAddendumValidationError; res.status(400).json({ error: 'invalid_addendum', code: e.code, detail: e.message }); return }
      if (!updated || !created) { res.status(404).json({ error: 'Ticket not found' }); return }
      broadcastTicket(req, updated, store.revision)
      // Advisory: what no run can do (impossible gates, frozen artifacts, host access) comes back to the author.
      res.status(201).json({ addendum: created, ticket: updated, revision: store.revision, warnings: lintSpecAddendum(created) })
    } catch (err) {
      console.error('[project-router] addendum create error:', err)
      res.status(500).json({ error: 'Failed to add addendum' })
    }
  })

  // PATCH /:projectId/tickets/:id/addenda/:addendumId — edit content and/or move status (open|dismissed);
  // `force: true` releases an in-flight claim whose run vanished (user escape hatch)
  router.patch('/:projectId/tickets/:id/addenda/:addendumId', (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (!ticketId) return
    const aid = addendumId(req, res)
    if (!aid) return
    const body = req.body ?? {}
    const wantsContent = body.kind !== undefined || body.title !== undefined || body.body !== undefined
    const status = body.status
    if (status !== undefined && status !== 'open' && status !== 'dismissed') {
      res.status(400).json({ error: 'invalid_addendum', code: 'invalid_status', detail: 'status must be open or dismissed' }); return
    }
    if (!wantsContent && status === undefined) { res.status(400).json({ error: 'invalid_addendum', code: 'not_object', detail: 'nothing to change' }); return }
    try {
      let result: SpecAddendum | 'not_found' | 'in_flight' | 'applied' = 'not_found'
      let updated: Ticket | undefined
      let validation: SpecAddendumValidationError | null = null
      const store = mutateStore(ticketPath(req), (s) => {
        const ticket = s.tickets[ticketId]
        if (!ticket) return
        updated = ticket
        if (wantsContent) {
          const current = readSpecAddenda(ticket.addenda).find((a) => a.id === aid)
          if (!current) { result = 'not_found'; return }
          let input
          try {
            input = parseSpecAddendumInput({ kind: body.kind ?? current.kind, title: body.title ?? current.title, body: body.body ?? current.body })
          } catch (err) {
            if (err instanceof SpecAddendumValidationError) { validation = err; return }
            throw err
          }
          result = editSpecAddendum(ticket, aid, input)
          if (typeof result === 'string') return
        }
        if (status !== undefined) result = setSpecAddendumStatus(ticket, aid, status, undefined, { force: body.force === true })
      })
      if (validation) { const e = validation as SpecAddendumValidationError; res.status(400).json({ error: 'invalid_addendum', code: e.code, detail: e.message }); return }
      if (!updated) { res.status(404).json({ error: 'Ticket not found' }); return }
      if (typeof result === 'string') { addendumEditFailure(res, result); return }
      broadcastTicket(req, updated, store.revision)
      res.json({ addendum: result, ticket: updated, revision: store.revision, warnings: result && typeof result === 'object' && 'body' in result ? lintSpecAddendum(result) : [] })
    } catch (err) {
      console.error('[project-router] addendum update error:', err)
      res.status(500).json({ error: 'Failed to update addendum' })
    }
  })

  // DELETE /:projectId/tickets/:id/addenda/:addendumId — remove (never while in flight)
  router.delete('/:projectId/tickets/:id/addenda/:addendumId', (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (!ticketId) return
    const aid = addendumId(req, res)
    if (!aid) return
    try {
      let result: true | 'not_found' | 'in_flight' | 'applied' = 'not_found'
      let updated: Ticket | undefined
      const store = mutateStore(ticketPath(req), (s) => {
        const ticket = s.tickets[ticketId]
        if (!ticket) return
        updated = ticket
        result = removeSpecAddendum(ticket, aid)
      })
      if (!updated) { res.status(404).json({ error: 'Ticket not found' }); return }
      const outcome = result as true | 'not_found' | 'in_flight' | 'applied'
      if (outcome !== true) { addendumEditFailure(res, outcome); return }
      broadcastTicket(req, updated, store.revision)
      res.json({ ok: true, ticket: updated, revision: store.revision })
    } catch (err) {
      console.error('[project-router] addendum delete error:', err)
      res.status(500).json({ error: 'Failed to delete addendum' })
    }
  })
}
