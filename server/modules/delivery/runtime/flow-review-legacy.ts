/**
 * One-shot reclassification of Flow → Spec deliveries settled as a generic
 * implementation failure before settlement classified requested changes
 * (flow-review-outcome.ts). The snapshot already presents such a row as
 * `review_changes_requested` on read when its stored evidence shows the
 * rejected review; this heal makes it durable and fills evidence that was
 * harvested without the reviewer verdict, reading the retained run ledger
 * read-only through the SAME harvest path (`healRuntimeEvidence` over
 * `probeDefinitionRuns`). Idempotent: a reclassified row no longer matches.
 */
import type { DbInstance } from '../../../db'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import { healRuntimeEvidence, readSettleEvidence, type DeliverySettleEvidence } from './delivery-evidence'
import { FLOW_SPEC_DELIVERY_LOOP_ID, isLegacyFlowReviewCandidate, legacyFlowReviewReclassification } from './flow-review-outcome'
import { getPrDelivery, transitionDecision, type DeliverBranchRecord, type RailPrDeliveryRow } from './rail-pr-store'

function parseList<T>(raw: string | null | undefined): T[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

/** Every legacy candidate (Flow → Spec, implementation_failed, not yet a review outcome). */
export function listLegacyFlowReviewCandidates(db: DbInstance): RailPrDeliveryRow[] {
  return (db.prepare(`
    SELECT * FROM rail_pr_deliveries
     WHERE loop_id = ? AND decision = 'implementation_failed' AND implementation_outcome = 'failed'
       AND COALESCE(status_code, '') NOT IN ('review_changes_requested', 'returned_to_flow')
     ORDER BY created_at ASC, rowid ASC
  `).all(FLOW_SPEC_DELIVERY_LOOP_ID) as RailPrDeliveryRow[]).filter(isLegacyFlowReviewCandidate)
}

/**
 * Persist the reclassification of ONE row (optionally with healed evidence)
 * in one transaction: the evidence and the status move together or not at
 * all. False when the row is not a candidate, is busy, or its evidence does
 * not show requested changes (the evidence is then left untouched too).
 */
export function persistLegacyFlowReview(db: DbInstance, deliveryId: string, healedEvidence?: DeliverySettleEvidence): boolean {
  return db.transaction(() => {
    const stored = getPrDelivery(db, deliveryId)
    if (!stored || !isLegacyFlowReviewCandidate(stored) || stored.operation_token || stored.operation) return false
    const row = healedEvidence ? { ...stored, settle_evidence: JSON.stringify(healedEvidence) } : stored
    const reclassified = legacyFlowReviewReclassification(row, parseList<DeliverBranchRecord>(row.branches))
    if (!reclassified) return false
    return transitionDecision(db, row.id, 'implementation_failed', 'implementation_failed', {
      ...(healedEvidence ? { settleEvidence: healedEvidence } : {}),
      statusCode: reclassified.statusCode,
      statusDetail: reclassified.statusDetail,
      branches: reclassified.units,
    })
  })()
}

export interface LegacyFlowReviewHealDeps {
  db: DbInstance
  /** `<specrailsDir>/pipeline` — engine 1 runtime evidence. */
  pipelineDir: string
  /** Engine 2 run ids → full retained status (read-only; `probeDefinitionRuns(..., true)`). */
  probe: (runIds: string[]) => Promise<ReadonlyMap<string, DefinitionRunProbe>>
  /** Whether a run used the definition engine (engine_version 2). */
  isDefinitionRun: (runId: string) => boolean
}

/** Evidence for a row whose settle harvest stored nothing: one bare unit per run. */
function bareEvidence(row: RailPrDeliveryRow): DeliverySettleEvidence | null {
  const runIds = parseList<string>(row.run_ids).filter((id): id is string => typeof id === 'string' && id.length > 0)
  const ticketIds = parseList<number>(row.ticket_ids)
  if (runIds.length === 0) return null
  return {
    schemaVersion: 1, harvest: 'partial', harvestedAt: new Date().toISOString(),
    units: runIds.map((runId, index) => ({ ticketId: ticketIds[index] ?? ticketIds[0] ?? 0, runId, sentinel: 'absent', sentinelDetail: null, verifyTail: null, confidence: null })),
  }
}

/**
 * Reclassify every legacy candidate whose evidence (stored, or re-read from
 * the retained run) shows requested changes. Returns the reclassified ids so
 * the caller re-projects their cards. Never throws.
 */
export async function healLegacyFlowReviews(deps: LegacyFlowReviewHealDeps): Promise<string[]> {
  const reclassified: string[] = []
  let candidates: RailPrDeliveryRow[]
  try { candidates = listLegacyFlowReviewCandidates(deps.db) } catch { return reclassified }
  for (const row of candidates) {
    try {
      if (legacyFlowReviewReclassification(row, [])) {
        if (persistLegacyFlowReview(deps.db, row.id)) reclassified.push(row.id)
        continue
      }
      const stored = readSettleEvidence(row.settle_evidence) ?? bareEvidence(row)
      if (!stored) continue
      const missing = stored.units.filter((unit) => unit.runId && !unit.runtime?.review).map((unit) => unit.runId!)
      if (missing.length === 0) continue
      const definitionIds = missing.filter((runId) => deps.isDefinitionRun(runId))
      const statuses = definitionIds.length > 0 ? await deps.probe(definitionIds) : new Map<string, DefinitionRunProbe>()
      const healed = healRuntimeEvidence(stored, deps.pipelineDir, {}, statuses, { refreshMissingReview: true })
      if (healed && persistLegacyFlowReview(deps.db, row.id, healed)) reclassified.push(row.id)
    } catch (error) {
      console.warn(`[flow-review] legacy reclassification skipped for ${row.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return reclassified
}
