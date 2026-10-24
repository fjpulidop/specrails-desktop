import type { DbInstance } from '../../../db'
import { aggregateDecisionTimes, type DecisionTimeGroup, type DecisionTimeRow } from './decision-times'
import { resolveRange, type SpendingFilters } from './spending'

/**
 * Loop economics (loop-economics-analytics, feedback 2026-10 task 4.5).
 *
 * Per loop over a period: deliveries that reached review, merges, discards,
 * cost per delivery, time to decision/merge, rework rounds and escaped
 * defects. Every metric is null-safe: unknown values are `null` (rendered
 * "no data" / "—"), never a manufactured zero.
 *
 * The pure helpers below (`isDelivered`, `summarizeInvocationCost`,
 * `countLoopRounds`, `aggregateLoopEconomics`) mirror the join rules of the
 * offline baseline export (scripts/metrics-baseline.mjs, PR #786) so that
 * script can import them instead of duplicating them.
 */

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface LoopEconomicsDeliveryRow extends DecisionTimeRow {
  id: string
  run_ids: string
  implementation_outcome: string | null
  /** Settle-time evidence JSON (spec trace source); absent in older callers. */
  settle_evidence?: string | null
}

export interface InvocationCostRow {
  total_cost_usd: number | null
  total_cost_usd_estimated: number | null
}

export interface LoopStepRow {
  node_id: string | null
  attempt: number | null
}

/** A ticket's human-entered escaped-defect link (`metadata.regressionOf`). */
export interface RegressionLink {
  ticketId: number
  deliveryId: string
}

export interface KnownLoop {
  id: string
  name: string
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

export interface DeliveryCost {
  invocations: number
  pricedInvocations: number
  unpricedInvocations: number
  /** Priced total (authoritative + estimated); null when no row is priced. */
  costUsd: number | null
  /** Provider-reported portion; null when no row is priced. */
  authoritativeUsd: number | null
  /** Pricing-table portion; null when no row is priced. */
  estimatedUsd: number | null
}

export interface LoopCostStats {
  /** Delivered deliveries with at least one priced invocation. */
  pricedDeliveries: number
  /** Delivered deliveries without any priced invocation (unknown cost). */
  unpricedDeliveries: number
  /** Priced deliveries that also carry unpriced invocations (lower bound). */
  incompleteDeliveries: number
  totalUsd: number | null
  authoritativeUsd: number | null
  estimatedUsd: number | null
  avgCostUsd: number | null
  /** estimatedUsd / totalUsd in [0, 1]; null when no positive priced total. */
  estimatedShare: number | null
}

export interface LoopRoundStats {
  /** Delivered deliveries whose runs emitted loop_step events. */
  measuredDeliveries: number
  reviewRounds: number
  fixerRounds: number
  reviewPerDelivery: number | null
  fixerPerDelivery: number | null
}

export interface LoopEconomicsGroup {
  hasData: boolean
  delivered: number
  merged: number
  discarded: number
  superseded: number
  onReview: number
  discardRate: number | null
  cost: LoopCostStats
  decisionTimes: DecisionTimeGroup
  rounds: LoopRoundStats
  /** Linked regression tickets; null while no ticket in the project carries `regressionOf`. */
  escapedDefects: number | null
  /** Requirements demonstrated by a passing test (Core `specTrace: 1`), summed
   *  over the delivered deliveries that carry a spec trace; null when none does. */
  requirementsDemonstrated: { demonstrated: number; total: number; deliveries: number } | null
  /** Placeholder until triage lands (recommendedLoop == chosenLoop). */
  triageAccuracy: { matched: number; total: number } | null
}

export interface LoopEconomicsLoop extends LoopEconomicsGroup {
  loopId: string | null
  loopName: string
}

export interface LoopEconomicsResponse {
  period: string
  from: string
  to: string
  sources: {
    escapedDefects: 'tracked' | 'untracked'
    /** `measured` once any delivery in the window carries a spec trace. */
    requirementsDemonstrated: 'measured' | 'unavailable'
    triageAccuracy: 'unavailable'
  }
  project: LoopEconomicsGroup
  byLoop: LoopEconomicsLoop[]
}

/** Per-delivery facts the aggregation consumes (already joined). */
export interface LoopEconomicsDelivery {
  row: LoopEconomicsDeliveryRow
  cost: DeliveryCost
  /** null when the delivery's runs emitted no loop_step events. */
  rounds: { review: number; fixer: number } | null
  escapedDefects: number
  /** From the settle evidence's spec traces; null when the delivery has none. */
  requirements?: { demonstrated: number; total: number } | null
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Decisions that prove the delivery reached review. */
const PAST_REVIEW = new Set(['on_review', 'pr_draft', 'pr_ready', 'pr_closed', 'merged', 'superseded'])
const SUCCEEDED = new Set(['succeeded', 'partially_succeeded'])
const REVIEW_NODES = new Set(['reviewer', 'review'])
const FIXER_NODES = new Set(['fixer', 'fix'])

const round6 = (value: number) => Math.round(value * 1e6) / 1e6

/**
 * Requirements demonstrated by one delivery, summed over its units' spec
 * traces (Core `specTrace: 1`). Null when the evidence carries no trace —
 * unknown, never zero. Tolerant of malformed JSON.
 */
export function requirementsFromSettleEvidence(raw: string | null | undefined): { demonstrated: number; total: number } | null {
  if (!raw || !raw.includes('"specTrace"')) return null
  try {
    const evidence = JSON.parse(raw) as { units?: Array<{ specTrace?: { requirements?: unknown; demonstrated?: unknown } }> }
    let demonstrated = 0, total = 0, traced = 0
    for (const unit of Array.isArray(evidence.units) ? evidence.units : []) {
      const trace = unit?.specTrace
      if (!trace || !Array.isArray(trace.demonstrated)) continue
      traced++
      demonstrated += trace.demonstrated.length
      total += typeof trace.requirements === 'number' && Number.isSafeInteger(trace.requirements) && trace.requirements >= 0 ? Math.max(trace.requirements, trace.demonstrated.length) : trace.demonstrated.length
    }
    return traced ? { demonstrated, total } : null
  } catch { return null }
}

/** A delivery counts as delivered once it reached `on_review` or beyond. */
export function isDelivered(row: Pick<LoopEconomicsDeliveryRow, 'decision' | 'on_review_at' | 'merged_at' | 'implementation_outcome'>): boolean {
  if (row.on_review_at || row.merged_at || PAST_REVIEW.has(row.decision)) return true
  // Legacy rows (pre-migration 72) carry no instants: a discarded delivery
  // whose implementation succeeded was reviewable when it was discarded.
  return row.decision === 'discarded' && SUCCEEDED.has(row.implementation_outcome ?? '')
}

/** Sum invocation rows keeping unknown (null) cost distinguishable from $0. */
export function summarizeInvocationCost(rows: readonly InvocationCostRow[]): DeliveryCost {
  let authoritative = 0, estimated = 0, priced = 0, unpriced = 0
  for (const row of rows) {
    if (row.total_cost_usd == null || !Number.isFinite(row.total_cost_usd)) { unpriced++; continue }
    priced++
    if (row.total_cost_usd_estimated === 1) estimated += row.total_cost_usd
    else authoritative += row.total_cost_usd
  }
  return {
    invocations: rows.length,
    pricedInvocations: priced,
    unpricedInvocations: unpriced,
    costUsd: priced ? round6(authoritative + estimated) : null,
    authoritativeUsd: priced ? round6(authoritative) : null,
    estimatedUsd: priced ? round6(estimated) : null,
  }
}

/**
 * Count review / fixer rounds from `loop_step` rows. Automatic stall retries
 * (`attempt >= 2`) re-run the same step and are not new rounds. Returns null
 * when there are no step rows at all (unknown, not zero).
 */
export function countLoopRounds(steps: readonly LoopStepRow[]): { review: number; fixer: number } | null {
  if (steps.length === 0) return null
  let review = 0, fixer = 0
  for (const step of steps) {
    if (step.attempt != null && step.attempt >= 2) continue
    const node = String(step.node_id ?? '').toLowerCase()
    if (REVIEW_NODES.has(node)) review++
    else if (FIXER_NODES.has(node)) fixer++
  }
  return { review, fixer }
}

function emptyGroup(tracked: boolean): LoopEconomicsGroup {
  return {
    hasData: false,
    delivered: 0, merged: 0, discarded: 0, superseded: 0, onReview: 0,
    discardRate: null,
    cost: { pricedDeliveries: 0, unpricedDeliveries: 0, incompleteDeliveries: 0, totalUsd: null, authoritativeUsd: null, estimatedUsd: null, avgCostUsd: null, estimatedShare: null },
    decisionTimes: aggregateDecisionTimes([]),
    rounds: { measuredDeliveries: 0, reviewRounds: 0, fixerRounds: 0, reviewPerDelivery: null, fixerPerDelivery: null },
    escapedDefects: tracked ? 0 : null,
    requirementsDemonstrated: null,
    triageAccuracy: null,
  }
}

/**
 * Aggregate already-joined deliveries of one group. Only delivered rows count;
 * `regressionTracked` is false while no ticket in the project uses
 * `regressionOf`, which keeps escaped defects null instead of a fake zero.
 */
export function aggregateLoopEconomics(deliveries: readonly LoopEconomicsDelivery[], regressionTracked: boolean): LoopEconomicsGroup {
  const delivered = deliveries.filter((d) => isDelivered(d.row))
  const group = emptyGroup(regressionTracked)
  if (delivered.length === 0) return group

  let total = 0, authoritative = 0, estimated = 0
  for (const d of delivered) {
    group.delivered++
    if (d.row.decision === 'merged' || d.row.merged_at) group.merged++
    else if (d.row.decision === 'discarded') group.discarded++
    else if (d.row.decision === 'superseded') group.superseded++
    else if (d.row.decision === 'on_review') group.onReview++

    if (d.cost.costUsd == null) group.cost.unpricedDeliveries++
    else {
      group.cost.pricedDeliveries++
      if (d.cost.unpricedInvocations > 0) group.cost.incompleteDeliveries++
      total += d.cost.costUsd
      authoritative += d.cost.authoritativeUsd ?? 0
      estimated += d.cost.estimatedUsd ?? 0
    }

    if (d.rounds) {
      group.rounds.measuredDeliveries++
      group.rounds.reviewRounds += d.rounds.review
      group.rounds.fixerRounds += d.rounds.fixer
    }
    if (regressionTracked) group.escapedDefects = (group.escapedDefects ?? 0) + d.escapedDefects
    if (d.requirements) {
      const current = group.requirementsDemonstrated ?? { demonstrated: 0, total: 0, deliveries: 0 }
      group.requirementsDemonstrated = { demonstrated: current.demonstrated + d.requirements.demonstrated, total: current.total + d.requirements.total, deliveries: current.deliveries + 1 }
    }
  }

  group.hasData = true
  group.discardRate = round6(group.discarded / group.delivered)
  if (group.cost.pricedDeliveries > 0) {
    group.cost.totalUsd = round6(total)
    group.cost.authoritativeUsd = round6(authoritative)
    group.cost.estimatedUsd = round6(estimated)
    group.cost.avgCostUsd = round6(total / group.cost.pricedDeliveries)
    group.cost.estimatedShare = total > 0 ? round6(estimated / total) : null
  }
  if (group.rounds.measuredDeliveries > 0) {
    group.rounds.reviewPerDelivery = round6(group.rounds.reviewRounds / group.rounds.measuredDeliveries)
    group.rounds.fixerPerDelivery = round6(group.rounds.fixerRounds / group.rounds.measuredDeliveries)
  }
  group.decisionTimes = aggregateDecisionTimes(delivered.map((d) => d.row))
  return group
}

// ─── Effectful queries ───────────────────────────────────────────────────────

function parseRunIds(text: string | null | undefined): string[] {
  try {
    const value = JSON.parse(text ?? '[]') as unknown
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))] : []
  } catch { return [] }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** Same attribution rule as `sumInvocationCostForRuns`, keeping unpriced rows. */
function invocationsForRuns(db: DbInstance, runIds: string[]): InvocationCostRow[] {
  if (runIds.length === 0) return []
  const placeholders = runIds.map(() => '?').join(', ')
  const merge = runIds.map(() => `surface_ref_id LIKE ? ESCAPE '\\'`).join(' OR ')
  return db.prepare(
    `SELECT total_cost_usd, total_cost_usd_estimated FROM ai_invocations
      WHERE loop_run_id IN (${placeholders}) OR surface_ref_id IN (${placeholders}) OR ${merge}`,
  ).all(...runIds, ...runIds, ...runIds.map((id) => `${escapeLikePattern(id)}:merge:%`)) as InvocationCostRow[]
}

function stepsForRuns(db: DbInstance, runIds: string[]): LoopStepRow[] {
  if (runIds.length === 0) return []
  const placeholders = runIds.map(() => '?').join(', ')
  return db.prepare(
    `SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, '$.nodeId') END AS node_id,
            CASE WHEN json_valid(payload) THEN json_extract(payload, '$.attempt') END AS attempt
       FROM events
      WHERE event_type = 'loop_step' AND job_id IN (${placeholders})`,
  ).all(...runIds) as LoopStepRow[]
}

export interface LoopEconomicsOptions {
  /** Tickets carrying `metadata.regressionOf` (any, across the whole store). */
  regressionLinks?: readonly RegressionLink[]
  /** Published saved loops; those without data are listed as `hasData: false`. */
  knownLoops?: readonly KnownLoop[]
  now?: Date
}

/** Per-project and per-loop economics for deliveries reviewed in the window. */
export function getLoopEconomics(db: DbInstance, filters: SpendingFilters, options: LoopEconomicsOptions = {}): LoopEconomicsResponse {
  const range = resolveRange(filters, options.now ?? new Date())
  const rows = db.prepare(`
    SELECT id, loop_id, loop_name, decision, on_review_at, decided_at, merged_at, run_ids, implementation_outcome, settle_evidence
      FROM rail_pr_deliveries
     WHERE parent_delivery_id IS NULL
       AND julianday(COALESCE(on_review_at, created_at)) >= julianday(?)
       AND julianday(COALESCE(on_review_at, created_at)) <= julianday(?)
     ORDER BY created_at
  `).all(range.from, range.to) as LoopEconomicsDeliveryRow[]

  const links = options.regressionLinks ?? []
  const tracked = links.length > 0
  // Links may name a repository child; count them through the parent.
  const parentOf = new Map<string, string>()
  if (tracked) {
    for (const child of db.prepare('SELECT id, parent_delivery_id FROM rail_pr_deliveries WHERE parent_delivery_id IS NOT NULL').all() as Array<{ id: string; parent_delivery_id: string }>) {
      parentOf.set(child.id, child.parent_delivery_id)
    }
  }
  const defects = new Map<string, number>()
  for (const link of links) {
    const id = parentOf.get(link.deliveryId) ?? link.deliveryId
    defects.set(id, (defects.get(id) ?? 0) + 1)
  }

  const joined: LoopEconomicsDelivery[] = rows.map((row) => {
    if (!isDelivered(row)) return { row, cost: summarizeInvocationCost([]), rounds: null, escapedDefects: 0 }
    const runIds = parseRunIds(row.run_ids)
    return {
      row,
      cost: summarizeInvocationCost(invocationsForRuns(db, runIds)),
      rounds: countLoopRounds(stepsForRuns(db, runIds)),
      escapedDefects: defects.get(row.id) ?? 0,
      requirements: requirementsFromSettleEvidence(row.settle_evidence),
    }
  })

  const loops = new Map<string, { loopId: string | null; loopName: string; items: LoopEconomicsDelivery[] }>()
  for (const item of joined) {
    const key = item.row.loop_id ?? `name:${item.row.loop_name}`
    const group = loops.get(key) ?? { loopId: item.row.loop_id, loopName: item.row.loop_name, items: [] }
    if (item.row.loop_name) group.loopName = item.row.loop_name
    group.items.push(item)
    loops.set(key, group)
  }
  for (const loop of options.knownLoops ?? []) {
    if (!loops.has(loop.id)) loops.set(loop.id, { loopId: loop.id, loopName: loop.name, items: [] })
  }

  const byLoop = [...loops.values()]
    .map(({ loopId, loopName, items }) => ({ loopId, loopName, ...aggregateLoopEconomics(items, tracked) }))
    .sort((a, b) => Number(b.hasData) - Number(a.hasData) || b.delivered - a.delivered || a.loopName.localeCompare(b.loopName))

  return {
    period: filters.period ?? '30d',
    from: range.from,
    to: range.to,
    sources: {
      escapedDefects: tracked ? 'tracked' : 'untracked',
      requirementsDemonstrated: joined.some((item) => item.requirements) ? 'measured' : 'unavailable',
      triageAccuracy: 'unavailable',
    },
    project: aggregateLoopEconomics(joined, tracked),
    byLoop,
  }
}

export interface RecentDelivery {
  id: string
  loopId: string | null
  loopName: string
  decision: string
  ticketIds: number[]
  createdAt: string
}

/** Recent delivered parent deliveries — the `regressionOf` picker source. */
export function listRecentDeliveries(db: DbInstance, limit = 50): RecentDelivery[] {
  const capped = Math.min(200, Math.max(1, Math.trunc(limit) || 50))
  const rows = db.prepare(`
    SELECT id, loop_id, loop_name, decision, on_review_at, merged_at, implementation_outcome, ticket_ids, created_at
      FROM rail_pr_deliveries
     WHERE parent_delivery_id IS NULL
     ORDER BY COALESCE(on_review_at, created_at) DESC
     LIMIT ?
  `).all(capped * 4) as Array<LoopEconomicsDeliveryRow & { ticket_ids: string; created_at: string }>
  return rows.filter(isDelivered).slice(0, capped).map((row) => {
    let ticketIds: number[] = []
    try {
      const parsed = JSON.parse(row.ticket_ids) as unknown
      if (Array.isArray(parsed)) ticketIds = parsed.filter((n): n is number => Number.isInteger(n))
    } catch { /* malformed legacy value: no tickets */ }
    return { id: row.id, loopId: row.loop_id, loopName: row.loop_name, decision: row.decision, ticketIds, createdAt: row.created_at }
  })
}
