import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { createProjectRouter } from './project-router'
import { initDb, type DbInstance } from './db'
import { initDesktopDb } from './desktop-db'
import { writeBlueprintPair } from './modules/builder/runtime/blueprint-render'
import { mutateStore } from './modules/specs/runtime/ticket-store'
import { workspacePathFor } from './workspace-manager'
import { MilestoneProgressBroadcaster } from './modules/builder/runtime/milestone-progress'
import { MilestoneChainManager } from './modules/builder/runtime/milestone-chain'
import { createChain, updateChain } from './modules/builder/runtime/milestone-chain-store'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { Blueprint } from './modules/builder/runtime/blueprint-types'

// GET /:projectId/blueprint now carries the server-derived milestone progress
// next to the blueprint (premium-milestone-progress).

function makeContext(db: DbInstance, projectPath: string, extra: Partial<ProjectContext> = {}): ProjectContext {
  return {
    project: { id: 'proj-1', slug: 'recipely', name: 'Recipely', path: projectPath, db_path: ':memory:', added_at: '', last_seen_at: '' },
    db,
    queueManager: { enqueue: vi.fn(), getJobs: vi.fn(() => []), isPaused: vi.fn(() => false), getActiveJobId: vi.fn(() => null), phasesForCommand: vi.fn(() => []) } as never,
    chatManager: { isActive: vi.fn(() => false) } as never,
    setupManager: {} as never,
    proposalManager: {} as never,
    specLauncherManager: {} as never,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as never,
    broadcast: vi.fn(),
    ...extra,
  } as ProjectContext
}

function createApp(ctx: ProjectContext) {
  const desktopDb = initDesktopDb(':memory:')
  const map = new Map([[ctx.project.id, ctx]])
  const registry = {
    desktopDb,
    getContext: vi.fn((id: string) => map.get(id)),
    getContextByPath: vi.fn(() => undefined),
    addProject: vi.fn(),
    removeProject: vi.fn(),
    touchProject: vi.fn(),
    listContexts: vi.fn(() => Array.from(map.values())),
  } as unknown as ProjectRegistry
  const app = express()
  app.use(express.json())
  app.use('/api/projects', createProjectRouter(registry))
  return app
}

function blueprint(): Blueprint {
  return {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'p', audience: 'a' },
    coreFlow: 'f', platform: 'web', stack: { language: 'ts', framework: 'react', db: 'sqlite' }, assumptions: [],
    milestones: [{ id: 'm1', title: 'Walking skeleton', goal: 'g', status: 'committed', plannedSpecs: [] }],
    specsComplete: true, m1Specs: [],
  }
}

describe('GET /:projectId/blueprint — progress payload', () => {
  let tmp: string
  let priorHome: string | undefined
  let db: DbInstance
  let repo: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-route-'))
    priorHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = tmp
    db = initDb(':memory:')
    repo = path.join(tmp, 'repo')
    fs.mkdirSync(path.join(repo, '.specrails'), { recursive: true })
  })
  afterEach(() => {
    if (priorHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = priorHome
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('404s for a project without a blueprint', async () => {
    const res = await request(createApp(makeContext(db, repo))).get('/api/projects/proj-1/blueprint')
    expect(res.status).toBe(404)
  })

  it('returns the blueprint plus live per-milestone progress', async () => {
    const ws = workspacePathFor('recipely')
    fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
    writeBlueprintPair(ws, blueprint())
    mutateStore(path.join(repo, '.specrails', 'local-tickets.json'), (s) => {
      s.tickets['1'] = { id: 1, title: 't', description: '', status: 'on_review', priority: 'medium', labels: ['M1'], assignee: null, prerequisites: [], metadata: {}, created_at: 'x', updated_at: 'x' } as never
      s.tickets['2'] = { id: 2, title: 't', description: '', status: 'todo', priority: 'medium', labels: ['M1'], assignee: null, prerequisites: [], metadata: {}, created_at: 'x', updated_at: 'x' } as never
    })
    const ctx = makeContext(db, repo, { railJobs: new Map(), railLoopRuns: new Map() })
    const res = await request(createApp(ctx)).get('/api/projects/proj-1/blueprint')
    expect(res.status).toBe(200)
    expect(res.body.blueprint.product.name).toBe('Recipely')
    expect(res.body.progress).toHaveLength(1)
    expect(res.body.progress[0]).toMatchObject({ id: 'm1', n: 1, state: 'committed', counts: { total: 2, onReview: 1, todo: 1, done: 0 } })
  })

  it('[spec:milestone-launch-chain/milestone-launch-is-a-server-owned-chain] milestone launch relays autoAdvance to the chain manager; PATCH /chains/:id flips it (D9)', async () => {
    const start = vi.fn(async () => ({ ok: true as const, status: 202 as const, chainId: 'c1', launched: [], pending: [] }))
    const setAutoAdvance = vi.fn(async (_id: string, on: boolean) => ({ ok: true as const, status: on ? 202 : 200, chain: { id: 'c1', autoAdvance: on } }))
    const ctx = makeContext(db, repo, { milestoneChains: { start, setAutoAdvance, listActive: () => [] } as never })
    const app = createApp(ctx)
    let res = await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({ mode: 'sequential', autoAdvance: false })
    expect(res.status).toBe(202)
    expect(res.body.mode).toBe('sequential')
    expect(start).toHaveBeenCalledWith(1, { autoAdvance: false })
    const engine = { provider: 'claude', model: 'sonnet', reasoningEffort: 'high' }
    res = await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({ engine })
    expect(res.status).toBe(202)
    expect(start).toHaveBeenLastCalledWith(1, { autoAdvance: undefined, engine })
    const calls = start.mock.calls.length
    for (const bad of [{ ...engine, provider: 'missing' }, { ...engine, model: 'wrong' }, { ...engine, reasoningEffort: 'wrong' }]) {
      expect((await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({ engine: bad })).status).toBe(400)
    }
    expect(start.mock.calls).toHaveLength(calls)
    res = await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({})
    // Omitted autoAdvance: the chain manager defaults it to ON.
    expect(start).toHaveBeenLastCalledWith(1, { autoAdvance: undefined })
    res = await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({ autoAdvance: 'yes' })
    expect(res.status).toBe(400)
    // The retired Parallel option is accepted from old clients and runs sequentially.
    res = await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({ mode: 'parallel', autoAdvance: true })
    expect(res.status).toBe(202)
    expect(res.body.mode).toBe('sequential')
    expect(start).toHaveBeenLastCalledWith(1, { autoAdvance: true })
    res = await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({ mode: 'waves' })
    expect(res.status).toBe(400)
    // The typed rail-limit guard is relayed for the UI to localize.
    start.mockResolvedValueOnce({ ok: false, status: 409, error: 'rail_limit_reached', chainId: 'c2' } as never)
    res = await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({})
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'rail_limit_reached', chainId: 'c2' })

    res = await request(app).patch('/api/projects/proj-1/blueprint/chains/c1').send({ autoAdvance: true })
    expect(res.status).toBe(202)
    expect(res.body.chain).toEqual({ id: 'c1', autoAdvance: true })
    expect(setAutoAdvance).toHaveBeenCalledWith('c1', true)
    res = await request(app).patch('/api/projects/proj-1/blueprint/chains/c1').send({ autoAdvance: false })
    expect(res.status).toBe(200)
    res = await request(app).patch('/api/projects/proj-1/blueprint/chains/c1').send({})
    expect(res.status).toBe(400)
    setAutoAdvance.mockResolvedValueOnce({ ok: false, status: 409, error: 'chain_terminal', detail: 'chain is cancelled' } as never)
    res = await request(app).patch('/api/projects/proj-1/blueprint/chains/c1').send({ autoAdvance: true })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'chain_terminal', detail: 'chain is cancelled' })
  })

  it('a paused chain carries its reconciled plan; Resume takes the recommended step (the spec delivered by hand is skipped)', async () => {
    const ws = workspacePathFor('recipely')
    fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
    writeBlueprintPair(ws, blueprint())
    const tickets = path.join(repo, '.specrails', 'local-tickets.json')
    mutateStore(tickets, (s) => {
      s.tickets['1'] = { id: 1, title: 'First', description: '', status: 'done', priority: 'medium', labels: ['M1'], assignee: null, prerequisites: [], metadata: {}, created_at: 'x', updated_at: 'x' } as never
      s.tickets['2'] = { id: 2, title: 'Second', description: '', status: 'todo', priority: 'medium', labels: ['M1'], assignee: null, prerequisites: [], metadata: {}, created_at: 'x', updated_at: 'x' } as never
    })
    const launch = vi.fn(async () => ({ ok: true as const, loopRunIds: ['r2'] }))
    const chains = new MilestoneChainManager(db, 'proj-1', {
      createRail: async () => ({ ok: true, railIndex: 4 }),
      assignTickets: async () => ({ ok: true }),
      launch,
      activeDeliveryForRail: () => null,
      getDelivery: () => null,
      branchExists: async () => true,
      readTickets: () => [
        { id: 1, status: 'done', labels: ['M1'], title: 'First' },
        { id: 2, status: 'todo', labels: ['M1'], title: 'Second' },
      ],
      readBlueprint: () => blueprint(),
      integrationBranch: async () => 'main',
      integrateDelivery: async () => ({ ok: true }),
      runState: () => null,
      broadcast: () => {},
    })
    createChain(db, { id: 'c1', milestoneN: 1, milestoneId: 'm1', mode: 'sequential', chunks: [[1], [2]], integrationBranch: 'main' })
    updateChain(db, 'c1', 'running', { status: 'paused', pauseReason: 'head_discarded', retryChunk: 0, nextChunk: 1, launched: [{ chunk: 1, railIndex: 3, ticketIds: [1], runIds: ['r1'], deliveryId: 'd1' }] })
    const app = createApp(makeContext(db, repo, { railJobs: new Map(), railLoopRuns: new Map(), milestoneChains: chains }))
    let res = await request(app).get('/api/projects/proj-1/blueprint')
    expect(res.status).toBe(200)
    expect(res.body.progress[0].state).toBe('paused')
    expect(res.body.progress[0].chain.plan.offers).toEqual([expect.objectContaining({ kind: 'next', ticketId: 2, title: 'Second', from: 'recommended' })])
    res = await request(app).post('/api/projects/proj-1/blueprint/chains/c1/resume').send({ from: 'bogus' })
    expect(res.status).toBe(400)
    res = await request(app).post('/api/projects/proj-1/blueprint/chains/c1/resume').send({ from: 'recommended' })
    expect(res.status).toBe(202)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(res.body.chain).toMatchObject({ status: 'running', nextChunk: 2 })
    expect(res.body.chain.launched.map((l: { ticketIds: number[] }) => l.ticketIds[0])).toEqual([1, 2])
  })

  it('commit-milestone invalidates the progress memo', async () => {
    const ws = workspacePathFor('recipely')
    fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
    const bp = blueprint()
    bp.milestones.push({ id: 'm2', title: 'Pantry', goal: 'g', status: 'planned', plannedSpecs: ['x'] })
    writeBlueprintPair(ws, bp)
    const invalidate = vi.fn()
    const ctx = makeContext(db, repo, {
      milestoneProgress: { invalidate } as unknown as MilestoneProgressBroadcaster,
    })
    const spec = {
      kind: 'feature', title: 'Add pantry items', shortSummary: 'Users add pantry items.',
      description: '## Problem Statement\nx\n\n## Proposed Solution\ny\n\n## Out of Scope\n- a\n- b\n\n## Technical Considerations\n- c\n- d\n\n## Estimated Complexity\nlow',
      acceptanceCriteria: ['a', 'b', 'c', 'd'], priority: 'medium', labels: ['pantry'],
    }
    const res = await request(createApp(ctx))
      .post('/api/projects/proj-1/blueprint/commit-milestone')
      .send({ milestoneId: 'm2', specsComplete: true, specs: [spec] })
    expect([201, 400]).toContain(res.status)
    if (res.status === 201) expect(invalidate).toHaveBeenCalled()
  })

  it('[spec:blueprint-generation-settings/project-scoped-generation-preference] GET/PUT milestone-engines reads, sets and clears "only for M<n>"', async () => {
    const ws = workspacePathFor('recipely')
    fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
    const bp = blueprint()
    bp.milestones.push({ id: 'm2', title: 'Pantry', goal: 'g', status: 'planned', plannedSpecs: [] })
    writeBlueprintPair(ws, bp)
    const schedule = vi.fn()
    const ctx = makeContext(db, repo, { milestoneProgress: { schedule } as unknown as MilestoneProgressBroadcaster })
    ctx.project.providers = ['claude', 'codex']
    const app = createApp(ctx)
    const url = '/api/projects/proj-1/blueprint/milestone-engines'
    expect((await request(app).get(url)).body).toEqual({ overrides: { m1: null, m2: null } })
    const engine = { provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' }
    let res = await request(app).put(url).send({ milestoneId: 'M2', engine })
    expect(res.status).toBe(200)
    expect(res.body.overrides.m2).toMatchObject({ engine })
    expect(schedule).toHaveBeenCalledTimes(1)
    for (const [body, status] of [
      [{ milestoneId: 'm9', engine }, 404],
      [{ milestoneId: 'two', engine }, 400],
      [{ milestoneId: 'm2' }, 400],
      [{ milestoneId: 'm2', engine: { ...engine, model: 'nope' } }, 400],
    ] as const) expect((await request(app).put(url).send(body)).status).toBe(status)
    expect((await request(app).get(url)).body.overrides.m2).toMatchObject({ engine })
    res = await request(app).put(url).send({ milestoneId: 'm2', engine: null })
    expect(res.body.overrides.m2).toBeNull()
  })

  it('milestone-engines 404s without a blueprint', async () => {
    const app = createApp(makeContext(db, repo))
    expect((await request(app).get('/api/projects/proj-1/blueprint/milestone-engines')).status).toBe(404)
    expect((await request(app).put('/api/projects/proj-1/blueprint/milestone-engines').send({ milestoneId: 'm2', engine: null })).status).toBe(404)
  })
})
