import {
  parsePrDecisionEnvelope,
  type AgentMessage,
  type AgentPrDecisionEnvelope,
  type AgentPrDecisionValue,
} from '../../lib/agent-api'

// ── PR-decision card pinning (safe-pr-review-flow) ────────────────────────────
// While a delivery still DEMANDS ATTENTION its card is pinned above the chat
// composer; once published or terminal it unpins back into chat history.
// Locked semantics: PINNED while decision ∈ {building, on_review, pr_draft,
// implementation_failed, pr_failed}; UNPINNED at pr_ready (published), merged,
// discarded.

export const PINNED_PR_DECISIONS: ReadonlySet<AgentPrDecisionValue> = new Set([
  'building',
  'on_review',
  'pr_draft',
  'implementation_failed',
  'pr_failed',
])

export function isPrDecisionPinned(decision: AgentPrDecisionValue): boolean {
  return PINNED_PR_DECISIONS.has(decision)
}

export interface PinnedPrCard {
  /** The backing system row's id — the pinned card's identity + history anchor. */
  messageId: string
  envelope: AgentPrDecisionEnvelope
}

export interface DerivedPrCards {
  /** Every parseable pr_decision system row, keyed by message id — the single
   *  parse pass the conversation view reuses per row (no per-frame reparse). */
  byMessageId: ReadonlyMap<string, AgentPrDecisionEnvelope>
  /** The pinned subset in message order — newest LAST. */
  pinned: PinnedPrCard[]
}

/**
 * One-pass derivation from the conversation's messages — memoize on the
 * `messages` array identity (it only changes on real message-state updates,
 * never on streaming frames).
 */
export function derivePrCards(messages: readonly AgentMessage[]): DerivedPrCards {
  const byMessageId = new Map<string, AgentPrDecisionEnvelope>()
  const pinned: PinnedPrCard[] = []
  for (const m of messages) {
    if (m.role !== 'system') continue
    const envelope = parsePrDecisionEnvelope(m.content)
    if (!envelope) continue
    byMessageId.set(m.id, envelope)
    if (isPrDecisionPinned(envelope.decision)) pinned.push({ messageId: m.id, envelope })
  }
  return { byMessageId, pinned }
}
