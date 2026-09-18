import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb } from './desktop-db'
import type { DbInstance } from './db'
import { addAgentMessage, createAgentConversation, listAgentMessages, setAgentMessageIntent } from './agent-store'
import { createAgentChatRouter } from './agent-chat-router'
import type { AgentChatManager } from './agent-chat-manager'

let db: DbInstance
beforeEach(() => { db = initDesktopDb(':memory:') })
afterEach(() => { db.close(); delete process.env.SPECRAILS_MISSION_RAIL_CARDS })

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/agent', createAgentChatRouter({ manager: { pendingMessages: () => [], conversationLive: () => null } as unknown as AgentChatManager, desktopDb: db }))
  return a
}

function seed() {
  const conv = createAgentConversation(db, { provider: 'claude', model: 'sonnet', tierLevel: 1 } as never)
  const msg = addAgentMessage(db, { conversationId: conv.id, role: 'assistant', content: 'plan ```rail-launch\n{"ticketIds":[1]}\n```' })
  return { conv, msg }
}

describe('agent_messages.intent (mission-rail-cards)', () => {
  it('is null by default and round-trips through the store', () => {
    const { conv, msg } = seed()
    expect(listAgentMessages(db, conv.id)[0].intents).toEqual([])
    const r = setAgentMessageIntent(db, msg.id, { kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: 'now', railIndex: 2, runIds: ['r1'], prDeliveryId: null })
    expect(r.ok).toBe(true)
    expect(listAgentMessages(db, conv.id)[0].intents[0]).toMatchObject({ status: 'launched', railIndex: 2, runIds: ['r1'], prDeliveryId: null })
  })

  it('refuses a second decision on the same proposal but allows another proposal index', () => {
    const { msg } = seed()
    setAgentMessageIntent(db, msg.id, { kind: 'rail-launch', proposalIndex: 0, status: 'dismissed', at: 'now' })
    expect(setAgentMessageIntent(db, msg.id, { kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: 'now' })).toEqual({ ok: false, reason: 'already_decided' })
    expect(setAgentMessageIntent(db, 'nope', { kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: 'now' })).toEqual({ ok: false, reason: 'not_found' })
    expect(setAgentMessageIntent(db, msg.id, { kind: 'rail-launch', proposalIndex: 1, status: 'launched', at: 'now' }).ok).toBe(true)
    expect(listAgentMessages(db, msg.conversation_id)[0].intents.map((i) => [i.proposalIndex, i.status])).toEqual([[0, 'dismissed'], [1, 'launched']])
  })

  it('PATCH route validates, persists and 409s on a repeat', async () => {
    const { conv, msg } = seed()
    const url = `/api/agent/conversations/${conv.id}/messages/${msg.id}/intent`
    expect((await request(app()).patch(url).send({ kind: 'nope' })).status).toBe(400)
    expect((await request(app()).patch(url).send({ kind: 'rail-launch', proposalIndex: -1, status: 'launched' })).status).toBe(400)
    expect((await request(app()).patch(url).send({ kind: 'rail-launch', proposalIndex: 0, status: 'maybe' })).status).toBe(400)
    const ok = await request(app()).patch(url).send({ kind: 'rail-launch', proposalIndex: 0, status: 'launched', railIndex: 1, runIds: ['a', 7], prDeliveryId: 'd1', config: { model: 'opus' } })
    expect(ok.status).toBe(200)
    expect(ok.body.message.intents[0]).toMatchObject({ status: 'launched', railIndex: 1, runIds: ['a'], prDeliveryId: 'd1', config: { model: 'opus' } })
    expect(typeof ok.body.message.intents[0].at).toBe('string')
    expect((await request(app()).patch(url).send({ kind: 'rail-launch', proposalIndex: 0, status: 'dismissed' })).status).toBe(409)
    expect((await request(app()).patch(`/api/agent/conversations/${conv.id}/messages/missing/intent`).send({ kind: 'rail-launch', proposalIndex: 0, status: 'dismissed' })).status).toBe(404)
    expect((await request(app()).patch(`/api/agent/conversations/missing/messages/${msg.id}/intent`).send({ kind: 'rail-launch', proposalIndex: 0, status: 'dismissed' })).status).toBe(404)
    // GET conversation carries the intent for cold-load rendering.
    const got = await request(app()).get(`/api/agent/conversations/${conv.id}`)
    expect(got.body.messages[0].intents[0].status).toBe('launched')
  })

  it('403s when the feature is off', async () => {
    process.env.SPECRAILS_MISSION_RAIL_CARDS = 'false'
    const { conv, msg } = seed()
    const r = await request(app()).patch(`/api/agent/conversations/${conv.id}/messages/${msg.id}/intent`).send({ kind: 'rail-launch', proposalIndex: 0, status: 'launched' })
    expect(r.status).toBe(403)
  })
})

describe('legacy single-object intent column', () => {
  it('reads a pre-array value as one decision', () => {
    const { conv, msg } = seed()
    db.prepare('UPDATE agent_messages SET intent = ? WHERE id = ?').run(JSON.stringify({ kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: 'x' }), msg.id)
    expect(listAgentMessages(db, conv.id)[0].intents).toHaveLength(1)
    expect(setAgentMessageIntent(db, msg.id, { kind: 'rail-launch', proposalIndex: 0, status: 'dismissed', at: 'y' })).toEqual({ ok: false, reason: 'already_decided' })
  })
})

describe('run-only card dismiss (POST /rails/pr-decision with a run: id)', () => {
  it('AgentChatManager.dismissRunCard marks the persisted envelope discarded and refuses delivery cards', async () => {
    const { AgentChatManager } = await import('./agent-chat-manager')
    const broadcasts: unknown[] = []
    const manager = new AgentChatManager((m: unknown) => { broadcasts.push(m) }, db, 0)
    const conv = createAgentConversation(db, { provider: 'claude' })
    const envelope = { kind: 'pr_decision', prDeliveryId: 'run:r1', railIndex: 0, projectId: 'p', baseBranch: '', ticketIds: [1], decision: 'implementation_failed', implementationOutcome: 'failed', deliveryOutcome: 'not_started', statusCode: 'implementation_failed', statusDetail: 'boom', deliverySha: null, isContinuation: false, supersedesDeliveryId: null, restoredFromDeliveryId: null, operation: null, cleanupWarnings: [], safetyArchives: [], units: [], prUrl: null, prNumber: null, prState: 'none', branch: null, runIds: ['r1'], hasDelivery: false, phase: 'settled' }
    manager.postPrDecisionCard(conv.id, envelope as never)
    expect(manager.dismissRunCard(conv.id, 'run:missing')).toBe(false)
    expect(manager.dismissRunCard(conv.id, 'run:r1')).toBe(true)
    const rows = listAgentMessages(db, conv.id).filter((m) => m.role === 'system')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].content)).toMatchObject({ decision: 'discarded', phase: 'settled', operation: 'dismiss', hasDelivery: false })
    const delivery = { ...envelope, prDeliveryId: 'd1', hasDelivery: true }
    manager.postPrDecisionCard(conv.id, delivery as never)
    expect(manager.dismissRunCard(conv.id, 'd1')).toBe(false)
    expect(broadcasts.filter((b) => (b as { type: string }).type === 'agent_pr_decision').length).toBeGreaterThanOrEqual(3)
  })
})
