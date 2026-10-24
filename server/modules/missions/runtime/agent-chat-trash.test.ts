import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import {
  addAgentMessage,
  createAgentConversation,
  getAgentConversation,
  listAgentConversations,
  searchAgentConversations,
} from '../../agents/runtime/agent-store'
import type { AgentChatManager } from './agent-chat-manager'
import { createAgentChatRouter } from './agent-chat-router'

describe('missions: soft delete and Recently deleted', () => {
  let db: DbInstance
  let manager: Record<string, ReturnType<typeof vi.fn>>

  function app() {
    const server = express()
    server.use(express.json())
    server.use('/api/agent', createAgentChatRouter({ manager: manager as unknown as AgentChatManager, desktopDb: db }))
    return server
  }

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    manager = {
      abort: vi.fn(),
      closeCoreSession: vi.fn(async () => undefined),
      pendingMessages: vi.fn(() => []),
      conversationLive: vi.fn(() => false),
      sessionState: vi.fn(() => null),
      sendMessage: vi.fn(async () => undefined),
      isBusy: vi.fn(() => false),
    }
  })

  it('migration 37 adds deleted_at, null for existing rows', () => {
    const cols = (db.prepare('PRAGMA table_info(agent_conversations)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('deleted_at')
    const c = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    expect(getAgentConversation(db, c.id)?.deleted_at).toBeNull()
  })

  it('DELETE stops the live turn, hides the mission everywhere and keeps its history', async () => {
    const c = createAgentConversation(db, { provider: 'claude', model: 'haiku', pinnedProjectId: 'p1' })
    addAgentMessage(db, { conversationId: c.id, role: 'user', content: 'zebra migration plan' })
    db.prepare('UPDATE agent_conversations SET title = ? WHERE id = ?').run('Zebra mission', c.id)

    const res = await request(app()).delete(`/api/agent/conversations/${c.id}`)
    expect(res.status).toBe(200)
    expect(res.body.restorable).toBe(true)
    expect(manager.abort).toHaveBeenCalledWith(c.id)
    expect(manager.closeCoreSession).toHaveBeenCalledWith(c.id)

    expect(listAgentConversations(db).map((x) => x.id)).not.toContain(c.id)
    expect((await request(app()).get('/api/agent/conversations')).body.conversations).toEqual([])
    expect(searchAgentConversations(db, 'zebra')).toEqual([])
    expect(searchAgentConversations(db, 'Zebra mission')).toEqual([])
    expect((await request(app()).get(`/api/agent/conversations/${c.id}`)).status).toBe(404)
    expect((await request(app()).post(`/api/agent/conversations/${c.id}/send`).send({ text: 'hi' })).status).toBe(404)
    // The row and its messages are still there (restorable).
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE conversation_id = ?').get(c.id)).toEqual({ n: 1 })
  })

  it('lists the trash per project and restores with the full history', async () => {
    const a = createAgentConversation(db, { provider: 'claude', model: 'haiku', pinnedProjectId: 'p1' })
    const b = createAgentConversation(db, { provider: 'claude', model: 'haiku', pinnedProjectId: 'p2' })
    addAgentMessage(db, { conversationId: a.id, role: 'user', content: 'hello' })
    await request(app()).delete(`/api/agent/conversations/${a.id}`)
    await request(app()).delete(`/api/agent/conversations/${b.id}`)

    const p1 = await request(app()).get('/api/agent/conversations/trash?projectId=p1')
    expect(p1.status).toBe(200)
    expect(p1.body.items.map((i: { conversation: { id: string } }) => i.conversation.id)).toEqual([a.id])
    expect(p1.body.retentionDays).toBe(30)
    expect(Date.parse(p1.body.items[0].purgeAt) - Date.parse(`${p1.body.items[0].deletedAt}`)).toBe(30 * 86_400_000)
    expect((await request(app()).get('/api/agent/conversations/trash')).body.items).toHaveLength(2)

    const restored = await request(app()).post(`/api/agent/conversations/${a.id}/restore`)
    expect(restored.status).toBe(200)
    expect(restored.body.conversation.deleted_at).toBeNull()
    const open = await request(app()).get(`/api/agent/conversations/${a.id}`)
    expect(open.status).toBe(200)
    expect(open.body.messages).toHaveLength(1)
    expect((await request(app()).get('/api/agent/conversations/trash?projectId=p1')).body.items).toEqual([])
    // Idempotent; unknown id is 404.
    expect((await request(app()).post(`/api/agent/conversations/${a.id}/restore`)).status).toBe(200)
    expect((await request(app()).post('/api/agent/conversations/nope/restore')).status).toBe(404)
  })

  it('a repeat DELETE keeps the first deletion stamp', async () => {
    const c = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    await request(app()).delete(`/api/agent/conversations/${c.id}`)
    const first = getAgentConversation(db, c.id)?.deleted_at
    db.prepare('UPDATE agent_conversations SET deleted_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', c.id)
    await request(app()).delete(`/api/agent/conversations/${c.id}`)
    expect(first).toBeTruthy()
    expect(getAgentConversation(db, c.id)?.deleted_at).toBe('2020-01-01T00:00:00.000Z')
  })

  it('?permanent=1 removes the mission for good, deleted or not', async () => {
    const c = createAgentConversation(db, { provider: 'claude', model: 'haiku' })
    await request(app()).delete(`/api/agent/conversations/${c.id}`)
    const gone = await request(app()).delete(`/api/agent/conversations/${c.id}?permanent=1`)
    expect(gone.status).toBe(200)
    expect(getAgentConversation(db, c.id)).toBeUndefined()
    expect((await request(app()).delete(`/api/agent/conversations/${c.id}?permanent=1`)).status).toBe(404)
    expect((await request(app()).post(`/api/agent/conversations/${c.id}/restore`)).status).toBe(404)
  })

  it('reading the trash purges missions deleted more than 30 days ago, and only those', async () => {
    const old = createAgentConversation(db, { provider: 'claude', model: 'haiku', pinnedProjectId: 'p1' })
    const fresh = createAgentConversation(db, { provider: 'claude', model: 'haiku', pinnedProjectId: 'p1' })
    await request(app()).delete(`/api/agent/conversations/${old.id}`)
    await request(app()).delete(`/api/agent/conversations/${fresh.id}`)
    db.prepare('UPDATE agent_conversations SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString(), old.id)
    const res = await request(app()).get('/api/agent/conversations/trash?projectId=p1')
    expect(res.body.items.map((i: { conversation: { id: string } }) => i.conversation.id)).toEqual([fresh.id])
    expect(getAgentConversation(db, old.id)).toBeUndefined()
    expect(getAgentConversation(db, fresh.id)).toBeDefined()
  })
})
