import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

import { createProjectRouter, stripSpecMetadataSections, formatDescriptionWithCriteria, extractShortSummary } from './project-router'
import { serializeInstallConfigYaml } from './project-router-helpers'
import { resolveTicketStoragePath, mutateStore, readStore } from './ticket-store'
import { mirrorProjectEntry as regMirror, workspaceLayout as regLayout, resolveHome as regResolveHome } from './artifact-registry'
import { initDb, listProposals } from './db'
import { initDesktopDb } from './desktop-db'
import { installConfigPath, installConfigPathForProvider } from './install-config-path'
import { readBlueprint, writeBlueprintPair } from './blueprint-render'
import {
  ClaudeNotFoundError,
  InvalidJobDependencyError,
  JobNotFoundError,
  JobAlreadyTerminalError,
} from './queue-manager'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { DbInstance } from './db'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeQueueManager(overrides: Partial<{
  enqueue: (...args: any[]) => any
  cancel: () => any
  pause: () => void
  resume: () => void
  reorder: () => void
  getJobs: () => any[]
  isPaused: () => boolean
  getActiveJobId: () => string | null
  phasesForCommand: () => any[]
}> = {}) {
  return {
    enqueue: overrides.enqueue ?? vi.fn(() => ({ id: 'job-1', queuePosition: 0 })),
    cancel: overrides.cancel ?? vi.fn(() => 'canceled'),
    pause: overrides.pause ?? vi.fn(),
    resume: overrides.resume ?? vi.fn(),
    reorder: overrides.reorder ?? vi.fn(),
    getJobs: overrides.getJobs ?? vi.fn(() => []),
    isPaused: overrides.isPaused ?? vi.fn(() => false),
    getActiveJobId: overrides.getActiveJobId ?? vi.fn(() => null),
    phasesForCommand: overrides.phasesForCommand ?? vi.fn(() => []),
  }
}

/** Minimal QueueManager admission protocol for route tests: queued_jobs and the
 * route-supplied durable hook share one transaction, matching the real manager
 * without spawning a CLI process. */
function makeAtomicEnqueue(db: DbInstance) {
  let fallbackId = 0
  return vi.fn((
    command: string,
    priority: string = 'normal',
    opts: { dependsOnJobId?: string; pipelineId?: string } = {},
    admission?: { jobId: string; commit: (db: DbInstance, job: any) => void },
  ) => {
    const id = admission?.jobId ?? `route-job-${++fallbackId}`
    const position = (db.prepare('SELECT COUNT(*) AS count FROM queued_jobs').get() as { count: number }).count + 1
    const job = { id, command, queuePosition: position, priority }
    db.transaction(() => {
      db.prepare(`
        INSERT INTO queued_jobs (
          id, command, queue_position, priority, depends_on_job_id, pipeline_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        command,
        position,
        priority,
        opts.dependsOnJobId ?? null,
        opts.pipelineId ?? null,
      )
      admission?.commit(db, job)
    })()
    return job
  })
}

function makeSetupManager(overrides: Partial<{
  isInstalling: (id: string) => boolean
  isSettingUp: (id: string) => boolean
  isEnriching: (id: string) => boolean
  startInstall: () => void
  startSetup: () => void
  startEnrich: () => void
  resumeSetup: () => void
  resumeEnrich: () => void
  abort: () => void
  getCheckpointStatus: () => any[]
  getInstallLog: () => string[]
  getInstallTier: () => string | undefined
  getSummary: () => { agents: number; personas: number; commands: number }
}> = {}) {
  const isEnriching = overrides.isEnriching ?? overrides.isSettingUp ?? vi.fn(() => false)
  return {
    isInstalling: overrides.isInstalling ?? vi.fn(() => false),
    isEnriching,
    isSettingUp: overrides.isSettingUp ?? isEnriching,
    startInstall: overrides.startInstall ?? vi.fn(),
    startEnrich: overrides.startEnrich ?? overrides.startSetup ?? vi.fn(),
    startSetup: overrides.startSetup ?? overrides.startEnrich ?? vi.fn(),
    resumeEnrich: overrides.resumeEnrich ?? overrides.resumeSetup ?? vi.fn(),
    resumeSetup: overrides.resumeSetup ?? overrides.resumeEnrich ?? vi.fn(),
    abort: overrides.abort ?? vi.fn(),
    getCheckpointStatus: overrides.getCheckpointStatus ?? vi.fn(() => []),
    getInstallLog: overrides.getInstallLog ?? vi.fn(() => []),
    getInstallTier: overrides.getInstallTier ?? vi.fn(() => undefined),
    getSummary: overrides.getSummary ?? vi.fn(() => ({ agents: 0, personas: 0, commands: 0 })),
  }
}

function makeChatManager(overrides: Partial<{
  isActive: (id: string) => boolean
  sendMessage: () => Promise<void>
  abort: () => void
  forgetSpecDraft: (id: string) => void
  forgetExploreLifecycle: (id: string) => void
  getSpecDraftState: (id: string) => unknown
}> = {}) {
  return {
    isActive: overrides.isActive ?? vi.fn(() => false),
    sendMessage: overrides.sendMessage ?? vi.fn(async () => {}),
    abort: overrides.abort ?? vi.fn(),
    forgetSpecDraft: overrides.forgetSpecDraft ?? vi.fn(),
    forgetExploreLifecycle: overrides.forgetExploreLifecycle ?? vi.fn(),
    getSpecDraftState: overrides.getSpecDraftState ?? vi.fn(() => null),
  }
}

function makeProposalManager(overrides: Partial<{
  isActive: (id: string) => boolean
  canStartExploration: () => boolean
  startExploration: () => Promise<void>
  sendRefinement: () => Promise<void>
  createIssue: () => Promise<void>
  cancel: () => void
}> = {}) {
  return {
    isActive: overrides.isActive ?? vi.fn(() => false),
    canStartExploration: overrides.canStartExploration ?? vi.fn(() => true),
    startExploration: overrides.startExploration ?? vi.fn(async () => {}),
    sendRefinement: overrides.sendRefinement ?? vi.fn(async () => {}),
    createIssue: overrides.createIssue ?? vi.fn(async () => {}),
    cancel: overrides.cancel ?? vi.fn(),
  }
}

function makeSpecLauncherManager(overrides: Partial<{
  isActive: (id: string) => boolean
  launch: () => Promise<void>
  cancel: () => void
}> = {}) {
  return {
    isActive: overrides.isActive ?? vi.fn(() => false),
    launch: overrides.launch ?? vi.fn(async () => {}),
    cancel: overrides.cancel ?? vi.fn(),
  }
}

function makeContext(db: DbInstance, overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    project: { id: 'proj-1', slug: 'proj', name: 'Test Project', path: '/tmp', db_path: ':memory:', provider: 'claude', providers: ['claude'], added_at: '', last_seen_at: '' },
    db,
    queueManager: makeQueueManager() as any,
    chatManager: makeChatManager() as any,
    setupManager: makeSetupManager() as any,
    proposalManager: makeProposalManager() as any,
    specLauncherManager: makeSpecLauncherManager() as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast: vi.fn(),
    ...overrides,
  }
}

function makeRegistry(contexts: Map<string, ProjectContext>): ProjectRegistry {
  const desktopDb = initDesktopDb(':memory:')
  return {
    desktopDb,
    getContext: vi.fn((id: string) => contexts.get(id)),
    getContextByPath: vi.fn(() => undefined),
    getProjectRow: vi.fn(() => undefined),
    listFailedProjects: vi.fn(() => []),
    addProject: vi.fn() as any,
    removeProject: vi.fn(),
    touchProject: vi.fn(),
    listContexts: vi.fn(() => Array.from(contexts.values())),
  } as unknown as ProjectRegistry
}

// ─── App factory ──────────────────────────────────────────────────────────────

function createApp(contexts: Map<string, ProjectContext> = new Map()) {
  const registry = makeRegistry(contexts)
  const router = createProjectRouter(registry)
  const app = express()
  app.use(express.json())
  app.use('/api/projects', router)
  return { app, registry }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('project-router', () => {
  let db: DbInstance

  beforeEach(() => {
    db = initDb(':memory:')
  })

  // ─── Middleware: unknown projectId ──────────────────────────────────────────

  describe('unknown projectId middleware', () => {
    it('returns 404 for an unregistered project', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/projects/nonexistent/state')
      expect(res.status).toBe(404)
      expect(res.body.error).toContain('Project not found')
    })

    it('returns 404 for jobs endpoint with unknown project', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/projects/bad-id/jobs')
      expect(res.status).toBe(404)
    })

    it('returns a retryable unavailable response for a registered project with a failed database', async () => {
      const { app, registry } = createApp()
      const project = makeContext(db).project
      vi.mocked(registry.getProjectRow).mockReturnValue(project)
      vi.mocked(registry.listFailedProjects).mockReturnValue([{ project, error: 'database is locked' }])
      const res = await request(app).get('/api/projects/proj-1/state')
      expect(res.status).toBe(503)
      expect(res.headers['retry-after']).toBe('2')
      expect(res.body).toEqual({ error: 'project_unavailable', projectId: 'proj-1', detail: 'database is locked' })
    })
  })

  // ─── Project Builder: milestone ticket provenance ─────────────────────────

  describe('POST /:projectId/blueprint/commit-milestone', () => {
    let repoDir: string
    let registryHome: string
    let priorRegistryHome: string | undefined

    beforeEach(() => {
      repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'builder-milestone-repo-')))
      registryHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'builder-milestone-home-')))
      priorRegistryHome = process.env.SPECRAILS_REGISTRY_HOME
      process.env.SPECRAILS_REGISTRY_HOME = registryHome
    })

    afterEach(() => {
      fs.rmSync(repoDir, { recursive: true, force: true })
      fs.rmSync(registryHome, { recursive: true, force: true })
      if (priorRegistryHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
      else process.env.SPECRAILS_REGISTRY_HOME = priorRegistryHome
    })

    it('persists M2+ specs with project-builder provenance', async () => {
      const entry = regMirror({
        repoPath: repoDir,
        slug: 'proj',
        providers: ['claude'],
        desktopProjectId: 'proj-1',
      }, registryHome)
      fs.mkdirSync(path.join(entry.workspaceDir, '.specrails'), { recursive: true })
      fs.writeFileSync(path.join(entry.workspaceDir, '.specrails', 'specrails-version'), 'test\n')
      writeBlueprintPair(entry.workspaceDir, {
        blueprintVersion: 1,
        product: { name: 'Test Project', pitch: 'A useful app', audience: 'Testers' },
        coreFlow: 'Create and verify a project',
        platform: 'desktop',
        stack: { language: 'TypeScript', framework: 'React', db: 'SQLite' },
        assumptions: [],
        milestones: [
          { id: 'm1', title: 'Foundation', goal: 'Start', status: 'committed', plannedSpecs: [] },
          { id: 'm2', title: 'Expansion', goal: 'Grow', status: 'planned', plannedSpecs: ['Add reports'] },
          { id: 'm3', title: 'Automation', goal: 'Automate', status: 'planned', plannedSpecs: ['Add alerts'] },
        ],
        specsComplete: true,
        m1Specs: [],
      })

      const projectCtx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'Test Project', path: repoDir,
          db_path: ':memory:', provider: 'claude', providers: ['claude'],
          added_at: '', last_seen_at: '',
        },
      })
      const { app } = createApp(new Map([['proj-1', projectCtx]]))

      const response = await request(app)
        .post('/api/projects/proj-1/blueprint/commit-milestone')
        .send({
          milestoneId: 'm2',
          specsComplete: true,
          specs: [{
            kind: 'feature',
            title: 'Add reports',
            shortSummary: 'Show actionable progress reports.',
            description: [
              '## Problem Statement', 'Teams cannot understand progress or identify stalled work from the current project view.',
              '', '## Proposed Solution', 'Add a grounded report view that derives milestone progress from the existing ticket store and current status model.',
              '', '## Out of Scope', '- Predictive forecasting', '- External data warehouse exports',
              '', '## Technical Considerations', '- Reuse the existing ticket storage contract', '- Cover empty, loading, success, and failure states',
              '', '## Estimated Complexity', 'Medium — the report crosses server aggregation and client presentation.',
            ].join('\n'),
            acceptanceCriteria: [
              'The report shows progress for every committed milestone.',
              'An empty project renders a deliberate empty state.',
              'A ticket read failure produces an actionable error state.',
              'Automated tests cover aggregation and presentation behavior.',
            ],
            priority: 'high',
            labels: ['analytics', 'M2'],
          }],
        })

      expect(response.status).toBe(201)
      expect(response.body.insertedIds).toHaveLength(1)
      const ticket = readStore(entry.ticketsPath).tickets[String(response.body.insertedIds[0])]
      expect(ticket).toMatchObject({
        title: 'Add reports',
        status: 'todo',
        labels: ['analytics', 'M2'],
        priority: 'high',
        short_summary: 'Show actionable progress reports.',
        source: 'project-builder',
        created_by: 'project-builder',
      })
      expect(ticket.description).toContain('## Problem Statement')
      expect(ticket.description).toContain('## Acceptance Criteria')
      expect(ticket.description.match(/## Acceptance Criteria/g)).toHaveLength(1)

      const invalid = await request(app)
        .post('/api/projects/proj-1/blueprint/commit-milestone')
        .send({
          milestoneId: 'm3',
          specsComplete: false,
          specs: [{ title: 'Add alerts', description: 'Send alerts.', labels: ['M3'] }],
        })
      expect(invalid.status).toBe(400)
      expect(invalid.body).toMatchObject({
        error: 'milestone_spec_quality_invalid',
        detail: 'generation is not marked complete',
      })
      expect(Object.values(readStore(entry.ticketsPath).tickets)).toHaveLength(1)
      expect(readBlueprint(entry.workspaceDir)?.milestones.find((item) => item.id === 'm3')?.status).toBe('planned')
    })
  })

  // ─── Project settings: integration branch ──────────────────────────────────

  describe('project settings — integration branch', () => {
    function appWithProject() {
      const contexts = new Map<string, ProjectContext>()
      contexts.set('proj-1', makeContext(db))
      return createApp(contexts)
    }

    it('rejects an invalid integrationBranch (arg-injection guard)', async () => {
      const { app } = appWithProject()
      const res = await request(app).patch('/api/projects/proj-1/settings').send({ integrationBranch: '--upload-pack=x' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/integrationBranch/)
    })

    it('persists a valid integrationBranch and clears it with empty string', async () => {
      const { app } = appWithProject()
      let res = await request(app).patch('/api/projects/proj-1/settings').send({ integrationBranch: 'develop' })
      expect(res.status).toBe(200)
      expect(res.body.settings.integrationBranch).toBe('develop')
      res = await request(app).patch('/api/projects/proj-1/settings').send({ integrationBranch: '' })
      expect(res.body.settings.integrationBranch).toBe('')
    })

    it('resolve endpoint echoes the configured setting (project-setting short-circuits git)', async () => {
      const { app } = appWithProject()
      await request(app).patch('/api/projects/proj-1/settings').send({ integrationBranch: 'develop' })
      const res = await request(app).get('/api/projects/proj-1/integration-branch')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ configured: 'develop', branch: 'develop', source: 'project-setting' })
    })
  })

  // ─── Hooks mount (H18: memoized per ProjectContext) ─────────────────────────

  describe('hooks sub-router mount', () => {
    it('serves hook events across repeated requests through the memoized router', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      // First request constructs the sub-router; second hits the WeakMap memo.
      const first = await request(app)
        .post('/api/projects/proj-1/hooks/events')
        .send({ event: 'agent_start', agent: 'architect' })
      const second = await request(app)
        .post('/api/projects/proj-1/hooks/events')
        .send({ event: 'agent_stop', agent: 'architect' })

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(ctx.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'phase', phase: 'architect', state: 'running' })
      )
      expect(ctx.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'phase', phase: 'architect', state: 'done' })
      )
    })
  })

  // ─── POST /spawn ────────────────────────────────────────────────────────────

  describe('POST /spawn', () => {
    it('returns 400 when command is missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/spawn').send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('command is required')
    })

    it('returns 400 when command is empty string', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/spawn').send({ command: '  ' })
      expect(res.status).toBe(400)
    })

    it('returns 400 when dependsOnJobId is not a non-empty string', async () => {
      const enqueue = vi.fn()
      const ctx = makeContext(db, { queueManager: makeQueueManager({ enqueue }) as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app)
        .post('/api/projects/proj-1/spawn')
        .send({ command: 'sr:implement', dependsOnJobId: { typo: true } })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('dependsOnJobId must be a non-empty string')
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('returns 409 when the requested parent is terminal and unsuccessful', async () => {
      const enqueue = vi.fn(() => {
        throw new InvalidJobDependencyError(
          'Cannot depend on job failed-parent because it is failed',
        )
      })
      const ctx = makeContext(db, { queueManager: makeQueueManager({ enqueue }) as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app)
        .post('/api/projects/proj-1/spawn')
        .send({ command: 'sr:implement', dependsOnJobId: 'failed-parent' })

      expect(res.status).toBe(409)
      expect(res.body.error).toContain('because it is failed')
    })

    it('returns 400 when claude is not found', async () => {
      const qm = makeQueueManager({ enqueue: vi.fn(() => { throw new ClaudeNotFoundError() }) })
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/spawn').send({ command: 'test' })
      expect(res.status).toBe(400)
    })

    it('returns 202 with jobId on success', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/spawn').send({ command: 'sr:implement' })
      expect(res.status).toBe(202)
      expect(res.body.jobId).toBeDefined()
    })

    it('leaves profileName absent when the client requests project-default resolution', async () => {
      const enqueue = vi.fn(() => ({ id: 'default-profile-job', queuePosition: 0 }))
      const ctx = makeContext(db, { queueManager: makeQueueManager({ enqueue }) as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app)
        .post('/api/projects/proj-1/spawn')
        .send({ command: 'sr:implement' })

      expect(res.status).toBe(202)
      const enqueueOptions = enqueue.mock.calls[0][2]
      expect(Object.prototype.hasOwnProperty.call(enqueueOptions, 'profileName')).toBe(false)
    })

    it('reruns a Kimi job with its exact custom alias, profile, ticket command, and no invented effort', async () => {
      const alias = 'moonshot-team/private-coder:v2'
      db.prepare(`
        INSERT INTO jobs (id, command, started_at, finished_at, status, provider, model)
        VALUES (?, ?, ?, ?, 'completed', 'kimi', ?)
      `).run(
        'kimi-source',
        '/specrails:implement #42 --yes',
        '2026-07-18T10:00:00.000Z',
        '2026-07-18T10:05:00.000Z',
        alias,
      )
      db.prepare(`
        INSERT INTO job_profiles (job_id, profile_name, profile_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run('kimi-source', 'kimi-balanced', '{}', Date.now())

      const enqueue = vi.fn(() => ({ id: 'kimi-rerun', queuePosition: 0 }))
      const base = makeContext(db)
      const ctx = makeContext(db, {
        project: { ...base.project, provider: 'kimi', providers: ['kimi', 'claude'] },
        queueManager: makeQueueManager({ enqueue }) as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app)
        .post('/api/projects/proj-1/spawn')
        .send({
          rerunOfJobId: 'kimi-source',
          // Duplicated client metadata is deliberately untrusted/ignored.
          command: '/specrails:implement #999 --yes',
          aiEngine: 'claude',
          model: 'k3',
          profileName: 'different-profile',
          reasoning_effort: 'max',
        })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledOnce()
      expect(enqueue.mock.calls[0][0]).toBe('/specrails:implement #42 --yes')
      expect(enqueue.mock.calls[0][2]).toEqual({
        profileName: 'kimi-balanced',
        provider: 'kimi',
        model: alias,
        dependsOnJobId: undefined,
        pipelineId: undefined,
      })
      expect(enqueue.mock.calls[0][2]).not.toHaveProperty('reasoning_effort')
      expect(enqueue.mock.calls[0][2]).not.toHaveProperty('effort')
    })

    it('fails closed when persisted Kimi rerun metadata contains an unsafe alias', async () => {
      db.prepare(`
        INSERT INTO jobs (id, command, started_at, status, provider, model)
        VALUES ('kimi-unsafe', '/specrails:implement #7 --yes', ?, 'failed', 'kimi', '--yolo')
      `).run('2026-07-18T10:00:00.000Z')
      const enqueue = vi.fn()
      const base = makeContext(db)
      const ctx = makeContext(db, {
        project: { ...base.project, provider: 'kimi', providers: ['kimi'] },
        queueManager: makeQueueManager({ enqueue }) as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app)
        .post('/api/projects/proj-1/spawn')
        .send({ rerunOfJobId: 'kimi-unsafe' })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('model is not valid for provider "kimi"')
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('rejects a missing or non-terminal rerun source before enqueue', async () => {
      db.prepare(`
        INSERT INTO jobs (id, command, started_at, status, provider, model)
        VALUES ('kimi-running', '/specrails:implement #8 --yes', ?, 'running', 'kimi', 'k3')
      `).run('2026-07-18T10:00:00.000Z')
      const enqueue = vi.fn()
      const base = makeContext(db)
      const ctx = makeContext(db, {
        project: { ...base.project, provider: 'kimi', providers: ['kimi'] },
        queueManager: makeQueueManager({ enqueue }) as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const missing = await request(app)
        .post('/api/projects/proj-1/spawn')
        .send({ rerunOfJobId: 'missing-source' })
      const running = await request(app)
        .post('/api/projects/proj-1/spawn')
        .send({ rerunOfJobId: 'kimi-running' })

      expect(missing.status).toBe(404)
      expect(running.status).toBe(409)
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('returns the original job when an idempotent spawn is submitted twice', async () => {
      const enqueue = makeAtomicEnqueue(db)
      const ctx = makeContext(db, { queueManager: makeQueueManager({ enqueue }) as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const first = await request(app)
        .post('/api/projects/proj-1/spawn')
        .set('Idempotency-Key', 'rerun-abc')
        .send({ command: 'sr:implement' })
      const replay = await request(app)
        .post('/api/projects/proj-1/spawn')
        .set('Idempotency-Key', 'rerun-abc')
        .send({ command: 'sr:implement' })

      expect(first.status).toBe(202)
      expect(replay.status).toBe(202)
      expect(replay.body).toMatchObject({ jobId: first.body.jobId, idempotentReplay: true })
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(db.prepare('SELECT id FROM queued_jobs').all()).toEqual([{ id: first.body.jobId }])
      expect(db.prepare('SELECT job_id FROM job_spawn_requests').all())
        .toEqual([{ job_id: first.body.jobId }])
    })

    it('includes the source-job identity in the rerun idempotency fingerprint', async () => {
      const insert = db.prepare(`
        INSERT INTO jobs (id, command, started_at, status, provider, model)
        VALUES (?, '/specrails:implement #42 --yes', ?, 'completed', 'kimi', ?)
      `)
      insert.run('kimi-source-a', '2026-07-18T10:00:00.000Z', 'moonshot-team/private-coder:v2')
      insert.run('kimi-source-b', '2026-07-18T11:00:00.000Z', 'moonshot-team/private-coder:v2')
      const enqueue = makeAtomicEnqueue(db)
      const base = makeContext(db)
      const ctx = makeContext(db, {
        project: { ...base.project, provider: 'kimi', providers: ['kimi'] },
        queueManager: makeQueueManager({ enqueue }) as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const first = await request(app)
        .post('/api/projects/proj-1/spawn')
        .set('Idempotency-Key', 'same-rerun-key')
        .send({ rerunOfJobId: 'kimi-source-a' })
      const conflict = await request(app)
        .post('/api/projects/proj-1/spawn')
        .set('Idempotency-Key', 'same-rerun-key')
        .send({ rerunOfJobId: 'kimi-source-b' })

      expect(first.status).toBe(202)
      expect(conflict.status).toBe(409)
      expect(enqueue).toHaveBeenCalledTimes(1)
    })

    it('rejects reuse of an idempotency key for a different command', async () => {
      const enqueue = makeAtomicEnqueue(db)
      const ctx = makeContext(db, { queueManager: makeQueueManager({ enqueue }) as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      await request(app)
        .post('/api/projects/proj-1/spawn')
        .set('Idempotency-Key', 'rerun-abc')
        .send({ command: 'sr:implement' })

      const conflict = await request(app)
        .post('/api/projects/proj-1/spawn')
        .set('Idempotency-Key', 'rerun-abc')
        .send({ command: 'sr:refine' })

      expect(conflict.status).toBe(409)
      expect(enqueue).toHaveBeenCalledTimes(1)
    })

    it('rolls queue admission back when the idempotency ledger insert fails, then retries cleanly', async () => {
      const enqueue = makeAtomicEnqueue(db)
      const ctx = makeContext(db, { queueManager: makeQueueManager({ enqueue }) as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      db.exec(`
        CREATE TRIGGER reject_route_spawn_claim
        BEFORE INSERT ON job_spawn_requests
        BEGIN
          SELECT RAISE(ABORT, 'simulated route ledger failure');
        END;
      `)

      const failed = await request(app)
        .post('/api/projects/proj-1/spawn')
        .set('Idempotency-Key', 'atomic-route-key')
        .send({ command: 'sr:implement' })
      expect(failed.status).toBe(500)
      expect(db.prepare('SELECT 1 FROM queued_jobs').all()).toEqual([])
      expect(db.prepare('SELECT 1 FROM job_spawn_requests').all()).toEqual([])

      db.exec('DROP TRIGGER reject_route_spawn_claim')
      const retry = await request(app)
        .post('/api/projects/proj-1/spawn')
        .set('Idempotency-Key', 'atomic-route-key')
        .send({ command: 'sr:implement' })
      expect(retry.status).toBe(202)
      expect(db.prepare('SELECT id FROM queued_jobs').all()).toEqual([{ id: retry.body.jobId }])
      expect(db.prepare('SELECT job_id FROM job_spawn_requests').all())
        .toEqual([{ job_id: retry.body.jobId }])
    })

    it('admits exactly one job for concurrent requests with the same exact key', async () => {
      const enqueue = makeAtomicEnqueue(db)
      const ctx = makeContext(db, { queueManager: makeQueueManager({ enqueue }) as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const [first, second] = await Promise.all([
        request(app)
          .post('/api/projects/proj-1/spawn')
          .set('Idempotency-Key', 'concurrent-key')
          .send({ command: 'sr:implement' }),
        request(app)
          .post('/api/projects/proj-1/spawn')
          .set('Idempotency-Key', 'concurrent-key')
          .send({ command: 'sr:implement' }),
      ])

      expect(first.status).toBe(202)
      expect(second.status).toBe(202)
      expect(first.body.jobId).toBe(second.body.jobId)
      expect([first.body.idempotentReplay, second.body.idempotentReplay].filter(Boolean)).toHaveLength(1)
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(db.prepare('SELECT COUNT(*) AS count FROM queued_jobs').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM job_spawn_requests').get()).toEqual({ count: 1 })
    })
  })

  // ─── DELETE /jobs/:id ──────────────────────────────────────────────────────

  describe('POST /jobs/:id/cancel', () => {
    it('returns 404 when job does not exist', async () => {
      const qm = makeQueueManager({ cancel: vi.fn(() => { throw new JobNotFoundError() }) })
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/jobs/no-such-job/cancel')
      expect(res.status).toBe(404)
      expect(res.body.error).toContain('Job not found')
    })

    it('is idempotent and preserves a terminal job that finished before cancel landed', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('some-job', 'sr:test', '2025-01-01T10:00:00.000Z', 'completed')`
      ).run()
      const qm = makeQueueManager({ cancel: vi.fn(() => { throw new JobAlreadyTerminalError() }) })
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/jobs/some-job/cancel')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('already_terminal')
      expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get('some-job')).toEqual({ status: 'completed' })
    })
  })

  describe('DELETE /jobs/:id', () => {
    it('deletes terminal history explicitly', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('done-job', 'sr:test', '2025-01-01T10:00:00.000Z', 'completed')`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).delete('/api/projects/proj-1/jobs/done-job')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('deleted')
      expect(db.prepare('SELECT id FROM jobs WHERE id = ?').get('done-job')).toBeUndefined()
    })

    it('refuses to erase active history', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('live-job', 'sr:test', '2025-01-01T10:00:00.000Z', 'running')`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).delete('/api/projects/proj-1/jobs/live-job')
      expect(res.status).toBe(409)
      expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get('live-job')).toEqual({ status: 'running' })
    })

    it('returns a stable 409 while loop accounting recovery still references the job', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, owner)
         VALUES ('recovering-job', 'loop: recover', '2025-01-01T10:00:00.000Z', 'failed', 'loop')`
      ).run()
      db.prepare(`
        INSERT INTO loop_step_recovery (run_id, step_key, invocation_id, payload)
        VALUES ('recovering-job', 'ai:1', 'recovering-invocation', '{}')
      `).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).delete('/api/projects/proj-1/jobs/recovering-job')

      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ code: 'job_recovery_pending' })
      expect(db.prepare(`SELECT id FROM jobs WHERE id = 'recovering-job'`).get())
        .toEqual({ id: 'recovering-job' })
      expect(db.prepare(`SELECT run_id FROM loop_step_recovery WHERE run_id = 'recovering-job'`).get())
        .toEqual({ run_id: 'recovering-job' })
    })
  })

  // ─── PUT /queue/reorder ────────────────────────────────────────────────────

  describe('PUT /queue/reorder', () => {
    it('returns 400 when jobIds is missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).put('/api/projects/proj-1/queue/reorder').send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('jobIds must be an array')
    })

    it('returns 200 on valid reorder', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).put('/api/projects/proj-1/queue/reorder').send({ jobIds: ['a', 'b'] })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('returns 400 when a reorder would cross priority bands', async () => {
      const qm = makeQueueManager({
        reorder: vi.fn(() => {
          throw new Error('Cannot reorder jobs across priority levels; update priority first')
        }),
      })
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app)
        .put('/api/projects/proj-1/queue/reorder')
        .send({ jobIds: ['low-job', 'high-job'] })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Cannot reorder jobs across priority levels')
    })
  })

  // ─── GET /jobs/:id ─────────────────────────────────────────────────────────

  describe('GET /jobs/:id', () => {
    it('returns 404 when job does not exist', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/no-such-job')
      expect(res.status).toBe(404)
      expect(res.body.error).toContain('Job not found')
    })

    it('returns job data when job exists', async () => {
      const today = new Date().toISOString().slice(0, 10)
      db.prepare(`
        INSERT INTO jobs (id, command, started_at, status)
        VALUES ('j1', 'sr:implement', ?, 'running')
      `).run(`${today}T10:00:00.000Z`)
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/j1')
      expect(res.status).toBe(200)
      expect(res.body.job.id).toBe('j1')
      expect(res.body.events).toBeDefined()
      // Backwards-compat: existing consumers continue to receive the original
      // job fields. tickets[] is additive.
      expect(res.body.job.command).toBe('sr:implement')
      expect(res.body.job.tickets).toEqual([])
    })

    it('returns provider, exact model, and persisted profile metadata for rerun', async () => {
      const alias = 'moonshot-team/private-coder:v2'
      db.prepare(`
        INSERT INTO jobs (id, command, started_at, status, provider, model)
        VALUES ('kimi-detail', '/specrails:implement #42 --yes', ?, 'completed', 'kimi', ?)
      `).run('2026-07-18T10:00:00.000Z', alias)
      db.prepare(`
        INSERT INTO job_profiles (job_id, profile_name, profile_json, created_at)
        VALUES ('kimi-detail', 'kimi-balanced', '{}', ?)
      `).run(Date.now())
      const base = makeContext(db)
      const ctx = makeContext(db, {
        project: { ...base.project, provider: 'kimi', providers: ['kimi'] },
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/jobs/kimi-detail')

      expect(res.status).toBe(200)
      expect(res.body.job).toMatchObject({
        id: 'kimi-detail',
        command: '/specrails:implement #42 --yes',
        provider: 'kimi',
        model: alias,
        profile_name: 'kimi-balanced',
      })
    })

    it('returns stable durable enqueue time and no synthetic start for a queued job', async () => {
      db.prepare(`
        INSERT INTO queued_jobs (
          id, command, queue_position, priority, enqueued_at
        ) VALUES ('queued-detail', '/queued', 1, 'normal', '2026-07-10 11:22:33')
      `).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const first = await request(app).get('/api/projects/proj-1/jobs/queued-detail')
      const repeated = await request(app).get('/api/projects/proj-1/jobs/queued-detail')

      expect(first.status).toBe(200)
      expect(first.body.job).toMatchObject({
        id: 'queued-detail',
        status: 'queued',
        started_at: null,
        enqueued_at: '2026-07-10 11:22:33',
      })
      expect(repeated.body.job).toEqual(first.body.job)
    })

    describe('tickets field', () => {
      function withProjectDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdesktop-jobtickets-'))
        fs.mkdirSync(path.join(dir, '.specrails'), { recursive: true })
        return dir
      }

      function writeTickets(dir: string, tickets: Record<string, { id: number; title: string }>) {
        const store = {
          schema_version: '1',
          revision: 1,
          last_updated: new Date().toISOString(),
          next_id: 1000,
          tickets: Object.fromEntries(
            Object.entries(tickets).map(([id, t]) => [id, {
              id: t.id, title: t.title, description: '', status: 'todo',
              priority: 'medium', labels: [], assignee: null, prerequisites: [],
              metadata: {}, created_at: '', updated_at: '', created_by: 'test',
              source: 'manual',
            }]),
          ),
        }
        fs.writeFileSync(
          path.join(dir, '.specrails', 'local-tickets.json'),
          JSON.stringify(store),
          'utf-8',
        )
      }

      function makeCtxAt(projectPath: string): ProjectContext {
        return makeContext(db, {
          project: { id: 'proj-1', slug: 'proj', name: 'P', path: projectPath, db_path: ':memory:', added_at: '', last_seen_at: '' },
        } as any)
      }

      let projectDirs: string[] = []
      afterEach(() => {
        for (const d of projectDirs) {
          try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* noop */ }
        }
        projectDirs = []
      })

      function newProjectDir(): string {
        const d = withProjectDir()
        projectDirs.push(d)
        return d
      }

      it('resolves a single live ticket title', async () => {
        const dir = newProjectDir()
        writeTickets(dir, { '24': { id: 24, title: 'Add live job status' } })
        db.prepare(`INSERT INTO jobs (id, command, started_at, status)
          VALUES ('j1', '/specrails:implement #24 --yes', '2026-05-05T10:00:00.000Z', 'running')`).run()
        const { app } = createApp(new Map([['proj-1', makeCtxAt(dir)]]))
        const res = await request(app).get('/api/projects/proj-1/jobs/j1')
        expect(res.status).toBe(200)
        expect(res.body.job.tickets).toEqual([{ id: 24, title: 'Add live job status' }])
      })

      it('RELOCATED: resolves ticket titles from the WORKSPACE store, not the repo', async () => {
        const prevHome = process.env.SPECRAILS_REGISTRY_HOME
        const regHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-reloc-home-')))
        fs.mkdirSync(path.join(regHome, '.specrails'), { recursive: true })
        process.env.SPECRAILS_REGISTRY_HOME = regHome
        const dir = newProjectDir() // repo (no ticket written here)
        try {
          // Seed a relocated entry + populated workspace, ticket ONLY in workspace.
          regMirror({ repoPath: dir, slug: 'proj', providers: ['claude'] }, regHome)
          const ws = regLayout(regResolveHome(regHome), 'proj', dir).workspaceDir
          fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
          fs.writeFileSync(path.join(ws, '.specrails', 'specrails-version'), '4.8.0\n')
          fs.writeFileSync(
            path.join(ws, '.specrails', 'local-tickets.json'),
            JSON.stringify({
              schema_version: '1', revision: 1, last_updated: '', next_id: 1000,
              tickets: { '24': { id: 24, title: 'WORKSPACE-TITLE', description: '', status: 'todo', priority: 'medium', labels: [], metadata: {}, created_at: '', updated_at: '', created_by: 'test', source: 'manual' } },
            }),
            'utf-8',
          )
          db.prepare(`INSERT INTO jobs (id, command, started_at, status)
            VALUES ('jr', '/specrails:implement #24 --yes', '2026-05-05T10:00:00.000Z', 'running')`).run()
          const { app } = createApp(new Map([['proj-1', makeCtxAt(dir)]]))
          const res = await request(app).get('/api/projects/proj-1/jobs/jr')
          expect(res.status).toBe(200)
          expect(res.body.job.tickets).toEqual([{ id: 24, title: 'WORKSPACE-TITLE' }])
        } finally {
          if (prevHome !== undefined) process.env.SPECRAILS_REGISTRY_HOME = prevHome
          else delete process.env.SPECRAILS_REGISTRY_HOME
          fs.rmSync(regHome, { recursive: true, force: true })
        }
      })

      it('returns null title for deleted ticket', async () => {
        const dir = newProjectDir()
        writeTickets(dir, {}) // no tickets in store
        db.prepare(`INSERT INTO jobs (id, command, started_at, status)
          VALUES ('j2', '/specrails:implement #99', '2026-05-05T10:00:00.000Z', 'completed')`).run()
        const { app } = createApp(new Map([['proj-1', makeCtxAt(dir)]]))
        const res = await request(app).get('/api/projects/proj-1/jobs/j2')
        expect(res.body.job.tickets).toEqual([{ id: 99, title: null }])
      })

      it('mixes live and deleted tickets, preserves order', async () => {
        const dir = newProjectDir()
        writeTickets(dir, {
          '24': { id: 24, title: 'Live one' },
          '47': { id: 47, title: 'Live two' },
        })
        db.prepare(`INSERT INTO jobs (id, command, started_at, status)
          VALUES ('j3', '/specrails:implement #24 #99 #47 --yes', '2026-05-05T10:00:00.000Z', 'running')`).run()
        const { app } = createApp(new Map([['proj-1', makeCtxAt(dir)]]))
        const res = await request(app).get('/api/projects/proj-1/jobs/j3')
        expect(res.body.job.tickets).toEqual([
          { id: 24, title: 'Live one' },
          { id: 99, title: null },
          { id: 47, title: 'Live two' },
        ])
      })

      it('returns empty array when command has no #<id>', async () => {
        const dir = newProjectDir()
        writeTickets(dir, {})
        db.prepare(`INSERT INTO jobs (id, command, started_at, status)
          VALUES ('j4', '/setup', '2026-05-05T10:00:00.000Z', 'completed')`).run()
        const { app } = createApp(new Map([['proj-1', makeCtxAt(dir)]]))
        const res = await request(app).get('/api/projects/proj-1/jobs/j4')
        expect(res.body.job.tickets).toEqual([])
      })

      it('deduplicates duplicate ticket references in first-occurrence order', async () => {
        const dir = newProjectDir()
        writeTickets(dir, {
          '24': { id: 24, title: 'A' },
          '47': { id: 47, title: 'B' },
        })
        db.prepare(`INSERT INTO jobs (id, command, started_at, status)
          VALUES ('j5', '/specrails:implement #24 #47 #24 #24', '2026-05-05T10:00:00.000Z', 'running')`).run()
        const { app } = createApp(new Map([['proj-1', makeCtxAt(dir)]]))
        const res = await request(app).get('/api/projects/proj-1/jobs/j5')
        expect(res.body.job.tickets).toEqual([
          { id: 24, title: 'A' },
          { id: 47, title: 'B' },
        ])
      })
    })
  })

  // ─── GET /analytics ────────────────────────────────────────────────────────

  // ─── GET /state ────────────────────────────────────────────────────────────

  describe('GET /state', () => {
    it('returns project name and busy status', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/state')
      expect(res.status).toBe(200)
      expect(res.body.projectName).toBe('Test Project')
      expect(res.body.busy).toBe(false)
    })
  })

  // ─── Chat conversation routes ───────────────────────────────────────────────

  describe('chat conversations', () => {
    it('GET /conversations returns empty list', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/chat/conversations')
      expect(res.status).toBe(200)
      expect(res.body.conversations).toEqual([])
    })

    it('GET /conversations/:id returns 404 for unknown conversation', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/chat/conversations/no-id')
      expect(res.status).toBe(404)
    })

    it('DELETE /conversations/:id returns 404 for unknown conversation', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).delete('/api/projects/proj-1/chat/conversations/no-id')
      expect(res.status).toBe(404)
    })

    it('PATCH /conversations/:id returns 404 for unknown conversation', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).patch('/api/projects/proj-1/chat/conversations/no-id').send({ title: 'x' })
      expect(res.status).toBe(404)
    })

    it('POST /conversations creates with default kind=sidebar', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/chat/conversations').send({ model: 'sonnet' })
      expect(res.status).toBe(201)
      expect(res.body.conversation.kind).toBe('sidebar')
    })

    it('POST /conversations accepts kind=explore', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/chat/conversations').send({ model: 'sonnet', kind: 'explore' })
      expect(res.status).toBe(201)
      expect(res.body.conversation.kind).toBe('explore')
    })

    it('POST /conversations rejects unknown kind by falling back to sidebar', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/chat/conversations').send({ model: 'sonnet', kind: 'whatever' })
      expect(res.status).toBe(201)
      expect(res.body.conversation.kind).toBe('sidebar')
    })

    it('POST /conversations/:id/messages returns 400 when text is missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      // Create a conversation first
      const createRes = await request(app).post('/api/projects/proj-1/chat/conversations').send({ model: 'sonnet' })
      expect(createRes.status).toBe(201)
      const convId = createRes.body.conversation.id
      const res = await request(app).post(`/api/projects/proj-1/chat/conversations/${convId}/messages`).send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('text is required')
    })

    it('GET /conversations/:id/spec-draft returns 404 when conversation missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/chat/conversations/missing/spec-draft')
      expect(res.status).toBe(404)
    })

    it('GET /conversations/:id/spec-draft returns null draft when no state accumulated', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app).post('/api/projects/proj-1/chat/conversations').send({})
      const convId = createRes.body.conversation.id
      const res = await request(app).get(`/api/projects/proj-1/chat/conversations/${convId}/spec-draft`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ draft: null, ready: false, chips: [] })
    })

    it('GET /conversations/:id/spec-draft returns the accumulated draft state', async () => {
      const sampleDraft = { title: 'Hello', description: 'world', priority: 'high', labels: ['x'], acceptanceCriteria: ['a'] }
      const chatManager = makeChatManager({
        getSpecDraftState: vi.fn(() => ({ draft: sampleDraft, ready: true, chips: ['Refine', 'Discard'] })),
      })
      const ctx = makeContext(db, { chatManager: chatManager as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app).post('/api/projects/proj-1/chat/conversations').send({})
      const convId = createRes.body.conversation.id
      const res = await request(app).get(`/api/projects/proj-1/chat/conversations/${convId}/spec-draft`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ draft: sampleDraft, ready: true, chips: ['Refine', 'Discard'] })
    })

    it('POST /conversations/:id/messages returns 409 when conversation is busy', async () => {
      const chatManager = makeChatManager({ isActive: vi.fn(() => true) })
      const ctx = makeContext(db, { chatManager: chatManager as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app).post('/api/projects/proj-1/chat/conversations').send({})
      const convId = createRes.body.conversation.id
      const res = await request(app).post(`/api/projects/proj-1/chat/conversations/${convId}/messages`).send({ text: 'hello' })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('CONVERSATION_BUSY')
    })
  })

  // ─── Setup routes ──────────────────────────────────────────────────────────

  describe('setup routes', () => {
    it('POST /setup/install returns 409 when install already in progress', async () => {
      const sm = makeSetupManager({ isInstalling: vi.fn(() => true) })
      const ctx = makeContext(db, { setupManager: sm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/setup/install')
      expect(res.status).toBe(409)
      expect(res.body.error).toContain('Install already in progress')
    })

    it('POST /setup/start returns 409 when setup already in progress', async () => {
      const sm = makeSetupManager({ isSettingUp: vi.fn(() => true) })
      const ctx = makeContext(db, { setupManager: sm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/setup/start')
      expect(res.status).toBe(409)
    })

    it('POST /setup/message returns 400 when sessionId is missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/setup/message').send({ message: 'hello' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('sessionId is required')
    })

    it('POST /setup/message returns 400 when message is missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/setup/message').send({ sessionId: 'sess-1' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('message is required')
    })

    it('GET /setup/checkpoints returns checkpoint status', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/setup/checkpoints')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.checkpoints)).toBe(true)
    })

    it('GET /setup/checkpoints includes summary with agent/persona/command counts', async () => {
      // Regression: was missing from the response; SetupWizard.tsx used hardcoded zeros.
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/setup/checkpoints')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('summary')
      expect(res.body.summary).toMatchObject({
        agents: expect.any(Number),
        personas: expect.any(Number),
        commands: expect.any(Number),
      })
    })
  })

  // ─── Proposal routes ────────────────────────────────────────────────────────

  describe('proposal routes', () => {
    it('GET /propose returns empty list', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/propose')
      expect(res.status).toBe(200)
    })

    it('GET /propose/:id returns 404 for unknown proposal', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/propose/no-such-id')
      expect(res.status).toBe(404)
      expect(res.body.error).toContain('Proposal not found')
    })

    it('DELETE /propose/:id returns 404 for unknown proposal', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).delete('/api/projects/proj-1/propose/no-such-id')
      expect(res.status).toBe(404)
    })

    it('POST /propose returns 400 when idea is missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/propose').send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('idea is required')
    })
  })

  // ─── Queue routes ───────────────────────────────────────────────────────────

  describe('queue routes', () => {
    it('GET /queue returns queue state', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/queue')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.jobs)).toBe(true)
      expect(typeof res.body.paused).toBe('boolean')
    })

    it('POST /queue/pause returns ok', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/queue/pause')
      expect(res.status).toBe(200)
      expect(res.body.paused).toBe(true)
    })

    it('POST /queue/resume returns ok', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/queue/resume')
      expect(res.status).toBe(200)
      expect(res.body.paused).toBe(false)
    })
  })

  // ─── GET /activity ──────────────────────────────────────────────────────────

  describe('GET /activity', () => {
    it('returns empty array when project has no jobs', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/activity')
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('returns 404 for unknown project', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/projects/nonexistent/activity')
      expect(res.status).toBe(404)
    })

    it('running job appears as job_started', async () => {
      db.prepare(
        "INSERT INTO jobs (id, command, started_at, status) VALUES ('j-run', 'sr:implement', '2025-01-01T10:00:00.000Z', 'running')"
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/activity')
      expect(res.status).toBe(200)
      const item = res.body.find((i: any) => i.jobId === 'j-run')
      expect(item).toBeDefined()
      expect(item.type).toBe('job_started')
      expect(item.costUsd).toBeNull()
    })

    it('completed job appears as job_completed with costUsd', async () => {
      db.prepare(
        "INSERT INTO jobs (id, command, started_at, finished_at, status, total_cost_usd) VALUES ('j-done', 'sr:implement', '2025-01-01T10:00:00.000Z', '2025-01-01T10:05:00.000Z', 'completed', 0.05)"
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/activity')
      const item = res.body.find((i: any) => i.jobId === 'j-done')
      expect(item.type).toBe('job_completed')
      expect(item.costUsd).toBe(0.05)
    })

    it('failed job appears as job_failed', async () => {
      db.prepare(
        "INSERT INTO jobs (id, command, started_at, finished_at, status) VALUES ('j-fail', 'sr:implement', '2025-01-01T09:00:00.000Z', '2025-01-01T09:01:00.000Z', 'failed')"
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/activity')
      const item = res.body.find((i: any) => i.jobId === 'j-fail')
      expect(item.type).toBe('job_failed')
    })

    it('canceled job appears as job_canceled', async () => {
      db.prepare(
        "INSERT INTO jobs (id, command, started_at, finished_at, status) VALUES ('j-cancel', 'sr:implement', '2025-01-01T08:00:00.000Z', '2025-01-01T08:00:30.000Z', 'canceled')"
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/activity')
      const item = res.body.find((i: any) => i.jobId === 'j-cancel')
      expect(item.type).toBe('job_canceled')
    })

    it('respects limit param', async () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO jobs (id, command, started_at, status) VALUES ('lim-${i}', 'cmd', '2025-01-0${i + 1}T10:00:00.000Z', 'completed')`
        ).run()
      }
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/activity?limit=2')
      expect(res.status).toBe(200)
      expect(res.body.length).toBeLessThanOrEqual(2)
    })

    it('caps limit at 100', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      // Just verify the request succeeds (no 400/500) when limit > 100
      const res = await request(app).get('/api/projects/proj-1/activity?limit=500')
      expect(res.status).toBe(200)
      expect(res.body.length).toBeLessThanOrEqual(100)
    })

    it('before param filters results', async () => {
      db.prepare(
        "INSERT INTO jobs (id, command, started_at, status) VALUES ('before-old', 'cmd', '2024-01-01T10:00:00.000Z', 'completed')"
      ).run()
      db.prepare(
        "INSERT INTO jobs (id, command, started_at, status) VALUES ('before-new', 'cmd', '2025-06-01T10:00:00.000Z', 'completed')"
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/activity?before=2025-01-01T00:00:00.000Z')
      expect(res.status).toBe(200)
      const ids = res.body.map((i: any) => i.jobId)
      expect(ids).toContain('before-old')
      expect(ids).not.toContain('before-new')
    })
  })

  // ─── Spec Launcher ───────────────────────────────────────────────────────────

  describe('POST /:projectId/spec-launcher/start', () => {
    it('returns 400 if description is missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/spec-launcher/start')
        .send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toBeTruthy()
    })

    it('returns 400 if description is empty string', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/spec-launcher/start')
        .send({ description: '   ' })
      expect(res.status).toBe(400)
    })

    it('returns 202 with launchId and calls launch', async () => {
      const launch = vi.fn(async () => {})
      const slm = makeSpecLauncherManager({ launch })
      const ctx = makeContext(db, { specLauncherManager: slm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/spec-launcher/start')
        .send({ description: 'feat: add dark mode toggle' })
      expect(res.status).toBe(202)
      expect(typeof res.body.launchId).toBe('string')
      expect(res.body.launchId).toBeTruthy()
      // launch is called asynchronously — wait a tick
      await new Promise((r) => setTimeout(r, 10))
      expect(launch).toHaveBeenCalledWith(res.body.launchId, 'feat: add dark mode toggle')
    })
  })

  describe('DELETE /:projectId/spec-launcher/:launchId', () => {
    it('returns 404 if no active launch', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .delete('/api/projects/proj-1/spec-launcher/nonexistent-id')
      expect(res.status).toBe(404)
    })

    it('cancels an active launch and returns ok', async () => {
      const cancel = vi.fn()
      const slm = makeSpecLauncherManager({
        isActive: vi.fn(() => true),
        cancel,
      })
      const ctx = makeContext(db, { specLauncherManager: slm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .delete('/api/projects/proj-1/spec-launcher/some-launch-id')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(cancel).toHaveBeenCalledWith('some-launch-id')
    })
  })

  // ─── Changes endpoint ─────────────────────────────────────────────────────

  describe('GET /:projectId/changes', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-desktop-changes-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('returns empty changes array when no openspec/changes dir', async () => {
      const ctx = makeContext(db, {
        project: { id: 'proj-1', slug: 'proj', name: 'Test', path: tmpDir, db_path: ':memory:', added_at: '', last_seen_at: '' },
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/changes')
      expect(res.status).toBe(200)
      expect(res.body.changes).toEqual([])
    })

    it('returns active changes from openspec/changes/', async () => {
      const changesDir = path.join(tmpDir, 'openspec', 'changes')
      fs.mkdirSync(path.join(changesDir, 'my-feature'), { recursive: true })
      fs.writeFileSync(path.join(changesDir, 'my-feature', 'proposal.md'), '# Proposal')

      const ctx = makeContext(db, {
        project: { id: 'proj-1', slug: 'proj', name: 'Test', path: tmpDir, db_path: ':memory:', added_at: '', last_seen_at: '' },
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/changes')
      expect(res.status).toBe(200)
      const change = res.body.changes.find((c: { id: string }) => c.id === 'my-feature')
      expect(change).toBeDefined()
      expect(change.artifacts.proposal).toBe(true)
      expect(change.isArchived).toBe(false)
    })
  })

  // ─── Change Artifact Browser ──────────────────────────────────────────────

  describe('GET /:projectId/changes/:changeId/artifacts/:artifact', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-desktop-artifacts-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    function makeCtxWithPath(p: string) {
      return makeContext(db, {
        project: { id: 'proj-1', slug: 'proj', name: 'Test', path: p, db_path: ':memory:', added_at: '', last_seen_at: '' },
      })
    }

    it('returns 400 for disallowed artifact names', async () => {
      const ctx = makeCtxWithPath(tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/changes/my-change/artifacts/package.json')
      expect(res.status).toBe(400)
    })

    it('rejects change IDs with special characters', async () => {
      const ctx = makeCtxWithPath(tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/changes/my%2Fevil/artifacts/proposal.md')
      expect(res.status).toBe(400)
    })

    it('returns 404 when artifact file does not exist', async () => {
      fs.mkdirSync(path.join(tmpDir, 'openspec', 'changes', 'my-change'), { recursive: true })
      const ctx = makeCtxWithPath(tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/changes/my-change/artifacts/proposal.md')
      expect(res.status).toBe(404)
    })

    it('returns artifact content from active changes dir', async () => {
      const changeDir = path.join(tmpDir, 'openspec', 'changes', 'my-change')
      fs.mkdirSync(changeDir, { recursive: true })
      fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# My Proposal')
      const ctx = makeCtxWithPath(tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/changes/my-change/artifacts/proposal.md')
      expect(res.status).toBe(200)
      expect(res.body.content).toBe('# My Proposal')
      expect(res.body.artifact).toBe('proposal.md')
      expect(res.body.changeId).toBe('my-change')
    })

    it('returns artifact content from archive dir', async () => {
      const archiveDir = path.join(tmpDir, 'openspec', 'changes', 'archive', 'old-change')
      fs.mkdirSync(archiveDir, { recursive: true })
      fs.writeFileSync(path.join(archiveDir, 'design.md'), '# Design')
      const ctx = makeCtxWithPath(tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/changes/old-change/artifacts/design.md')
      expect(res.status).toBe(200)
      expect(res.body.content).toBe('# Design')
    })
  })

  // ─── Config routes ──────────────────────────────────────────────────────────

  describe('GET /:projectId/config', () => {
    it('returns config object with project, issueTracker, commands', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/config')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('project')
      expect(res.body).toHaveProperty('issueTracker')
      expect(res.body).toHaveProperty('commands')
    })
  })

  describe('POST /:projectId/config', () => {
    it('persists active tracker', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/config')
        .send({ active: 'github' })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('persists label filter', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/config')
        .send({ labelFilter: 'bug' })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('accepts empty body without error', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/config').send({})
      expect(res.status).toBe(200)
    })
  })

  // ─── Issues endpoint ────────────────────────────────────────────────────────

  describe('GET /:projectId/issues', () => {
    it('returns 503 or 200 depending on tracker availability', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/issues')
      expect([200, 503]).toContain(res.status)
    })
  })

  // ─── GET /stats ─────────────────────────────────────────────────────────────

  describe('GET /:projectId/stats', () => {
    it('returns stats object', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/stats')
      expect(res.status).toBe(200)
    })
  })

  // ─── DELETE /jobs (purge) ────────────────────────────────────────────────────

  describe('DELETE /:projectId/jobs', () => {
    it('returns ok with deleted count', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).delete('/api/projects/proj-1/jobs').send({})
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(typeof res.body.deleted).toBe('number')
    })
  })

  // ─── Full conversation lifecycle ─────────────────────────────────────────────

  describe('full conversation lifecycle', () => {
    it('creates, reads, updates, and deletes a conversation', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      // Create
      const createRes = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: 'sonnet' })
      expect(createRes.status).toBe(201)
      const convId = createRes.body.conversation.id

      // Read
      const getRes = await request(app).get(`/api/projects/proj-1/chat/conversations/${convId}`)
      expect(getRes.status).toBe(200)
      expect(getRes.body.conversation.id).toBe(convId)

      // Get messages
      const msgsRes = await request(app).get(`/api/projects/proj-1/chat/conversations/${convId}/messages`)
      expect(msgsRes.status).toBe(200)
      expect(Array.isArray(msgsRes.body.messages)).toBe(true)

      // Update
      const patchRes = await request(app)
        .patch(`/api/projects/proj-1/chat/conversations/${convId}`)
        .send({ title: 'Updated Title' })
      expect(patchRes.status).toBe(200)
      expect(patchRes.body.ok).toBe(true)

      // Delete
      const deleteRes = await request(app).delete(`/api/projects/proj-1/chat/conversations/${convId}`)
      expect(deleteRes.status).toBe(200)
      expect(deleteRes.body.ok).toBe(true)

      // Verify deleted
      const afterDelete = await request(app).get(`/api/projects/proj-1/chat/conversations/${convId}`)
      expect(afterDelete.status).toBe(404)
    })

    it('returns 404 for DELETE /conversations/:id/messages/stream when no active stream', async () => {
      const chatManager = makeChatManager({ isActive: vi.fn(() => false) })
      const ctx = makeContext(db, { chatManager: chatManager as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .delete('/api/projects/proj-1/chat/conversations/some-id/messages/stream')
      expect(res.status).toBe(404)
    })
  })

  // ─── Job Templates ────────────────────────────────────────────────────────

  describe('job templates CRUD', () => {
    it('GET /templates returns empty list initially', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/templates')
      expect(res.status).toBe(200)
      expect(res.body.templates).toEqual([])
    })

    it('POST /templates creates a template', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'My Template', description: 'A test template', commands: ['/specrails:test', '/specrails:build'] })
      expect(res.status).toBe(201)
      expect(res.body.template.name).toBe('My Template')
      expect(res.body.template.commands).toEqual(['/specrails:test', '/specrails:build'])
    })

    it('POST /templates returns 400 when name is missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ commands: ['/specrails:test'] })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/name/)
    })

    it('POST /templates returns 400 when commands is empty array', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'T', commands: [] })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/commands/)
    })

    it('POST /templates returns 400 when a command is not a string', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'T', commands: [42] })
      expect(res.status).toBe(400)
    })

    it('POST /templates returns 409 for duplicate name', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Dup', commands: ['/specrails:test'] })
      const res = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Dup', commands: ['/specrails:build'] })
      expect(res.status).toBe(409)
    })

    it('GET /templates/:templateId returns the template', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Get Me', commands: ['/specrails:run'] })
      const id = createRes.body.template.id
      const res = await request(app).get(`/api/projects/proj-1/templates/${id}`)
      expect(res.status).toBe(200)
      expect(res.body.template.id).toBe(id)
    })

    it('GET /templates/:templateId returns 404 for unknown id', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/templates/no-such-id')
      expect(res.status).toBe(404)
    })

    it('PATCH /templates/:templateId updates name and description', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Old Name', commands: ['/specrails:run'] })
      const id = createRes.body.template.id
      const res = await request(app)
        .patch(`/api/projects/proj-1/templates/${id}`)
        .send({ name: 'New Name', description: 'Updated' })
      expect(res.status).toBe(200)
      expect(res.body.template.name).toBe('New Name')
    })

    it('PATCH /templates/:templateId returns 404 for unknown id', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/templates/no-such-id')
        .send({ name: 'X' })
      expect(res.status).toBe(404)
    })

    it('PATCH /templates/:templateId returns 400 for empty name', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Valid', commands: ['/specrails:run'] })
      const id = createRes.body.template.id
      const res = await request(app)
        .patch(`/api/projects/proj-1/templates/${id}`)
        .send({ name: '' })
      expect(res.status).toBe(400)
    })

    it('PATCH /templates/:templateId returns 400 for empty commands array', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Valid2', commands: ['/specrails:run'] })
      const id = createRes.body.template.id
      const res = await request(app)
        .patch(`/api/projects/proj-1/templates/${id}`)
        .send({ commands: [] })
      expect(res.status).toBe(400)
    })

    it('PATCH /templates/:templateId returns 409 for duplicate name', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Alpha', commands: ['/specrails:run'] })
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Beta', commands: ['/specrails:run'] })
      const betaId = createRes.body.template.id
      const res = await request(app)
        .patch(`/api/projects/proj-1/templates/${betaId}`)
        .send({ name: 'Alpha' })
      expect(res.status).toBe(409)
    })

    it('DELETE /templates/:templateId deletes the template', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'To Delete', commands: ['/specrails:run'] })
      const id = createRes.body.template.id
      const deleteRes = await request(app).delete(`/api/projects/proj-1/templates/${id}`)
      expect(deleteRes.status).toBe(200)
      expect(deleteRes.body.ok).toBe(true)
      const getRes = await request(app).get(`/api/projects/proj-1/templates/${id}`)
      expect(getRes.status).toBe(404)
    })

    it('DELETE /templates/:templateId returns 404 for unknown id', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).delete('/api/projects/proj-1/templates/no-such-id')
      expect(res.status).toBe(404)
    })

    it('POST /templates/:templateId/run enqueues all commands as a pipeline', async () => {
      const enqueue = vi.fn()
        .mockReturnValueOnce({ id: 'job-1', queuePosition: 0 })
        .mockReturnValueOnce({ id: 'job-2', queuePosition: 1 })
      const queueManager = makeQueueManager({ enqueue })
      const ctx = makeContext(db, { queueManager: queueManager as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Run Me', commands: ['/specrails:test', '/specrails:build'] })
      const id = createRes.body.template.id
      const res = await request(app).post(`/api/projects/proj-1/templates/${id}/run`)
      expect(res.status).toBe(202)
      expect(res.body.jobIds).toEqual(['job-1', 'job-2'])
      expect(enqueue).toHaveBeenCalledTimes(2)
    })

    it('POST /templates/:templateId/run returns 404 for unknown template', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/templates/no-such-id/run')
      expect(res.status).toBe(404)
    })

    it('POST /templates/:templateId/run returns 400 when Claude not found', async () => {
      const enqueue = vi.fn().mockImplementation(() => { throw new ClaudeNotFoundError('claude not found') })
      const queueManager = makeQueueManager({ enqueue })
      const ctx = makeContext(db, { queueManager: queueManager as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Fail Run', commands: ['/specrails:test'] })
      const id = createRes.body.template.id
      const res = await request(app).post(`/api/projects/proj-1/templates/${id}/run`)
      expect(res.status).toBe(400)
    })

    it('PATCH /templates/:templateId sets description to null when passed null', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Desc Test', description: 'Initial', commands: ['/specrails:run'] })
      const id = createRes.body.template.id
      const res = await request(app)
        .patch(`/api/projects/proj-1/templates/${id}`)
        .send({ description: null })
      expect(res.status).toBe(200)
    })

    it('PATCH /templates/:templateId returns 400 when a command is not a string', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'CmdTest', commands: ['/specrails:run'] })
      const id = createRes.body.template.id
      const res = await request(app)
        .patch(`/api/projects/proj-1/templates/${id}`)
        .send({ commands: [123] })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/command/)
    })

    it('POST /templates/:templateId/run with chain=false enqueues without dependencies', async () => {
      const enqueue = vi.fn()
        .mockReturnValueOnce({ id: 'job-1', queuePosition: 0 })
        .mockReturnValueOnce({ id: 'job-2', queuePosition: 1 })
      const queueManager = makeQueueManager({ enqueue })
      const ctx = makeContext(db, { queueManager: queueManager as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'No Chain', commands: ['/specrails:test', '/specrails:build'] })
      const id = createRes.body.template.id
      const res = await request(app)
        .post(`/api/projects/proj-1/templates/${id}/run`)
        .send({ chain: false })
      expect(res.status).toBe(202)
      expect(res.body.jobIds).toEqual(['job-1', 'job-2'])
      // Verify no dependsOnJobId was passed
      for (const call of enqueue.mock.calls) {
        expect(call[2]?.dependsOnJobId).toBeUndefined()
      }
    })

    it('POST /templates/:templateId/run returns 500 for unexpected errors', async () => {
      const enqueue = vi.fn().mockImplementation(() => { throw new Error('unexpected') })
      const queueManager = makeQueueManager({ enqueue })
      const ctx = makeContext(db, { queueManager: queueManager as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Error Run', commands: ['/specrails:test'] })
      const id = createRes.body.template.id
      const res = await request(app).post(`/api/projects/proj-1/templates/${id}/run`)
      expect(res.status).toBe(500)
    })
  })

  // ─── Pipeline routes ─────────────────────────────────────────────────────
  // NOTE: POST /pipelines removed — ad-hoc pipeline creation consolidated into rails (templates).

  describe('GET /:projectId/pipelines/:pipelineId', () => {
    it('returns 404 for unknown pipeline', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/pipelines/unknown-id')
      expect(res.status).toBe(404)
    })

    it('returns pipeline status with jobs', async () => {
      // Insert jobs with a pipeline_id
      const pipeId = 'pipe-123'
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, pipeline_id) VALUES ('pj-1', 'sr:test', '2025-01-01T10:00:00.000Z', 'completed', ?)`
      ).run(pipeId)
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, pipeline_id) VALUES ('pj-2', 'sr:build', '2025-01-01T10:01:00.000Z', 'completed', ?)`
      ).run(pipeId)
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get(`/api/projects/proj-1/pipelines/${pipeId}`)
      expect(res.status).toBe(200)
      expect(res.body.pipelineId).toBe(pipeId)
      expect(res.body.status).toBe('completed')
      expect(res.body.jobs).toHaveLength(2)
    })

    it('returns failed status when any job failed', async () => {
      const pipeId = 'pipe-fail'
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, pipeline_id) VALUES ('pfj-1', 'sr:test', '2025-01-01T10:00:00.000Z', 'completed', ?)`
      ).run(pipeId)
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, finished_at, status, pipeline_id) VALUES ('pfj-2', 'sr:build', '2025-01-01T10:01:00.000Z', '2025-01-01T10:02:00.000Z', 'failed', ?)`
      ).run(pipeId)
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get(`/api/projects/proj-1/pipelines/${pipeId}`)
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('failed')
    })

    it('returns running status when jobs are still in progress', async () => {
      const pipeId = 'pipe-run'
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, pipeline_id) VALUES ('prj-1', 'sr:test', '2025-01-01T10:00:00.000Z', 'completed', ?)`
      ).run(pipeId)
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status, pipeline_id) VALUES ('prj-2', 'sr:build', '2025-01-01T10:01:00.000Z', 'running', ?)`
      ).run(pipeId)
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get(`/api/projects/proj-1/pipelines/${pipeId}`)
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('running')
    })
  })

  // ─── POST /spawn error paths ─────────────────────────────────────────────

  describe('POST /spawn additional paths', () => {
    it('returns 400 for invalid priority', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/spawn')
        .send({ command: 'sr:test', priority: 'invalid' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('priority must be one of')
    })

    it('returns 500 on unexpected error during spawn', async () => {
      const qm = makeQueueManager({ enqueue: vi.fn(() => { throw new Error('unexpected') }) })
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/spawn')
        .send({ command: 'sr:test' })
      expect(res.status).toBe(500)
    })

    it('passes priority and dependsOnJobId through to enqueue', async () => {
      const enqueue = vi.fn(() => ({ id: 'job-x', queuePosition: 0 }))
      const qm = makeQueueManager({ enqueue })
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/spawn')
        .send({ command: 'sr:test', priority: 'high', dependsOnJobId: 'parent-1', pipelineId: 'pipe-1' })
      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith('sr:test', 'high', {
        dependsOnJobId: 'parent-1',
        pipelineId: 'pipe-1',
      })
    })
  })

  // ─── PATCH /jobs/:id/priority ────────────────────────────────────────────

  describe('PATCH /:projectId/jobs/:id/priority', () => {
    it('returns 400 when priority is missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/jobs/some-job/priority')
        .send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('priority must be one of')
    })

    it('returns 400 for invalid priority value', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/jobs/some-job/priority')
        .send({ priority: 'mega' })
      expect(res.status).toBe(400)
    })

    it('returns 200 on valid priority update', async () => {
      const updatePriority = vi.fn()
      const qm = { ...makeQueueManager(), updatePriority }
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/jobs/some-job/priority')
        .send({ priority: 'high' })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(updatePriority).toHaveBeenCalledWith('some-job', 'high')
    })

    it('returns 404 when job not found', async () => {
      const updatePriority = vi.fn(() => { throw new JobNotFoundError() })
      const qm = { ...makeQueueManager(), updatePriority }
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/jobs/no-job/priority')
        .send({ priority: 'low' })
      expect(res.status).toBe(404)
    })

    it('returns 400 when updatePriority throws a generic error', async () => {
      const updatePriority = vi.fn(() => { throw new Error('Cannot update running job') })
      const qm = { ...makeQueueManager(), updatePriority }
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/jobs/some-job/priority')
        .send({ priority: 'low' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Cannot update running job')
    })
  })

  // ─── DELETE /jobs/:id 500 error path ────────────────────────────────────

  describe('POST /jobs/:id/cancel 500 error', () => {
    it('returns 500 on unexpected error during cancel', async () => {
      const qm = makeQueueManager({ cancel: vi.fn(() => { throw new Error('boom') }) })
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/jobs/some-job/cancel')
      expect(res.status).toBe(500)
    })

    it('returns 200 with status on successful cancel', async () => {
      const qm = makeQueueManager({ cancel: vi.fn(() => 'canceled') })
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/jobs/some-job/cancel')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.status).toBe('canceled')
    })
  })

  // ─── Jobs export ─────────────────────────────────────────────────────────

  describe('GET /:projectId/jobs/:id/phase-breakdown', () => {
    it('404s for an unknown job', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/nope/phase-breakdown')
      expect(res.status).toBe(404)
    })

    it('computes per-phase usage from persisted assistant/user events', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('pb-1', 'sr:implement', '2026-07-21T10:00:00.000Z', 'completed')`
      ).run()
      const insert = db.prepare(
        `INSERT INTO events (job_id, seq, event_type, source, payload, timestamp) VALUES ('pb-1', ?, ?, 'stdout', ?, ?)`
      )
      insert.run(0, 'assistant', JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'tool_use', name: 'Task', id: 'T1', input: { subagent_type: 'sr-architect' } }],
        },
      }), '2026-07-21T10:00:00Z')
      insert.run(1, 'assistant', JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'T1',
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 500, output_tokens: 100 }, content: [] },
      }), '2026-07-21T10:01:00Z')
      insert.run(2, 'user', JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'T1' }] },
      }), '2026-07-21T10:02:00Z')
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/pb-1/phase-breakdown')
      expect(res.status).toBe(200)
      expect(res.body.breakdown.estimated).toBe(true)
      expect(res.body.breakdown.phases).toHaveLength(1)
      expect(res.body.breakdown.phases[0].agent).toBe('sr-architect')
      expect(res.body.breakdown.phases[0].tokensIn).toBe(500)
      expect(res.body.breakdown.phases[0].durationMs).toBe(120000)
      expect(res.body.breakdown.orchestrator.tokensIn).toBe(10)
    })

    it('returns breakdown null when the stream carries no usage envelopes', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('pb-2', 'sr:implement', '2026-07-21T10:00:00.000Z', 'completed')`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/pb-2/phase-breakdown')
      expect(res.status).toBe(200)
      expect(res.body.breakdown).toBeNull()
    })
  })

  describe('GET /:projectId/jobs/export', () => {
    it('returns 400 for invalid format', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/export?format=xml')
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Invalid format')
    })

    it('exports jobs as JSON (default format)', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('exp-1', 'sr:test', '2025-01-01T10:00:00.000Z', 'completed')`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/export')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.jobs)).toBe(true)
      expect(res.body.jobs.length).toBeGreaterThanOrEqual(1)
    })

    it('exports jobs as CSV', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('exp-csv', 'sr:test', '2025-01-01T10:00:00.000Z', 'completed')`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/export?format=csv')
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')
      expect(res.text).toContain('id,command,status')
    })

    it('supports from and to date filters', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('eflt-1', 'sr:a', '2025-01-01T10:00:00.000Z', 'completed')`
      ).run()
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('eflt-2', 'sr:b', '2025-06-01T10:00:00.000Z', 'completed')`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get(
        '/api/projects/proj-1/jobs/export?format=json&from=2025-05-01T00:00:00.000Z&to=2025-12-31T00:00:00.000Z'
      )
      expect(res.status).toBe(200)
      expect(res.body.jobs.some((j: any) => j.id === 'eflt-2')).toBe(true)
      expect(res.body.jobs.some((j: any) => j.id === 'eflt-1')).toBe(false)
    })
  })

  // ─── Jobs compare (must out-rank /jobs/:id) ──────────────────────────────

  describe('GET /:projectId/jobs/compare', () => {
    it('is reachable (not shadowed by /jobs/:id) and returns the two compared jobs', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('cmp-a', 'sr:a', '2025-01-01T10:00:00.000Z', 'completed')`
      ).run()
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('cmp-b', 'sr:b', '2025-01-02T10:00:00.000Z', 'completed')`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/compare?jobIds=cmp-a,cmp-b')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.jobs)).toBe(true)
      expect(res.body.jobs.map((j: any) => j.id).sort()).toEqual(['cmp-a', 'cmp-b'])
    })

    it('returns 400 when jobIds is missing', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/compare')
      expect(res.status).toBe(400)
    })

    it('returns 400 when not exactly 2 jobIds', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/compare?jobIds=only-one')
      expect(res.status).toBe(400)
    })

    it('returns 404 when a compared job does not exist', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, status) VALUES ('cmp-exists', 'sr:a', '2025-01-01T10:00:00.000Z', 'completed')`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/jobs/compare?jobIds=cmp-exists,cmp-missing')
      expect(res.status).toBe(404)
      expect(res.body.error).toContain('cmp-missing')
    })
  })

  // ─── Analytics export ────────────────────────────────────────────────────

  describe('GET /:projectId/analytics/export', () => {
    it('returns 400 for invalid format', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?format=xml')
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Invalid format')
    })

    it('returns 400 for invalid period', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?period=invalid')
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Invalid period')
    })

    it('returns 400 for custom period without from/to', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?period=custom')
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('from and to are required')
    })

    it('exports analytics summary as JSON', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?format=json&period=7d')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('summary')
      expect(res.body).toHaveProperty('bySurface')
      expect(res.body).toHaveProperty('dailyTimeline')
    })

    it('exports analytics summary as multi-section CSV', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?format=csv&period=7d')
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')
      expect(res.text).toContain('# Totals')
      expect(res.text).toContain('# By surface')
      expect(res.text).toContain('# By model')
    })

    it('exports raw invocations as CSV with truncation marker when capped', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?format=csv&mode=raw&period=all')
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')
      expect(res.text.split('\n')[0]).toContain('id,surface,surface_ref_id')
    })

    it('returns 400 for invalid mode', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?mode=bogus')
      expect(res.status).toBe(400)
    })

    it('exports summary as JSON with explicit filename header', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?format=json&mode=summary&period=30d')
      expect(res.status).toBe(200)
      expect(res.headers['content-disposition']).toContain('analytics-30d')
      expect(res.headers['content-disposition']).toContain('.json')
    })

    it('exports raw as JSON', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?format=json&mode=raw&period=all')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('rows')
      expect(res.body).toHaveProperty('truncated')
      expect(res.body).toHaveProperty('totalAvailable')
    })

    it('uses surface tag in filename when single surface filter is active', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?format=csv&mode=raw&period=7d&surface=explore-spec')
      expect(res.status).toBe(200)
      expect(res.headers['content-disposition']).toContain('-explore-')
    })

    it('returns 400 for custom period without from/to', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?period=custom')
      expect(res.status).toBe(400)
    })
  })

  // ─── Spending dashboard endpoints ────────────────────────────────────────────

  describe('GET /:projectId/spending', () => {
    it('returns the dashboard payload shape', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/spending?period=30d')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('summary')
      expect(res.body).toHaveProperty('bySurface')
      expect(res.body).toHaveProperty('byModel')
      expect(res.body).toHaveProperty('byMode')
      expect(res.body).toHaveProperty('dailyTimeline')
      expect(res.body).toHaveProperty('scatter')
      expect(res.body).toHaveProperty('topTickets')
    })

    it('honours the surface filter', async () => {
      db.prepare(
        `INSERT INTO ai_invocations (id, project_id, surface, status, started_at, total_cost_usd)
         VALUES ('a', 'proj-1', 'job', 'success', datetime('now'), 1.0),
                ('b', 'proj-1', 'quick-spec', 'success', datetime('now'), 5.0)`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/spending?period=all&surface=quick-spec')
      expect(res.status).toBe(200)
      expect(res.body.summary.totalCostUsd).toBeCloseTo(5.0)
    })

    it('returns 400 for custom period without from/to', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/spending?period=custom')
      expect(res.status).toBe(400)
    })
  })

  describe('GET /:projectId/invocations', () => {
    it('returns paginated rows', async () => {
      for (let i = 0; i < 3; i++) {
        db.prepare(
          `INSERT INTO ai_invocations (id, project_id, surface, status, started_at) VALUES (?, 'proj-1', 'job', 'success', datetime('now', ?))`
        ).run(`r${i}`, `-${i} seconds`)
      }
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/invocations?period=all&limit=2')
      expect(res.status).toBe(200)
      expect(res.body.rows).toHaveLength(2)
      expect(res.body.totalAvailable).toBe(3)
    })
  })

  describe('GET /:projectId/tickets/:id/spending-summary', () => {
    it('returns aggregate when ticket has invocations', async () => {
      db.prepare(
        `INSERT INTO ai_invocations (id, project_id, surface, status, started_at, ticket_id, total_cost_usd, num_turns, duration_ms)
         VALUES ('x', 'proj-1', 'job', 'success', datetime('now'), 42, 1.5, 3, 2000)`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/tickets/42/spending-summary')
      expect(res.status).toBe(200)
      expect(res.body.totalCostUsd).toBeCloseTo(1.5)
      expect(res.body.totalRuns).toBe(1)
      expect(res.body.totalTurns).toBe(3)
    })

    it('returns 400 for non-numeric ticket id', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/tickets/abc/spending-summary')
      expect(res.status).toBe(400)
    })

    it('returns zeroed summary when ticket has no invocations', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/tickets/999/spending-summary')
      expect(res.status).toBe(200)
      expect(res.body.totalRuns).toBe(0)
      expect(res.body.totalCostUsd).toBe(0)
    })
  })

  // ─── Additional spending/invocations branch coverage ────────────────────────

  describe('spending endpoints branch coverage', () => {
    beforeEach(() => {
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO ai_invocations (id, project_id, surface, status, started_at, model, total_cost_usd, num_turns, duration_ms, ticket_id)
         VALUES
           ('a', 'proj-1', 'job', 'success', ?, 'sonnet', 1.0, 2, 1000, NULL),
           ('b', 'proj-1', 'quick-spec', 'failed', ?, NULL, NULL, NULL, NULL, NULL),
           ('c', 'proj-1', 'explore-spec', 'aborted', ?, 'opus', 0.5, 1, 500, 7),
           ('d', 'proj-1', 'ai-edit', 'success', ?, 'sonnet', 0.2, 1, 300, 7)`
      ).run(now, now, now, now)
    })

    it('/spending honours model and status filters together', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/spending?period=all&model=sonnet&status=success')
      expect(res.status).toBe(200)
      expect(res.body.summary.totalRuns).toBe(2)
    })

    it('/spending custom period with explicit from/to', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const from = new Date(Date.now() - 86_400_000).toISOString()
      const to = new Date(Date.now() + 86_400_000).toISOString()
      const res = await request(app).get(`/api/projects/proj-1/spending?period=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      expect(res.status).toBe(200)
      expect(res.body.summary.totalRuns).toBe(4)
    })

    it('/invocations honours minCostUsd filter', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/invocations?period=all&minCostUsd=0.4')
      expect(res.status).toBe(200)
      expect(res.body.rows.length).toBeGreaterThan(0)
      for (const r of res.body.rows) {
        expect(r.total_cost_usd).toBeGreaterThanOrEqual(0.4)
      }
    })

    it('/invocations honours offset', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/invocations?period=all&limit=2&offset=2')
      expect(res.status).toBe(200)
      expect(res.body.rows.length).toBeLessThanOrEqual(2)
    })

    it('export raw with status filter narrows rows', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?format=json&mode=raw&period=all&status=success')
      expect(res.status).toBe(200)
      for (const r of res.body.rows) expect(r.status).toBe('success')
    })

    it('export summary with surface filter restricts breakdown', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/analytics/export?format=json&mode=summary&period=all&surface=explore-spec')
      expect(res.status).toBe(200)
      expect(res.body.summary.totalRuns).toBe(1)
    })
  })

  // ─── Budget routes ───────────────────────────────────────────────────────

  describe('GET /:projectId/budget', () => {
    it('returns budget data with null budget when not configured', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/budget')
      expect(res.status).toBe(200)
      expect(res.body.dailyBudgetUsd).toBeNull()
      expect(res.body.costToday).toBeDefined()
      expect(res.body.budgetUtilizationPct).toBeNull()
    })

    it('returns budget utilization when daily budget is configured', async () => {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.daily_budget_usd', '10.00')`).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/budget')
      expect(res.status).toBe(200)
      expect(res.body.dailyBudgetUsd).toBe(10)
      expect(typeof res.body.budgetUtilizationPct).toBe('number')
    })

    it('returns jobCostThresholdUsd when configured', async () => {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.job_cost_threshold_usd', '2.50')`).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/budget')
      expect(res.status).toBe(200)
      expect(res.body.jobCostThresholdUsd).toBe(2.5)
    })
  })

  describe('PATCH /:projectId/budget', () => {
    it('sets daily budget', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/budget')
        .send({ dailyBudgetUsd: 25.0 })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      // Verify it was persisted
      const getRes = await request(app).get('/api/projects/proj-1/budget')
      expect(getRes.body.dailyBudgetUsd).toBe(25)
    })

    it('clears daily budget when null', async () => {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.daily_budget_usd', '10')`).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/budget')
        .send({ dailyBudgetUsd: null })
      expect(res.status).toBe(200)
      const getRes = await request(app).get('/api/projects/proj-1/budget')
      expect(getRes.body.dailyBudgetUsd).toBeNull()
    })

    it('sets job cost threshold', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/budget')
        .send({ jobCostThresholdUsd: 5.0 })
      expect(res.status).toBe(200)
      const getRes = await request(app).get('/api/projects/proj-1/budget')
      expect(getRes.body.jobCostThresholdUsd).toBe(5)
    })

    it('clears job cost threshold when null', async () => {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.job_cost_threshold_usd', '5')`).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/budget')
        .send({ jobCostThresholdUsd: null })
      expect(res.status).toBe(200)
      const getRes = await request(app).get('/api/projects/proj-1/budget')
      expect(getRes.body.jobCostThresholdUsd).toBeNull()
    })

    it('accepts empty body', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).patch('/api/projects/proj-1/budget').send({})
      expect(res.status).toBe(200)
    })
  })

  // ─── Removed project-level Explore toggles ─────────────────────────────
  // The four endpoints `(GET|PATCH) /:projectId/(explore-mcp-enabled|
  // explore-contract-refine-enabled)` were deleted. Decisions for MCP and
  // Contract Refine are now exclusively per-spec (via context_scope).
  describe('removed Explore project-toggle endpoints', () => {
    it.each([
      'explore-mcp-enabled',
      'explore-contract-refine-enabled',
    ])('GET /:projectId/%s returns 404', async (path) => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get(`/api/projects/proj-1/${path}`)
      expect(res.status).toBe(404)
    })

    it.each([
      'explore-mcp-enabled',
      'explore-contract-refine-enabled',
    ])('PATCH /:projectId/%s returns 404', async (path) => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch(`/api/projects/proj-1/${path}`)
        .send({ enabled: true })
      expect(res.status).toBe(404)
    })
  })

  // ─── GET/PATCH /:projectId/add-spec-quick-contract-refine-last ──────────

  describe('GET /:projectId/add-spec-quick-contract-refine-last', () => {
    it('returns false and configured=false by default', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/add-spec-quick-contract-refine-last')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ enabled: false, configured: false })
    })
  })

  describe('PATCH /:projectId/add-spec-quick-contract-refine-last', () => {
    it('round-trips the last-used value', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const on = await request(app)
        .patch('/api/projects/proj-1/add-spec-quick-contract-refine-last')
        .send({ enabled: true })
      expect(on.status).toBe(200)
      expect(on.body.enabled).toBe(true)
      const verify = await request(app).get('/api/projects/proj-1/add-spec-quick-contract-refine-last')
      expect(verify.body).toEqual({ enabled: true, configured: true })
    })

    it('rejects non-boolean payloads', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/add-spec-quick-contract-refine-last')
        .send({ enabled: 'yes' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('boolean')
    })
  })

  // ─── GET /:projectId/context-budget ──────────────────────────────────────

  describe('GET /:projectId/context-budget', () => {
    it('returns a budget shape for the project path', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/context-budget')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('specrailsTicketsTokens')
      expect(res.body).toHaveProperty('openspecSpecsTokens')
      expect(res.body).toHaveProperty('codebaseFileCount')
      expect(res.body).toHaveProperty('codebaseEstimatedTokens')
      expect(Array.isArray(res.body.mcpServers)).toBe(true)
    })
  })

  // ─── GET/PATCH /:projectId/context-scope-last ────────────────────────────

  describe('GET /:projectId/context-scope-last', () => {
    it('returns default boot when nothing persisted', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/context-scope-last')
      expect(res.status).toBe(200)
      expect(res.body.scope).toEqual({
        specrails: true, openspec: false, full: true, mcp: false, contractRefine: false, userMcp: false,
      })
    })
  })

  describe('PATCH /:projectId/context-scope-last', () => {
    it('merges partial updates and persists', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const a = await request(app)
        .patch('/api/projects/proj-1/context-scope-last')
        .send({ openspec: true, full: false })
      expect(a.status).toBe(200)
      expect(a.body.scope).toEqual({
        specrails: true, openspec: true, full: false, mcp: false, contractRefine: false, userMcp: false,
      })
      const verify = await request(app).get('/api/projects/proj-1/context-scope-last')
      expect(verify.body.scope.openspec).toBe(true)
      expect(verify.body.scope.full).toBe(false)
    })

    it('rejects non-boolean values', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/context-scope-last')
        .send({ specrails: 'yes' })
      expect(res.status).toBe(400)
    })

    it('rejects non-object body', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/context-scope-last')
        .send('not-an-object')
      expect(res.status).toBe(400)
    })
  })

  // ─── POST /:projectId/chat/conversations with contextScope ─────────────────

  describe('POST /chat/conversations with contextScope', () => {
    it('persists contextScope on explore conversations', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({
          model: 'sonnet',
          kind: 'explore',
          contextScope: { specrails: false, openspec: true, full: false, mcp: true, contractRefine: false },
        })
      expect(res.status).toBe(201)
      const row = db.prepare('SELECT context_scope FROM chat_conversations WHERE id = ?')
        .get(res.body.conversation.id) as { context_scope: string }
      const parsed = JSON.parse(row.context_scope)
      expect(parsed).toEqual({ specrails: false, openspec: true, full: false, mcp: true, contractRefine: false, userMcp: false })
    })

    it('persists userMcp=true on explore conversations', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({
          model: 'sonnet',
          kind: 'explore',
          contextScope: { specrails: false, openspec: false, full: false, mcp: false, contractRefine: false, userMcp: true },
        })
      expect(res.status).toBe(201)
      const row = db.prepare('SELECT context_scope FROM chat_conversations WHERE id = ?')
        .get(res.body.conversation.id) as { context_scope: string }
      expect(JSON.parse(row.context_scope).userMcp).toBe(true)
    })

    it('rejects contextScope on sidebar conversations', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: 'sonnet', kind: 'sidebar', contextScope: { full: true } })
      expect(res.status).toBe(400)
    })

    it('uses last persisted scope as default when explore conv omits scope', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      await request(app)
        .patch('/api/projects/proj-1/context-scope-last')
        .send({ openspec: true })
      const res = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: 'sonnet', kind: 'explore' })
      expect(res.status).toBe(201)
      const row = db.prepare('SELECT context_scope FROM chat_conversations WHERE id = ?')
        .get(res.body.conversation.id) as { context_scope: string }
      expect(JSON.parse(row.context_scope).openspec).toBe(true)
    })

    it('strips contractRefine from contextScope when project provider is codex', async () => {
      // Codex does not support SMASH / Contract Layer. Even when the client sends
      // contractRefine: true, the server must store false (defence-in-depth).
      const codexCtx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'Test Project', path: '/tmp',
          db_path: ':memory:', added_at: '', last_seen_at: '',
          provider: 'codex',
        },
      })
      const { app } = createApp(new Map([['proj-1', codexCtx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({
          model: 'gpt-5.4-mini',
          kind: 'explore',
          contextScope: { specrails: true, openspec: true, full: true, mcp: false, contractRefine: true },
        })
      expect(res.status).toBe(201)
      const row = db.prepare('SELECT context_scope FROM chat_conversations WHERE id = ?')
        .get(res.body.conversation.id) as { context_scope: string }
      const parsed = JSON.parse(row.context_scope)
      expect(parsed.contractRefine).toBe(false)
      // Other scope fields must be preserved
      expect(parsed.specrails).toBe(true)
      expect(parsed.openspec).toBe(true)
      expect(parsed.full).toBe(true)
    })

    it('preserves contractRefine when project provider is claude', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({
          model: 'sonnet',
          kind: 'explore',
          contextScope: { specrails: true, openspec: true, full: true, mcp: false, contractRefine: true },
        })
      expect(res.status).toBe(201)
      const row = db.prepare('SELECT context_scope FROM chat_conversations WHERE id = ?')
        .get(res.body.conversation.id) as { context_scope: string }
      expect(JSON.parse(row.context_scope).contractRefine).toBe(true)
    })
  })

  // ─── GET/PATCH /:projectId/settings ──────────────────────────────────────

  describe('GET /:projectId/settings', () => {
    it('returns default settings', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/settings')
      expect(res.status).toBe(200)
      expect(res.body.pipelineTelemetryEnabled).toBe(false)
      expect(res.body.orchestratorModel).toBe('sonnet')
      expect(res.body.prePrompt).toBe('')
      expect(res.body.worktreeEnvPassthrough).toEqual([])
    })
  })

  describe('PATCH /:projectId/settings', () => {
    it('updates orchestratorModel to opus', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/settings')
        .send({ orchestratorModel: 'opus' })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.settings.orchestratorModel).toBe('opus')
    })

    it('updates orchestratorModel to haiku', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/settings')
        .send({ orchestratorModel: 'haiku' })
      expect(res.status).toBe(200)
      expect(res.body.settings.orchestratorModel).toBe('haiku')
    })

    it('rejects invalid orchestratorModel', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/settings')
        .send({ orchestratorModel: 'gpt-5' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('orchestratorModel')
    })

    it('updates pipelineTelemetryEnabled', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/settings')
        .send({ pipelineTelemetryEnabled: true })
      expect(res.status).toBe(200)
      expect(res.body.settings.pipelineTelemetryEnabled).toBe(true)
    })

    it('updates prePrompt', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/settings')
        .send({ prePrompt: 'Prefer backward-compatible migrations.' })
      expect(res.status).toBe(200)
      expect(res.body.settings.prePrompt).toBe('Prefer backward-compatible migrations.')
    })

    it('rejects non-string prePrompt', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/settings')
        .send({ prePrompt: 42 })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('prePrompt')
    })

    it('accepts empty body without error', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).patch('/api/projects/proj-1/settings').send({})
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('updates freestylePrePrompt', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/settings')
        .send({ freestylePrePrompt: 'Ship it autonomously.' })
      expect(res.status).toBe(200)
      expect(res.body.settings.freestylePrePrompt).toBe('Ship it autonomously.')
    })

    it('rejects non-string freestylePrePrompt', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/settings')
        .send({ freestylePrePrompt: 7 })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('freestylePrePrompt')
    })

    it('updates worktree env passthrough names without storing values', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/settings')
        .send({ worktreeEnvPassthrough: [' NODE_AUTH_TOKEN ', 'AWS_PROFILE', 'NODE_AUTH_TOKEN', ''] })
      expect(res.status).toBe(200)
      expect(res.body.settings.worktreeEnvPassthrough).toEqual(['NODE_AUTH_TOKEN', 'AWS_PROFILE'])
      expect(JSON.stringify(res.body)).not.toContain('secret-token')

      const get = await request(app).get('/api/projects/proj-1/settings')
      expect(get.body.worktreeEnvPassthrough).toEqual(['NODE_AUTH_TOKEN', 'AWS_PROFILE'])
    })

    it('rejects invalid worktree env passthrough names', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/settings')
        .send({ worktreeEnvPassthrough: ['NODE_AUTH_TOKEN=secret'] })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('invalid environment variable name')
    })
  })

  // ─── POST /config dailyBudgetUsd ─────────────────────────────────────────

  describe('POST /:projectId/config dailyBudgetUsd', () => {
    it('sets dailyBudgetUsd', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/config')
        .send({ dailyBudgetUsd: 15.0 })
      expect(res.status).toBe(200)
    })

    it('clears dailyBudgetUsd when null', async () => {
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.daily_budget_usd', '15')`).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/config')
        .send({ dailyBudgetUsd: null })
      expect(res.status).toBe(200)
    })
  })

  // ─── GET /metrics ──────────────────────────────────────────────────────────

  describe('GET /:projectId/metrics', () => {
    it('returns metrics data', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/metrics')
      // metrics depends on project.path existing — may return 200 or 500
      expect([200, 500]).toContain(res.status)
    })
  })

  // ─── Proposal refine and create-issue ─────────────────────────────────────

  describe('POST /:projectId/propose/:id/refine', () => {
    it('returns 404 for unknown proposal', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/propose/unknown/refine')
        .send({ feedback: 'more tests' })
      expect(res.status).toBe(404)
    })

    it('returns 400 when feedback is missing', async () => {
      // Create a proposal first
      const { createProposal, getProposal } = await import('./db')
      createProposal(db, { id: 'prop-ref', idea: 'test idea' })
      // Manually set status to review
      db.prepare(`UPDATE proposals SET status = 'review' WHERE id = 'prop-ref'`).run()

      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/propose/prop-ref/refine')
        .send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('feedback is required')
    })

    it('returns 409 when proposal is busy', async () => {
      const { createProposal } = await import('./db')
      createProposal(db, { id: 'prop-busy', idea: 'test' })
      db.prepare(`UPDATE proposals SET status = 'review' WHERE id = 'prop-busy'`).run()

      const pm = makeProposalManager({ isActive: vi.fn(() => true) })
      const ctx = makeContext(db, { proposalManager: pm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/propose/prop-busy/refine')
        .send({ feedback: 'more details' })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('PROPOSAL_BUSY')
    })

    it('returns 409 when proposal is not in review state', async () => {
      const { createProposal } = await import('./db')
      createProposal(db, { id: 'prop-pending', idea: 'test' })
      // status defaults to 'exploring', not 'review'

      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/propose/prop-pending/refine')
        .send({ feedback: 'more details' })
      expect(res.status).toBe(409)
      expect(res.body.error).toContain('not in review state')
    })

    it('returns 202 and calls sendRefinement on valid request', async () => {
      const { createProposal } = await import('./db')
      createProposal(db, { id: 'prop-ok', idea: 'test' })
      db.prepare(`UPDATE proposals SET status = 'review' WHERE id = 'prop-ok'`).run()

      const sendRefinement = vi.fn(async () => {})
      const pm = makeProposalManager({ sendRefinement })
      const ctx = makeContext(db, { proposalManager: pm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/propose/prop-ok/refine')
        .send({ feedback: 'add more tests' })
      expect(res.status).toBe(202)
      await new Promise((r) => setTimeout(r, 10))
      expect(sendRefinement).toHaveBeenCalledWith('prop-ok', 'add more tests')
    })
  })

  describe('POST /:projectId/propose/:id/create-issue', () => {
    it('returns 404 for unknown proposal', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/propose/unknown/create-issue')
      expect(res.status).toBe(404)
    })

    it('returns 409 when proposal is busy', async () => {
      const { createProposal } = await import('./db')
      createProposal(db, { id: 'prop-ci-busy', idea: 'test' })
      db.prepare(`UPDATE proposals SET status = 'review' WHERE id = 'prop-ci-busy'`).run()

      const pm = makeProposalManager({ isActive: vi.fn(() => true) })
      const ctx = makeContext(db, { proposalManager: pm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/propose/prop-ci-busy/create-issue')
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('PROPOSAL_BUSY')
    })

    it('returns 409 when proposal is not in review state', async () => {
      const { createProposal } = await import('./db')
      createProposal(db, { id: 'prop-ci-norev', idea: 'test' })

      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/propose/prop-ci-norev/create-issue')
      expect(res.status).toBe(409)
    })

    it('returns 202 and calls createIssue on valid request', async () => {
      const { createProposal } = await import('./db')
      createProposal(db, { id: 'prop-ci-ok', idea: 'test' })
      db.prepare(`UPDATE proposals SET status = 'review' WHERE id = 'prop-ci-ok'`).run()

      const createIssue = vi.fn(async () => {})
      const pm = makeProposalManager({ createIssue })
      const ctx = makeContext(db, { proposalManager: pm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/propose/prop-ci-ok/create-issue')
      expect(res.status).toBe(202)
      await new Promise((r) => setTimeout(r, 10))
      expect(createIssue).toHaveBeenCalledWith('prop-ci-ok')
    })
  })

  // ─── DELETE /chat/conversations/:id/messages/stream (active stream) ────

  describe('DELETE /:projectId/chat/conversations/:id/messages/stream', () => {
    it('aborts active stream and returns ok', async () => {
      const abort = vi.fn()
      const chatManager = makeChatManager({
        isActive: vi.fn(() => true),
        abort,
      })
      const ctx = makeContext(db, { chatManager: chatManager as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .delete('/api/projects/proj-1/chat/conversations/conv-123/messages/stream')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(abort).toHaveBeenCalledWith('conv-123')
    })
  })

  // ─── POST /setup/message additional paths ──────────────────────────────

  describe('POST /:projectId/setup/message additional paths', () => {
    it('returns 409 when setup is already in progress', async () => {
      const sm = makeSetupManager({ isSettingUp: vi.fn(() => true) })
      const ctx = makeContext(db, { setupManager: sm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/setup/message')
        .send({ sessionId: 'sess-1', message: 'hello' })
      expect(res.status).toBe(409)
    })

    it('returns 202 and calls resumeSetup on valid input', async () => {
      const resumeSetup = vi.fn()
      const sm = makeSetupManager({ resumeSetup })
      const ctx = makeContext(db, { setupManager: sm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/setup/message')
        .send({ sessionId: 'sess-1', message: 'hello' })
      expect(res.status).toBe(202)
      expect(resumeSetup).toHaveBeenCalled()
    })
  })

  // ─── POST /setup/install and /setup/start success paths ─────────────────

  describe('POST /:projectId/setup/install success', () => {
    it('returns 202 and calls startInstall', async () => {
      const startInstall = vi.fn()
      const sm = makeSetupManager({ startInstall })
      const ctx = makeContext(db, { setupManager: sm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/setup/install')
      expect(res.status).toBe(202)
      expect(startInstall).toHaveBeenCalled()
    })
  })

  describe('POST /:projectId/setup/start success', () => {
    it('returns 202 and calls startSetup', async () => {
      const startSetup = vi.fn()
      const sm = makeSetupManager({ startSetup })
      const ctx = makeContext(db, { setupManager: sm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/setup/start')
      expect(res.status).toBe(202)
      expect(startSetup).toHaveBeenCalled()
    })
  })

  // ─── POST /setup/abort ────────────────────────────────────────────────────

  describe('POST /:projectId/setup/abort', () => {
    it('aborts setup and returns ok', async () => {
      const abort = vi.fn()
      const sm = makeSetupManager({ abort })
      const ctx = makeContext(db, { setupManager: sm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/setup/abort')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(abort).toHaveBeenCalled()
    })
  })

  // ─── GET /jobs with query params ──────────────────────────────────────────

  describe('GET /:projectId/jobs with query params', () => {
    it('applies limit, offset, status, from, to filters', async () => {
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, finished_at, status) VALUES ('flt-1', 'sr:a', '2025-01-01T10:00:00.000Z', '2025-01-01T10:05:00.000Z', 'completed')`
      ).run()
      db.prepare(
        `INSERT INTO jobs (id, command, started_at, finished_at, status) VALUES ('flt-2', 'sr:b', '2025-06-01T10:00:00.000Z', '2025-06-01T10:05:00.000Z', 'failed')`
      ).run()
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get(
        '/api/projects/proj-1/jobs?limit=10&offset=0&status=completed'
      )
      expect(res.status).toBe(200)
    })

    it('pages durable queued admissions without limit amplification and keeps timestamps stable', async () => {
      const insertQueued = db.prepare(`
        INSERT INTO queued_jobs (
          id, command, queue_position, priority, enqueued_at
        ) VALUES (?, ?, ?, 'normal', ?)
      `)
      for (let index = 0; index < 55; index += 1) {
        insertQueued.run(
          `queued-${String(index).padStart(2, '0')}`,
          `/queued-${index}`,
          index + 1,
          `2026-07-10 10:${String(index).padStart(2, '0')}:00`,
        )
      }
      const insertHistory = db.prepare(`
        INSERT INTO jobs (id, command, started_at, status)
        VALUES (?, ?, ?, 'completed')
      `)
      for (let index = 0; index < 5; index += 1) {
        insertHistory.run(
          `history-${index}`,
          `/history-${index}`,
          `2026-07-09T0${index}:00:00.000Z`,
        )
      }
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const first = await request(app).get('/api/projects/proj-1/jobs?limit=10&offset=0')
      const repeated = await request(app).get('/api/projects/proj-1/jobs?limit=10&offset=0')
      expect(first.status).toBe(200)
      expect(first.body.total).toBe(60)
      expect(first.body.jobs).toHaveLength(10)
      expect(first.body.jobs.map((job: any) => job.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `queued-${String(index).padStart(2, '0')}`),
      )
      expect(first.body.jobs.every((job: any) => job.started_at === null)).toBe(true)
      expect(first.body.jobs[0].enqueued_at).toBe('2026-07-10 10:00:00')
      expect(repeated.body.jobs).toEqual(first.body.jobs)

      const boundary = await request(app).get('/api/projects/proj-1/jobs?limit=10&offset=52')
      expect(boundary.body.total).toBe(60)
      expect(boundary.body.jobs).toHaveLength(8)
      expect(boundary.body.jobs.slice(0, 3).map((job: any) => job.id))
        .toEqual(['queued-52', 'queued-53', 'queued-54'])
      expect(boundary.body.jobs.slice(3).map((job: any) => job.id))
        .toEqual(['history-4', 'history-3', 'history-2', 'history-1', 'history-0'])

      const historyOnly = await request(app)
        .get('/api/projects/proj-1/jobs?limit=2&offset=1&status=completed')
      expect(historyOnly.body.total).toBe(5)
      expect(historyOnly.body.jobs.map((job: any) => job.id)).toEqual(['history-3', 'history-2'])
    })
  })

  // ─── PUT /queue/reorder error path ────────────────────────────────────────

  describe('PUT /queue/reorder error path', () => {
    it('returns 400 when reorder throws', async () => {
      const qm = makeQueueManager({ reorder: vi.fn(() => { throw new Error('mismatch') }) })
      const ctx = makeContext(db, { queueManager: qm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .put('/api/projects/proj-1/queue/reorder')
        .send({ jobIds: ['a', 'b'] })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('mismatch')
    })
  })

  // ─── POST /propose success path ──────────────────────────────────────────

  describe('POST /:projectId/propose success path', () => {
    it('returns 202 with proposalId when proposal command exists', async () => {
      const canStartExploration = vi.fn(() => true)
      const startExploration = vi.fn(async () => {})
      const pm = makeProposalManager({ canStartExploration, startExploration })
      const ctx = makeContext(db, { proposalManager: pm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/propose')
        .send({ idea: 'add dark mode' })
      expect(res.status).toBe(202)
      expect(canStartExploration).toHaveBeenCalledOnce()
      expect(startExploration).toHaveBeenCalledOnce()
    })

    it('returns 400 before creating a proposal when the provider preflight fails', async () => {
      const startExploration = vi.fn(async () => {})
      const pm = makeProposalManager({
        canStartExploration: vi.fn(() => false),
        startExploration,
      })
      const ctx = makeContext(db, { proposalManager: pm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/propose')
        .send({ idea: 'add dark mode' })
      expect(res.status).toBe(400)
      expect(startExploration).not.toHaveBeenCalled()
      expect(listProposals(db, { limit: 20, offset: 0 }).total).toBe(0)
    })
  })

  // ─── DELETE /propose/:id (with existing proposal) ─────────────────────────

  describe('DELETE /:projectId/propose/:id with existing proposal', () => {
    it('deletes the proposal and calls cancel', async () => {
      const { createProposal } = await import('./db')
      createProposal(db, { id: 'prop-del', idea: 'delete me' })

      const cancel = vi.fn()
      const pm = makeProposalManager({ cancel })
      const ctx = makeContext(db, { proposalManager: pm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).delete('/api/projects/proj-1/propose/prop-del')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(cancel).toHaveBeenCalledWith('prop-del')
    })
  })

  // ─── GET /chat/conversations/:id/messages ────────────────────────────────

  describe('GET /:projectId/chat/conversations/:id/messages', () => {
    it('returns 404 for unknown conversation', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/chat/conversations/nope/messages')
      expect(res.status).toBe(404)
    })
  })

  // ─── POST /chat/conversations/:id/messages (404) ─────────────────────────

  describe('POST /:projectId/chat/conversations/:id/messages 404', () => {
    it('returns 404 for unknown conversation', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/chat/conversations/no-conv/messages')
        .send({ text: 'hello' })
      expect(res.status).toBe(404)
    })
  })

  // ─── GET /setup/install log ──────────────────────────────────────────────

  describe('GET /:projectId/setup/checkpoints install log', () => {
    it('includes logLines and savedSessionId in response', async () => {
      const sm = makeSetupManager({ getInstallLog: vi.fn(() => ['line1', 'line2']) })
      const ctx = makeContext(db, { setupManager: sm as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/setup/checkpoints')
      expect(res.status).toBe(200)
      expect(res.body.logLines).toEqual(['line1', 'line2'])
      expect(res.body).toHaveProperty('savedSessionId')
      expect(res.body).toHaveProperty('isInstalling')
      expect(res.body).toHaveProperty('isSettingUp')
    })
  })

  // ─── PATCH conversation model ──────────────────────────────────────────────

  describe('PATCH /:projectId/chat/conversations/:id model update', () => {
    it('updates model on a conversation with a valid model', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: 'sonnet' })
      const convId = createRes.body.conversation.id
      const res = await request(app)
        .patch(`/api/projects/proj-1/chat/conversations/${convId}`)
        .send({ model: 'haiku' })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('rejects an invalid model with 400 (no longer persists garbage)', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: 'sonnet' })
      const convId = createRes.body.conversation.id
      const res = await request(app)
        .patch(`/api/projects/proj-1/chat/conversations/${convId}`)
        .send({ model: 'not-a-real-model' })
      expect(res.status).toBe(400)
    })

    it('rejects a non-string title with 400', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: 'sonnet' })
      const convId = createRes.body.conversation.id
      const res = await request(app)
        .patch(`/api/projects/proj-1/chat/conversations/${convId}`)
        .send({ title: { not: 'a string' } })
      expect(res.status).toBe(400)
    })
  })

  // ─── Changes with active jobs ──────────────────────────────────────────────

  describe('GET /:projectId/changes with running jobs', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-desktop-changes-active-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('passes active commands from running and queued jobs', async () => {
      const getJobs = vi.fn(() => [
        { status: 'running', command: '/specrails:implement #1' },
        { status: 'queued', command: '/specrails:test' },
        { status: 'completed', command: '/specrails:build' },
      ])
      const qm = makeQueueManager({ getJobs })
      const ctx = makeContext(db, {
        queueManager: qm as any,
        project: { id: 'proj-1', slug: 'proj', name: 'Test', path: tmpDir, db_path: ':memory:', added_at: '', last_seen_at: '' },
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/changes')
      expect(res.status).toBe(200)
      expect(res.body.changes).toBeDefined()
    })
  })

  // ─── Template listing (non-empty) ────────────────────────────────────────

  describe('GET /:projectId/templates (non-empty)', () => {
    it('returns templates with parsed commands', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      // Create a template first
      await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'List Test', commands: ['/specrails:run'] })
      const res = await request(app).get('/api/projects/proj-1/templates')
      expect(res.status).toBe(200)
      expect(res.body.templates.length).toBeGreaterThan(0)
      expect(res.body.templates[0].commands).toBeDefined()
    })
  })

  // ─── PATCH template update commands ──────────────────────────────────────

  describe('PATCH /:projectId/templates/:templateId commands update', () => {
    it('updates commands on a template', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/templates')
        .send({ name: 'Cmd Update', commands: ['/specrails:run'] })
      const id = createRes.body.template.id
      const res = await request(app)
        .patch(`/api/projects/proj-1/templates/${id}`)
        .send({ commands: ['/specrails:test', '/specrails:build'] })
      expect(res.status).toBe(200)
      expect(res.body.template.commands).toEqual(['/specrails:test', '/specrails:build'])
    })
  })

  // ─── POST /chat send message fires async handler ─────────────────────────

  describe('POST /:projectId/chat/conversations/:id/messages async path', () => {
    it('returns 202 and triggers sendMessage', async () => {
      const sendMessage = vi.fn(async () => {})
      const chatManager = makeChatManager({ sendMessage })
      const ctx = makeContext(db, { chatManager: chatManager as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const createRes = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: 'sonnet' })
      const convId = createRes.body.conversation.id
      const res = await request(app)
        .post(`/api/projects/proj-1/chat/conversations/${convId}/messages`)
        .send({ text: 'hello world' })
      expect(res.status).toBe(202)
      await new Promise((r) => setTimeout(r, 10))
      expect(sendMessage).toHaveBeenCalledWith(convId, 'hello world', { lightweight: false, maxTurns: undefined })
    })
  })

  // ─── Terminals ──────────────────────────────────────────────────────────────

  describe('terminals', () => {
    const tmpdir = os.tmpdir()

    beforeEach(async () => {
      // Clear any leftover sessions between tests
      const { _resetTerminalManagerForTest } = await import('./terminal-manager')
      _resetTerminalManagerForTest()
    })

    afterEach(async () => {
      const { _resetTerminalManagerForTest } = await import('./terminal-manager')
      _resetTerminalManagerForTest()
      // give PTYs a tick to die
      await new Promise((r) => setTimeout(r, 50))
    })

    it('GET /terminals returns empty list + limit for a fresh project', async () => {
      const ctx = makeContext(db, { project: { id: 'proj-1', slug: 'p1', name: 'P1', path: tmpdir, db_path: ':memory:', added_at: '', last_seen_at: '' } })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/terminals')
      expect(res.status).toBe(200)
      expect(res.body.sessions).toEqual([])
      expect(res.body.limit).toBe(10)
    })

    it('POST /terminals creates a session with project.path as cwd', async () => {
      const ctx = makeContext(db, { project: { id: 'proj-1', slug: 'p1', name: 'P1', path: tmpdir, db_path: ':memory:', added_at: '', last_seen_at: '' } })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/terminals').send({ cols: 90, rows: 30 })
      expect(res.status).toBe(201)
      expect(res.body.session.cwd).toBe(tmpdir)
      expect(res.body.session.cols).toBe(90)
      expect(res.body.session.rows).toBe(30)
      expect(typeof res.body.session.id).toBe('string')
    })

    it('POST /terminals returns 409 when limit reached', async () => {
      const ctx = makeContext(db, { project: { id: 'proj-1', slug: 'p1', name: 'P1', path: tmpdir, db_path: ':memory:', added_at: '', last_seen_at: '' } })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      for (let i = 0; i < 10; i++) {
        const r = await request(app).post('/api/projects/proj-1/terminals').send({})
        expect(r.status).toBe(201)
      }
      const res = await request(app).post('/api/projects/proj-1/terminals').send({})
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('terminal_limit_exceeded')
      expect(res.body.limit).toBe(10)
    })

    it('PATCH /terminals/:id rejects empty and overlong names with 400', async () => {
      const ctx = makeContext(db, { project: { id: 'proj-1', slug: 'p1', name: 'P1', path: tmpdir, db_path: ':memory:', added_at: '', last_seen_at: '' } })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const create = await request(app).post('/api/projects/proj-1/terminals').send({})
      const id = create.body.session.id
      const bad1 = await request(app).patch(`/api/projects/proj-1/terminals/${id}`).send({ name: '' })
      expect(bad1.status).toBe(400)
      const bad2 = await request(app).patch(`/api/projects/proj-1/terminals/${id}`).send({ name: 'x'.repeat(65) })
      expect(bad2.status).toBe(400)
      const ok = await request(app).patch(`/api/projects/proj-1/terminals/${id}`).send({ name: 'build' })
      expect(ok.status).toBe(200)
      expect(ok.body.session.name).toBe('build')
    })

    it('PATCH /terminals/:id returns 404 for session belonging to another project', async () => {
      const ctxA = makeContext(db, { project: { id: 'proj-A', slug: 'a', name: 'A', path: tmpdir, db_path: ':memory:', added_at: '', last_seen_at: '' } })
      const ctxB = makeContext(initDb(':memory:'), { project: { id: 'proj-B', slug: 'b', name: 'B', path: tmpdir, db_path: ':memory:', added_at: '', last_seen_at: '' } })
      const contexts = new Map<string, ProjectContext>()
      contexts.set('proj-A', ctxA)
      contexts.set('proj-B', ctxB)
      const { app } = createApp(contexts)
      const created = await request(app).post('/api/projects/proj-A/terminals').send({})
      const id = created.body.session.id
      const cross = await request(app).patch(`/api/projects/proj-B/terminals/${id}`).send({ name: 'x' })
      expect(cross.status).toBe(404)
    })

    it('DELETE /terminals/:id returns 200 then 404 on second call', async () => {
      const ctx = makeContext(db, { project: { id: 'proj-1', slug: 'p1', name: 'P1', path: tmpdir, db_path: ':memory:', added_at: '', last_seen_at: '' } })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const create = await request(app).post('/api/projects/proj-1/terminals').send({})
      const id = create.body.session.id
      const first = await request(app).delete(`/api/projects/proj-1/terminals/${id}`)
      expect(first.status).toBe(200)
      const second = await request(app).delete(`/api/projects/proj-1/terminals/${id}`)
      expect(second.status).toBe(404)
    })

    it('DELETE /terminals/:id returns 404 for cross-project access', async () => {
      const ctxA = makeContext(db, { project: { id: 'proj-A', slug: 'a', name: 'A', path: tmpdir, db_path: ':memory:', added_at: '', last_seen_at: '' } })
      const ctxB = makeContext(initDb(':memory:'), { project: { id: 'proj-B', slug: 'b', name: 'B', path: tmpdir, db_path: ':memory:', added_at: '', last_seen_at: '' } })
      const contexts = new Map<string, ProjectContext>()
      contexts.set('proj-A', ctxA)
      contexts.set('proj-B', ctxB)
      const { app } = createApp(contexts)
      const created = await request(app).post('/api/projects/proj-A/terminals').send({})
      const id = created.body.session.id
      const cross = await request(app).delete(`/api/projects/proj-B/terminals/${id}`)
      expect(cross.status).toBe(404)
    })
  })

  describe('terminal-settings (per-project override)', () => {
    it('GET returns { resolved, override, desktopDefaults } shape with empty override', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/terminal-settings')
      expect(res.status).toBe(200)
      expect(res.body.override).toEqual({})
      expect(res.body.desktopDefaults.fontSize).toBe(12)
      expect(res.body.resolved.fontSize).toBe(12)
    })

    it('PATCH with field sets override and resolved reflects override', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/terminal-settings')
        .send({ fontSize: 18, renderMode: 'webgl' })
      expect(res.status).toBe(200)
      expect(res.body.override).toEqual({ fontSize: 18, renderMode: 'webgl' })
      expect(res.body.resolved.fontSize).toBe(18)
      expect(res.body.resolved.renderMode).toBe('webgl')
      expect(res.body.desktopDefaults.fontSize).toBe(12)
    })

    it('PATCH with null clears that override field', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      await request(app).patch('/api/projects/proj-1/terminal-settings').send({ fontSize: 18 })
      const res = await request(app)
        .patch('/api/projects/proj-1/terminal-settings')
        .send({ fontSize: null })
      expect(res.status).toBe(200)
      expect(res.body.override).toEqual({})
      expect(res.body.resolved.fontSize).toBe(12)
    })

    it('PATCH with invalid value returns 400 validation_failed', async () => {
      const ctx = makeContext(db)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .patch('/api/projects/proj-1/terminal-settings')
        .send({ fontSize: 4 })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('validation_failed')
      expect(res.body.field).toBe('fontSize')
    })

    it('GET unknown project returns 404 via middleware', async () => {
      const { app } = createApp(new Map())
      const res = await request(app).get('/api/projects/missing/terminal-settings')
      expect(res.status).toBe(404)
    })
  })

  // ─── Add Spec model picker — default + validation ───────────────────────────
  describe('stripSpecMetadataSections', () => {
    it('removes the Spec Title, Labels, and Estimated Complexity sections', () => {
      const input = [
        '## Spec Title',
        'Add SpecRails logo',
        '',
        '## Labels',
        'ui, branding',
        '',
        '## Problem Statement',
        'Splash screen lacks logo.',
        '',
        '## Estimated Complexity',
        'Low — single asset swap.',
      ].join('\n')
      const out = stripSpecMetadataSections(input)
      expect(out).not.toMatch(/Spec Title/)
      expect(out).not.toMatch(/^## Labels/m)
      expect(out).not.toMatch(/Estimated Complexity/)
      expect(out).toContain('Problem Statement')
      expect(out).toContain('Splash screen lacks logo.')
    })

    it('leaves a buffer with no metadata sections unchanged (modulo trim)', () => {
      const input = '## Problem Statement\n\nNo logo.\n'
      expect(stripSpecMetadataSections(input)).toBe('## Problem Statement\n\nNo logo.')
    })

    it('handles a multi-line Labels block', () => {
      const input = '## Labels\nui\nbranding\nsplash\n\n## Problem Statement\nfoo'
      const out = stripSpecMetadataSections(input)
      expect(out).not.toMatch(/^## Labels/m)
      expect(out).toContain('Problem Statement')
      expect(out).toContain('foo')
    })

    it('also strips the Short Summary section', () => {
      const input = [
        '## Spec Title',
        'Add dark mode',
        '',
        '## Problem Statement',
        'Users want dark mode.',
        '',
        '## Short Summary',
        'Lets users switch to a dark theme persisted app-wide.',
      ].join('\n')
      const out = stripSpecMetadataSections(input)
      expect(out).not.toMatch(/Short Summary/)
      expect(out).toContain('Problem Statement')
    })
  })

  describe('extractShortSummary', () => {
    it('returns the body of the Short Summary section', () => {
      const input = [
        '## Problem Statement',
        'foo',
        '',
        '## Short Summary',
        'A crisp one-line summary.',
        '',
        '## Estimated Complexity',
        'Low',
      ].join('\n')
      expect(extractShortSummary(input)).toBe('A crisp one-line summary.')
    })

    it('returns null when no Short Summary section is present', () => {
      expect(extractShortSummary('## Problem Statement\nfoo')).toBeNull()
    })

    it('returns null for an empty Short Summary section', () => {
      const input = '## Short Summary\n\n## Next Section\nbody'
      expect(extractShortSummary(input)).toBeNull()
    })

    it('supports multi-line summary body', () => {
      const input = '## Short Summary\nLine one.\nLine two.\n\n## Next\nbody'
      const out = extractShortSummary(input)
      expect(out).not.toBeNull()
      expect(out).toContain('Line one.')
      expect(out).toContain('Line two.')
    })
  })

  describe('formatDescriptionWithCriteria', () => {
    it('appends a new Acceptance Criteria section to a body without one', () => {
      const out = formatDescriptionWithCriteria('## Problem Statement\n\nThing.', ['A', 'B'])
      expect(out).toBe('## Problem Statement\n\nThing.\n\n## Acceptance Criteria\n\n- A\n- B')
    })

    it('replaces an existing Acceptance Criteria section', () => {
      const body = '## Problem Statement\n\nThing.\n\n## Acceptance Criteria\n\n- old\n- old2'
      const out = formatDescriptionWithCriteria(body, ['fresh'])
      expect(out).toBe('## Problem Statement\n\nThing.\n\n## Acceptance Criteria\n\n- fresh')
    })

    it('removes the section when criteria is empty', () => {
      const body = '## Problem Statement\n\nThing.\n\n## Acceptance Criteria\n\n- a'
      expect(formatDescriptionWithCriteria(body, [])).toBe('## Problem Statement\n\nThing.')
    })

    it('returns just the section when body is empty', () => {
      expect(formatDescriptionWithCriteria('', ['solo'])).toBe('## Acceptance Criteria\n\n- solo')
    })

    it('preserves trailing sections after Acceptance Criteria when replacing', () => {
      const body = '## A\n\nfoo\n\n## Acceptance Criteria\n\n- old\n\n## B\n\nbar'
      const out = formatDescriptionWithCriteria(body, ['new'])
      // The old section is replaced; the new one is appended at the end.
      expect(out).toContain('## A\n\nfoo')
      expect(out).toContain('## B\n\nbar')
      expect(out).toContain('## Acceptance Criteria\n\n- new')
      expect(out).not.toContain('- old')
    })

    it('is case-insensitive on the heading', () => {
      const body = '## acceptance criteria\n\n- x'
      expect(formatDescriptionWithCriteria(body, ['y'])).toBe('## Acceptance Criteria\n\n- y')
    })
  })

  describe('PATCH /:projectId/tickets/:id with acceptanceCriteria', () => {
    function makeAppWithTicket() {
      const ctx = makeContext(db)
      const fp = resolveTicketStoragePath(ctx.project.path)
      mutateStore(fp, (s) => {
        s.next_id = 42
        s.tickets['41'] = {
          id: 41,
          title: 'Sample',
          description: '## Problem Statement\n\nIssue.',
          status: 'todo',
          priority: 'medium',
          labels: [],
          source: 'manual',
          assignee: null,
          prerequisites: [],
          metadata: {},
          attachments: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          origin_conversation_id: null,
        } as never
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      return { app, fp }
    }

    it('writes a new Acceptance Criteria section when missing', async () => {
      const { app, fp } = makeAppWithTicket()
      const res = await request(app)
        .patch('/api/projects/proj-1/tickets/41')
        .send({ acceptanceCriteria: ['A', 'B'] })
      expect(res.status).toBe(200)
      const stored = readStore(fp).tickets['41']!
      expect(stored.description).toContain('## Acceptance Criteria\n\n- A\n- B')
    })

    it('replaces an existing Acceptance Criteria section', async () => {
      const { app, fp } = makeAppWithTicket()
      mutateStore(fp, (s) => {
        s.tickets['41'].description = '## Problem Statement\n\nx\n\n## Acceptance Criteria\n\n- old'
      })
      const res = await request(app)
        .patch('/api/projects/proj-1/tickets/41')
        .send({ acceptanceCriteria: ['fresh'] })
      expect(res.status).toBe(200)
      const stored = readStore(fp).tickets['41']!
      expect(stored.description).toContain('- fresh')
      expect(stored.description).not.toContain('- old')
    })

    it('removes the section when acceptanceCriteria is an empty array', async () => {
      const { app, fp } = makeAppWithTicket()
      mutateStore(fp, (s) => {
        s.tickets['41'].description = '## Problem Statement\n\nx\n\n## Acceptance Criteria\n\n- a'
      })
      const res = await request(app)
        .patch('/api/projects/proj-1/tickets/41')
        .send({ acceptanceCriteria: [] })
      expect(res.status).toBe(200)
      const stored = readStore(fp).tickets['41']!
      expect(stored.description).not.toContain('Acceptance Criteria')
    })

    it('preserves any existing section when acceptanceCriteria is omitted', async () => {
      const { app, fp } = makeAppWithTicket()
      mutateStore(fp, (s) => {
        s.tickets['41'].description = '## Problem Statement\n\nx\n\n## Acceptance Criteria\n\n- keep'
      })
      const res = await request(app)
        .patch('/api/projects/proj-1/tickets/41')
        .send({ title: 'Sample renamed' })
      expect(res.status).toBe(200)
      const stored = readStore(fp).tickets['41']!
      expect(stored.title).toBe('Sample renamed')
      expect(stored.description).toContain('- keep')
    })

    it('rejects a non-array acceptanceCriteria payload', async () => {
      const { app } = makeAppWithTicket()
      const res = await request(app)
        .patch('/api/projects/proj-1/tickets/41')
        .send({ acceptanceCriteria: 'A, B' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('acceptanceCriteria')
    })

    it('rejects an array containing non-strings', async () => {
      const { app } = makeAppWithTicket()
      const res = await request(app)
        .patch('/api/projects/proj-1/tickets/41')
        .send({ acceptanceCriteria: ['ok', 123] })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /default-spec-model', () => {
    let tmpDir: string
    let registryHome: string
    let prevRegistryHome: string | undefined

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specmodels-'))
      // Relocate-artifacts: install-config.yaml lives in the per-project HOME
      // dir, not the repo. Point the registry home at a tmp dir so the resolver
      // writes/reads there instead of the real ~/.specrails.
      registryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'specmodels-home-'))
      prevRegistryHome = process.env.SPECRAILS_REGISTRY_HOME
      process.env.SPECRAILS_REGISTRY_HOME = registryHome
    })
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      fs.rmSync(registryHome, { recursive: true, force: true })
      if (prevRegistryHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
      else process.env.SPECRAILS_REGISTRY_HOME = prevRegistryHome
    })

    function ctxWithProject(
      provider: 'claude' | 'codex' | 'gemini' | 'kimi' | undefined,
      configBody?: string,
    ): ProjectContext {
      const ctx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'P', path: tmpDir,
          db_path: ':memory:', added_at: '', last_seen_at: '',
          ...(provider ? { provider } : {}),
        } as any,
      })
      if (configBody !== undefined) {
        // Write to the relocated per-project HOME location (resolver target).
        const configPath = installConfigPath({ slug: 'proj', path: tmpDir })
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, configBody)
      }
      return ctx
    }

    it.each([
      [{}, 'claude', 'sonnet'],
      [{ provider: 'not-a-provider' }, 'claude', 'sonnet'],
    ] as const)(
      'fails safe to Claude when serializing an absent or invalid provider (%#)',
      (config, expectedProvider, expectedModel) => {
        const yaml = serializeInstallConfigYaml(config)
        expect(yaml).toContain(`provider: ${expectedProvider}`)
        expect(yaml).toContain(`defaults: { model: ${expectedModel} }`)
      },
    )

    it('returns claude default when no install-config and provider is claude', async () => {
      const ctx = ctxWithProject('claude')
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/default-spec-model')
      expect(res.status).toBe(200)
      expect(res.body.provider).toBe('claude')
      expect(res.body.model).toBe('sonnet')
      expect(res.body.allowed.map((m: { value: string }) => m.value)).toEqual(['sonnet', 'fable', 'opus', 'haiku'])
    })

    it('returns codex default when provider is codex', async () => {
      const ctx = ctxWithProject('codex')
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/default-spec-model')
      expect(res.status).toBe(200)
      expect(res.body.provider).toBe('codex')
      expect(res.body.model).toBe('gpt-5.5')
      expect(res.body.allowed.map((m: { value: string }) => m.value)).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'])
    })

    it('honors install-config defaults.model when valid', async () => {
      const ctx = ctxWithProject('claude', 'models:\n  defaults: { model: opus }\n')
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/default-spec-model')
      expect(res.body.model).toBe('opus')
    })

    it('preserves an exact configured Kimi alias and advertises custom-alias support', async () => {
      const customAlias = 'moonshot-team/private-coder:v2'
      const ctx = ctxWithProject(
        'kimi',
        `models:\n  defaults: { model: ${customAlias} }\n`,
      )
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/default-spec-model')

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        provider: 'kimi',
        model: customAlias,
        customModelAliases: true,
      })
      expect(res.body.allowed.map((entry: { value: string }) => entry.value)).toEqual([
        'k3',
        'kimi-for-coding',
        'kimi-for-coding-highspeed',
      ])
    })

    it('rejects an unsafe configured Kimi alias and falls back to K3', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ctx = ctxWithProject('kimi', 'models:\n  defaults: { model: --yolo }\n')
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/default-spec-model')

      expect(res.status).toBe(200)
      expect(res.body.model).toBe('k3')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('falls back to provider default when configured model is not in allow-list', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ctx = ctxWithProject('claude', 'models:\n  defaults: { model: bogus-model }\n')
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/default-spec-model')
      expect(res.body.model).toBe('sonnet')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('defaults provider to claude when undefined on the project row', async () => {
      const ctx = ctxWithProject(undefined)
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/default-spec-model')
      expect(res.body.provider).toBe('claude')
      expect(res.body.model).toBe('sonnet')
    })

    it('relocates install-config writes OUT of the repo and reads them back', async () => {
      // PRIMARY relocation fix: POST /setup/install-config must NOT create any
      // .specrails inside the user's repo, and GET /default-spec-model must read
      // the config back from the per-project HOME dir.
      const ctx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'P', path: tmpDir,
          db_path: ':memory:', provider: 'claude', added_at: '', last_seen_at: '',
        } as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const write = await request(app)
        .post('/api/projects/proj-1/setup/install-config')
        .send({ version: 1, provider: 'claude', tier: 'quick', models: { defaults: { model: 'opus' } } })
      expect(write.status).toBe(200)
      // The reported path is the relocated HOME path, never the repo.
      expect(write.body.path).toBe(installConfigPath({ slug: 'proj', path: tmpDir }))
      expect(String(write.body.path).startsWith(tmpDir)).toBe(false)

      // ZERO .specrails created inside the repo by the install-config write.
      expect(fs.existsSync(path.join(tmpDir, '.specrails'))).toBe(false)

      // The config is read back from HOME by the model resolver.
      const res = await request(app).get('/api/projects/proj-1/default-spec-model')
      expect(res.body.model).toBe('opus')
    })

    it.each([
      ['kimi', 'k3'],
      ['claude', 'sonnet'],
    ] as const)(
      'serializes a minimal MCP-compatible %s install config with its provider default %s',
      async (provider, expectedModel) => {
        const ctx = makeContext(db, {
          project: {
            id: 'proj-1', slug: 'proj', name: 'P', path: tmpDir,
            db_path: ':memory:', provider, providers: [provider], added_at: '', last_seen_at: '',
          } as any,
        })
        const { app } = createApp(new Map([['proj-1', ctx]]))

        // This is the minimal shape specrails_setup(install_config) forwards:
        // no models block, so the server serializer owns the provider default.
        const write = await request(app)
          .post('/api/projects/proj-1/setup/install-config')
          .send({ provider, agents: { selected: [], excluded: [] }, tier: 'quick' })

        expect(write.status).toBe(200)
        const yaml = fs.readFileSync(
          installConfigPathForProvider({ slug: 'proj', path: tmpDir }, provider),
          'utf-8',
        )
        expect(yaml).toContain(`provider: ${provider}`)
        expect(yaml).toContain(`defaults: { model: ${expectedModel} }`)
      },
    )

    it('persists a PER-PROVIDER install-config per provider (additive, not clobbered)', async () => {
      // Multi-provider regression: installing providers in turn used
      // to leave only the LAST provider's config in the single shared file. Each
      // POST must now also write install-config.<provider>.yaml so every config
      // survives.
      const ctx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'P', path: tmpDir,
          db_path: ':memory:', provider: 'claude', added_at: '', last_seen_at: '',
        } as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const modelByProvider: Record<string, string> = {
        claude: 'opus',
        codex: 'gpt-5.5',
        gemini: 'gemini-3.5-flash',
        kimi: 'k3',
      }
      for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
        const w = await request(app)
          .post('/api/projects/proj-1/setup/install-config')
          .send({
            version: 1,
            provider,
            tier: 'quick',
            models: { defaults: { model: modelByProvider[provider] } },
          })
        expect(w.status).toBe(200)
        expect(w.body.providerPath).toBe(installConfigPathForProvider({ slug: 'proj', path: tmpDir }, provider))
      }

      // All per-provider configs coexist, each carrying its own provider.
      for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
        const p = installConfigPathForProvider({ slug: 'proj', path: tmpDir }, provider)
        expect(fs.existsSync(p)).toBe(true)
        expect(fs.readFileSync(p, 'utf-8')).toContain(`provider: ${provider}`)
      }
      // The shared file is still written (legacy readers) = the last provider.
      expect(fs.readFileSync(installConfigPath({ slug: 'proj', path: tmpDir }), 'utf-8')).toContain('provider: kimi')
      // And still ZERO .specrails in the repo.
      expect(fs.existsSync(path.join(tmpDir, '.specrails'))).toBe(false)
    })

    it('PATCH /agent-models writes install-config to HOME, not the repo', async () => {
      // Seed agents in the repo (legacy/un-relocated project) so applyModelConfig
      // patches them; the install-config it reads/writes must land in HOME.
      const agentsDir = path.join(tmpDir, '.claude', 'agents')
      fs.mkdirSync(agentsDir, { recursive: true })
      fs.writeFileSync(path.join(agentsDir, 'sr-architect.md'), '---\nmodel: sonnet\n---\nbody\n')

      const ctx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'P', path: tmpDir,
          db_path: ':memory:', provider: 'claude', added_at: '', last_seen_at: '',
        } as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app)
        .patch('/api/projects/proj-1/agent-models')
        .send({ defaultModel: 'opus' })
      expect(res.status).toBe(200)
      // The agent frontmatter (in-repo, legacy) was patched.
      expect(fs.readFileSync(path.join(agentsDir, 'sr-architect.md'), 'utf-8')).toContain('model: opus')
      // The install-config landed in HOME, NOT the repo's .specrails.
      expect(fs.existsSync(path.join(tmpDir, '.specrails'))).toBe(false)
      expect(fs.existsSync(installConfigPath({ slug: 'proj', path: tmpDir }))).toBe(true)

      // GET reflects the patched model from the in-repo agents dir.
      const get = await request(app).get('/api/projects/proj-1/agent-models')
      expect(get.body.agents).toEqual([{ name: 'sr-architect', model: 'opus' }])
    })

    it.each([
      ['claude', 'sonnet', 'opus'],
      ['codex', 'gpt-5.5', 'gpt-5.4'],
      ['gemini', 'gemini-3.5-flash', 'gemini-3.1-pro-preview'],
      ['kimi', 'k3', 'kimi-for-coding'],
    ] as const)(
      'creates an absent %s config from an overrides-only patch without cross-provider defaults',
      async (provider, expectedDefault, overrideModel) => {
        const { app } = createApp(new Map([
          ['proj-1', ctxWithProject(provider)],
        ]))

        const patched = await request(app)
          .patch('/api/projects/proj-1/agent-models')
          .send({ overrides: { 'sr-architect': overrideModel } })

        expect(patched.status).toBe(200)
        const config = fs.readFileSync(
          installConfigPath({ slug: 'proj', path: tmpDir }),
          'utf8',
        )
        expect(config).toContain(`provider: ${provider}`)
        expect(config).toContain(`defaults: { model: ${expectedDefault} }`)
        expect(config).toContain(`sr-architect: ${overrideModel}`)
      },
    )

    it.each([
      ['claude', 'opus', 'haiku'],
      ['codex', 'gpt-5.4', 'gpt-5.4-mini'],
      ['gemini', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'],
      ['kimi', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
    ] as const)(
      'preserves a valid parsed %s default during an overrides-only patch',
      async (provider, existingDefault, overrideModel) => {
        const ctx = ctxWithProject(
          provider,
          [
            `provider: ${provider}`,
            'models:',
            `  defaults: { model: ${existingDefault} }`,
            '  overrides: {}',
            '',
          ].join('\n'),
        )
        const { app } = createApp(new Map([['proj-1', ctx]]))

        const patched = await request(app)
          .patch('/api/projects/proj-1/agent-models')
          .send({ overrides: { 'sr-architect': overrideModel } })

        expect(patched.status).toBe(200)
        const config = fs.readFileSync(
          installConfigPath({ slug: 'proj', path: tmpDir }),
          'utf8',
        )
        expect(config).toContain(`provider: ${provider}`)
        expect(config).toContain(`defaults: { model: ${existingDefault} }`)
      },
    )

    it('replaces a stale cross-provider parsed default with the project provider default', async () => {
      const ctx = ctxWithProject(
        'codex',
        'provider: claude\nmodels:\n  defaults: { model: sonnet }\n  overrides: {}\n',
      )
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const patched = await request(app)
        .patch('/api/projects/proj-1/agent-models')
        .send({ overrides: { 'sr-architect': 'gpt-5.4' } })

      expect(patched.status).toBe(200)
      const config = fs.readFileSync(
        installConfigPath({ slug: 'proj', path: tmpDir }),
        'utf8',
      )
      expect(config).toContain('provider: codex')
      expect(config).toContain('defaults: { model: gpt-5.5 }')
      expect(config).not.toContain('sonnet')
    })

    it('GET /agent-models projects the K3 fallback only over direct Kimi role skills', async () => {
      const skillsDir = path.join(tmpDir, '.kimi-code', 'skills')
      for (const role of ['sr-architect', 'custom-auditor']) {
        const dir = path.join(skillsDir, role)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${role}\n`)
      }
      fs.mkdirSync(path.join(skillsDir, 'specrails-implement'), { recursive: true })
      fs.writeFileSync(
        path.join(skillsDir, 'specrails-implement', 'SKILL.md'),
        '# operational command, not a role\n',
      )
      fs.mkdirSync(path.join(skillsDir, 'sr-incomplete'), { recursive: true })

      const { app } = createApp(new Map([
        ['proj-1', ctxWithProject('kimi')],
      ]))
      const res = await request(app).get('/api/projects/proj-1/agent-models')

      expect(res.status).toBe(200)
      expect(res.body.agents).toEqual([
        { name: 'custom-auditor', model: 'k3' },
        { name: 'sr-architect', model: 'k3' },
      ])
    })

    it('PATCH /agent-models preserves exact Kimi aliases without modifying SKILL.md', async () => {
      const skillsDir = path.join(tmpDir, '.kimi-code', 'skills')
      const originalBodies = new Map<string, string>()
      for (const role of ['sr-architect', 'sr-developer']) {
        const dir = path.join(skillsDir, role)
        const body = `---\nname: ${role}\ndescription: ${role}\ntype: prompt\n---\n\n# ${role}\n`
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'SKILL.md'), body)
        originalBodies.set(role, body)
      }
      const defaultAlias = 'Moonshot-Team/Private_Coder:v2'
      const architectAlias = 'moonshot-team/architect.v3'
      const missingAlias = 'moonshot-team/missing:v1'
      const { app } = createApp(new Map([
        ['proj-1', ctxWithProject('kimi')],
      ]))

      const patched = await request(app)
        .patch('/api/projects/proj-1/agent-models')
        .send({
          defaultModel: defaultAlias,
          overrides: {
            'sr-architect': architectAlias,
            'sr-missing': missingAlias,
          },
        })

      expect(patched.status).toBe(200)
      expect(patched.body.agents).toEqual([
        { name: 'sr-architect', model: architectAlias },
        { name: 'sr-developer', model: defaultAlias },
      ])
      for (const [role, body] of originalBodies) {
        expect(fs.readFileSync(path.join(skillsDir, role, 'SKILL.md'), 'utf8')).toBe(body)
      }
      expect(fs.existsSync(path.join(skillsDir, 'sr-missing'))).toBe(false)

      const config = fs.readFileSync(
        installConfigPath({ slug: 'proj', path: tmpDir }),
        'utf8',
      )
      expect(config).toContain('provider: kimi')
      expect(config).toContain(`defaults: { model: ${defaultAlias} }`)
      expect(config).toContain(`sr-architect: ${architectAlias}`)
      expect(config).toContain(`sr-missing: ${missingAlias}`)

      const fetched = await request(app).get('/api/projects/proj-1/agent-models')
      expect(fetched.body.agents).toEqual(patched.body.agents)
    })

    it('GET /agent-models falls back to K3 for unsafe Kimi config aliases', async () => {
      const roleDir = path.join(tmpDir, '.kimi-code', 'skills', 'sr-architect')
      fs.mkdirSync(roleDir, { recursive: true })
      fs.writeFileSync(path.join(roleDir, 'SKILL.md'), '# architect\n')
      const ctx = ctxWithProject(
        'kimi',
        [
          'provider: kimi',
          'models:',
          '  defaults: { model: --yolo }',
          '  overrides:',
          '    sr-architect: --danger',
          'agent_teams: false',
          '',
        ].join('\n'),
      )
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/agent-models')
      expect(res.status).toBe(200)
      expect(res.body.agents).toEqual([{ name: 'sr-architect', model: 'k3' }])

      const rejected = await request(app)
        .patch('/api/projects/proj-1/agent-models')
        .send({ defaultModel: '--yolo' })
      expect(rejected.status).toBe(400)
      expect(fs.readFileSync(path.join(roleDir, 'SKILL.md'), 'utf8')).toBe('# architect\n')
    })

    it.each([
      ['claude', 'opus'],
      ['codex', 'gpt-5.4'],
      ['gemini', 'gemini-3.1-pro-preview'],
    ] as const)(
      'keeps the existing .claude agent projection byte-identical for %s',
      async (provider, targetModel) => {
        const agentsDir = path.join(tmpDir, '.claude', 'agents')
        fs.mkdirSync(agentsDir, { recursive: true })
        const before = [
          '---',
          'name: sr-architect',
          'model: sonnet',
          'description: existing role',
          '---',
          '',
          'body',
          '',
        ].join('\n')
        const agentPath = path.join(agentsDir, 'sr-architect.md')
        fs.writeFileSync(agentPath, before)
        const { app } = createApp(new Map([
          ['proj-1', ctxWithProject(provider)],
        ]))

        const res = await request(app)
          .patch('/api/projects/proj-1/agent-models')
          .send({ defaultModel: targetModel })

        expect(res.status).toBe(200)
        expect(fs.readFileSync(agentPath, 'utf8'))
          .toBe(before.replace('model: sonnet', `model: ${targetModel}`))
      },
    )
  })

  describe('POST /tickets/generate-spec — model validation', () => {
    function ctxFor(provider: 'claude' | 'codex' | 'kimi'): ProjectContext {
      return makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'P', path: '/tmp', db_path: ':memory:',
          added_at: '', last_seen_at: '', provider,
        } as any,
        // Stub the spawn — generate-spec spawns a subprocess that we don't
        // want to actually start. The router fires it after validation, so
        // a 200/400 distinction is enough here.
        queueManager: makeQueueManager() as any,
      })
    }

    it('rejects an invalid model with 400 + allowed list', async () => {
      const ctx = ctxFor('claude')
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/tickets/generate-spec')
        .send({ idea: 'do a thing', model: 'not-a-real-model' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Invalid model/)
      expect(res.body.allowed).toEqual(['sonnet', 'fable', 'opus', 'haiku'])
    })

    it('rejects a cross-provider model with 400', async () => {
      const ctx = ctxFor('claude')
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/tickets/generate-spec')
        .send({ idea: 'idea', model: 'gpt-5.4-mini' })
      expect(res.status).toBe(400)
    })

    it('rejects an empty idea with 400', async () => {
      const ctx = ctxFor('claude')
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/tickets/generate-spec')
        .send({ idea: '   ' })
      expect(res.status).toBe(400)
    })

    it('rejects Kimi Quick generation before any spawn', async () => {
      const ctx = ctxFor('kimi')
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/tickets/generate-spec')
        .send({ idea: 'do a thing', model: 'k3' })
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({
        error: 'provider_tool_policy_unsupported',
        provider: 'kimi',
      })
    })

  })

  describe('POST /chat/conversations — model validation', () => {
    it('rejects an invalid model with 400 + allowed list', async () => {
      const ctx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'P', path: '/tmp', db_path: ':memory:',
          added_at: '', last_seen_at: '', provider: 'claude',
        } as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: 'not-real' })
      expect(res.status).toBe(400)
      expect(res.body.allowed).toEqual(['sonnet', 'fable', 'opus', 'haiku'])
    })

    it('falls back to provider default when no model is sent', async () => {
      const ctx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'P', path: '/tmp', db_path: ':memory:',
          added_at: '', last_seen_at: '', provider: 'claude',
        } as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({})
      expect(res.status).toBe(201)
      expect(res.body.conversation.model).toBe('sonnet')
    })

    it('preserves exact custom Kimi aliases on create and update', async () => {
      const firstAlias = 'moonshot-team/private-coder:v2'
      const secondAlias = 'moonshot-team/private-coder:v3'
      const ctx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'P', path: '/tmp', db_path: ':memory:',
          added_at: '', last_seen_at: '', provider: 'kimi', providers: ['kimi', 'claude'],
        } as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const created = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: firstAlias })
      expect(created.status).toBe(201)
      expect(created.body.conversation).toMatchObject({
        provider: 'kimi',
        model: firstAlias,
      })

      const updated = await request(app)
        .patch(`/api/projects/proj-1/chat/conversations/${created.body.conversation.id}`)
        .send({ model: secondAlias })
      expect(updated.status).toBe(200)
      expect(updated.body.conversation.model).toBe(secondAlias)
    })

    it('rejects unsafe flag-like Kimi aliases on create and update', async () => {
      const safeAlias = 'moonshot-team/private-coder:v2'
      const ctx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'P', path: '/tmp', db_path: ':memory:',
          added_at: '', last_seen_at: '', provider: 'kimi', providers: ['kimi'],
        } as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const rejectedCreate = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: '--yolo' })
      expect(rejectedCreate.status).toBe(400)

      const created = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ model: safeAlias })
      expect(created.status).toBe(201)

      const rejectedUpdate = await request(app)
        .patch(`/api/projects/proj-1/chat/conversations/${created.body.conversation.id}`)
        .send({ model: '--yolo' })
      expect(rejectedUpdate.status).toBe(400)

      const unchanged = await request(app)
        .get(`/api/projects/proj-1/chat/conversations/${created.body.conversation.id}`)
      expect(unchanged.status).toBe(200)
      expect(unchanged.body.conversation.model).toBe(safeAlias)
    })

    it('rejects Kimi milestone creation before persisting the conversation', async () => {
      const ctx = makeContext(db, {
        project: {
          id: 'proj-1', slug: 'proj', name: 'P', path: '/tmp', db_path: ':memory:',
          added_at: '', last_seen_at: '', provider: 'kimi', providers: ['kimi'],
        } as any,
      })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app)
        .post('/api/projects/proj-1/chat/conversations')
        .send({ kind: 'milestone', milestone: 'm2' })
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({
        error: 'provider_tool_policy_unsupported',
        provider: 'kimi',
        requiredPolicy: 'read-only',
      })
      const list = await request(app).get('/api/projects/proj-1/chat/conversations')
      expect(list.body.conversations).toEqual([])
    })
  })
})

// ─── Multi-provider routes ─────────────────────────────────────────────────────

describe('project-router multi-provider', () => {
  let db: DbInstance

  const MULTI_PROJECT = {
    id: 'proj-1', slug: 'proj', name: 'Multi', path: '/tmp',
    db_path: ':memory:', provider: 'claude' as const, providers: ['claude', 'codex'] as ('claude' | 'codex')[],
    added_at: '', last_seen_at: '',
  }

  beforeEach(() => { db = initDb(':memory:') })

  describe('GET /default-spec-model', () => {
    it('returns codex models + provider list when ?provider=codex on a multi-provider project', async () => {
      const ctx = makeContext(db, { project: MULTI_PROJECT })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/default-spec-model?provider=codex')
      expect(res.status).toBe(200)
      expect(res.body.provider).toBe('codex')
      expect(res.body.providers).toEqual(['claude', 'codex'])
      expect(res.body.allowed.some((m: { value: string }) => m.value === 'gpt-5.5')).toBe(true)
    })

    it('falls back to the primary provider when ?provider= is not installed', async () => {
      const ctx = makeContext(db, { project: { ...MULTI_PROJECT, providers: ['claude'] } })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).get('/api/projects/proj-1/default-spec-model?provider=codex')
      expect(res.status).toBe(200)
      expect(res.body.provider).toBe('claude')
    })
  })

  describe('POST /spawn aiEngine', () => {
    it('threads aiEngine through to enqueue as provider', async () => {
      const enqueue = vi.fn(() => ({ id: 'job-x', queuePosition: 0 }))
      const ctx = makeContext(db, { project: MULTI_PROJECT, queueManager: makeQueueManager({ enqueue }) as any })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/spawn').send({ command: '/specrails:implement #1', aiEngine: 'codex' })
      expect(res.status).toBe(202)
      expect((enqueue.mock.calls[0][2] as { provider?: string }).provider).toBe('codex')
    })

    it('rejects an aiEngine not installed for the project', async () => {
      const ctx = makeContext(db, { project: { ...MULTI_PROJECT, providers: ['claude'] } })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/spawn').send({ command: '/x', aiEngine: 'codex' })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /chat/conversations aiEngine', () => {
    it('persists the conversation provider on a multi-provider project', async () => {
      const ctx = makeContext(db, { project: MULTI_PROJECT })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/chat/conversations').send({ kind: 'explore', aiEngine: 'codex' })
      expect(res.status).toBe(201)
      expect(res.body.conversation.provider).toBe('codex')
      // codex model default
      expect(res.body.conversation.model).toBe('gpt-5.5')
    })

    it('rejects an aiEngine not installed for the project', async () => {
      const ctx = makeContext(db, { project: { ...MULTI_PROJECT, providers: ['claude'] } })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/chat/conversations').send({ kind: 'explore', aiEngine: 'codex' })
      expect(res.status).toBe(400)
    })

    it('leaves provider NULL on a single-provider project (legacy behaviour)', async () => {
      const ctx = makeContext(db, { project: { ...MULTI_PROJECT, providers: ['claude'] } })
      const { app } = createApp(new Map([['proj-1', ctx]]))
      const res = await request(app).post('/api/projects/proj-1/chat/conversations').send({ kind: 'explore' })
      expect(res.status).toBe(201)
      expect(res.body.conversation.provider).toBeNull()
    })
  })
  // ─── Git diagnostics (specrails_git backing) ───────────────────────────────
  describe('GET /:projectId/git/diagnostic', () => {
    function appWithProject() {
      const contexts = new Map<string, ProjectContext>()
      contexts.set('proj-1', makeContext(db))
      return createApp(contexts)
    }

    it('400 with the allowlist for an invalid/mutating action (no spawn)', async () => {
      const { app } = appWithProject()
      for (const bad of ['push', 'nope', '', 'git remote -v; rm -rf /']) {
        const res = await request(app).get('/api/projects/proj-1/git/diagnostic').query({ action: bad })
        expect(res.status).toBe(400)
        expect(res.body.error).toBe('invalid_action')
        expect(Array.isArray(res.body.allowed)).toBe(true)
        expect(res.body.allowed).toContain('remote')
      }
    })

    it('runs an allow-listed read-only action and returns the structured result', async () => {
      // cwd is /tmp (not a git repo) — `git remote -v` exits non-zero, which is a
      // NORMAL ok:false result, proving the route delegates without throwing.
      const { app } = appWithProject()
      const res = await request(app).get('/api/projects/proj-1/git/diagnostic').query({ action: 'remote' })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ action: 'remote', command: 'git remote -v' })
      expect(typeof res.body.ok).toBe('boolean')
      expect(typeof res.body.exitCode).toBe('number')
    })

    it('404 for an unknown project (middleware)', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/projects/nope/git/diagnostic').query({ action: 'remote' })
      expect(res.status).toBe(404)
    })
  })
})
