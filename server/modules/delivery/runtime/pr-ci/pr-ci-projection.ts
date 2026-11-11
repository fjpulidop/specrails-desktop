import type { DbInstance } from '../../../../db'
import { isPrCiLoopEnabled } from '../../../../feature-flags'
import { loadCoreAgentRuntime } from '../../../agent-runtime/runtime/agent-runtime-loader'
import { supportsPrCi } from '../../../loops/runtime/loop-pr-ci-recipe'
import { getAgentChatManager } from '../../../missions/runtime/agent-chat-registry'
import { projectPrCiOffer } from './pr-ci-offer'
import { getPrDelivery } from '../rail-pr-store'

/** Whether the selected Core can run the PR CI loop (any failure reads as "no"). */
export async function prCiCapable(): Promise<boolean> {
  if (!isPrCiLoopEnabled()) return false
  try { return supportsPrCi((await loadCoreAgentRuntime()).api?.capabilities as Record<string, number> | undefined) } catch { return false }
}

/** Advisory projection after any delivery change; never throws, never blocks the caller. */
export function refreshPrCiOffer(ctx: { db: DbInstance; project: { id: string } }, deliveryId: string): void {
  void prCiCapable().then(capable => {
    projectPrCiOffer(ctx.db, ctx.project.id, getAgentChatManager(), deliveryId, { capable })
    // A repository delivery changes its multi-repository generation: project the parent too.
    const parent = getPrDelivery(ctx.db, deliveryId)?.parent_delivery_id
    if (parent) projectPrCiOffer(ctx.db, ctx.project.id, getAgentChatManager(), parent, { capable })
  }).catch(() => { /* the offer is optional */ })
}
