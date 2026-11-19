// Ticket CRUD routes: the list/board view (filters, status groups, paging),
// single read, manual create, field PATCH and soft delete. Validation and
// persistence stay in the ticket store; these handlers map them onto HTTP and
// the ticket_created / ticket_updated / ticket_deleted WebSocket contract.

import { PageCursorError, pageOf, parsePageQuery } from './util/page-cursor'
import type { Request, Response } from 'express'
import { validateNonGoals } from './modules/specs/domain/non-goals'
import { validateSpecIntent } from './modules/specs/domain/intent'
import { softDeleteTicket } from './modules/specs/runtime/ticket-trash'
import { normalizeSpecTitle } from './modules/specs/runtime/spec-title'
import { readStore, mutateStore, filterTickets, isValidStatus, isValidPriority, validatePriorityForStatus, clampShortSummary, normalizeRegressionOfMetadata, type Ticket } from './modules/specs/runtime/ticket-store'
import type { TicketCreatedMessage, TicketUpdatedMessage, TicketDeletedMessage, LocalTicket } from './types'
import { formatDescriptionWithCriteria } from './project-router-helpers'
import { createRepositoryScope, requireTicketIdParam } from './project-router-tickets-shared'
import type { ProjectRoutesDeps } from './project-router-helpers'

/** The client's Undo window (8 s) plus margin: outbound Jira writes of undoable edits wait this long. */
const UNDO_WINDOW_HOLD_MS = 10_000

export function registerTicketCrudRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx, ticketPath } = deps
  const repositoryScope = createRepositoryScope(ctx)

  // GET /:projectId/tickets — List all tickets with optional filters
  router.get('/:projectId/tickets', (req: Request, res: Response) => {
    try {
      const filePath = ticketPath(req)
      const store = readStore(filePath)
      const allTickets = Object.values(store.tickets)
      const filtered = filterTickets(allTickets, {
        status: req.query.status as string | undefined,
        label: req.query.label as string | undefined,
        q: req.query.q as string | undefined,
      })
      // Sort by updated_at descending
      filtered.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      // Optional board view: per-status counts and the newest items of each.
      if (req.query.groupBy === 'status') {
        const requested = Number.parseInt(String(req.query.perGroup ?? '5'), 10)
        const perGroup = Math.min(Math.max(Number.isFinite(requested) ? requested : 5, 0), 50)
        const groups = new Map<string, { status: string; count: number; tickets: typeof filtered }>()
        for (const ticket of filtered) {
          const status = String(ticket.status ?? 'unknown')
          const group = groups.get(status) ?? { status, count: 0, tickets: [] }
          group.count += 1
          if (group.tickets.length < perGroup) group.tickets.push(ticket)
          groups.set(status, group)
        }
        res.json({ groups: [...groups.values()], revision: store.revision, total: allTickets.length, matched: filtered.length, perGroup })
        return
      }
      // Optional paging (limit + cursor/offset); without limit the full list is returned as before.
      const page = parsePageQuery(req.query as Record<string, unknown>, { max: 200, revision: store.revision })
      if (page) {
        const statusCounts: Record<string, number> = {}
        for (const ticket of filtered) statusCounts[String(ticket.status ?? 'unknown')] = (statusCounts[String(ticket.status ?? 'unknown')] ?? 0) + 1
        const { items, ...paging } = pageOf(filtered, page, store.revision)
        res.json({ tickets: items, revision: store.revision, total: allTickets.length, matched: filtered.length, statusCounts, ...paging })
        return
      }
      res.json({ tickets: filtered, revision: store.revision, total: allTickets.length })
    } catch (err) {
      if (err instanceof PageCursorError) { res.status(err.status).json({ error: err.code, message: err.message }); return }
      console.error('[project-router] ticket list error:', err)
      res.status(500).json({ error: 'Failed to read tickets' })
    }
  })

  // GET /:projectId/tickets/:id — Get single ticket
  router.get('/:projectId/tickets/:id', (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (ticketId === null) return
    try {
      const store = readStore(ticketPath(req))
      const ticket = store.tickets[ticketId]
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' }); return
      }
      res.json({ ticket, revision: store.revision })
    } catch (err) {
      console.error('[project-router] ticket get error:', err)
      res.status(500).json({ error: 'Failed to read ticket' })
    }
  })

  // POST /:projectId/tickets — Create new ticket
  router.post('/:projectId/tickets', (req: Request, res: Response) => {
    const { title, description, status, priority, labels, assignee, prerequisites, metadata: rawMetadata, source, nonGoals: rawNonGoals, intent: rawIntent } = req.body ?? {}
    const normalizedTitle = normalizeSpecTitle(title)
    if (!normalizedTitle.ok) {
      res.status(400).json({ error: normalizedTitle.error }); return
    }
    const createNonGoals = rawNonGoals === undefined ? null : validateNonGoals(rawNonGoals)
    if (createNonGoals && !createNonGoals.ok) {
      res.status(400).json({ error: createNonGoals.error }); return
    }
    const createIntent = rawIntent === undefined ? null : validateSpecIntent(rawIntent)
    if (createIntent && !createIntent.ok) {
      res.status(400).json({ error: createIntent.error }); return
    }
    const createRegression = normalizeRegressionOfMetadata(typeof rawMetadata === 'object' && rawMetadata !== null ? rawMetadata : {})
    if (!createRegression.ok) {
      res.status(400).json({ error: createRegression.error }); return
    }
    const metadata = typeof rawMetadata === 'object' && rawMetadata !== null ? createRegression.metadata : undefined
    if (status !== undefined && !isValidStatus(status)) {
      res.status(400).json({ error: 'status must be one of: draft, todo, in_progress, on_review, done, cancelled' }); return
    }
    const finalStatus = (status ?? 'todo') as import('./modules/specs/runtime/ticket-store').TicketStatus
    const finalPriority = priority === undefined ? (finalStatus === 'draft' ? null : 'medium') : (priority === null ? null : priority)
    const priorityError = validatePriorityForStatus(finalStatus, finalPriority as never)
    if (priorityError) {
      res.status(400).json({ error: priorityError }); return
    }
    try {
      const filePath = ticketPath(req)
      const now = new Date().toISOString()
      let created: Ticket | undefined
      const store = mutateStore(filePath, (s) => {
        const id = s.next_id++
        const ticket: Ticket = {
          ...repositoryScope(req, res),
          id,
          title: normalizedTitle.title,
          description: typeof description === 'string' ? description : '',
          status: finalStatus,
          priority: finalPriority as Ticket['priority'],
          labels: Array.isArray(labels) ? labels.filter((l: unknown) => typeof l === 'string') : [],
          assignee: typeof assignee === 'string' ? assignee : null,
          prerequisites: Array.isArray(prerequisites) ? prerequisites.filter((p: unknown) => typeof p === 'number') : [],
          metadata: typeof metadata === 'object' && metadata !== null ? metadata : {},
          comments: [],
          origin_conversation_id: null,
          is_epic: false,
          parent_epic_id: null,
          execution_order: null,
          short_summary: null,
          ...(createNonGoals?.ok && createNonGoals.nonGoals.length ? { nonGoals: createNonGoals.nonGoals } : {}),
          ...(createIntent?.ok && createIntent.intent ? { intent: createIntent.intent } : {}),
          created_at: now,
          updated_at: now,
          created_by: source === 'mcp' ? 'mcp' : 'hub', // 'hub' = legacy on-disk wire value (tickets.json, shared with specrails-core) — do not rename
          source: source === 'product-backlog' || source === 'propose-spec' || source === 'manual' || source === 'mcp' ? source : 'hub', // 'hub' legacy wire value — do not rename
        }
        s.tickets[String(id)] = ticket
        created = ticket
      })
      const { broadcast, ticketWatcher } = ctx(req)
      ticketWatcher.notifyDesktopWrite(store.revision)
      const msg: TicketCreatedMessage = { type: 'ticket_created', ticket: created! as unknown as LocalTicket, projectId: ctx(req).project.id, timestamp: new Date().toISOString() }
      broadcast(msg)
      res.status(201).json({ ticket: created!, revision: store.revision })
    } catch (err) {
      console.error('[project-router] ticket create error:', err)
      res.status(500).json({ error: 'Failed to create ticket' })
    }
  })

  // PATCH /:projectId/tickets/:id — Update ticket fields
  router.patch('/:projectId/tickets/:id', (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (ticketId === null) return
    const { title, description, status, priority, labels, assignee, prerequisites, metadata: rawMetadata, acceptanceCriteria, short_summary, nonGoals: rawNonGoals, intent: rawIntent } = req.body ?? {}
    const patchNonGoals = rawNonGoals === undefined ? null : validateNonGoals(rawNonGoals)
    if (patchNonGoals && !patchNonGoals.ok) {
      res.status(400).json({ error: patchNonGoals.error }); return
    }
    const patchIntent = rawIntent === undefined ? null : validateSpecIntent(rawIntent)
    if (patchIntent && !patchIntent.ok) {
      res.status(400).json({ error: patchIntent.error }); return
    }
    if (status !== undefined && !isValidStatus(status)) {
      res.status(400).json({ error: 'status must be one of: draft, todo, in_progress, on_review, done, cancelled' }); return
    }
    const patchRegression = normalizeRegressionOfMetadata(typeof rawMetadata === 'object' && rawMetadata !== null ? rawMetadata : {})
    if (!patchRegression.ok) {
      res.status(400).json({ error: patchRegression.error }); return
    }
    const metadata = typeof rawMetadata === 'object' && rawMetadata !== null ? patchRegression.metadata : rawMetadata
    if (priority !== undefined && priority !== null && !isValidPriority(priority)) {
      res.status(400).json({ error: 'priority must be one of: critical, high, medium, low' }); return
    }
    const patchTitle = title === undefined ? null : normalizeSpecTitle(title, 'title cannot be empty')
    if (patchTitle && !patchTitle.ok) {
      res.status(400).json({ error: patchTitle.error }); return
    }
    if (acceptanceCriteria !== undefined) {
      if (!Array.isArray(acceptanceCriteria) || !acceptanceCriteria.every((c) => typeof c === 'string')) {
        res.status(400).json({ error: 'acceptanceCriteria must be an array of strings' }); return
      }
    }
    try {
      const filePath = ticketPath(req)
      let updated: Ticket | undefined
      let validationError: string | null = null
      const store = mutateStore(filePath, (s) => {
        const ticket = s.tickets[ticketId]
        if (!ticket) return
        const nextStatus = (status ?? ticket.status) as import('./modules/specs/runtime/ticket-store').TicketStatus
        const nextPriority = priority === undefined ? ticket.priority : (priority === null ? null : priority)
        const err = validatePriorityForStatus(nextStatus, nextPriority as never)
        if (err) { validationError = err; return }
        Object.assign(ticket, repositoryScope(req, res))
        if (patchTitle?.ok) ticket.title = patchTitle.title
        if (description !== undefined) ticket.description = description
        if (acceptanceCriteria !== undefined) {
          // Fold criteria into the description body under a `## Acceptance Criteria`
          // section, replacing any existing one. Use the just-set description if
          // present, otherwise the ticket's current description.
          ticket.description = formatDescriptionWithCriteria(ticket.description ?? '', acceptanceCriteria as string[])
        }
        if (status !== undefined) ticket.status = status
        // Non-goals (3.2): local-only (never a Jira write-back); [] / null clear.
        if (patchNonGoals?.ok) {
          if (patchNonGoals.nonGoals.length) ticket.nonGoals = patchNonGoals.nonGoals
          else delete ticket.nonGoals
        }
        // Intent (intent-mode): local-only like non-goals; null clears.
        if (patchIntent?.ok) {
          if (patchIntent.intent) ticket.intent = patchIntent.intent
          else delete ticket.intent
        }
        if (priority !== undefined) ticket.priority = nextPriority as Ticket['priority']
        if (labels !== undefined && Array.isArray(labels)) ticket.labels = labels.filter((l: unknown) => typeof l === 'string')
        if (assignee !== undefined) ticket.assignee = typeof assignee === 'string' ? assignee : null
        if (prerequisites !== undefined && Array.isArray(prerequisites)) ticket.prerequisites = prerequisites.filter((p: unknown) => typeof p === 'number')
        if (metadata !== undefined && typeof metadata === 'object' && metadata !== null) {
          ticket.metadata = { ...ticket.metadata, ...metadata }
          if (patchRegression.clear) delete ticket.metadata.regressionOf
        }
        // Short summary: explicit non-empty overwrites; explicit null clears;
        // omitted leaves the existing value untouched (preserves prior summary
        // when AI Refine omits it for a partial edit).
        if (short_summary === null) {
          ticket.short_summary = null
        } else if (typeof short_summary === 'string') {
          ticket.short_summary = clampShortSummary(short_summary)
        }
        ticket.updated_at = new Date().toISOString()
        updated = ticket
      })
      if (validationError) {
        res.status(400).json({ error: validationError }); return
      }
      if (!updated) {
        res.status(404).json({ error: 'Ticket not found' }); return
      }
      const { broadcast, ticketWatcher, jiraSyncManager } = ctx(req)
      ticketWatcher.notifyDesktopWrite(store.revision)
      const msg: TicketUpdatedMessage = { type: 'ticket_updated', ticket: updated as unknown as LocalTicket, projectId: ctx(req).project.id, timestamp: new Date().toISOString() }
      broadcast(msg)
      // Write the edited fields back to Jira for Jira-backed specs (no-op
      // otherwise). Uses the FINAL stored values (e.g. acceptance-criteria
      // folding) for the fields that were actually changed. Never breaks the
      // local save — a Jira hiccup only fails the enqueue, which is caught.
      try {
        const u = updated as Ticket
        const changes: { title?: string; description?: string; priority?: string | null; labels?: string[] } = {}
        if (title !== undefined) changes.title = u.title
        if (description !== undefined || acceptanceCriteria !== undefined) changes.description = u.description
        if (priority !== undefined) changes.priority = u.priority ?? null
        if (labels !== undefined) changes.labels = u.labels
        // A label-only edit is undoable for a few seconds in the UI: hold its Jira
        // write past that window so an undone change never reaches Jira.
        const labelsOnly = Object.keys(changes).length === 1 && changes.labels !== undefined
        if (Object.keys(changes).length > 0) jiraSyncManager?.onSpecEdited(Number(ticketId), changes, labelsOnly ? { holdMs: UNDO_WINDOW_HOLD_MS } : {})
      } catch (e) {
        console.error('[project-router] jira write-back enqueue failed:', e)
      }
      res.json({ ticket: updated, revision: store.revision })
    } catch (err) {
      console.error('[project-router] ticket update error:', err)
      res.status(500).json({ error: 'Failed to update ticket' })
    }
  })

  // DELETE /:projectId/tickets/:id — Delete ticket
  // DELETE /:projectId/tickets/:id — soft delete: the spec moves to "Recently
  // deleted" (restorable for 30 days). Attachments, its Explore draft
  // conversation and the Jira link stay untouched until the entry is purged or
  // deleted permanently, so Undo is lossless and Jira never sees a transient
  // delete (a spec delete has never written to Jira).
  router.delete('/:projectId/tickets/:id', (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (ticketId === null) return
    try {
      const result = softDeleteTicket(ticketPath(req), Number(ticketId))
      if (!result) {
        res.status(404).json({ error: 'Ticket not found' }); return
      }
      const { broadcast, ticketWatcher, project } = ctx(req)
      ticketWatcher.notifyDesktopWrite(result.revision)
      // Broadcast ticket_updated for each orphaned child so observers see them
      // as regular tickets (no longer attached to the deleted épica).
      for (const child of result.orphanedChildren) {
        broadcast({
          type: 'ticket_updated',
          ticket: child,
          projectId: project.id,
          timestamp: new Date().toISOString(),
        } as unknown as TicketCreatedMessage)
      }
      const msg: TicketDeletedMessage = { type: 'ticket_deleted', ticketId: Number(ticketId), projectId: project.id, timestamp: new Date().toISOString() }
      broadcast(msg)
      res.json({ ok: true, revision: result.revision, restorable: true })
    } catch (err) {
      console.error('[project-router] ticket delete error:', err)
      res.status(500).json({ error: 'Failed to delete ticket' })
    }
  })
}
