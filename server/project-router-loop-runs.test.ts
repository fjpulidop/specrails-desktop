import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { Router, type Express } from 'express'
import request from 'supertest'
import { initDesktopDb } from './desktop-db'
import { initDb, type DbInstance } from './db'
import { createLoopRun } from './modules/loops/runtime/loop-runs-store'
import { createLoop, publishLoop } from './modules/loops/runtime/loops-store'
import { registerLoopRunRoutes } from './project-router-loop-runs'
import type { ProjectRoutesDeps } from './project-router-helpers'
import type { LoopGraph } from './modules/loops/runtime/loop-graph'

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

function buildApp(project: { providers: string[]; provider: string; repositories?: import('./project-repositories').ProjectRepository[] }, extra: Record<string, unknown> = {}): Express {
  run = vi.fn().mockResolvedValue({ runId: 'rid', outcome: 'success', iterations: 1, totalCostUsd: 0 })
  const app = express()
  app.use(express.json())
  const router = Router()
  const ctx = () => ({
    desktopDb,
    project: { id: 'p1', slug: 's1', path: '/repo', repositories: project.repositories, provider: project.provider, providers: project.providers },
    loopRunManager: { run, cancel: vi.fn() },
    onLoopRunFinished: vi.fn(),
    ...extra,
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

  it('freezes selected registered workspace paths and rejects parent scope before spawning', async () => {
    const id = publish('workspace-loop')
    const app = buildApp({ provider: 'claude', providers: ['claude'], repositories: [{ id: 'primary-p1', projectId: 'p1', name: 'Skills', path: '/repo', kind: 'folder', isPrimary: true, integrationBranch: null, addedAt: '', workspacePaths: ['/repo/studio', '/repo/service'] }] })
    const invalid = await request(app).post('/api/projects/p1/loop-runs').send({ loopId: id, workspaceSelection: { 'primary-p1': ['/repo'] } })
    expect(invalid.status).toBe(400)
    expect(run).not.toHaveBeenCalled()
    const valid = await request(app).post('/api/projects/p1/loop-runs').send({ loopId: id, workspaceSelection: { 'primary-p1': ['studio'] } })
    expect(valid.status).toBe(202)
    expect(run.mock.calls[0][0]).toMatchObject({ workspacePaths: ['/repo/studio'] })
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

  it.each([true, false])('gates a {{cmd:freestyle}} loop on the project provider capability (codex freestyle=%s)', async (capable) => {
    const { getAdapter } = await import('./providers/registry')
    const capabilities = getAdapter('codex').capabilities
    capabilities.freestyle = capable
    try {
      const id = publish('freestyle', '{{cmd:freestyle}}')
      const res = await request(buildApp({ provider: 'codex', providers: ['codex'] }))
        .post('/api/projects/p1/loop-runs').send({ loopId: id })
      expect(res.status).toBe(capable ? 202 : 400)
      if (capable) expect(run).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex' }))
      else expect(run).not.toHaveBeenCalled()
    } finally { capabilities.freestyle = true }
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

  it('accepts Kimi effort for K3 and rejects it for other Kimi models', async () => {
    const id = publish('kimi-loop', 'Inspect the repository')
    const app = buildApp({ provider: 'kimi', providers: ['kimi'] })
    const accepted = await request(app)
      .post('/api/projects/p1/loop-runs')
      .send({ loopId: id, model: 'k3', reasoning_effort: 'max' })
    expect(accepted.status).toBe(202)
    expect((run.mock.calls[0][0] as { effort: string }).effort).toBe('max')

    run.mockClear()
    const rejected = await request(app)
      .post('/api/projects/p1/loop-runs')
      .send({ loopId: id, model: 'kimi-for-coding', reasoning_effort: 'max' })
    expect(rejected.status).toBe(400)
    expect(rejected.body.allowed).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it('passes a per-launch per-run soft cap through, and omits it when absent or malformed (CD5)', async () => {
    const id = publish('capped-loop')
    const launch = async (body: Record<string, unknown>) => {
      run.mockClear()
      const res = await request(buildApp({ provider: 'claude', providers: ['claude'] })).post('/api/projects/p1/loop-runs').send({ loopId: id, ...body })
      expect(res.status).toBe(202)
      return run.mock.calls[0][0] as Record<string, unknown>
    }
    expect(await launch({ runCapUsd: 3.5 })).toMatchObject({ runCapUsd: 3.5 })
    expect(await launch({ runCapUsd: 0 })).toMatchObject({ runCapUsd: 0 }) // 0 waives the default for this run
    expect(await launch({})).not.toHaveProperty('runCapUsd')
    expect(await launch({ runCapUsd: -1 })).not.toHaveProperty('runCapUsd')
    expect(await launch({ runCapUsd: '5' })).not.toHaveProperty('runCapUsd')
  })

  it('preserves a safe custom Kimi alias exactly and omits effort', async () => {
    const id = publish('kimi-custom-model', 'Inspect the repository')
    const customAlias = 'moonshot-team/private-coder:v2'
    const res = await request(buildApp({ provider: 'kimi', providers: ['kimi'] }))
      .post('/api/projects/p1/loop-runs')
      .send({ loopId: id, model: customAlias })

    expect(res.status).toBe(202)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toMatchObject({
      provider: 'kimi',
      model: customAlias,
      effort: undefined,
    })
  })

  it('rejects effort and unsafe flag-like values for a custom Kimi alias', async () => {
    const id = publish('kimi-custom-model-invalid', 'Inspect the repository')
    const customAlias = 'moonshot-team/private-coder:v2'

    const withEffort = await request(buildApp({ provider: 'kimi', providers: ['kimi'] }))
      .post('/api/projects/p1/loop-runs')
      .send({ loopId: id, model: customAlias, reasoning_effort: 'max' })
    expect(withEffort.status).toBe(400)
    expect(withEffort.body.allowed).toEqual([])
    expect(run).not.toHaveBeenCalled()

    const unsafe = await request(buildApp({ provider: 'kimi', providers: ['kimi'] }))
      .post('/api/projects/p1/loop-runs')
      .send({ loopId: id, model: '--yolo' })
    expect(unsafe.status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  it('409s a Kimi loop with a Decider because Kimi headless cannot enforce read-only', async () => {
    const graph = graphWith('Inspect the repository')
    graph.nodes.splice(2, 0, {
      id: 'd',
      type: 'decider',
      position: { x: 0, y: 2 },
      data: { goal: 'done' },
    })
    graph.edges = [
      { id: 'e1', source: 's', target: 'ai' },
      { id: 'e2', source: 'ai', target: 'd' },
      { id: 'e3', source: 'd', target: 'e', branch: 'stop' },
      { id: 'e4', source: 'd', target: 'ai', branch: 'continue' },
    ]
    const loop = createLoop(desktopDb, { id: 'kimi-decider', name: 'Kimi Decider', graph })
    publishLoop(desktopDb, loop.id)

    const res = await request(buildApp({ provider: 'kimi', providers: ['kimi'] }))
      .post('/api/projects/p1/loop-runs')
      .send({ loopId: loop.id })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'provider_tool_policy_unsupported',
      provider: 'kimi',
      requiredPolicy: 'read-only',
    })
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
    const { createLoopRun } = await import('./modules/loops/runtime/loop-runs-store')
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

  it('serializes unavailable Kimi loop usage as null instead of zero', async () => {
    const { initDb } = await import('./db')
    const { createLoopRun } = await import('./modules/loops/runtime/loop-runs-store')
    const db = initDb(':memory:')
    createLoopRun(db, {
      id: 'run-kimi',
      projectId: 'p1',
      loopId: 'kimi-loop',
      provider: 'kimi',
      model: 'k3',
      iterationLimit: 1,
      startedAt: new Date(1000).toISOString(),
    })

    const app = express()
    app.use(express.json())
    const router = Router()
    const ctx = () => ({
      db,
      desktopDb,
      project: { id: 'p1', slug: 's1', path: '/repo', provider: 'kimi', providers: ['kimi'] },
      loopRunManager: { run: vi.fn(), cancel: vi.fn() },
      onLoopRunFinished: vi.fn(),
    })
    registerLoopRunRoutes({ router, ctx } as unknown as ProjectRoutesDeps)
    app.use('/api/projects', router)

    const res = await request(app).get('/api/projects/p1/loop-runs/run-kimi')
    expect(res.status).toBe(200)
    expect(res.body.loopRun).toMatchObject({
      id: 'run-kimi',
      usage_available: false,
      total_cost_usd: null,
      total_tokens: null,
    })
  })

  it('404s the whole loop-runs surface when Loops are disabled', async () => {
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    const res = await request(buildApp({ provider: 'claude', providers: ['claude'] })).get('/api/projects/p1/loop-runs/x')
    expect(res.status).toBe(404)
    delete process.env.SPECRAILS_LOOPS_SECTION
  })
})

describe('loop runs — daily budget guard (rail-loop-budget-guard)', () => {
  const rejection = { error: 'daily_budget_exceeded', scope: 'project', budgetUsd: 1, spentUsd: 2, resetsAt: '2026-10-22T00:00:00.000Z', detail: 'over', action: 'raise' }

  it('409s a standalone loop run while the daily budget is exhausted and spawns nothing', async () => {
    const id = publish('budget-loop')
    const res = await request(buildApp({ provider: 'claude', providers: ['claude'] }, { dailyBudgetRejection: () => rejection }))
      .post('/api/projects/p1/loop-runs').send({ loopId: id })
    expect(res.status).toBe(409)
    expect(res.body).toEqual(rejection)
    expect(run).not.toHaveBeenCalled()
  })

  function resumeApp(manager: Record<string, unknown>, gate: () => unknown = () => null) {
    const db = initDb(':memory:')
    createLoopRun(db, { id: 'paused-run', projectId: 'p1', loopId: 'loop-1', ticketIds: [], provider: 'claude', model: 'sonnet', iterationLimit: 3, startedAt: '2026-10-21T08:00:00Z' })
    const app = express()
    app.use(express.json())
    const router = Router()
    registerLoopRunRoutes({ router, ctx: () => ({ db, desktopDb, project: { id: 'p1', slug: 's1', path: '/repo' }, loopRunManager: manager, dailyBudgetRejection: gate, onLoopRunFinished: vi.fn() }) } as unknown as ProjectRoutesDeps)
    app.use('/api/projects', router)
    return app
  }

  it('resumes a budget_paused run of either engine in place once the budget allows it', async () => {
    const resumeBudgetPause = vi.fn().mockReturnValue({ status: 'resumed' })
    const res = await request(resumeApp({ budgetPause: () => rejection, resumeBudgetPause })).post('/api/projects/p1/loop-runs/paused-run/resume').send({})
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ loopRunId: 'paused-run', resumed: true })
    expect(resumeBudgetPause).toHaveBeenCalledWith('paused-run', undefined)
  })

  it('passes the person\'s answer to a per-run soft cap: ignore, or raise to a positive amount (CD5)', async () => {
    const resumeBudgetPause = vi.fn().mockReturnValue({ status: 'resumed' })
    const app = resumeApp({ budgetPause: () => rejection, resumeBudgetPause })
    await request(app).post('/api/projects/p1/loop-runs/paused-run/resume').send({ runCap: 'ignore' })
    expect(resumeBudgetPause).toHaveBeenLastCalledWith('paused-run', { ignore: true })
    await request(app).post('/api/projects/p1/loop-runs/paused-run/resume').send({ runCapUsd: 8.5 })
    expect(resumeBudgetPause).toHaveBeenLastCalledWith('paused-run', { raiseTo: 8.5 })
    for (const bad of [{ runCapUsd: 0 }, { runCapUsd: -2 }, { runCapUsd: '8' }, { runCap: 'raise' }]) {
      await request(app).post('/api/projects/p1/loop-runs/paused-run/resume').send(bad)
      expect(resumeBudgetPause).toHaveBeenLastCalledWith('paused-run', undefined)
    }
  })

  it('a run paused at its per-run cap answers 409 with the run period until the person chooses', async () => {
    const runRejection = { ...rejection, period: 'run', resetsAt: null }
    const resumeBudgetPause = vi.fn().mockReturnValue({ status: 'over_budget', rejection: runRejection })
    const res = await request(resumeApp({ budgetPause: () => runRejection, resumeBudgetPause })).post('/api/projects/p1/loop-runs/paused-run/resume').send({})
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'daily_budget_exceeded', period: 'run', resetsAt: null })
  })

  it('keeps a budget_paused run paused and 409s while still over budget', async () => {
    const resumeBudgetPause = vi.fn().mockReturnValue({ status: 'over_budget', rejection })
    const res = await request(resumeApp({ budgetPause: () => rejection, resumeBudgetPause })).post('/api/projects/p1/loop-runs/paused-run/resume').send({})
    expect(res.status).toBe(409)
    expect(res.body).toEqual(rejection)
  })

  it('409s continuing a paused Core workflow while over budget, before probing Core', async () => {
    const beginDefinitionResume = vi.fn()
    const app = resumeApp({ budgetPause: () => null, beginDefinitionResume, isDefinitionRunActive: () => false }, () => rejection)
    const res = await request(app).post('/api/projects/p1/loop-runs/paused-run/resume').send({})
    expect(res.status).toBe(404) // legacy row: not a definition run
    const db2 = initDb(':memory:')
    createLoopRun(db2, { id: 'core-run', projectId: 'p1', loopId: 'loop-1', ticketIds: [], provider: 'claude', model: 'sonnet', iterationLimit: 3, startedAt: '2026-10-21T08:00:00Z' })
    db2.prepare("UPDATE loop_runs SET engine_version=2,status='paused',restart_reason='restart' WHERE id='core-run'").run()
    const coreApp = express(); coreApp.use(express.json()); const router = Router()
    registerLoopRunRoutes({ router, ctx: () => ({ db: db2, desktopDb, project: { id: 'p1', slug: 's1', path: '/repo' }, loopRunManager: { budgetPause: () => null, beginDefinitionResume }, dailyBudgetRejection: () => rejection }) } as unknown as ProjectRoutesDeps)
    coreApp.use('/api/projects', router)
    const blocked = await request(coreApp).post('/api/projects/p1/loop-runs/core-run/resume').send({})
    expect(blocked.status).toBe(409)
    expect(blocked.body).toEqual(rejection)
    expect(beginDefinitionResume).not.toHaveBeenCalled()
  })

  it('falls through to the definition resume path for runs that are not budget_paused', async () => {
    const res = await request(resumeApp({ budgetPause: () => null, resumeBudgetPause: vi.fn() })).post('/api/projects/p1/loop-runs/paused-run/resume').send({})
    expect(res.status).toBe(404)
  })
})

describe('project-router launch forecast (read-only)', () => {
  const finished = (db: DbInstance, ms: number, cost: number, provider = 'claude') => {
    const id = `lr-${Math.random().toString(36).slice(2)}`
    createLoopRun(db, { id, projectId: 'p1', loopId: 'factory:sdd-quick-openspec', loopName: 'L', iterationLimit: 1, provider, startedAt: new Date().toISOString() } as Parameters<typeof createLoopRun>[1])
    db.prepare('UPDATE loop_runs SET finished_at = ?, total_duration_ms = ?, total_cost_usd = ? WHERE id = ?').run(new Date().toISOString(), ms, cost, id)
  }
  const app = (db: DbInstance, headroom?: unknown) =>
    buildApp({ provider: 'claude', providers: ['claude'] }, { db, ...(headroom ? { dailyBudgetHeadroom: () => headroom } : {}) })

  it('requires a loop or a command and a well-formed provider', async () => {
    const db = initDb(':memory:')
    expect((await request(app(db)).get('/api/projects/p1/launch-forecast')).status).toBe(400)
    expect((await request(app(db)).get('/api/projects/p1/launch-forecast?loopId=x&provider=../etc')).status).toBe(400)
  })

  it('answers "not enough history" honestly, with the sample floor and no budget', async () => {
    const db = initDb(':memory:')
    for (let i = 1; i <= 4; i++) finished(db, i * 60_000, i)
    const res = await request(app(db)).get('/api/projects/p1/launch-forecast?loopId=factory:sdd-quick-openspec&provider=claude')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ time: null, cost: null, minSamples: 5, budget: null })
  })

  it('returns the measured bands and the tightest budget headroom', async () => {
    const db = initDb(':memory:')
    for (let i = 1; i <= 5; i++) finished(db, i * 60_000, i)
    for (let i = 1; i <= 5; i++) finished(db, i * 600_000, i * 10, 'codex')
    const budget = { scope: 'project', budgetUsd: 10, spentUsd: 4, exhausted: false, resetsAt: '2026-10-25T00:00:00.000Z' }
    const res = await request(app(db, budget)).get('/api/projects/p1/launch-forecast?loopId=factory:sdd-quick-openspec&provider=claude')
    expect(res.body.time).toMatchObject({ p25Ms: 120_000, p75Ms: 240_000, sampleCount: 5 })
    expect(res.body.cost).toEqual({ lowUsd: 2, highUsd: 4, sampleCount: 5 })
    expect(res.body.budget).toEqual(budget)
  })
})
