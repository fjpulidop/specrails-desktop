import { randomUUID } from 'crypto'
import type { DbInstance } from './db'
import type { AgentTierLevel } from './agent-tier'
import { addAgentMessage, listAgentMessages, type AgentMessage, type AgentMessageContextRef } from './agent-store'

export interface AgentInputOptions {
  tierLevel?: AgentTierLevel
  model?: string
  attachmentIds?: string[]
  contextRefs?: AgentMessageContextRef[]
  deliveryMode?: 'queue' | 'steer'
}

export type AgentInputStatus = 'pending' | 'delivered' | 'cancelled' | 'interrupted'
export type AgentInputDeliveryStatus = Exclude<AgentInputStatus, 'pending'>
export type AgentInputReceipt = 'sent' | 'received' | 'read'
export type AgentInputMessage = AgentMessage & { delivery_status: AgentInputDeliveryStatus; delivery_receipt?: AgentInputReceipt }
export interface AgentInput {
  id: string
  conversationId: string
  queueId: string
  text: string
  options: AgentInputOptions
  status: AgentInputStatus
  receipt: AgentInputReceipt
  createdAt: string
  messageId: string | null
}
export interface AgentInputSettlement { input: AgentInput; message: AgentInputMessage }
export interface AgentInputReceiptUpdate { input: AgentInput; message?: AgentInputMessage }

interface RawInput {
  id: string
  conversation_id: string
  queue_id: string
  text: string
  options_json: string
  enqueue_payload: string
  status: AgentInputStatus
  receipt: AgentInputReceipt
  created_at: string
  message_id: string | null
}

export const MAX_PENDING_AGENT_INPUTS = 50
export class AgentInputConflictError extends Error {
  readonly code = 'agent_input_conflict'
  constructor() { super('This message ID was already used for different content.'); this.name = 'AgentInputConflictError' }
}
export class AgentInputLimitError extends Error {
  readonly code = 'agent_input_limit'
  constructor() { super(`A conversation can have at most ${MAX_PENDING_AGENT_INPUTS} pending messages.`); this.name = 'AgentInputLimitError' }
}

function mapInput(row: RawInput): AgentInput {
  return {
    id: row.id, conversationId: row.conversation_id, queueId: row.queue_id, text: row.text,
    options: JSON.parse(row.options_json) as AgentInputOptions,
    status: row.status, receipt: row.receipt, createdAt: row.created_at, messageId: row.message_id,
  }
}

/** Stable key ordering makes equivalent HTTP retries independent of JSON key order. */
function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => Array.isArray(entry)
    ? entry.map(sort)
    : entry && typeof entry === 'object'
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)]))
      : entry
  return JSON.stringify(sort(value))
}

function readRaw(db: DbInstance, conversationId: string, queueId: string): RawInput | undefined {
  return db.prepare('SELECT * FROM agent_inputs WHERE conversation_id = ? AND queue_id = ?').get(conversationId, queueId) as RawInput | undefined
}

export function getAgentInput(db: DbInstance, conversationId: string, queueId: string): AgentInput | undefined {
  const row = readRaw(db, conversationId, queueId)
  return row ? mapInput(row) : undefined
}

export function enqueueAgentInput(db: DbInstance, input: {
  conversationId: string
  queueId?: string | null
  text: string
  options?: AgentInputOptions
}): { input: AgentInput; created: boolean } {
  const queueId = input.queueId ?? randomUUID()
  if (typeof queueId !== 'string' || queueId.trim().length === 0) throw new Error('A message ID must be a nonempty string.')
  if (typeof input.text !== 'string') throw new Error('A message must contain text.')
  if (input.options?.deliveryMode !== undefined && input.options.deliveryMode !== 'queue' && input.options.deliveryMode !== 'steer') {
    throw new Error('Message deliveryMode must be queue or steer.')
  }
  // Copy only the supported options. Persist arrays even when empty so absent
  // and explicitly empty metadata have the same idempotency semantics.
  const options = {
    ...(input.options?.tierLevel !== undefined ? { tierLevel: input.options.tierLevel } : {}),
    ...(input.options?.model !== undefined ? { model: input.options.model } : {}),
    ...(input.options?.deliveryMode !== undefined ? { deliveryMode: input.options.deliveryMode } : {}),
    attachmentIds: input.options?.attachmentIds ?? [], contextRefs: input.options?.contextRefs ?? [],
  }
  const optionsJson = canonicalJson(options)
  const payload = canonicalJson({ text: input.text, options })
  return db.transaction(() => {
    const existing = readRaw(db, input.conversationId, queueId)
    if (existing) {
      if (existing.enqueue_payload !== payload) throw new AgentInputConflictError()
      return { input: mapInput(existing), created: false }
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM agent_inputs WHERE conversation_id = ? AND status = 'pending'").get(input.conversationId) as { n: number }
    if (count.n >= MAX_PENDING_AGENT_INPUTS) throw new AgentInputLimitError()
    db.prepare(`INSERT INTO agent_inputs (id, conversation_id, queue_id, text, options_json, enqueue_payload)
      VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), input.conversationId, queueId, input.text, optionsJson, payload)
    return { input: mapInput(readRaw(db, input.conversationId, queueId)!), created: true }
  })()
}

export function listPendingAgentInputs(db: DbInstance, conversationId: string): AgentInput[] {
  return (db.prepare("SELECT * FROM agent_inputs WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at, rowid").all(conversationId) as RawInput[]).map(mapInput)
}

/** Editing changes the pending intent, never its original HTTP dedup fingerprint. */
export function editPendingAgentInput(db: DbInstance, conversationId: string, queueId: string, text: string): AgentInput | undefined {
  if (typeof text !== 'string') throw new Error('A message must contain text.')
  return db.transaction(() => {
    const update = db.prepare("UPDATE agent_inputs SET text = ? WHERE conversation_id = ? AND queue_id = ? AND status = 'pending'").run(text, conversationId, queueId)
    return update.changes ? getAgentInput(db, conversationId, queueId) : undefined
  })()
}

/** Promote pending input without rewriting its original HTTP identity. The
 * manager owns the synchronous in-flight claim and must reject a claimed row. */
export function steerPendingAgentInput(db: DbInstance, conversationId: string, queueId: string): AgentInput | undefined {
  return db.transaction(() => {
    const row = readRaw(db, conversationId, queueId)
    if (!row || row.status !== 'pending') return undefined
    const options: AgentInputOptions = { ...JSON.parse(row.options_json), deliveryMode: 'steer' }
    db.prepare("UPDATE agent_inputs SET options_json = ? WHERE id = ? AND status = 'pending'").run(canonicalJson(options), row.id)
    return getAgentInput(db, conversationId, queueId)
  })()
}

/** Removing a queue chip is an explicit deletion of unsent input. Keep its
 * dedup tombstone, but do not add the removed text to conversation history. */
export function deletePendingAgentInput(db: DbInstance, conversationId: string, queueId: string): boolean {
  return db.prepare("UPDATE agent_inputs SET status = 'cancelled' WHERE conversation_id = ? AND queue_id = ? AND status = 'pending'")
    .run(conversationId, queueId).changes > 0
}

const receiptOrder: Record<AgentInputReceipt, number> = { sent: 0, received: 1, read: 2 }

function validateReceipt(receipt: AgentInputReceipt): void {
  if (receipt !== 'sent' && receipt !== 'received' && receipt !== 'read') throw new Error('Message receipt must be sent, received or read.')
}

function latestReceipt(existing: AgentInputReceipt, incoming: AgentInputReceipt): AgentInputReceipt {
  return receiptOrder[incoming] > receiptOrder[existing] ? incoming : existing
}

/** The caller must hold a transaction while moving a pending row and user message together. */
function settleInput(db: DbInstance, row: RawInput, status: AgentInputDeliveryStatus, receipt = row.receipt): AgentInputSettlement {
  const options = JSON.parse(row.options_json) as AgentInputOptions
  const message = addAgentMessage(db, {
    conversationId: row.conversation_id, role: 'user', content: row.text,
    attachmentIds: options.attachmentIds, contextRefs: options.contextRefs,
  })
  const nextReceipt = latestReceipt(row.receipt, receipt)
  db.prepare("UPDATE agent_inputs SET status = ?, message_id = ?, receipt = ? WHERE id = ? AND status = 'pending'").run(status, message.id, nextReceipt, row.id)
  return {
    input: mapInput(readRaw(db, row.conversation_id, row.queue_id)!),
    message: { ...message, delivery_status: status, delivery_receipt: nextReceipt },
  }
}

/** Provider acknowledgements can arrive out of order or after a reconnect. Only
 * advance receipt state, retaining the same transcript identity and metadata. */
export function setAgentInputReceipt(db: DbInstance, conversationId: string, queueId: string, receipt: AgentInputReceipt): AgentInputReceiptUpdate | undefined {
  validateReceipt(receipt)
  return db.transaction(() => {
    const row = readRaw(db, conversationId, queueId)
    if (!row || (row.status !== 'pending' && row.status !== 'delivered')) return undefined
    const nextReceipt = latestReceipt(row.receipt, receipt)
    if (nextReceipt !== row.receipt) db.prepare('UPDATE agent_inputs SET receipt = ? WHERE id = ?').run(nextReceipt, row.id)
    const updated = { ...row, receipt: nextReceipt }
    const message = row.message_id ? listAgentMessages(db, conversationId).find((entry) => entry.id === row.message_id) : undefined
    return {
      input: mapInput(updated),
      ...(message ? { message: { ...message, delivery_status: row.status as AgentInputDeliveryStatus, delivery_receipt: nextReceipt } } : {}),
    }
  })()
}

export function deliverAgentInput(db: DbInstance, conversationId: string, queueId: string, receipt: AgentInputReceipt = 'received'): AgentInputMessage | undefined {
  validateReceipt(receipt)
  return db.transaction(() => {
    const row = readRaw(db, conversationId, queueId)
    if (!row) return undefined
    if (row.status === 'delivered') {
      return setAgentInputReceipt(db, conversationId, queueId, receipt)?.message
    }
    if (row.status !== 'pending') return undefined
    return settleInput(db, row, 'delivered', receipt).message
  })()
}

/** A native write whose acknowledgement was lost must not be replayed. */
export function interruptAgentInput(db: DbInstance, conversationId: string, queueId: string): AgentInputMessage | undefined {
  return db.transaction(() => {
    const row = readRaw(db, conversationId, queueId)
    if (!row || row.status !== 'pending') return undefined
    return settleInput(db, row, 'interrupted').message
  })()
}

function settlePending(db: DbInstance, status: 'cancelled' | 'interrupted', conversationId?: string): AgentInputSettlement[] {
  return db.transaction(() => {
    const rows = conversationId === undefined
      ? db.prepare("SELECT * FROM agent_inputs WHERE status = 'pending' ORDER BY created_at, rowid").all()
      : db.prepare("SELECT * FROM agent_inputs WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at, rowid").all(conversationId)
    return (rows as RawInput[]).map((row) => settleInput(db, row, status))
  })()
}

export function cancelPendingAgentInputs(db: DbInstance, conversationId: string): AgentInputSettlement[] {
  return settlePending(db, 'cancelled', conversationId)
}

/** Startup preserves unsent messages for review; it never silently replays them. */
export function recoverPendingAgentInputs(db: DbInstance, conversationId?: string): AgentInputSettlement[] {
  return settlePending(db, 'interrupted', conversationId)
}

export function decorateAgentInputMessages<T extends AgentMessage>(db: DbInstance, messages: readonly T[]): Array<T & { delivery_status?: AgentInputDeliveryStatus; delivery_receipt?: AgentInputReceipt }> {
  if (messages.length === 0) return []
  const ids = messages.map((message) => message.id)
  const rows = db.prepare(`SELECT message_id, status, receipt FROM agent_inputs
    WHERE message_id IN (SELECT value FROM json_each(?)) AND status <> 'pending'`).all(JSON.stringify(ids)) as Array<{ message_id: string; status: AgentInputDeliveryStatus; receipt: AgentInputReceipt }>
  const statuses = new Map(rows.map((row) => [row.message_id, row]))
  return messages.map((message) => {
    const status = statuses.get(message.id)
    return status ? { ...message, delivery_status: status.status, delivery_receipt: status.receipt } : message
  })
}
