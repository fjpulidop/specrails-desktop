// ─── Local overlay of card decisions (mission-rail-cards) ─────────────────────
// The server persists a decision on `agent_messages.intent`, but the message
// array in AgentChatContext is only re-fetched on conversation (re)load. A
// decision taken RIGHT NOW must freeze the card and unpin it immediately, so
// this tiny store keeps a session-local overlay keyed by message id that the
// proposal hook merges over the persisted `intent`. Cold loads read the row.

import { useSyncExternalStore } from 'react'
import type { AgentMessageIntent } from '../../missions/lib/agent-api'

type Listener = () => void
let intents: ReadonlyMap<string, readonly AgentMessageIntent[]> = new Map()
const listeners = new Set<Listener>()

export function recordLocalIntent(messageId: string, intent: AgentMessageIntent): void {
  const next = new Map(intents)
  const current = next.get(messageId) ?? []
  next.set(messageId, [...current.filter((i) => i.proposalIndex !== intent.proposalIndex), intent])
  intents = next
  for (const l of listeners) l()
}

/** Test seam. */
export function resetLocalIntents(): void {
  intents = new Map()
  for (const l of listeners) l()
}

function subscribe(l: Listener): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export function useLocalIntents(): ReadonlyMap<string, readonly AgentMessageIntent[]> {
  return useSyncExternalStore(subscribe, () => intents, () => intents)
}

/** The decision that applies to ONE proposal of a message: the local overlay
 *  wins over the persisted row; each proposal index is decided independently. */
export function intentFor(
  local: ReadonlyMap<string, readonly AgentMessageIntent[]>,
  messageId: string,
  persisted: readonly AgentMessageIntent[] | null | undefined,
  proposalIndex: number,
): AgentMessageIntent | null {
  return local.get(messageId)?.find((i) => i.proposalIndex === proposalIndex)
    ?? persisted?.find((i) => i.proposalIndex === proposalIndex)
    ?? null
}
