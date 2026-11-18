/**
 * Pure transcript helpers of the mission chat: delivery receipt ordering,
 * merging WS/HTTP rows, keeping optimistic rows across a revalidation, and the
 * small revisit cache of conversation snapshots.
 */
import type { getAgentConversation, AgentDeliveryReceipt, AgentMessage } from './agent-api'

const receiptRank = { sent: 0, received: 1, read: 2 }
export function latestReceipt(a?: AgentDeliveryReceipt, b?: AgentDeliveryReceipt): AgentDeliveryReceipt | undefined {
  return !a ? b : !b || receiptRank[a] >= receiptRank[b] ? a : b
}

export function mergeTranscriptRows(current: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const rows = [...current]
  for (const [incomingIndex, message] of incoming.entries()) {
    const index = rows.findIndex((row) => row.id === message.id)
    if (index >= 0) {
      const receipt = latestReceipt(rows[index].delivery_receipt, message.delivery_receipt)
      rows[index] = { ...message, ...(receipt ? { delivery_receipt: receipt } : {}) }
    }
    else {
      // HTTP can acknowledge a user row before WS delivers the preceding
      // assistant segment. Insert that segment before its already-known user.
      const nextIds = new Set(incoming.slice(incomingIndex + 1).map((row) => row.id))
      const nextIndex = rows.findIndex((row) => nextIds.has(row.id))
      if (nextIndex >= 0) rows.splice(nextIndex, 0, message)
      else rows.push(message)
    }
  }
  return rows
}

export type ConversationSnapshot = Awaited<ReturnType<typeof getAgentConversation>>

/**
 * Optimistic rows the server has not echoed yet (`local-u-<queueId>` user bubbles, `err-`
 * failure notes). A background revalidation replaces the transcript with the
 * persisted one; these must survive it — unless the snapshot already carries
 * the persisted copy of the same user message. That copy is recognised by id only:
 * the bubble's own id, the persisted row's `queue_id` (the id the client sent, which the
 * server stores with the message), or the server message id the send acknowledged
 * (`serverIdOf`). Never by content: a repeated "ok" is a different message.
 */
export function retainOptimisticRows(current: AgentMessage[], persisted: AgentMessage[], serverIdOf?: (queueId: string) => string | undefined): AgentMessage[] {
  return current.filter((message) => {
    if (message.id.startsWith('err-')) return !persisted.some((row) => row.id === message.id)
    if (!message.id.startsWith('local-u-')) return false
    const queueId = message.id.slice('local-u-'.length)
    const serverId = serverIdOf?.(queueId)
    return !persisted.some((row) => row.id === message.id || row.queue_id === queueId || (serverId !== undefined && row.id === serverId))
  })
}

/**
 * Put retained optimistic rows back on a persisted transcript. A row that remembers the row
 * before it (`client_after_id`, set on `err-` notes) goes right after it; the rest append.
 */
export function placeOptimisticRows(base: AgentMessage[], optimistic: AgentMessage[]): AgentMessage[] {
  const rows = [...base]
  const placed = new Set<string>()
  // An anchor on an optimistic bubble (`local-u-<queueId>`) follows it to its saved row once the send is acknowledged.
  const anchorId = (id: string): string => {
    if (!id.startsWith('local-u-')) return id
    const queueId = id.slice('local-u-'.length)
    return rows.find((row) => row.queue_id === queueId)?.id ?? id
  }
  for (const message of optimistic) {
    const anchor = message.client_after_id ? anchorId(message.client_after_id) : null
    let index = anchor ? rows.findIndex((row) => row.id === anchor) : -1
    if (index >= 0) {
      while (index + 1 < rows.length && placed.has(rows[index + 1].id)) index++
      rows.splice(index + 1, 0, message)
    } else rows.push(message)
    placed.add(message.id)
  }
  return rows
}

/** A renamed mission must also read renamed when it is repainted from the revisit cache. */
export function patchCachedTitle(cache: Map<string, ConversationSnapshot>, id: string, title: string | null): void {
  const cached = cache.get(id)
  if (cached) cache.set(id, { ...cached, conversation: { ...cached.conversation, title } })
}

/** A snapshot read in flight, stamped with the WS event version it started at. */
export interface InflightSnapshot { promise: Promise<ConversationSnapshot>; versionAtStart: number; archiveVersion: number }

/** Revisit cache size: a transcript is the heavy part, a dozen missions is plenty. */
const CONVERSATION_CACHE_LIMIT = 12
export function cacheConversation(cache: Map<string, ConversationSnapshot>, id: string, snapshot: ConversationSnapshot): void {
  cache.delete(id) // re-insert as most recent
  cache.set(id, snapshot)
  while (cache.size > CONVERSATION_CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
}
