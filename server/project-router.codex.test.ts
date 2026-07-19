/**
 * Focused tests for codex provider model propagation in project-router routes.
 * These tests verify that spec-gen and ticket AI edit never hardcode 'o4-mini'
 * but always use 'gpt-5.5' (codex default).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import express from 'express'
import request from 'supertest'

// Mock child_process before importing project-router
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-req-uuid'),
}))

import { spawn as mockSpawn } from 'child_process'
import { createProjectRouter } from './project-router'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { DbInstance } from './db'

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 99999
  child.kill = vi.fn()
  return child
}

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

describe('codex model propagation in project-router', () => {
  let db: DbInstance

  beforeEach(() => {
    vi.resetAllMocks()
    db = initDb(':memory:')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('POST /tickets/generate-spec with provider=codex', () => {
    it('uses gpt-5.5, not o4-mini', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const ctx = makeMinimalContext(db, 'codex')
      const { app } = createApp(ctx)

      // Fire request and close child immediately so the route handler finishes
      const requestPromise = request(app)
        .post('/api/projects/proj-codex/tickets/generate-spec')
        .send({ idea: 'Add dark mode toggle' })

      // Wait for the route handler to have called spawn (synchronous after receiving request)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      child.stdout.push(null)
      child.emit('close', 0)
      await requestPromise.catch(() => { /* ignore */ })

      const spawnCalls = vi.mocked(mockSpawn).mock.calls
      expect(spawnCalls.length).toBeGreaterThan(0)

      const spawnArgs = spawnCalls[0][1] as string[]
      expect(spawnArgs).toContain('--model')
      const modelIdx = spawnArgs.indexOf('--model')
      expect(spawnArgs[modelIdx + 1]).toBe('gpt-5.5')
      // Explicitly verify o4-mini is NOT used
      expect(spawnArgs).not.toContain('o4-mini')
    })
  })

  describe('POST /tickets/:id/ai-edit with provider=codex', () => {
    it('uses gpt-5.5, not o4-mini', async () => {
      const { writeFileSync, mkdirSync } = await import('fs')
      const { join } = await import('path')

      // Set up a temporary ticket file so the route can find ticket #1
      const tmpDir = '/tmp/specrails-codex-test-' + Date.now()
      mkdirSync(join(tmpDir, '.specrails'), { recursive: true })
      writeFileSync(join(tmpDir, '.specrails', 'local-tickets.json'), JSON.stringify({
        revision: 1,
        tickets: [{ id: 1, title: 'Test', description: '# Test\n\nDesc', status: 'open' }],
      }))

      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const ctx = makeMinimalContext(db, 'codex')
      ctx.project.path = tmpDir
      const { app } = createApp(ctx)

      const aiEditRequest = request(app)
        .post('/api/projects/proj-codex/tickets/1/ai-edit')
        .send({ instructions: 'Make it clearer', description: '# Test\n\nOriginal description.' })

      // Wait for spawn to be called, then clean up
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      child.stdout.push(null)
      child.emit('close', 0)
      await aiEditRequest.catch(() => { /* ignore */ })

      const spawnCalls = vi.mocked(mockSpawn).mock.calls
      expect(spawnCalls.length).toBeGreaterThan(0)

      const spawnArgs = spawnCalls[0][1] as string[]
      expect(spawnArgs).toContain('--model')
      const modelIdx = spawnArgs.indexOf('--model')
      expect(spawnArgs[modelIdx + 1]).toBe('gpt-5.5')
      expect(spawnArgs).not.toContain('o4-mini')

      // Cleanup
      try { const { rmSync } = await import('fs'); rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
    })
  })

  describe('Kimi pure-output safety gates', () => {
    it('rejects Quick Spec before spawning because prompt mode cannot enforce tool isolation', async () => {
      const ctx = makeMinimalContext(db, 'kimi')
      const { app } = createApp(ctx)

      const response = await request(app)
        .post('/api/projects/proj-codex/tickets/generate-spec')
        .send({ idea: 'Add a dark mode toggle' })

      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        error: 'provider_tool_policy_unsupported',
        provider: 'kimi',
        requiredPolicy: 'pure-output',
      })
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('rejects AI Edit before spawning because prompt mode cannot enforce read-only tools', async () => {
      const ctx = makeMinimalContext(db, 'kimi')
      const { app } = createApp(ctx)

      const response = await request(app)
        .post('/api/projects/proj-codex/tickets/1/ai-edit')
        .send({
          title: 'Test',
          instructions: 'Make it clearer',
          description: '# Test\n\nOriginal description.',
        })

      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        error: 'provider_tool_policy_unsupported',
        provider: 'kimi',
        requiredPolicy: 'read-only',
      })
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('rejects an explicit Kimi AI Edit in a Claude-primary mixed project instead of silently using Claude', async () => {
      const ctx = makeMinimalContext(db, 'claude')
      ctx.project.providers = ['claude', 'kimi']
      const { app } = createApp(ctx)

      const response = await request(app)
        .post('/api/projects/proj-codex/tickets/1/ai-edit')
        .send({
          provider: 'kimi',
          title: 'Test',
          instructions: 'Make it clearer',
          description: '# Test\n\nOriginal description.',
        })

      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        error: 'provider_tool_policy_unsupported',
        provider: 'kimi',
        requiredPolicy: 'read-only',
      })
      expect(mockSpawn).not.toHaveBeenCalled()
    })
  })
})
