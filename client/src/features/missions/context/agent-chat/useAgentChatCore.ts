/**
 * Shared core of the mission chat provider: the open conversation and its
 * transcript (state plus the refs WS handlers read synchronously), the live
 * turn store, the per-conversation version/receipt/queue bookkeeping every
 * other agent-chat hook coordinates through, and the window-editability rule.
 * Created once per provider; the focused hooks receive it as `core`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createLiveStore, type AgentConvLive, type AgentQueuedItem } from '../../lib/live-store'
import { useMissionWindows } from '../MissionWindowsContext'
import { isMissionWindowRoute } from '../../lib/mission-windows'
import { parsePrDecisionEnvelope, type AgentConversation, type AgentMessage, type AgentDeliveryReceipt, type AgentPrDecisionEnvelope } from '../../lib/agent-api'
import { isStalePrDecisionEnvelope, upsertPrDecisionMessage } from '../../lib/agent-chat-pr-envelopes'
import { latestReceipt, type ConversationSnapshot, type InflightSnapshot } from '../../lib/agent-chat-transcript'
import type { PrDecisionSnapshotApplication } from './types'

export function useAgentChatCore() {
  const missionWindows = useMissionWindows()
  const windowsRef = useRef(missionWindows)
  windowsRef.current = missionWindows
  const secondaryWindow = isMissionWindowRoute()
  const editable = (id?: string | null) => id ? windowsRef.current.isEditable(id) : !secondaryWindow

  const [active, setActive] = useState<AgentConversation | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const metadataVersion = useRef(new Map<string, number>())
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  // Live turn state is PER CONVERSATION: agents keep working in the background,
  // so switching threads never drops streamed text, tool chips or queued
  // messages. The view derives the active conversation's slice below.
  // They live in an external store (lib/live-store.ts), NOT in React state: a
  // streamed token must not re-render this provider or its consumers. Components
  // subscribe to their own slice through hooks/useAgentLive.ts.
  const [liveStore] = useState(createLiveStore)
  useEffect(() => () => liveStore.dispose(), [liveStore])

  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = active?.id ?? null
  // The open mission flushes its tokens once per frame; the others at a low cadence.
  useEffect(() => { liveStore.setForeground(active?.id ?? null) }, [liveStore, active?.id])
  // queueIds whose agent_dequeued already ran — send()'s race reconciliation
  // must never re-add a chip that was consumed while the POST was in flight.
  const consumedQueueIdsRef = useRef(new Set<string>())
  const removedQueueIdsRef = useRef(new Set<string>())
  const inputReceiptsRef = useRef(new Map<string, AgentDeliveryReceipt>())
  const inputMessageIdsRef = useRef(new Map<string, string>())
  const withReceipt = (row: AgentMessage): AgentMessage => {
    const receipt = latestReceipt(row.delivery_receipt, inputReceiptsRef.current.get(`${row.conversation_id}:m:${row.id}`))
    return receipt ? { ...row, delivery_receipt: receipt } : row
  }
  const withPendingReceipt = (conversationId: string, item: AgentQueuedItem): AgentQueuedItem => {
    const receipt = latestReceipt(item.deliveryReceipt, inputReceiptsRef.current.get(`${conversationId}:q:${item.queueId}`))
    return receipt ? { ...item, deliveryReceipt: receipt } : item
  }
  const deliveredMessageIdsRef = useRef(new Set<string>())
  const conversationEventVersionRef = useRef(new Map<string, number>())
  // Revisit cache (stale-while-revalidate, see loadConversation) and the reads in flight.
  const archiveVersionsRef = useRef(new Map<string, number>())
  const conversationCacheRef = useRef(new Map<string, ConversationSnapshot>())
  const inflightConversationRef = useRef(new Map<string, InflightSnapshot>())
  const queueClearVersionRef = useRef(new Map<string, number>())
  const transcriptEventsRef = useRef(new Map<string, AgentMessage[]>())
  const draftMaterializeRef = useRef<Promise<AgentConversation> | null>(null)
  const prSnapshotVersionRef = useRef(0)
  // Latest `agent_pr_decision` envelope per conversation/delivery: replayed
  // over a conversation load so a broadcast that lands while the load's fetch
  // is in flight is not overwritten by the older snapshot (stale-guarded).
  const prEnvelopeEventsRef = useRef(new Map<string, Map<string, AgentPrDecisionEnvelope>>())
  // Bound after the resync hook below; WS handlers call through this ref.
  const requestCardResyncRef = useRef<() => void>(() => {})
  const conversationLoadEpochRef = useRef(0)
  const localTurnStartedAtRef = useRef(new Map<string, string>())

  const applyPrDecisionSnapshot = useCallback((
    envelope: AgentPrDecisionEnvelope,
  ): PrDecisionSnapshotApplication => {
    const conversationId = activeIdRef.current
    if (!conversationId) return 'untracked'
    if (isStalePrDecisionEnvelope(messagesRef.current, envelope)) return 'stale'
    const belongsToActiveThread = messagesRef.current.some(
      (message) => message.role === 'system' && parsePrDecisionEnvelope(message.content)?.prDeliveryId === envelope.prDeliveryId,
    )
    if (!belongsToActiveThread) return 'untracked'
    // Advance before scheduling React state so an already-resolving focus GET
    // cannot enqueue a stale overwrite in the same batch.
    prSnapshotVersionRef.current++
    const projected = upsertPrDecisionMessage(messagesRef.current, conversationId, envelope)
    messagesRef.current = projected
    setMessages((current) => {
      // An action can resolve after the user switches conversations. HTTP card
      // snapshots are update-only: the delivery must still exist in the active
      // thread, otherwise appending would leak conversation A's card into B.
      const stillBelongsToActiveThread = current.some(
        (message) => message.role === 'system' && parsePrDecisionEnvelope(message.content)?.prDeliveryId === envelope.prDeliveryId,
      )
      if (!stillBelongsToActiveThread) {
        messagesRef.current = current
        return current
      }
      const next = upsertPrDecisionMessage(current, conversationId, envelope)
      messagesRef.current = next
      return next
    })
    return 'accepted'
  }, [])

  /** Update one conversation's live slice; a fully-idle slice drops its entry. */
  const patchLive = useCallback((id: string, fn: (prev: AgentConvLive) => AgentConvLive | null) => {
    liveStore.patch(id, fn)
  }, [liveStore])
  const activeRef = useRef(active)
  activeRef.current = active
  const selectConversationRef = useRef<((id: string) => Promise<void>) | null>(null)
  const builderActiveRef = useRef(false)

  return {
    windowsRef, secondaryWindow, editable,
    active, setActive, messages, setMessages, messagesRef, metadataVersion, activeIdRef, activeRef,
    liveStore, patchLive,
    consumedQueueIdsRef, removedQueueIdsRef, inputReceiptsRef, inputMessageIdsRef, withReceipt, withPendingReceipt,
    deliveredMessageIdsRef, conversationEventVersionRef, archiveVersionsRef, conversationCacheRef, inflightConversationRef,
    queueClearVersionRef, transcriptEventsRef, draftMaterializeRef, prSnapshotVersionRef, prEnvelopeEventsRef,
    requestCardResyncRef, conversationLoadEpochRef, localTurnStartedAtRef,
    selectConversationRef, builderActiveRef,
    applyPrDecisionSnapshot,
  }
}

export type AgentChatCore = ReturnType<typeof useAgentChatCore>
