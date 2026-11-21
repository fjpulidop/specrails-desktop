/**
 * Mission attention marks: which deliveries (and extension runs) wait for the
 * person, per conversation. WS envelopes cover every conversation; the open
 * one is recomputed from its own rows, which are authoritative for its mark.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentConversation, AgentMessage, AgentPrDecisionEnvelope } from '../../lib/agent-api'
import { derivePrCards } from '../../components/agent-pr-pinning'
import { deliveryAttention, mergeAttention, type MissionAttentionKind } from '../../components/mission-run-strip'
import { useMissionRunAttention } from '../MissionExtensionsContext'

export function useMissionAttention(conversations: AgentConversation[], activeConversationId: string | null, messages: AgentMessage[]) {
  // Attention: per conversation, which deliveries wait for the person. WS
  // envelopes cover every conversation; the open one is recomputed from its rows.
  const [attentionByConversation, setAttentionByConversation] = useState<ReadonlyMap<string, ReadonlyMap<string, MissionAttentionKind>>>(new Map())
  const recordAttention = useCallback((conversationId: string, envelope: AgentPrDecisionEnvelope): void => {
    const kind = deliveryAttention(envelope)
    setAttentionByConversation((current) => {
      const before = current.get(conversationId)
      if ((before?.get(envelope.prDeliveryId) ?? null) === kind) return current
      const deliveries = new Map(before ?? [])
      if (kind) deliveries.set(envelope.prDeliveryId, kind)
      else deliveries.delete(envelope.prDeliveryId)
      return new Map(current).set(conversationId, deliveries)
    })
  }, [])
  // Extension runs without an app-wide source report theirs from the strip:
  // kept apart so the open conversation's delivery recompute never wipes them.
  const [runAttention, setRunAttention] = useState<ReadonlyMap<string, ReadonlyMap<string, MissionAttentionKind>>>(new Map())
  const reportRunAttention = useCallback((conversationId: string, runKey: string, needsPerson: boolean | MissionAttentionKind): void => {
    const kind: MissionAttentionKind | null = needsPerson === true ? 'decision' : needsPerson === false ? null : needsPerson
    setRunAttention((current) => {
      const before = current.get(conversationId)
      if ((before?.get(runKey) ?? null) === kind) return current
      const keys = new Map(before ?? [])
      if (kind) keys.set(runKey, kind)
      else keys.delete(runKey)
      return new Map(current).set(conversationId, keys)
    })
  }, [])
  // An extension that derives its runs' attention app-wide (IntentSession, from its
  // per-project watch) feeds the dot for every listed mission, open or not.
  const extensionAttention = useMissionRunAttention(conversations)
  const attentionKinds = useMemo<ReadonlyMap<string, MissionAttentionKind>>(() => {
    const kinds = new Map<string, MissionAttentionKind[]>()
    const add = (conversationId: string, values: Iterable<MissionAttentionKind>): void => {
      const list = kinds.get(conversationId) ?? []
      list.push(...values)
      if (list.length) kinds.set(conversationId, list)
    }
    for (const [conversationId, deliveries] of attentionByConversation) add(conversationId, deliveries.values())
    for (const [conversationId, keys] of runAttention) add(conversationId, keys.values())
    // An extension's app-wide source says only "needs you": read as a decision.
    for (const [conversationId, keys] of extensionAttention) if (keys.size > 0) add(conversationId, ['decision'])
    const merged = new Map<string, MissionAttentionKind>()
    for (const [conversationId, list] of kinds) {
      const kind = mergeAttention(list)
      if (kind) merged.set(conversationId, kind)
    }
    return merged
  }, [attentionByConversation, runAttention, extensionAttention])
  const attentionConversationIds = useMemo<ReadonlySet<string>>(() => new Set(attentionKinds.keys()), [attentionKinds])

  // The open conversation: its rows are authoritative for its attention mark.
  useEffect(() => {
    if (!activeConversationId) return
    const deliveries = new Map<string, MissionAttentionKind>()
    for (const envelope of derivePrCards(messages).byDeliveryId.values()) {
      const kind = deliveryAttention(envelope)
      if (kind) deliveries.set(envelope.prDeliveryId, kind)
    }
    setAttentionByConversation((current) => {
      const before = current.get(activeConversationId)
      if (before && before.size === deliveries.size && [...deliveries].every(([id, kind]) => before.get(id) === kind)) return current
      return new Map(current).set(activeConversationId, deliveries)
    })
  }, [activeConversationId, messages])

  return { recordAttention, reportRunAttention, attentionKinds, attentionConversationIds }
}
