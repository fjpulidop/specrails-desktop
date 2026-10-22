// ─── flow-offer protocol + display helpers (pure) ─────────────────────────────
// The operator emits ONE fenced ```flow-offer block (see
// server/modules/missions/runtime/agent-operator-prompt.ts FLOW_OFFER_SECTION):
// { idea, reason, recommended: 'flow' | 'implement', title? }.

import type { FlowCapability, FlowCost } from './flow-api'

export type FlowMode = 'flow' | 'implement'

export interface FlowOffer {
  idea: string
  reason: string | null
  recommended: FlowMode
  title: string | null
}

export const FLOW_OFFER_TAG = 'flow-offer'
export const FLOW_SPEC_LOOP_ID = 'factory:flow-spec'

const MAX_IDEA = 2000

/** Normalize a parsed fence body; null when it is not a usable offer. */
export function parseFlowOffer(payload: unknown): FlowOffer | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const o = payload as Record<string, unknown>
  const idea = typeof o.idea === 'string' ? o.idea.trim().slice(0, MAX_IDEA) : ''
  if (!idea) return null
  if (o.recommended !== 'flow' && o.recommended !== 'implement') return null
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : null
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 200) : null
  return { idea, reason, recommended: o.recommended, title }
}

export function otherMode(mode: FlowMode): FlowMode {
  return mode === 'flow' ? 'implement' : 'flow'
}

/** Missing Core capabilities → i18n keys (friendly words, never raw ids). */
export function missingCapabilityKeys(missing: readonly FlowCapability[]): string[] {
  return missing.map((capability) => `flow.missing.${capability}`)
}

/**
 * Real cost only: provider-billed turns. Nothing priced yet → null ("—");
 * `partial` flags turns the provider did not price (never estimated here).
 */
export function flowCostDisplay(cost: FlowCost | null): { usd: string | null; partial: boolean } {
  if (!cost) return { usd: null, partial: false }
  const priced = cost.turns - cost.unpricedTurns
  if (priced <= 0) return { usd: null, partial: cost.unpricedTurns > 0 }
  return { usd: `$${cost.costUsd.toFixed(cost.costUsd < 1 ? 3 : 2)}`, partial: cost.unpricedTurns > 0 }
}
