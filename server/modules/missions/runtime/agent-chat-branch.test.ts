import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { initDesktopDb } from '../../../desktop-db'
import { AttachmentManager, attachmentManager } from '../../../attachment-manager'
import { addAgentMessage, createAgentConversation, deleteAgentConversation, getAgentConversation, listAgentConversations, listAgentMessages, setAgentMessageIntent, updateAgentConversation } from '../../agents/runtime/agent-store'
import type { AgentChatManager } from './agent-chat-manager'
import { createAgentChatRouter } from './agent-chat-router'
import { decorateAgentInputMessages, enqueueAgentInput, recoverPendingAgentInputs } from './agent-input-store'

vi.mock('../../../attachment-manager', async original => ({
  ...await original<typeof import('../../../attachment-manager')>(),
  attachmentManager: { copyAgentAttachments: vi.fn(), deleteAllAgent: vi.fn() },
}))

describe('mission branches', () => {
  let db: ReturnType<typeof initDesktopDb>
  let files: AttachmentManager
  let home: string
  let app: express.Express
  const manager = { notifyConversationCreated: vi.fn(), sendMessage: vi.fn() }
  beforeEach(() => {
    vi.clearAllMocks()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-branch-'))
    files = new AttachmentManager(home)
    vi.mocked(attachmentManager.copyAgentAttachments).mockImplementation((...args) => files.copyAgentAttachments(...args))
    vi.mocked(attachmentManager.deleteAllAgent).mockImplementation(id => files.deleteAllAgent(id))
    db = initDesktopDb(':memory:')
    app = express().use(express.json()).use('/api/agent', createAgentChatRouter({ desktopDb: db, manager: manager as unknown as AgentChatManager }))
  })
  afterEach(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }) })
  const upload = (conversationId: string, text: string) => files.uploadAgent({ conversationId,
    file: { buffer: Buffer.from(text), size: text.length, mimetype: 'text/plain', originalname: `${text}.txt` } })

  it('[spec:mission-text-reuse/fork-snapshots-are-inclusive-and-independent] copies the inclusive cut with independent files, settings and provenance; never starts a turn', async () => {
    const source = createAgentConversation(db, { pinnedProjectId: 'project', provider: 'codex', model: 'gpt-6.1-sol', tierLevel: 3, reasoningEffort: 'high' })
    updateAgentConversation(db, source.id, { title: 'Original', session_id: 'private-provider-session' })
    const file = await upload(source.id, 'selected-context')
    const laterFile = await upload(source.id, 'later-context')
    await upload(source.id, 'unsent-draft')
    const first = addAgentMessage(db, { conversationId: source.id, role: 'user', content: 'First', attachmentIds: [file.id], contextRefs: [{ kind: 'project', id: 'project', label: 'Project', token: '@project' }] })
    const cut = addAgentMessage(db, { conversationId: source.id, role: 'assistant', content: 'Selected', coreTurnId: 'old-core-turn' })
    setAgentMessageIntent(db, cut.id, { kind: 'rail-launch', proposalIndex: 0, status: 'launched', at: '2026-01-01', runIds: ['old-run'] })
    addAgentMessage(db, { conversationId: source.id, role: 'user', content: 'Later', attachmentIds: [laterFile.id] })
    enqueueAgentInput(db, { conversationId: source.id, queueId: 'pending', text: 'Pending' })
    const before = listAgentMessages(db, source.id)
    const result = await request(app).post(`/api/agent/conversations/${source.id}/branch`).send({ mode: 'fork', throughMessageId: cut.id })
    expect(result.status).toBe(201)
    const branch = result.body.conversation
    expect(branch).toMatchObject({ provider: source.provider, model: source.model, pinned_project_id: 'project', tier_level: 3, reasoning_effort: 'high', session_id: null, archivedAt: null,
      forkSource: { conversationId: source.id, messageId: cut.id, title: 'Original' } })
    const history = listAgentMessages(db, branch.id)
    expect(history.map(message => message.content)).toEqual(['First', 'Selected'])
    expect(history[0]).toMatchObject({ ...first, id: expect.any(String), conversation_id: branch.id, source_message_id: first.id })
    expect(history[0].id).not.toBe(first.id)
    expect(history[1].intents[0].status).toBe('launched')
    expect(history[1].core_turn_id).toBeUndefined()
    expect(files.listAgent(branch.id)).toEqual([file])
    expect(listAgentMessages(db, source.id)).toEqual(before)
    expect(getAgentConversation(db, source.id)?.session_id).toBe('private-provider-session')
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_inputs WHERE conversation_id = ?').get(branch.id)).toEqual({ n: 0 })
    expect(manager.sendMessage).not.toHaveBeenCalled()
    expect(manager.notifyConversationCreated).toHaveBeenCalledExactlyOnceWith(branch.id)
    deleteAgentConversation(db, source.id)
    await files.deleteAllAgent(source.id)
    expect(fs.readFileSync(files.getAgentFilePath(branch.id, file.id)!, 'utf8')).toBe('selected-context')
    expect(getAgentConversation(db, branch.id)?.forkSource?.messageId).toBe(cut.id)
  })

  it('[spec:mission-text-reuse/snapshot-creation-reports-failure-without-a-partial-mission] starts empty with the source settings and no history, files or provider session', async () => {
    const source = createAgentConversation(db, { pinnedProjectId: 'p', provider: 'codex', tierLevel: 2 })
    const message = addAgentMessage(db, { conversationId: source.id, role: 'user', content: 'Source' })
    const result = await request(app).post(`/api/agent/conversations/${source.id}/branch`).send({ mode: 'empty', throughMessageId: message.id })
    expect(result.status).toBe(201)
    expect(result.body.conversation).toMatchObject({ pinned_project_id: 'p', provider: 'codex', tier_level: 2, session_id: null })
    expect(result.body.conversation.forkSource).toBeUndefined()
    expect(listAgentMessages(db, result.body.conversation.id)).toEqual([])
    expect(files.listAgent(result.body.conversation.id)).toEqual([])
    expect(manager.sendMessage).not.toHaveBeenCalled()
  })

  it('[spec:mission-text-reuse/fork-snapshots-are-inclusive-and-independent] preserves interrupted history without copying admissions that could replay it', async () => {
    const source = createAgentConversation(db)
    enqueueAgentInput(db, { conversationId: source.id, queueId: 'interrupted', text: 'Unfinished' })
    recoverPendingAgentInputs(db)
    const [message] = listAgentMessages(db, source.id)
    const result = await request(app).post(`/api/agent/conversations/${source.id}/branch`).send({ mode: 'fork', throughMessageId: message.id })
    expect(result.status).toBe(201)
    expect(decorateAgentInputMessages(db, listAgentMessages(db, result.body.conversation.id))[0]).toMatchObject({ content: 'Unfinished', delivery_status: 'interrupted' })
    expect(recoverPendingAgentInputs(db)).toEqual([])
  })

  it('[spec:mission-text-reuse/snapshot-creation-reports-failure-without-a-partial-mission] branches archived sources without changing their archive state', async () => {
    const source = createAgentConversation(db)
    db.prepare('UPDATE agent_conversations SET archived_at = ? WHERE id = ?').run('2026-01-01', source.id)
    const message = addAgentMessage(db, { conversationId: source.id, role: 'user', content: 'Archived history' })
    const before = getAgentConversation(db, source.id)
    const result = await request(app).post(`/api/agent/conversations/${source.id}/branch`).send({ mode: 'fork', throughMessageId: message.id })
    expect(result.status).toBe(201)
    expect(result.body.conversation.archivedAt).toBeNull()
    expect(listAgentMessages(db, result.body.conversation.id).map(row => row.content)).toEqual(['Archived history'])
    expect(getAgentConversation(db, source.id)).toEqual(before)
    expect(before?.archivedAt).toBe('2026-01-01')
    expect(manager.sendMessage).not.toHaveBeenCalled()
  })

  it('[spec:mission-text-reuse/snapshot-creation-reports-failure-without-a-partial-mission] rejects a foreign message, missing source, trash and malformed requests without creating a mission', async () => {
    const source = createAgentConversation(db)
    const other = createAgentConversation(db)
    const message = addAgentMessage(db, { conversationId: other.id, role: 'user', content: 'Other project' })
    const endpoint = `/api/agent/conversations/${source.id}/branch`
    expect((await request(app).post(endpoint).send({ mode: 'fork', throughMessageId: message.id })).status).toBe(404)
    expect((await request(app).post(endpoint).send({ mode: 'fork' })).status).toBe(400)
    expect((await request(app).post(endpoint).send({ mode: 'unknown', throughMessageId: message.id })).status).toBe(400)
    expect((await request(app).post('/api/agent/conversations/missing/branch').send({ mode: 'fork', throughMessageId: message.id })).status).toBe(404)
    db.prepare('UPDATE agent_conversations SET deleted_at = ? WHERE id = ?').run('2026-01-01', source.id)
    expect((await request(app).post(endpoint).send({ mode: 'empty', throughMessageId: message.id })).status).toBe(404)
    expect(listAgentConversations(db)).toHaveLength(1)
    expect(manager.notifyConversationCreated).not.toHaveBeenCalled()
  })

  it.each(['missing file', 'database failure'])('[spec:mission-text-reuse/snapshot-creation-reports-failure-without-a-partial-mission] rolls back the mission and its files on %s', async failure => {
    const source = createAgentConversation(db)
    const file = await upload(source.id, 'context')
    const message = addAgentMessage(db, { conversationId: source.id, role: 'user', content: 'Original', attachmentIds: [file.id] })
    if (failure === 'missing file') fs.unlinkSync(files.getAgentFilePath(source.id, file.id)!)
    else db.exec(`CREATE TRIGGER fail_copy BEFORE INSERT ON agent_messages WHEN NEW.source_message_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'copy failed'); END`)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await request(app).post(`/api/agent/conversations/${source.id}/branch`).send({ mode: 'fork', throughMessageId: message.id })
      expect(result.status).toBe(409)
      expect(listAgentConversations(db).map(item => item.id)).toEqual([source.id])
      expect(listAgentMessages(db, source.id)).toEqual([message])
      expect(fs.readdirSync(path.join(home, '.specrails', 'agent'))).toEqual([source.id])
      expect(manager.notifyConversationCreated).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })
})
