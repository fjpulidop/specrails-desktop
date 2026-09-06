import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb, addProject } from '../desktop-db'
import { createAgentConversation } from '../agent-store'
import { createDevice, hashToken, setAllowedProjects, getAllowedProjects, _resetAclColumnCacheForTests } from './mobile-devices'
import { createMobileMissionsRouter, missionSnapshot, type MobileUpstream } from './mobile-missions'
import type { DbInstance } from '../db'

describe('mobile mission contract', () => {
  let db: DbInstance
  let app: express.Express
  let deviceId: string
  let cid: string
  let upstream: ReturnType<typeof vi.fn<MobileUpstream>>
  beforeEach(() => {
    _resetAclColumnCacheForTests()
    db = initDesktopDb(':memory:')
    addProject(db, { id: 'p1', name: 'Checkout', slug: 'mobile-test', path: '/tmp/mobile-no-user-project' })
    addProject(db, { id: 'p2', name: 'Other', slug: 'mobile-other', path: '/tmp/mobile-no-other-project' })
    deviceId = createDevice(db, { name: 'Phone', platform: 'ios', tokenHash: hashToken('test-only'), certFingerprint: 'fp' }).id
    cid = createAgentConversation(db, { pinnedProjectId: 'p1' }).id
    upstream = vi.fn(async () => ({ status: 200, json: { ok: true } }))
    app = express(); app.use(express.json())
    app.use((req, _res, next) => { Object.assign(req, { mobileDevice: { id: deviceId } }); next() })
    app.use('/v1', createMobileMissionsRouter({ db, upstream }))
  })
  afterEach(() => { db.close(); vi.unstubAllEnvs() })
  const base = () => '/v1/projects/p1/missions'
  it('negotiates additive capabilities; restricted and disabled missions explain why', async () => {
    expect((await request(app).get('/v1/capabilities')).body).toMatchObject({ protocolVersion: 2, features: { missions: true, repositories: true } })
    setAllowedProjects(db, deviceId, ['p1'])
    expect((await request(app).get('/v1/capabilities')).body).toMatchObject({ features: { missions: false }, missionsUnavailableReason: expect.stringContaining('all-projects') })
    for (const method of ['get', 'post'] as const) expect((await request(app)[method](base())).status).toBe(403)
    expect((await request(app).get(`${base()}/${cid}`)).status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
    setAllowedProjects(db, deviceId, [])
    vi.stubEnv('SPECRAILS_AGENT_CHAT', 'false')
    expect((await request(app).get('/v1/capabilities')).body.features.missions).toBe(false)
  })
  it('pins creation to the authorized URL and drops arbitrary privileged fields', async () => {
    upstream.mockResolvedValue({ status: 201, json: { conversation: { id: cid, provider: 'codex', session_id: 'secret', pinned_project_id: 'p1' } } })
    const response = await request(app).post(base()).send({ provider: 'codex', tierLevel: 2, pinnedProjectId: 'p2', env: { TOKEN: 'secret' }, model: 'gpt-6-astra' })
    expect(upstream).toHaveBeenCalledWith('POST', '/api/agent/conversations', { provider: 'codex', tierLevel: 2, pinnedProjectId: 'p1', model: 'gpt-6-astra' })
    expect(response.status).toBe(201)
    expect(response.body.conversation.session_id).toBeUndefined()
  })
  it('requires matching conversation identity for every scoped operation', async () => {
    const foreign = createAgentConversation(db, { pinnedProjectId: 'p2' }).id
    expect((await request(app).get(`${base()}/${foreign}`)).status).toBe(404)
    expect((await request(app).post(`${base()}/${foreign}/send`).send({ queueId: 'q1', text: 'Hi' })).status).toBe(404)
    expect((await request(app).delete(`${base()}/${foreign}/queue/q1`)).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })
  it('preserves idempotency and queue mode while narrowing send metadata', async () => {
    const payload = { text: 'Implement #17', queueId: 'stable-1', deliveryMode: 'steer', attachmentIds: ['secret-file'], contextRefs: [{ projectId: 'other' }], model: 'arbitrary' }
    await request(app).post(`${base()}/${cid}/send`).send(payload)
    expect(upstream).toHaveBeenCalledWith('POST', `/api/agent/conversations/${cid}/send`, { text: payload.text, queueId: payload.queueId, deliveryMode: 'steer' })
    expect((await request(app).post(`${base()}/${cid}/send`).send({ text: 'missing identity' })).status).toBe(400)
    expect((await request(app).post(`${base()}/${cid}/send`).send({ text: 'x', queueId: 'q', deliveryMode: 'execute' })).status).toBe(400)
  })
  it('preserves conflicts after queue claim, edit, steer and removal methods', async () => {
    upstream.mockResolvedValue({ status: 409, json: { error: 'Already entered the provider' } })
    const response = await request(app).patch(`${base()}/${cid}/queue/q`).send({ text: 'edited', model: 'bad' })
    expect(response.status).toBe(409)
    expect(upstream).toHaveBeenLastCalledWith('PATCH', `/api/agent/conversations/${cid}/queue/q`, { text: 'edited' })
    await request(app).post(`${base()}/${cid}/queue/q/steer`)
    expect(upstream).toHaveBeenLastCalledWith('POST', `/api/agent/conversations/${cid}/queue/q/steer`, undefined)
    await request(app).delete(`${base()}/${cid}/queue/q`)
    expect(upstream).toHaveBeenLastCalledWith('DELETE', `/api/agent/conversations/${cid}/queue/q`, undefined)
  })
  it('exposes current repo identities without filesystem roots', async () => {
    const response = await request(app).get('/v1/projects/p1/repositories')
    expect(response.body.repositories[0]).toMatchObject({ id: 'primary-p1', name: 'Checkout', isPrimary: true })
    expect(JSON.stringify(response.body)).not.toContain('/tmp/')
    expect(response.body.repositories[0].path).toBeUndefined()
  })
  it('queries missions before limiting and marks active authoritative turns', async () => {
    createAgentConversation(db, { pinnedProjectId: 'p2' })
    upstream.mockResolvedValue({ status: 200, json: { turns: [{ conversationId: cid, streamingText: 'private' }] } })
    const response = await request(app).get(`${base()}?limit=1`)
    expect(response.body.conversations).toHaveLength(1)
    expect(response.body.conversations[0]).toMatchObject({ id: cid, isStreaming: true })
    expect(JSON.stringify(response.body)).not.toContain('private')
    expect((await request(app).get(`${base()}?limit=201`)).status).toBe(400)
  })
  it('process control binds project, conversation, UUID and OS pid with a bounded log tail', async () => {
    await request(app).get(`${base()}/${cid}/processes/run-uuid/logs?pid=123&chatId=foreign&limit=999999`)
    expect(upstream).toHaveBeenLastCalledWith('GET', `/api/projects/p1/background-processes/123/logs?chatId=${cid}&processId=run-uuid&limit=1000`, undefined)
    await request(app).delete(`${base()}/${cid}/processes/run-uuid?pid=123`)
    expect(upstream).toHaveBeenLastCalledWith('DELETE', `/api/projects/p1/background-processes/123?chatId=${cid}&processId=run-uuid`, undefined)
    expect((await request(app).delete(`${base()}/${cid}/processes/run-uuid`)).status).toBe(400)
    expect((await request(app).post(`${base()}/${cid}/processes`).send({ command: 'arbitrary' })).status).toBe(404)
  })
  it('never turns corrupt stored restrictions into all-project grants', () => {
    setAllowedProjects(db, deviceId, ['p1'])
    for (const value of ['broken', '{}', '[]', '[123]']) {
      db.prepare('UPDATE mobile_devices SET allowed_projects = ? WHERE id = ?').run(value, deviceId)
      expect(getAllowedProjects(db, deviceId)).toEqual(new Set())
    }
    expect(getAllowedProjects(db, 'missing-device')).toEqual(new Set())
  })
  it('budgets UTF-8 pending, stream and history together and flags shortened queue previews', () => {
    const result = missionSnapshot({ pendingMessages: Array.from({ length: 50 }, (_, i) => ({ queueId: `q${i}`, text: '😺'.repeat(40000) })), live: { streamingText: '😺'.repeat(40000) }, messages: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, role: 'assistant', content: '😺'.repeat(40000) })) })
    const text = result.live.streamingText + result.pendingMessages.map(row => row.text).join('') + result.messages.map(row => row.content).join('')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(480000)
    expect(text).not.toContain('�')
    expect(result.pendingMessages).toHaveLength(50)
    expect(result.pendingMessages.every(row => row.textTruncated)).toBe(true)
    expect(result.live.textTruncated).toBe(true)
  })
  it('bounds long history and excludes provider/context internals and arbitrary system card payloads', () => {
    const result = missionSnapshot({ conversation: { id: cid, session_id: 'private' }, messages: Array.from({ length: 201 }, (_, i) => ({ id: `m${i}`, role: 'assistant', content: 'x'.repeat(50000), context_refs: ['private'] })), live: { isStreaming: true, streamingText: 's'.repeat(100000), pendingToolCalls: ['private'] } })
    expect(result.truncated).toBe(true)
    expect(result.messages.reduce((sum, row) => sum + String(row.content).length, 0)).toBeLessThanOrEqual(400000)
    expect(result.live.streamingText).toHaveLength(80000)
    expect(JSON.stringify(result)).not.toContain('private')
    const cards = missionSnapshot({ messages: [{ id: 'card', role: 'system', content: JSON.stringify({ kind: 'pr_decision', decision: 'on_review', ticketIds: [17], executionManifest: { secret: 'private' } }) }] })
    expect(cards.messages[0]).toMatchObject({ content: '', card: { decision: 'on_review', ticketIds: [17] } })
    expect(JSON.stringify(cards)).not.toContain('private')
  })
})
