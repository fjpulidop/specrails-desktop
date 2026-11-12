import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import { addAgentMessage, createAgentConversation, getAgentConversation } from '../../agents/runtime/agent-store'
import type { AgentChatManager } from './agent-chat-manager'
import { createAgentChatRouter } from './agent-chat-router'
import { killBackgroundProcessesForChat, listBackgroundProcesses, purgeBackgroundProcessHistory } from '../../../transient-children'

vi.mock('../../../transient-children', () => ({
  listBackgroundProcesses: vi.fn(() => []), killBackgroundProcessesForChat: vi.fn(), purgeBackgroundProcessHistory: vi.fn(),
}))

describe('mission archive HTTP', () => {
  let db: DbInstance
  let manager: Record<string, ReturnType<typeof vi.fn>>
  let app: express.Express
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listBackgroundProcesses).mockReturnValue([])
    db = initDesktopDb(':memory:')
    manager = {
      isBusy: vi.fn(() => false), sessionState: vi.fn(() => null), abort: vi.fn(),
      closeCoreSession: vi.fn(async () => undefined), pendingMessages: vi.fn(() => []),
      conversationLive: vi.fn(() => ({ isStreaming: false })), sendMessage: vi.fn(async () => undefined),
    }
    app = express()
    app.use(express.json())
    app.use('/api/agent', createAgentChatRouter({ desktopDb: db, manager: manager as unknown as AgentChatManager }))
  })
  afterEach(() => { db.close() })

  it('archives, lists scopes, reads history and restores with the first archive stamp', async () => {
    const c = createAgentConversation(db, { pinnedProjectId: 'project' })
    addAgentMessage(db, { conversationId: c.id, role: 'user', content: 'Full history' })
    const before = getAgentConversation(db, c.id)!
    const archived = await request(app).post(`/api/agent/conversations/${c.id}/archive`)
    expect(archived.status).toBe(200)
    expect(archived.body.conversation.archivedAt).toEqual(expect.any(String))
    expect(archived.body.conversation).toEqual({ ...before, archivedAt: archived.body.conversation.archivedAt })
    expect((await request(app).post(`/api/agent/conversations/${c.id}/archive`)).body).toEqual(archived.body)
    expect((await request(app).get('/api/agent/conversations')).body.conversations).toEqual([])
    expect((await request(app).get('/api/agent/conversations?archiveScope=active')).body.conversations).toEqual([])
    expect((await request(app).get('/api/agent/conversations?archiveScope=archived')).body.conversations).toEqual([archived.body.conversation])
    expect((await request(app).get('/api/agent/conversations?archiveScope=all')).body.conversations).toEqual([archived.body.conversation])
    const history = await request(app).get(`/api/agent/conversations/${c.id}`)
    expect(history.status).toBe(200)
    expect(history.body.messages).toEqual([expect.objectContaining({ content: 'Full history' })])
    expect((await request(app).post(`/api/agent/conversations/${c.id}/unarchive`)).body.conversation).toEqual(before)
    expect((await request(app).post(`/api/agent/conversations/${c.id}/unarchive`)).body.conversation).toEqual(before)
    expect((await request(app).get('/api/agent/conversations')).body.conversations).toEqual([before])
    expect(manager.abort).not.toHaveBeenCalled()
    expect(manager.closeCoreSession).not.toHaveBeenCalled()
    expect(killBackgroundProcessesForChat).not.toHaveBeenCalled()
    expect(purgeBackgroundProcessHistory).not.toHaveBeenCalled()
  })

  it('[spec:mission-archive/archived-history-is-read-only] refuses archived send, queue edits and steering without admission effects; restore enables send', async () => {
    const c = createAgentConversation(db)
    manager.editQueued = vi.fn()
    manager.steerQueued = vi.fn()
    addAgentMessage(db, { conversationId: c.id, role: 'user', content: 'History' })
    await request(app).post(`/api/agent/conversations/${c.id}/archive`)
    const send = await request(app).post(`/api/agent/conversations/${c.id}/send`).send({ text: 'blocked', queueId: 'new' })
    expect(send.status).toBe(409)
    expect(send.body.code).toBe('MISSION_ARCHIVED')
    const edit = await request(app).patch(`/api/agent/conversations/${c.id}/queue/queued`).send({ text: 'blocked' })
    expect(edit.status).toBe(409)
    expect(edit.body.code).toBe('MISSION_ARCHIVED')
    const steer = await request(app).post(`/api/agent/conversations/${c.id}/queue/queued/steer`)
    expect(steer.status).toBe(409)
    expect(steer.body.code).toBe('MISSION_ARCHIVED')
    expect(manager.sendMessage).not.toHaveBeenCalled()
    expect(manager.editQueued).not.toHaveBeenCalled()
    expect(manager.steerQueued).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_inputs').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual({ n: 1 })
    expect((await request(app).get(`/api/agent/conversations/${c.id}`)).body.messages[0].content).toBe('History')
    await request(app).post(`/api/agent/conversations/${c.id}/unarchive`)
    expect((await request(app).post(`/api/agent/conversations/${c.id}/send`).send({ text: 'allowed' })).status).toBe(202)
    expect(manager.sendMessage).toHaveBeenCalledOnce()
  })

  it.each(['', '?permanent=1'])('refuses active DELETE %s before any cleanup', async (suffix) => {
    const c = createAgentConversation(db)
    const before = getAgentConversation(db, c.id)
    const result = await request(app).delete(`/api/agent/conversations/${c.id}${suffix}`)
    expect(result.status).toBe(409)
    expect(result.body.code).toBe('NOT_ARCHIVED')
    expect(getAgentConversation(db, c.id)).toEqual(before)
    expect(manager.abort).not.toHaveBeenCalled()
    expect(manager.closeCoreSession).not.toHaveBeenCalled()
    expect(killBackgroundProcessesForChat).not.toHaveBeenCalled()
    expect(purgeBackgroundProcessHistory).not.toHaveBeenCalled()
  })

  it('preserves unknown DELETE semantics', async () => {
    expect((await request(app).delete('/api/agent/conversations/missing')).status).toBe(200)
    expect((await request(app).delete('/api/agent/conversations/missing?permanent=1')).status).toBe(404)
  })

  it.each(['bad', '', 'active&archiveScope=all', 'active&archiveScope=active', 'x[y]=all'])('rejects malformed archive scope %s', async (scope) => {
    expect((await request(app).get(`/api/agent/conversations?archiveScope=${scope}`)).status).toBe(400)
  })

  it.each(['archive', 'unarchive'])('%s rejects missing or trashed missions', async (operation) => {
    const c = createAgentConversation(db)
    db.prepare('UPDATE agent_conversations SET deleted_at = ? WHERE id = ?').run('2026-01-01', c.id)
    expect((await request(app).post(`/api/agent/conversations/missing/${operation}`)).status).toBe(404)
    expect((await request(app).post(`/api/agent/conversations/${c.id}/${operation}`)).status).toBe(404)
    expect(getAgentConversation(db, c.id)?.archivedAt).toBeNull()
  })

  it.each([
    ['busy or reserved', true, null, null],
    ['background session', false, { residentPhase: 'background', liveSubagents: 0 }, null],
    ['live subagent', false, { residentPhase: 'idle', liveSubagents: 1 }, null],
    ['starting process', false, null, 'starting'],
    ['running process', false, null, 'running'],
  ])('[spec:mission-archive/refuse-archive-while-live] refuses archive for %s without stopping work', async (_case, busy, session, status) => {
    const c = createAgentConversation(db)
    manager.isBusy.mockReturnValue(busy)
    manager.sessionState.mockReturnValue(session)
    if (status) vi.mocked(listBackgroundProcesses).mockReturnValue([{ status } as ReturnType<typeof listBackgroundProcesses>[number]])
    const before = getAgentConversation(db, c.id)
    const result = await request(app).post(`/api/agent/conversations/${c.id}/archive`)
    expect(result.status).toBe(409)
    expect(result.body).toEqual({ error: expect.any(String), code: 'MISSION_LIVE' })
    expect(getAgentConversation(db, c.id)).toEqual(before)
    expect(manager.abort).not.toHaveBeenCalled()
    expect(manager.closeCoreSession).not.toHaveBeenCalled()
    expect(killBackgroundProcessesForChat).not.toHaveBeenCalled()
    expect(purgeBackgroundProcessHistory).not.toHaveBeenCalled()
  })

  it('allows idle resident sessions without running work', async () => {
    const c = createAgentConversation(db)
    manager.sessionState.mockReturnValue({ residentPhase: 'idle', processAlive: true, liveSubagents: 0 })
    expect((await request(app).post(`/api/agent/conversations/${c.id}/archive`)).status).toBe(200)
  })
})
