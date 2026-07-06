// Manager-agnostic interactive-turn routing (S2): POST /jobs/:id/messages and
// POST /jobs/:id/finalize must address the job row's OWNER — QueueManager for
// rail/freestyle/spawned jobs, LoopRunManager for a loop run's job (its ACTIVE
// step session) — and 409 only when NEITHER manager owns an active session.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express, { Router, type Express } from 'express'
import request from 'supertest'
import { initDb, createJob, finishJob, type DbInstance } from './db'
import { createLoopRun } from './loop-runs-store'
import { registerJobsRoutes } from './project-router-jobs'
import { JobNotFoundError } from './queue-manager'
import type { ProjectRoutesDeps } from './project-router-helpers'

interface FakeManagers {
  queue: { sendInteractiveTurn: ReturnType<typeof vi.fn>; finalizeInteractive: ReturnType<typeof vi.fn> }
  loop: { sendInteractiveTurn: ReturnType<typeof vi.fn>; finalizeInteractive: ReturnType<typeof vi.fn> }
}

let db: DbInstance

function buildApp(opts: { queueOwns: boolean; loopOwns: boolean; omitLoopManager?: boolean }): { app: Express; managers: FakeManagers } {
  const managers: FakeManagers = {
    queue: {
      sendInteractiveTurn: vi.fn(() => opts.queueOwns),
      finalizeInteractive: vi.fn(() => opts.queueOwns),
    },
    loop: {
      sendInteractiveTurn: vi.fn(() => opts.loopOwns),
      finalizeInteractive: vi.fn(() => opts.loopOwns),
    },
  }
  const app = express()
  app.use(express.json())
  const router = Router()
  const ctx = () => ({
    db,
    project: { id: 'p1', slug: 's1', path: '/repo', provider: 'claude', providers: ['claude'] },
    queueManager: managers.queue,
    ...(opts.omitLoopManager ? {} : { loopRunManager: managers.loop }),
  })
  registerJobsRoutes({ router, ctx, ticketPath: () => undefined } as unknown as ProjectRoutesDeps)
  app.use('/api/projects', router)
  return { app, managers }
}

beforeEach(() => {
  delete process.env.SPECRAILS_INTERACTIVE_JOBS
  db = initDb(':memory:')
})
afterEach(() => {
  delete process.env.SPECRAILS_INTERACTIVE_JOBS
})

describe('POST /jobs/:id/messages (manager-agnostic)', () => {
  it('202 when QueueManager owns the session — the loop manager is not consulted', async () => {
    const { app, managers } = buildApp({ queueOwns: true, loopOwns: false })
    const res = await request(app).post('/api/projects/p1/jobs/j1/messages').send({ text: 'hi' })
    expect(res.status).toBe(202)
    expect(managers.queue.sendInteractiveTurn).toHaveBeenCalledWith('j1', 'hi')
    expect(managers.loop.sendInteractiveTurn).not.toHaveBeenCalled()
  })

  it('202 when only the LoopRunManager owns the session (a loop run job)', async () => {
    const { app, managers } = buildApp({ queueOwns: false, loopOwns: true })
    const res = await request(app).post('/api/projects/p1/jobs/run-1/messages').send({ text: 'steer left' })
    expect(res.status).toBe(202)
    expect(managers.queue.sendInteractiveTurn).toHaveBeenCalledWith('run-1', 'steer left')
    expect(managers.loop.sendInteractiveTurn).toHaveBeenCalledWith('run-1', 'steer left')
  })

  it('409 when NEITHER manager owns an active interactive session', async () => {
    const { app } = buildApp({ queueOwns: false, loopOwns: false })
    const res = await request(app).post('/api/projects/p1/jobs/ghost/messages').send({ text: 'hi' })
    expect(res.status).toBe(409)
  })

  it('409 (not a crash) when the context has no loopRunManager at all', async () => {
    const { app } = buildApp({ queueOwns: false, loopOwns: false, omitLoopManager: true })
    const res = await request(app).post('/api/projects/p1/jobs/j1/messages').send({ text: 'hi' })
    expect(res.status).toBe(409)
  })

  it('400 when text is missing', async () => {
    const { app } = buildApp({ queueOwns: true, loopOwns: false })
    expect((await request(app).post('/api/projects/p1/jobs/j1/messages').send({})).status).toBe(400)
    expect((await request(app).post('/api/projects/p1/jobs/j1/messages').send({ text: '   ' })).status).toBe(400)
  })

  it('403 when the interactive-jobs kill-switch is off', async () => {
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    const { app, managers } = buildApp({ queueOwns: true, loopOwns: true })
    const res = await request(app).post('/api/projects/p1/jobs/j1/messages').send({ text: 'hi' })
    expect(res.status).toBe(403)
    expect(managers.queue.sendInteractiveTurn).not.toHaveBeenCalled()
    expect(managers.loop.sendInteractiveTurn).not.toHaveBeenCalled()
  })
})

describe('POST /jobs/:id/finalize (manager-agnostic)', () => {
  it('202 when QueueManager owns the session — the loop manager is not consulted', async () => {
    const { app, managers } = buildApp({ queueOwns: true, loopOwns: false })
    createJob(db, { id: 'j1', command: '/specrails:freestyle #1 --yes', started_at: new Date().toISOString(), interactive: true })
    const res = await request(app).post('/api/projects/p1/jobs/j1/finalize').send({})
    expect(res.status).toBe(202)
    expect(res.body.job?.id).toBe('j1')
    expect(managers.queue.finalizeInteractive).toHaveBeenCalledWith('j1')
    expect(managers.loop.finalizeInteractive).not.toHaveBeenCalled()
  })

  it('202 when only the LoopRunManager owns the session (settle-now for the ACTIVE step)', async () => {
    const { app, managers } = buildApp({ queueOwns: false, loopOwns: true })
    createJob(db, { id: 'run-1', command: 'loop: Fix & Verify #7', started_at: new Date().toISOString(), interactive: true })
    const res = await request(app).post('/api/projects/p1/jobs/run-1/finalize').send({})
    expect(res.status).toBe(202)
    expect(res.body.job?.id).toBe('run-1')
    expect(managers.loop.finalizeInteractive).toHaveBeenCalledWith('run-1')
  })

  it('409 when neither manager owns an active interactive session', async () => {
    const { app } = buildApp({ queueOwns: false, loopOwns: false })
    expect((await request(app).post('/api/projects/p1/jobs/ghost/finalize').send({})).status).toBe(409)
  })

  it('403 when the interactive-jobs kill-switch is off', async () => {
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    const { app, managers } = buildApp({ queueOwns: true, loopOwns: true })
    expect((await request(app).post('/api/projects/p1/jobs/j1/finalize').send({})).status).toBe(403)
    expect(managers.queue.finalizeInteractive).not.toHaveBeenCalled()
  })
})

// ─── GET /jobs/:id interactive surface fields (S3) ────────────────────────────
// The client composer phrases its UX from `interactiveSettleMode` ('finalize' =
// freestyle Finalize semantics; 'auto' = self-settling, wrap-up optional) and
// `interactiveAcceptingTurns` (loop ai-step sessions come and go mid-run).
describe('GET /jobs/:id interactive surface fields', () => {
  function buildGetApp(opts: {
    qmMode?: 'finalize' | 'auto' | null
    loopStepActive?: boolean
    omitLoopManager?: boolean
  } = {}): Express {
    const app = express()
    app.use(express.json())
    const router = Router()
    const ctx = () => ({
      db,
      project: { id: 'p1', slug: 's1', path: '/repo', provider: 'claude', providers: ['claude'] },
      queueManager: {
        getJobs: () => [],
        phasesForCommand: () => [],
        getInteractiveSettleMode: vi.fn(() => opts.qmMode ?? null),
      },
      ...(opts.omitLoopManager ? {} : { loopRunManager: { isInteractiveJob: vi.fn(() => opts.loopStepActive ?? false) } }),
    })
    registerJobsRoutes({ router, ctx, ticketPath: () => undefined } as unknown as ProjectRoutesDeps)
    app.use('/api/projects', router)
    return app
  }

  it("running interactive QueueManager job reports the live session's settle mode + accepting turns", async () => {
    createJob(db, { id: 'j1', command: '/specrails:implement --yes', started_at: new Date().toISOString(), interactive: true })
    const app = buildGetApp({ qmMode: 'auto' })
    const res = await request(app).get('/api/projects/p1/jobs/j1')
    expect(res.status).toBe(200)
    expect(res.body.job.interactiveSettleMode).toBe('auto')
    expect(res.body.job.interactiveAcceptingTurns).toBe(true)
  })

  it("freestyle session reports 'finalize'", async () => {
    createJob(db, { id: 'j-ult', command: '/specrails:freestyle #1 --yes', started_at: new Date().toISOString(), interactive: true })
    const app = buildGetApp({ qmMode: 'finalize' })
    const res = await request(app).get('/api/projects/p1/jobs/j-ult')
    expect(res.body.job.interactiveSettleMode).toBe('finalize')
    expect(res.body.job.interactiveAcceptingTurns).toBe(true)
  })

  it("loop run with an ACTIVE step session: 'auto' + accepting turns", async () => {
    createJob(db, { id: 'run-1', command: 'loop: Fix & Verify', started_at: new Date().toISOString(), interactive: true })
    const app = buildGetApp({ loopStepActive: true })
    const res = await request(app).get('/api/projects/p1/jobs/run-1')
    expect(res.body.job.interactiveSettleMode).toBe('auto')
    expect(res.body.job.interactiveAcceptingTurns).toBe(true)
  })

  it("loop run BETWEEN steps: 'auto' (via the loop_runs row) but NOT accepting turns", async () => {
    createJob(db, { id: 'run-2', command: 'loop: Fix & Verify', started_at: new Date().toISOString(), interactive: true })
    createLoopRun(db, { id: 'run-2', projectId: 'p1', loopId: 'loop-1', iterationLimit: 5, startedAt: new Date().toISOString() })
    const app = buildGetApp({ loopStepActive: false })
    const res = await request(app).get('/api/projects/p1/jobs/run-2')
    expect(res.body.job.interactiveSettleMode).toBe('auto')
    expect(res.body.job.interactiveAcceptingTurns).toBe(false)
  })

  it('non-interactive running job: null + not accepting', async () => {
    createJob(db, { id: 'j-plain', command: '/specrails:implement --yes', started_at: new Date().toISOString() })
    const app = buildGetApp({ qmMode: 'auto' })
    const res = await request(app).get('/api/projects/p1/jobs/j-plain')
    expect(res.body.job.interactiveSettleMode).toBeNull()
    expect(res.body.job.interactiveAcceptingTurns).toBe(false)
  })

  it('finished interactive job: null + not accepting', async () => {
    createJob(db, { id: 'j-done', command: '/specrails:freestyle #1', started_at: new Date().toISOString(), interactive: true })
    finishJob(db, 'j-done', { exit_code: 0, status: 'completed' })
    const app = buildGetApp({ qmMode: null })
    const res = await request(app).get('/api/projects/p1/jobs/j-done')
    expect(res.body.job.interactiveSettleMode).toBeNull()
    expect(res.body.job.interactiveAcceptingTurns).toBe(false)
  })

  it('kill-switch off: null + not accepting even with a live session', async () => {
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    createJob(db, { id: 'j-off', command: '/specrails:implement --yes', started_at: new Date().toISOString(), interactive: true })
    const app = buildGetApp({ qmMode: 'auto' })
    const res = await request(app).get('/api/projects/p1/jobs/j-off')
    expect(res.body.job.interactiveSettleMode).toBeNull()
    expect(res.body.job.interactiveAcceptingTurns).toBe(false)
  })

  it('no loopRunManager in the context: the loop probe is skipped without crashing', async () => {
    createJob(db, { id: 'j-noloop', command: '/specrails:implement --yes', started_at: new Date().toISOString(), interactive: true })
    const app = buildGetApp({ qmMode: null, omitLoopManager: true })
    const res = await request(app).get('/api/projects/p1/jobs/j-noloop')
    expect(res.status).toBe(200)
    expect(res.body.job.interactiveSettleMode).toBeNull()
    expect(res.body.job.interactiveAcceptingTurns).toBe(false)
  })
})

// Standalone loop runs (railIndex=null) never register in railLoopRuns — the
// cancel route must fall back to the loop engine instead of 404ing while the
// loop keeps executing (the mission-modal "cancel did nothing" incident).
describe('DELETE /jobs/:id — standalone loop-run fallback', () => {
  function buildCancelApp() {
    const loopCancel = vi.fn()
    const app = express()
    app.use(express.json())
    const router = Router()
    const ctx = () => ({
      db,
      project: { id: 'p1', slug: 's1', path: '/repo', provider: 'claude', providers: ['claude'] },
      // queueManager.cancel throws the REAL JobNotFoundError class the route
      // checks with instanceof — import it from queue-manager.
      queueManager: {
        cancel: vi.fn(() => {
          throw new JobNotFoundError('nope')
        }),
      },
      loopRunManager: { cancel: loopCancel },
      railLoopRuns: new Map(),
    })
    registerJobsRoutes({ router, ctx, ticketPath: () => undefined } as unknown as ProjectRoutesDeps)
    app.use('/api/projects', router)
    return { app, loopCancel }
  }

  it('cancels a running standalone loop run through the LoopRunManager', async () => {
    const { app, loopCancel } = buildCancelApp()
    const runId = 'lr-standalone-1'
    createJob(db, { id: runId, command: 'loop: Solo #9', started_at: new Date().toISOString() })
    createLoopRun(db, {
      id: runId, projectId: 'p1', loopId: 'l1', loopName: 'Solo', railIndex: null,
      ticketId: 9, provider: 'claude', model: 'sonnet', iterationLimit: 3,
      startedAt: new Date().toISOString(),
    })

    const res = await request(app).delete('/api/projects/p1/jobs/' + runId)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, status: 'canceling' })
    expect(loopCancel).toHaveBeenCalledWith(runId)
  })

  it('still 404s for a genuinely unknown job id', async () => {
    const { app, loopCancel } = buildCancelApp()
    const res = await request(app).delete('/api/projects/p1/jobs/nope')
    expect(res.status).toBe(404)
    expect(loopCancel).not.toHaveBeenCalled()
  })
})
