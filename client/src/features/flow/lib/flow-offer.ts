// ─── flow-offer protocol + display helpers (pure) ─────────────────────────────
// The operator emits ONE fenced ```flow-offer block (see
// server/modules/missions/runtime/agent-operator-prompt.ts FLOW_OFFER_SECTION):
// { idea, reason, title?, repositoryId?, ticketId? }. `ticketId`: the offer is
// about an EXISTING spec (idea = its title); Flow then works on that spec.
// Flow and Implement never compete: older offers carried `recommended: 'flow' | 'implement'`, which still parses
// but is ignored. `repositoryId`: the Git repository the agent triaged the idea
// into (workspace and multi-repository projects); the entry card preselects it.

import type { FlowCapability, FlowCost } from './flow-api'

export type FlowMode = 'flow' | 'implement'

export interface FlowOffer {
  idea: string
  /** Why the agent asked (neutral context, never a preference). */
  reason: string | null
  title: string | null
  /** The agent's triage of the target repository (null ⇒ none named). */
  repositoryId: string | null
  /** An EXISTING spec the offer is about (Flow works on it; Implement launches it). */
  ticketId: number | null
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
  // A legacy `recommended` is tolerated but must still be one of the two modes.
  if (o.recommended !== undefined && o.recommended !== null && o.recommended !== 'flow' && o.recommended !== 'implement') return null
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : null
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 200) : null
  const repositoryId = typeof o.repositoryId === 'string' && o.repositoryId.trim() && o.repositoryId.length <= 200 ? o.repositoryId.trim() : null
  const ticketId = typeof o.ticketId === 'number' && Number.isSafeInteger(o.ticketId) && o.ticketId > 0 ? o.ticketId : null
  return { idea, reason, title, repositoryId, ticketId }
}

/** The two paths, always in this order and with equal weight. */
export const FLOW_OFFER_MODES: readonly FlowMode[] = Object.freeze(['flow', 'implement'])

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
