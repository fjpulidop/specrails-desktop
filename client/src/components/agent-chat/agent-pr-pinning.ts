import {
  parsePrDecisionEnvelope,
  type AgentMessage,
  type AgentPrDecisionEnvelope,
  type AgentPrDecisionValue,
} from '../../lib/agent-api'
import { comparePrSnapshotUpdatedAt } from '../../lib/pr-delivery'

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
  /** Parseable legacy rows hidden because a newer row represents the same
   * delivery. Conversation rendering suppresses these without warning. */
  duplicateMessageIds: ReadonlySet<string>
  /** The pinned subset in message order — newest LAST. */
  pinned: PinnedPrCard[]
}

/**
 * One-pass derivation from the conversation's messages — memoize on the
 * `messages` array identity (it only changes on real message-state updates,
 * never on streaming frames).
 */
export function derivePrCards(messages: readonly AgentMessage[]): DerivedPrCards {
  const parsed: Array<{ messageId: string; envelope: AgentPrDecisionEnvelope; position: number }> = []
  for (const [position, message] of messages.entries()) {
    if (message.role !== 'system') continue
    const envelope = parsePrDecisionEnvelope(message.content)
    if (!envelope) continue
    parsed.push({ messageId: message.id, envelope, position })
  }

  // Pick one same-ID row by durable update time. A conflicting timestamp tie
  // keeps the first accepted row because SQLite's second precision cannot
  // prove which conflicting payload is newer.
  const canonicalByDelivery = new Map<string, typeof parsed[number]>()
  for (const card of parsed) {
    const current = canonicalByDelivery.get(card.envelope.prDeliveryId)
    if (!current) {
      canonicalByDelivery.set(card.envelope.prDeliveryId, card)
      continue
    }
    const order = comparePrSnapshotUpdatedAt(current.envelope.updatedAt, card.envelope.updatedAt)
    if (
      order === 1 ||
      (order === null && card.position > current.position)
    ) canonicalByDelivery.set(card.envelope.prDeliveryId, card)
  }

  // Lineage is a conversation-wide invariant, not a chronological rendering
  // hint. Resolve explicit edges first, then choose the latest remaining root
  // per rail by durable creation time. On an equal/missing-time ambiguity the
  // first accepted root wins fail-closed, ensuring two generations never
  // expose competing action sets without pretending row order is causality.
  const supersededDeliveryIds = new Set(
    parsed
      .map(({ envelope }) => envelope.supersedesDeliveryId)
      .filter((id): id is string => Boolean(id)),
  )
  const restorationFailedIds = new Set<string>()
  const canonicalCards = [...canonicalByDelivery.values()]
  for (const restored of canonicalCards) {
    const sourceId = restored.envelope.restoredFromDeliveryId
    if (!sourceId) continue
    let latestSuperseder: typeof parsed[number] | null = null
    for (const candidate of canonicalCards) {
      if (candidate.envelope.supersedesDeliveryId !== restored.envelope.prDeliveryId) continue
      if (!latestSuperseder) {
        latestSuperseder = candidate
        continue
      }
      const order = comparePrSnapshotUpdatedAt(
        latestSuperseder.envelope.createdAt,
        candidate.envelope.createdAt,
      )
      if (order === 1 || ((order === 0 || order === null) && candidate.position > latestSuperseder.position)) {
        latestSuperseder = candidate
      }
    }
    if (latestSuperseder && latestSuperseder.envelope.prDeliveryId !== sourceId) continue
    supersededDeliveryIds.delete(restored.envelope.prDeliveryId)
    supersededDeliveryIds.add(sourceId)
    restorationFailedIds.add(sourceId)
  }
  const rootsByRail = new Map<number, Array<typeof parsed[number]>>()
  for (const card of canonicalByDelivery.values()) {
    if (supersededDeliveryIds.has(card.envelope.prDeliveryId)) continue
    const roots = rootsByRail.get(card.envelope.railIndex) ?? []
    roots.push(card)
    rootsByRail.set(card.envelope.railIndex, roots)
  }
  for (const roots of rootsByRail.values()) {
    if (roots.length <= 1) continue
    let winner = roots[0]
    for (const candidate of roots.slice(1)) {
      const order = comparePrSnapshotUpdatedAt(winner.envelope.createdAt, candidate.envelope.createdAt)
      if (order === 1) winner = candidate
    }
    for (const card of roots) {
      if (card.envelope.prDeliveryId !== winner.envelope.prDeliveryId) {
        supersededDeliveryIds.add(card.envelope.prDeliveryId)
      }
    }
  }
  const projected = parsed.map((card) => (
    supersededDeliveryIds.has(card.envelope.prDeliveryId) && (
      card.envelope.decision !== 'superseded' ||
      restorationFailedIds.has(card.envelope.prDeliveryId)
    )
      ? {
          ...card,
          envelope: {
            ...card.envelope,
            decision: restorationFailedIds.has(card.envelope.prDeliveryId)
              ? 'discarded' as const
              : 'superseded' as const,
          },
        }
      : card
  ))

  const byMessageId = new Map<string, AgentPrDecisionEnvelope>()
  const duplicateMessageIds = new Set<string>()
  const pinned: PinnedPrCard[] = []
  for (const card of projected) {
    if (canonicalByDelivery.get(card.envelope.prDeliveryId)?.messageId !== card.messageId) {
      duplicateMessageIds.add(card.messageId)
      continue
    }
    byMessageId.set(card.messageId, card.envelope)
    if (isPrDecisionPinned(card.envelope.decision)) pinned.push(card)
  }
  return { byMessageId, duplicateMessageIds, pinned }
}
