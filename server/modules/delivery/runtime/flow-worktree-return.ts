/**
 * "Back to Flow": the inverse of the Flow hand-off adoption
 * (flow-worktree-handoff.ts). A Flow → Spec delivery that stopped with
 * requested changes keeps the adopted Flow worktree in the rail ledger
 * (`rail_worktrees`, `needs-review`). Returning it removes the ledger row,
 * closes the delivery as `returned_to_flow` and hands ownership back to the
 * Flow — all in ONE SQLite transaction that delivery owns, mirroring the
 * adoption: Flow supplies only the `commit` callback (its own state change),
 * delivery never touches Flow's table and never removes the worktree.
 */
import type { DbInstance } from '../../../db'
import type { WsMessage } from '../../../types'
import { getAgentChatManager } from '../../missions/runtime/agent-chat-registry'
import { FLOW_SPEC_DELIVERY_LOOP_ID } from './flow-review-outcome'
import { getPrDelivery, toPrDecisionCardEnvelope, toPrDeliverySnapshot, toRailPrStateMessage, transitionDecision, type PrDeliverySnapshot } from './rail-pr-store'

/** The delivery cannot give its worktree back now (HTTP 409). */
export class FlowReturnRejectedError extends Error {
  constructor(readonly code: 'flow_return_not_found' | 'flow_return_not_allowed' | 'flow_return_busy' | 'flow_return_worktree_mismatch', message: string) {
    super(message)
    this.name = 'FlowReturnRejectedError'
  }
}

export interface FlowWorktreeReturnInput {
  deliveryId: string
  /** The Flow's own mount; the delivery must have adopted exactly this path. */
  worktreePath: string
  /** Shown on the closed delivery (statusDetail). */
  detail: string
}

/**
 * Transfer the adopted worktree back. `commit` runs INSIDE the transaction
 * (it saves the Flow's state); throwing rolls back the ledger and the delivery
 * too. Idempotent: a delivery already `returned_to_flow` returns its snapshot
 * without calling `commit` again.
 */
export function returnFlowWorktree(db: DbInstance, input: FlowWorktreeReturnInput, commit: () => void): PrDeliverySnapshot {
  return db.transaction(() => {
    const row = getPrDelivery(db, input.deliveryId)
    if (!row || row.loop_id !== FLOW_SPEC_DELIVERY_LOOP_ID) throw new FlowReturnRejectedError('flow_return_not_found', 'This delivery is not a Flow → Spec run')
    if (row.decision === 'discarded' && row.status_code === 'returned_to_flow') return toPrDeliverySnapshot(row)
    if (row.decision !== 'implementation_failed') {
      throw new FlowReturnRejectedError('flow_return_not_allowed', 'Only a Flow → Spec run that stopped before delivery can go back to its Flow')
    }
    if (row.operation_token || row.operation) throw new FlowReturnRejectedError('flow_return_busy', 'The delivery is busy; try again when its current action finishes')
    const snap = toPrDeliverySnapshot(row)
    if (!snap.branches.some((unit) => unit.worktreePath === input.worktreePath)) {
      throw new FlowReturnRejectedError('flow_return_worktree_mismatch', 'The delivery did not adopt this Flow worktree')
    }
    const runIds = new Set(snap.runIds)
    const ledger = (db.prepare('SELECT id, run_id FROM rail_worktrees WHERE worktree_path = ?').all(input.worktreePath) as Array<{ id: string; run_id: string | null }>)
      .filter((entry) => entry.run_id === null || runIds.has(entry.run_id))
    for (const entry of ledger) db.prepare('DELETE FROM rail_worktrees WHERE id = ?').run(entry.id)
    const released = new Set(ledger.map((entry) => entry.id))
    if (!transitionDecision(db, row.id, 'implementation_failed', 'discarded', {
      statusCode: 'returned_to_flow',
      statusDetail: input.detail,
      worktreeIds: snap.worktreeIds.filter((id) => !released.has(id)),
    })) throw new FlowReturnRejectedError('flow_return_busy', 'The delivery changed while returning its worktree')
    commit()
    return toPrDeliverySnapshot(getPrDelivery(db, row.id)!)
  })()
}

/** Re-broadcast a closed delivery to the rail strip and its mission card. Never throws. */
export function announceReturnedDelivery(projectId: string, snap: PrDeliverySnapshot, broadcast: (message: WsMessage) => void): void {
  try { broadcast(toRailPrStateMessage(projectId, snap) as WsMessage) } catch { /* hydration recovers */ }
  try {
    if (snap.originConversationId) getAgentChatManager()?.updatePrDecisionCard(snap.originConversationId, toPrDecisionCardEnvelope(projectId, snap))
  } catch { /* the card refreshes on its next hydration */ }
}
