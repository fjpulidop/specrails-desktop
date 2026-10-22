import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import { createAgentConversation } from '../../agents/runtime/agent-store'
import type { AgentChatManager } from './agent-chat-manager'
import { createAgentChatRouter } from './agent-chat-router'

describe('mission send with Flow interrupt delivery', () => {
  let db: DbInstance
  let conversationId: string
  let flowActive: boolean
  let busy: boolean
  let sendMessage: ReturnType<typeof vi.fn>

  function app() {
    const server = express()
    server.use(express.json())
    server.use('/api/agent', createAgentChatRouter({ manager: {
      isBusy: () => busy,
      isFlowActive: () => flowActive,
      sendMessage,
      pendingMessages: () => [],
    } as unknown as AgentChatManager, desktopDb: db }))
    return server
  }

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    conversationId = createAgentConversation(db, { provider: 'claude', model: 'haiku' }).id
    flowActive = true
    busy = true
    sendMessage = vi.fn(async () => {})
  })

  it('admits interrupt in an active Flow as a native steer and echoes interrupt', async () => {
    const response = await request(app()).post(`/api/agent/conversations/${conversationId}/send`).send({ text: 'use blue', deliveryMode: 'interrupt' })
    expect(response.status).toBe(202)
    expect(response.body).toMatchObject({ accepted: true, queued: true, deliveryMode: 'interrupt' })
    expect(sendMessage).toHaveBeenCalledWith(conversationId, 'use blue', expect.objectContaining({ deliveryMode: 'steer' }))
  })

  it('refuses interrupt outside Flow and keeps queue/steer unchanged', async () => {
    flowActive = false
    const refused = await request(app()).post(`/api/agent/conversations/${conversationId}/send`).send({ text: 'x', deliveryMode: 'interrupt' })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('interrupt_requires_flow')
    expect(sendMessage).not.toHaveBeenCalled()
    const invalid = await request(app()).post(`/api/agent/conversations/${conversationId}/send`).send({ text: 'x', deliveryMode: 'now' })
    expect(invalid.status).toBe(400)
    const steer = await request(app()).post(`/api/agent/conversations/${conversationId}/send`).send({ text: 'x', deliveryMode: 'steer' })
    expect(steer.body.deliveryMode).toBe('steer')
  })
})
