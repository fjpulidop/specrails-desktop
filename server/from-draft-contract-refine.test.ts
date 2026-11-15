import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

// Mock the runner module BEFORE the router pulls it in: these tests assert the
// SCHEDULING contract (which runner fires, with which args), not the spawn.
vi.mock('./modules/specs/runtime/contract-refine-runner', () => ({
  runContractRefine: vi.fn(async () => ({ ok: true })),
  runContractRefineForQuick: vi.fn(async () => ({ ok: true })),
}))

import { createProjectRouter } from './project-router'
import { runContractRefine, runContractRefineForQuick } from './modules/specs/runtime/contract-refine-runner'
import { initDb, createConversation, addMessage } from './db'
import { initDesktopDb } from './desktop-db'
import { resolveTicketStoragePath, mutateStore, readStore } from './modules/specs/runtime/ticket-store'
import { CONTRACT_LAYER_SEPARATOR } from './modules/conversations/runtime/explore-contract-refine'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { DbInstance } from './db'

function makeContext(db: DbInstance, projectPath: string, providers: string[] = ['claude']): ProjectContext {
  return {
    project: {
      id: 'proj-1', slug: 'proj', name: 'Test', path: projectPath, db_path: ':memory:',
      provider: providers[0], providers, added_at: '', last_seen_at: '',
    },
    db,
    queueManager: { enqueue: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), reorder: vi.fn(), getJobs: vi.fn(() => []), isPaused: vi.fn(() => false), getActiveJobId: vi.fn(() => null), phasesForCommand: vi.fn(() => []) } as any,
    chatManager: { isActive: vi.fn(() => false), sendMessage: vi.fn(), abort: vi.fn(), forgetSpecDraft: vi.fn(), forgetExploreLifecycle: vi.fn() } as any,
    setupManager: {} as any,
    proposalManager: {} as any,
    specLauncherManager: {} as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast: vi.fn(),
  } as unknown as ProjectContext
}

function makeRegistry(ctx: ProjectContext): ProjectRegistry {
  const desktopDb = initDesktopDb(':memory:')
  const map = new Map([[ctx.project.id, ctx]])
  return {
    desktopDb,
    getContext: vi.fn((id: string) => map.get(id)),
    getContextByPath: vi.fn(() => undefined),
    addProject: vi.fn() as any,
    removeProject: vi.fn(),
    touchProject: vi.fn(),
    listContexts: vi.fn(() => Array.from(map.values())),
  } as unknown as ProjectRegistry
}

function createApp(ctx: ProjectContext) {
  const router = createProjectRouter(makeRegistry(ctx))
  const app = express()
  app.use(express.json())
  app.use('/api/projects', router)
  return app
}

/** Let the route's process.nextTick(...) scheduling run. */
async function drainScheduling(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('from-draft agent-authored Contract Refine scheduling', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fromdraft-cr-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
    vi.mocked(runContractRefine).mockClear()
    vi.mocked(runContractRefineForQuick).mockClear()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('contractRefine:true on a conversation-less insert schedules the Quick-style refine with the inserted spec', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({
        title: 'Agent-authored spec',
        description: '## Problem Statement\nStuff.',
        acceptanceCriteria: ['It works'],
        contractRefine: true,
      })
    expect(res.status).toBe(201)
    await drainScheduling()

    expect(runContractRefineForQuick).toHaveBeenCalledTimes(1)
    const [deps, ticketId, title, description, model] = vi.mocked(runContractRefineForQuick).mock.calls[0]
    expect(deps).toMatchObject({ projectId: 'proj-1', projectSlug: 'proj', projectPath: tmpDir })
    expect(ticketId).toBe(res.body.ticket.id)
    expect(title).toBe('Agent-authored spec')
    // Seeded with the COMPOSED description (criteria folded in).
    expect(description).toContain('## Problem Statement')
    expect(description).toContain('## Acceptance Criteria')
    expect(model).toBeNull()
    // The Explore-resume path must NOT fire (no origin conversation).
    expect(runContractRefine).not.toHaveBeenCalled()
  })

  it('does NOT schedule anything when contractRefine is absent (Explore-client payloads stay byte-identical)', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Plain insert', description: 'Body' })
    expect(res.status).toBe(201)
    await drainScheduling()
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
    expect(runContractRefine).not.toHaveBeenCalled()
  })

  it('does NOT schedule when contractRefine is explicitly false (user opt-out)', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Opted out', description: 'Body', contractRefine: false })
    expect(res.status).toBe(201)
    await drainScheduling()
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
  })

  it('a conversation-backed commit keeps the Explore --resume path (Quick variant not fired)', async () => {
    createConversation(db, { id: 'conv-1', model: 'sonnet', kind: 'explore' })
    addMessage(db, { conversation_id: 'conv-1', role: 'user', content: 'idea' })
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'From Explore', description: 'Body', conversationId: 'conv-1', contractRefine: true })
    expect(res.status).toBe(201)
    await drainScheduling()
    expect(runContractRefine).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runContractRefine).mock.calls[0][1]).toBe('conv-1')
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
  })

  it('treats a NULL conversation provider as the Kimi project primary and does not schedule Contract Refine', async () => {
    const kimiCtx = makeContext(db, tmpDir, ['kimi'])
    createConversation(db, { id: 'conv-kimi-primary', model: 'k3', kind: 'explore', provider: null })
    const app = createApp(kimiCtx)

    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({
        title: 'Kimi Explore spec',
        description: 'Body',
        conversationId: 'conv-kimi-primary',
        contractRefine: true,
      })

    expect(res.status).toBe(201)
    await drainScheduling()
    expect(runContractRefine).not.toHaveBeenCalled()
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
  })

  it('schedules enrichment with Codex when it is the project provider', async () => {
    const codexCtx = makeContext(db, tmpDir, ['codex'])
    const app = createApp(codexCtx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Codex project', description: 'Body', contractRefine: true })
    expect(res.status).toBe(201)
    await drainScheduling()
    expect(runContractRefineForQuick).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'codex' }), res.body.ticket.id, 'Codex project', 'Body', null,
    )
    expect(runContractRefine).not.toHaveBeenCalled()
  })
})

describe('from-draft mission provider propagation', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext
  let pinProvider: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fromdraft-pin-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir, ['claude', 'codex', 'kimi'])
    pinProvider = vi.fn()
    ;(ctx as unknown as { specTriage: unknown }).specTriage = { pinProvider }
    vi.mocked(runContractRefine).mockClear()
    vi.mocked(runContractRefineForQuick).mockClear()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const ticketCount = () => Object.keys(readStore(resolveTicketStoragePath(tmpDir)).tickets).length

  it('[spec:spec-creation-provider-affinity/mission-provider-governs-derived-ai-steps] pins the mission provider for triage before the ticket broadcast and refines with it, not the Claude primary', async () => {
    const res = await request(createApp(ctx))
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Codex mission spec', description: 'Body', contractRefine: true, agentProvider: 'codex' })
    expect(res.status).toBe(201)
    await drainScheduling()

    expect(pinProvider).toHaveBeenCalledWith(res.body.ticket.id, 'codex')
    const created = vi.mocked(ctx.broadcast).mock.calls.findIndex(([m]) => (m as { type: string }).type === 'ticket_created')
    expect(pinProvider.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ctx.broadcast).mock.invocationCallOrder[created])
    expect(runContractRefineForQuick).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'codex' }), res.body.ticket.id, 'Codex mission spec', 'Body', null,
    )
  })

  it('[spec:spec-creation-provider-affinity/mission-provider-governs-derived-ai-steps] pins the origin conversation provider of an Explore commit', async () => {
    createConversation(db, { id: 'conv-codex', model: 'gpt-5', kind: 'explore', provider: 'codex' })
    const res = await request(createApp(ctx))
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Explore codex', description: 'Body', conversationId: 'conv-codex', contractRefine: true })
    expect(res.status).toBe(201)
    await drainScheduling()
    expect(pinProvider).toHaveBeenCalledWith(res.body.ticket.id, 'codex')
    expect(vi.mocked(runContractRefine).mock.calls[0][0]).toMatchObject({ providerId: 'codex' })
  })

  it('[spec:spec-creation-provider-affinity/non-mission-creation-unchanged] pins nothing without a mission context (external MCP client, no agentProvider)', async () => {
    const res = await request(createApp(ctx))
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'External', description: 'Body', contractRefine: true })
    expect(res.status).toBe(201)
    await drainScheduling()
    expect(pinProvider).not.toHaveBeenCalled()
    expect(runContractRefineForQuick).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'claude' }), res.body.ticket.id, 'External', 'Body', null,
    )
  })

  it('[spec:spec-creation-provider-affinity/no-silent-provider-fallback] does not pin a provider that is not installed and runs no refine on another provider', async () => {
    const res = await request(createApp(ctx))
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Ghost provider', description: 'Body', contractRefine: true, agentProvider: 'gemini' })
    expect(res.status).toBe(201)
    await drainScheduling()
    expect(pinProvider).not.toHaveBeenCalled()
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
    expect(ticketCount()).toBe(1)
  })

  it('[spec:spec-creation-provider-affinity/saved-spec-survives-enrichment-failure] keeps the single saved spec and reports the unsupported contract step with its provider', async () => {
    const res = await request(createApp(ctx))
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Kimi mission spec', description: 'Body', contractRefine: true, agentProvider: 'kimi' })
    expect(res.status).toBe(201)
    await drainScheduling()

    expect(pinProvider).toHaveBeenCalledWith(res.body.ticket.id, 'kimi')
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
    expect(runContractRefine).not.toHaveBeenCalled()
    expect(ticketCount()).toBe(1)
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'explore.contract_refine_failed', provider: 'kimi', ticketId: res.body.ticket.id, reason: 'provider-unsupported',
    }))
  })

  it('[spec:spec-creation-provider-affinity/provider-fixed-at-operation-start] keeps concurrent missions with different providers apart', async () => {
    const app = createApp(ctx)
    const [a, b] = await Promise.all([
      request(app).post('/api/projects/proj-1/tickets/from-draft').send({ title: 'A', description: 'a', contractRefine: true, agentProvider: 'codex' }),
      request(app).post('/api/projects/proj-1/tickets/from-draft').send({ title: 'B', description: 'b', contractRefine: true, agentProvider: 'claude' }),
    ])
    await drainScheduling()
    expect(pinProvider).toHaveBeenCalledWith(a.body.ticket.id, 'codex')
    expect(pinProvider).toHaveBeenCalledWith(b.body.ticket.id, 'claude')
    const providerByTicket = Object.fromEntries(vi.mocked(runContractRefineForQuick).mock.calls.map(([deps, id]) => [id, deps.providerId]))
    expect(providerByTicket).toEqual({ [a.body.ticket.id]: 'codex', [b.body.ticket.id]: 'claude' })
  })
})

describe('contract-refine retry endpoint — quick fallback for origin-less tickets', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-cr-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
    vi.mocked(runContractRefine).mockClear()
    vi.mocked(runContractRefineForQuick).mockClear()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE
  })

  function seedTicket(opts: { description: string; originConversationId?: string | null; title?: string }): number {
    const filePath = resolveTicketStoragePath(tmpDir)
    let id = 0
    mutateStore(filePath, (s) => {
      id = s.next_id++
      s.tickets[String(id)] = {
        id,
        title: opts.title ?? 'Seed',
        description: opts.description,
        status: 'todo',
        priority: 'medium',
        labels: [],
        assignee: null,
        prerequisites: [],
        metadata: {},
        comments: [],
        origin_conversation_id: opts.originConversationId ?? null,
        is_epic: false,
        parent_epic_id: null,
        execution_order: null,
        short_summary: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        created_by: 'manual',
        source: 'manual',
      } as any
    })
    return id
  }

  it.each(['claude', 'codex'])('202 + %s refine seeded with the user body (prior Contract Layer stripped)', async (provider) => {
    const userBody = '## Problem Statement\nReal body.'
    const id = seedTicket({
      title: 'Agent spec',
      description: `${userBody}${CONTRACT_LAYER_SEPARATOR}### Naming Contract\n\nstale layer`,
    })
    const app = createApp(makeContext(db, tmpDir, [provider]))
    const res = await request(app).post(`/api/projects/proj-1/tickets/${id}/contract-refine`).send({})
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ scheduled: true, mode: 'quick' })
    await drainScheduling()

    expect(runContractRefineForQuick).toHaveBeenCalledTimes(1)
    const [deps, ticketId, title, seed, model] = vi.mocked(runContractRefineForQuick).mock.calls[0]
    expect(deps.providerId).toBe(provider)
    expect(ticketId).toBe(id)
    expect(title).toBe('Agent spec')
    expect(seed).toBe(userBody)
    expect(seed).not.toContain('Naming Contract')
    expect(model).toBeNull()
    expect(runContractRefine).not.toHaveBeenCalled()
  })

  it('[spec:spec-creation-provider-affinity/no-silent-provider-fallback] retry honours an explicit provider over the Claude primary and never runs another', async () => {
    const id = seedTicket({ description: 'body' })
    const app = createApp(makeContext(db, tmpDir, ['claude', 'codex']))
    const res = await request(app).post(`/api/projects/proj-1/tickets/${id}/contract-refine`).send({ provider: 'codex' })
    expect(res.status).toBe(202)
    await drainScheduling()
    expect(vi.mocked(runContractRefineForQuick).mock.calls.map(([deps]) => deps.providerId)).toEqual(['codex'])
    expect(runContractRefine).not.toHaveBeenCalled()
  })

  it('[spec:spec-creation-provider-affinity/no-silent-provider-fallback] retry with an unsupported provider is rejected and schedules nothing', async () => {
    const id = seedTicket({ description: 'body' })
    const app = createApp(makeContext(db, tmpDir, ['claude', 'kimi']))
    const res = await request(app).post(`/api/projects/proj-1/tickets/${id}/contract-refine`).send({ provider: 'kimi' })
    expect(res.status).toBe(409)
    await drainScheduling()
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
    expect(runContractRefine).not.toHaveBeenCalled()
  })

  it('keeps the Explore --resume path when the ticket has an origin conversation', async () => {
    const id = seedTicket({ description: 'body', originConversationId: 'conv-9' })
    createConversation(db, { id: 'conv-9', model: 'sonnet', kind: 'explore', provider: null })
    const app = createApp(ctx)
    const res = await request(app).post(`/api/projects/proj-1/tickets/${id}/contract-refine`).send({})
    expect(res.status).toBe(202)
    await drainScheduling()
    expect(runContractRefine).toHaveBeenCalledTimes(1)
    const [deps, convoId, ticketId] = vi.mocked(runContractRefine).mock.calls[0]
    expect((deps as { ignoreConversationScope?: boolean }).ignoreConversationScope).toBe(true)
    expect(convoId).toBe('conv-9')
    expect(ticketId).toBe(id)
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
  })

  it('rejects explicit Kimi refine in a Claude-primary mixed project before scheduling either runner', async () => {
    ctx = makeContext(db, tmpDir, ['claude', 'kimi'])
    const id = seedTicket({ description: 'body' })
    const app = createApp(ctx)

    const res = await request(app)
      .post(`/api/projects/proj-1/tickets/${id}/contract-refine`)
      .send({ provider: 'kimi' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('contract_refine_unsupported_for_kimi')
    await drainScheduling()
    expect(runContractRefine).not.toHaveBeenCalled()
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
  })

  it('rejects a Kimi-origin retry in a Claude-primary mixed project before scheduling either runner', async () => {
    ctx = makeContext(db, tmpDir, ['claude', 'kimi'])
    createConversation(db, {
      id: 'conv-kimi',
      model: 'k3',
      kind: 'explore',
      provider: 'kimi',
    })
    const id = seedTicket({ description: 'body', originConversationId: 'conv-kimi' })
    const app = createApp(ctx)

    const res = await request(app)
      .post(`/api/projects/proj-1/tickets/${id}/contract-refine`)
      .send({})

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('contract_refine_unsupported_for_kimi')
    await drainScheduling()
    expect(runContractRefine).not.toHaveBeenCalled()
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
  })

  it('409 + nothing scheduled when the kill switch is active', async () => {
    process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE = '0'
    const id = seedTicket({ description: 'body' })
    const app = createApp(ctx)
    const res = await request(app).post(`/api/projects/proj-1/tickets/${id}/contract-refine`).send({})
    expect(res.status).toBe(409)
    await drainScheduling()
    expect(runContractRefineForQuick).not.toHaveBeenCalled()
    expect(runContractRefine).not.toHaveBeenCalled()
  })

  it('404 for an unknown ticket', async () => {
    const app = createApp(ctx)
    const res = await request(app).post('/api/projects/proj-1/tickets/999/contract-refine').send({})
    expect(res.status).toBe(404)
  })
})
