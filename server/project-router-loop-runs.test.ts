import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { Router, type Express } from 'express'
import request from 'supertest'
import { initDesktopDb } from './desktop-db'
import { createJob, initDb, type DbInstance } from './db'
import { createLoopRun } from './modules/loops/runtime/loop-runs-store'
import { createLoop, publishLoop } from './modules/loops/runtime/loops-store'
import { readRetainedBudgetPause, saveRetainedBudgetPause } from './modules/loops/runtime/loop-budget-pauses'
import { registerLoopRunRoutes } from './project-router-loop-runs'
import { readLimitPause, saveLimitPause } from './modules/loops/runtime/loop-limit-pauses'
import type { ProjectRoutesDeps } from './project-router-helpers'
import type { LoopGraph } from './modules/loops/runtime/loop-graph'

const settled = vi.hoisted(() => ({ offer: null as unknown }))
vi.mock('./modules/loops/runtime/loop-provider-switch-settled', async () => ({
  ...await vi.importActual<object>('./modules/loops/runtime/loop-provider-switch-settled'),
  settledProviderSwitch: vi.fn(async () => settled.offer),
}))

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

  it('[spec:pr-ci-loop-editable/fix-pr-ci-shows-in-loops] never runs Fix PR CI loose from Loops: it needs a pull request', async () => {
    const app = buildApp({ provider: 'claude', providers: ['claude'] })
    const res = await request(app).post('/api/projects/p1/loop-runs').send({ loopId: 'factory:pr-ci' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('pr_ci_requires_delivery')
  })

  it('[spec:mobile-device-testing/run-from-loops] never runs Test in Mobile Device as a generic loop: it needs a target', async () => {
    const app = buildApp({ provider: 'claude', providers: ['claude'] })
    const res = await request(app).post('/api/projects/p1/loop-runs').send({ loopId: 'factory:mobile-test' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('mobile_test_requires_target')
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

  it('a run a restart retained while parked at its per-run cap answers the cap before it resumes', async () => {
    // After a restart nothing resident holds the pause: only its durable record says it waits on its cap.
    const db = initDb(':memory:')
    createLoopRun(db, { id: 'capped', projectId: 'p1', loopId: 'loop-1', ticketIds: [], provider: 'claude', model: 'haiku', iterationLimit: 3, startedAt: '2026-10-21T08:00:00Z' })
    db.prepare("UPDATE loop_runs SET status='paused', restart_reason='restart', total_cost_usd=0.606, run_cap_usd=0.4 WHERE id='capped'").run()
    saveRetainedBudgetPause(db, 'capped')
    const app = express(); app.use(express.json()); const router = Router()
    registerLoopRunRoutes({ router, ctx: () => ({ db, desktopDb, project: { id: 'p1', slug: 's1', path: '/repo' }, loopRunManager: { budgetPause: () => null, limitPause: () => null }, dailyBudgetRejection: () => null, onLoopRunFinished: vi.fn() }) } as unknown as ProjectRoutesDeps)
    app.use('/api/projects', router)
    const refused = await request(app).post('/api/projects/p1/loop-runs/capped/resume').send({})
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ error: 'daily_budget_exceeded', period: 'run', budgetUsd: 0.4, spentUsd: 0.606 })
    expect(readRetainedBudgetPause(db, 'capped')).toBe(true)
    // Raising the cap below what it spent still refuses; raising it above lets the resume through.
    expect((await request(app).post('/api/projects/p1/loop-runs/capped/resume').send({ runCapUsd: 0.5 })).status).toBe(409)
    const raised = await request(app).post('/api/projects/p1/loop-runs/capped/resume').send({ runCapUsd: 3 })
    expect(raised.body).not.toMatchObject({ period: 'run' })
    expect(db.prepare("SELECT run_cap_usd FROM loop_runs WHERE id='capped'").get()).toEqual({ run_cap_usd: 3 })
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

describe('usage-limit pause controls (provider-quota)', () => {
  const limit = { providerId: 'claude', resumeAt: '2099-01-01T00:00:00.000Z', autoResume: true, message: 'limit', pausedAt: '2026-11-18T10:00:00.000Z', switchable: true }
  function limitApp(live: typeof limit | null) {
    const db = initDb(':memory:')
    createLoopRun(db, { id: 'run-1', projectId: 'p1', loopId: 'loop', iterationLimit: 3, startedAt: '2026-11-18T10:00:00Z' })
    db.prepare("UPDATE loop_runs SET status='paused', restart_reason='limit_paused' WHERE id='run-1'").run()
    const resolveLimitPause = vi.fn().mockReturnValue(true)
    const app = buildApp({ provider: 'claude', providers: ['claude', 'codex'] }, {
      db,
      loopRunManager: { run: vi.fn(), cancel: vi.fn(), limitPause: vi.fn(() => live), resolveLimitPause, budgetPause: () => null },
    })
    return { app, db, resolveLimitPause }
  }

  it('resumes now, toggles the automatic resume and switches only to a provider that does not share the quota', async () => {
    const { app, resolveLimitPause } = limitApp(limit)
    expect((await request(app).post('/api/projects/p1/loop-runs/run-1/limit').send({ action: 'resume' })).status).toBe(202)
    expect(resolveLimitPause).toHaveBeenLastCalledWith('run-1', { action: 'resume' })
    expect((await request(app).post('/api/projects/p1/loop-runs/run-1/limit').send({ action: 'auto', enabled: false })).status).toBe(200)
    expect(resolveLimitPause).toHaveBeenLastCalledWith('run-1', { action: 'auto', enabled: false })
    expect((await request(app).post('/api/projects/p1/loop-runs/run-1/limit').send({ action: 'switch', provider: 'claude' })).body.error).toBe('shares_quota')
    const switched = await request(app).post('/api/projects/p1/loop-runs/run-1/limit').send({ action: 'switch', provider: 'codex' })
    expect(switched.status).toBe(202)
    expect(resolveLimitPause).toHaveBeenLastCalledWith('run-1', expect.objectContaining({ action: 'switch', provider: 'codex' }))
    expect((await request(app).post('/api/projects/p1/loop-runs/run-1/limit').send({ action: 'nope' })).status).toBe(400)
    // The regular Resume (inbox, run card) answers a live limit pause too.
    expect((await request(app).post('/api/projects/p1/loop-runs/run-1/resume').send({})).status).toBe(202)
  })

  it('edits the persisted pause of a run retained over a restart and refuses runs that are not limit-paused', async () => {
    const { app, db } = limitApp(null)
    expect((await request(app).post('/api/projects/p1/loop-runs/run-1/limit').send({ action: 'auto', enabled: true })).status).toBe(409)
    saveLimitPause(db, 'run-1', limit)
    const res = await request(app).post('/api/projects/p1/loop-runs/run-1/limit').send({ action: 'auto', enabled: false })
    expect(res.status).toBe(200)
    expect(res.body.limit).toMatchObject({ autoResume: false })
    expect(readLimitPause(db, 'run-1')?.autoResume).toBe(false)
    expect((await request(app).post('/api/projects/p1/loop-runs/run-1/limit').send({ action: 'switch', provider: 'codex' })).body.error).toBe('switch_unavailable')
  })
})

describe('continuing a limit-paused Core run on another provider (Core routeOverrides)', () => {
  const core = { providerId: 'codex', resumeAt: '2099-01-01T00:00:00.000Z', autoResume: true, message: 'codex usage limit reached', pausedAt: '2026-11-18T10:00:00.000Z', switchable: true,
    switchRoles: ['developer', 'fixer'], switchTargets: [{ provider: 'claude', model: 'sonnet', effort: 'medium' }] }
  function coreApp(live: typeof core | null) {
    const db = initDb(':memory:')
    createLoopRun(db, { id: 'run-1', projectId: 'p1', loopId: 'loop', iterationLimit: 3, startedAt: '2026-11-18T10:00:00Z' })
    db.prepare("UPDATE loop_runs SET status='paused', restart_reason='limit_paused' WHERE id='run-1'").run()
    const resolveLimitPause = vi.fn().mockReturnValue(true)
    const app = buildApp({ provider: 'codex', providers: ['claude', 'codex', 'gemini'] }, {
      db, loopRunManager: { run: vi.fn(), cancel: vi.fn(), limitPause: vi.fn(() => live), resolveLimitPause, budgetPause: () => null },
    })
    return { app, db, resolveLimitPause }
  }
  const post = (app: ReturnType<typeof coreApp>['app'], body: object) => request(app).post('/api/projects/p1/loop-runs/run-1/limit').send({ action: 'switch', ...body })

  it('validates the provider, model and effort server-side before the run continues', async () => {
    const { app, resolveLimitPause } = coreApp(core)
    // Never the exhausted provider (or one sharing its quota), nor one the card did not offer.
    expect((await post(app, { provider: 'codex', model: 'gpt-6-sol' })).body.error).toBe('shares_quota')
    expect((await post(app, { provider: 'gemini', model: 'gemini-3.5-flash' })).body.error).toBe('invalid_provider')
    expect((await post(app, { provider: 'claude', model: 'gpt-6-sol' })).body.error).toBe('invalid_model')
    expect((await post(app, { provider: 'claude', model: 'haiku', effort: 'ultra' })).body.error).toBe('invalid_effort')
    expect((await post(app, { provider: 'claude', model: 'haiku', effort: 'low', remember: 'yes' })).body.error).toBe('invalid_remember')
    expect(resolveLimitPause).not.toHaveBeenCalled()
    const switched = await post(app, { provider: 'claude', model: 'haiku', effort: 'low', remember: true })
    expect(switched.status).toBe(202)
    expect(switched.body).toMatchObject({ provider: 'claude', model: 'haiku', effort: 'low' })
    expect(resolveLimitPause).toHaveBeenLastCalledWith('run-1', { action: 'switch', provider: 'claude', model: 'haiku', effort: 'low', remember: true })
    // The model defaults to the offered one.
    await post(app, { provider: 'claude' })
    expect(resolveLimitPause).toHaveBeenLastCalledWith('run-1', { action: 'switch', provider: 'claude', model: 'sonnet' })
  })

  it('refuses a switch when the run offered none (an older Core)', async () => {
    const { app, resolveLimitPause } = coreApp({ ...core, switchable: false })
    expect((await post(app, { provider: 'claude', model: 'haiku' })).body.error).toBe('switch_unavailable')
    expect(resolveLimitPause).not.toHaveBeenCalled()
  })
})

describe('resuming a run a Desktop restart interrupted', () => {
  it('authorizes recovery of the cut-off step when a limit pause retained over a restart resumes', async () => {
    const { limitResumeOptions } = await import('./project-router-loop-runs')
    expect(limitResumeOptions({ status: 'paused', restart_reason: 'restart' })).toEqual({ restartResume: true })
    expect(limitResumeOptions({ status: 'paused', restart_reason: 'limit_paused' })).toEqual({ restartResume: false })
    expect(limitResumeOptions(undefined)).toEqual({ restartResume: false })
  })
  it('treats the empty-handed Resume of a restart-paused run as the explicit recovery of its interrupted steps', async () => {
    const { isRestartResume, restartRecoveryControls } = await import('./project-router-loop-runs')
    const interrupted = { status: 'paused', restart_reason: 'restart' }
    expect(isRestartResume(interrupted, {})).toBe(true)
    expect(restartRecoveryControls({}, [{ attemptId: 'a1' }, { attemptId: 'a2' }])).toEqual({ recover: ['a1', 'a2'] })
    // Nothing interrupted mid-write: the body stays as it was.
    expect(restartRecoveryControls({}, [])).toEqual({})
  })
  it('leaves answers, explicit recovery and other pauses alone', async () => {
    const { isRestartResume } = await import('./project-router-loop-runs')
    expect(isRestartResume({ status: 'paused', restart_reason: 'restart' }, { answer: 'yes', interruptId: 'i1' })).toBe(false)
    expect(isRestartResume({ status: 'paused', restart_reason: 'restart' }, { recover: [] })).toBe(false)
    expect(isRestartResume({ status: 'paused', restart_reason: 'budget_paused' }, {})).toBe(false)
    expect(isRestartResume({ status: 'completed', restart_reason: null }, {})).toBe(false)
  })
})

describe('resuming right after a restart', () => {
  it('waits for the killed Core child lease to expire, bounded, and never for a run alive in this process', async () => {
    const { staleLeaseWaitMs, STALE_LEASE_MAX_WAIT_MS } = await import('./project-router-loop-runs')
    expect(staleLeaseWaitMs({ active: true, expiresAt: 10_000 }, 4_000, false)).toBe(6_250)
    expect(staleLeaseWaitMs({ active: true, expiresAt: 10_000 }, 4_000, true)).toBe(0)
    expect(staleLeaseWaitMs({ active: false, expiresAt: 10_000 }, 4_000, false)).toBe(0)
    expect(staleLeaseWaitMs(null, 4_000, false)).toBe(0)
    expect(staleLeaseWaitMs({ active: true, expiresAt: 4_000 + STALE_LEASE_MAX_WAIT_MS + 10_000 }, 4_000, false)).toBe(0)
  })
})

describe('continuing a run that settled on a usage limit on another provider', () => {
  const offer = { providerId: 'codex', roles: ['developer', 'fixer'], targets: [{ provider: 'claude', model: 'sonnet', effort: 'medium' }], via: 'fork' }
  function settledApp() {
    process.env.SPECRAILS_LOOPS_SECTION = '1'
    const db = initDb(':memory:')
    createLoopRun(db, { id: 'run-1', projectId: 'p1', loopId: 'loop', iterationLimit: 3, startedAt: '2026-11-18T10:00:00Z' })
    db.prepare("UPDATE loop_runs SET status='completed', final_outcome='failure', engine_version=2 WHERE id='run-1'").run()
    return buildApp({ provider: 'codex', providers: ['claude', 'codex', 'gemini'] }, { db })
  }
  const post = (app: Express, body: object) => request(app).post('/api/projects/p1/loop-runs/run-1/remedy').send(body)

  it('offers the switch with the run\'s attempts and checks the choice against that offer', async () => {
    settled.offer = offer
    const app = settledApp()
    expect((await request(app).get('/api/projects/p1/loop-runs/run-1/attempts')).body).toMatchObject({ continuable: true, providerSwitch: offer })
    // Never the exhausted provider, nor one the run did not offer, nor a model or effort outside the catalog.
    expect((await post(app, { remedy: 'continue', switch: { provider: 'codex', model: 'gpt-6-sol' } })).body.error).toBe('shares_quota')
    expect((await post(app, { remedy: 'continue', switch: { provider: 'gemini', model: 'gemini-3.5-flash' } })).body.error).toBe('invalid_provider')
    expect((await post(app, { remedy: 'continue', switch: { provider: 'claude', model: 'gpt-6-sol' } })).body.error).toBe('invalid_model')
    expect((await post(app, { remedy: 'continue', switch: { provider: 'claude', model: 'haiku', effort: 'ultra' } })).body.error).toBe('invalid_effort')
    expect((await post(app, { remedy: 'continue', switch: { provider: 'claude', temperature: 1 } })).body.error).toBe('invalid_switch')
    expect((await post(app, { remedy: 'continue-to-review', switch: { provider: 'claude' } })).body.error).toBe('invalid_switch')
    // A valid choice goes on to Continue (here the run has no Core state to fork from).
    const valid = await post(app, { remedy: 'continue', switch: { provider: 'claude', model: 'haiku', effort: 'low' } })
    expect(valid.body.error).not.toMatch(/switch|provider|model|effort/)
  })

  it('is not continuable once its saved Core state is gone, and Continue says to launch again', async () => {
    settled.offer = offer
    process.env.SPECRAILS_LOOPS_SECTION = '1'
    const db = initDb(':memory:')
    createLoopRun(db, { id: 'run-1', projectId: 'p1', loopId: 'loop', iterationLimit: 3, startedAt: '2026-11-18T10:00:00Z' })
    db.prepare("UPDATE loop_runs SET status='completed', final_outcome='failure', engine_version=2, run_request_json=?, runtime_metadata_json=? WHERE id='run-1'")
      .run(JSON.stringify({ runId: 'run-1', projectId: 'p1', loopId: 'loop' }), JSON.stringify({ source: 'definition', contextPath: '/nonexistent/worktree/.specrails/pipeline/run-1/desktop-context.json' }))
    const app = buildApp({ provider: 'codex', providers: ['claude', 'codex', 'gemini'] }, { db })
    const attempts = (await request(app).get('/api/projects/p1/loop-runs/run-1/attempts')).body
    expect(attempts).toMatchObject({ continuable: false, providerSwitch: null })
    const refused = await post(app, { remedy: 'continue' })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('runtime_state_gone')
  })

  it('refuses a switch the run does not offer (no limit, an older Core, nothing else installed)', async () => {
    settled.offer = null
    const app = settledApp()
    expect((await request(app).get('/api/projects/p1/loop-runs/run-1/attempts')).body.providerSwitch).toBeNull()
    expect((await post(app, { remedy: 'continue', switch: { provider: 'claude', model: 'haiku' } })).body).toMatchObject({ error: 'switch_unavailable' })
  })
})

describe('loop runs — the person\'s Pause', () => {
  function pauseApp(manager: Record<string, unknown>, engineVersion = 2) {
    const db = initDb(':memory:')
    createLoopRun(db, { id: 'r1', projectId: 'p1', loopId: 'implement', ticketIds: [], provider: 'claude', model: 'haiku', iterationLimit: 3, startedAt: '2026-11-21T08:00:00Z' })
    db.prepare('UPDATE loop_runs SET engine_version=? WHERE id=?').run(engineVersion, 'r1')
    const app = express(); app.use(express.json()); const router = Router()
    registerLoopRunRoutes({ router, ctx: () => ({ db, desktopDb, project: { id: 'p1', slug: 's1', path: '/repo' }, loopRunManager: manager, dailyBudgetRejection: () => null, onLoopRunFinished: vi.fn() }) } as unknown as ProjectRoutesDeps)
    app.use('/api/projects', router)
    return { app, db }
  }

  it('reads the pause control of one run (the rail toggle), the same value Job detail reports', async () => {
    const userPauseControl = vi.fn().mockReturnValue('pause')
    const { app, db } = pauseApp({ userPauseControl })
    createJob(db, { id: 'r1', command: 'loop:implement', started_at: '2026-11-21T08:00:00Z', owner: 'loop' })
    expect((await request(app).get('/api/projects/p1/loop-runs/r1/pause-control')).body).toEqual({ loopRunId: 'r1', pauseControl: 'pause' })
    userPauseControl.mockReturnValue('pausing')
    expect((await request(app).get('/api/projects/p1/loop-runs/r1/pause-control')).body.pauseControl).toBe('pausing')
    // No resident task (held over a restart): a pause by you still offers Resume through its hold.
    userPauseControl.mockReturnValue(null)
    db.prepare("UPDATE loop_runs SET status='paused', restart_reason='user_paused' WHERE id='r1'").run()
    expect((await request(app).get('/api/projects/p1/loop-runs/r1/pause-control')).body.pauseControl).toBe('resume')
    db.prepare("UPDATE jobs SET status='completed' WHERE id='r1'").run()
    expect((await request(app).get('/api/projects/p1/loop-runs/r1/pause-control')).body).toEqual({ loopRunId: 'r1', pauseControl: null })
    expect((await request(app).get('/api/projects/p1/loop-runs/nope/pause-control')).status).toBe(404)
  })

  it('requests a pause at the next step boundary and answers 202 pausing', async () => {
    const requestUserPause = vi.fn().mockResolvedValue({ status: 'pausing', requestId: 'desktop-user-pause:r1:1:abc' })
    const res = await request(pauseApp({ requestUserPause }).app).post('/api/projects/p1/loop-runs/r1/pause').send({})
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ loopRunId: 'r1', pausing: true, requestId: 'desktop-user-pause:r1:1:abc' })
    expect(requestUserPause).toHaveBeenCalledWith('r1')
  })

  it('409s a run that cannot pause: a legacy run, an older Core, a held or settled run', async () => {
    expect((await request(pauseApp({ requestUserPause: vi.fn() }, 1).app).post('/api/projects/p1/loop-runs/r1/pause').send({})).body).toMatchObject({ error: 'pause_unsupported' })
    for (const [status, error] of [['unsupported', 'pause_unsupported'], ['held', 'pause_held'], ['not_running', 'pause_not_running']] as const) {
      const res = await request(pauseApp({ requestUserPause: vi.fn().mockResolvedValue({ status }) }).app).post('/api/projects/p1/loop-runs/r1/pause').send({})
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(error)
    }
    expect((await request(pauseApp({ requestUserPause: vi.fn().mockRejectedValue(new Error('Core did not acknowledge')) }).app).post('/api/projects/p1/loop-runs/r1/pause').send({})).body)
      .toEqual({ error: 'pause_rejected', detail: 'Core did not acknowledge' })
  })

  it('resumes a resident run the person paused in place', async () => {
    const resumeUserPause = vi.fn().mockReturnValue(true)
    const beginDefinitionResume = vi.fn()
    const res = await request(pauseApp({ budgetPause: () => null, resumeUserPause, beginDefinitionResume }).app).post('/api/projects/p1/loop-runs/r1/resume').send({})
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ loopRunId: 'r1', resumed: true })
    expect(resumeUserPause).toHaveBeenCalledWith('r1')
    expect(beginDefinitionResume).not.toHaveBeenCalled()
  })
})
