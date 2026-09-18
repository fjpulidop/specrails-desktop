// ─── Local overlay of card decisions (mission-rail-cards) ─────────────────────
// The server persists a decision on `agent_messages.intent`, but the message
// array in AgentChatContext is only re-fetched on conversation (re)load. A
// decision taken RIGHT NOW must freeze the card and unpin it immediately, so
// this tiny store keeps a session-local overlay keyed by message id that the
// proposal hook merges over the persisted `intent`. Cold loads read the row.

import { useSyncExternalStore } from 'react'
import type { AgentMessageIntent } from './agent-api'

type Listener = () => void
let intents: ReadonlyMap<string, AgentMessageIntent> = new Map()
const listeners = new Set<Listener>()

export function recordLocalIntent(messageId: string, intent: AgentMessageIntent): void {
  const next = new Map(intents)
  next.set(messageId, intent)
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

export function useLocalIntents(): ReadonlyMap<string, AgentMessageIntent> {
  return useSyncExternalStore(subscribe, () => intents, () => intents)
}

/** The decision that applies to a proposal: the local overlay wins over the row. */
export function intentFor(
  local: ReadonlyMap<string, AgentMessageIntent>,
  messageId: string,
  persisted: AgentMessageIntent | null | undefined,
  proposalIndex: number,
): AgentMessageIntent | null {
  const candidate = local.get(messageId) ?? persisted ?? null
  return candidate && candidate.proposalIndex === proposalIndex ? candidate : null
}
