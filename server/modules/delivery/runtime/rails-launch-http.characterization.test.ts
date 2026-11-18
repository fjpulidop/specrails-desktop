// Characterization tests for the rail launch door (POST /rails/:i/launch and
// /relaunch). They pin the status codes, bodies, side effects and broadcast
// order of branches the main router suite does not reach, so the staged
// launch pipeline (rail-launch-*.ts) stays byte-identical to the original
// single handler.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createRailsRouter } from './rails-router'
import { getRail, setRailTickets } from './rails-store'
import { createLoopRun } from '../../loops/runtime/loop-runs-store'
import { createPrDelivery, transitionDecision, PrDeliveryGenerationConflict, type CreatePrDeliveryInput } from './rail-pr-store'
import { openProjectProcessAdmission } from '../../../process-admission'
import { ClaudeNotFoundError, CodexNotFoundError } from '../../execution/runtime/queue-manager'
import { defaultGitRunner } from '../../../worktree-manager'
import type { ProjectRepository } from '../../../project-repositories'

const { mockRepoStatus, mockLaunchIsolated } = vi.hoisted(() => ({
  mockRepoStatus: vi.fn(),
  mockLaunchIsolated: vi.fn(),
}))
vi.mock('../../agent-runtime/runtime/agent-runtime-loader', () => ({ loadCoreAgentRuntime: async () => ({ api: { capabilities: {} } }) }))
vi.mock('../../../worktree-manager', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  repoIsolationStatus: mockRepoStatus,
}))
vi.mock('./rail-isolated-launch', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  launchIsolatedRail: mockLaunchIsolated,
}))

const ENV_KEYS = ['SPECRAILS_LOOPS_SECTION', 'SPECRAILS_RAIL_DELIVER_PR', 'SPECRAILS_CODE_EXPLORER'] as const
let savedEnv: Record<string, string | undefined>
let db: DbInstance
let desktopDb: DbInstance
let projectPath: string

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.SPECRAILS_CODE_EXPLORER = 'false'
  db = initDb(':memory:')
  desktopDb = initDesktopDb(':memory:')
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-launch-char-'))
  mockRepoStatus.mockReset().mockResolvedValue('no-git')
  mockLaunchIsolated.mockReset().mockResolvedValue(['iso-run'])
})
afterEach(() => {
  openProjectProcessAdmission('p1')
  vi.restoreAllMocks()
  db.close(); desktopDb.close()
  fs.rmSync(projectPath, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

interface AppOptions {
  queueManager?: { enqueue: (...args: unknown[]) => unknown }
  broadcast?: (msg: unknown) => void
  loopRunManager?: { run: (...args: unknown[]) => Promise<unknown>; cancel: (id: string) => void }
  railLoopRuns?: Map<string, { railIndex: number; ticketIds: number[] }>
  railJobs?: Map<string, { railIndex: number; mode: string; ticketIds: number[] }>
  getTicketSpec?: (ticketId: number) => { title: string; description: string; repositoryIds?: string[] } | undefined
  repositories?: ProjectRepository[]
  onRailLaunch?: (ticketIds: number[], id: string) => void
}

function appWith(opts: AppOptions = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { projectCtx: unknown }).projectCtx = {
      db,
      desktopDb,
      railJobs: opts.railJobs ?? new Map(),
      railLoopRuns: opts.railLoopRuns ?? new Map(),
      project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude', 'codex'], path: projectPath, repositories: opts.repositories },
      queueManager: opts.queueManager,
      broadcast: opts.broadcast ?? (() => { /* noop */ }),
      loopRunManager: opts.loopRunManager ?? { run: vi.fn(() => new Promise<never>(() => {})), cancel: vi.fn() },
      getTicketSpec: opts.getTicketSpec ?? ((id: number) => ({ title: `Spec ${id}`, description: 'D' })),
      onLoopRunFinished: () => { /* noop */ },
      jiraSyncManager: { onRailLaunch: opts.onRailLaunch ?? (() => { /* noop */ }) },
    }
    next()
  })
  app.use('/rails', createRailsRouter())
  return app
}

const twoRepositories = (): ProjectRepository[] => ['backend', 'frontend'].map((id, index) => {
  const repositoryPath = path.join(projectPath, id)
  fs.mkdirSync(repositoryPath, { recursive: true })
  return { id, projectId: 'p1', name: id, path: repositoryPath, isPrimary: index === 0,
    kind: 'git', integrationBranch: 'main', addedAt: '2026-10-05T00:00:00Z' }
})

const failedDelivery = (options: Partial<CreatePrDeliveryInput> = {}) => {
  const row = createPrDelivery(db, { railIndex: 0, railKey: '0-quick', ticketIds: [4], baseBranch: 'main',
    loopId: 'factory:implement', loopName: 'Quick', originSurface: 'agent-chat', originConversationId: 'mission-1', ...options })
  transitionDecision(db, row.id, 'building', 'implementation_failed', { implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: 'implementation_failed' })
  return row
}

const completedRun = (id = 'old-run') => {
  createLoopRun(db, { id, projectId: 'p1', railIndex: 0, loopId: 'factory:implement', loopName: 'Implement', ticketIds: [4], ticketId: 4, provider: 'claude', model: 'sonnet', iterationLimit: 1, startedAt: '2026-10-03T08:00:00Z' })
  db.prepare("UPDATE loop_runs SET status='completed',final_outcome='failed' WHERE id=?").run(id)
}

describe('launch door — request validation stage', () => {
  beforeEach(() => { setRailTickets(db, 0, [1], 'implement') })

  it('400 invalid_runtime_provider_override for a malformed override', async () => {
    const res = await request(appWith()).post('/rails/0/launch').send({ runtimeProviderOverride: 42 })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_runtime_provider_override' })
  })

  it('400 invalid_follow_up before any other check, then follow_up_requires_target', async () => {
    const invalid = await request(appWith()).post('/rails/0/launch').send({ targetPrNumber: 5, followUp: 'nope' })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toBe('invalid_follow_up')
    const noTarget = await request(appWith()).post('/rails/0/launch').send({ followUp: { comments: [{ path: 'a.ts', body: 'fix' }] } })
    expect(noTarget.status).toBe(400)
    expect(noTarget.body.error).toBe('follow_up_requires_target')
  })

  it('400 follow_up_requires_pr_mode when PR delivery is disabled', async () => {
    process.env.SPECRAILS_RAIL_DELIVER_PR = 'false'
    const res = await request(appWith()).post('/rails/0/launch')
      .send({ revisionOfDeliveryId: 'abc', revisionNote: 'tweak', followUp: { comments: [{ path: 'a.ts', body: 'fix' }] } })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'follow_up_requires_pr_mode', detail: 'a PR review follow-up runs on the isolated PR-delivery path; loops and PR delivery must be enabled' })
  })

  it('400 base_branch_requires_isolation when loops are disabled', async () => {
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    const res = await request(appWith()).post('/rails/0/launch').send({ baseBranch: 'feat/x' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'base_branch_requires_isolation', detail: 'baseBranch requires an isolated (worktree) loop launch; loops are disabled' })
  })

  it('403 for loop mode while loops are disabled', async () => {
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    const res = await request(appWith()).post('/rails/0/launch').send({ mode: 'loop' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Loops are disabled on this server' })
  })

  it('404 for an unknown factory loop id', async () => {
    const res = await request(appWith()).post('/rails/0/launch').send({ loopId: 'factory:does-not-exist' })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Factory loop not found' })
  })
})

describe('launch door — scope stage', () => {
  it('400 when the rail carries no tickets', async () => {
    const res = await request(appWith()).post('/rails/0/launch').send({})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Rail has no tickets assigned' })
  })

  it('400 repository_scope_incomplete when the launch omits a repository its spec needs', async () => {
    setRailTickets(db, 0, [1], 'implement')
    const repositories = twoRepositories()
    const res = await request(appWith({ repositories, getTicketSpec: () => ({ title: 'T', description: 'D', repositoryIds: ['backend', 'frontend'] }) }))
      .post('/rails/0/launch').send({ repositoryIds: ['backend'] })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'repository_scope_incomplete', missingRepositoryIds: ['frontend'] })
  })

  it('409 repository_isolation_required for a non-primary scope with loops disabled', async () => {
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    setRailTickets(db, 0, [1], 'implement')
    const enqueue = vi.fn()
    const res = await request(appWith({ repositories: twoRepositories(), queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ repositoryIds: ['backend', 'frontend'] })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'repository_isolation_required' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('409 invalid_repository_base for an unknown base delivery', async () => {
    setRailTickets(db, 0, [1], 'implement')
    const res = await request(appWith()).post('/rails/0/launch').send({ baseDeliveryIds: { backend: 'missing' } })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('invalid_repository_base')
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })

  it('409 tickets_in_flight when a loop run already works one of the tickets', async () => {
    setRailTickets(db, 0, [1, 2], 'implement')
    const res = await request(appWith({ railLoopRuns: new Map([['r', { railIndex: 3, ticketIds: [2] }]]) }))
      .post('/rails/0/launch').send({})
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'tickets_in_flight', ticketIds: [2] })
  })
})

describe('launch door — engine stage', () => {
  beforeEach(() => { setRailTickets(db, 0, [1], 'implement') })

  it('400 runtime_provider_mismatch for a roles launch carrying an override', async () => {
    const res = await request(appWith()).post('/rails/0/launch').send({ aiEngine: 'roles', runtimeProviderOverride: { provider: 'claude' } })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'runtime_provider_mismatch', detail: 'A roles launch carries no provider override' })
  })

  it('400 runtime_provider_mismatch when the override names a different provider than the engine', async () => {
    const res = await request(appWith()).post('/rails/0/launch').send({ aiEngine: 'codex', runtimeProviderOverride: { provider: 'claude' } })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'runtime_provider_mismatch' })
  })
})

describe('launch door — PR continuation stage', () => {
  beforeEach(() => { setRailTickets(db, 0, [1], 'implement') })

  it('409 invalid_revision_target when the revised delivery is no longer active', async () => {
    const res = await request(appWith()).post('/rails/0/launch').send({ revisionOfDeliveryId: 'abc', revisionNote: 'tweak' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'invalid_revision_target', detail: 'The delivery is no longer active; refresh before continuing.' })
  })
})

describe('launch door — isolated launch errors', () => {
  beforeEach(() => {
    setRailTickets(db, 0, [1], 'implement')
    mockRepoStatus.mockResolvedValue('ok')
  })

  it('409 pr_delivery_generation_conflict with the current generation id', async () => {
    mockLaunchIsolated.mockRejectedValue(new PrDeliveryGenerationConflict('gen-2'))
    const res = await request(appWith()).post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'pr_delivery_generation_conflict', prDeliveryId: 'gen-2' })
  })

  it('202 isolated response carries the run ids and the active delivery id', async () => {
    const res = await request(appWith()).post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ loopRunIds: ['iso-run'], railIndex: 0, mode: 'implement', loopId: 'factory:implement', prDeliveryId: null, isolated: true })
  })
})

describe('launch door — relaunch stage', () => {
  it('409 relaunch_delivery_unavailable when PR delivery is disabled for a delivery source', async () => {
    const row = failedDelivery()
    process.env.SPECRAILS_RAIL_DELIVER_PR = 'false'
    const res = await request(appWith()).post('/rails/0/relaunch').send({ sourceId: row.id })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'relaunch_delivery_unavailable', detail: 'The original attempt belongs to isolated PR delivery, which is disabled.',
      action: 'Enable PR delivery before retrying this attempt.' })
    expect(getRail(db, 0).ticketIds).toEqual([])
  })

  it('409 invalid_relaunch_source from the resolver with its own action', async () => {
    const res = await request(appWith()).post('/rails/0/relaunch').send({ sourceId: 42 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('invalid_relaunch_source')
    expect(typeof res.body.action).toBe('string')
  })

  it('restores the released specs before a shared-cwd run, broadcasting rail.updated first', async () => {
    completedRun()
    vi.spyOn(defaultGitRunner, 'run').mockResolvedValue({ code: 0, stdout: 'a'.repeat(40), stderr: '' })
    const messages: Array<{ type: string }> = []
    const run = vi.fn(() => new Promise<never>(() => {}))
    const onRailLaunch = vi.fn()
    const res = await request(appWith({ broadcast: (m) => messages.push(m as { type: string }), loopRunManager: { run, cancel: vi.fn() }, onRailLaunch }))
      .post('/rails/0/relaunch').send({ sourceId: 'run:old-run' })
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect(res.body).toMatchObject({ railIndex: 0, mode: 'implement', isolationUnavailable: 'no-git' })
    expect(res.body.loopRunIds).toHaveLength(1)
    expect(res.body.runIds).toEqual(res.body.loopRunIds)
    expect(getRail(db, 0).ticketIds).toEqual([4])
    expect(messages[0]).toMatchObject({ type: 'rail.updated' })
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0]).toMatchObject({ railIndex: 0, ticketId: 4, loopId: 'factory:implement', ticketCompletionStatus: 'on_review' })
    expect(onRailLaunch).toHaveBeenCalledWith([4], res.body.loopRunIds[0])
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })

  it('maps a rail edited during the shared-cwd preflight to the relaunch error (outer handler)', async () => {
    completedRun()
    mockRepoStatus.mockImplementationOnce(async () => { setRailTickets(db, 0, [99], 'implement'); return 'no-git' })
    const run = vi.fn()
    const res = await request(appWith({ loopRunManager: { run, cancel: vi.fn() } })).post('/rails/0/relaunch').send({ sourceId: 'run:old-run' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'relaunch_rail_changed', detail: 'This rail now contains different specs. Relaunch has not changed or launched them.',
      action: expect.any(String) })
    expect(getRail(db, 0).ticketIds).toEqual([99])
    expect(run).not.toHaveBeenCalled()
  })
})

describe('launch door — legacy queue job and outer error mapping (loops off)', () => {
  beforeEach(() => {
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    setRailTickets(db, 0, [1, 2], 'implement')
  })

  it('enqueues one implement job, registers it, then broadcasts rail.job_started', async () => {
    const messages: unknown[] = []
    const railJobs = new Map()
    const enqueue = vi.fn(() => ({ id: 'job-1' }))
    const onRailLaunch = vi.fn()
    const res = await request(appWith({ queueManager: { enqueue }, broadcast: (m) => messages.push(m), railJobs, onRailLaunch }))
      .post('/rails/0/launch').send({})
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ jobId: 'job-1', railIndex: 0, mode: 'implement' })
    expect(enqueue).toHaveBeenCalledWith('/specrails:implement #1 #2 --yes', 'normal', { profileName: undefined, provider: undefined })
    expect(railJobs.get('job-1')).toEqual({ railIndex: 0, mode: 'implement', ticketIds: [1, 2] })
    expect(onRailLaunch).toHaveBeenCalledWith([1, 2], 'job-1')
    expect(messages.at(-1)).toEqual({ type: 'rail.job_started', projectId: 'p1', railIndex: 0, jobId: 'job-1', mode: 'implement' })
  })

  it.each([
    [new ClaudeNotFoundError(), 503, { error: 'Claude CLI not found' }],
    [new CodexNotFoundError(), 503, { error: 'Codex CLI not found' }],
    [new Error('boom'), 500, { error: 'Failed to launch rail job' }],
  ])('maps enqueue failure %s', async (error, status, body) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const enqueue = vi.fn(() => { throw error })
    const res = await request(appWith({ queueManager: { enqueue } })).post('/rails/0/launch').send({})
    expect(res.status).toBe(status)
    expect(res.body).toEqual(body)
  })
})
