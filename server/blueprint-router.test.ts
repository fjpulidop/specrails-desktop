import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createBlueprintRouter } from './blueprint-router'
import type { BlueprintChatManager } from './blueprint-chat-manager'
import type { BlueprintCommitRunner } from './blueprint-commit'
import { initDesktopDb } from './desktop-db'
import type { DbInstance } from './db'
import { createBlueprintConversation, getBlueprintConversation } from './blueprint-store'

function makeApp(overrides: {
  manager?: Partial<BlueprintChatManager>
  runner?: Partial<BlueprintCommitRunner>
  db?: DbInstance
} = {}) {
  const db = overrides.db ?? initDesktopDb(':memory:')
  const manager = {
    isStreaming: vi.fn(() => false),
    sendMessage: vi.fn(async () => { /* noop */ }),
    abort: vi.fn(),
    ...overrides.manager,
  } as unknown as BlueprintChatManager
  const runner = {
    validate: vi.fn(() => ({ ok: true })),
    start: vi.fn(() => 'commit-1'),
    ...overrides.runner,
  } as unknown as BlueprintCommitRunner
  const app = express()
  app.use(express.json())
  app.use('/api/blueprint', createBlueprintRouter({ manager, desktopDb: db, runCommit: runner }))
  return { app, db, manager, runner }
}

afterEach(() => {
  delete process.env.SPECRAILS_PROJECT_BUILDER
})

describe('gating', () => {
  it('404s every route when SPECRAILS_PROJECT_BUILDER=false', async () => {
    process.env.SPECRAILS_PROJECT_BUILDER = 'false'
    const { app } = makeApp()
    const res = await request(app).get('/api/blueprint/conversations')
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/disabled/)
  })

  it('serves routes when the flag is unset (default on)', async () => {
    const { app } = makeApp()
    const res = await request(app).get('/api/blueprint/conversations')
    expect(res.status).toBe(200)
    expect(res.body.conversations).toEqual([])
  })
})

describe('conversations CRUD', () => {
  it('creates a conversation (default provider claude)', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/blueprint/conversations').send({})
    expect(res.status).toBe(201)
    expect(res.body.conversation.provider).toBe('claude')
  })

  it('falls back to claude on unknown provider', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/blueprint/conversations').send({ provider: 'bogus' })
    expect(res.status).toBe(201)
    expect(res.body.conversation.provider).toBe('claude')
  })

  it('rejects Kimi before creating or switching a Builder conversation', async () => {
    const { app, db } = makeApp()
    const create = await request(app)
      .post('/api/blueprint/conversations')
      .send({ provider: 'kimi' })
    expect(create.status).toBe(409)
    expect(create.body.error).toBe('provider_tool_policy_unsupported')

    const conv = createBlueprintConversation(db)
    const patch = await request(app)
      .patch(`/api/blueprint/conversations/${conv.id}`)
      .send({ provider: 'kimi' })
    expect(patch.status).toBe(409)
    expect(getBlueprintConversation(db, conv.id)?.provider).toBe('claude')
  })

  it('gets a conversation with messages; 404 unknown', async () => {
    const { app, db } = makeApp()
    const conv = createBlueprintConversation(db)
    const ok = await request(app).get(`/api/blueprint/conversations/${conv.id}`)
    expect(ok.status).toBe(200)
    expect(ok.body.messages).toEqual([])
    const missing = await request(app).get('/api/blueprint/conversations/nope')
    expect(missing.status).toBe(404)
  })

  it('patches title and validates model against the provider catalog', async () => {
    const { app, db } = makeApp()
    const conv = createBlueprintConversation(db)
    const bad = await request(app).patch(`/api/blueprint/conversations/${conv.id}`).send({ model: 'not-a-model' })
    expect(bad.status).toBe(400)
    const good = await request(app).patch(`/api/blueprint/conversations/${conv.id}`).send({ title: 'My app' })
    expect(good.status).toBe(200)
    expect(good.body.conversation.title).toBe('My app')
  })

  it('provider switch resets session and model', async () => {
    const { app, db } = makeApp()
    const conv = createBlueprintConversation(db)
    db.prepare('UPDATE blueprint_conversations SET session_id = ?, model = ? WHERE id = ?').run('sess', 'sonnet', conv.id)
    const res = await request(app).patch(`/api/blueprint/conversations/${conv.id}`).send({ provider: 'codex' })
    expect(res.status).toBe(200)
    const fresh = getBlueprintConversation(db, conv.id)
    expect(fresh?.provider).toBe('codex')
    expect(fresh?.session_id).toBeNull()
    expect(fresh?.model).toBeNull()
  })

  it('delete aborts a live turn and removes the row', async () => {
    const { app, db, manager } = makeApp()
    const conv = createBlueprintConversation(db)
    const res = await request(app).delete(`/api/blueprint/conversations/${conv.id}`)
    expect(res.status).toBe(200)
    expect(manager.abort).toHaveBeenCalledWith(conv.id)
    expect(getBlueprintConversation(db, conv.id)).toBeUndefined()
  })
})

describe('send / abort', () => {
  it('202 accepts and forwards the selected reasoning effort', async () => {
    const { app, db, manager } = makeApp()
    const conv = createBlueprintConversation(db)
    const res = await request(app)
      .post(`/api/blueprint/conversations/${conv.id}/send`)
      .send({ text: 'an app idea', reasoning_effort: 'high' })
    expect(res.status).toBe(202)
    expect(manager.sendMessage).toHaveBeenCalledWith(conv.id, 'an app idea', { model: undefined, reasoningEffort: 'high' })
  })

  it('400 on a reasoning effort outside the conversation provider catalog', async () => {
    const { app, db, manager } = makeApp()
    const conv = createBlueprintConversation(db)
    const res = await request(app)
      .post(`/api/blueprint/conversations/${conv.id}/send`)
      .send({ text: 'an app idea', reasoning_effort: 'turbo' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/reasoning effort/)
    expect(manager.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an existing Kimi conversation before dispatching to the manager', async () => {
    const { app, db, manager } = makeApp()
    const conv = createBlueprintConversation(db, { provider: 'kimi', model: 'k3' })
    const rejected = await request(app)
      .post(`/api/blueprint/conversations/${conv.id}/send`)
      .send({ text: 'an app idea', reasoning_effort: 'high' })
    expect(rejected.status).toBe(409)
    expect(rejected.body.error).toBe('provider_tool_policy_unsupported')
    expect(manager.sendMessage).not.toHaveBeenCalled()
  })

  it('400 on empty text, 409 while streaming, 404 unknown conversation', async () => {
    const { app, db } = makeApp({ manager: { isStreaming: vi.fn(() => true) } })
    const conv = createBlueprintConversation(db)
    const empty = await request(app).post(`/api/blueprint/conversations/${conv.id}/send`).send({ text: '  ' })
    expect(empty.status).toBe(400)
    const busy = await request(app).post(`/api/blueprint/conversations/${conv.id}/send`).send({ text: 'x' })
    expect(busy.status).toBe(409)
    const missing = await request(app).post('/api/blueprint/conversations/nope/send').send({ text: 'x' })
    expect(missing.status).toBe(404)
  })

  it('abort route delegates to the manager', async () => {
    const { app, db, manager } = makeApp()
    const conv = createBlueprintConversation(db)
    const res = await request(app).post(`/api/blueprint/conversations/${conv.id}/abort`)
    expect(res.status).toBe(200)
    expect(manager.abort).toHaveBeenCalledWith(conv.id)
  })
})

describe('models', () => {
  it('returns each provider model and effort catalog', async () => {
    const { app } = makeApp()
    const claude = await request(app).get('/api/blueprint/models?provider=claude')
    expect(claude.status).toBe(200)
    expect(claude.body.provider).toBe('claude')
    expect(Array.isArray(claude.body.models)).toBe(true)
    expect(typeof claude.body.defaultModel).toBe('string')
    expect(claude.body.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])

    const codex = await request(app).get('/api/blueprint/models?provider=codex')
    expect(codex.body.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

    const gemini = await request(app).get('/api/blueprint/models?provider=gemini')
    expect(gemini.body.efforts).toEqual([])

    const kimi = await request(app).get('/api/blueprint/models?provider=kimi&model=k3')
    expect(kimi.body).toMatchObject({
      provider: 'kimi',
      available: false,
      toolPolicy: null,
      models: [],
      defaultModel: null,
      efforts: [],
    })
  })
})

describe('commit', () => {
  it('400 with the named validation error', async () => {
    const { app } = makeApp({ runner: { validate: vi.fn(() => ({ ok: false as const, error: 'location_not_empty', detail: '/x' })) } })
    const res = await request(app).post('/api/blueprint/commit').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('location_not_empty')
    expect(res.body.detail).toBe('/x')
  })

  it('202 with commitId on acceptance', async () => {
    const { app, runner } = makeApp()
    const res = await request(app).post('/api/blueprint/commit').send({ name: 'x' })
    expect(res.status).toBe(202)
    expect(res.body.commitId).toBe('commit-1')
    expect(runner.start).toHaveBeenCalled()
  })
})

describe('durable snapshots + resume (harden-project-builder-snapshots)', () => {
  const bp = {
    blueprintVersion: 1,
    product: { name: 'WebTetris', pitch: 'p', audience: 'a' },
    coreFlow: 'flow', platform: 'web',
    stack: { language: 'ts', framework: 'vite', db: 'none' },
    assumptions: [], milestones: [{ id: 'm1', title: 't', goal: 'g', status: 'planned' as const, plannedSpecs: [] }],
    specsComplete: false, m1Specs: [],
  }

  it('GET /conversations?resumable=1 lists unfinished conversations with a snapshot summary', async () => {
    const { app, db } = makeApp()
    const { saveBlueprintSnapshot, addBlueprintMessage } = await import('./blueprint-store')
    const conv = createBlueprintConversation(db)
    addBlueprintMessage(db, { conversationId: conv.id, role: 'assistant', content: 'plan' })
    saveBlueprintSnapshot(db, conv.id, { blueprint: bp, rawBlueprint: bp })
    createBlueprintConversation(db) // empty bootstrap row — excluded
    const res = await request(app).get('/api/blueprint/conversations?resumable=1')
    expect(res.status).toBe(200)
    expect(res.body.conversations).toHaveLength(1)
    expect(res.body.conversations[0]).toEqual(expect.objectContaining({ id: conv.id, productName: 'WebTetris', dimensionsFilled: 5, hasSnapshot: true }))
    // The plain list is unchanged (both rows).
    const all = await request(app).get('/api/blueprint/conversations')
    expect(all.body.conversations).toHaveLength(2)
  })

  it('GET /conversations/:id rehydrates the transcript (empty rows hidden, raw hidden), the snapshot pair and its status', async () => {
    const { app, db } = makeApp()
    const { saveBlueprintSnapshot, addBlueprintMessage } = await import('./blueprint-store')
    const conv = createBlueprintConversation(db)
    addBlueprintMessage(db, { conversationId: conv.id, role: 'user', content: 'tetris' })
    addBlueprintMessage(db, { conversationId: conv.id, role: 'assistant', content: '', rawContent: 'raw' })
    addBlueprintMessage(db, { conversationId: conv.id, role: 'assistant', content: 'plan', rawContent: 'raw2' })
    saveBlueprintSnapshot(db, conv.id, { blueprint: bp, rawBlueprint: bp })
    const res = await request(app).get(`/api/blueprint/conversations/${conv.id}`)
    expect(res.status).toBe(200)
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual(['tetris', 'plan'])
    expect(res.body.messages[1].raw_content).toBeUndefined()
    expect(res.body.blueprint.product.name).toBe('WebTetris')
    expect(res.body.rawBlueprint.product.name).toBe('WebTetris')
    expect(res.body.snapshot).toEqual({ status: 'accepted', claimsComplete: false })
    expect(res.body.snapshotUpdatedAt).toBeTruthy()
  })

  it('GET /conversations/:id reports a pending rejection and, for a claimed-complete snapshot, the audit issues', async () => {
    const { app, db } = makeApp()
    const { saveBlueprintSnapshot, saveBlueprintSnapshotIssue } = await import('./blueprint-store')
    const conv = createBlueprintConversation(db)
    saveBlueprintSnapshotIssue(db, conv.id, { reason: 'truncated', detail: 'cut', at: 'now' })
    let res = await request(app).get(`/api/blueprint/conversations/${conv.id}`)
    expect(res.body.snapshot).toEqual({ status: 'rejected', reason: 'truncated', detail: 'cut' })
    expect(res.body.blueprint).toBeNull()

    const claimed = { ...bp, specsComplete: true, m1Specs: [{ kind: 'feature', title: 'x' }] }
    saveBlueprintSnapshot(db, conv.id, { blueprint: claimed as never, rawBlueprint: claimed })
    res = await request(app).get(`/api/blueprint/conversations/${conv.id}`)
    expect(res.body.snapshot.status).toBe('accepted')
    expect(res.body.snapshot.claimsComplete).toBe(true)
    expect(res.body.snapshot.qualityIssues.length).toBeGreaterThan(0)

    const none = createBlueprintConversation(db)
    res = await request(app).get(`/api/blueprint/conversations/${none.id}`)
    expect(res.body.snapshot).toEqual({ status: 'none' })
  })

  it('POST /conversations/:id/repair-snapshot → 202 with the kind, 409 on refusal, 404 unknown', async () => {
    const repairSnapshot = vi.fn(async () => ({ ok: true as const, kind: 'invalid_json' as const }))
    const { app, db } = makeApp({ manager: { repairSnapshot } as never })
    const conv = createBlueprintConversation(db)
    let res = await request(app).post(`/api/blueprint/conversations/${conv.id}/repair-snapshot`)
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ accepted: true, kind: 'invalid_json' })
    expect(repairSnapshot).toHaveBeenCalledWith(conv.id)

    repairSnapshot.mockResolvedValueOnce({ ok: false, reason: 'nothing_to_repair' } as never)
    res = await request(app).post(`/api/blueprint/conversations/${conv.id}/repair-snapshot`)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('nothing_to_repair')

    res = await request(app).post('/api/blueprint/conversations/missing/repair-snapshot')
    expect(res.status).toBe(404)
  })
})
