import type { DbInstance } from '../../../db'
import { resolveRange, type SpendingFilters } from './spending'

/**
 * Time to decision / time to merge per delivery (delivery-decision-times).
 *
 * Reads the first-write-wins lifecycle instants of `rail_pr_deliveries`
 * (migration 72). Every aggregate is null-safe: a missing instant is counted
 * as `unknown` (or `pending` while the delivery still awaits it), never as a
 * zero-length duration. Repository children of a grouped delivery are
 * excluded so a multi-repo delivery counts once, through its parent.
 */

export interface DurationStats {
  /** Deliveries with both instants (and a non-negative interval). */
  measured: number
  /** Reviewable deliveries still awaiting this milestone. */
  pending: number
  /** Deliveries that reached the milestone without a measurable interval
   * (pre-migration history, or an instant that was never recorded). */
  unknown: number
  medianMs: number | null
  p90Ms: number | null
}

export interface DecisionTimeGroup {
  deliveries: number
  toDecision: DurationStats
  toMerge: DurationStats
}

export interface LoopDecisionTimes extends DecisionTimeGroup {
  /** NULL for deliveries launched without a saved loop. */
  loopId: string | null
  loopName: string
}

export interface DecisionTimesResponse {
  period: string
  from: string
  to: string
  project: DecisionTimeGroup
  byLoop: LoopDecisionTimes[]
}

export interface DecisionTimeRow {
  loop_id: string | null
  loop_name: string
  decision: string
  on_review_at: string | null
  decided_at: string | null
  merged_at: string | null
}

/** Decisions in which the delivery still waits for a human decision. */
const AWAITING_DECISION = new Set(['on_review'])
/** Decisions from which a merge can still happen. */
const AWAITING_MERGE = new Set(['on_review', 'pr_draft', 'pr_ready', 'pr_closed', 'pr_failed'])
/** Decisions that prove a review happened, even on a legacy row without stamps. */
const PAST_REVIEW = new Set(['pr_draft', 'pr_ready', 'pr_closed', 'merged'])

/** Linear-interpolated quantile (R type 7) of an ascending array; null when empty. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q))
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower))
}

function intervalMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const ms = Date.parse(end) - Date.parse(start)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

function stats(durations: number[], pending: number, unknown: number): DurationStats {
  const sorted = [...durations].sort((a, b) => a - b)
  return { measured: sorted.length, pending, unknown, medianMs: quantile(sorted, 0.5), p90Ms: quantile(sorted, 0.9) }
}

/** Pure, null-safe aggregation of delivery rows into decision/merge timings. */
export function aggregateDecisionTimes(rows: readonly DecisionTimeRow[]): DecisionTimeGroup {
  const decision: number[] = []
  const merge: number[] = []
  let decisionPending = 0, decisionUnknown = 0, mergePending = 0, mergeUnknown = 0
  let deliveries = 0
  for (const row of rows) {
    // `decided_at` alone does not prove a review: acknowledging no-changes or
    // discarding a failed preparation is a decision on a never-reviewable row.
    const reviewed = row.on_review_at != null || row.merged_at != null || PAST_REVIEW.has(row.decision)
    if (!reviewed) continue
    deliveries++

    const toDecision = intervalMs(row.on_review_at, row.decided_at)
    if (toDecision != null) decision.push(toDecision)
    else if (row.on_review_at && !row.decided_at && AWAITING_DECISION.has(row.decision)) decisionPending++
    else decisionUnknown++

    const toMerge = intervalMs(row.on_review_at, row.merged_at)
    if (toMerge != null) merge.push(toMerge)
    else if (row.merged_at || row.decision === 'merged') mergeUnknown++
    else if (AWAITING_MERGE.has(row.decision)) {
      if (row.on_review_at) mergePending++
      else mergeUnknown++
    }
    // discarded / completed / superseded never merge: neither pending nor unknown.
  }
  return {
    deliveries,
    toDecision: stats(decision, decisionPending, decisionUnknown),
    toMerge: stats(merge, mergePending, mergeUnknown),
  }
}

/** Per-project and per-loop decision timings for deliveries reviewed in the window. */
export function getDecisionTimes(db: DbInstance, filters: SpendingFilters, now: Date = new Date()): DecisionTimesResponse {
  const range = resolveRange(filters, now)
  const rows = db.prepare(`
    SELECT loop_id, loop_name, decision, on_review_at, decided_at, merged_at
      FROM rail_pr_deliveries
     WHERE parent_delivery_id IS NULL
       AND julianday(COALESCE(on_review_at, created_at)) >= julianday(?)
       AND julianday(COALESCE(on_review_at, created_at)) <= julianday(?)
     ORDER BY created_at
  `).all(range.from, range.to) as DecisionTimeRow[]

  const loops = new Map<string, { loopId: string | null; loopName: string; rows: DecisionTimeRow[] }>()
  for (const row of rows) {
    const key = row.loop_id ?? `name:${row.loop_name}`
    const group = loops.get(key) ?? { loopId: row.loop_id, loopName: row.loop_name, rows: [] }
    if (row.loop_name) group.loopName = row.loop_name
    group.rows.push(row)
    loops.set(key, group)
  }
  const byLoop = [...loops.values()]
    .map(({ loopId, loopName, rows: loopRows }) => ({ loopId, loopName, ...aggregateDecisionTimes(loopRows) }))
    .filter((group) => group.deliveries > 0)
    .sort((a, b) => b.deliveries - a.deliveries || a.loopName.localeCompare(b.loopName))

  return {
    period: filters.period ?? '30d',
    from: range.from,
    to: range.to,
    project: aggregateDecisionTimes(rows),
    byLoop,
  }
}
