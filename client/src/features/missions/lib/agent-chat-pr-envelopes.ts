/**
 * Pure reconciliation of PR-decision card envelopes inside a mission
 * transcript: which incoming envelope is stale (older generation, a tombstone,
 * a conflicting tie), how restorations and newer rail generations project onto
 * older cards, and the single canonical upsert of a card row.
 */
import { comparePrSnapshotUpdatedAt } from '../../delivery/lib/pr-delivery'
import { parsePrDecisionEnvelope, type AgentMessage, type AgentPrDecisionEnvelope } from './agent-api'

export const TERMINAL_PR_CARD_DECISIONS = new Set(['completed', 'merged', 'discarded', 'superseded'])

function envelopesMatch(a: AgentPrDecisionEnvelope, b: AgentPrDecisionEnvelope): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function createdAtMs(envelope: AgentPrDecisionEnvelope): number | null {
  if (!envelope.createdAt) return null
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(envelope.createdAt)
    ? `${envelope.createdAt.replace(' ', 'T')}Z`
    : envelope.createdAt
  const parsed = Date.parse(sqliteUtc)
  return Number.isFinite(parsed) ? parsed : null
}

function incomingGenerationOrder(
  existing: AgentPrDecisionEnvelope,
  incoming: AgentPrDecisionEnvelope,
): -1 | 0 | 1 | null {
  if (incoming.supersedesDeliveryId === existing.prDeliveryId) return 1
  if (existing.supersedesDeliveryId === incoming.prDeliveryId) return -1
  const existingMs = createdAtMs(existing)
  const incomingMs = createdAtMs(incoming)
  if (existingMs == null || incomingMs == null) return null
  if (incomingMs < existingMs) return -1
  if (incomingMs > existingMs) return 1
  return 0
}

function latestDirectSuperseder(
  envelopes: readonly AgentPrDecisionEnvelope[],
  predecessorId: string,
): AgentPrDecisionEnvelope | null {
  let latest: AgentPrDecisionEnvelope | null = null
  for (const candidate of envelopes) {
    if (candidate.supersedesDeliveryId !== predecessorId) continue
    if (!latest) {
      latest = candidate
      continue
    }
    const latestCreated = createdAtMs(latest)
    const candidateCreated = createdAtMs(candidate)
    if (
      latestCreated == null || candidateCreated == null ||
      candidateCreated >= latestCreated
    ) latest = candidate
  }
  return latest
}

function isExplicitPrRestoration(
  envelopes: readonly AgentPrDecisionEnvelope[],
  incoming: AgentPrDecisionEnvelope,
): boolean {
  const sourceId = incoming.restoredFromDeliveryId
  if (!sourceId) return false
  const latestSuperseder = latestDirectSuperseder(envelopes, incoming.prDeliveryId)
  // The durable marker is sufficient when this conversation never contained
  // B. If lineage is present, however, it must name that exact latest B; this
  // prevents a delayed restore-from-B replay after newer generation C exists.
  return !latestSuperseder || latestSuperseder.prDeliveryId === sourceId
}

export function isStalePrDecisionEnvelope(
  messages: readonly AgentMessage[],
  incoming: AgentPrDecisionEnvelope,
): boolean {
  const envelopes = messages
    .filter((message) => message.role === 'system')
    .map((message) => parsePrDecisionEnvelope(message.content))
    .filter((envelope): envelope is AgentPrDecisionEnvelope => envelope !== null)
  const existing = [...envelopes].reverse().find(
    (envelope) => envelope.prDeliveryId === incoming.prDeliveryId,
  )
  const explicitRestoration = isExplicitPrRestoration(envelopes, incoming)
  if (existing) {
    const existingTerminal = TERMINAL_PR_CARD_DECISIONS.has(existing.decision)
    const incomingTerminal = TERMINAL_PR_CARD_DECISIONS.has(incoming.decision)
    const order = comparePrSnapshotUpdatedAt(existing.updatedAt, incoming.updatedAt)
    if (order === -1) return true
    // Durable timestamps have one-second precision. Keep the accepted state
    // on every conflicting tie; visual state is not causal ordering evidence.
    if (order === 0 && !envelopesMatch(existing, incoming)) return true
    // A rollback marker may consume the superseded tombstone once. It cannot
    // reopen A after that restored generation has itself reached another
    // terminal state, even if a delayed payload repeats the same A <- B proof.
    if (
      existingTerminal && !incomingTerminal &&
      !(explicitRestoration && existing.decision === 'superseded')
    ) return true
  }
  const supersededIds = new Set(
    envelopes.map((envelope) => envelope.supersedesDeliveryId).filter((id): id is string => Boolean(id)),
  )
  if (explicitRestoration) return false
  if (supersededIds.has(incoming.prDeliveryId) && incoming.decision !== 'superseded') return true

  // Only one actionable delivery generation may exist per rail. Modern rows
  // carry explicit lineage; `createdAt` is the durable fallback for recovered
  // rows. With neither signal, keep an already-actionable generation instead
  // of allowing two contradictory action sets to coexist.
  for (const candidate of envelopes) {
    if (
      candidate.railIndex !== incoming.railIndex ||
      candidate.prDeliveryId === incoming.prDeliveryId ||
      supersededIds.has(candidate.prDeliveryId)
    ) continue
    const order = incomingGenerationOrder(candidate, incoming)
    if (order === -1) return true
    if (
      (order === 0 || order === null) &&
      !TERMINAL_PR_CARD_DECISIONS.has(candidate.decision) &&
      incoming.supersedesDeliveryId !== candidate.prDeliveryId
    ) return true
  }
  return false
}

function projectRestorationSource(
  messages: AgentMessage[],
  incoming: AgentPrDecisionEnvelope,
): AgentMessage[] {
  const sourceId = incoming.restoredFromDeliveryId
  if (!sourceId) return messages
  let changed = false
  const projected = messages.map((message) => {
    if (message.role !== 'system') return message
    const envelope = parsePrDecisionEnvelope(message.content)
    if (
      !envelope || envelope.prDeliveryId !== sourceId ||
      TERMINAL_PR_CARD_DECISIONS.has(envelope.decision)
    ) return message
    changed = true
    return { ...message, content: JSON.stringify({ ...envelope, decision: 'discarded' as const }) }
  })
  return changed ? projected : messages
}

function projectOlderRailGenerations(
  messages: AgentMessage[],
  incoming: AgentPrDecisionEnvelope,
): AgentMessage[] {
  const envelopes = messages
    .filter((message) => message.role === 'system')
    .map((message) => parsePrDecisionEnvelope(message.content))
    .filter((envelope): envelope is AgentPrDecisionEnvelope => envelope !== null)
  const rolledBackByRestoredPredecessor = envelopes.some((envelope) => (
    envelope.restoredFromDeliveryId === incoming.prDeliveryId &&
    isExplicitPrRestoration(envelopes, envelope)
  ))
  if (rolledBackByRestoredPredecessor) return messages

  let changed = false
  const projected = messages.map((message) => {
    if (message.role !== 'system') return message
    const envelope = parsePrDecisionEnvelope(message.content)
    if (
      !envelope ||
      envelope.railIndex !== incoming.railIndex ||
      envelope.prDeliveryId === incoming.prDeliveryId ||
      TERMINAL_PR_CARD_DECISIONS.has(envelope.decision) ||
      incomingGenerationOrder(envelope, incoming) !== 1
    ) return message
    changed = true
    return { ...message, content: JSON.stringify({ ...envelope, decision: 'superseded' as const }) }
  })
  return changed ? projected : messages
}

export function upsertPrDecisionMessage(
  messages: AgentMessage[],
  conversationId: string,
  envelope: AgentPrDecisionEnvelope,
): AgentMessage[] {
  if (isStalePrDecisionEnvelope(messages, envelope)) return messages
  const restored = projectRestorationSource(messages, envelope)
  const base = projectOlderRailGenerations(restored, envelope)
  const content = JSON.stringify(envelope)
  const matching = base.flatMap((message, index) => (
    message.role === 'system' && parsePrDecisionEnvelope(message.content)?.prDeliveryId === envelope.prDeliveryId
      ? [index]
      : []
  ))
  if (matching.length > 0) {
    const canonicalIndex = matching[matching.length - 1]
    if (matching.length === 1 && base[canonicalIndex].content === content) return base
    const duplicateIndexes = new Set(matching.slice(0, -1))
    return base.flatMap((message, index) => {
      if (duplicateIndexes.has(index)) return []
      return [index === canonicalIndex ? { ...message, content } : message]
    })
  }
  return [
    ...base,
    {
      id: `prd-${envelope.prDeliveryId}`,
      conversation_id: conversationId,
      role: 'system',
      content,
      created_at: new Date().toISOString(),
    },
  ]
}
