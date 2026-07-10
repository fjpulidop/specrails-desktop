import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'path'
import fs from 'fs'
import dns from 'dns'

vi.mock('./core-compat', async (importActual) => {
  const actual = await importActual<typeof import('./core-compat')>()
  return {
    ...actual,
    checkCoreCompat: vi.fn().mockResolvedValue({ compatible: true, contractFound: false }),
    getCLIStatus: vi.fn().mockReturnValue({ provider: 'claude', version: '1.2.3' }),
    detectAvailableCLIs: vi.fn().mockReturnValue({ claude: true, codex: false, gemini: false }),
  }
})

const mockSpecrailsTechClient = {
  health: vi.fn(),
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  listDocs: vi.fn(),
  getDoc: vi.fn(),
}

vi.mock('./specrails-tech-client', () => ({
  createSpecrailsTechClient: vi.fn(() => mockSpecrailsTechClient),
}))

import { createDesktopRouter } from './desktop-router'
import { initDesktopDb, addProject, removeProject as removeProjectFromDesktopDb, getProject, getDesktopSetting, setDesktopSetting, addAgent, getAgent, addWebhook } from './desktop-db'
import { initDb } from './db'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { WsMessage } from './types'
import type { DbInstance } from './db'

function createMockRegistry(desktopDb: DbInstance) {
  const contexts = new Map<string, any>()

  const registry = {
    desktopDb,
    getContext: vi.fn((id: string) => contexts.get(id)),
    getContextByPath: vi.fn((projectPath: string) => {
      for (const ctx of contexts.values()) {
        if (ctx.project.path === projectPath) return ctx
      }
      return undefined
    }),
    getProjectRow: vi.fn((id: string) => getProject(desktopDb, id)),
    addProject: vi.fn((opts: { id: string; slug: string; name: string; path: string }) => {
      const row = addProject(desktopDb, opts)
      const ctx = {
        project: row,
        db: {} as any,
        queueManager: {} as any,
        chatManager: {} as any,
        setupManager: { isInstalling: vi.fn(() => false), isSettingUp: vi.fn(() => false) } as any,
        proposalManager: {} as any,
        broadcast: vi.fn(),
      }
      contexts.set(opts.id, ctx)
      return ctx
    }),
    removeProject: vi.fn((id: string) => {
      contexts.delete(id)
      removeProjectFromDesktopDb(desktopDb, id)
    }),
    touchProject: vi.fn(),
    listContexts: vi.fn(() => Array.from(contexts.values())),
    installedProvidersUnion: vi.fn(() => ['claude']),
  } as unknown as ProjectRegistry

  return { registry, contexts }
}

describe('desktop-router', () => {
  let desktopDb: DbInstance
  let existsSyncSpy: any
  let realpathSyncSpy: any
  let dnsLookupSpy: any

  beforeEach(() => {
    vi.restoreAllMocks()
    desktopDb = initDesktopDb(':memory:')
    // Spy on fs.existsSync so the router's `fs.existsSync(resolvedPath)` is intercepted
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    realpathSyncSpy = vi.spyOn(fs, 'realpathSync').mockImplementation((p: fs.PathLike) => String(p))
    // BUG-WEBHOOK-01: webhook create/update now DNS-resolves the host to block
    // rebinding SSRF. Default the lookup to a public IP so existing tests using
    // `example.com` stay hermetic (no real network); rebinding tests override.
    dnsLookupSpy = vi
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any)
  })

  function createApp() {
    const { registry, contexts } = createMockRegistry(desktopDb)
    const broadcast = vi.fn()
    const router = createDesktopRouter(registry, broadcast)
    const app = express()
    app.use(express.json())
    app.use('/api', router)
    return { app, registry, broadcast, contexts }
  }

  // ─── GET /projects ──────────────────────────────────────────────────────────

  describe('GET /api/projects', () => {
    it('returns empty projects list', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/projects')
      expect(res.status).toBe(200)
      expect(res.body.projects).toEqual([])
      expect(res.body.setupProjectIds).toEqual([])
    })

    it('returns registered projects', async () => {
      addProject(desktopDb, { id: 'p1', slug: 'proj-1', name: 'Project 1', path: '/path/1' })
      const { app } = createApp()
      const res = await request(app).get('/api/projects')
      expect(res.status).toBe(200)
      expect(res.body.projects).toHaveLength(1)
      expect(res.body.projects[0].slug).toBe('proj-1')
    })
  })

  // ─── POST /projects ────────────────────────────────────────────────────────

  describe('POST /api/projects', () => {
    it('returns 400 when path is missing', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('path is required')
    })

    it('returns 400 when path is not a string', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({ path: 123 })
      expect(res.status).toBe(400)
    })

    it('returns 400 when path does not exist on filesystem', async () => {
      existsSyncSpy.mockReturnValue(false)
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({ path: '/nonexistent' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('does not exist')
    })

    it('creates project with derived name from path', async () => {
      const { app, broadcast } = createApp()
      const res = await request(app).post('/api/projects').send({ path: '/home/user/my-project' })
      expect(res.status).toBe(201)
      expect(res.body.project).toBeDefined()
      expect(res.body.project.name).toBe('my-project')
      expect(broadcast).toHaveBeenCalled()
    })

    it('creates project with custom name', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({
        path: '/home/user/my-project',
        name: 'Custom Name',
      })
      expect(res.status).toBe(201)
      expect(res.body.project.name).toBe('Custom Name')
    })

    it('returns 409 when path is already registered', async () => {
      const { app } = createApp()
      await request(app).post('/api/projects').send({ path: '/home/user/my-project' })
      const res = await request(app).post('/api/projects').send({ path: '/home/user/my-project' })
      expect(res.status).toBe(409)
    })

    it('dedups the slug with a -N suffix for two same-basename repos (no false 409)', async () => {
      const { app } = createApp()
      const first = await request(app).post('/api/projects').send({ path: '/a/frontend' })
      const second = await request(app).post('/api/projects').send({ path: '/b/frontend' })
      // Both succeed — the second is a NEW path, not a duplicate.
      expect(first.status).toBe(201)
      expect(second.status).toBe(201)
      expect(first.body.project.slug).toBe('frontend')
      expect(second.body.project.slug).toBe('frontend-2')
    })

    it('includes has_specrails in response', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({ path: '/home/user/proj' })
      expect(res.status).toBe(201)
      expect(res.body.has_specrails).toBeDefined()
    })

    it('broadcasts desktop.project_added on success', async () => {
      const { app, broadcast } = createApp()
      await request(app).post('/api/projects').send({ path: '/home/user/proj' })

      const addMsgs = broadcast.mock.calls
        .map((c: any) => c[0])
        .filter((m: any) => m.type === 'desktop.project_added')
      expect(addMsgs).toHaveLength(1)
      expect(addMsgs[0].project).toBeDefined()
    })

    it('stores canonical project path when realpath differs', async () => {
      realpathSyncSpy.mockReturnValue('/private/tmp/test-wizard')
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({ path: '/tmp/test-wizard' })
      expect(res.status).toBe(201)
      expect(res.body.project.path).toBe('/private/tmp/test-wizard')
    })

    it('defaults to providers=["claude"] when no provider is sent', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({ path: '/home/user/single' })
      expect(res.status).toBe(201)
      expect(res.body.project.provider).toBe('claude')
      expect(res.body.project.providers).toEqual(['claude'])
    })

    it('accepts a providers array and sets the first as primary', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({ path: '/home/user/multi', providers: ['claude', 'codex'] })
      expect(res.status).toBe(201)
      expect(res.body.project.provider).toBe('claude')
      expect(res.body.project.providers).toEqual(['claude', 'codex'])
    })

    it('honours a legacy single provider field', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({ path: '/home/user/legacy', provider: 'codex' })
      expect(res.status).toBe(201)
      expect(res.body.project.provider).toBe('codex')
      expect(res.body.project.providers).toEqual(['codex'])
    })

    it('de-duplicates repeated providers', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({ path: '/home/user/dup', providers: ['claude', 'claude', 'codex'] })
      expect(res.status).toBe(201)
      expect(res.body.project.providers).toEqual(['claude', 'codex'])
    })

    it('rejects an unknown provider in the array', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({ path: '/home/user/bad', providers: ['claude', 'turbofake'] })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/provider must be one of/i)
    })
  })

  // ─── DELETE /projects/:id ──────────────────────────────────────────────────

  describe('DELETE /api/projects/:id', () => {
    it('returns 404 for non-existent project', async () => {
      const { app } = createApp()
      const res = await request(app).delete('/api/projects/nonexistent')
      expect(res.status).toBe(404)
    })

    it('removes project and broadcasts desktop.project_removed', async () => {
      const { app, broadcast } = createApp()
      const createRes = await request(app).post('/api/projects').send({ path: '/home/user/proj' })
      const id = createRes.body.project.id

      const res = await request(app).delete(`/api/projects/${id}`)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)

      const removeMsgs = broadcast.mock.calls
        .map((c: any) => c[0])
        .filter((m: any) => m.type === 'desktop.project_removed')
      expect(removeMsgs).toHaveLength(1)
      expect(removeMsgs[0].projectId).toBe(id)
    })

    it('removes a registered project even when its runtime context failed to load', async () => {
      const { app } = createApp()
      addProject(desktopDb, {
        id: 'failed-load', slug: 'failed-load', name: 'Failed', path: '/repo/failed',
      })

      const res = await request(app).delete('/api/projects/failed-load')

      expect(res.status).toBe(200)
      expect(getProject(desktopDb, 'failed-load')).toBeUndefined()
    })
  })

  // ─── GET /state ─────────────────────────────────────────────────────────────

  describe('GET /api/state', () => {
    it('returns state with project count', async () => {
      addProject(desktopDb, { id: 'p1', slug: 'proj-1', name: 'Project 1', path: '/path/1' })
      const { app } = createApp()
      const res = await request(app).get('/api/state')
      expect(res.status).toBe(200)
      expect(res.body.projectCount).toBe(1)
      expect(res.body.projects).toHaveLength(1)
    })
  })

  // ─── GET /resolve ──────────────────────────────────────────────────────────

  describe('GET /api/resolve', () => {
    it('returns 400 when path query is missing', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/resolve')
      expect(res.status).toBe(400)
    })

    it('returns 404 for unregistered path', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/resolve?path=/unknown')
      expect(res.status).toBe(404)
    })

    it('resolves registered project by path', async () => {
      realpathSyncSpy.mockImplementation((p: fs.PathLike) => {
        const s = String(p)
        return s === '/tmp/test-wizard' ? '/private/tmp/test-wizard' : s
      })
      const { app, registry } = createApp()
      // Create a project first
      await request(app).post('/api/projects').send({ path: '/tmp/test-wizard' })

      const res = await request(app).get('/api/resolve?path=/tmp/test-wizard')
      expect(res.status).toBe(200)
      expect(res.body.project).toBeDefined()
      expect(registry.touchProject).toHaveBeenCalled()
    })
  })

  // ─── GET /agents ────────────────────────────────────────────────────────────

  describe('GET /api/agents', () => {
    it('returns empty agents list', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/agents')
      expect(res.status).toBe(200)
      expect(res.body.agents).toEqual([])
    })

    it('returns registered agents', async () => {
      addAgent(desktopDb, { id: 'a1', slug: 'my-agent', name: 'My Agent' })
      const { app } = createApp()
      const res = await request(app).get('/api/agents')
      expect(res.status).toBe(200)
      expect(res.body.agents).toHaveLength(1)
      expect(res.body.agents[0].slug).toBe('my-agent')
    })
  })

  // ─── GET /agents/:id ────────────────────────────────────────────────────────

  describe('GET /api/agents/:id', () => {
    it('returns 404 for non-existent agent', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/agents/nonexistent')
      expect(res.status).toBe(404)
    })

    it('returns agent by ID', async () => {
      addAgent(desktopDb, { id: 'a1', slug: 'my-agent', name: 'My Agent' })
      const { app } = createApp()
      const res = await request(app).get('/api/agents/a1')
      expect(res.status).toBe(200)
      expect(res.body.agent.id).toBe('a1')
      expect(res.body.agent.status).toBe('idle')
    })
  })

  // ─── POST /agents ────────────────────────────────────────────────────────────

  describe('POST /api/agents', () => {
    it('returns 400 when slug is missing', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/agents').send({ name: 'Foo' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('slug is required')
    })

    it('returns 400 when name is missing', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/agents').send({ slug: 'foo' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('name is required')
    })

    it('creates agent with required fields', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/agents').send({ slug: 'my-agent', name: 'My Agent' })
      expect(res.status).toBe(201)
      expect(res.body.agent.slug).toBe('my-agent')
      expect(res.body.agent.name).toBe('My Agent')
      expect(res.body.agent.status).toBe('idle')
    })

    it('creates agent with optional role and config', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/agents').send({
        slug: 'dev-agent',
        name: 'Dev Agent',
        role: 'developer',
        config: '{"key":"val"}',
      })
      expect(res.status).toBe(201)
      expect(res.body.agent.role).toBe('developer')
    })

    it('returns 409 when slug is already registered', async () => {
      addAgent(desktopDb, { id: 'a1', slug: 'my-agent', name: 'My Agent' })
      const { app } = createApp()
      const res = await request(app).post('/api/agents').send({ slug: 'my-agent', name: 'Other' })
      expect(res.status).toBe(409)
    })
  })

  // ─── PATCH /agents/:id ──────────────────────────────────────────────────────

  describe('PATCH /api/agents/:id', () => {
    it('returns 404 for non-existent agent', async () => {
      const { app } = createApp()
      const res = await request(app).patch('/api/agents/missing').send({ status: 'busy' })
      expect(res.status).toBe(404)
    })

    it('updates agent status and current_job_id', async () => {
      addAgent(desktopDb, { id: 'a1', slug: 'my-agent', name: 'My Agent' })
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/agents/a1')
        .send({ status: 'busy', current_job_id: 'job-xyz' })
      expect(res.status).toBe(200)
      expect(res.body.agent.status).toBe('busy')
      expect(res.body.agent.current_job_id).toBe('job-xyz')
    })

    it('persists updates to the DB', async () => {
      addAgent(desktopDb, { id: 'a1', slug: 'my-agent', name: 'My Agent' })
      const { app } = createApp()
      await request(app).patch('/api/agents/a1').send({ name: 'Renamed' })
      const row = getAgent(desktopDb, 'a1')
      expect(row?.name).toBe('Renamed')
    })

    it('returns updated agent with no body changes', async () => {
      addAgent(desktopDb, { id: 'a1', slug: 'my-agent', name: 'My Agent' })
      const { app } = createApp()
      const res = await request(app).patch('/api/agents/a1').send({})
      expect(res.status).toBe(200)
      expect(res.body.agent.id).toBe('a1')
    })
  })

  // ─── GET /settings ─────────────────────────────────────────────────────────

  describe('GET /api/settings', () => {
    it('returns default port 4200', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/settings')
      expect(res.status).toBe(200)
      expect(res.body.port).toBe(4200)
    })

    it('returns persisted port setting', async () => {
      setDesktopSetting(desktopDb, 'port', '8080')
      const { app } = createApp()
      const res = await request(app).get('/api/settings')
      expect(res.status).toBe(200)
      expect(res.body.port).toBe(8080)
    })
  })

  // ─── PUT /settings ─────────────────────────────────────────────────────────

  describe('PUT /api/settings', () => {
    it('updates port setting', async () => {
      const { app } = createApp()
      const res = await request(app)
        .put('/api/settings')
        .send({ port: 9090 })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(getDesktopSetting(desktopDb, 'port')).toBe('9090')
    })

    it('returns ok even with empty body', async () => {
      const { app } = createApp()
      const res = await request(app).put('/api/settings').send({})
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('rejects a non-numeric port with 400 and does not persist garbage', async () => {
      const { app } = createApp()
      const res = await request(app).put('/api/settings').send({ port: 'abc' })
      expect(res.status).toBe(400)
      expect(getDesktopSetting(desktopDb, 'port')).toBeUndefined()
    })

    it('rejects an out-of-range port with 400', async () => {
      const { app } = createApp()
      const res = await request(app).put('/api/settings').send({ port: 70000 })
      expect(res.status).toBe(400)
    })
  })

  // ─── GET /recent-jobs ───────────────────────────────────────────────────────

  describe('GET /api/recent-jobs', () => {
    it('returns empty list when no projects have jobs', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/recent-jobs')
      expect(res.status).toBe(200)
      expect(res.body.jobs).toEqual([])
    })

    it('returns jobs from project contexts', async () => {
      const { app, contexts } = createApp()
      const today = new Date().toISOString().slice(0, 10)
      const db = initDb(':memory:')
      db.prepare(`
        INSERT INTO jobs (id, command, started_at, status, total_cost_usd)
        VALUES (?, 'implement', ?, 'completed', 0.01)
      `).run('job-1', `${today}T10:00:00.000Z`)

      contexts.set('p1', {
        project: { id: 'p1', name: 'TestProj', slug: 'testproj', path: '/tmp', db_path: ':memory:', added_at: '', last_seen_at: '' },
        db,
        queueManager: {} as any,
        chatManager: {} as any,
        setupManager: { isInstalling: vi.fn(() => false), isSettingUp: vi.fn(() => false) } as any,
        proposalManager: {} as any,
        broadcast: vi.fn(),
      })

      const res = await request(app).get('/api/recent-jobs')
      expect(res.status).toBe(200)
      expect(res.body.jobs).toHaveLength(1)
      expect(res.body.jobs[0].projectId).toBe('p1')
      expect(res.body.jobs[0].projectName).toBe('TestProj')
    })

    it('respects limit query param', async () => {
      const { app, contexts } = createApp()
      const today = new Date().toISOString().slice(0, 10)
      const db = initDb(':memory:')
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO jobs (id, command, started_at, status)
          VALUES (?, 'implement', ?, 'completed')
        `).run(`job-${i}`, `${today}T0${i}:00:00.000Z`)
      }
      contexts.set('p1', {
        project: { id: 'p1', name: 'P', slug: 'p', path: '/tmp', db_path: ':memory:', added_at: '', last_seen_at: '' },
        db,
        queueManager: {} as any, chatManager: {} as any, setupManager: {} as any, proposalManager: {} as any, broadcast: vi.fn(),
      })

      const res = await request(app).get('/api/recent-jobs?limit=3')
      expect(res.status).toBe(200)
      expect(res.body.jobs).toHaveLength(3)
    })
  })

  // ─── GET /api/cli-status ────────────────────────────────────────────────

  describe('GET /api/cli-status', () => {
    it('returns provider and version from getCLIStatus', async () => {
      const { app } = createApp()

      const res = await request(app).get('/api/cli-status')
      expect(res.status).toBe(200)
      expect(res.body.provider).toBe('claude')
      expect(res.body.version).toBe('1.2.3')
    })
  })

  // ─── GET /api/available-providers ───────────────────────────────────────

  describe('GET /api/available-providers', () => {
    it('returns available CLI providers (codex forced to false — coming soon)', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/available-providers')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('claude')
      expect(res.body).toHaveProperty('codex')
      expect(res.body.codex).toBe(false)
    })

    it('surfaces gemini by default (enabled — key reflects real detection)', async () => {
      const prev = process.env.SPECRAILS_GEMINI_BETA
      delete process.env.SPECRAILS_GEMINI_BETA
      try {
        const { app } = createApp()
        const res = await request(app).get('/api/available-providers')
        expect(res.status).toBe(200)
        expect(res.body).toHaveProperty('gemini')
        expect(typeof res.body.gemini).toBe('boolean')
      } finally {
        if (prev === undefined) delete process.env.SPECRAILS_GEMINI_BETA
        else process.env.SPECRAILS_GEMINI_BETA = prev
      }
    })

    it('forces gemini unavailable when SPECRAILS_GEMINI_BETA=0 (emergency rollback)', async () => {
      const prev = process.env.SPECRAILS_GEMINI_BETA
      process.env.SPECRAILS_GEMINI_BETA = '0'
      try {
        const { app } = createApp()
        const res = await request(app).get('/api/available-providers')
        expect(res.status).toBe(200)
        expect(res.body.gemini).toBe(false)
      } finally {
        if (prev === undefined) delete process.env.SPECRAILS_GEMINI_BETA
        else process.env.SPECRAILS_GEMINI_BETA = prev
      }
    })
  })

  // ─── POST /projects — provider validation ───────────────────────────────────

  describe('POST /api/projects — provider field', () => {
    it('accepts gemini by default (enabled)', async () => {
      const prev = process.env.SPECRAILS_GEMINI_BETA
      delete process.env.SPECRAILS_GEMINI_BETA
      const projectPath = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gemini-project-'))
      try {
        const { app } = createApp()
        const res = await request(app).post('/api/projects').send({
          path: projectPath,
          provider: 'gemini',
        })
        expect(res.status).toBe(201)
        expect(res.body.project.provider).toBe('gemini')
      } finally {
        fs.rmSync(projectPath, { recursive: true, force: true })
        if (prev === undefined) delete process.env.SPECRAILS_GEMINI_BETA
        else process.env.SPECRAILS_GEMINI_BETA = prev
      }
    })

    it('rejects gemini when SPECRAILS_GEMINI_BETA=0 (emergency rollback)', async () => {
      const prev = process.env.SPECRAILS_GEMINI_BETA
      process.env.SPECRAILS_GEMINI_BETA = '0'
      const projectPath = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gemini-blocked-'))
      try {
        const { app } = createApp()
        const res = await request(app).post('/api/projects').send({
          path: projectPath,
          provider: 'gemini',
        })
        expect(res.status).toBe(400)
        expect(res.body.error).toMatch(/SPECRAILS_GEMINI_BETA|disabled/)
      } finally {
        fs.rmSync(projectPath, { recursive: true, force: true })
        if (prev === undefined) delete process.env.SPECRAILS_GEMINI_BETA
        else process.env.SPECRAILS_GEMINI_BETA = prev
      }
    })

    it('accepts codex provider (Stage C of multi-provider; gate lifted)', async () => {
      const { app } = createApp()
      // Path must exist for the registry to accept registration. Use a real
      // dir under tmp so the registry validation passes.
      const projectPath = fs.mkdtempSync(path.join(require('os').tmpdir(), 'codex-project-'))
      try {
        const res = await request(app).post('/api/projects').send({
          path: projectPath,
          provider: 'codex',
        })
        expect(res.status).toBe(201)
        expect(res.body.project.provider).toBe('codex')
      } finally {
        fs.rmSync(projectPath, { recursive: true, force: true })
      }
    })

    it('rejects unknown provider id with a clear allow-list error', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({
        path: '/tmp/whatever',
        provider: 'turbofake',
      })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/provider must be one of:.*claude.*codex/)
    })

    it('SPECRAILS_CODEX_BETA=0 env var disables codex acceptance', async () => {
      const prev = process.env.SPECRAILS_CODEX_BETA
      process.env.SPECRAILS_CODEX_BETA = '0'
      const projectPath = fs.mkdtempSync(path.join(require('os').tmpdir(), 'codex-blocked-'))
      try {
        const { app } = createApp()
        const res = await request(app).post('/api/projects').send({
          path: projectPath,
          provider: 'codex',
        })
        expect(res.status).toBe(400)
        expect(res.body.error).toMatch(/disabled|SPECRAILS_CODEX_BETA/)
      } finally {
        fs.rmSync(projectPath, { recursive: true, force: true })
        if (prev === undefined) delete process.env.SPECRAILS_CODEX_BETA
        else process.env.SPECRAILS_CODEX_BETA = prev
      }
    })

    it('legacy SPECRAILS_HUB_CODEX_BETA=0 env var still disables codex (legacy fallback)', async () => {
      // Pre-rebrand installs may still set the old var name — it must keep
      // working when the new one is unset. Legacy name allowed here only.
      const prevNew = process.env.SPECRAILS_CODEX_BETA
      const prevLegacy = process.env.SPECRAILS_HUB_CODEX_BETA
      delete process.env.SPECRAILS_CODEX_BETA
      process.env.SPECRAILS_HUB_CODEX_BETA = '0'
      const projectPath = fs.mkdtempSync(path.join(require('os').tmpdir(), 'codex-legacy-blocked-'))
      try {
        const { app } = createApp()
        const res = await request(app).post('/api/projects').send({
          path: projectPath,
          provider: 'codex',
        })
        expect(res.status).toBe(400)
        expect(res.body.error).toMatch(/disabled|SPECRAILS_CODEX_BETA/)
      } finally {
        fs.rmSync(projectPath, { recursive: true, force: true })
        if (prevNew === undefined) delete process.env.SPECRAILS_CODEX_BETA
        else process.env.SPECRAILS_CODEX_BETA = prevNew
        if (prevLegacy === undefined) delete process.env.SPECRAILS_HUB_CODEX_BETA
        else process.env.SPECRAILS_HUB_CODEX_BETA = prevLegacy
      }
    })

    it('returns 400 when path is a system-critical directory', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/projects').send({ path: '/etc' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('system')
    })
  })

  // ─── GET /api/analytics ──────────────────────────────────────────────────

  describe('GET /api/analytics', () => {
    it('returns analytics data with default period', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/analytics')
      expect(res.status).toBe(200)
    })

    it('accepts period query param', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/analytics?period=30d')
      expect(res.status).toBe(200)
    })

    it('accepts from and to query params', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/analytics?period=custom&from=2026-01-01&to=2026-03-01')
      expect(res.status).toBe(200)
    })
  })

  // ─── GET /api/core-compat ───────────────────────────────────────────────

  describe('GET /api/core-compat', () => {
    it('returns compatibility result', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/core-compat')
      expect(res.status).toBe(200)
      expect(res.body.compatible).toBe(true)
    })
  })

  // ─── PUT /api/settings — additional fields ──────────────────────────────

  describe('PUT /api/settings — extended fields', () => {
    it('updates specrailsTechUrl', async () => {
      const { app } = createApp()
      const res = await request(app)
        .put('/api/settings')
        .send({ specrailsTechUrl: 'http://my-specrails.internal' })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(getDesktopSetting(desktopDb, 'specrails_tech_url')).toBe('http://my-specrails.internal')
    })

    it('ignores non-string specrailsTechUrl', async () => {
      const { app } = createApp()
      const res = await request(app)
        .put('/api/settings')
        .send({ specrailsTechUrl: 42 })
      expect(res.status).toBe(200)
      // Should not have been saved
      expect(getDesktopSetting(desktopDb, 'specrails_tech_url')).toBeUndefined()
    })

    it('sets costAlertThresholdUsd', async () => {
      const { app } = createApp()
      const res = await request(app)
        .put('/api/settings')
        .send({ costAlertThresholdUsd: 5.0 })
      expect(res.status).toBe(200)
      expect(getDesktopSetting(desktopDb, 'cost_alert_threshold_usd')).toBe('5')
    })

    it('clears costAlertThresholdUsd when null', async () => {
      setDesktopSetting(desktopDb, 'cost_alert_threshold_usd', '5')
      const { app } = createApp()
      const res = await request(app)
        .put('/api/settings')
        .send({ costAlertThresholdUsd: null })
      expect(res.status).toBe(200)
      expect(getDesktopSetting(desktopDb, 'cost_alert_threshold_usd')).toBeUndefined()
    })

    it('returns costAlertThresholdUsd from GET /settings', async () => {
      setDesktopSetting(desktopDb, 'cost_alert_threshold_usd', '10.5')
      const { app } = createApp()
      const res = await request(app).get('/api/settings')
      expect(res.status).toBe(200)
      expect(res.body.costAlertThresholdUsd).toBe(10.5)
    })

    it('returns null costAlertThresholdUsd when not set', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/settings')
      expect(res.status).toBe(200)
      expect(res.body.costAlertThresholdUsd).toBeNull()
    })
  })

  // ─── specrails-tech proxy routes ────────────────────────────────────────────

  describe('GET /api/specrails-tech/status', () => {
    it('returns connected:true when service is reachable', async () => {
      mockSpecrailsTechClient.health.mockResolvedValue({ connected: true, data: { status: 'ok' } })
      const { app } = createApp()
      const res = await request(app).get('/api/specrails-tech/status')
      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(true)
      expect(res.body.data.status).toBe('ok')
    })

    it('returns connected:false when service is unreachable', async () => {
      mockSpecrailsTechClient.health.mockResolvedValue({ connected: false, error: 'ECONNREFUSED' })
      const { app } = createApp()
      const res = await request(app).get('/api/specrails-tech/status')
      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(false)
      expect(res.body.error).toBeDefined()
    })
  })

  describe('GET /api/specrails-tech/agents', () => {
    it('returns agents list when connected', async () => {
      mockSpecrailsTechClient.listAgents.mockResolvedValue({ connected: true, data: [{ slug: 'cto' }] })
      const { app } = createApp()
      const res = await request(app).get('/api/specrails-tech/agents')
      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(true)
      expect(res.body.data).toHaveLength(1)
    })

    it('returns empty data when disconnected', async () => {
      mockSpecrailsTechClient.listAgents.mockResolvedValue({ connected: false, error: 'offline' })
      const { app } = createApp()
      const res = await request(app).get('/api/specrails-tech/agents')
      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(false)
      expect(res.body.data).toEqual([])
    })
  })

  describe('GET /api/specrails-tech/agents/:slug', () => {
    it('returns agent detail when connected', async () => {
      mockSpecrailsTechClient.getAgent.mockResolvedValue({ connected: true, data: { slug: 'cto', name: 'CTO' } })
      const { app } = createApp()
      const res = await request(app).get('/api/specrails-tech/agents/cto')
      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(true)
      expect(res.body.data.slug).toBe('cto')
    })

    it('returns 503 when disconnected', async () => {
      mockSpecrailsTechClient.getAgent.mockResolvedValue({ connected: false, error: 'offline' })
      const { app } = createApp()
      const res = await request(app).get('/api/specrails-tech/agents/cto')
      expect(res.status).toBe(503)
      expect(res.body.connected).toBe(false)
    })
  })

  describe('GET /api/specrails-tech/docs', () => {
    it('returns docs list when connected', async () => {
      mockSpecrailsTechClient.listDocs.mockResolvedValue({ connected: true, data: [{ page: 'intro' }] })
      const { app } = createApp()
      const res = await request(app).get('/api/specrails-tech/docs')
      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(true)
      expect(res.body.data).toHaveLength(1)
    })

    it('returns empty data when disconnected', async () => {
      mockSpecrailsTechClient.listDocs.mockResolvedValue({ connected: false, error: 'offline' })
      const { app } = createApp()
      const res = await request(app).get('/api/specrails-tech/docs')
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
    })
  })

  describe('GET /api/specrails-tech/docs/:page', () => {
    it('returns doc detail when connected', async () => {
      mockSpecrailsTechClient.getDoc.mockResolvedValue({ connected: true, data: { page: 'intro', content: '...' } })
      const { app } = createApp()
      const res = await request(app).get('/api/specrails-tech/docs/intro')
      expect(res.status).toBe(200)
      expect(res.body.connected).toBe(true)
      expect(res.body.data.page).toBe('intro')
    })

    it('returns 503 when disconnected', async () => {
      mockSpecrailsTechClient.getDoc.mockResolvedValue({ connected: false, error: 'offline' })
      const { app } = createApp()
      const res = await request(app).get('/api/specrails-tech/docs/intro')
      expect(res.status).toBe(503)
    })
  })

  // ─── PATCH /agents/:id — extended fields ────────────────────────────────────

  describe('PATCH /api/agents/:id — extended fields', () => {
    it('updates last_heartbeat_at and config', async () => {
      addAgent(desktopDb, { id: 'a2', slug: 'extended-agent', name: 'Extended' })
      const { app } = createApp()
      const heartbeat = new Date().toISOString()
      const res = await request(app)
        .patch('/api/agents/a2')
        .send({ last_heartbeat_at: heartbeat, config: '{"model":"claude"}' })
      expect(res.status).toBe(200)
      expect(res.body.agent.last_heartbeat_at).toBe(heartbeat)
    })
  })

  // ─── Webhook routes ──────────────────────────────────────────────────────────

  describe('GET /api/webhooks', () => {
    it('returns empty list when no webhooks exist', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/webhooks')
      expect(res.status).toBe(200)
      expect(res.body.webhooks).toEqual([])
    })

    it('returns list of webhooks', async () => {
      addWebhook(desktopDb, {
        id: 'wh-1',
        projectId: null,
        url: 'https://example.com/hook',
        events: ['job.completed'],
        secret: 'stored-secret',
      })
      const { app } = createApp()
      const res = await request(app).get('/api/webhooks')
      expect(res.status).toBe(200)
      expect(res.body.webhooks).toHaveLength(1)
      expect(res.body.webhooks[0].url).toBe('https://example.com/hook')
      expect(res.body.webhooks[0].secret).toBeUndefined()
      expect(res.body.webhooks[0].hasSecret).toBe(true)
    })
  })

  describe('POST /api/webhooks', () => {
    it('returns 400 when url is missing', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/webhooks').send({ events: ['job.completed'] })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('url is required')
    })

    it('returns 400 when url is not a string', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/webhooks').send({ url: 123 })
      expect(res.status).toBe(400)
    })

    it('returns 400 when all provided events are invalid', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://example.com/hook', events: ['invalid.event'] })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('valid event')
    })

    it('creates webhook with default events when events not provided', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://example.com/hook' })
      expect(res.status).toBe(201)
      expect(res.body.webhook.url).toBe('https://example.com/hook')
      const events = JSON.parse(res.body.webhook.events)
      expect(events).toContain('job.completed')
      expect(events).toContain('job.failed')
    })

    it('creates webhook with custom events', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://example.com/hook', events: ['job.completed', 'daily_budget_exceeded'] })
      expect(res.status).toBe(201)
      const events = JSON.parse(res.body.webhook.events)
      expect(events).toContain('job.completed')
      expect(events).toContain('daily_budget_exceeded')
    })

    it('creates webhook with secret', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://example.com/hook', secret: 'mysecret' })
      expect(res.status).toBe(201)
      expect(res.body.webhook.secret).toBeUndefined()
      expect(res.body.webhook.hasSecret).toBe(true)
    })

    it('rejects non-https webhook urls', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'http://example.com/hook' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('webhook url must be https')
    })

    it('rejects localhost webhook urls', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://localhost/hook' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('webhook url must be https')
    })

    it('returns 400 when projectId does not match a registered project', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://example.com/hook', projectId: 'nonexistent-project' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('project not found')
    })

    it('creates project-scoped webhook when projectId is valid', async () => {
      const { app } = createApp()
      const createRes = await request(app).post('/api/projects').send({ path: '/home/user/myproj' })
      const projectId = createRes.body.project.id

      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://example.com/hook', projectId })
      expect(res.status).toBe(201)
      expect(res.body.webhook.project_id).toBe(projectId)
    })

    // ─── BUG-WEBHOOK-01: SSRF hardening ──────────────────────────────────────

    it('rejects decimal-IPv4-encoded loopback (https://2130706433/)', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://2130706433/hook' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('webhook url must be https')
    })

    it('rejects octal-IPv4-encoded loopback (https://0177.0.0.1/)', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://0177.0.0.1/hook' })
      expect(res.status).toBe(400)
    })

    it('rejects hex-mapped IPv6 loopback (https://[::ffff:7f00:1]/)', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://[::ffff:7f00:1]/hook' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('webhook url must be https')
    })

    it('rejects dotted-decimal IPv4-mapped IPv6 loopback (https://[::ffff:127.0.0.1]/)', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://[::ffff:127.0.0.1]/hook' })
      expect(res.status).toBe(400)
    })

    it('rejects a public hostname that DNS-resolves to a private address (rebinding)', async () => {
      dnsLookupSpy.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 }, // link-local metadata endpoint
      ] as any)
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://rebind.attacker.example/hook' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('webhook url must be https')
      expect(dnsLookupSpy).toHaveBeenCalled()
    })

    it('rejects a public hostname that DNS-resolves to loopback (rebinding)', async () => {
      dnsLookupSpy.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any)
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://rebind2.attacker.example/hook' })
      expect(res.status).toBe(400)
    })

    it('allows a public hostname that DNS-resolves only to public addresses', async () => {
      dnsLookupSpy.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any)
      const { app } = createApp()
      const res = await request(app)
        .post('/api/webhooks')
        .send({ url: 'https://good.example.com/hook' })
      expect(res.status).toBe(201)
    })

    it('skips the DNS rebinding gate when SPECRAILS_ALLOW_LOCAL_WEBHOOKS=1', async () => {
      const prev = process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS
      process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS = '1'
      dnsLookupSpy.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any)
      try {
        const { app } = createApp()
        const res = await request(app)
          .post('/api/webhooks')
          .send({ url: 'https://localhost/hook' })
        expect(res.status).toBe(201)
        // The gate was skipped entirely — no DNS lookup performed.
        expect(dnsLookupSpy).not.toHaveBeenCalled()
      } finally {
        if (prev === undefined) delete process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS
        else process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS = prev
      }
    })
  })

  describe('PATCH /api/webhooks/:id', () => {
    it('returns 404 for non-existent webhook', async () => {
      const { app } = createApp()
      const res = await request(app).patch('/api/webhooks/nonexistent').send({ enabled: false })
      expect(res.status).toBe(404)
      expect(res.body.error).toContain('Webhook not found')
    })

    it('updates webhook url', async () => {
      addWebhook(desktopDb, { id: 'wh-1', projectId: null, url: 'https://old.example.com/hook', events: ['job.completed'] })
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/webhooks/wh-1')
        .send({ url: 'https://new.example.com/hook' })
      expect(res.status).toBe(200)
      expect(res.body.webhook.url).toBe('https://new.example.com/hook')
    })

    it('updates webhook enabled flag', async () => {
      addWebhook(desktopDb, { id: 'wh-1', projectId: null, url: 'https://example.com/hook', events: ['job.completed'] })
      const { app } = createApp()
      const res = await request(app).patch('/api/webhooks/wh-1').send({ enabled: false })
      expect(res.status).toBe(200)
      expect(res.body.webhook.enabled).toBe(0)
    })

    it('updates webhook events', async () => {
      addWebhook(desktopDb, { id: 'wh-1', projectId: null, url: 'https://example.com/hook', events: ['job.completed'] })
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/webhooks/wh-1')
        .send({ events: ['job.failed', 'daily_budget_exceeded'] })
      expect(res.status).toBe(200)
      const events = JSON.parse(res.body.webhook.events)
      expect(events).toContain('job.failed')
    })

    it('updates webhook secret', async () => {
      addWebhook(desktopDb, { id: 'wh-1', projectId: null, url: 'https://example.com/hook', events: ['job.completed'] })
      const { app } = createApp()
      const res = await request(app).patch('/api/webhooks/wh-1').send({ secret: 'new-secret' })
      expect(res.status).toBe(200)
      expect(res.body.webhook.secret).toBeUndefined()
      expect(res.body.webhook.hasSecret).toBe(true)
    })

    it('rejects updated webhook urls that target private IPs', async () => {
      addWebhook(desktopDb, { id: 'wh-1', projectId: null, url: 'https://example.com/hook', events: ['job.completed'] })
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/webhooks/wh-1')
        .send({ url: 'https://127.0.0.1/hook' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('webhook url must be https')
    })

    // BUG-WEBHOOK-01: the DNS-rebinding gate applies to updates too.
    it('rejects an updated url whose host DNS-resolves to a private address', async () => {
      addWebhook(desktopDb, { id: 'wh-1', projectId: null, url: 'https://example.com/hook', events: ['job.completed'] })
      dnsLookupSpy.mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as any)
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/webhooks/wh-1')
        .send({ url: 'https://rebind.attacker.example/hook' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('webhook url must be https')
    })

    it('rejects an updated url that is a decimal-encoded loopback', async () => {
      addWebhook(desktopDb, { id: 'wh-1', projectId: null, url: 'https://example.com/hook', events: ['job.completed'] })
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/webhooks/wh-1')
        .send({ url: 'https://2130706433/hook' })
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /api/webhooks/:id', () => {
    it('returns 404 for non-existent webhook', async () => {
      const { app } = createApp()
      const res = await request(app).delete('/api/webhooks/nonexistent')
      expect(res.status).toBe(404)
      expect(res.body.error).toContain('Webhook not found')
    })

    it('deletes existing webhook', async () => {
      addWebhook(desktopDb, { id: 'wh-1', projectId: null, url: 'https://example.com/hook', events: ['job.completed'] })
      const { app } = createApp()
      const deleteRes = await request(app).delete('/api/webhooks/wh-1')
      expect(deleteRes.status).toBe(200)
      expect(deleteRes.body.ok).toBe(true)

      const listRes = await request(app).get('/api/webhooks')
      expect(listRes.body.webhooks).toHaveLength(0)
    })
  })

  describe('POST /api/webhooks/:id/test', () => {
    it('returns 404 for non-existent webhook', async () => {
      const { app } = createApp()
      const res = await request(app).post('/api/webhooks/nonexistent/test')
      expect(res.status).toBe(404)
      expect(res.body.error).toContain('Webhook not found')
    })

    it('queues a test ping and returns ok', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', fetchMock)

      addWebhook(desktopDb, { id: 'wh-1', projectId: null, url: 'https://example.com/hook', events: ['job.completed'] })
      const { app } = createApp()
      const res = await request(app).post('/api/webhooks/wh-1/test')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.message).toContain('queued')

      vi.unstubAllGlobals()
    })
  })

  describe('GET /api/setup-prerequisites', () => {
    it('omits diagnostic field on default request', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/setup-prerequisites')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('prerequisites')
      expect(res.body).not.toHaveProperty('diagnostic')
    })

    it('includes diagnostic field when ?diagnostic=1', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/setup-prerequisites?diagnostic=1')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('diagnostic')
      expect(res.body.diagnostic).toHaveProperty('pathSegments')
      expect(res.body.diagnostic).toHaveProperty('pathSources')
      expect(res.body.diagnostic).toHaveProperty('loginShellStatus')
      expect(res.body.diagnostic).toHaveProperty('whichResults')
      expect(res.body.diagnostic).toHaveProperty('platform')
      expect(Array.isArray(res.body.diagnostic.pathSegments)).toBe(true)
    })
  })

  describe('GET /api/terminal-settings', () => {
    it('returns documented defaults seeded by migration', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/terminal-settings')
      expect(res.status).toBe(200)
      expect(res.body.fontSize).toBe(12)
      expect(res.body.renderMode).toBe('auto')
      expect(res.body.shellIntegrationEnabled).toBe(true)
      expect(res.body.imageRendering).toBe(true)
      expect(res.body.longCommandThresholdMs).toBe(60000)
    })
  })

  describe('PATCH /api/terminal-settings', () => {
    it('updates valid fields and returns the merged settings', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/terminal-settings')
        .send({ fontSize: 16, renderMode: 'canvas', copyOnSelect: true })
      expect(res.status).toBe(200)
      expect(res.body.fontSize).toBe(16)
      expect(res.body.renderMode).toBe('canvas')
      expect(res.body.copyOnSelect).toBe(true)
      // Untouched defaults preserved.
      expect(res.body.shellIntegrationEnabled).toBe(true)
    })

    it('rejects out-of-range fontSize with 400', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/terminal-settings')
        .send({ fontSize: 4 })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('validation_failed')
      expect(res.body.field).toBe('fontSize')
    })

    it('rejects unknown setting key with 400', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/terminal-settings')
        .send({ fontWeight: 700 })
      expect(res.status).toBe(400)
      expect(res.body.field).toBe('fontWeight')
    })

    it('rejects non-object body with 400', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/terminal-settings')
        .send([1, 2])
      expect(res.status).toBe(400)
    })
  })

  // ─── Theme ──────────────────────────────────────────────────────────────────

  describe('GET /api/theme', () => {
    it('returns specrails by default (seeded by migration)', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/theme')
      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('specrails')
    })

    it('returns the persisted theme', async () => {
      setDesktopSetting(desktopDb, 'ui_theme', 'aurora-light')
      const { app } = createApp()
      const res = await request(app).get('/api/theme')
      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('aurora-light')
    })

    it.each([
      ['star-wars', 'galaxy'],
      ['matrix', 'code-rain'],
    ])('migrates legacy persisted theme %s to %s with write-back', async (legacy, current) => {
      setDesktopSetting(desktopDb, 'ui_theme', legacy)
      const { app } = createApp()
      const res = await request(app).get('/api/theme')
      expect(res.status).toBe(200)
      expect(res.body.theme).toBe(current)
      expect(getDesktopSetting(desktopDb, 'ui_theme')).toBe(current)
    })

    it('falls back to specrails when persisted value is outside the allow-list', async () => {
      setDesktopSetting(desktopDb, 'ui_theme', 'totally-bogus-theme')
      const { app } = createApp()
      const res = await request(app).get('/api/theme')
      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('specrails')
    })
  })

  describe('PATCH /api/theme', () => {
    it('persists a valid theme', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/theme')
        .send({ theme: 'obsidian-dark' })
      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('obsidian-dark')
      expect(getDesktopSetting(desktopDb, 'ui_theme')).toBe('obsidian-dark')
    })

    it('persists the code-rain theme', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/theme')
        .send({ theme: 'code-rain' })
      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('code-rain')
      expect(getDesktopSetting(desktopDb, 'ui_theme')).toBe('code-rain')
    })

    it('persists the galaxy theme', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/theme')
        .send({ theme: 'galaxy' })
      expect(res.status).toBe(200)
      expect(res.body.theme).toBe('galaxy')
      expect(getDesktopSetting(desktopDb, 'ui_theme')).toBe('galaxy')
    })

    it('rejects a near-miss code-rain typo with 400', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/theme')
        .send({ theme: 'matricks' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_theme')
      expect(getDesktopSetting(desktopDb, 'ui_theme')).toBe('specrails')
    })

    it.each(['matrix', 'star-wars'])('rejects legacy theme id %s with 400', async (theme) => {
      setDesktopSetting(desktopDb, 'ui_theme', 'dracula')
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/theme')
        .send({ theme })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_theme')
      expect(getDesktopSetting(desktopDb, 'ui_theme')).toBe('dracula')
    })

    it('rejects unknown theme with 400', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/theme')
        .send({ theme: 'midnight-blue' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_theme')
      expect(getDesktopSetting(desktopDb, 'ui_theme')).toBe('specrails')
    })

    it('rejects non-string theme with 400', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/theme')
        .send({ theme: 123 })
      expect(res.status).toBe(400)
    })

    it('rejects missing theme field with 400', async () => {
      const { app } = createApp()
      const res = await request(app)
        .patch('/api/theme')
        .send({})
      expect(res.status).toBe(400)
    })

    it('round-trip GET reflects PATCH', async () => {
      const { app } = createApp()
      await request(app).patch('/api/theme').send({ theme: 'aurora-light' })
      const res = await request(app).get('/api/theme')
      expect(res.body.theme).toBe('aurora-light')
    })

    it.each(['dracula', 'aurora-light', 'obsidian-dark', 'code-rain', 'galaxy'])('accepts %s', async (theme) => {
      const { app } = createApp()
      const res = await request(app).patch('/api/theme').send({ theme })
      expect(res.status).toBe(200)
      expect(res.body.theme).toBe(theme)
    })
  })

  // ─── Language ──────────────────────────────────────────────────────────────

  describe('GET /api/language', () => {
    it('returns null when the user never chose a language (OS detection stays client-side)', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/language')
      expect(res.status).toBe(200)
      expect(res.body.language).toBeNull()
    })

    it('returns the persisted language', async () => {
      setDesktopSetting(desktopDb, 'ui_language', 'es')
      const { app } = createApp()
      const res = await request(app).get('/api/language')
      expect(res.status).toBe(200)
      expect(res.body.language).toBe('es')
    })

    it('returns null when persisted value is outside the allow-list', async () => {
      setDesktopSetting(desktopDb, 'ui_language', 'klingon')
      const { app } = createApp()
      const res = await request(app).get('/api/language')
      expect(res.status).toBe(200)
      expect(res.body.language).toBeNull()
    })
  })

  describe('PATCH /api/language', () => {
    it.each(['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja'])('persists %s', async (language) => {
      const { app } = createApp()
      const res = await request(app).patch('/api/language').send({ language })
      expect(res.status).toBe(200)
      expect(res.body.language).toBe(language)
      expect(getDesktopSetting(desktopDb, 'ui_language')).toBe(language)
    })

    it('rejects unknown language with 400', async () => {
      const { app } = createApp()
      const res = await request(app).patch('/api/language').send({ language: 'nl' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_language')
      expect(getDesktopSetting(desktopDb, 'ui_language')).toBeUndefined()
    })

    it('rejects region-qualified tags with 400 (client sends base subtags only)', async () => {
      const { app } = createApp()
      const res = await request(app).patch('/api/language').send({ language: 'es-ES' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_language')
    })

    it('rejects non-string language with 400', async () => {
      const { app } = createApp()
      const res = await request(app).patch('/api/language').send({ language: 42 })
      expect(res.status).toBe(400)
    })

    it('rejects missing language field with 400', async () => {
      const { app } = createApp()
      const res = await request(app).patch('/api/language').send({})
      expect(res.status).toBe(400)
    })

    it('round-trip GET reflects PATCH', async () => {
      const { app } = createApp()
      await request(app).patch('/api/language').send({ language: 'ja' })
      const res = await request(app).get('/api/language')
      expect(res.body.language).toBe('ja')
    })
  })

  // ─── core-update channel ────────────────────────────────────────────────────
  // No bundled core in the test env ⇒ available:false; these cover the route
  // wiring + the unavailable guard without touching npm/network.
  describe('GET /api/core-update/status', () => {
    it('returns available:false when no bundled core is present', async () => {
      const prev = process.env.SPECRAILS_BUNDLED_CORE_PATH
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      try {
        const { app } = createApp()
        const res = await request(app).get('/api/core-update/status')
        expect(res.status).toBe(200)
        expect(res.body.available).toBe(false)
        expect(res.body.updateAvailable).toBe(false)
      } finally {
        if (prev === undefined) delete process.env.SPECRAILS_BUNDLED_CORE_PATH
        else process.env.SPECRAILS_BUNDLED_CORE_PATH = prev
      }
    })
  })

  describe('POST /api/core-update/update', () => {
    it('409 when core updates are unavailable in this build', async () => {
      const prev = process.env.SPECRAILS_BUNDLED_CORE_PATH
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      try {
        const { app } = createApp()
        const res = await request(app).post('/api/core-update/update').send({})
        expect(res.status).toBe(409)
        expect(res.body.error).toBe('unavailable')
      } finally {
        if (prev === undefined) delete process.env.SPECRAILS_BUNDLED_CORE_PATH
        else process.env.SPECRAILS_BUNDLED_CORE_PATH = prev
      }
    })
  })

})
