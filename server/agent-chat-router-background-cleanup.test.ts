import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb, type DbInstance } from './desktop-db'
import { createAgentConversation, getAgentConversation } from './agent-store'
import { createAgentChatRouter } from './agent-chat-router'
import type { AgentChatManager } from './agent-chat-manager'
import { killBackgroundProcessesForChat } from './transient-children'

vi.mock('./transient-children', () => ({
  killBackgroundProcessesForChat: vi.fn(),
}))

let db: DbInstance

beforeEach(() => {
  db = initDesktopDb(':memory:')
  vi.mocked(killBackgroundProcessesForChat).mockReset()
})

afterEach(() => {
  db.close()
})

it('kills background chip processes when deleting their owning agent conversation', async () => {
  const conversation = createAgentConversation(db, { provider: 'claude' })
  const abort = vi.fn(() => true)
  const app = express()
  app.use(express.json())
  app.use('/api/agent', createAgentChatRouter({
    manager: { abort } as unknown as AgentChatManager,
    desktopDb: db,
  }))

  const res = await request(app).delete(`/api/agent/conversations/${conversation.id}`)

  expect(res.status).toBe(200)
  expect(abort).toHaveBeenCalledWith(conversation.id)
  expect(killBackgroundProcessesForChat).toHaveBeenCalledWith(conversation.id)
  expect(getAgentConversation(db, conversation.id)).toBeUndefined()
})
