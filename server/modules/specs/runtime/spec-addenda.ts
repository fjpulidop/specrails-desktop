// ─── Spec addenda — the Node half (ids, hashing, ticket-store lifecycle) ─────
// See server/modules/specs/runtime/spec-addenda-core.ts for the contract and the WHY. This module
// owns everything that touches the ticket store: creating/editing addenda on a
// ticket, CLAIMING them for a launch (open → in_flight), SETTLING them when the
// job/run ends (in_flight → applied, or back to open on failure/cancel) and
// REOPENING them when a delivery is discarded. Every mutation goes through
// `mutateStore` (advisory lock + atomic rename) and never touches any other
// ticket field — in particular never `description`.
import { createHash } from 'crypto'
import { newId } from '../../../ids'
import { mutateStore, readStore, resolveTicketStoragePath, type Ticket, type TicketStore } from './ticket-store'
import { resolveProjectExecution } from '../../../workspace-resolution'
import {
  addendumCanonicalContent,
  injectableAddenda,
  readSpecAddenda,
  renderSpecAddendaBriefing,
  snapshotSpecAddenda,
  SPEC_ADDENDA_MAX_PER_TICKET,
  SpecAddendumValidationError,
  type SpecAddendaBriefingEntry,
  type SpecAddendaSnapshotEntry,
  type SpecAddendum,
  type SpecAddendumInput,
} from './spec-addenda-core'

export * from './spec-addenda-core'

export function specAddendumHash(input: SpecAddendumInput): string {
  return createHash('sha256').update(addendumCanonicalContent(input)).digest('hex')
}

/** The ticket store a project's addenda live in (workspace when relocated, else the repo). */
export function ticketStorePathForProject(project: { slug: string; path: string }): string {
  const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
  return exec.relocated ? exec.ticketsPath : resolveTicketStoragePath(project.path)
}

export interface CreateSpecAddendumMeta {
  createdBy: string
  originConversationId?: string | null
  now?: string
}

export function buildSpecAddendum(input: SpecAddendumInput, meta: CreateSpecAddendumMeta): SpecAddendum {
  const now = meta.now ?? new Date().toISOString()
  return {
    id: newId(),
    version: 1,
    kind: input.kind,
    title: input.title,
    body: input.body,
    status: 'open',
    hash: specAddendumHash(input),
    created_at: now,
    updated_at: now,
    created_by: meta.createdBy,
    origin_conversation_id: meta.originConversationId ?? null,
    run_id: null,
    applied_at: null,
  }
}

/** Append an addendum to a ticket inside an open store mutation. Throws the typed cap error. */
export function appendSpecAddendum(ticket: Ticket, addendum: SpecAddendum): SpecAddendum {
  const addenda = readSpecAddenda(ticket.addenda)
  if (addenda.length >= SPEC_ADDENDA_MAX_PER_TICKET) {
    throw new SpecAddendumValidationError('too_many_addenda', `a spec carries at most ${SPEC_ADDENDA_MAX_PER_TICKET} addenda`)
  }
  addenda.push(addendum)
  ticket.addenda = addenda
  ticket.updated_at = addendum.updated_at
  return addendum
}

export type SpecAddendumEditError = 'not_found' | 'in_flight' | 'applied'

/**
 * Edit an addendum's content (kind/title/body) in place. Only `open` and
 * `dismissed` addenda are editable: an in-flight one is frozen inside a running
 * generation and an applied one is history — the hash proves what a run got.
 */
export function editSpecAddendum(ticket: Ticket, addendumId: string, input: SpecAddendumInput, now = new Date().toISOString()): SpecAddendum | SpecAddendumEditError {
  const addenda = readSpecAddenda(ticket.addenda)
  const target = addenda.find((a) => a.id === addendumId)
  if (!target) return 'not_found'
  if (target.status === 'in_flight') return 'in_flight'
  if (target.status === 'applied') return 'applied'
  target.kind = input.kind
  target.title = input.title
  target.body = input.body
  target.hash = specAddendumHash(input)
  target.updated_at = now
  ticket.addenda = addenda
  ticket.updated_at = now
  return target
}

export type SpecAddendumStatusTarget = 'open' | 'dismissed'

/**
 * User-driven status moves: dismiss an open/applied addendum, or reopen a
 * dismissed/applied one so the next launch carries it again. An in-flight
 * addendum belongs to its run until that run settles.
 */
export function setSpecAddendumStatus(ticket: Ticket, addendumId: string, status: SpecAddendumStatusTarget, now = new Date().toISOString(), opts?: { force?: boolean }): SpecAddendum | SpecAddendumEditError {
  const addenda = readSpecAddenda(ticket.addenda)
  const target = addenda.find((a) => a.id === addendumId)
  if (!target) return 'not_found'
  // `force` is the user's escape hatch for a run that vanished without a
  // terminal callback (a purged job, a lost process): it releases the claim.
  // Never taken by the automatic paths — only an explicit PATCH { force }.
  if (target.status === 'in_flight' && !opts?.force) return 'in_flight'
  if (target.status !== status) {
    target.status = status
    if (status === 'open') { target.run_id = null; target.applied_at = null }
    target.updated_at = now
    ticket.updated_at = now
  }
  ticket.addenda = addenda
  return target
}

export function removeSpecAddendum(ticket: Ticket, addendumId: string, now = new Date().toISOString()): true | SpecAddendumEditError {
  const addenda = readSpecAddenda(ticket.addenda)
  const target = addenda.find((a) => a.id === addendumId)
  if (!target) return 'not_found'
  if (target.status === 'in_flight') return 'in_flight'
  ticket.addenda = addenda.filter((a) => a.id !== addendumId)
  ticket.updated_at = now
  return true
}

// ─── Launch-time plan / claim ────────────────────────────────────────────────

/** Read (no mutation) the addenda a launch of these tickets would carry. */
export function planSpecAddenda(store: TicketStore, ticketIds: readonly number[], runId?: string | null): SpecAddendaBriefingEntry[] {
  const entries: SpecAddendaBriefingEntry[] = []
  for (const ticketId of ticketIds) {
    const ticket = store.tickets[String(ticketId)]
    if (!ticket) continue
    const addenda = injectableAddenda(readSpecAddenda(ticket.addenda), runId)
    if (addenda.length === 0) continue
    entries.push({ ticketId, title: ticket.title ?? null, status: ticket.status ?? null, addenda: addenda.map((a) => ({ ...a })) })
  }
  return entries
}

export function planSpecAddendaAt(storePath: string, ticketIds: readonly number[], runId?: string | null): SpecAddendaBriefingEntry[] {
  try {
    return planSpecAddenda(readStore(storePath), ticketIds, runId)
  } catch {
    return []
  }
}

/**
 * Claim the planned addenda for a run inside an open store mutation: open →
 * in_flight with `run_id`. Idempotent for the same run (a resume re-claims its
 * own). Returns the ticket ids whose addenda changed (for broadcasts).
 */
export function claimSpecAddenda(store: TicketStore, entries: readonly SpecAddendaBriefingEntry[], runId: string, now = new Date().toISOString()): number[] {
  const changed: number[] = []
  for (const entry of entries) {
    const ticket = store.tickets[String(entry.ticketId)]
    if (!ticket) continue
    const addenda = readSpecAddenda(ticket.addenda)
    const wanted = new Set(entry.addenda.map((a) => a.id))
    let touched = false
    for (const a of addenda) {
      if (!wanted.has(a.id)) continue
      if (a.status === 'in_flight' && a.run_id === runId) continue
      if (a.status !== 'open' && a.status !== 'in_flight') continue
      a.status = 'in_flight'
      a.run_id = runId
      a.updated_at = now
      touched = true
    }
    if (touched) {
      ticket.addenda = addenda
      ticket.updated_at = now
      changed.push(entry.ticketId)
    }
  }
  return changed
}

/** One-shot: plan + claim + render. What every launch door calls with the run/job id it just allocated. */
export interface ClaimedSpecAddenda {
  entries: SpecAddendaBriefingEntry[]
  snapshot: SpecAddendaSnapshotEntry[]
  briefing: string
  /** Ticket ids whose addenda moved to in_flight (broadcast `ticket_updated`). */
  changedTicketIds: number[]
  store: TicketStore | null
}

export const NO_SPEC_ADDENDA: ClaimedSpecAddenda = { entries: [], snapshot: [], briefing: '', changedTicketIds: [], store: null }

export function claimSpecAddendaForRun(
  storePath: string,
  ticketIds: readonly number[],
  runId: string,
  opts?: { plan?: SpecAddendaBriefingEntry[]; now?: string },
): ClaimedSpecAddenda {
  if (ticketIds.length === 0) return NO_SPEC_ADDENDA
  let entries: SpecAddendaBriefingEntry[] = []
  let changedTicketIds: number[] = []
  let store: TicketStore | null = null
  try {
    // A quick read first: most launches carry no addenda and must not take the
    // store lock or rewrite the file for nothing.
    const preview = opts?.plan ?? planSpecAddendaAt(storePath, ticketIds, runId)
    if (preview.length === 0) return NO_SPEC_ADDENDA
    store = mutateStore(storePath, (s) => {
      // Re-plan under the lock so a concurrent edit between read and claim can
      // neither inject a stale body nor leave an addendum half-claimed. An
      // explicit plan (a launch that froze the set earlier) is honoured as-is.
      entries = opts?.plan
        ? opts.plan.filter((e) => Boolean(s.tickets[String(e.ticketId)]))
        : planSpecAddenda(s, ticketIds, runId)
      changedTicketIds = claimSpecAddenda(s, entries, runId, opts?.now)
    })
  } catch (err) {
    console.warn(`[spec-addenda] claim failed for run ${runId}: ${(err as Error).message}`)
    return NO_SPEC_ADDENDA
  }
  if (entries.length === 0) return NO_SPEC_ADDENDA
  return { entries, snapshot: snapshotSpecAddenda(entries), briefing: renderSpecAddendaBriefing(entries), changedTicketIds, store }
}

// ─── Settle / reopen ─────────────────────────────────────────────────────────

export type SpecAddendaSettleOutcome = 'completed' | 'failed' | 'canceled' | 'zombie_terminated'

/**
 * Settle the addenda a run claimed, inside an open store mutation. The run id
 * is the causal key: only addenda that are in_flight FOR THIS RUN move —
 * `completed` ⇒ applied, anything else ⇒ back to open so the next launch
 * carries them again. Returns the ticket ids that changed.
 */
export function settleSpecAddenda(store: TicketStore, ticketIds: readonly number[], runId: string, outcome: SpecAddendaSettleOutcome, now = new Date().toISOString()): number[] {
  const changed: number[] = []
  for (const ticketId of ticketIds) {
    const ticket = store.tickets[String(ticketId)]
    if (!ticket) continue
    const addenda = readSpecAddenda(ticket.addenda)
    let touched = false
    for (const a of addenda) {
      if (a.status !== 'in_flight' || a.run_id !== runId) continue
      if (outcome === 'completed') {
        a.status = 'applied'
        a.applied_at = now
      } else {
        a.status = 'open'
        a.run_id = null
      }
      a.updated_at = now
      touched = true
    }
    if (touched) {
      ticket.addenda = addenda
      ticket.updated_at = now
      changed.push(ticketId)
    }
  }
  return changed
}

export function settleSpecAddendaAt(storePath: string, ticketIds: readonly number[], runId: string, outcome: SpecAddendaSettleOutcome): { changedTicketIds: number[]; store: TicketStore | null } {
  if (ticketIds.length === 0) return { changedTicketIds: [], store: null }
  try {
    // Read-only probe first: settling a run whose specs never carried addenda
    // must not take the lock or rewrite the store.
    const probe = readStore(storePath)
    const pending = ticketIds.some((id) => readSpecAddenda(probe.tickets[String(id)]?.addenda).some((a) => a.status === 'in_flight' && a.run_id === runId))
    if (!pending) return { changedTicketIds: [], store: null }
    let changedTicketIds: number[] = []
    const store = mutateStore(storePath, (s) => { changedTicketIds = settleSpecAddenda(s, ticketIds, runId, outcome) })
    return { changedTicketIds, store }
  } catch (err) {
    console.warn(`[spec-addenda] settle failed for run ${runId}: ${(err as Error).message}`)
    return { changedTicketIds: [], store: null }
  }
}

/**
 * A discarded delivery destroyed the work its addenda were applied by: reopen
 * exactly those (by id, from the delivery's frozen snapshot) so the next launch
 * carries them again. Inside an open store mutation. Returns changed ticket ids.
 */
export function reopenSpecAddenda(store: TicketStore, snapshot: readonly SpecAddendaSnapshotEntry[], now = new Date().toISOString()): number[] {
  const changed: number[] = []
  const byTicket = new Map<number, Set<string>>()
  for (const entry of snapshot) {
    const set = byTicket.get(entry.ticketId) ?? new Set<string>()
    set.add(entry.id)
    byTicket.set(entry.ticketId, set)
  }
  for (const [ticketId, ids] of byTicket) {
    const ticket = store.tickets[String(ticketId)]
    if (!ticket) continue
    const addenda = readSpecAddenda(ticket.addenda)
    let touched = false
    for (const a of addenda) {
      if (!ids.has(a.id) || a.status !== 'applied') continue
      a.status = 'open'
      a.run_id = null
      a.applied_at = null
      a.updated_at = now
      touched = true
    }
    if (touched) {
      ticket.addenda = addenda
      ticket.updated_at = now
      changed.push(ticketId)
    }
  }
  return changed
}

// ─── Broadcast ──────────────────────────────────────────────────────────────

/** Re-broadcast every ticket whose addenda a claim/settle moved (best-effort). */
export function broadcastSpecAddendaChange(
  broadcast: (msg: { type: 'ticket_updated'; ticket: unknown; projectId: string; timestamp: string }) => void,
  projectId: string,
  result: { changedTicketIds: number[]; store: TicketStore | null },
): void {
  if (!result.store) return
  for (const tid of result.changedTicketIds) {
    const ticket = result.store.tickets[String(tid)]
    if (!ticket) continue
    try {
      broadcast({ type: 'ticket_updated', ticket, projectId, timestamp: ticket.updated_at })
    } catch { /* the file mutation is authoritative */ }
  }
}
