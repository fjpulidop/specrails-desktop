/**
 * The mission chat's app-global WebSocket handler (`agent_*` events, no
 * projectId filter): titles and context usage for the list, per-conversation
 * live turn state (stream, tools, queue, receipts) for every conversation, and
 * transcript rows / PR-decision cards for the ACTIVE thread only.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useSharedWebSocket } from '../../../../hooks/useSharedWebSocket'
import { FEATURE_AGENT_CHAT } from '../../../../lib/feature-flags'
import { notifyError } from '../../../../lib/notify-error'
import { EMPTY_LIVE } from '../../lib/live-store'
import { coercePrDecisionEnvelope, type AgentConversation, type AgentContextUsage, type AgentMessage, type AgentPrDecisionEnvelope } from '../../lib/agent-api'
import { upsertPrDecisionMessage } from '../../lib/agent-chat-pr-envelopes'
import { latestReceipt, mergeTranscriptRows, patchCachedTitle } from '../../lib/agent-chat-transcript'
import { describeAgentError, describeAgentErrorToast, nextQueueSeq, nextToolSeq, type WsAgentMsg } from '../../lib/agent-chat-ws'
import { railStateDiffersFromCard } from '../usePrCardResync'
import type { AgentChatCore } from './useAgentChatCore'

/** Hard cap on retained activity entries per turn — the modal is a preview
 *  surface, not an archive; unbounded pushes would leak on very long turns. */
const MAX_ACTIVITY_ENTRIES = 200

export function useAgentWsEvents(core: AgentChatCore, opts: {
  handlerId: string
  fixedConversationId: string | undefined
  refreshConversations: () => Promise<void>
  setConversations: Dispatch<SetStateAction<AgentConversation[]>>
  markUnread: (conversationId: string) => void
  recordAttention: (conversationId: string, envelope: AgentPrDecisionEnvelope) => void
}) {
  const {
    secondaryWindow, setActive, setMessages, messagesRef, activeIdRef, liveStore, patchLive,
    consumedQueueIdsRef, removedQueueIdsRef, inputReceiptsRef, inputMessageIdsRef, withReceipt,
    deliveredMessageIdsRef, conversationEventVersionRef, conversationCacheRef, queueClearVersionRef,
    transcriptEventsRef, prSnapshotVersionRef, prEnvelopeEventsRef, requestCardResyncRef,
    localTurnStartedAtRef, selectConversationRef, builderActiveRef,
  } = core
  const { handlerId, fixedConversationId, refreshConversations, setConversations, markUnread, recordAttention } = opts
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const [projectRecoveryRevision, setProjectRecoveryRevision] = useState(0)

  // ── WebSocket: app-global agent_* events (no projectId filter) ──────────────
  useEffect(() => {
    if (!FEATURE_AGENT_CHAT) return
    const handler = (raw: unknown): void => {
      const msg = raw as WsAgentMsg
      if (!msg) return
      if (fixedConversationId && msg.conversationId && msg.conversationId !== fixedConversationId) return
      if (msg.type === 'desktop.project_recovered') {
        setProjectRecoveryRevision((revision) => revision + 1)
        return
      }
      if (msg.type === 'rail.pr_state') {
        // The delivery moved but the active card still shows another state:
        // its card broadcast was missed (or never sent) — re-read the cards.
        if (railStateDiffersFromCard(messagesRef.current, raw)) requestCardResyncRef.current()
        return
      }
      if (typeof msg.type !== 'string' || !msg.type.startsWith('agent_')) return
      if (msg.type === 'agent_conversation_created') {
        const openId = msg.openOnArrival && !secondaryWindow && !fixedConversationId ? msg.conversationId : undefined
        void refreshConversations().then(() => {
          // Commit creates an empty mission, but selecting it exits the Builder
          // and hides the M1 execution controls. Keep the post-create screen;
          // the user can leave it through Open project or launch M1 explicitly.
          if (openId && !builderActiveRef.current) void selectConversationRef.current?.(openId)
        })
        return
      }
      // Auto-title updates apply to the LIST (any conversation), not just the
      // active one — handle before the active-conversation filter.
      if (msg.type === 'agent_title' && msg.conversationId) {
        const title = (msg as { title?: string }).title ?? null
        setConversations((cs) => cs.map((c) => (c.id === msg.conversationId ? { ...c, title } : c)))
        setActive((a) => (a && a.id === msg.conversationId ? { ...a, title } : a))
        patchCachedTitle(conversationCacheRef.current, msg.conversationId, title)
        return
      }
      // Context snapshot of the mission's provider session (list + active, like titles).
      if (msg.type === 'agent_context_usage' && msg.conversationId) {
        const contextUsage = ((msg as { contextUsage?: AgentContextUsage | null }).contextUsage) ?? null
        setConversations((cs) => cs.map((c) => (c.id === msg.conversationId ? { ...c, contextUsage } : c)))
        setActive((a) => (a && a.id === msg.conversationId ? { ...a, contextUsage } : a))
        const cached = conversationCacheRef.current.get(msg.conversationId)
        if (cached) conversationCacheRef.current.set(msg.conversationId, { ...cached, conversation: { ...cached.conversation, contextUsage } })
        return
      }
      const convId = msg.conversationId
      if (!convId) return
      conversationEventVersionRef.current.set(convId, (conversationEventVersionRef.current.get(convId) ?? 0) + 1)
      // NO active-conversation filter for live state: background turns keep
      // accumulating in their own slice so a switch-back shows the full stream.
      // Only the `messages` list (the active thread) is gated on isActive.
      const isActive = convId === activeIdRef.current
      const appendTranscript = (rows: AgentMessage[]) => {
        transcriptEventsRef.current.set(convId, mergeTranscriptRows(transcriptEventsRef.current.get(convId) ?? [], rows).slice(-500))
        if (isActive) {
          messagesRef.current = mergeTranscriptRows(messagesRef.current, rows)
          setMessages((current) => mergeTranscriptRows(current, rows))
        }
      }
      if (msg.type === 'agent_input_receipt') {
        if (msg.receipt !== 'received' && msg.receipt !== 'read') return
        const queueKey = `${convId}:q:${msg.queueId}`
        const messageId = msg.messageId ?? inputMessageIdsRef.current.get(queueKey)
        if (msg.queueId) inputReceiptsRef.current.set(queueKey, latestReceipt(inputReceiptsRef.current.get(queueKey), msg.receipt)!)
        if (messageId) {
          const key = `${convId}:m:${messageId}`
          inputReceiptsRef.current.set(key, latestReceipt(inputReceiptsRef.current.get(key), msg.receipt)!)
          const rows = isActive ? messagesRef.current : transcriptEventsRef.current.get(convId) ?? []
          const existing = rows.find((row) => row.id === messageId)
          if (existing) appendTranscript([withReceipt(existing)])
        }
        patchLive(convId, (previous) => ({ ...previous, queued: previous.queued.map((item) => item.queueId === msg.queueId
          ? { ...item, deliveryReceipt: latestReceipt(item.deliveryReceipt, msg.receipt) } : item) }))
      } else if (msg.turnId && (msg.type === 'agent_stream' || msg.type === 'agent_tool' || msg.type === 'agent_tool_result')) {
        // A turn the agent started after sub-agents finished: rendered by
        // MissionSessionsContext, never mixed into the user turn's live state.
        if (msg.type === 'agent_stream') markUnread(convId)
      } else if (msg.type === 'agent_turn_done') {
        markUnread(convId)
        if (msg.messageId && (msg.fullText || msg.attachmentIds?.length)) {
          appendTranscript([{ id: msg.messageId, conversation_id: convId, role: 'assistant', content: msg.fullText ?? '', created_at: msg.timestamp ?? new Date().toISOString(),
            ...(msg.attachmentIds?.length ? { attachment_ids: msg.attachmentIds } : {}),
            ...(msg.turnId ? { core_turn_id: msg.turnId } : {}), ...(msg.origin ? { turn_origin: msg.origin } : {}) }])
        }
      } else if (msg.type === 'agent_stream') {
        markUnread(convId)
        liveStore.appendStream(convId, msg.delta ?? '')
      } else if (msg.type === 'agent_tool') {
        patchLive(convId, (p) => ({
          ...p,
          isStreaming: true,
          liveTools: [
            ...p.liveTools,
            {
              id: `t${nextToolSeq()}`,
              tool: msg.tool ?? 'tool',
              ...(msg.input ? { input: msg.input } : {}),
              ...(msg.toolId ? { toolId: msg.toolId } : {}),
              ...(msg.timestamp ? { at: msg.timestamp } : {}),
            },
          ].slice(-MAX_ACTIVITY_ENTRIES),
        }))
      } else if (msg.type === 'agent_tool_result') {
        // Merge the output into its originating entry: by toolId when the
        // provider correlates, else onto the LAST entry still missing output.
        patchLive(convId, (p) => {
          const tools = [...p.liveTools]
          let idx = msg.toolId ? tools.findIndex((t) => t.toolId === msg.toolId) : -1
          if (idx === -1) {
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].output === undefined) { idx = i; break }
            }
          }
          if (idx === -1) return p
          tools[idx] = {
            ...tools[idx],
            output: msg.output ?? '',
            ...(msg.isError ? { isError: true } : {}),
          }
          return { ...p, liveTools: tools }
        })
      } else if (msg.type === 'agent_partial') {
        const partial = msg.fullText ?? ''
        if (partial) {
          appendTranscript([{ id: msg.messageId ?? `partial-${convId}-${msg.timestamp ?? Date.now()}`, conversation_id: convId, role: 'assistant', content: partial, created_at: msg.timestamp ?? new Date().toISOString() }])
        }
      } else if (msg.type === 'agent_done') {
        localTurnStartedAtRef.current.delete(convId)
        markUnread(convId)
        const full = msg.fullText ?? ''
        if (msg.messageId && (full || msg.attachmentIds?.length)) {
          // `coreTurnId` anchors the sub-agents this turn launched under this reply.
          appendTranscript([{ id: msg.messageId, conversation_id: convId, role: 'assistant', content: full, created_at: msg.timestamp ?? new Date().toISOString(),
            ...(msg.attachmentIds?.length ? { attachment_ids: msg.attachmentIds } : {}),
            ...(msg.coreTurnId ? { core_turn_id: msg.coreTurnId, turn_origin: 'user' as const } : {}) }])
        } else if (isActive && full) {
          setMessages((m) => {
            // A switch-back refetch can already contain this reply (it is
            // persisted before the broadcast) — don't append it twice. Only
            // server-fetched rows (non-local ids) dedupe: two legitimately
            // identical consecutive replies both arrive as local appends.
            const last = m[m.length - 1]
            if (last && last.role === 'assistant' && last.content === full && !last.id.startsWith('local-')) return m
            return [
              ...m,
              { id: `local-${Date.now()}`, conversation_id: convId, role: 'assistant', content: full, created_at: new Date().toISOString() },
            ]
          })
        }
        // Keep queued chips: with a non-empty queue the next drained turn is
        // about to start (agent_dequeued follows). The finished turn's tool
        // activity survives as `turnTools` so the log modal outlives settle.
        patchLive(convId, (p) => ({
          ...EMPTY_LIVE,
          queued: p.queued,
          turnTools: p.liveTools.length ? p.liveTools : p.turnTools,
        }))
      } else if (msg.type === 'agent_error') {
        localTurnStartedAtRef.current.delete(convId)
        markUnread(convId)
        patchLive(convId, (p) => ({
          ...EMPTY_LIVE,
          queued: p.queued,
          turnTools: p.liveTools.length ? p.liveTools : p.turnTools,
        }))
        const err = describeAgentError(msg)
        if (!fixedConversationId) { const { title, detail } = describeAgentErrorToast(msg); notifyError(title, { detail }) }
        // Also surface it inline so it's visible in the conversation.
        if (isActive) {
          setMessages((m) => [
            ...m,
            { id: `err-${Date.now()}`, conversation_id: convId, role: 'assistant', content: `⚠️ ${err}`, client_after_id: m[m.length - 1]?.id ?? null, created_at: new Date().toISOString() },
          ])
        }
      } else if (msg.type === 'agent_queued') {
        // Dedupe by queueId: the sending window already parked its own chip.
        if (msg.queueId && consumedQueueIdsRef.current.has(msg.queueId)) return
        patchLive(convId, (p) => {
          const receipt = latestReceipt(msg.deliveryReceipt ?? msg.delivery_receipt, inputReceiptsRef.current.get(`${convId}:q:${msg.queueId}`))
          const item = { queueId: msg.queueId ?? `srv-${nextQueueSeq()}`, text: msg.text ?? '', contextRefs: msg.contextRefs, attachmentIds: msg.attachmentIds, deliveryMode: msg.deliveryMode, ...(receipt ? { deliveryReceipt: receipt } : {}), timestamp: msg.timestamp }
          if (msg.queueId && p.queued.some((q) => q.queueId === msg.queueId)) {
            return { ...p, queued: p.queued.map((q) => q.queueId === msg.queueId ? { ...q, ...item, deliveryReceipt: latestReceipt(q.deliveryReceipt, item.deliveryReceipt), deliveryMode: q.deliveryMode === 'steer' ? 'steer' : item.deliveryMode ?? q.deliveryMode, attachmentIds: item.attachmentIds ?? q.attachmentIds, contextRefs: item.contextRefs ?? q.contextRefs } : q) }
          }
          return {
            ...p,
            queued: [...p.queued, item],
          }
        })
      } else if (msg.type === 'agent_steered') {
        if (!msg.messageId) return
        if (deliveredMessageIdsRef.current.has(msg.messageId)) {
          if (msg.queueId) consumedQueueIdsRef.current.add(msg.queueId)
          patchLive(convId, (p) => ({ ...p, queued: p.queued.filter((q) => q.queueId !== msg.queueId) }))
          return
        }
        deliveredMessageIdsRef.current.add(msg.messageId)
        if (msg.queueId) consumedQueueIdsRef.current.add(msg.queueId)
        inputMessageIdsRef.current.set(`${convId}:q:${msg.queueId}`, msg.messageId)
        const receipt = latestReceipt(msg.delivery_receipt ?? msg.deliveryReceipt, inputReceiptsRef.current.get(`${convId}:q:${msg.queueId}`))
        const rows: AgentMessage[] = []
        if (msg.assistantSegment) rows.push({ ...msg.assistantSegment, conversation_id: convId, role: 'assistant' })
        rows.push(withReceipt({ id: msg.messageId, conversation_id: convId, role: 'user', content: msg.text ?? '', context_refs: msg.contextRefs ?? [], attachment_ids: msg.attachmentIds ?? [], delivery_status: msg.deliveryStatus ?? 'delivered', ...(receipt ? { delivery_receipt: receipt } : {}), created_at: msg.timestamp ?? new Date().toISOString() }))
        appendTranscript(rows)
        // Settling input delivery (including an unconfirmed native write) does
        // not end the turn. Only the persisted assistant segment resets.
        patchLive(convId, (p) => ({ ...p, queued: p.queued.filter((q) => q.queueId !== msg.queueId), streamingText: msg.assistantSegment ? '' : p.streamingText }))
      } else if (msg.type === 'agent_dequeued' || msg.type === 'agent_input_started') {
        if (isActive && msg.queueId) {
          messagesRef.current = messagesRef.current.filter(row => row.id !== `local-u-${msg.queueId}`)
          setMessages(current => current.filter(row => row.id !== `local-u-${msg.queueId}`))
        }
        // The queued message's turn starts now: chip → real user bubble.
        if (msg.queueId && consumedQueueIdsRef.current.has(msg.queueId)) return
        if (msg.queueId) consumedQueueIdsRef.current.add(msg.queueId)
        patchLive(convId, (p) => {
          return { ...p, queued: msg.queueId ? p.queued.filter((q) => q.queueId !== msg.queueId) : p.queued.slice(1), isStreaming: true, streamingText: '', liveTools: [] }
        })
        if (msg.text) {
          if (msg.messageId) inputMessageIdsRef.current.set(`${convId}:q:${msg.queueId}`, msg.messageId)
          const receipt = latestReceipt(msg.delivery_receipt ?? msg.deliveryReceipt, inputReceiptsRef.current.get(`${convId}:q:${msg.queueId}`))
          appendTranscript([
            withReceipt({
              id: msg.messageId ?? `local-u-${Date.now()}`,
              conversation_id: convId,
              role: 'user',
              content: msg.text!,
              context_refs: msg.contextRefs ?? [],
              attachment_ids: msg.attachmentIds ?? [],
              ...(msg.messageId ? { delivery_status: 'delivered' as const } : {}),
              ...(receipt ? { delivery_receipt: receipt } : {}),
              created_at: msg.timestamp ?? new Date().toISOString(),
            }),
          ])
        }
      } else if (msg.type === 'agent_queue_cleared') {
        queueClearVersionRef.current.set(convId, (queueClearVersionRef.current.get(convId) ?? 0) + 1)
        if (msg.messages?.length) appendTranscript(msg.messages)
        patchLive(convId, (p) => ({ ...p, queued: [] }))
      } else if (msg.type === 'agent_queue_removed') {
        if (!msg.queueId) return
        consumedQueueIdsRef.current.add(msg.queueId)
        removedQueueIdsRef.current.add(msg.queueId)
        patchLive(convId, (p) => ({ ...p, queued: p.queued.filter((item) => item.queueId !== msg.queueId) }))
      } else if (msg.type === 'agent_queue_edited') {
        // A queued chip was edited in place (this window or another) — update
        // its text; the editing window's optimistic update makes this a no-op.
        patchLive(convId, (p) => ({
          ...p,
          queued: p.queued.map((q) => (
            msg.queueId && q.queueId === msg.queueId
              ? { ...q, text: msg.text ?? q.text, contextRefs: msg.contextRefs ?? q.contextRefs, deliveryMode: msg.deliveryMode ?? q.deliveryMode }
              : q
          )),
        }))
      } else if (msg.type === 'agent_run_failure' || msg.type === 'agent_system_row') {
        // mission-rail-cards: the server persisted a `run-failure` system row
        // and broadcast it; append it to the ACTIVE thread so the failure
        // marker appears live (background threads rehydrate on select).
        // pr-ci-loop: the CI offer is informational — never an unread/attention mark.
        // A session renewal marker is the person's own action — never an unread mark either.
        const rowKind = (msg as { kind?: unknown }).kind
        if (rowKind !== 'pr-ci-offer' && rowKind !== 'session-summary') markUnread(convId)
        if (isActive) {
          const { type: _t, conversationId: _c, messageId, timestamp, ...row } = msg as unknown as { type: string; conversationId: string; messageId: string; timestamp: string } & Record<string, unknown>
          if (typeof messageId === 'string') {
            const systemRow: AgentMessage = { id: messageId, conversation_id: convId, role: 'system', content: JSON.stringify(row), created_at: typeof timestamp === 'string' ? timestamp : new Date().toISOString() }
            // A row re-broadcast with a known id was updated in place (the
            // Intent delivered card filling in): replace it where it stands.
            const upsert = (list: AgentMessage[]): AgentMessage[] =>
              list.some((m) => m.id === messageId) ? list.map((m) => (m.id === messageId ? { ...m, content: systemRow.content } : m)) : [...list, systemRow]
            messagesRef.current = upsert(messagesRef.current)
            setMessages(upsert)
          }
        }
      } else if (msg.type === 'agent_pr_decision') {
        markUnread(convId)
        const recorded = coercePrDecisionEnvelope(raw)
        if (recorded) {
          recordAttention(convId, recorded)
          const byDelivery = prEnvelopeEventsRef.current.get(convId) ?? new Map<string, AgentPrDecisionEnvelope>()
          byDelivery.delete(recorded.prDeliveryId)
          byDelivery.set(recorded.prDeliveryId, recorded)
          if (byDelivery.size > 50) byDelivery.delete(byDelivery.keys().next().value as string)
          prEnvelopeEventsRef.current.set(convId, byDelivery)
        }
        // PR-decision card (safe-pr-review-flow): the WS message carries the
        // persisted envelope's fields top-level. Only the ACTIVE thread's
        // `messages` slice is held in state — upsert its card in place (match
        // by prDeliveryId) or append it for a live arrival without reload.
        // Background conversations need nothing: the server updates the SAME
        // persisted system row, so rehydrate-on-select shows the current state.
        if (isActive) {
          const envelope = coercePrDecisionEnvelope(raw)
          if (envelope) {
            prSnapshotVersionRef.current++
            const projected = upsertPrDecisionMessage(messagesRef.current, convId, envelope)
            messagesRef.current = projected
            setMessages((current) => {
              const next = upsertPrDecisionMessage(current, convId, envelope)
              messagesRef.current = next
              return next
            })
          }
        }
      }
    }
    registerHandler(handlerId, handler)
    return () => unregisterHandler(handlerId)
  }, [registerHandler, unregisterHandler, patchLive, liveStore, markUnread, recordAttention, refreshConversations, handlerId, fixedConversationId])

  return { projectRecoveryRevision }
}
