import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { Router, type Express } from 'express'
import request from 'supertest'
import { initDesktopDb } from './desktop-db'
import type { DbInstance } from './db'
import { createLoop, publishLoop } from './loops-store'
import { registerLoopRunRoutes } from './project-router-loop-runs'
import type { ProjectRoutesDeps } from './project-router-helpers'
import type { LoopGraph } from './loop-graph'

function graphWith(prompt: string): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt } },
      { id: 'e', type: 'end', position: { x: 0, y: 2 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'ai' },
      { id: 'e2', source: 'ai', target: 'e' },
    ],
    config: { maxIterations: 5, timeoutMinutes: 20 },
  }
}

let desktopDb: DbInstance
let run: ReturnType<typeof vi.fn>

function buildApp(project: { providers: string[]; provider: string }): Express {
  run = vi.fn().mockResolvedValue({ runId: 'rid', outcome: 'success', iterations: 1, totalCostUsd: 0 })
  const app = express()
  app.use(express.json())
  const router = Router()
  const ctx = () => ({
    desktopDb,
    project: { id: 'p1', slug: 's1', path: '/repo', provider: project.provider, providers: project.providers },
    loopRunManager: { run, cancel: vi.fn() },
    onLoopRunFinished: vi.fn(),
  })
  registerLoopRunRoutes({ router, ctx } as unknown as ProjectRoutesDeps)
  app.use('/api/projects', router)
  return app
}

beforeEach(() => {
  delete process.env.SPECRAILS_LOOPS_SECTION
  desktopDb = initDesktopDb(':memory:')
})

function publish(id: string, prompt = '{{cmd:verify}}'): string {
  const loop = createLoop(desktopDb, { id, name: 'CI Watch', graph: graphWith(prompt) })
  publishLoop(desktopDb, loop.id)
  return loop.id
}

describe('project-router standalone loop runs', () => {
  it('launches a published ticket-less loop with no rail and no ticket', async () => {
    const id = publish('ci-watch')
    const res = await request(buildApp({ provider: 'claude', providers: ['claude'] }))
      .post('/api/projects/p1/loop-runs').send({ loopId: id })
    expect(res.status).toBe(202)
    expect(res.body.loopRunId).toBeTruthy()
    expect(run).toHaveBeenCalledTimes(1)
    const arg = run.mock.calls[0][0] as { railIndex: unknown; ticketId: unknown }
    expect(arg.railIndex).toBeNull()
    expect(arg.ticketId).toBeNull()
  })

  it('400s an unpublished loop', async () => {
    createLoop(desktopDb, { id: 'draft', name: 'D', graph: graphWith('{{cmd:verify}}') })
    const res = await request(buildApp({ provider: 'claude', providers: ['claude'] }))
      .post('/api/projects/p1/loop-runs').send({ loopId: 'draft' })
    expect(res.status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  it('404s an unknown loop and 400s a missing loopId', async () => {
    const app = buildApp({ provider: 'claude', providers: ['claude'] })
    expect((await request(app).post('/api/projects/p1/loop-runs').send({ loopId: 'ghost' })).status).toBe(404)
    expect((await request(app).post('/api/projects/p1/loop-runs').send({})).status).toBe(400)
  })

  it('rejects a claude-only loop on a non-claude project', async () => {
    const id = publish('ultra', '{{cmd:ultracode}}')
    const res = await request(buildApp({ provider: 'codex', providers: ['codex'] }))
      .post('/api/projects/p1/loop-runs').send({ loopId: id })
    expect(res.status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  it('defaults to the provider default model when none is given', async () => {
    const id = publish('ci-watch')
    const res = await request(buildApp({ provider: 'claude', providers: ['claude'] }))
      .post('/api/projects/p1/loop-runs').send({ loopId: id })
    expect(res.status).toBe(202)
    expect((run.mock.calls[0][0] as { model: string }).model).toBe('sonnet')
  })

  it('passes a valid explicit model through to the run', async () => {
    const id = publish('ci-watch')
    const res = await request(buildApp({ provider: 'claude', providers: ['claude'] }))
      .post('/api/projects/p1/loop-runs').send({ loopId: id, model: 'opus' })
    expect(res.status).toBe(202)
    expect((run.mock.calls[0][0] as { model: string }).model).toBe('opus')
  })

  it('400s a model that is not in the provider catalog', async () => {
    const id = publish('ci-watch')
    const res = await request(buildApp({ provider: 'claude', providers: ['claude'] }))
      .post('/api/projects/p1/loop-runs').send({ loopId: id, model: 'gpt-5.5' }) // codex model, not claude
    expect(res.status).toBe(400)
    expect(res.body.allowed).toBeTruthy()
    expect(run).not.toHaveBeenCalled()
  })

  it('404s when the Loops section is disabled', async () => {
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    const id = publish('ci')
    const res = await request(buildApp({ provider: 'claude', providers: ['claude'] }))
      .post('/api/projects/p1/loop-runs').send({ loopId: id })
    expect(res.status).toBe(404)
  })
})

describe('project-router GET /loop-runs/:id', () => {
  it('returns a loop run scoped to the project, 404s unknown / cross-project', async () => {
    const { initDb } = await import('./db')
    const { createLoopRun } = await import('./loop-runs-store')
    const db = initDb(':memory:')
    createLoopRun(db, { id: 'run-1', projectId: 'p1', loopId: 'factory:implement', loopName: 'Implement', railIndex: 0, iterationLimit: 12, startedAt: new Date(1000).toISOString() })

    const app = express()
    app.use(express.json())
    const router = Router()
    const ctx = () => ({ db, desktopDb, project: { id: 'p1', slug: 's1', path: '/repo', provider: 'claude', providers: ['claude'] }, loopRunManager: { run: vi.fn(), cancel: vi.fn() }, onLoopRunFinished: vi.fn() })
    registerLoopRunRoutes({ router, ctx } as unknown as ProjectRoutesDeps)
    app.use('/api/projects', router)

    const ok = await request(app).get('/api/projects/p1/loop-runs/run-1')
    expect(ok.status).toBe(200)
    expect(ok.body.loopRun).toMatchObject({ id: 'run-1', loop_id: 'factory:implement', loop_name: 'Implement' })

    expect((await request(app).get('/api/projects/p1/loop-runs/nope')).status).toBe(404)
  })

  it('404s the whole loop-runs surface when Loops are disabled', async () => {
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    const res = await request(buildApp({ provider: 'claude', providers: ['claude'] })).get('/api/projects/p1/loop-runs/x')
    expect(res.status).toBe(404)
    delete process.env.SPECRAILS_LOOPS_SECTION
  })
})
