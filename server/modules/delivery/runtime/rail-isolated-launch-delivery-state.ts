/**
 * Isolated launch delivery-row publisher: the durable `rail.pr_state`
 * broadcast, the origin-conversation decision card, the mission failure
 * trigger and the failed-generation close. Every closure reads the launch's
 * live delivery state, so the row inserted mid-allocation is always the one
 * reported.
 */
import { FLOW_SPEC_DELIVERY_LOOP_ID } from './flow-review-outcome'
import {
  failPrDeliveryAndRestoreSuperseded, getPrDelivery, transitionDecision, toPrDeliverySnapshot, toRailPrStateMessage, 
  toPrDecisionCardEnvelope, type SupersededPrDelivery,
} from './rail-pr-store'
import { getAgentChatManager } from '../../missions/runtime/agent-chat-registry'
import { notifyMissionRunFailure } from '../../missions/runtime/mission-run-notify'
import { refreshPrCiOffer } from './pr-ci/pr-ci-projection'
import { runtimeRunSummary } from '../../agent-runtime/runtime/agent-runtime-controls-router'
import type { ProjectContext } from '../../../project-registry'
import { errorDetail, getRailName } from './rail-isolated-launch-support'

/** The generation this launch owns; set once the decision row is inserted. */
export interface LaunchDeliveryState {
  prDeliveryId: string | null
  supersededDelivery: SupersededPrDelivery | null
}

export type LaunchDeliveryPublisher = ReturnType<typeof createLaunchDeliveryPublisher>

export function createLaunchDeliveryPublisher(
  ctx: ProjectContext,
  railIndex: number,
  ticketIds: readonly number[],
  state: LaunchDeliveryState,
) {
  // Origin-conversation card sync: when the launch came from an agent-chat
  // conversation, mirror the row's state into its inline decision card —
  // 'post' at launch (the user sees "working in an isolated worktree" from
  // second zero), 'update' on every later transition (settle, alloc-failure).
  // Null-safe: registry empty in tests / disabled builds; update falls back to
  // post when no card exists yet.
  const broadcastDeliveryState = (deliveryId: string): void => {
    const row = getPrDelivery(ctx.db, deliveryId)
    if (!row) return
    ctx.broadcast(toRailPrStateMessage(ctx.project.id, toPrDeliverySnapshot(row)))
  }
  const syncDeliveryCard = (deliveryId: string, verb: 'post' | 'update'): void => {
    const row = getPrDelivery(ctx.db, deliveryId)
    if (!row?.origin_conversation_id) return
    const mgr = getAgentChatManager()
    if (!mgr) return
    const envelope = toPrDecisionCardEnvelope(ctx.project.id, toPrDeliverySnapshot(row))
    if (verb === 'post') mgr.postPrDecisionCard(row.origin_conversation_id, envelope)
    else mgr.updatePrDecisionCard(row.origin_conversation_id, envelope)
  }
  const emitPrDeliveryState = (deliveryId: string, verb: 'post' | 'update'): void => {
    broadcastDeliveryState(deliveryId)
    syncDeliveryCard(deliveryId, verb)
    // pr-ci-loop: settle-time offer for a new PR / final state of a CI loop run.
    refreshPrCiOffer(ctx, deliveryId)
  }
  const broadcastPrState = (): void => {
    if (state.prDeliveryId) broadcastDeliveryState(state.prDeliveryId)
  }
  const syncOriginCard = (verb: 'post' | 'update'): void => {
    if (state.prDeliveryId) syncDeliveryCard(state.prDeliveryId, verb)
  }
  // mission-rail-cards: the failure trigger for isolated launches. Reads the
  // durable row (origin link + latest envelope) so the notification reflects
  // the exact persisted state; fire-and-forget, never throws into settle.
  const notifyOriginRunFailure = (deliveryId: string, failure: { code: string; detail: string | null; stepId: string | null }, runId: string | null): void => {
    const row = getPrDelivery(ctx.db, deliveryId)
    if (!row?.origin_conversation_id) return
    const snapshot = toPrDeliverySnapshot(row)
    const primaryRunId = runId ?? snapshot.runIds[0] ?? deliveryId
    // An Intent session → Spec run that failed outright goes back to its Intent on its own
    // (flow module, `rail.pr_state` observer); the Intent's return card and
    // automatic turn carry the failure, so the mission gets only the card
    // update — no second trace row, no second briefing turn.
    const flowCrash = row.loop_id === FLOW_SPEC_DELIVERY_LOOP_ID && failure.code === 'implementation_failed'
    void (async () => {
      const summary = runId ? await runtimeRunSummary(ctx, runId).catch(() => null) : null
      // Re-read after the await: the delivery may have moved on meanwhile
      // (Back to Intent closes it) and the card must never regress to the old decision.
      const current = getPrDelivery(ctx.db, deliveryId) ?? row
      const envelope = toPrDecisionCardEnvelope(ctx.project.id, toPrDeliverySnapshot(current))
      await notifyMissionRunFailure({
        originConversationId: row.origin_conversation_id,
        projectId: ctx.project.id, runId: primaryRunId, railIndex, ticketIds: [...ticketIds],
        railName: getRailName(ctx, railIndex),
        failure, envelope, summary, hasDelivery: true, prDeliveryId: deliveryId,
        tickets: ticketIds.map((id) => ({ id, title: ctx.getTicketSpec(id)?.title ?? null })),
        ...(flowCrash ? { cardOnly: true } : {}),
      })
    })().catch((err) => console.error('[rail-isolated] mission failure notify failed:', err))
  }
  const closeFailedGeneration = (err: unknown): void => {
    if (!state.prDeliveryId || getPrDelivery(ctx.db, state.prDeliveryId)?.decision !== 'building') return
    const closed = state.supersededDelivery
      ? failPrDeliveryAndRestoreSuperseded(ctx.db, state.prDeliveryId, state.supersededDelivery)
      : transitionDecision(ctx.db, state.prDeliveryId, 'building', 'discarded', {
          implementationOutcome: 'unknown',
          deliveryOutcome: 'blocked',
          statusCode: 'delivery_failed',
          statusDetail: errorDetail(err),
        })
    if (!closed) return
    try { emitPrDeliveryState(state.prDeliveryId, 'update') } catch { /* durable row is authoritative */ }
    notifyOriginRunFailure(state.prDeliveryId, { code: 'launch_failed', detail: errorDetail(err), stepId: null }, null)
    if (state.supersededDelivery) {
      try { emitPrDeliveryState(state.supersededDelivery.id, 'update') } catch { /* durable row is authoritative */ }
    }
  }
  return { emitPrDeliveryState, broadcastPrState, syncOriginCard, notifyOriginRunFailure, closeFailedGeneration }
}
