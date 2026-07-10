import {
  parsePrDecisionEnvelope,
  type AgentMessage,
  type AgentPrDecisionEnvelope,
  type AgentPrDecisionValue,
} from '../../lib/agent-api'

// ── PR-decision card pinning (safe-pr-review-flow) ────────────────────────────
// While a delivery still DEMANDS ATTENTION its card is pinned above the chat
// composer; once published or terminal it unpins back into chat history.
// Locked semantics: PINNED while the card still needs a decision. Published
// PRs unpin at pr_ready; terminal completed/merged/discarded/superseded cards
// stay in history. No-change and closed-without-merge still need an action.

export const PINNED_PR_DECISIONS: ReadonlySet<AgentPrDecisionValue> = new Set([
  'building',
  'on_review',
  'pr_draft',
  'no_changes',
  'pr_closed',
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
