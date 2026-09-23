import { type ExecResult } from '../../runtime/pr-publisher'
import {
  appendPrDeliverySafetyArchive, getPrDelivery, transitionClaimedDecision,
  toPrDeliverySnapshot, toRailPrStateMessage, toPrDecisionCardEnvelope, type PrDecision, type PrDeliveryPatch, type PrDeliverySnapshot, type RailPrDeliveryRow
} from '../../runtime/rail-pr-store'
import { getAgentChatManager } from '../../../missions/runtime/agent-chat-registry'
import {
  applyRailPrTicketEffect,
  transitionClaimedDecisionWithTicketEffect,
  type RailPrTicketEffect,
} from '../../runtime/rail-pr-ticket-effects'
import { PrDecisionResult, PrDecisionDeps } from './contracts'


// Action handlers keep using one finalization helper, but the operation lease
// must be absent from every emitted snapshot. Calls made while a lease is held
// are deferred until executePrDecision's finally releases that exact token.
export const deferredFinalizations = new Set<string>()


export function staleDecision(current: string): PrDecisionResult {
  return { status: 409, body: { error: 'stale_decision', current } }
}


export function illegalAction(current: string): PrDecisionResult {
  return { status: 409, body: { error: 'stale_decision', current, reason: 'illegal_action' } }
}


export function ghFailed(r: ExecResult): PrDecisionResult {
  const detail = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`
  return { status: 502, body: { error: 'gh_failed', detail } }
}


export function safetyArchiveRecorder(deps: PrDecisionDeps, row: RailPrDeliveryRow) {
  return (archive: string): void => {
    if (!appendPrDeliverySafetyArchive(deps.db, row.id, archive)) {
      throw new Error(`delivery ${row.id} disappeared while recording safety archive ${archive}`)
    }
  }
}


/**
 * Atomic CAS transition; a `false` return means a concurrent mutation raced us
 * between the pre-check and here — surface the same 409 with the fresh state.
 */
export function casTransition(deps: PrDecisionDeps, row: RailPrDeliveryRow, next: PrDecision, patch: PrDeliveryPatch = {}): PrDecisionResult | null {
  if (row.operation_token && transitionClaimedDecision(deps.db, row.id, row.decision, next, row.operation_token, patch)) return null
  const current = getPrDelivery(deps.db, row.id)
  return staleDecision(current?.decision ?? row.decision)
}


export function casTransitionWithTicketEffect(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  next: PrDecision,
  patch: PrDeliveryPatch,
  effect: RailPrTicketEffect,
): PrDecisionResult | null {
  if (deps.repositoryChildOf) return casTransition(deps, row, next, patch)
  if (
    row.operation_token &&
    transitionClaimedDecisionWithTicketEffect(
      deps.db, row.id, row.decision, next, row.operation_token, patch, effect,
    )
  ) return null
  const current = getPrDelivery(deps.db, row.id)
  return staleDecision(current?.decision ?? row.decision)
}


export function applyTerminalTicketEffect(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  terminalDecision: PrDecision,
  cleanupWarnings: string[],
): void {
  if (deps.repositoryChildOf) return
  const result = applyRailPrTicketEffect(deps, row.id)
  if (result.ok) return
  cleanupWarnings.push(`ticket status update pending: ${result.error ?? 'unknown ticket-store error'}`)
  if (!row.operation_token) return
  transitionClaimedDecision(deps.db, row.id, terminalDecision, terminalDecision, row.operation_token, {
    statusCode: 'cleanup_incomplete',
    cleanupWarnings,
  })
}


/**
 * Post-transition fan-out: re-broadcast the durable rail.pr_state snapshot
 * (both surfaces converge on it) and, for agent-chat-originated launches,
 * update the persisted inline card in place.
 */
export function finalizeTransition(deps: PrDecisionDeps, id: string): PrDeliverySnapshot | undefined {
  const row = getPrDelivery(deps.db, id)
  if (!row) return undefined
  const snap = toPrDeliverySnapshot(row)
  if (row.operation_token) {
    deferredFinalizations.add(id)
    return snap
  }
  if (deps.repositoryChildOf) return snap
  deps.broadcast(toRailPrStateMessage(deps.project.id, snap))
  if (row.origin_conversation_id) {
    const agent = (deps.agentChat ?? getAgentChatManager)()
    // Shared mapper (rail-pr-store.toPrDecisionCardEnvelope) — the SAME shape
    // rail-isolated-launch's origin-card sync posts, so the two card-writing
    // sites (incl. the runIds chip data) can never drift.
    agent?.updatePrDecisionCard(row.origin_conversation_id, toPrDecisionCardEnvelope(deps.project.id, snap))
  }
  return snap
}
