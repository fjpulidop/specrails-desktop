import type { DbInstance } from '../../../db/types'
import type { PrDecision } from '../domain/state'
import { REVIEW_WIP_DECISIONS, type ReviewWipDelivery } from '../domain/review-wip'

/** SQLite `datetime('now')` (UTC, no zone) → ISO; ISO input passes through. */
function toIso(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
}

function parseTicketIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id)) : []
  } catch {
    return []
  }
}

/**
 * Outbound adapter: the review WIP snapshot of ONE project's connection. It
 * reads only top-level rows in a counted decision; the pure domain still
 * re-applies the rule so the adapter cannot widen it.
 */
export function readReviewWipSnapshot(db: DbInstance): ReviewWipDelivery[] {
  const decisions = [...REVIEW_WIP_DECISIONS]
  const rows = db.prepare(
    `SELECT id, rail_index, ticket_ids, decision, parent_delivery_id, created_at
       FROM rail_pr_deliveries
      WHERE parent_delivery_id IS NULL AND decision IN (${decisions.map(() => '?').join(', ')})
      ORDER BY created_at ASC, rowid ASC`,
  ).all(...decisions) as Array<{ id: string; rail_index: number; ticket_ids: string; decision: PrDecision; parent_delivery_id: string | null; created_at: string }>
  return rows.map((row) => ({
    id: row.id,
    railIndex: row.rail_index,
    ticketIds: parseTicketIds(row.ticket_ids),
    decision: row.decision,
    parentDeliveryId: row.parent_delivery_id,
    createdAt: toIso(row.created_at),
  }))
}
