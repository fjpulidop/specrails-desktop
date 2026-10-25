import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb, type DbInstance } from './desktop-db'
import { createAgentConversation, getAgentConversation } from './modules/agents/runtime/agent-store'
import { createAgentChatRouter } from './modules/missions/runtime/agent-chat-router'
import type { AgentChatManager } from './modules/missions/runtime/agent-chat-manager'
import { killBackgroundProcessesForChat, purgeBackgroundProcessHistory } from './transient-children'

vi.mock('./transient-children', () => ({
  killBackgroundProcessesForChat: vi.fn(),
  purgeBackgroundProcessHistory: vi.fn(),
}))

let db: DbInstance

beforeEach(() => {
  db = initDesktopDb(':memory:')
  vi.mocked(killBackgroundProcessesForChat).mockReset()
  vi.mocked(purgeBackgroundProcessHistory).mockReset()
})

afterEach(() => {
  db.close()
})

function appFor(abort: () => boolean) {
  const app = express()
  app.use(express.json())
  app.use('/api/agent', createAgentChatRouter({
    manager: { abort, closeCoreSession: async () => {} } as unknown as AgentChatManager,
    desktopDb: db,
  }))
  return app
}

it('soft delete stops live background processes but keeps the mission and its history restorable', async () => {
  const conversation = createAgentConversation(db, { provider: 'claude' })
  const abort = vi.fn(() => true)

  const res = await request(appFor(abort)).delete(`/api/agent/conversations/${conversation.id}`)

  expect(res.status).toBe(200)
  expect(res.body.restorable).toBe(true)
  expect(abort).toHaveBeenCalledWith(conversation.id)
  expect(killBackgroundProcessesForChat).toHaveBeenCalledWith(conversation.id)
  expect(purgeBackgroundProcessHistory).not.toHaveBeenCalled()
  expect(getAgentConversation(db, conversation.id)?.deleted_at).toBeTruthy()
})

it('permanent delete kills background chip processes and purges their history', async () => {
  const conversation = createAgentConversation(db, { provider: 'claude' })
  const abort = vi.fn(() => true)

  const res = await request(appFor(abort)).delete(`/api/agent/conversations/${conversation.id}?permanent=1`)

  expect(res.status).toBe(200)
  expect(abort).toHaveBeenCalledWith(conversation.id)
  expect(killBackgroundProcessesForChat).toHaveBeenCalledWith(conversation.id)
  expect(purgeBackgroundProcessHistory).toHaveBeenCalledWith({ chatId: conversation.id })
  expect(getAgentConversation(db, conversation.id)).toBeUndefined()
})
