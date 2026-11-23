// Ticket "Recently deleted" routes: list the soft-deleted specs (purging
// expired ones first), restore one, or delete one permanently. Owns the
// trash-service dependency binding for a request. Registered by
// registerTicketsRoutes before GET /tickets/:id so `trash` is never read as a
// ticket id, and before the two-segment DELETE routes it would shadow.

import type { Request, Response } from 'express'
import { restoreTicket, listTrashedTickets, purgeTrashedTicket, TRASH_RETENTION_DAYS, TRASH_RETENTION_MS } from './modules/specs/runtime/ticket-trash'
import { finalizeTrashedTicket, purgeProjectTrash } from './modules/specs/runtime/ticket-trash-service'
import type { TicketCreatedMessage } from './types'
import { attachmentManager } from './attachment-manager'
import { requireTicketIdParam } from './project-router-tickets-shared'
import type { ProjectRoutesDeps } from './project-router-helpers'

export function registerTicketTrashRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx, ticketPath } = deps

  const trashDeps = (req: Request) => {
    const c = ctx(req)
    return {
      ticketStorePath: () => ticketPath(req),
      db: c.db,
      deleteAttachments: (key: string) => attachmentManager.deleteAll(c.project.slug, key),
      forgetExploreConversation: (conversationId: string) => {
        c.chatManager?.forgetSpecDraft(conversationId)
        c.chatManager?.forgetExploreLifecycle(conversationId)
      },
    }
  }

  // GET /:projectId/tickets/trash — "Recently deleted" specs (newest first).
  router.get('/:projectId/tickets/trash', async (req: Request, res: Response) => {
    try {
      await purgeProjectTrash(trashDeps(req))
      const items = listTrashedTickets(ticketPath(req)).map((e) => ({
        ticket: e.ticket,
        deletedAt: e.deleted_at,
        purgeAt: new Date(Date.parse(e.deleted_at) + TRASH_RETENTION_MS).toISOString(),
      }))
      res.json({ items, retentionDays: TRASH_RETENTION_DAYS })
    } catch (err) {
      console.error('[project-router] ticket trash list error:', err)
      res.status(500).json({ error: 'Failed to read recently deleted specs' })
    }
  })

  // POST /:projectId/tickets/:id/restore — Undo a delete. Idempotent.
  router.post('/:projectId/tickets/:id/restore', (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (ticketId === null) return
    try {
      const result = restoreTicket(ticketPath(req), Number(ticketId))
      if (!result) {
        res.status(404).json({ error: 'Ticket not found in recently deleted' }); return
      }
      const { broadcast, ticketWatcher, project } = ctx(req)
      if (!result.alreadyLive) {
        ticketWatcher.notifyDesktopWrite(result.revision)
        const now = new Date().toISOString()
        broadcast({ type: 'ticket_created', ticket: result.ticket, projectId: project.id, timestamp: now } as unknown as TicketCreatedMessage)
        for (const child of result.readoptedChildren) {
          broadcast({ type: 'ticket_updated', ticket: child, projectId: project.id, timestamp: now } as unknown as TicketCreatedMessage)
        }
      }
      res.json({ ok: true, ticket: result.ticket, revision: result.revision, alreadyLive: result.alreadyLive })
    } catch (err) {
      console.error('[project-router] ticket restore error:', err)
      res.status(500).json({ error: 'Failed to restore ticket' })
    }
  })

  // DELETE /:projectId/tickets/trash/:id — "Delete permanently" (the one confirmed step).
  router.delete('/:projectId/tickets/trash/:id', async (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (ticketId === null) return
    try {
      const entry = purgeTrashedTicket(ticketPath(req), Number(ticketId))
      if (!entry) {
        res.status(404).json({ error: 'Ticket not found in recently deleted' }); return
      }
      await finalizeTrashedTicket(trashDeps(req), entry)
      res.json({ ok: true })
    } catch (err) {
      console.error('[project-router] ticket permanent delete error:', err)
      res.status(500).json({ error: 'Failed to delete ticket permanently' })
    }
  })
}
