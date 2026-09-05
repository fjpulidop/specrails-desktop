import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { createProjectRouter } from './project-router'
import { initDb, type DbInstance } from './db'
import { initDesktopDb } from './desktop-db'
import { writeBlueprintPair } from './blueprint-render'
import { mutateStore } from './ticket-store'
import { workspacePathFor } from './workspace-manager'
import { MilestoneProgressBroadcaster } from './milestone-progress'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { Blueprint } from './blueprint-types'

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

  it('milestone launch relays autoAdvance to the chain manager; PATCH /chains/:id flips it (D9)', async () => {
    const start = vi.fn(async () => ({ ok: true as const, status: 202 as const, chainId: 'c1', launched: [], pending: [] }))
    const setAutoAdvance = vi.fn(async (_id: string, on: boolean) => ({ ok: true as const, status: on ? 202 : 200, chain: { id: 'c1', autoAdvance: on } }))
    const ctx = makeContext(db, repo, { milestoneChains: { start, setAutoAdvance, listActive: () => [] } as never })
    const app = createApp(ctx)
    let res = await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({ mode: 'sequential', autoAdvance: false })
    expect(res.status).toBe(202)
    expect(start).toHaveBeenCalledWith(1, 'sequential', { autoAdvance: false })
    res = await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({})
    expect(start).toHaveBeenLastCalledWith(1, 'sequential', { autoAdvance: undefined })
    res = await request(app).post('/api/projects/proj-1/blueprint/milestones/1/launch').send({ autoAdvance: 'yes' })
    expect(res.status).toBe(400)

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
})
