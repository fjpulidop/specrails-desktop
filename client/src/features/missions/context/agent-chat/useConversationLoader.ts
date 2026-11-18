/**
 * Opening and reconciling the active mission. Stale-while-revalidate: the last
 * snapshot of every mission the person opened (or hovered) paints a revisit at
 * once; a fresh read reconciles right after. Only the transcript/identity is
 * cached — live turn state, queue and cards are owned by the WS stream and the
 * live store, which never go stale. Also the self-healing card resync and the
 * reconnect reconciliation of active turns.
 */
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import { FEATURE_AGENT_CHAT } from '../../../../lib/feature-flags'
import { EMPTY_LIVE } from '../../lib/live-store'
import { getAgentConversation, getAgentActiveTurns, parsePrDecisionEnvelope, type AgentConversation, type AgentPrDecisionEnvelope } from '../../lib/agent-api'
import { upsertPrDecisionMessage } from '../../lib/agent-chat-pr-envelopes'
import {
  cacheConversation,
  mergeTranscriptRows,
  placeOptimisticRows,
  retainOptimisticRows,
  type ConversationSnapshot,
  type InflightSnapshot,
} from '../../lib/agent-chat-transcript'
import { hasUnsettledPrCard, usePrCardResync } from '../usePrCardResync'
import type { AgentChatCore } from './useAgentChatCore'

export function useConversationLoader(core: AgentChatCore, opts: {
  fixedConversationId: string | undefined
  clearUnread: (conversationId: string) => void
  setConversations: Dispatch<SetStateAction<AgentConversation[]>>
}) {
  const {
    secondaryWindow, active, setActive, messages, setMessages, messagesRef, metadataVersion, activeIdRef, activeRef,
    liveStore, patchLive, consumedQueueIdsRef, inputMessageIdsRef, withReceipt, withPendingReceipt, deliveredMessageIdsRef,
    conversationEventVersionRef, archiveVersionsRef, conversationCacheRef, inflightConversationRef, transcriptEventsRef,
    prSnapshotVersionRef, prEnvelopeEventsRef, requestCardResyncRef, conversationLoadEpochRef, localTurnStartedAtRef,
  } = core
  const { fixedConversationId, clearUnread, setConversations } = opts
  const shownIdRef = useRef<string | null>(null)
  useEffect(() => { shownIdRef.current = null }, [active?.id])

  /** One GET per mission at a time: concurrent opens, hovers and focus syncs share it.
   *  The WS event version is stamped when the request is CREATED (a hover prefetch
   *  included): a response older than any live event must never overwrite live state. */
  const startConversationSnapshot = useCallback((id: string): InflightSnapshot => {
    const pending = inflightConversationRef.current.get(id)
    if (pending) return pending
    const archiveVersion = archiveVersionsRef.current.get(id) ?? 0
    const promise = getAgentConversation(id)
      .then((snapshot) => {
        if (archiveVersion === (archiveVersionsRef.current.get(id) ?? 0)) cacheConversation(conversationCacheRef.current, id, snapshot)
        return snapshot
      })
      .finally(() => { if (inflightConversationRef.current.get(id) === entry) inflightConversationRef.current.delete(id) })
    const entry: InflightSnapshot = { promise, versionAtStart: conversationEventVersionRef.current.get(id) ?? 0, archiveVersion }
    inflightConversationRef.current.set(id, entry)
    return entry
  }, [])

  const prefetchConversation = useCallback((id: string): void => {
    if (id === activeIdRef.current || fixedConversationId || secondaryWindow) return
    if (conversationCacheRef.current.has(id) || inflightConversationRef.current.has(id)) return
    void startConversationSnapshot(id).promise.catch(() => { /* a hover must never surface an error */ })
  }, [startConversationSnapshot, fixedConversationId, secondaryWindow])

  /** Paint a snapshot as the open mission: transcript, rows' receipts, PR cards. */
  const showConversation = useCallback((id: string, snapshot: ConversationSnapshot) => {
    prSnapshotVersionRef.current++
    const merged = mergeTranscriptRows(snapshot.messages, transcriptEventsRef.current.get(id) ?? []).map(withReceipt)
    // `shownIdRef` leads `active` by a render: a cached paint followed at once by
    // its revalidation must still see that this mission is the one on screen.
    const optimistic = (shownIdRef.current ?? activeRef.current?.id) === id ? retainOptimisticRows(messagesRef.current, merged, (queueId) => inputMessageIdsRef.current.get(`${id}:q:${queueId}`)) : []
    const msgs = [...(prEnvelopeEventsRef.current.get(id)?.values() ?? [])]
      .reduce((projected, envelope) => upsertPrDecisionMessage(projected, id, envelope), optimistic.length ? placeOptimisticRows(merged, optimistic) : merged)
    for (const message of msgs) if (message.delivery_status === 'delivered' || message.delivery_status === 'interrupted') deliveredMessageIdsRef.current.add(message.id)
    shownIdRef.current = id
    setActive(snapshot.conversation)
    messagesRef.current = msgs
    setMessages(msgs)
    clearUnread(id)
  }, [clearUnread])

  const loadConversation = useCallback(async (id: string, signal?: AbortSignal) => {
    const epoch = ++conversationLoadEpochRef.current
    // Invalidates a focus/reconnect card hydration for the previous view even
    // when navigation later returns to the same conversation (C1→C2→C1 ABA).
    prSnapshotVersionRef.current++
    // Leaving a mission: remember exactly what the person saw, for the way back.
    const leaving = activeRef.current
    if (leaving && leaving.id !== id) {
      cacheConversation(conversationCacheRef.current, leaving.id, { conversation: leaving, messages: messagesRef.current })
    }
    const cached = conversationCacheRef.current.get(id)
    const revalidate = async (): Promise<void> => {
      const request = startConversationSnapshot(id)
      const eventVersion = request.versionAtStart
      const fetched = await request.promise
      const { pendingMessages, live } = fetched
      if (signal?.aborted) throw new DOMException('Window transfer cancelled', 'AbortError')
      if (epoch !== conversationLoadEpochRef.current || request.archiveVersion !== (archiveVersionsRef.current.get(id) ?? 0)) {
        if (signal) throw new DOMException('The mission changed during restoration', 'AbortError')
        return
      }
      showConversation(id, fetched)
      if (eventVersion === (conversationEventVersionRef.current.get(id) ?? 0) && (pendingMessages !== undefined || live)) {
        patchLive(id, (previous) => ({
          ...previous,
          ...(live ? { isStreaming: live.isStreaming, streamingText: live.streamingText } : {}),
          queued: pendingMessages?.filter((item) => !consumedQueueIdsRef.current.has(item.queueId)).map((item) => withPendingReceipt(id, item)) ?? previous.queued,
        }))
      }
    }
    if (cached && !signal && leaving?.id !== id) {
      // A revisit paints from its snapshot and resolves; the fresh read follows
      // on its own (a failed refresh is not a failed open).
      showConversation(id, cached)
      void revalidate().catch(() => { /* the snapshot stays; the next focus/reconnect sync retries */ })
      return
    }
    await revalidate()
    // Old servers omit live snapshots; retain background state in that case.
    // Modern snapshots hydrate reloads without overwriting newer WS events.
  }, [startConversationSnapshot, showConversation, patchLive])

  // Reconcile persisted cards and checkpoint deliveries after missed WS events.
  // Older servers still use the card-only convergence path.
  const hydrateActivePrCards = useCallback(async (): Promise<boolean> => {
    const conversationId = activeIdRef.current
    if (!conversationId) return true
    const version = prSnapshotVersionRef.current
    const eventVersion = conversationEventVersionRef.current.get(conversationId) ?? 0
    const metaVersion = metadataVersion.current.get(conversationId) ?? 0
    try {
      const fresh = await getAgentConversation(conversationId)
      if (activeIdRef.current !== conversationId || prSnapshotVersionRef.current !== version) return true
      if (metaVersion === (metadataVersion.current.get(conversationId) ?? 0)) {
        setActive(current => current?.id === conversationId ? fresh.conversation : current)
        setConversations(current => current.map(item => item.id === conversationId ? fresh.conversation : item))
      }
      // A current server snapshot also reconciles checkpoint deliveries and
      // pending inputs after missed WS events. Never overwrite a newer event.
      if ((fresh.pendingMessages !== undefined || fresh.live) && eventVersion === (conversationEventVersionRef.current.get(conversationId) ?? 0)) {
        const persisted = mergeTranscriptRows(fresh.messages, transcriptEventsRef.current.get(conversationId) ?? []).map(withReceipt)
        for (const message of persisted) if (message.delivery_status === 'delivered' || message.delivery_status === 'interrupted') deliveredMessageIdsRef.current.add(message.id)
        setMessages((current) => placeOptimisticRows(persisted, retainOptimisticRows(current, persisted, (queueId) => inputMessageIdsRef.current.get(`${conversationId}:q:${queueId}`))))
        patchLive(conversationId, (previous) => ({
          ...previous,
          ...(fresh.live ? { isStreaming: fresh.live.isStreaming, streamingText: fresh.live.streamingText } : {}),
          queued: fresh.pendingMessages?.filter((item) => !consumedQueueIdsRef.current.has(item.queueId)).map((item) => withPendingReceipt(conversationId, item)) ?? previous.queued,
        }))
      }
      const envelopes = fresh.messages
        .filter((message) => message.role === 'system')
        .map((message) => parsePrDecisionEnvelope(message.content))
        .filter((envelope): envelope is AgentPrDecisionEnvelope => envelope !== null)
      if (envelopes.length === 0) return true
      setMessages((current) => {
        const next = envelopes.reduce(
          (projected, envelope) => upsertPrDecisionMessage(projected, conversationId, envelope),
          current,
        )
        messagesRef.current = next
        return next
      })
      return true
    } catch {
      /* Advisory convergence path; the next focus/reconnect/poll retries. */
      return false
    }
  }, [patchLive])

  // Self-healing cards: visibility/focus/resume resync plus a gentle poll while
  // a card is still building, so a missed broadcast never needs a reload.
  const unsettledPrCard = useMemo(() => hasUnsettledPrCard(messages), [messages])
  const requestCardResync = usePrCardResync({
    enabled: FEATURE_AGENT_CHAT && active !== null,
    resync: hydrateActivePrCards,
    unsettled: unsettledPrCard,
  })
  requestCardResyncRef.current = requestCardResync
  const resyncRunCards = useCallback((): void => { void hydrateActivePrCards() }, [hydrateActivePrCards])

  const reconcileActiveTurns = useCallback(async (): Promise<void> => {
    try {
      const eventVersions = new Map(conversationEventVersionRef.current)
      const snapshot = await getAgentActiveTurns()
      const activeIds = new Set(snapshot.turns.map((turn) => turn.conversationId))
      const capturedAt = Date.parse(snapshot.capturedAt)
      // React may defer or repeat a state updater. Derive side effects before
      // queuing it, otherwise the interruption notice depends on eager render.
      const interrupted = [...liveStore.snapshot()].flatMap(([conversationId, live]) => {
        if (!live.isStreaming || activeIds.has(conversationId)) return []
        if ((eventVersions.get(conversationId) ?? 0) !== (conversationEventVersionRef.current.get(conversationId) ?? 0)) return []
        const startedAt = localTurnStartedAtRef.current.get(conversationId)
        if (startedAt && Date.parse(startedAt) > capturedAt) return []
        return [conversationId]
      })
      liveStore.replaceAll((current) => {
        const next = new Map(current)
        for (const [conversationId, live] of current) {
          if (!live.isStreaming || activeIds.has(conversationId)) continue
          if ((eventVersions.get(conversationId) ?? 0) !== (conversationEventVersionRef.current.get(conversationId) ?? 0)) continue
          const localStartedAt = localTurnStartedAtRef.current.get(conversationId)
          if (localStartedAt && Date.parse(localStartedAt) > capturedAt) continue
          next.set(conversationId, { ...EMPTY_LIVE, queued: live.queued, turnTools: live.liveTools.length ? live.liveTools : live.turnTools })
        }
        for (const turn of snapshot.turns) {
          const conversationId = turn.conversationId
          if ((eventVersions.get(conversationId) ?? 0) !== (conversationEventVersionRef.current.get(conversationId) ?? 0)) continue
          const live = next.get(conversationId) ?? EMPTY_LIVE
          next.set(conversationId, { ...live, isStreaming: true,
            streamingText: turn.streamingText ?? live.streamingText,
            queued: turn.pendingMessages?.filter((item) => !consumedQueueIdsRef.current.has(item.queueId)).map((item) => withPendingReceipt(conversationId, item)) ?? live.queued,
          })
        }
        return next
      })
      for (const conversationId of interrupted) localTurnStartedAtRef.current.delete(conversationId)
      const activeId = activeIdRef.current
      if (activeId && interrupted.includes(activeId)) {
        const id = `interrupted-${activeId}-${snapshot.snapshotVersion}`
        setMessages((current) => current.some((message) => message.id === id) ? current : [
          ...current,
          { id, conversation_id: activeId, role: 'assistant', content: '⚠️ The agent turn was interrupted when the Specrails server reconnected. It was not retried.', created_at: snapshot.capturedAt },
        ])
      }
      console.info('[agent-chat] reconciled active turns', { snapshotVersion: snapshot.snapshotVersion, active: activeIds.size, interrupted: interrupted.length })
    } catch {
      /* The connection may still be stabilising; a later reconnect can retry. */
    }
  }, [liveStore])

  return { prefetchConversation, loadConversation, hydrateActivePrCards, resyncRunCards, reconcileActiveTurns }
}
