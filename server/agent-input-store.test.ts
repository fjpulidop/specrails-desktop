import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { initDesktopDb } from './desktop-db'
import type { DbInstance } from './db'
import { addAgentMessage, createAgentConversation, deleteAgentConversation, listAgentMessages } from './agent-store'
import {
  AgentInputConflictError, AgentInputLimitError, MAX_PENDING_AGENT_INPUTS,
  cancelPendingAgentInputs, decorateAgentInputMessages, deliverAgentInput, editPendingAgentInput,
  enqueueAgentInput, getAgentInput, listPendingAgentInputs, recoverPendingAgentInputs,
  steerPendingAgentInput, deletePendingAgentInput, setAgentInputReceipt,
} from './agent-input-store'

describe('durable mission inputs', () => {
  let db: DbInstance
  let conversationId: string
  beforeEach(() => { db = initDesktopDb(':memory:'); conversationId = createAgentConversation(db).id })
  afterEach(() => { db.close() })

  const options = () => ({
    tierLevel: 3 as const, model: 'gpt-6-astra', attachmentIds: ['image-1'],
    contextRefs: [{ kind: 'file', id: 'README.md', label: 'README.md', token: '@README.md', scope: { projectId: 'p', repositoryId: 'frontend' }, metadata: { line: 4 } }],
  })
  const put = (text = 'Use the shared frontend contract.', queueId = 'q1') => enqueueAgentInput(db, { conversationId, queueId, text, options: options() })

  it('freezes pending metadata and deduplicates matching HTTP retries before and after delivery', () => {
    const initialOptions = options()
    const first = enqueueAgentInput(db, { conversationId, queueId: 'q1', text: 'Update this.', options: initialOptions })
    initialOptions.attachmentIds.push('a-later-edit')
    expect(first.created).toBe(true)
    expect(listAgentMessages(db, conversationId)).toEqual([])
    expect(getAgentInput(db, conversationId, 'q1')?.options.attachmentIds).toEqual(['image-1'])
    const retry = enqueueAgentInput(db, { conversationId, queueId: 'q1', text: 'Update this.', options: options() })
    expect(retry).toEqual({ input: first.input, created: false })
    const delivered = deliverAgentInput(db, conversationId, 'q1')!
    expect(delivered).toMatchObject({ role: 'user', content: 'Update this.', attachment_ids: ['image-1'], context_refs: options().contextRefs, delivery_status: 'delivered' })
    expect(deliverAgentInput(db, conversationId, 'q1')).toEqual(delivered)
    expect(enqueueAgentInput(db, { conversationId, queueId: 'q1', text: 'Update this.', options: options() }).created).toBe(false)
    expect(listAgentMessages(db, conversationId)).toHaveLength(1)
    expect(getAgentInput(db, conversationId, 'q1')?.messageId).toBe(delivered.id)
  })

  it('rejects a reused identity with different text or metadata and isolates conversation identities', () => {
    put()
    expect(() => put('Different instructions')).toThrow(AgentInputConflictError)
    expect(() => enqueueAgentInput(db, { conversationId, queueId: 'q1', text: 'Use the shared frontend contract.', options: { ...options(), model: 'sonnet' } })).toThrow(AgentInputConflictError)
    const other = createAgentConversation(db).id
    expect(enqueueAgentInput(db, { conversationId: other, queueId: 'q1', text: 'Different instructions' }).created).toBe(true)
    expect(listPendingAgentInputs(db, conversationId)).toHaveLength(1)
  })

  it('edits only pending text while retaining options and the original deduplication fingerprint', () => {
    const first = put()
    const edited = editPendingAgentInput(db, conversationId, 'q1', 'Correction: preserve existing API names.')!
    expect(edited.options).toEqual(first.input.options)
    expect(put()).toEqual({ created: false, input: edited })
    expect(deliverAgentInput(db, conversationId, 'q1')?.content).toBe('Correction: preserve existing API names.')
    expect(editPendingAgentInput(db, conversationId, 'q1', 'Too late')).toBeUndefined()
    expect(editPendingAgentInput(db, conversationId, 'unknown', 'Unknown')).toBeUndefined()
  })

  it('persists explicit delivery modes in the original identity and retains legacy absent-mode retries', () => {
    const original = { conversationId, queueId: 'queued', text: 'Do this later.', options: { ...options(), deliveryMode: 'queue' as const } }
    const queued = enqueueAgentInput(db, original)
    expect(queued.input.options.deliveryMode).toBe('queue')
    expect(enqueueAgentInput(db, original).created).toBe(false)
    expect(() => enqueueAgentInput(db, { ...original, options: { ...original.options, deliveryMode: 'steer' } })).toThrow(AgentInputConflictError)
    expect(enqueueAgentInput(db, { ...original, queueId: 'steer', options: { ...original.options, deliveryMode: 'steer' } }).input.options.deliveryMode).toBe('steer')
    const legacy = put()
    expect(legacy.input.options).not.toHaveProperty('deliveryMode')
    expect(put().created).toBe(false)
    expect(() => enqueueAgentInput(db, { ...original, queueId: 'invalid', options: { deliveryMode: 'invalid' as never } })).toThrow('deliveryMode')
  })

  it('promotes a pending input without losing edits, resources or its immutable submission fingerprint', () => {
    const first = put()
    const fingerprint = db.prepare('SELECT enqueue_payload FROM agent_inputs WHERE id = ?').get(first.input.id)
    editPendingAgentInput(db, conversationId, 'q1', 'Updated before promotion.')
    const promoted = steerPendingAgentInput(db, conversationId, 'q1')!
    expect(promoted).toMatchObject({ text: 'Updated before promotion.', status: 'pending', options: { ...options(), deliveryMode: 'steer' } })
    expect(promoted.createdAt).toBe(first.input.createdAt)
    expect(db.prepare('SELECT enqueue_payload FROM agent_inputs WHERE id = ?').get(first.input.id)).toEqual(fingerprint)
    expect(put()).toEqual({ created: false, input: promoted })
    expect(steerPendingAgentInput(db, conversationId, 'q1')).toEqual(promoted)
    expect(listAgentMessages(db, conversationId)).toEqual([])
    expect(deliverAgentInput(db, conversationId, 'q1')).toMatchObject({ content: 'Updated before promotion.', attachment_ids: options().attachmentIds, context_refs: options().contextRefs })
    expect(steerPendingAgentInput(db, conversationId, 'q1')).toBeUndefined()
    expect(steerPendingAgentInput(db, 'different-conversation', 'q1')).toBeUndefined()
    expect(steerPendingAgentInput(db, conversationId, 'missing')).toBeUndefined()
  })

  it('removes pending input without adding a transcript row and retains a dedup tombstone through recovery', () => {
    const input = put().input
    expect(deletePendingAgentInput(db, 'different-conversation', 'q1')).toBe(false)
    expect(deletePendingAgentInput(db, conversationId, 'q1')).toBe(true)
    expect(getAgentInput(db, conversationId, 'q1')).toMatchObject({ status: 'cancelled', messageId: null, options: input.options })
    expect(listAgentMessages(db, conversationId)).toEqual([])
    expect(listPendingAgentInputs(db, conversationId)).toEqual([])
    expect(put()).toMatchObject({ created: false, input: { status: 'cancelled', messageId: null } })
    expect(() => put('Different request.')).toThrow(AgentInputConflictError)
    expect(steerPendingAgentInput(db, conversationId, 'q1')).toBeUndefined()
    expect(deletePendingAgentInput(db, conversationId, 'q1')).toBe(false)
    expect(deliverAgentInput(db, conversationId, 'q1')).toBeUndefined()
    expect(cancelPendingAgentInputs(db, conversationId)).toEqual([])
    expect(recoverPendingAgentInputs(db)).toEqual([])
    expect(listAgentMessages(db, conversationId)).toEqual([])
  })

  it('never removes dispatched/interrupted input and rolls promotion back if its update fails', () => {
    put('Delivered.', 'delivered'); deliverAgentInput(db, conversationId, 'delivered')
    put('Interrupted.', 'interrupted'); recoverPendingAgentInputs(db)
    for (const id of ['delivered', 'interrupted']) {
      expect(deletePendingAgentInput(db, conversationId, id)).toBe(false)
      expect(steerPendingAgentInput(db, conversationId, id)).toBeUndefined()
    }
    expect(listAgentMessages(db, conversationId)).toHaveLength(2)
    const original = put().input
    db.exec("CREATE TRIGGER fail_promotion BEFORE UPDATE OF options_json ON agent_inputs BEGIN SELECT RAISE(ABORT, 'promotion failed'); END")
    expect(() => steerPendingAgentInput(db, conversationId, 'q1')).toThrow('promotion failed')
    expect(getAgentInput(db, conversationId, 'q1')).toEqual(original)
  })

  it('keeps message creation and delivery atomic if either persistence step fails', () => {
    put()
    db.exec("CREATE TRIGGER fail_delivery BEFORE UPDATE OF status ON agent_inputs BEGIN SELECT RAISE(ABORT, 'test ledger failure'); END")
    expect(() => deliverAgentInput(db, conversationId, 'q1')).toThrow('test ledger failure')
    expect(listAgentMessages(db, conversationId)).toEqual([])
    expect(getAgentInput(db, conversationId, 'q1')).toMatchObject({ status: 'pending', messageId: null })
    db.exec('DROP TRIGGER fail_delivery')
    db.exec("CREATE TRIGGER fail_user BEFORE INSERT ON agent_messages BEGIN SELECT RAISE(ABORT, 'test message failure'); END")
    expect(() => deliverAgentInput(db, conversationId, 'q1')).toThrow('test message failure')
    expect(getAgentInput(db, conversationId, 'q1')?.status).toBe('pending')
    db.exec('DROP TRIGGER fail_user')
    expect(deliverAgentInput(db, conversationId, 'q1')?.delivery_status).toBe('delivered')
  })

  it('cancels pending inputs atomically as original user messages and never redelivers them', () => {
    put('Already delivered', 'done')
    const delivered = deliverAgentInput(db, conversationId, 'done')!
    put('Pending first', 'first'); put('Pending second', 'second')
    db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON agent_messages WHEN NEW.content = 'Pending second' BEGIN SELECT RAISE(ABORT, 'second message failed'); END")
    expect(() => cancelPendingAgentInputs(db, conversationId)).toThrow('second message failed')
    expect(listPendingAgentInputs(db, conversationId)).toHaveLength(2)
    expect(listAgentMessages(db, conversationId)).toHaveLength(1)
    db.exec('DROP TRIGGER fail_second')
    const cancelled = cancelPendingAgentInputs(db, conversationId)
    expect(cancelled.map(({ message }) => [message.content, message.delivery_status])).toEqual([['Pending first', 'cancelled'], ['Pending second', 'cancelled']])
    expect(cancelled[0].message.context_refs).toEqual(options().contextRefs)
    expect(listPendingAgentInputs(db, conversationId)).toEqual([])
    expect(cancelPendingAgentInputs(db, conversationId)).toEqual([])
    expect(deliverAgentInput(db, conversationId, 'first')).toBeUndefined()
    expect(deliverAgentInput(db, conversationId, 'done')).toEqual(delivered)
  })

  it('recovers pending inputs across conversations as interrupted without replaying delivered or cancelled messages', () => {
    const other = createAgentConversation(db).id
    put('Delivered', 'done'); deliverAgentInput(db, conversationId, 'done')
    put('Cancelled', 'cancel'); cancelPendingAgentInputs(db, conversationId)
    put('Interrupted', 'pending')
    enqueueAgentInput(db, { conversationId: other, queueId: 'q1', text: 'Other pending' })
    const recovered = recoverPendingAgentInputs(db)
    expect(recovered.map(({ message }) => [message.content, message.delivery_status])).toEqual([['Interrupted', 'interrupted'], ['Other pending', 'interrupted']])
    expect(recoverPendingAgentInputs(db)).toEqual([])
    expect(deliverAgentInput(db, conversationId, 'pending')).toBeUndefined()
    expect(listPendingAgentInputs(db, conversationId)).toEqual([])
    const messages = decorateAgentInputMessages(db, listAgentMessages(db, conversationId))
    expect(messages.map((message) => message.delivery_status)).toEqual(['delivered', 'cancelled', 'interrupted'])
  })

  it('decorates only ledger-owned messages and preserves ordinary history and message ordering', () => {
    const ordinary = addAgentMessage(db, { conversationId, role: 'assistant', content: 'Existing history' })
    put(); deliverAgentInput(db, conversationId, 'q1')
    const history = listAgentMessages(db, conversationId)
    const decorated = decorateAgentInputMessages(db, history)
    expect(decorated.map((message) => message.id)).toEqual(history.map((message) => message.id))
    expect(decorated[0]).toEqual(ordinary)
    expect(decorated[1].delivery_status).toBe('delivered')
    expect(history[1]).not.toHaveProperty('delivery_status')
    expect(decorateAgentInputMessages(db, [])).toEqual([])
  })

  it('persists sent before provider handoff and advances receipts on the same original message', () => {
    const original = put().input
    expect(original.receipt).toBe('sent')
    const message = deliverAgentInput(db, conversationId, 'q1', 'sent')!
    expect(message.delivery_receipt).toBe('sent')
    const received = setAgentInputReceipt(db, conversationId, 'q1', 'received')!
    expect(received).toMatchObject({ input: { ...original, status: 'delivered', receipt: 'received', messageId: message.id }, message: { ...message, delivery_receipt: 'received' } })
    const read = setAgentInputReceipt(db, conversationId, 'q1', 'read')!
    expect(read.message).toEqual({ ...message, delivery_receipt: 'read' })
    expect(put()).toEqual({ input: read.input, created: false })
    expect(decorateAgentInputMessages(db, listAgentMessages(db, conversationId))).toEqual([read.message])
    expect(listAgentMessages(db, conversationId)).toHaveLength(1)
    expect(listAgentMessages(db, conversationId)[0].created_at).toBe(message.created_at)
  })

  it('never downgrades or duplicates receipts when acknowledgements are repeated or reordered', () => {
    put()
    const message = deliverAgentInput(db, conversationId, 'q1')!
    expect(message.delivery_receipt).toBe('received')
    expect(setAgentInputReceipt(db, conversationId, 'q1', 'sent')?.message).toEqual(message)
    const read = setAgentInputReceipt(db, conversationId, 'q1', 'read')!
    // Equal or stale acknowledgements do not even write the row.
    db.exec("CREATE TRIGGER reject_receipt_rewrite BEFORE UPDATE OF receipt ON agent_inputs BEGIN SELECT RAISE(ABORT, 'unexpected receipt rewrite'); END")
    for (const receipt of ['sent', 'received', 'read'] as const) {
      expect(setAgentInputReceipt(db, conversationId, 'q1', receipt)).toEqual(read)
      expect(deliverAgentInput(db, conversationId, 'q1', receipt)).toEqual(read.message)
    }
    expect(deliverAgentInput(db, conversationId, 'q1')).toEqual(read.message)
    expect(listAgentMessages(db, conversationId)).toHaveLength(1)
  })

  it('retains an early read acknowledgement when a pending input enters the transcript', () => {
    const original = put().input
    const receipt = setAgentInputReceipt(db, conversationId, 'q1', 'read')!
    expect(receipt).toEqual({ input: { ...original, receipt: 'read' } })
    expect(listAgentMessages(db, conversationId)).toEqual([])
    expect(listPendingAgentInputs(db, conversationId)).toEqual([receipt.input])
    expect(editPendingAgentInput(db, conversationId, 'q1', 'Changed before handoff')?.receipt).toBe('read')
    expect(steerPendingAgentInput(db, conversationId, 'q1')?.receipt).toBe('read')
    expect(deliverAgentInput(db, conversationId, 'q1', 'sent')).toMatchObject({ content: 'Changed before handoff', delivery_receipt: 'read', attachment_ids: options().attachmentIds, context_refs: options().contextRefs })
    expect(getAgentInput(db, conversationId, 'q1')?.receipt).toBe('read')
  })

  it('rejects receipts for missing, cancelled or interrupted input and isolates conversations', () => {
    put('Cancelled', 'cancelled')
    setAgentInputReceipt(db, conversationId, 'cancelled', 'received')
    cancelPendingAgentInputs(db, conversationId)
    put('Interrupted', 'interrupted'); recoverPendingAgentInputs(db, conversationId)
    put('Removed', 'removed'); deletePendingAgentInput(db, conversationId, 'removed')
    for (const id of ['cancelled', 'interrupted', 'removed']) {
      const before = getAgentInput(db, conversationId, id)
      expect(setAgentInputReceipt(db, conversationId, id, 'read')).toBeUndefined()
      expect(getAgentInput(db, conversationId, id)).toEqual(before)
    }
    expect(decorateAgentInputMessages(db, listAgentMessages(db, conversationId)).map((message) => [message.delivery_status, message.delivery_receipt])).toEqual([['cancelled', 'received'], ['interrupted', 'sent']])
    expect(setAgentInputReceipt(db, conversationId, 'unknown', 'read')).toBeUndefined()
    put()
    const other = createAgentConversation(db).id
    expect(setAgentInputReceipt(db, other, 'q1', 'read')).toBeUndefined()
    enqueueAgentInput(db, { conversationId: other, queueId: 'q1', text: 'Independent' })
    deliverAgentInput(db, other, 'q1', 'read')
    expect(getAgentInput(db, conversationId, 'q1')?.receipt).toBe('sent')
    expect(setAgentInputReceipt(db, conversationId, 'q1', 'received')?.input.conversationId).toBe(conversationId)
    expect(getAgentInput(db, other, 'q1')?.receipt).toBe('read')
  })

  it('rejects invalid receipt values and rolls back transcript delivery when receipt persistence fails', () => {
    const original = put().input
    expect(() => setAgentInputReceipt(db, conversationId, 'q1', 'invalid' as never)).toThrow('receipt')
    expect(() => deliverAgentInput(db, conversationId, 'q1', 'invalid' as never)).toThrow('receipt')
    expect(() => db.prepare('UPDATE agent_inputs SET receipt = ? WHERE id = ?').run('invalid', original.id)).toThrow('CHECK constraint')
    db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF receipt ON agent_inputs BEGIN SELECT RAISE(ABORT, 'receipt failure'); END")
    expect(() => setAgentInputReceipt(db, conversationId, 'q1', 'received')).toThrow('receipt failure')
    expect(() => deliverAgentInput(db, conversationId, 'q1', 'read')).toThrow('receipt failure')
    expect(getAgentInput(db, conversationId, 'q1')).toEqual(original)
    expect(listAgentMessages(db, conversationId)).toEqual([])
  })

  it('bounds pending work without rejecting dedup retries and frees capacity on settlement', () => {
    for (let index = 0; index < MAX_PENDING_AGENT_INPUTS; index++) put(String(index), `q${index}`)
    expect(() => put('Overflow', 'overflow')).toThrow(AgentInputLimitError)
    expect(put('0', 'q0').created).toBe(false)
    deliverAgentInput(db, conversationId, 'q0')
    expect(put('Next', 'next').created).toBe(true)
    expect(listPendingAgentInputs(db, conversationId)).toHaveLength(MAX_PENDING_AGENT_INPUTS)
  })

  it('uses generated identities for legacy clients and cascades conversation deletion', () => {
    const a = enqueueAgentInput(db, { conversationId, text: '' })
    const b = enqueueAgentInput(db, { conversationId, queueId: null, text: '' })
    expect(a.input.queueId).not.toBe(b.input.queueId)
    deliverAgentInput(db, conversationId, a.input.queueId)
    deleteAgentConversation(db, conversationId)
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_inputs').get()).toEqual({ n: 0 })
    expect(deliverAgentInput(db, conversationId, 'unknown')).toBeUndefined()
    expect(() => enqueueAgentInput(db, { conversationId, text: 'Missing conversation' })).toThrow()
  })
})

it('migrations27–28 upgrade an existing desktop database without rewriting its conversations or memberships', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-agent-input-migration-'))
  const file = path.join(dir, 'desktop.sqlite')
  let db: DbInstance | undefined
  try {
    db = initDesktopDb(file)
    const conversation = createAgentConversation(db, { provider: 'codex', model: 'gpt-6-astra' })
    const legacy = addAgentMessage(db, { conversationId: conversation.id, role: 'user', content: 'Existing message' })
    db.exec('DROP TABLE agent_inputs; DELETE FROM schema_migrations WHERE version >= 27')
    db.close(); db = initDesktopDb(file)
    expect(listAgentMessages(db, conversation.id)).toEqual([legacy])
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 28 })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_repositories'").get()).toBeTruthy()
    expect(enqueueAgentInput(db, { conversationId: conversation.id, queueId: 'after-upgrade', text: 'New update' }).created).toBe(true)
    db.close(); db = initDesktopDb(file)
    const recovered = recoverPendingAgentInputs(db)
    expect(recovered[0].message).toMatchObject({ content: 'New update', delivery_status: 'interrupted' })
    expect(listAgentMessages(db, conversation.id)[0]).toEqual(legacy)
  } finally {
    db?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('migration28 adds receipts in place and backfills only accepted legacy inputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-agent-receipt-migration-'))
  const file = path.join(dir, 'desktop.sqlite')
  let db: DbInstance | undefined
  try {
    db = initDesktopDb(file)
    const conversationId = createAgentConversation(db).id
    const other = createAgentConversation(db).id
    enqueueAgentInput(db, { conversationId, queueId: 'done', text: 'Accepted' })
    deliverAgentInput(db, conversationId, 'done')
    enqueueAgentInput(db, { conversationId, queueId: 'cancelled', text: 'Cancelled' })
    cancelPendingAgentInputs(db, conversationId)
    enqueueAgentInput(db, { conversationId, queueId: 'interrupted', text: 'Interrupted' })
    recoverPendingAgentInputs(db, conversationId)
    enqueueAgentInput(db, { conversationId, queueId: 'pending', text: 'Still queued', options: { deliveryMode: 'queue', attachmentIds: ['image'] } })
    enqueueAgentInput(db, { conversationId: other, queueId: 'done', text: 'Independent queue' })
    const messages = listAgentMessages(db, conversationId)
    db.exec('ALTER TABLE agent_inputs DROP COLUMN receipt; DELETE FROM schema_migrations WHERE version = 28')
    const oldRows = db.prepare('SELECT * FROM agent_inputs ORDER BY rowid').all()
    const oldIndexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_inputs' ORDER BY name").all()
    const oldRootPage = db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'agent_inputs'").get()
    db.close(); db = initDesktopDb(file)
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 28 })
    expect(db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'agent_inputs'").get()).toEqual(oldRootPage)
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_inputs' ORDER BY name").all()).toEqual(oldIndexes)
    const upgradedRows = db.prepare('SELECT * FROM agent_inputs ORDER BY rowid').all() as Array<Record<string, unknown>>
    expect(upgradedRows.map(({ receipt: _receipt, ...original }) => original)).toEqual(oldRows)
    expect(upgradedRows.map((row) => row.receipt)).toEqual(['received', 'sent', 'sent', 'sent', 'sent'])
    expect(listAgentMessages(db, conversationId)).toEqual(messages)
    expect(decorateAgentInputMessages(db, messages).map((message) => message.delivery_receipt)).toEqual(['received', 'sent', 'sent'])
    expect(db.pragma('foreign_key_check')).toEqual([])
    setAgentInputReceipt(db, conversationId, 'done', 'read')
    db.close(); db = initDesktopDb(file)
    expect(getAgentInput(db, conversationId, 'done')?.receipt).toBe('read')
    expect(getAgentInput(db, other, 'done')?.receipt).toBe('sent')
    expect(enqueueAgentInput(db, { conversationId, queueId: 'new', text: 'New after upgrade' }).input.receipt).toBe('sent')
  } finally {
    db?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
