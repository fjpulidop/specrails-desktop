import type { DbInstance } from './db'
import {
  boundPrDiagnostic,
  getPrDelivery,
  transitionClaimedDecision,
  transitionDecision,
  type PrDecision,
  type PrDeliveryPatch,
  type PrDeliveryStatusCode,
} from './rail-pr-store'
import { mutateStore, resolveTicketStoragePath } from './ticket-store'
import { resolveProjectExecution } from './workspace-resolution'
import type { TicketUpdatedMessage, WsMessage } from './types'

export interface RailPrTicketEffect {
  deliveryId: string
  ticketIds: number[]
  targetStatus: 'todo' | 'done'
  jiraAction: 'discard' | 'merged' | 'completed' | 'refine' | 'backlog'
  prUrl: string | null
}

interface RailPrTicketEffectRow {
  delivery_id: string
  ticket_ids: string
  causal_owners: string
  applied_ticket_ids: string | null
  target_status: 'todo' | 'done'
  jira_action: 'discard' | 'merged' | 'completed' | 'refine' | 'backlog'
  pr_url: string | null
  attempts: number
  last_error: string | null
  tickets_applied_at: string | null
  jira_enqueued_at: string | null
  completed_at: string | null
}

export interface RailPrTicketEffectDeps {
  db: DbInstance
  project: { id: string; slug: string; path: string }
  broadcast: (message: WsMessage) => void
  jiraSyncManager?: {
    /** Current JiraSyncManager returns a durable-enqueue acknowledgement.
     * `void` remains accepted for older/injected implementations whose return
     * value was historically ignored. */
    onRailMerged(ticketIds: number[], refId: string, prUrl: string | null): boolean | void
    onRailDiscard(ticketIds: number[], refId: string): boolean | void
    onRailCompleted?(ticketIds: number[], refId: string): boolean | void
    onRailRefined?(ticketIds: number[], refId: string): boolean | void
    onRailBacklog?(ticketIds: number[], refId: string): boolean | void
  }
  ticketFile?: string
}

/** Commit the terminal decision and its external ticket-file intent together. */
export function transitionClaimedDecisionWithTicketEffect(
  db: DbInstance,
  id: string,
  expected: PrDecision,
  next: PrDecision,
  operationToken: string,
  patch: PrDeliveryPatch,
  effect: RailPrTicketEffect,
): boolean {
  return db.transaction(() => {
    if (!transitionClaimedDecision(db, id, expected, next, operationToken, patch)) return false
    const ownerQuery = db.prepare(`SELECT owner_id FROM ticket_outcome_ownership WHERE ticket_id = ?`)
    const causalOwners = Object.fromEntries(effect.ticketIds.map((ticketId) => {
      const current = ownerQuery.get(ticketId) as { owner_id: string } | undefined
      return [String(ticketId), current?.owner_id ?? null]
    }))
    db.prepare(`
      INSERT INTO rail_pr_ticket_effects (
        delivery_id, ticket_ids, causal_owners, target_status, jira_action, pr_url
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      effect.deliveryId,
      JSON.stringify(effect.ticketIds),
      JSON.stringify(causalOwners),
      effect.targetStatus,
      effect.jiraAction,
      effect.prUrl,
    )
    return true
  })()
}

function resolveTicketFile(deps: RailPrTicketEffectDeps): string {
  if (deps.ticketFile) return deps.ticketFile
  const execution = resolveProjectExecution({ slug: deps.project.slug, path: deps.project.path })
  return execution.relocated ? execution.ticketsPath : resolveTicketStoragePath(deps.project.path)
}

function parseTicketIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
  } catch {
    return []
  }
}

function parseCausalOwners(raw: string): Record<string, string | null> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter(([ticketId, owner]) => /^\d+$/.test(ticketId) && (owner === null || typeof owner === 'string'))
      .map(([ticketId, owner]) => [ticketId, owner as string | null]))
  } catch {
    return {}
  }
}

function clearPendingWarning(db: DbInstance, deliveryId: string): void {
  const delivery = getPrDelivery(db, deliveryId)
  if (!delivery) return
  let warnings: string[] = []
  try {
    const parsed = JSON.parse(delivery.cleanup_warnings) as unknown
    if (Array.isArray(parsed)) warnings = parsed.filter((value): value is string => typeof value === 'string')
  } catch { /* a malformed warning set is safely normalized below */ }
  const remaining = warnings.filter((warning) => !warning.startsWith('ticket status update pending:'))
  if (remaining.length === warnings.length) return
  const restored: PrDeliveryStatusCode = delivery.decision === 'completed'
    ? 'no_changes'
    : delivery.decision === 'merged'
      ? 'merged'
      : delivery.decision === 'discarded'
        ? 'discarded'
        : delivery.status_code ?? 'cleanup_incomplete'
  transitionDecision(db, delivery.id, delivery.decision, delivery.decision, {
    cleanupWarnings: remaining,
    statusCode: remaining.length > 0 ? 'cleanup_incomplete' : restored,
  })
}

export interface RailPrTicketEffectResult {
  ok: boolean
  changedTicketIds: number[]
  error?: string
}

function recordEffectFailure(
  db: DbInstance,
  deliveryId: string,
  error: unknown,
  changedTicketIds: number[],
): RailPrTicketEffectResult {
  const detail = boundPrDiagnostic(error instanceof Error ? error.message : String(error))
  db.prepare(`
    UPDATE rail_pr_ticket_effects
       SET attempts = attempts + 1, last_error = ?, updated_at = datetime('now')
     WHERE delivery_id = ? AND completed_at IS NULL
  `).run(detail, deliveryId)
  const delivery = getPrDelivery(db, deliveryId)
  if (delivery) {
    let warnings: string[] = []
    try {
      const parsed = JSON.parse(delivery.cleanup_warnings) as unknown
      if (Array.isArray(parsed)) warnings = parsed.filter((value): value is string => typeof value === 'string')
    } catch { /* normalize malformed historical warnings */ }
    const warning = `ticket status update pending: ${detail}`
    const withoutOlderPending = warnings.filter((value) => !value.startsWith('ticket status update pending:'))
    transitionDecision(db, delivery.id, delivery.decision, delivery.decision, {
      cleanupWarnings: [...withoutOlderPending, warning].slice(-8),
      statusCode: 'cleanup_incomplete',
    })
  }
  return { ok: false, changedTicketIds, error: detail }
}

/**
 * Freeze the exact tickets that were still on_review before crossing the
 * SQLite→JSON boundary. The conditional write makes concurrent/replayed
 * applicators converge on the first durable selection. It deliberately runs
 * while mutateStore holds the ticket-file lock and before that callback
 * changes the in-memory statuses, so a crash can leave either:
 *
 *   selected ids + old JSON  → replay applies them, or
 *   selected ids + new JSON  → replay keeps the ids for Jira.
 */
function selectAppliedTicketIds(
  db: DbInstance,
  deliveryId: string,
  candidateIds: number[],
  causalOwners: Record<string, string | null>,
  tickets: Record<string, { status?: string }>,
): number[] {
  const current = db.prepare(`
    SELECT applied_ticket_ids FROM rail_pr_ticket_effects WHERE delivery_id = ?
  `).get(deliveryId) as { applied_ticket_ids: string | null } | undefined
  if (!current) throw new Error(`ticket effect ${deliveryId} disappeared`)
  if (current.applied_ticket_ids !== null) return parseTicketIds(current.applied_ticket_ids)

  const ownerQuery = db.prepare(`SELECT owner_id FROM ticket_outcome_ownership WHERE ticket_id = ?`)
  const selected = candidateIds.filter((ticketId) => {
    const key = String(ticketId)
    if (!Object.prototype.hasOwnProperty.call(causalOwners, key)) return false
    const capturedOwner = causalOwners[key]
    // Absence of ownership is not ownership. Historical/dev rows that lack a
    // causal owner are completed as a no-op instead of being allowed to mutate
    // whichever iteration happens to be on_review at replay time.
    if (capturedOwner === null) return false
    const current = ownerQuery.get(ticketId) as { owner_id: string } | undefined
    return tickets[key]?.status === 'on_review' && current?.owner_id === capturedOwner
  })
  db.prepare(`
    UPDATE rail_pr_ticket_effects
       SET applied_ticket_ids = ?, updated_at = datetime('now')
     WHERE delivery_id = ? AND applied_ticket_ids IS NULL AND completed_at IS NULL
  `).run(JSON.stringify(selected), deliveryId)

  const durable = db.prepare(`
    SELECT applied_ticket_ids FROM rail_pr_ticket_effects WHERE delivery_id = ?
  `).get(deliveryId) as { applied_ticket_ids: string | null } | undefined
  if (!durable || durable.applied_ticket_ids === null) {
    throw new Error(`ticket effect ${deliveryId} could not persist its selected ticket ids`)
  }
  return parseTicketIds(durable.applied_ticket_ids)
}

/** Apply one pending row idempotently. Only tickets still parked at on_review
 * move. The selected ids and each boundary phase are durable, so replay after
 * the JSON write still hands the original ids to Jira; completion is recorded
 * only after Jira has durably accepted (or definitively does not require) the
 * handoff. */
export function applyRailPrTicketEffect(
  deps: RailPrTicketEffectDeps,
  deliveryId: string,
): RailPrTicketEffectResult {
  const row = deps.db.prepare(`
    SELECT * FROM rail_pr_ticket_effects WHERE delivery_id = ?
  `).get(deliveryId) as RailPrTicketEffectRow | undefined
  if (!row || row.completed_at) return { ok: true, changedTicketIds: [] }

  const ticketIds = parseTicketIds(row.ticket_ids)
  const causalOwners = parseCausalOwners(row.causal_owners)
  const changedTicketIds: number[] = []
  let appliedTicketIds = row.applied_ticket_ids === null ? [] : parseTicketIds(row.applied_ticket_ids)
  let store: ReturnType<typeof mutateStore> | null = null

  // Phase 1: select under the ticket-file lock, persist that immutable set in
  // SQLite, then atomically replace the JSON. If the JSON phase was already
  // checkpointed, never rewrite it merely because Jira needs a retry.
  try {
    if (!row.tickets_applied_at) {
      const now = new Date().toISOString()
      store = mutateStore(resolveTicketFile(deps), (current) => {
        appliedTicketIds = selectAppliedTicketIds(
          deps.db,
          deliveryId,
          ticketIds,
          causalOwners,
          current.tickets,
        )
        for (const ticketId of appliedTicketIds) {
          const ticket = current.tickets[String(ticketId)]
          if (!ticket || ticket.status !== 'on_review') continue
          ticket.status = row.target_status
          ticket.updated_at = now
          changedTicketIds.push(ticketId)
        }
      })
      deps.db.prepare(`
        UPDATE rail_pr_ticket_effects
           SET tickets_applied_at = COALESCE(tickets_applied_at, datetime('now')),
               last_error = NULL, updated_at = datetime('now')
         WHERE delivery_id = ? AND completed_at IS NULL
      `).run(deliveryId)
    }
  } catch (err) {
    return recordEffectFailure(deps.db, deliveryId, err, [])
  }

  for (const ticketId of changedTicketIds) {
    const ticket = store?.tickets[String(ticketId)]
    if (!ticket) continue
    try {
      deps.broadcast({
        type: 'ticket_updated',
        ticket: ticket as unknown as TicketUpdatedMessage['ticket'],
        projectId: deps.project.id,
        timestamp: ticket.updated_at,
      } as TicketUpdatedMessage)
    } catch { /* persisted ticket JSON is authoritative */ }
  }

  // Phase 2: hand the immutable id set to Jira. Jira's own outbox keys each op
  // by (delivery,ticket,action), so a crash after enqueue but before this
  // checkpoint safely replays the same handoff without duplicating work.
  if (!row.jira_enqueued_at) {
    try {
      let accepted: boolean | void
      if (!deps.jiraSyncManager || appliedTicketIds.length === 0) {
        accepted = true
      } else if (row.jira_action === 'merged') {
        accepted = deps.jiraSyncManager.onRailMerged(appliedTicketIds, deliveryId, row.pr_url)
      } else if (row.jira_action === 'discard') {
        accepted = deps.jiraSyncManager.onRailDiscard(appliedTicketIds, deliveryId)
      } else if (row.jira_action === 'completed') {
        if (!deps.jiraSyncManager.onRailCompleted) {
          throw new Error('Jira manager does not support no-change completion handoff')
        }
        accepted = deps.jiraSyncManager.onRailCompleted(appliedTicketIds, deliveryId)
      } else if (row.jira_action === 'refine') {
        if (!deps.jiraSyncManager.onRailRefined) {
          throw new Error('Jira manager does not support refinement handoff')
        }
        accepted = deps.jiraSyncManager.onRailRefined(appliedTicketIds, deliveryId)
      } else {
        if (!deps.jiraSyncManager.onRailBacklog) {
          throw new Error('Jira manager does not support recovered-backlog handoff')
        }
        accepted = deps.jiraSyncManager.onRailBacklog(appliedTicketIds, deliveryId)
      }
      if (accepted === false) throw new Error('Jira outbox handoff was not durably accepted')
    } catch (err) {
      console.error(`[rail-pr-ticket-effects] Jira handoff failed for ${deliveryId}:`, err)
      return recordEffectFailure(deps.db, deliveryId, err, changedTicketIds)
    }
  }

  // Phase 3: Jira handoff and terminal completion advance together. A process
  // death before this transaction merely repeats the idempotent phase above.
  try {
    deps.db.transaction(() => {
      const completed = deps.db.prepare(`
        UPDATE rail_pr_ticket_effects
           SET jira_enqueued_at = COALESCE(jira_enqueued_at, datetime('now')),
               completed_at = datetime('now'), attempts = attempts + 1,
               last_error = NULL, updated_at = datetime('now')
         WHERE delivery_id = ? AND completed_at IS NULL
           AND tickets_applied_at IS NOT NULL
      `).run(deliveryId)
      if (completed.changes === 0) {
        const current = deps.db.prepare(`
          SELECT completed_at FROM rail_pr_ticket_effects WHERE delivery_id = ?
        `).get(deliveryId) as { completed_at: string | null } | undefined
        if (!current?.completed_at) {
          throw new Error(`ticket effect ${deliveryId} cannot complete before its JSON phase`)
        }
      }
    })()
    clearPendingWarning(deps.db, deliveryId)
    return { ok: true, changedTicketIds }
  } catch (err) {
    return recordEffectFailure(deps.db, deliveryId, err, changedTicketIds)
  }
}

/** Replay one startup pass. Failures remain pending for the in-process retry
 * loop (and a later restart) and never roll back a successful sibling effect. */
export function replayPendingRailPrTicketEffects(deps: RailPrTicketEffectDeps): {
  attempted: number
  completed: number
  pending: number
  attemptedDeliveryIds: string[]
} {
  const rows = deps.db.prepare(`
    SELECT delivery_id FROM rail_pr_ticket_effects
     WHERE completed_at IS NULL
     ORDER BY created_at ASC, rowid ASC
  `).all() as Array<{ delivery_id: string }>
  let completed = 0
  for (const row of rows) {
    const result = applyRailPrTicketEffect(deps, row.delivery_id)
    if (result.ok) completed++
  }
  const pending = (deps.db.prepare(`
    SELECT COUNT(*) AS count FROM rail_pr_ticket_effects WHERE completed_at IS NULL
  `).get() as { count: number }).count
  return {
    attempted: rows.length,
    completed,
    pending,
    attemptedDeliveryIds: rows.map((row) => row.delivery_id),
  }
}

/** Keep startup admission closed until every terminal effect has crossed both
 * durable boundaries. A transient JSON lock/corruption or Jira-outbox failure
 * heals in-process; it no longer requires another app restart. */
export async function replayRailPrTicketEffectsUntilSettled(
  deps: RailPrTicketEffectDeps,
  opts: {
    isCurrent: () => boolean
    onAttempt?: (result: {
      attempted: number
      completed: number
      pending: number
      attemptedDeliveryIds: string[]
    }) => void
    wait?: (delayMs: number) => Promise<void>
    initialDelayMs?: number
    maxDelayMs?: number
  },
): Promise<{ settled: boolean; attempts: number }> {
  const wait = opts.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs)
    // Recovery keeps project admission closed, but it must not keep a desktop
    // process alive after the normal shutdown path has released every manager.
    timer.unref()
  }))
  let delayMs = Math.max(25, opts.initialDelayMs ?? 250)
  const maxDelayMs = Math.max(delayMs, opts.maxDelayMs ?? 5_000)
  let attempts = 0
  while (opts.isCurrent()) {
    const result = replayPendingRailPrTicketEffects(deps)
    attempts++
    opts.onAttempt?.(result)
    if (result.pending === 0) return { settled: true, attempts }
    await wait(delayMs)
    delayMs = Math.min(maxDelayMs, delayMs * 2)
  }
  return { settled: false, attempts }
}
