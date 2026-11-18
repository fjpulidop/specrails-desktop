/**
 * Sending to the active mission: materialising the EMPTY compose draft into a
 * conversation, the optimistic send (user bubble or queued chip) with its
 * race reconciliation, abort, and editing / steering / removing a queued
 * message. Every write is refused for a mission owned by another window.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import i18n from '../../../../lib/i18n'
import { notifyError } from '../../../../lib/notify-error'
import type { AgentQueuedItem } from '../../lib/live-store'
import {
  createAgentConversation,
  sendAgentMessage,
  abortAgentTurn,
  editQueuedAgentMessage,
  steerQueuedAgentMessage,
  removeQueuedAgentMessage,
  type AgentConversation,
  type AgentContextReference,
  type AgentTierLevel,
} from '../../lib/agent-api'
import { migrateNewMissionComposerDrafts } from '../../lib/agent-composer-drafts'
import { latestReceipt, mergeTranscriptRows } from '../../lib/agent-chat-transcript'
import { nextQueueSeq } from '../../lib/agent-chat-ws'
import type { AgentChatCore } from './useAgentChatCore'

export function useAgentSending(core: AgentChatCore, opts: {
  setConversations: Dispatch<SetStateAction<AgentConversation[]>>
  draftPinRef: MutableRefObject<string | null>
  draftConvRef: MutableRefObject<{ provider: string; model: string | null; tierLevel: AgentTierLevel; effort: string | null }>
  reconcileActiveTurns: () => Promise<void>
  hydrateActivePrCards: () => Promise<boolean>
}) {
  const {
    editable, active, setActive, setMessages, activeIdRef, liveStore, patchLive,
    consumedQueueIdsRef, removedQueueIdsRef, inputReceiptsRef, inputMessageIdsRef, withReceipt,
    conversationEventVersionRef, queueClearVersionRef, transcriptEventsRef, draftMaterializeRef, localTurnStartedAtRef,
  } = core
  const { setConversations, draftPinRef, draftConvRef, reconcileActiveTurns, hydrateActivePrCards } = opts

  const materializeDraftConversation = useCallback(async (): Promise<AgentConversation> => {
    if (!editable(active?.id)) throw new Error('This mission is active in another window.')
    if (active) return active
    if (draftMaterializeRef.current) return draftMaterializeRef.current

    const promise = createAgentConversation({
      pinnedProjectId: draftPinRef.current,
      provider: draftConvRef.current.provider,
      model: draftConvRef.current.model,
      tierLevel: draftConvRef.current.tierLevel,
      reasoningEffort: draftConvRef.current.effort,
    })
      .then((created) => {
        // Move the empty-compose-screen drafts (typed text + attachment chips)
        // to the real conversation id BEFORE flipping `active`, so the
        // composer's restore-on-switch effect finds them under the new key —
        // this covers materialization triggered OUTSIDE the composer too
        // (e.g. a browser capture from the workspace sidebar).
        migrateNewMissionComposerDrafts(created.id)
        setConversations((c) => [created, ...c.filter((row) => row.id !== created.id)])
        setActive(created)
        setMessages([])
        return created
      })
      .finally(() => {
        draftMaterializeRef.current = null
      })

    draftMaterializeRef.current = promise
    return promise
  }, [active])

  const send = useCallback(async (text: string, opts?: { attachmentIds?: string[]; contextRefs?: AgentContextReference[]; queueId?: string; deliveryMode?: 'interrupt' }): Promise<{ accepted: boolean; conversationId?: string }> => {
    if (!editable(active?.id) || active?.archivedAt) return { accepted: false }
    const trimmed = text.trim()
    if (!trimmed) return { accepted: false }
    // EMPTY compose screen (no active conversation) ALWAYS starts a fresh
    // conversation with the draft pin — it never resurrects the latest chat.
    const conv = active ?? await materializeDraftConversation()
    conversationEventVersionRef.current.set(conv.id, (conversationEventVersionRef.current.get(conv.id) ?? 0) + 1)
    const sendEventVersion = conversationEventVersionRef.current.get(conv.id)
    const queueClearVersion = queueClearVersionRef.current.get(conv.id) ?? 0
    const queueId = opts?.queueId ?? `q-${Date.now()}-${nextQueueSeq()}`
    const nowIso = new Date().toISOString()
    localTurnStartedAtRef.current.set(conv.id, nowIso)
    // "Last interaction" is NOW — bump the conversation's updated_at (so the
    // mission-list time-since counter resets immediately to "now") and float it
    // to the top (newest-first, matching the server's ORDER BY updated_at DESC).
    setConversations((cs) => {
      const found = cs.find((c) => c.id === conv!.id)
      const bumped = { ...(found ?? conv!), updated_at: nowIso }
      return [bumped, ...cs.filter((c) => c.id !== conv!.id)]
    })
    setActive((a) => (a && a.id === conv!.id ? { ...a, updated_at: nowIso } : a))
    const userBubble = {
      id: `local-u-${queueId}`,
      conversation_id: conv.id,
      role: 'user' as const,
      content: trimmed,
      attachment_ids: opts?.attachmentIds ?? [],
      context_refs: opts?.contextRefs ?? [],
      delivery_receipt: 'sent' as const,
      created_at: nowIso,
    }
    // Busy sends wait for the next turn unless the user explicitly picks Steer.
    const wasBusy = liveStore.get(conv.id)?.isStreaming === true
    // An interrupt is admitted as a native steer server-side (IntentSession mode).
    const interrupt = wasBusy && opts?.deliveryMode === 'interrupt'
    const pendingItem: AgentQueuedItem = { queueId, text: trimmed, contextRefs: opts?.contextRefs, attachmentIds: opts?.attachmentIds, deliveryMode: interrupt ? 'steer' : 'queue', deliveryReceipt: 'sent', timestamp: nowIso }
    if (wasBusy) {
      patchLive(conv.id, (p) => ({ ...p, queued: p.queued.some((item) => item.queueId === queueId)
        ? p.queued.map((item) => item.queueId === queueId ? { ...pendingItem, deliveryReceipt: latestReceipt(item.deliveryReceipt, pendingItem.deliveryReceipt), deliveryMode: item.deliveryMode ?? pendingItem.deliveryMode, timestamp: item.timestamp ?? pendingItem.timestamp } : item)
        : [...p.queued, pendingItem] }))
    } else {
      setMessages((m) => [...m, userBubble])
      patchLive(conv.id, (p) => ({ ...p, isStreaming: true, streamingText: '', liveTools: [] }))
    }
    const attachments = opts?.attachmentIds && opts.attachmentIds.length ? { ids: opts.attachmentIds } : undefined
    try {
      const contextRefs = opts?.contextRefs && opts.contextRefs.length ? opts.contextRefs : undefined
      const res = await sendAgentMessage(conv.id, trimmed, { tierLevel: conv.tier_level, attachments, queueId, contextRefs, ...(interrupt ? { deliveryMode: 'interrupt' as const } : {}) })
      if (res.removed) {
        // A durable deletion survives reloads, unlike this window's tombstones.
        // Its idempotent retry must never become a new user bubble or turn.
        consumedQueueIdsRef.current.add(queueId)
        removedQueueIdsRef.current.add(queueId)
        const undoIdleStart = !wasBusy && sendEventVersion === conversationEventVersionRef.current.get(conv.id)
        if (activeIdRef.current === conv.id) setMessages((current) => current.filter((message) => message.id !== userBubble.id))
        patchLive(conv.id, (previous) => ({
          ...previous,
          queued: previous.queued.filter((item) => item.queueId !== queueId),
          ...(undoIdleStart ? { isStreaming: false } : {}),
        }))
        if (undoIdleStart) localTurnStartedAtRef.current.delete(conv.id)
        return { accepted: true, conversationId: conv.id }
      }
      if (res.message) {
        inputMessageIdsRef.current.set(`${conv.id}:q:${queueId}`, res.message.id)
        const receipt = latestReceipt(res.message.delivery_receipt, inputReceiptsRef.current.get(`${conv.id}:q:${queueId}`))
        const canonical = withReceipt({ ...res.message, ...(receipt ? { delivery_receipt: receipt } : {}) })
        consumedQueueIdsRef.current.add(queueId)
        transcriptEventsRef.current.set(conv.id, mergeTranscriptRows(transcriptEventsRef.current.get(conv.id) ?? [], [canonical]).slice(-500))
        if (activeIdRef.current === conv.id) setMessages((current) => mergeTranscriptRows(current.filter((message) => message.id !== userBubble.id), [canonical]))
        patchLive(conv.id, (previous) => ({ ...previous, queued: previous.queued.filter((item) => item.queueId !== queueId) }))
        if (res.duplicate) void reconcileActiveTurns()
        return { accepted: true, conversationId: conv.id }
      }
      if (queueClearVersion !== (queueClearVersionRef.current.get(conv.id) ?? 0)) {
        setMessages((current) => current.filter((message) => message.id !== userBubble.id))
        return { accepted: true, conversationId: conv.id }
      }
      const queued = res?.queued === true
      if (queued && !wasBusy) {
        // Rare race: the server was actually mid-turn — re-home the optimistic
        // bubble as a queued chip (the agent_queued event dedupes by queueId).
        // If its agent_dequeued ALREADY ran while this POST was in flight, the
        // chip is consumed — re-adding it would park a phantom chip forever.
        setMessages((m) => m.filter((x) => x.id !== userBubble.id))
        if (!consumedQueueIdsRef.current.has(queueId)) {
          patchLive(conv.id, (p) =>
            p.queued.some((q) => q.queueId === queueId)
              ? p
              : { ...p, queued: [...p.queued, { ...pendingItem, deliveryMode: res.deliveryMode === 'interrupt' ? 'steer' : res.deliveryMode ?? pendingItem.deliveryMode }] },
          )
        }
      } else if (!queued && wasBusy && !consumedQueueIdsRef.current.has(queueId)) {
        // Rare race: the turn had just settled — our chip is running as a direct
        // turn (no agent_dequeued will ever come for it), promote it now.
        patchLive(conv.id, (p) => ({ ...p, queued: p.queued.filter((q) => q.queueId !== queueId), isStreaming: true }))
        setMessages((m) => [...m, userBubble])
      }
      return { accepted: true, conversationId: conv.id }
    } catch (e) {
      if (consumedQueueIdsRef.current.has(queueId) || queueClearVersion !== (queueClearVersionRef.current.get(conv.id) ?? 0)) return { accepted: true, conversationId: conv.id }
      localTurnStartedAtRef.current.delete(conv.id)
      // No agent_* WS event will arrive (the POST never spawned a turn) — reset
      // the optimistic state here, mirroring the agent_error handler.
      if (wasBusy) {
        patchLive(conv.id, (p) => ({ ...p, queued: p.queued.filter((q) => q.queueId !== queueId) }))
      } else {
        patchLive(conv.id, (p) => ({ ...p, isStreaming: false, streamingText: '', liveTools: [] }))
        setMessages((current) => current.filter((message) => message.id !== userBubble.id))
      }
      notifyError(i18n.t('agent:errors.sendFailed'), { detail: e instanceof Error ? e.message : undefined })
      return { accepted: false, conversationId: conv.id }
    }
  }, [active, materializeDraftConversation, patchLive, liveStore, reconcileActiveTurns])

  const abort = useCallback(async () => {
    if (!active || !editable(active.id)) return
    try {
      await abortAgentTurn(active.id)
      queueClearVersionRef.current.set(active.id, (queueClearVersionRef.current.get(active.id) ?? 0) + 1)
      conversationEventVersionRef.current.set(active.id, (conversationEventVersionRef.current.get(active.id) ?? 0) + 1)
      // Preserve the live turn if stopping fails: hiding it would imply that
      // the provider stopped while it can still spend tokens and mutate state.
      patchLive(active.id, () => null)
    } catch (err) {
      notifyError(i18n.t('agent:errors.stopFailed'), { detail: err instanceof Error ? err.message : undefined })
    }
  }, [active, patchLive])

  const editQueuedMessage = useCallback(async (queueId: string, text: string): Promise<'saved' | 'conflict'> => {
    const conv = active
    if (!conv || !editable(conv.id) || liveStore.get(conv.id)?.queued.find((item) => item.queueId === queueId)?.deliveryMode === 'steer') return 'conflict'
    const r = await editQueuedAgentMessage(conv.id, queueId, text)
    if (r === 'saved') {
      // Optimistic chip update — the agent_queue_edited broadcast is a no-op here.
      patchLive(conv.id, (p) => ({
        ...p,
        queued: p.queued.map((q) => (
          q.queueId === queueId
            ? { ...q, text }
            : q
        )),
      }))
    }
    return r
  }, [active, patchLive, liveStore])

  const steerQueuedMessage = useCallback(async (queueId: string): Promise<'saved' | 'conflict'> => {
    const conv = active
    const item = conv && liveStore.get(conv.id)?.queued.find((entry) => entry.queueId === queueId)
    if (!conv || !editable(conv.id) || !item || item.deliveryMode === 'steer') return 'conflict'
    const result = await steerQueuedAgentMessage(conv.id, queueId)
    if (result === 'saved') {
      conversationEventVersionRef.current.set(conv.id, (conversationEventVersionRef.current.get(conv.id) ?? 0) + 1)
      patchLive(conv.id, (previous) => ({ ...previous, queued: previous.queued.map((entry) => entry.queueId === queueId ? { ...entry, deliveryMode: 'steer' } : entry) }))
    } else if (activeIdRef.current === conv.id) void hydrateActivePrCards()
    return result
  }, [active, patchLive, liveStore, hydrateActivePrCards])

  const removeQueuedMessage = useCallback(async (queueId: string): Promise<'saved' | 'conflict'> => {
    const conv = active
    const item = conv && liveStore.get(conv.id)?.queued.find((entry) => entry.queueId === queueId)
    if (!conv || !editable(conv.id) || !item || item.deliveryMode === 'steer') return 'conflict'
    const result = await removeQueuedAgentMessage(conv.id, queueId)
    if (result === 'saved') {
      consumedQueueIdsRef.current.add(queueId)
      removedQueueIdsRef.current.add(queueId)
      conversationEventVersionRef.current.set(conv.id, (conversationEventVersionRef.current.get(conv.id) ?? 0) + 1)
      patchLive(conv.id, (previous) => ({ ...previous, queued: previous.queued.filter((entry) => entry.queueId !== queueId) }))
    } else if (activeIdRef.current === conv.id) void hydrateActivePrCards()
    return result
  }, [active, patchLive, liveStore, hydrateActivePrCards])

  const wasQueueConsumed = useCallback((queueId: string): boolean => consumedQueueIdsRef.current.has(queueId) && !removedQueueIdsRef.current.has(queueId), [])

  return { materializeDraftConversation, send, abort, editQueuedMessage, steerQueuedMessage, removeQueuedMessage, wasQueueConsumed }
}
