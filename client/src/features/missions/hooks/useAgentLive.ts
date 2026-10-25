/**
 * Subscriptions to the per-conversation live-turn store (lib/live-store.ts).
 *
 * `useAgentChat()` deliberately carries NO streaming state: a token must not
 * re-render every consumer of the chat context. Read the live state through
 * these hooks, each subscribing to exactly what it renders:
 *
 * - `useActiveLive()`        the open mission's whole slice (text included) — the
 *                            streaming tail only.
 * - `useIsStreaming()`       is the open mission working (boolean; flips rarely).
 * - `useActiveQueued()`      the open mission's queued inputs.
 * - `useStreamingConversationIds()` / `useQueuedCounts()` / `useIsConversationStreaming(id)`
 *                            aggregates for lists and palettes; stable identity while
 *                            their content is unchanged, so tokens never re-render them.
 *
 * Without a provider (isolated component tests that mock `useAgentChat`) the hooks
 * fall back to the legacy fields on the mocked chat object.
 */
import { useContext, useRef, useSyncExternalStore } from 'react'
import { useAgentChat } from '../context/AgentChatContext'
import { LiveStoreContext } from '../context/LiveStoreContext'
import { EMPTY_LIVE, type AgentConvLive, type AgentQueuedItem, type LiveMap, type LiveStore } from '../lib/live-store'

const noopSubscribe = () => () => {}
const NO_QUEUE: readonly AgentQueuedItem[] = []

export function useLiveStore(): LiveStore | null {
  return useContext(LiveStoreContext)
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}
function sameCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [key, value] of a) if (b.get(key) !== value) return false
  return true
}

/**
 * Subscribe to a value derived from the store. `scope` picks the channel:
 * a conversation id (every change of that slice) or 'structural' (aggregates,
 * never fired by text-only changes). The derived value keeps its identity while
 * `equal` holds, so a consumer re-renders only when what it shows changed.
 */
function useLiveSelect<T>(
  scope: string | 'structural' | null,
  select: (map: LiveMap) => T,
  equal: (a: T, b: T) => boolean,
  legacy: () => T,
): T {
  const store = useLiveStore()
  const cache = useRef<{ value: T } | null>(null)
  const legacyValue = store ? undefined : legacy()
  const getSnapshot = (): T => {
    const next = store ? select(store.snapshot()) : (legacyValue as T)
    if (cache.current && equal(cache.current.value, next)) return cache.current.value
    cache.current = { value: next }
    return next
  }
  const subscribe = store && scope
    ? (listener: () => void) => (scope === 'structural' ? store.subscribe(listener) : store.subscribeId(scope, listener))
    : noopSubscribe
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** One mission's whole live slice, text included (re-renders per flushed frame). */
export function useConversationLive(id: string | null | undefined): AgentConvLive {
  const chat = useAgentChat()
  return useLiveSelect(
    id ?? null,
    (map) => (id ? map.get(id) : undefined) ?? EMPTY_LIVE,
    Object.is,
    () => (id && chat.active?.id === id ? {
      streamingText: chat.streamingText ?? '', isStreaming: chat.isStreaming ?? false,
      liveTools: chat.liveTools ?? [], turnTools: chat.turnTools ?? [], queued: chat.queuedMessages ?? [],
    } : chat.liveByConversation?.get(id ?? '') ?? EMPTY_LIVE),
  )
}

/** The open mission's slice. Only the streaming tail should call this. */
export function useActiveLive(): AgentConvLive {
  const { active } = useAgentChat()
  return useConversationLive(active?.id)
}

/** Is the open mission working? Notified on structural changes only. */
export function useIsStreaming(): boolean {
  const chat = useAgentChat()
  const id = chat.active?.id ?? null
  return useLiveSelect('structural', (map) => (id ? map.get(id)?.isStreaming === true : false), Object.is, () => chat.isStreaming ?? false)
}

export function useActiveQueued(): readonly AgentQueuedItem[] {
  const chat = useAgentChat()
  const id = chat.active?.id ?? null
  return useLiveSelect('structural', (map) => (id ? map.get(id)?.queued : undefined) ?? NO_QUEUE, Object.is, () => chat.queuedMessages ?? NO_QUEUE)
}

/** Is mission `id` working? (palette rows, header delete confirmation). */
export function useIsConversationStreaming(id: string | null | undefined): boolean {
  const chat = useAgentChat()
  return useLiveSelect('structural', (map) => (id ? map.get(id)?.isStreaming === true : false), Object.is,
    () => (id ? chat.liveByConversation?.get(id)?.isStreaming === true || chat.streamingConversationIds?.has(id) === true : false))
}

/** Every mission with a live turn. Same Set while membership is unchanged. */
export function useStreamingConversationIds(): ReadonlySet<string> {
  const chat = useAgentChat()
  return useLiveSelect('structural', (map) => {
    const ids = new Set<string>()
    for (const [id, live] of map) if (live.isStreaming) ids.add(id)
    return ids as ReadonlySet<string>
  }, sameSet, () => {
    if (chat.streamingConversationIds) return chat.streamingConversationIds
    const ids = new Set<string>()
    for (const [id, live] of chat.liveByConversation ?? []) if (live.isStreaming) ids.add(id)
    return ids
  })
}

/** Queued-message count per mission (selector badges). */
export function useQueuedCounts(): ReadonlyMap<string, number> {
  const chat = useAgentChat()
  return useLiveSelect('structural', (map) => {
    const counts = new Map<string, number>()
    for (const [id, live] of map) if (live.queued.length > 0) counts.set(id, live.queued.length)
    return counts as ReadonlyMap<string, number>
  }, sameCounts, () => {
    const counts = new Map<string, number>()
    for (const [id, live] of chat.liveByConversation ?? []) if (live.queued.length > 0) counts.set(id, live.queued.length)
    return counts
  })
}
