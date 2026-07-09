import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Mock all managers before importing
vi.mock('./queue-manager', () => {
  const QueueManager = vi.fn().mockImplementation(() => ({
    enqueue: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getJobs: vi.fn().mockReturnValue([]),
    getActiveJobId: vi.fn().mockReturnValue(null),
    isPaused: vi.fn().mockReturnValue(false),
    setCommands: vi.fn(),
    shutdown: vi.fn(),
  }))
  return { QueueManager }
})

vi.mock('./chat-manager', () => {
  const ChatManager = vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    abort: vi.fn(),
    isActive: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
    forgetSpecDraft: vi.fn(),
    forgetExploreLifecycle: vi.fn(),
  }))
  return { ChatManager }
})

vi.mock('./setup-manager', () => {
  const SetupManager = vi.fn().mockImplementation(() => ({
    startInstall: vi.fn(),
    startSetup: vi.fn(),
    resumeSetup: vi.fn(),
    abort: vi.fn(),
    isInstalling: vi.fn().mockReturnValue(false),
    isSettingUp: vi.fn().mockReturnValue(false),
    getCheckpointStatus: vi.fn().mockReturnValue([]),
  }))
  return { SetupManager }
})

vi.mock('./proposal-manager', () => {
  const ProposalManager = vi.fn().mockImplementation(() => ({
    startExploration: vi.fn(),
    sendRefinement: vi.fn(),
    createIssue: vi.fn(),
    cancel: vi.fn(),
    isActive: vi.fn().mockReturnValue(false),
  }))
  return { ProposalManager }
})

vi.mock('./config', () => ({
  getConfig: vi.fn().mockReturnValue({
    commands: [{ id: 'implement', name: 'Implement', slug: 'implement' }],
  }),
}))

import { ProjectRegistry } from './project-registry'
import { setRailTickets, getRail } from './rails-store'
import { initDesktopDb, addProject, listProjects, getProject } from './desktop-db'
import { createLoopRun, getLoopRun, listActiveLoopRuns } from './loop-runs-store'
import type { DbInstance } from './db'
import type { WsMessage } from './types'

describe('ProjectRegistry', () => {
  let desktopDb: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let registry: ProjectRegistry
  let registryHome: string
  let prevRegistryHome: string | undefined

  beforeEach(() => {
    vi.resetAllMocks()
    // Redirect the shared artifact-registry writes (mirror/reconcile/remove that
    // ProjectRegistry now performs) to a tmp home so tests never touch the real
    // ~/.specrails/registry.json.
    registryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-registry-home-'))
    prevRegistryHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = registryHome
    broadcast = vi.fn()
    registry = new ProjectRegistry(broadcast, ':memory:')
    desktopDb = registry.desktopDb
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (prevRegistryHome !== undefined) process.env.SPECRAILS_REGISTRY_HOME = prevRegistryHome
    else delete process.env.SPECRAILS_REGISTRY_HOME
    fs.rmSync(registryHome, { recursive: true, force: true })
  })

  // ─── Constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('initializes the desktop DB and empty context map', () => {
      expect(registry.desktopDb).toBeDefined()
      expect(registry.listContexts()).toHaveLength(0)
    })
  })

  // ─── loadAll ────────────────────────────────────────────────────────────────

  describe('loadAll', () => {
    it('loads all projects from the desktop DB', () => {
      addProject(desktopDb, { id: 'p1', slug: 'proj-1', name: 'Project 1', path: '/path/1' })
      addProject(desktopDb, { id: 'p2', slug: 'proj-2', name: 'Project 2', path: '/path/2' })

      registry.loadAll()

      expect(registry.listContexts()).toHaveLength(2)
    })

    it('handles empty project list', () => {
      registry.loadAll()
      expect(registry.listContexts()).toHaveLength(0)
    })

    it('M9: a single failing project DB does not abort loading the rest', () => {
      addProject(desktopDb, { id: 'good', slug: 'good', name: 'Good', path: '/path/good' })
      addProject(desktopDb, { id: 'bad', slug: 'bad', name: 'Bad', path: '/path/bad' })
      // Corrupt the bad project's db_path so initDb throws (ENOTDIR: /dev/null is
      // not a directory, so mkdirSync of its parent fails).
      desktopDb.prepare('UPDATE projects SET db_path = ? WHERE id = ?').run('/dev/null/jobs.sqlite', 'bad')

      expect(() => registry.loadAll()).not.toThrow()
      expect(registry.getContext('good')).toBeDefined()
      expect(registry.getContext('bad')).toBeUndefined()
      expect(registry.listFailedProjects().map((f) => f.project.id)).toContain('bad')
    })
  })

  // ─── installedProvidersUnion ─────────────────────────────────────────────────

  describe('installedProvidersUnion', () => {
    it('defaults to [claude] with no projects', () => {
      expect(registry.installedProvidersUnion()).toEqual(['claude'])
    })

    it('returns the deduped union across projects (from the desktop DB)', () => {
      addProject(desktopDb, { id: 'p1', slug: 'p1', name: 'P1', path: '/path/u1', providers: ['claude'] })
      addProject(desktopDb, { id: 'p2', slug: 'p2', name: 'P2', path: '/path/u2', providers: ['gemini', 'claude'] })
      addProject(desktopDb, { id: 'p3', slug: 'p3', name: 'P3', path: '/path/u3', provider: 'codex' })
      const union = registry.installedProvidersUnion().sort()
      expect(union).toEqual(['claude', 'codex', 'gemini'])
    })

    it('includes projects that failed to load a per-project DB (reads desktop DB, not contexts)', () => {
      addProject(desktopDb, { id: 'good', slug: 'good', name: 'Good', path: '/path/g', providers: ['claude'] })
      addProject(desktopDb, { id: 'bad', slug: 'bad', name: 'Bad', path: '/path/b', providers: ['gemini'] })
      desktopDb.prepare('UPDATE projects SET db_path = ? WHERE id = ?').run('/dev/null/jobs.sqlite', 'bad')
      registry.loadAll()
      // 'bad' has no context but its provider still counts toward the union.
      expect(registry.installedProvidersUnion().sort()).toEqual(['claude', 'gemini'])
    })
  })

  // ─── addProject ────────────────────────────────────────────────────────────

  describe('addProject', () => {
    it('rolls back the desktop row when context hydration fails', () => {
      vi.spyOn(registry as unknown as { _loadProjectContext: () => never }, '_loadProjectContext')
        .mockImplementation(() => { throw new Error('corrupt jobs db') })

      expect(() => registry.addProject({
        id: 'broken', slug: 'broken', name: 'Broken', path: '/path/broken',
      })).toThrow('corrupt jobs db')

      expect(getProject(desktopDb, 'broken')).toBeUndefined()
      expect(listProjects(desktopDb)).toEqual([])
      expect(registry.listFailedProjects()).toEqual([])
    })

    it('adds a project and returns context', () => {
      const ctx = registry.addProject({
        id: 'p1',
        slug: 'my-proj',
        name: 'My Proj',
        path: '/path/to/proj',
      })

      expect(ctx.project.id).toBe('p1')
      expect(ctx.project.slug).toBe('my-proj')
      expect(ctx.db).toBeDefined()
      expect(ctx.queueManager).toBeDefined()
      expect(ctx.chatManager).toBeDefined()
      expect(ctx.setupManager).toBeDefined()
      expect(ctx.proposalManager).toBeDefined()
      expect(ctx.broadcast).toBeDefined()
    })

    it('context broadcast injects projectId', () => {
      const ctx = registry.addProject({
        id: 'p1',
        slug: 'my-proj',
        name: 'My Proj',
        path: '/path/to/proj',
      })

      ctx.broadcast({ type: 'queue_update', jobs: [], paused: false, activeJobId: null } as any)

      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1' })
      )
    })
  })

  // ─── removeProject ─────────────────────────────────────────────────────────

  describe('removeProject', () => {
    it('removes project from contexts and the desktop DB', () => {
      registry.addProject({
        id: 'p1',
        slug: 'my-proj',
        name: 'My Proj',
        path: '/path/to/proj',
      })

      expect(registry.getContext('p1')).toBeDefined()

      registry.removeProject('p1')

      expect(registry.getContext('p1')).toBeUndefined()
      expect(getProject(desktopDb, 'p1')).toBeUndefined()
    })

    it('handles removing non-existent project gracefully', () => {
      expect(() => registry.removeProject('nonexistent')).not.toThrow()
    })

    it('tears down spawners: queueManager.shutdown + chatManager.shutdown + setupManager.abort', () => {
      registry.addProject({ id: 'p1', slug: 'my-proj', name: 'My Proj', path: '/path/to/proj' })
      const ctx = registry.getContext('p1')!
      // afterEach(restoreAllMocks) strips the factory mockImplementation, so the
      // context managers are bare objects here — attach fresh spies to assert
      // removeProject invokes the teardown hooks (all are try/catch-wrapped in
      // the source, so a missing method would silently pass otherwise).
      const qmShutdown = vi.fn(); const cmShutdown = vi.fn(); const smAbort = vi.fn()
      ;(ctx.queueManager as unknown as { shutdown: unknown }).shutdown = qmShutdown
      ;(ctx.chatManager as unknown as { shutdown: unknown }).shutdown = cmShutdown
      ;(ctx.setupManager as unknown as { abort: unknown }).abort = smAbort
      registry.removeProject('p1')
      expect(qmShutdown).toHaveBeenCalled()
      expect(cmShutdown).toHaveBeenCalled()
      expect(smAbort).toHaveBeenCalledWith('p1')
    })

    it('M12: also disposes proposal/agentRefine/specLauncher before db.close()', () => {
      registry.addProject({ id: 'p1', slug: 'my-proj', name: 'My Proj', path: '/path/to/proj' })
      const ctx = registry.getContext('p1')!
      const pmShutdown = vi.fn(); const arShutdown = vi.fn(); const slShutdown = vi.fn()
      ;(ctx.proposalManager as unknown as { shutdown: unknown }).shutdown = pmShutdown
      ;(ctx.agentRefineManager as unknown as { shutdown: unknown }).shutdown = arShutdown
      ;(ctx.specLauncherManager as unknown as { shutdown: unknown }).shutdown = slShutdown
      registry.removeProject('p1')
      expect(pmShutdown).toHaveBeenCalled()
      expect(arShutdown).toHaveBeenCalled()
      expect(slShutdown).toHaveBeenCalled()
    })
  })

  // ─── shutdown (process-level) ────────────────────────────────────────────────

  describe('shutdown', () => {
    it('tears down queue + chat managers for every loaded project', () => {
      registry.addProject({ id: 'p1', slug: 's1', name: 'N1', path: '/p1' })
      registry.addProject({ id: 'p2', slug: 's2', name: 'N2', path: '/p2' })
      const c1 = registry.getContext('p1')!
      const c2 = registry.getContext('p2')!
      const spies = [c1.queueManager, c1.chatManager, c2.queueManager, c2.chatManager].map((m) => {
        const fn = vi.fn()
        ;(m as unknown as { shutdown: unknown }).shutdown = fn
        return fn
      })
      registry.shutdown()
      for (const s of spies) expect(s).toHaveBeenCalled()
    })

    it('is safe with no projects loaded', () => {
      expect(() => registry.shutdown()).not.toThrow()
    })
  })

  describe('desktop budget coordination', () => {
    it('pauses every project queue when the app-wide cap is exceeded', () => {
      registry.addProject({ id: 'p1', slug: 's1', name: 'N1', path: '/p1' })
      registry.addProject({ id: 'p2', slug: 's2', name: 'N2', path: '/p2' })
      const queues = registry.listContexts().map((context) => context.queueManager)
      for (const queue of queues) {
        ;(queue as unknown as { isPaused: unknown }).isPaused = vi.fn(() => false)
        ;(queue as unknown as { pause: unknown }).pause = vi.fn()
      }

      ;(registry as unknown as { _pauseAllQueuesForDesktopBudget: () => void })
        ._pauseAllQueuesForDesktopBudget()

      for (const queue of queues) expect(queue.pause).toHaveBeenCalledTimes(1)
    })
  })

  // ─── getContext / getContextByPath ──────────────────────────────────────────

  describe('getContext', () => {
    it('returns context for existing project', () => {
      registry.addProject({ id: 'p1', slug: 's1', name: 'N1', path: '/p1' })
      expect(registry.getContext('p1')).toBeDefined()
    })

    it('returns undefined for non-existent project', () => {
      expect(registry.getContext('nonexistent')).toBeUndefined()
    })
  })

  describe('getContextByPath', () => {
    it('returns context for matching path', () => {
      registry.addProject({ id: 'p1', slug: 's1', name: 'N1', path: '/path/1' })
      const ctx = registry.getContextByPath('/path/1')
      expect(ctx?.project.id).toBe('p1')
    })

    it('returns undefined for non-matching path', () => {
      expect(registry.getContextByPath('/not/found')).toBeUndefined()
    })
  })

  // ─── listContexts ──────────────────────────────────────────────────────────

  describe('listContexts', () => {
    it('returns all loaded contexts', () => {
      registry.addProject({ id: 'p1', slug: 's1', name: 'N1', path: '/p1' })
      registry.addProject({ id: 'p2', slug: 's2', name: 'N2', path: '/p2' })
      expect(registry.listContexts()).toHaveLength(2)
    })
  })

  // ─── touchProject ──────────────────────────────────────────────────────────

  describe('touchProject', () => {
    it('delegates to desktop-db touchProject', () => {
      registry.addProject({ id: 'p1', slug: 's1', name: 'N1', path: '/p1' })
      expect(() => registry.touchProject('p1')).not.toThrow()
    })
  })

  // ─── getProjectRow ─────────────────────────────────────────────────────────

  describe('getProjectRow', () => {
    it('returns project row from the desktop DB', () => {
      registry.addProject({ id: 'p1', slug: 's1', name: 'N1', path: '/p1' })
      const row = registry.getProjectRow('p1')
      expect(row?.id).toBe('p1')
    })

    it('returns undefined for non-existent', () => {
      expect(registry.getProjectRow('nope')).toBeUndefined()
    })
  })

  // ─── Double-load prevention ────────────────────────────────────────────────

  describe('double-load prevention', () => {
    it('does not create duplicate contexts for same project', () => {
      addProject(desktopDb, { id: 'p1', slug: 'proj-1', name: 'Project 1', path: '/path/1' })

      registry.loadAll()
      const ctx1 = registry.getContext('p1')

      registry.loadAll()
      const ctx2 = registry.getContext('p1')

      // Same instance
      expect(ctx1).toBe(ctx2)
      expect(registry.listContexts()).toHaveLength(1)
    })
  })

  // ─── Config loading failure ────────────────────────────────────────────────

  describe('config loading failure', () => {
    it('still creates context when config loading fails', async () => {
      const configMod = await import('./config')
      vi.mocked(configMod.getConfig).mockImplementation(() => {
        throw new Error('No .claude/commands found')
      })

      const ctx = registry.addProject({
        id: 'p1',
        slug: 's1',
        name: 'N1',
        path: '/no-commands',
      })

      expect(ctx).toBeDefined()
      expect(ctx.project.id).toBe('p1')
    })
  })

  // ─── QueueManager constructor callback tests ──────────────────────────────

  describe('QueueManager options callbacks', () => {
    it('getCostAlertThreshold reads desktop setting', async () => {
      const { QueueManager } = await import('./queue-manager')
      registry.addProject({ id: 'cb-1', slug: 'cb-proj', name: 'CB', path: '/cb' })

      // Capture the options passed to QueueManager constructor
      const constructorCalls = vi.mocked(QueueManager).mock.calls
      const lastCall = constructorCalls[constructorCalls.length - 1]
      const options = lastCall[4] as any
      expect(options).toBeDefined()

      // getCostAlertThreshold should read from desktop settings
      const threshold = options.getCostAlertThreshold()
      // No setting set, so should return null
      expect(threshold).toBeNull()
    })

    it('getDesktopDailyBudget returns budget and total spend', async () => {
      const { QueueManager } = await import('./queue-manager')
      registry.addProject({ id: 'hb-1', slug: 'hb-proj', name: 'HB', path: '/hb' })

      const constructorCalls = vi.mocked(QueueManager).mock.calls
      const lastCall = constructorCalls[constructorCalls.length - 1]
      const options = lastCall[4] as any

      const result = options.getDesktopDailyBudget()
      expect(result).toHaveProperty('budget')
      expect(result).toHaveProperty('totalSpend')
      expect(typeof result.totalSpend).toBe('number')
    })

    it('onJobFinished calls webhook deliver', async () => {
      const { QueueManager } = await import('./queue-manager')
      registry.addProject({ id: 'wh-1', slug: 'wh-proj', name: 'WH', path: '/wh' })

      const constructorCalls = vi.mocked(QueueManager).mock.calls
      const lastCall = constructorCalls[constructorCalls.length - 1]
      const options = lastCall[4] as any

      // The onJobFinished callback should not throw even if job row doesn't exist
      expect(() => options.onJobFinished('fake-job', 'completed', 0.05)).not.toThrow()
    })

    it('onJobFinished releases the finished job tickets from rails and broadcasts rail.updated', async () => {
      const { QueueManager } = await import('./queue-manager')
      const ctx = registry.addProject({ id: 'rr-1', slug: 'rr-proj', name: 'RR', path: '/rr' })

      // Rail 0 holds tickets 5 and 7; the finishing job implements only #5.
      setRailTickets(ctx.db, 0, [5, 7])
      ctx.db.prepare(
        `INSERT OR REPLACE INTO jobs (id, command, started_at, status) VALUES (?, ?, ?, 'completed')`
      ).run('rjob-1', '/specrails:implement #5 --yes', new Date().toISOString())

      const constructorCalls = vi.mocked(QueueManager).mock.calls
      const lastCall = constructorCalls[constructorCalls.length - 1]
      const options = lastCall[4] as any

      broadcast.mockClear()
      options.onJobFinished('rjob-1', 'completed', 0.01)

      // Server rails table released #5 but kept #7 (mobile reads this table).
      expect(getRail(ctx.db, 0).ticketIds).toEqual([7])
      const msg = broadcast.mock.calls.map((c) => c[0] as any).find((m) => m.type === 'rail.updated')
      expect(msg).toBeDefined()
      expect(msg.changed).toBe('tickets')
      expect(msg.railIndex).toBe(0)
      expect(msg.ticketIds).toEqual([7])
    })

    it('onJobFinished releases rail tickets on failure too (specs return to the board)', async () => {
      const { QueueManager } = await import('./queue-manager')
      const ctx = registry.addProject({ id: 'rr-2', slug: 'rr-proj-2', name: 'RR2', path: '/rr2' })

      setRailTickets(ctx.db, 1, [9])
      ctx.db.prepare(
        `INSERT OR REPLACE INTO jobs (id, command, started_at, status) VALUES (?, ?, ?, 'failed')`
      ).run('rjob-2', '/specrails:implement #9 --yes', new Date().toISOString())

      const constructorCalls = vi.mocked(QueueManager).mock.calls
      const lastCall = constructorCalls[constructorCalls.length - 1]
      const options = lastCall[4] as any

      options.onJobFinished('rjob-2', 'failed', null)

      expect(getRail(ctx.db, 1).ticketIds).toEqual([])
    })
  })

  // ─── SetupManager constructor callback tests ──────────────────────────────

  describe('SetupManager callbacks', () => {
    it('setProjectSetupSession and clearProjectSetupSession callbacks work', async () => {
      const { SetupManager } = await import('./setup-manager')
      registry.addProject({ id: 'sm-1', slug: 'sm-proj', name: 'SM', path: '/sm' })

      const constructorCalls = vi.mocked(SetupManager).mock.calls
      const lastCall = constructorCalls[constructorCalls.length - 1]
      const setSessionFn = lastCall[1] as (pid: string, sid: string) => void
      const clearSessionFn = lastCall[2] as (pid: string) => void

      expect(() => setSessionFn('sm-1', 'session-123')).not.toThrow()
      expect(() => clearSessionFn('sm-1')).not.toThrow()
    })
  })

  // ─── Bound broadcast with queue terminal status ──────────────────────────

  describe('bound broadcast clears agent jobs for terminal statuses', () => {
    it('broadcasts queue message and calls clearAgentJob for terminal jobs', () => {
      const ctx = registry.addProject({ id: 'aq-1', slug: 'aq-proj', name: 'AQ', path: '/aq' })

      // Simulate a queue broadcast with terminal job statuses
      ctx.broadcast({
        type: 'queue',
        jobs: [
          { id: 'j1', status: 'completed', command: 'cmd', priority: 'normal' },
          { id: 'j2', status: 'running', command: 'cmd', priority: 'normal' },
          { id: 'j3', status: 'failed', command: 'cmd', priority: 'normal' },
        ],
        paused: false,
        activeJobId: null,
      } as any)

      // The broadcast should have been called with enriched projectId
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'aq-1', type: 'queue' })
      )
    })
  })

  // ─── artifact-registry mirror wiring ─────────────────────────────────────────

  describe('artifact-registry mirror wiring', () => {
    function readRegistry(): {
      schemaVersion: number
      generator?: string
      projects: Record<string, { slug: string; source: string; desktopProjectId?: string; providers: string[] }>
    } {
      const p = path.join(registryHome, '.specrails', 'registry.json')
      return JSON.parse(fs.readFileSync(p, 'utf8'))
    }

    it('addProject mirrors a desktop-owned entry keyed by the repo path', () => {
      registry.addProject({ id: 'p1', slug: 'my-proj', name: 'My Proj', path: '/repo/my-proj', provider: 'claude' })
      const reg = readRegistry()
      const key = process.platform === 'darwin' || process.platform === 'win32'
        ? path.resolve('/repo/my-proj').toLowerCase()
        : path.resolve('/repo/my-proj')
      const entry = reg.projects[key]
      expect(entry).toBeDefined()
      expect(entry.slug).toBe('my-proj')
      expect(entry.source).toBe('desktop')
      expect(entry.desktopProjectId).toBe('p1')
      expect(entry.providers).toEqual(['claude'])
      expect(reg.generator).toBe('specrails-desktop')
    })

    it('addProject failure to mirror does not break project creation', () => {
      // Point the registry home at a path that cannot be created (a file, not a
      // dir) so the mirror write throws; addProject must still succeed.
      const filePath = path.join(registryHome, 'not-a-dir')
      fs.writeFileSync(filePath, 'x')
      process.env.SPECRAILS_REGISTRY_HOME = filePath
      try {
        const ctx = registry.addProject({ id: 'p1', slug: 'my-proj', name: 'My Proj', path: '/repo/x' })
        expect(ctx.project.id).toBe('p1')
        expect(registry.getContext('p1')).toBeDefined()
      } finally {
        process.env.SPECRAILS_REGISTRY_HOME = registryHome
      }
    })

    it('removeProject deletes the registry entry', () => {
      registry.addProject({ id: 'p1', slug: 'my-proj', name: 'My Proj', path: '/repo/my-proj' })
      const key = process.platform === 'darwin' || process.platform === 'win32'
        ? path.resolve('/repo/my-proj').toLowerCase()
        : path.resolve('/repo/my-proj')
      expect(readRegistry().projects[key]).toBeDefined()
      registry.removeProject('p1')
      expect(readRegistry().projects[key]).toBeUndefined()
    })

    it('removeProject deletes the relocated workspace for an adopted (slug-mismatched) project', async () => {
      // Adopted project: the registry entry's slug differs from the desktop slug.
      // Pre-plant a core-standalone entry under a DIFFERENT slug, then add the
      // desktop project at the same repo path so addProject ADOPTS it (keeps the
      // core slug + workspaceDir). The workspace must be removed under the
      // REGISTRY slug, not the desktop slug.
      const repo = '/repo/adopted-proj'
      const key = process.platform === 'darwin' || process.platform === 'win32'
        ? path.resolve(repo).toLowerCase()
        : path.resolve(repo)
      const coreSlug = 'core-allocated-slug'
      const wsDir = path.join(registryHome, '.specrails', 'projects', coreSlug, 'workspace')
      const specrailsDir = path.join(wsDir, '.specrails')
      // Plant a complete core-standalone entry on disk.
      const regPath = path.join(registryHome, '.specrails', 'registry.json')
      fs.mkdirSync(path.dirname(regPath), { recursive: true })
      fs.writeFileSync(regPath, JSON.stringify({
        schemaVersion: 1,
        projects: {
          [key]: {
            repoPath: path.resolve(repo), slug: coreSlug, workspaceDir: wsDir,
            artifactRoot: wsDir, codeRoot: path.resolve(repo),
            stateDir: path.join(wsDir, '.claude'),
            ticketsPath: path.join(specrailsDir, 'local-tickets.json'),
            backlogConfigPath: path.join(specrailsDir, 'backlog-config.json'),
            profilesDir: path.join(specrailsDir, 'profiles'),
            pluginsStateDir: path.join(specrailsDir, 'plugins'),
            fileSummariesDir: path.join(specrailsDir, 'file-summaries'),
            providers: ['claude'], primaryProvider: 'claude', source: 'core-standalone',
          },
        },
      }))
      // Materialize the workspace dir on disk (the orphan that must be removed).
      fs.mkdirSync(specrailsDir, { recursive: true })
      fs.writeFileSync(path.join(specrailsDir, 'local-tickets.json'), '{}')

      // Add the desktop project at the same repo with a DIFFERENT desktop slug.
      registry.addProject({ id: 'pAdopt', slug: 'desktop-different-slug', name: 'Adopted', path: repo })
      // Sanity: the entry kept the core slug (adoption preserved workspace identity).
      expect(readRegistry().projects[key].slug).toBe(coreSlug)
      expect(fs.existsSync(wsDir)).toBe(true)

      registry.removeProject('pAdopt')

      // The workspace under the REGISTRY slug is gone (no orphan leak) and the
      // registry entry is dropped.
      expect(fs.existsSync(wsDir)).toBe(false)
      expect(readRegistry().projects[key]).toBeUndefined()
    })

    it('loadAll reconciles all desktop projects into the registry', () => {
      addProject(desktopDb, { id: 'p1', slug: 'proj-1', name: 'Project 1', path: '/repo/proj-1' })
      addProject(desktopDb, { id: 'p2', slug: 'proj-2', name: 'Project 2', path: '/repo/proj-2' })
      registry.loadAll()
      const reg = readRegistry()
      const slugs = Object.values(reg.projects).map((e) => e.slug).sort()
      expect(slugs).toEqual(['proj-1', 'proj-2'])
      for (const e of Object.values(reg.projects)) expect(e.source).toBe('desktop')
    })

    it('loadAll leaves a core-standalone entry for an untracked repo untouched', () => {
      // Pre-plant a core-standalone entry for a repo desktop does NOT track.
      const otherKey = process.platform === 'darwin' || process.platform === 'win32'
        ? path.resolve('/repo/untracked').toLowerCase()
        : path.resolve('/repo/untracked')
      const regPath = path.join(registryHome, '.specrails', 'registry.json')
      fs.mkdirSync(path.dirname(regPath), { recursive: true })
      fs.writeFileSync(regPath, JSON.stringify({
        schemaVersion: 1,
        projects: { [otherKey]: { slug: 'untracked', source: 'core-standalone', providers: ['claude'], workspaceDir: '/ws' } },
      }))
      addProject(desktopDb, { id: 'p1', slug: 'proj-1', name: 'Project 1', path: '/repo/proj-1' })
      registry.loadAll()
      const reg = readRegistry()
      expect(reg.projects[otherKey]).toBeDefined()
      expect(reg.projects[otherKey].source).toBe('core-standalone')
    })
  })

  // ─── onLoopRunFinished — ticket completion status (ask-first PR delivery) ────

  describe('onLoopRunFinished ticket completion status', () => {
    let projDir: string
    const ticketFile = () => path.join(projDir, '.specrails', 'local-tickets.json')

    const seedTicket = (status: string) => {
      fs.mkdirSync(path.dirname(ticketFile()), { recursive: true })
      const now = new Date().toISOString()
      fs.writeFileSync(ticketFile(), JSON.stringify({
        schema_version: '1.3', revision: 1, last_updated: now, next_id: 2,
        tickets: {
          '1': {
            id: 1, title: 'T', description: '', status, priority: null, labels: [],
            assignee: null, prerequisites: [], metadata: {}, origin_conversation_id: null,
            is_epic: false, parent_epic_id: null, execution_order: null, short_summary: null,
            created_at: now, updated_at: now, created_by: 'test', source: 'manual',
          },
        },
      }))
    }

    const readStatus = () =>
      (JSON.parse(fs.readFileSync(ticketFile(), 'utf-8')) as { tickets: Record<string, { status: string }> }).tickets['1'].status

    // Register the project + spy on the two Jira write-back hooks.
    const setup = () => {
      const ctx = registry.addProject({ id: 'pLoop', slug: 'loop-proj', name: 'Loop', path: projDir })
      const onJobOutcome = vi.fn()
      const onRailReview = vi.fn()
      ;(ctx.jiraSyncManager as unknown as Record<string, unknown>).onJobOutcome = onJobOutcome
      ;(ctx.jiraSyncManager as unknown as Record<string, unknown>).onRailReview = onRailReview
      ctx.railLoopRuns.set('run-1', { railIndex: 0, ticketIds: [1] })
      return { ctx, onJobOutcome, onRailReview }
    }

    const savedPrFlag = process.env.SPECRAILS_RAIL_DELIVER_PR
    beforeEach(() => {
      projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-loop-tickets-'))
      delete process.env.SPECRAILS_RAIL_DELIVER_PR // PR delivery default-on
    })
    afterEach(() => {
      try { registry.removeProject('pLoop') } catch { /* already gone */ }
      fs.rmSync(projDir, { recursive: true, force: true })
      if (savedPrFlag === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
      else process.env.SPECRAILS_RAIL_DELIVER_PR = savedPrFlag
    })

    it("parks a completed run's tickets at on_review and calls the Jira on-review hook instead of onJobOutcome", () => {
      seedTicket('in_progress')
      const { ctx, onJobOutcome, onRailReview } = setup()

      ctx.onLoopRunFinished('run-1', 'success', { ticketCompletionStatus: 'on_review' })

      expect(readStatus()).toBe('on_review')
      expect(onRailReview).toHaveBeenCalledWith([1], 'run-1')
      expect(onJobOutcome).not.toHaveBeenCalled()
      expect(broadcast.mock.calls.some(([m]) => {
        const msg = m as { type?: string; projectId?: string }
        return msg.type === 'ticket_updated' && msg.projectId === 'pLoop'
      })).toBe(true)
    })

    it('without opts the DEFAULT derives from the PR-delivery flag (default-on ⇒ on_review + on-review Jira hook) — universal ask-first', () => {
      // Shared-cwd rail runs / standalone loop runs / isolation-unavailable
      // fallbacks call onLoopRunFinished with NO opts — under the default-on
      // methodology switch they must park at on_review too, never done.
      seedTicket('in_progress')
      const { ctx, onJobOutcome, onRailReview } = setup()

      ctx.onLoopRunFinished('run-1', 'success')

      expect(readStatus()).toBe('on_review')
      expect(onRailReview).toHaveBeenCalledWith([1], 'run-1')
      expect(onJobOutcome).not.toHaveBeenCalled()
    })

    it('kill-switch off (SPECRAILS_RAIL_DELIVER_PR=0): no opts defaults to done with the done-flavoured Jira enqueue (legacy byte-identical)', () => {
      process.env.SPECRAILS_RAIL_DELIVER_PR = '0'
      seedTicket('in_progress')
      const { ctx, onJobOutcome, onRailReview } = setup()

      ctx.onLoopRunFinished('run-1', 'success')

      expect(readStatus()).toBe('done')
      expect(onJobOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ ticketIds: [1], status: 'completed', jobId: 'run-1' }),
      )
      expect(onRailReview).not.toHaveBeenCalled()
    })

    it("an explicit 'done' wins over the flag-derived default (legacy promotion)", () => {
      seedTicket('todo')
      const { ctx, onJobOutcome, onRailReview } = setup()

      ctx.onLoopRunFinished('run-1', 'success', { ticketCompletionStatus: 'done' })

      expect(readStatus()).toBe('done')
      expect(onJobOutcome).toHaveBeenCalled()
      expect(onRailReview).not.toHaveBeenCalled()
    })

    it('failure outcome ignores ticketCompletionStatus (in_progress → todo, done-flavoured enqueue)', () => {
      seedTicket('in_progress')
      const { ctx, onJobOutcome, onRailReview } = setup()

      ctx.onLoopRunFinished('run-1', 'failed', { ticketCompletionStatus: 'on_review' })

      expect(readStatus()).toBe('todo')
      expect(onJobOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
      expect(onRailReview).not.toHaveBeenCalled()
    })

    it('crash recovery replays loop failure through tickets, rail and Jira invariants', () => {
      seedTicket('in_progress')
      const { ctx, onJobOutcome } = setup()
      setRailTickets(ctx.db, 0, [1])
      createLoopRun(ctx.db, {
        id: 'crash-run', projectId: ctx.project.id, loopId: 'loop-1',
        railIndex: 0, ticketId: 1, iterationLimit: 3, startedAt: new Date().toISOString(),
      })
      const orphans = listActiveLoopRuns(ctx.db, ctx.project.id)

      ;(registry as unknown as {
        _recoverOrphanLoopRuns: (
          project: typeof ctx.project,
          db: typeof ctx.db,
          runs: typeof ctx.railLoopRuns,
          onFinished: typeof ctx.onLoopRunFinished,
          orphans: typeof orphans,
        ) => void
      })._recoverOrphanLoopRuns(ctx.project, ctx.db, ctx.railLoopRuns, ctx.onLoopRunFinished, orphans)

      expect(readStatus()).toBe('todo')
      expect(getRail(ctx.db, 0).ticketIds).toEqual([])
      expect(getLoopRun(ctx.db, 'crash-run')).toMatchObject({ status: 'completed', final_outcome: 'failed' })
      expect(onJobOutcome).toHaveBeenCalledWith(expect.objectContaining({
        ticketIds: [1], status: 'failed', jobId: 'crash-run',
      }))
    })
  })

  // ─── onJobFinished — ticket completion status (universal ask-first) ─────────

  describe('onJobFinished ticket completion status (QueueManager jobs)', () => {
    let projDir: string
    const ticketFile = () => path.join(projDir, '.specrails', 'local-tickets.json')

    const seedTicket = (status: string) => {
      fs.mkdirSync(path.dirname(ticketFile()), { recursive: true })
      const now = new Date().toISOString()
      fs.writeFileSync(ticketFile(), JSON.stringify({
        schema_version: '1.3', revision: 1, last_updated: now, next_id: 2,
        tickets: {
          '1': {
            id: 1, title: 'T', description: '', status, priority: null, labels: [],
            assignee: null, prerequisites: [], metadata: {}, origin_conversation_id: null,
            is_epic: false, parent_epic_id: null, execution_order: null, short_summary: null,
            created_at: now, updated_at: now, created_by: 'test', source: 'manual',
          },
        },
      }))
    }

    const readStatus = () =>
      (JSON.parse(fs.readFileSync(ticketFile(), 'utf-8')) as { tickets: Record<string, { status: string }> }).tickets['1'].status

    // Register the project (real ticket store on disk), spy on the Jira hooks,
    // and grab the onJobFinished closure handed to the (mocked) QueueManager.
    const setup = async () => {
      const { QueueManager } = await import('./queue-manager')
      const ctx = registry.addProject({ id: 'pJob', slug: 'job-proj', name: 'Job', path: projDir })
      const onJobOutcome = vi.fn()
      const onRailReview = vi.fn()
      ;(ctx.jiraSyncManager as unknown as Record<string, unknown>).onJobOutcome = onJobOutcome
      ;(ctx.jiraSyncManager as unknown as Record<string, unknown>).onRailReview = onRailReview
      // A jobs row so the closure can resolve command → ticket ids (#1).
      ctx.db.prepare(
        `INSERT OR REPLACE INTO jobs (id, command, started_at, status) VALUES (?, ?, ?, 'completed')`
      ).run('job-1', '/specrails:implement #1 --yes', new Date().toISOString())
      const constructorCalls = vi.mocked(QueueManager).mock.calls
      const options = constructorCalls[constructorCalls.length - 1][4] as {
        onJobFinished: (
          jobId: string,
          status: string,
          costUsd?: number | null,
          opts?: { ticketCompletionStatus?: 'done' | 'on_review' },
        ) => void
      }
      return { ctx, onJobOutcome, onRailReview, onJobFinished: options.onJobFinished }
    }

    beforeEach(() => { projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-job-tickets-')) })
    afterEach(() => {
      try { registry.removeProject('pJob') } catch { /* already gone */ }
      fs.rmSync(projDir, { recursive: true, force: true })
    })

    it("ticketCompletionStatus 'on_review' (the spawn-captured PR mode) parks a completed job's tickets at on_review and calls the Jira on-review hook", async () => {
      seedTicket('in_progress')
      const { onJobOutcome, onRailReview, onJobFinished } = await setup()

      onJobFinished('job-1', 'completed', 0.02, { ticketCompletionStatus: 'on_review' })

      expect(readStatus()).toBe('on_review')
      expect(onRailReview).toHaveBeenCalledWith([1], 'job-1')
      expect(onJobOutcome).not.toHaveBeenCalled()
      expect(broadcast.mock.calls.some(([m]) => {
        const msg = m as { type?: string; projectId?: string }
        return msg.type === 'ticket_updated' && msg.projectId === 'pJob'
      })).toBe(true)
    })

    it("no opts (legacy caller / kill-switch-off spawn) promotes to done with the done-flavoured onJobOutcome — byte-identical", async () => {
      seedTicket('in_progress')
      const { onJobOutcome, onRailReview, onJobFinished } = await setup()

      onJobFinished('job-1', 'completed', 0.02)

      expect(readStatus()).toBe('done')
      expect(onJobOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ ticketIds: [1], status: 'completed', jobId: 'job-1' }),
      )
      expect(onRailReview).not.toHaveBeenCalled()
    })

    it("an explicit 'done' behaves exactly like the legacy promotion", async () => {
      seedTicket('todo')
      const { onJobOutcome, onRailReview, onJobFinished } = await setup()

      onJobFinished('job-1', 'completed', null, { ticketCompletionStatus: 'done' })

      expect(readStatus()).toBe('done')
      expect(onJobOutcome).toHaveBeenCalled()
      expect(onRailReview).not.toHaveBeenCalled()
    })

    it('failure keeps the legacy revert + done-flavoured enqueue even when opts ride along (defensive)', async () => {
      seedTicket('in_progress')
      const { onJobOutcome, onRailReview, onJobFinished } = await setup()

      onJobFinished('job-1', 'failed', null, { ticketCompletionStatus: 'on_review' })

      expect(readStatus()).toBe('todo')
      expect(onJobOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
      expect(onRailReview).not.toHaveBeenCalled()
    })
  })
})
