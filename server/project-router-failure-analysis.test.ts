/** Failure reasons: the AI analysis of a failed job (GET reads, POST asks once). */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const generate = vi.fn()
const generatorOptions: unknown[] = []
vi.mock('./modules/code/runtime/file-summary-generator', () => ({
  createFileSummaryGenerator: vi.fn((options: unknown) => { generatorOptions.push(options); return generate }),
}))

import { createProjectRouter } from './project-router'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import { createJob, appendEvent, finishJob } from './db/jobs'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { DbInstance } from './db'

function makeMinimalContext(
  db: DbInstance,
  provider: 'claude' | 'codex' | 'kimi' = 'codex',
): ProjectContext {
  return {
    project: {
      id: 'proj-codex',
      slug: 'proj-codex',
      name: 'Codex Project',
      path: '/tmp',
      db_path: ':memory:',
      added_at: '',
      last_seen_at: '',
      provider,
    },
    db,
    queueManager: {
      enqueue: vi.fn(() => ({ id: 'job-1', queuePosition: 0 })),
      cancel: vi.fn(() => 'canceled'),
      pause: vi.fn(),
      resume: vi.fn(),
      reorder: vi.fn(),
      getJobs: vi.fn(() => []),
      isPaused: vi.fn(() => false),
      getActiveJobId: vi.fn(() => null),
      phasesForCommand: vi.fn(() => []),
    } as any,
    chatManager: {
      isActive: vi.fn(() => false),
      sendMessage: vi.fn(async () => {}),
      abort: vi.fn(),
    } as any,
    setupManager: {
      isInstalling: vi.fn(() => false),
      isEnriching: vi.fn(() => false),
      isSettingUp: vi.fn(() => false),
      startEnrich: vi.fn(),
      startSetup: vi.fn(),
      resumeEnrich: vi.fn(),
      resumeSetup: vi.fn(),
      abort: vi.fn(),
      getCheckpointStatus: vi.fn(() => []),
      getInstallLog: vi.fn(() => []),
      getInstallTier: vi.fn(() => undefined),
      getSummary: vi.fn(() => ({ agents: 0, personas: 0, commands: 0 })),
    } as any,
    proposalManager: {
      isActive: vi.fn(() => false),
      startExploration: vi.fn(async () => {}),
      sendRefinement: vi.fn(async () => {}),
      createIssue: vi.fn(async () => {}),
      cancel: vi.fn(),
    } as any,
    specLauncherManager: {
      isActive: vi.fn(() => false),
      launch: vi.fn(async () => {}),
      cancel: vi.fn(),
    } as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast: vi.fn(),
  }
}

function makeRegistry(ctx: ProjectContext): ProjectRegistry {
  const desktopDb = initDesktopDb(':memory:')
  return {
    desktopDb,
    getContext: vi.fn((id: string) => (id === ctx.project.id ? ctx : undefined)),
    getContextByPath: vi.fn(() => undefined),
    addProject: vi.fn() as any,
    removeProject: vi.fn(),
    touchProject: vi.fn(),
    listContexts: vi.fn(() => [ctx]),
    getProjectRow: vi.fn(() => undefined),
  } as unknown as ProjectRegistry
}

function createApp(ctx: ProjectContext) {
  const registry = makeRegistry(ctx)
  const router = createProjectRouter(registry)
  const app = express()
  app.use(express.json())
  app.use('/api/projects', router)
  return { app }
}


const answer = JSON.stringify({
  headline: 'The developer step failed: the OpenSpec change is missing',
  cause: 'The runtime stopped the developer because no OpenSpec change exists.',
  category: 'missing_artifact', failedStep: 'developer',
  evidence: ['[runtime] step_failed: developer — OpenSpec change metadata is missing'],
  nextSteps: ['Replay from the architect'],
})

describe('failure analysis routes', () => {
  let db: DbInstance
  let app: express.Express
  const url = '/api/projects/proj-codex/jobs/job-f/failure-analysis'

  beforeEach(() => {
    vi.clearAllMocks()
    generatorOptions.length = 0
    db = initDb(':memory:')
    app = createApp(makeMinimalContext(db)).app
    createJob(db, { id: 'job-f', command: 'loop:implement', started_at: '2026-11-17T10:00:00Z', provider: 'codex' })
    appendEvent(db, 'job-f', 1, { event_type: 'log', payload: JSON.stringify({ line: '[runtime] step_started: developer' }) })
    appendEvent(db, 'job-f', 2, { event_type: 'log', payload: JSON.stringify({ line: '[runtime] step_failed: developer — OpenSpec change metadata is missing' }) })
    finishJob(db, 'job-f', { status: 'failed', exit_code: 1 })
  })

  it('analyzes a failed job once, on its provider and model, records the spend and serves it back', async () => {
    db.prepare(`INSERT INTO loop_runs (id, project_id, loop_id, loop_name, provider, model, status, started_at, created_at) VALUES ('job-f', 'proj-codex', 'l', 'Implement', 'codex', 'gpt-6.1-sol', 'failed', '', '')`).run()
    generate.mockResolvedValue({ summary: answer, model: 'gpt-6.1-sol', provider: 'codex', costUsd: 0.01, costEstimated: true, tokensIn: 100, tokensOut: 20, durationMs: 900 })
    expect((await request(app).get(`${url}?language=es`)).body).toEqual({ status: 'none' })
    const [first, second] = await Promise.all([
      request(app).post(url).send({ language: 'es' }),
      request(app).post(url).send({ language: 'es' }),
    ])
    expect(first.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generatorOptions[0]).toMatchObject({ model: 'gpt-6.1-sol', adapter: expect.objectContaining({ id: 'codex' }) })
    expect(first.body).toMatchObject({ status: 'ready', stale: false, provider: 'codex', analysis: { category: 'missing_artifact', evidence: ['[runtime] step_failed: developer — OpenSpec change metadata is missing'] } })
    const spend = db.prepare(`SELECT surface, surface_ref_id, total_cost_usd FROM ai_invocations`).all()
    expect(spend).toEqual([{ surface: 'failure-analysis', surface_ref_id: 'job-f', total_cost_usd: 0.01 }])
    expect((await request(app).get(`${url}?language=es`)).body).toMatchObject({ status: 'ready', stale: false })
    expect((await request(app).post(url).send({ language: 'es' })).status).toBe(200)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('reports the provider error and records the failed call', async () => {
    generate.mockRejectedValue(Object.assign(new Error('The model is not supported'), { partial: { provider: 'codex', costUsd: 0.002 } }))
    const response = await request(app).post(url).send({ language: 'en' })
    expect(response.status).toBe(502)
    expect(response.body).toEqual({ error: 'analysis_failed', detail: 'The model is not supported' })
    expect(db.prepare(`SELECT status FROM ai_invocations`).all()).toEqual([{ status: 'failed' }])
  })

  it('retries once when the analysis CLI was stopped from outside (exit 143), then serves the answer', async () => {
    generate.mockRejectedValueOnce(new Error('claude exit code=143; no stderr')).mockResolvedValueOnce({ summary: answer, provider: 'claude', costUsd: 0.01, durationMs: 900 })
    const response = await request(app).post(url).send({ language: 'en' })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ status: 'ready' })
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('says the analysis was interrupted when it is stopped twice, instead of a raw exit code', async () => {
    generate.mockRejectedValue(new Error('claude exit code=143; no stderr'))
    const response = await request(app).post(url).send({ language: 'en' })
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'analysis_interrupted' })
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('refuses a job that did not fail', async () => {
    createJob(db, { id: 'job-ok', command: 'loop:implement', started_at: '', provider: 'codex' })
    expect((await request(app).post('/api/projects/proj-codex/jobs/job-ok/failure-analysis').send({})).status).toBe(404)
  })
})
