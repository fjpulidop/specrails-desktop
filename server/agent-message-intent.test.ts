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
    expect(listAgentMessages(db, conv.id)[0].intent).toBeNull()
    const r = setAgentMessageIntent(db, msg.id, { kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: 'now', railIndex: 2, runIds: ['r1'], prDeliveryId: null })
    expect(r.ok).toBe(true)
    expect(listAgentMessages(db, conv.id)[0].intent).toMatchObject({ status: 'launched', railIndex: 2, runIds: ['r1'], prDeliveryId: null })
  })

  it('refuses a second decision on the same proposal but allows another proposal index', () => {
    const { msg } = seed()
    setAgentMessageIntent(db, msg.id, { kind: 'rail-launch', proposalIndex: 0, status: 'dismissed', at: 'now' })
    expect(setAgentMessageIntent(db, msg.id, { kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: 'now' })).toEqual({ ok: false, reason: 'already_decided' })
    expect(setAgentMessageIntent(db, 'nope', { kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: 'now' })).toEqual({ ok: false, reason: 'not_found' })
    expect(setAgentMessageIntent(db, msg.id, { kind: 'rail-launch', proposalIndex: 1, status: 'launched', at: 'now' }).ok).toBe(true)
  })

  it('PATCH route validates, persists and 409s on a repeat', async () => {
    const { conv, msg } = seed()
    const url = `/api/agent/conversations/${conv.id}/messages/${msg.id}/intent`
    expect((await request(app()).patch(url).send({ kind: 'nope' })).status).toBe(400)
    expect((await request(app()).patch(url).send({ kind: 'rail-launch', proposalIndex: -1, status: 'launched' })).status).toBe(400)
    expect((await request(app()).patch(url).send({ kind: 'rail-launch', proposalIndex: 0, status: 'maybe' })).status).toBe(400)
    const ok = await request(app()).patch(url).send({ kind: 'rail-launch', proposalIndex: 0, status: 'launched', railIndex: 1, runIds: ['a', 7], prDeliveryId: 'd1', config: { model: 'opus' } })
    expect(ok.status).toBe(200)
    expect(ok.body.message.intent).toMatchObject({ status: 'launched', railIndex: 1, runIds: ['a'], prDeliveryId: 'd1', config: { model: 'opus' } })
    expect(typeof ok.body.message.intent.at).toBe('string')
    expect((await request(app()).patch(url).send({ kind: 'rail-launch', proposalIndex: 0, status: 'dismissed' })).status).toBe(409)
    expect((await request(app()).patch(`/api/agent/conversations/${conv.id}/messages/missing/intent`).send({ kind: 'rail-launch', proposalIndex: 0, status: 'dismissed' })).status).toBe(404)
    expect((await request(app()).patch(`/api/agent/conversations/missing/messages/${msg.id}/intent`).send({ kind: 'rail-launch', proposalIndex: 0, status: 'dismissed' })).status).toBe(404)
    // GET conversation carries the intent for cold-load rendering.
    const got = await request(app()).get(`/api/agent/conversations/${conv.id}`)
    expect(got.body.messages[0].intent.status).toBe('launched')
  })

  it('403s when the feature is off', async () => {
    process.env.SPECRAILS_MISSION_RAIL_CARDS = 'false'
    const { conv, msg } = seed()
    const r = await request(app()).patch(`/api/agent/conversations/${conv.id}/messages/${msg.id}/intent`).send({ kind: 'rail-launch', proposalIndex: 0, status: 'launched' })
    expect(r.status).toBe(403)
  })
})
