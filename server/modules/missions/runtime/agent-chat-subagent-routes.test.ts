import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import { createAgentConversation } from '../../agents/runtime/agent-store'
import { appendSubagentEvent, ensureSessionCursor, setResidentState, upsertSubagent } from './agent-session-store'
import { SessionRebuildBusyError, type AgentChatManager } from './agent-chat-manager'
import { createAgentChatRouter } from './agent-chat-router'

const node = (subagentId: string, phase: 'running' | 'idle') => ({
  subagentId, parentId: null, kind: 'background' as const, agentType: 'general-purpose', description: `Task ${subagentId}`, phase, reason: null, restarts: 0,
  startedAt: '2026-10-07T10:00:00.000Z', endedAt: null, usage: null, toolUses: null, durationMs: null, resultSummary: null, launchedInTurnId: 't1',
})

describe('mission sub-agent routes', () => {
  let db: DbInstance
  let conversationId: string
  let stop: ReturnType<typeof vi.fn>
  let rebuild: ReturnType<typeof vi.fn>

  function app() {
    const server = express()
    server.use(express.json())
    server.use('/api/agent', createAgentChatRouter({ manager: {
      notifyConversationCreated: vi.fn(),
      pendingMessages: () => [],
      conversationLive: () => ({ isStreaming: false, streamingText: '', startedAt: undefined }),
      sessionState: () => ({ residentPhase: 'background', processAlive: true, liveSubagents: 1, subagents: [] }),
      stopSubagents: stop,
      rebuildSessionProjection: rebuild,
    } as unknown as AgentChatManager, desktopDb: db }))
    return server
  }

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    conversationId = createAgentConversation(db, { provider: 'claude', model: 'haiku' }).id
    ensureSessionCursor(db, conversationId, conversationId, 'global')
    setResidentState(db, conversationId, 'background', true, 1)
    upsertSubagent(db, conversationId, node('a1', 'running'))
    upsertSubagent(db, conversationId, node('a2', 'idle'))
    for (let seq = 1; seq <= 5; seq++) appendSubagentEvent(db, conversationId, 'a1', seq, 'text', `chunk ${seq}`, null)
    stop = vi.fn(async () => ['a1'])
    rebuild = vi.fn(async () => ({ lastSeq: 12, subagents: 2 }))
  })

  it('lists sub-agents with the projected session state', async () => {
    const response = await request(app()).get(`/api/agent/conversations/${conversationId}/subagents`)
    expect(response.status).toBe(200)
    expect(response.body.subagents.map((item: { subagentId: string }) => item.subagentId)).toEqual(['a1', 'a2'])
    expect(response.body.session).toMatchObject({ residentPhase: 'background', liveSubagents: 1 })
    expect((await request(app()).get('/api/agent/conversations/ghost/subagents')).status).toBe(404)
  })

  it('pages a sub-agent transcript and validates the cursor', async () => {
    const first = await request(app()).get(`/api/agent/conversations/${conversationId}/subagents/a1/events?after=0&limit=2`)
    expect(first.body).toMatchObject({ hasMore: true, events: [{ seq: 1, delta: 'chunk 1' }, { seq: 2, delta: 'chunk 2' }] })
    const last = await request(app()).get(`/api/agent/conversations/${conversationId}/subagents/a1/events?after=4`)
    expect(last.body).toMatchObject({ hasMore: false, events: [{ seq: 5 }] })
    expect((await request(app()).get(`/api/agent/conversations/${conversationId}/subagents/a1/events?limit=0`)).status).toBe(400)
    expect((await request(app()).get(`/api/agent/conversations/${conversationId}/subagents/a1/events?after=-1`)).status).toBe(400)
  })

  it('stops all or selected sub-agents through the manager', async () => {
    expect((await request(app()).post(`/api/agent/conversations/${conversationId}/subagents/stop`).send({})).body).toEqual({ stopped: ['a1'] })
    expect(stop).toHaveBeenCalledWith(conversationId, undefined)
    await request(app()).post(`/api/agent/conversations/${conversationId}/subagents/stop`).send({ subagentIds: ['a1'] })
    expect(stop).toHaveBeenLastCalledWith(conversationId, ['a1'])
    expect((await request(app()).post(`/api/agent/conversations/${conversationId}/subagents/stop`).send({ subagentIds: [1] })).status).toBe(400)
    stop.mockRejectedValueOnce(new Error('host down'))
    expect((await request(app()).post(`/api/agent/conversations/${conversationId}/subagents/stop`).send({})).status).toBe(502)
  })

  it('includes the session state in the conversation payload', async () => {
    const response = await request(app()).get(`/api/agent/conversations/${conversationId}`)
    expect(response.body.session).toMatchObject({ residentPhase: 'background' })
  })

  it('rebuilds the session projection on request', async () => {
    const url = `/api/agent/conversations/${conversationId}/session/rebuild`
    expect((await request(app()).post(url)).body).toEqual({ lastSeq: 12, subagents: 2 })
    expect(rebuild).toHaveBeenCalledWith(conversationId)
    rebuild.mockResolvedValueOnce(null)
    expect((await request(app()).post(url)).status).toBe(409)
    rebuild.mockRejectedValueOnce(new SessionRebuildBusyError('busy'))
    expect((await request(app()).post(url)).status).toBe(409)
    rebuild.mockRejectedValueOnce(new Error('host down'))
    expect((await request(app()).post(url))).toMatchObject({ status: 502, body: { error: 'host down' } })
    expect((await request(app()).post('/api/agent/conversations/ghost/session/rebuild')).status).toBe(404)
  })
})
