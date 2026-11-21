// Bulk spec operations (MCP v2 `specrails_specs(bulk_update | purge)`, and any
// client that edits a selection at once). The board's bulk bar loops over the
// single-item routes; this route applies one operation to a whole selection
// with the same domain validators, one store write for field edits, per-spec
// WebSocket events and the same Jira write-back, and answers what changed,
// what was skipped and why, plus what an undo needs.
//
//   POST /:projectId/tickets/bulk
//     { op: 'update',  ids, patch }         status, priority, labels, addLabels, removeLabels, assignee, milestone
//     { op: 'update',  items: [{id,patch}] } a different patch per spec (undo of an earlier update)
//     { op: 'trash',   ids }                soft delete (restorable, Recently deleted)
//     { op: 'restore', ids }                back from Recently deleted
//     { op: 'purge',   ids }                delete permanently from Recently deleted
//     { op: 'merge',   targetId, ids }      fold specs into the target, then trash them
//     { op: 'reorder', ids }                execution order = position in ids
//   Optional `expected: { "<id>": "<updated_at>" }` refuses the whole call with
//   409 `stale` when a spec changed since the caller read it.

import type { Request, Response } from 'express'
import { readStore, mutateStore, isValidStatus, isValidPriority, validatePriorityForStatus, type Ticket, type TicketStatus } from './modules/specs/runtime/ticket-store'
import { softDeleteTicket, restoreTicket, purgeTrashedTicket, listTrashedTickets } from './modules/specs/runtime/ticket-trash'
import { finalizeTrashedTicket } from './modules/specs/runtime/ticket-trash-service'
import { milestoneLabelFor } from './modules/builder/runtime/milestone-progress'
import { attachmentManager } from './attachment-manager'
import type { LocalTicket, TicketCreatedMessage, TicketDeletedMessage, TicketUpdatedMessage } from './types'
import type { ProjectRoutesDeps } from './project-router-helpers'

export const BULK_MAX_IDS = 200
export const BULK_OPS = ['update', 'trash', 'restore', 'purge', 'merge', 'reorder'] as const
export type BulkOp = (typeof BULK_OPS)[number]

/** Same hold as a single label-only PATCH: the client's Undo window plus margin. */
const LABEL_UNDO_HOLD_MS = 10_000
const MILESTONE_LABEL = /^M\d{1,3}$/

export interface BulkPatch {
  status?: TicketStatus
  priority?: Ticket['priority']
  labels?: string[]
  addLabels?: string[]
  removeLabels?: string[]
  assignee?: string | null
  /** Milestone number (label `M<n>`); null removes the milestone label. */
  milestone?: number | null
}

export interface BulkSkip { id: number; reason: string }

class BulkInputError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly extra: Record<string, unknown> = {}) { super(message) }
}

const labelList = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((label) => typeof label !== 'string')) throw new BulkInputError('invalid_patch', `${field} must be an array of strings`)
  return [...new Set((value as string[]).map((label) => label.trim()).filter(Boolean))]
}

/** Validates a patch up front (field types only; per-spec rules run against each spec). */
export function parseBulkPatch(raw: unknown): BulkPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BulkInputError('invalid_patch', 'patch must be an object')
  const body = raw as Record<string, unknown>
  const known = new Set(['status', 'priority', 'labels', 'addLabels', 'removeLabels', 'assignee', 'milestone'])
  const unknown = Object.keys(body).filter((key) => !known.has(key))
  if (unknown.length) throw new BulkInputError('invalid_patch', `unsupported patch fields: ${unknown.join(', ')} (bulk edits status, priority, labels, addLabels, removeLabels, assignee, milestone)`)
  const patch: BulkPatch = {}
  if (body.status !== undefined) {
    if (!isValidStatus(body.status)) throw new BulkInputError('invalid_patch', 'status must be one of: draft, todo, in_progress, on_review, done, cancelled')
    patch.status = body.status
  }
  if (body.priority !== undefined) {
    if (body.priority !== null && !isValidPriority(body.priority)) throw new BulkInputError('invalid_patch', 'priority must be one of: critical, high, medium, low')
    patch.priority = body.priority as Ticket['priority']
  }
  if (body.labels !== undefined) patch.labels = labelList(body.labels, 'labels')
  if (body.addLabels !== undefined) patch.addLabels = labelList(body.addLabels, 'addLabels')
  if (body.removeLabels !== undefined) patch.removeLabels = labelList(body.removeLabels, 'removeLabels')
  if (body.assignee !== undefined) {
    if (body.assignee !== null && typeof body.assignee !== 'string') throw new BulkInputError('invalid_patch', 'assignee must be a string or null')
    patch.assignee = body.assignee as string | null
  }
  if (body.milestone !== undefined) {
    if (body.milestone !== null && !(Number.isInteger(body.milestone) && (body.milestone as number) >= 1 && (body.milestone as number) <= 999)) throw new BulkInputError('invalid_patch', 'milestone must be a positive integer or null')
    patch.milestone = body.milestone as number | null
  }
  if (!Object.keys(patch).length) throw new BulkInputError('invalid_patch', 'patch changes nothing')
  return patch
}

function parseIds(raw: unknown, field = 'ids'): number[] {
  if (!Array.isArray(raw) || !raw.length) throw new BulkInputError('invalid_ids', `${field} must be a non-empty array of spec ids`)
  if (raw.length > BULK_MAX_IDS) throw new BulkInputError('too_many', `at most ${BULK_MAX_IDS} specs per call`)
  if (raw.some((id) => !Number.isInteger(id) || (id as number) <= 0)) throw new BulkInputError('invalid_ids', `${field} must hold positive integer spec ids`)
  return [...new Set(raw as number[])]
}

/** The labels a patch leaves on a spec. */
export function patchedLabels(current: readonly string[], patch: BulkPatch): string[] {
  let labels = patch.labels ? [...patch.labels] : [...current]
  if (patch.milestone !== undefined) {
    labels = labels.filter((label) => !MILESTONE_LABEL.test(label))
    if (patch.milestone !== null) labels.push(milestoneLabelFor(patch.milestone))
  }
  if (patch.addLabels) for (const label of patch.addLabels) if (!labels.some((own) => own.toLowerCase() === label.toLowerCase())) labels.push(label)
  if (patch.removeLabels) {
    const drop = new Set(patch.removeLabels.map((label) => label.toLowerCase()))
    labels = labels.filter((label) => !drop.has(label.toLowerCase()))
  }
  return labels
}

const sameLabels = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((label, i) => label === b[i])

/** What an undo of a field edit restores (the edited fields only). */
function previousOf(ticket: Ticket, patch: BulkPatch): Record<string, unknown> {
  const previous: Record<string, unknown> = {}
  if (patch.status !== undefined) previous.status = ticket.status
  if (patch.priority !== undefined) previous.priority = ticket.priority
  if (patch.labels !== undefined || patch.addLabels !== undefined || patch.removeLabels !== undefined || patch.milestone !== undefined) previous.labels = [...ticket.labels]
  if (patch.assignee !== undefined) previous.assignee = ticket.assignee
  return previous
}

function checkExpected(store: { tickets: Record<string, Ticket> }, ids: readonly number[], expected: unknown): void {
  if (expected === undefined || expected === null) return
  if (typeof expected !== 'object' || Array.isArray(expected)) throw new BulkInputError('invalid_expected', 'expected must map spec ids to updated_at')
  const changed = ids.filter((id) => {
    const want = (expected as Record<string, unknown>)[String(id)]
    if (want === undefined) return false
    return store.tickets[String(id)]?.updated_at !== want
  })
  if (changed.length) throw new BulkInputError('stale', `specs changed since they were read: ${changed.join(', ')}`, 409, { changed })
}

/** Appends the merged specs to the target description, one section each. */
export function mergedDescription(target: Ticket, sources: readonly Ticket[]): string {
  const sections = sources.map((source) => [`## Merged from #${source.id}: ${source.title}`, source.description.trim()].filter(Boolean).join('\n\n'))
  return [target.description.trimEnd(), ...sections].filter(Boolean).join('\n\n')
}

export function registerTicketBulkRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx, ticketPath } = deps

  const updated = (req: Request, ticket: Ticket) => {
    const msg: TicketUpdatedMessage = { type: 'ticket_updated', ticket: ticket as unknown as LocalTicket, projectId: ctx(req).project.id, timestamp: new Date().toISOString() }
    ctx(req).broadcast(msg)
  }
  const deleted = (req: Request, id: number) => {
    const msg: TicketDeletedMessage = { type: 'ticket_deleted', ticketId: id, projectId: ctx(req).project.id, timestamp: new Date().toISOString() }
    ctx(req).broadcast(msg)
  }

  function applyUpdate(req: Request, items: Array<{ id: number; patch: BulkPatch }>, expected: unknown) {
    const filePath = ticketPath(req)
    const changedTickets: Ticket[] = []
    const skipped: BulkSkip[] = []
    const previous: Record<string, Record<string, unknown>> = {}
    const jira: Array<{ id: number; changes: { priority?: string | null; labels?: string[] } }> = []
    const store = mutateStore(filePath, (s) => {
      checkExpected(s, items.map((item) => item.id), expected)
      const now = new Date().toISOString()
      for (const { id, patch } of items) {
        const ticket = s.tickets[String(id)]
        if (!ticket) { skipped.push({ id, reason: 'not_found' }); continue }
        const nextStatus = patch.status ?? ticket.status
        const nextPriority = patch.priority === undefined ? ticket.priority : patch.priority
        const invalid = validatePriorityForStatus(nextStatus, nextPriority as never)
        if (invalid) { skipped.push({ id, reason: invalid }); continue }
        const labels = patchedLabels(ticket.labels, patch)
        const labelsChanged = !sameLabels(labels, ticket.labels)
        const changes = patch.status !== undefined && patch.status !== ticket.status
          || patch.priority !== undefined && patch.priority !== ticket.priority
          || labelsChanged
          || patch.assignee !== undefined && patch.assignee !== ticket.assignee
        if (!changes) { skipped.push({ id, reason: 'unchanged' }); continue }
        previous[String(id)] = previousOf(ticket, patch)
        const jiraChanges: { priority?: string | null; labels?: string[] } = {}
        if (patch.status !== undefined) ticket.status = patch.status
        if (patch.priority !== undefined && patch.priority !== ticket.priority) { ticket.priority = patch.priority; jiraChanges.priority = patch.priority ?? null }
        if (labelsChanged) { ticket.labels = labels; jiraChanges.labels = labels }
        if (patch.assignee !== undefined) ticket.assignee = patch.assignee
        ticket.updated_at = now
        changedTickets.push(ticket)
        if (Object.keys(jiraChanges).length) jira.push({ id, changes: jiraChanges })
      }
    })
    const { ticketWatcher, jiraSyncManager } = ctx(req)
    if (changedTickets.length) ticketWatcher.notifyDesktopWrite(store.revision)
    for (const ticket of changedTickets) updated(req, ticket)
    // Jira-backed specs get the same write-back a single edit queues (no-op for local specs).
    for (const { id, changes } of jira) {
      try {
        const labelsOnly = Object.keys(changes).length === 1 && changes.labels !== undefined
        jiraSyncManager?.onSpecEdited(id, changes, labelsOnly ? { holdMs: LABEL_UNDO_HOLD_MS } : {})
      } catch (err) {
        console.error('[tickets-bulk] jira write-back enqueue failed:', err)
      }
    }
    return { changed: changedTickets.map((ticket) => ticket.id), skipped, previous, tickets: changedTickets, revision: store.revision }
  }

  function applyTrash(req: Request, ids: number[], expected: unknown) {
    const filePath = ticketPath(req)
    checkExpected(readStore(filePath), ids, expected)
    const changed: number[] = []
    const skipped: BulkSkip[] = []
    let revision = readStore(filePath).revision
    for (const id of ids) {
      const result = softDeleteTicket(filePath, id)
      if (!result) { skipped.push({ id, reason: 'not_found' }); continue }
      if (result.alreadyTrashed) { skipped.push({ id, reason: 'already_trashed' }); continue }
      revision = result.revision
      changed.push(id)
      for (const child of result.orphanedChildren) updated(req, child)
      deleted(req, id)
    }
    if (changed.length) ctx(req).ticketWatcher.notifyDesktopWrite(revision)
    return { changed, skipped, revision }
  }

  function applyRestore(req: Request, ids: number[]) {
    const filePath = ticketPath(req)
    const changed: number[] = []
    const skipped: BulkSkip[] = []
    let revision = readStore(filePath).revision
    const now = new Date().toISOString()
    for (const id of ids) {
      const result = restoreTicket(filePath, id)
      if (!result) { skipped.push({ id, reason: 'not_found' }); continue }
      if (result.alreadyLive) { skipped.push({ id, reason: 'already_live' }); continue }
      revision = result.revision
      changed.push(id)
      ctx(req).broadcast({ type: 'ticket_created', ticket: result.ticket, projectId: ctx(req).project.id, timestamp: now } as unknown as TicketCreatedMessage)
      for (const child of result.readoptedChildren) updated(req, child)
    }
    if (changed.length) ctx(req).ticketWatcher.notifyDesktopWrite(revision)
    return { changed, skipped, revision }
  }

  async function applyPurge(req: Request, ids: number[]) {
    const filePath = ticketPath(req)
    const c = ctx(req)
    const finalizeDeps = {
      ticketStorePath: () => filePath,
      db: c.db,
      deleteAttachments: (key: string) => attachmentManager.deleteAll(c.project.slug, key),
      forgetExploreConversation: (conversationId: string) => {
        c.chatManager?.forgetSpecDraft(conversationId)
        c.chatManager?.forgetExploreLifecycle(conversationId)
      },
    }
    const trashed = new Set(listTrashedTickets(filePath).map((entry) => entry.ticket.id))
    const changed: number[] = []
    const skipped: BulkSkip[] = []
    for (const id of ids) {
      if (!trashed.has(id)) { skipped.push({ id, reason: 'not_in_trash' }); continue }
      const entry = purgeTrashedTicket(filePath, id)
      if (!entry) { skipped.push({ id, reason: 'not_in_trash' }); continue }
      await finalizeTrashedTicket(finalizeDeps, entry)
      changed.push(id)
    }
    return { changed, skipped, revision: readStore(filePath).revision }
  }

  function applyMerge(req: Request, targetId: number, ids: number[], expected: unknown) {
    const filePath = ticketPath(req)
    if (ids.includes(targetId)) throw new BulkInputError('invalid_ids', 'the merge target cannot also be a source')
    const before = readStore(filePath)
    checkExpected(before, [targetId, ...ids], expected)
    const missing = [targetId, ...ids].filter((id) => !before.tickets[String(id)])
    if (missing.length) throw new BulkInputError('not_found', `specs not found: ${missing.join(', ')}`, 404, { missing })
    const busy = [targetId, ...ids].filter((id) => before.tickets[String(id)].status === 'in_progress')
    if (busy.length) throw new BulkInputError('spec_in_progress', `a running spec cannot be merged: ${busy.join(', ')}`, 409, { busy })
    const merged = new Set(ids)
    const touched: Ticket[] = []
    let target: Ticket | undefined
    mutateStore(filePath, (s) => {
      const now = new Date().toISOString()
      target = s.tickets[String(targetId)]
      const sources = ids.map((id) => s.tickets[String(id)]).filter(Boolean)
      target.description = mergedDescription(target, sources)
      target.labels = patchedLabels(target.labels, { addLabels: sources.flatMap((source) => source.labels) })
      target.prerequisites = [...new Set([...target.prerequisites, ...sources.flatMap((source) => source.prerequisites)])]
        .filter((id) => id !== targetId && !merged.has(id))
      target.updated_at = now
      // Specs that depended on a merged spec now depend on the target.
      for (const other of Object.values(s.tickets)) {
        if (other.id === targetId || merged.has(other.id) || !other.prerequisites.some((id) => merged.has(id))) continue
        other.prerequisites = [...new Set(other.prerequisites.map((id) => merged.has(id) ? targetId : id))].filter((id) => id !== other.id)
        other.updated_at = now
        touched.push(other)
      }
    })
    updated(req, target!)
    for (const other of touched) updated(req, other)
    const trash = applyTrash(req, ids, undefined)
    return { changed: [targetId, ...trash.changed], skipped: trash.skipped, target: target!, revision: trash.revision }
  }

  function applyReorder(req: Request, ids: number[], expected: unknown) {
    const filePath = ticketPath(req)
    const changedTickets: Ticket[] = []
    const skipped: BulkSkip[] = []
    const previous: Record<string, Record<string, unknown>> = {}
    const store = mutateStore(filePath, (s) => {
      checkExpected(s, ids, expected)
      const now = new Date().toISOString()
      ids.forEach((id, index) => {
        const ticket = s.tickets[String(id)]
        if (!ticket) { skipped.push({ id, reason: 'not_found' }); return }
        if (ticket.execution_order === index + 1) { skipped.push({ id, reason: 'unchanged' }); return }
        previous[String(id)] = { executionOrder: ticket.execution_order }
        ticket.execution_order = index + 1
        ticket.updated_at = now
        changedTickets.push(ticket)
      })
    })
    if (changedTickets.length) ctx(req).ticketWatcher.notifyDesktopWrite(store.revision)
    for (const ticket of changedTickets) updated(req, ticket)
    return { changed: changedTickets.map((ticket) => ticket.id), skipped, previous, revision: store.revision }
  }

  router.post('/:projectId/tickets/bulk', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const op = body.op
    try {
      if (typeof op !== 'string' || !(BULK_OPS as readonly string[]).includes(op)) throw new BulkInputError('invalid_op', `op must be one of: ${BULK_OPS.join(', ')}`)
      switch (op as BulkOp) {
        case 'update': {
          let items: Array<{ id: number; patch: BulkPatch }>
          if (body.items !== undefined) {
            if (!Array.isArray(body.items) || !body.items.length || body.items.length > BULK_MAX_IDS) throw new BulkInputError('invalid_items', `items must be 1..${BULK_MAX_IDS} { id, patch } entries`)
            const ids = parseIds(body.items.map((item) => (item as { id?: unknown })?.id), 'items[].id')
            if (ids.length !== body.items.length) throw new BulkInputError('invalid_items', 'items name a spec twice')
            items = body.items.map((item) => ({ id: (item as { id: number }).id, patch: parseBulkPatch((item as { patch?: unknown }).patch) }))
          } else {
            const patch = parseBulkPatch(body.patch)
            items = parseIds(body.ids).map((id) => ({ id, patch }))
          }
          const out = applyUpdate(req, items, body.expected)
          res.json({ op, changed: out.changed, skipped: out.skipped, previous: out.previous, tickets: out.tickets, revision: out.revision })
          return
        }
        case 'trash': { res.json({ op, ...applyTrash(req, parseIds(body.ids), body.expected), restorable: true }); return }
        case 'restore': { res.json({ op, ...applyRestore(req, parseIds(body.ids)) }); return }
        case 'purge': { res.json({ op, ...await applyPurge(req, parseIds(body.ids)) }); return }
        case 'merge': {
          if (!Number.isInteger(body.targetId) || (body.targetId as number) <= 0) throw new BulkInputError('invalid_ids', 'targetId must be a spec id')
          const out = applyMerge(req, body.targetId as number, parseIds(body.ids), body.expected)
          res.json({ op, ...out })
          return
        }
        case 'reorder': { res.json({ op, ...applyReorder(req, parseIds(body.ids), body.expected) }); return }
      }
    } catch (err) {
      if (err instanceof BulkInputError) { res.status(err.status).json({ error: err.code, detail: err.message, ...err.extra }); return }
      console.error('[tickets-bulk] bulk operation failed:', err)
      res.status(500).json({ error: 'Failed to apply the bulk operation' })
    }
  })
}
