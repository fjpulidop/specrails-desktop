/**
 * Cost-accounting capture tests for project-router-tickets routes:
 *  - HIGH-4: POST /tickets/:id/ai-edit records one ai_invocations row per run
 *    (surface='ai-edit'), success or failed, with native-or-estimated cost.
 *  - LOW-13: POST /tickets/generate-spec salvage path (error_max_turns that
 *    still delivered a ticket) records status='success', not 'failed'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import express from 'express'
import request from 'supertest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Mock child_process before importing project-router — spawnAiCli (used by both
// the ai-edit and generate-spec routes) resolves to child_process.spawn.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
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

function makeContext(db: DbInstance, projectPath: string): ProjectContext {
  return {
    project: {
      id: 'proj-1', slug: 'proj-1', name: 'P', path: projectPath, db_path: ':memory:',
      added_at: '', last_seen_at: '', provider: 'claude', providers: ['claude'],
    },
    db,
    queueManager: {
      enqueue: vi.fn(() => ({ id: 'job-1', queuePosition: 0 })),
      cancel: vi.fn(() => 'canceled'), pause: vi.fn(), resume: vi.fn(), reorder: vi.fn(),
      getJobs: vi.fn(() => []), isPaused: vi.fn(() => false), getActiveJobId: vi.fn(() => null),
      phasesForCommand: vi.fn(() => []),
    } as any,
    chatManager: { isActive: vi.fn(() => false), sendMessage: vi.fn(async () => {}), abort: vi.fn() } as any,
    setupManager: {
      isInstalling: vi.fn(() => false), isEnriching: vi.fn(() => false), isSettingUp: vi.fn(() => false),
      startEnrich: vi.fn(), startSetup: vi.fn(), resumeEnrich: vi.fn(), resumeSetup: vi.fn(), abort: vi.fn(),
      getCheckpointStatus: vi.fn(() => []), getInstallLog: vi.fn(() => []), getInstallTier: vi.fn(() => undefined),
      getSummary: vi.fn(() => ({ agents: 0, personas: 0, commands: 0 })),
    } as any,
    proposalManager: {
      isActive: vi.fn(() => false), startExploration: vi.fn(async () => {}), sendRefinement: vi.fn(async () => {}),
      createIssue: vi.fn(async () => {}), cancel: vi.fn(),
    } as any,
    specLauncherManager: { isActive: vi.fn(() => false), launch: vi.fn(async () => {}), cancel: vi.fn() } as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast: vi.fn(),
  } as unknown as ProjectContext
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
  const router = createProjectRouter(makeRegistry(ctx))
  const app = express()
  app.use(express.json())
  app.use('/api/projects', router)
  return { app }
}

const tick = () => new Promise<void>((r) => setImmediate(r))

/** Wait until the route handler has actually called spawn (it does so
 *  synchronously, but only after the request body is received). */
async function waitForSpawn(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (vi.mocked(mockSpawn).mock.calls.length > 0) return
    await new Promise<void>((r) => setTimeout(r, 5))
  }
  throw new Error('spawn was never called')
}

describe('project-router-tickets cost accounting', () => {
  let db: DbInstance
  let tmpDir: string

  beforeEach(() => {
    vi.mocked(mockSpawn).mockReset()
    db = initDb(':memory:')
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cost-'))
    fs.mkdirSync(path.join(tmpDir, '.specrails'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.specrails', 'local-tickets.json'),
      JSON.stringify({
        schema_version: '1.1', next_id: 2, revision: 1,
        tickets: { '1': { id: 1, title: 'Test', description: '# Test\n\nDesc', status: 'todo', labels: [], comments: [] } },
      }),
    )
  })

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function invocationRows(projectId = 'proj-1') {
    return db.prepare(
      `SELECT surface, status, ticket_id, total_cost_usd, total_cost_usd_estimated, tokens_in, tokens_out
       FROM ai_invocations WHERE project_id = ?`,
    ).all(projectId) as Array<{
      surface: string; status: string; ticket_id: number | null; total_cost_usd: number | null
      total_cost_usd_estimated: number; tokens_in: number | null; tokens_out: number | null
    }>
  }

  // ─── HIGH-4: ai-edit records an ai_invocations row ────────────────────────
  describe('POST /tickets/:id/ai-edit (HIGH-4)', () => {
    it('records a success row with native cost when the run completes cleanly', async () => {
      const ctx = makeContext(db, tmpDir)
      ctx.project.path = tmpDir
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      const { app } = createApp(ctx)

      const req = request(app)
        .post('/api/projects/proj-1/tickets/1/ai-edit')
        .send({ instructions: 'clearer', description: '# Test\n\nOriginal.' })

      void req.then(() => undefined, () => undefined) // kick off the lazy supertest request
      await waitForSpawn()
      const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2))
        .toEqual(['--tools', 'Read,Grep,Glob'])
      expect(args.join(',')).not.toContain('Bash')
      expect(args.join(',')).not.toContain('Write')
      expect(args.join(',')).not.toContain('Edit')
      child.stdout.push(JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 120, output_tokens: 40 },
          content: [{ type: 'text', text: 'TITLE: Better\nSHORT-SUMMARY: s\n\nbody' }],
        },
      }) + '\n')
      child.stdout.push(JSON.stringify({
        type: 'result', total_cost_usd: 0.12, num_turns: 2, model: 'claude-sonnet-4-6',
        duration_ms: 500, usage: { input_tokens: 120, output_tokens: 40 },
      }) + '\n')
      child.stdout.push(null)
      await tick()
      child.emit('close', 0)
      await req.catch(() => { /* 202 already returned */ })
      await tick()

      const rows = invocationRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].surface).toBe('ai-edit')
      expect(rows[0].status).toBe('success')
      expect(rows[0].ticket_id).toBe(1)
      expect(rows[0].total_cost_usd).toBeCloseTo(0.12)
      expect(rows[0].total_cost_usd_estimated).toBe(0)
      expect((ctx.broadcast as any).mock.calls.some(
        ([m]: [any]) => m.type === 'spending.invalidated',
      )).toBe(true)
    })

    it('records a failed row with an ESTIMATED cost when the run dies before its result event', async () => {
      const ctx = makeContext(db, tmpDir)
      ctx.project.path = tmpDir
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      const { app } = createApp(ctx)

      const req = request(app)
        .post('/api/projects/proj-1/tickets/1/ai-edit')
        .send({ instructions: 'clearer', description: '# Test\n\nOriginal.' })

      void req.then(() => undefined, () => undefined) // kick off the lazy supertest request
      await waitForSpawn()
      // Tokens streamed (billed) but the child exits non-zero before a result.
      child.stdout.push(JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-3-5-haiku-20241022',
          usage: { input_tokens: 80, output_tokens: 20 },
          content: [{ type: 'text', text: 'partial' }],
        },
      }) + '\n')
      child.stdout.push(null)
      await tick()
      child.emit('close', 1)
      await req.catch(() => { /* ignore */ })
      await tick()

      const rows = invocationRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].surface).toBe('ai-edit')
      expect(rows[0].status).toBe('failed')
      expect(rows[0].tokens_in).toBe(80)
      expect(rows[0].total_cost_usd_estimated).toBe(1)
      expect(rows[0].total_cost_usd as number).toBeGreaterThan(0)
    })
  })

  // ─── LOW-13: salvaged quick-spec is recorded 'success' ────────────────────
  describe('POST /tickets/generate-spec salvage (LOW-13)', () => {
    it('records status=success when error_max_turns still delivered a ticket', async () => {
      const ctx = makeContext(db, tmpDir)
      ctx.project.path = tmpDir
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      const { app } = createApp(ctx)

      const req = request(app)
        .post('/api/projects/proj-1/tickets/generate-spec')
        .send({ idea: 'Add dark mode toggle' })

      void req.then(() => undefined, () => undefined) // kick off the lazy supertest request
      await waitForSpawn()
      // A complete, usable spec streamed before claude burned its turn budget.
      child.stdout.push(JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 200, output_tokens: 150 },
          content: [{ type: 'text', text: '## Spec Title\nDark Mode Toggle\n\n## Estimated Complexity\nmedium\n\n## Labels\nui\n\n## Description\nAdd a toggle.' }],
        },
      }) + '\n')
      // Non-zero exit carrying subtype error_max_turns → salvage path.
      child.stdout.push(JSON.stringify({
        type: 'result', subtype: 'error_max_turns', total_cost_usd: 0.3, num_turns: 4,
        model: 'claude-sonnet-4-6', duration_ms: 900, usage: { input_tokens: 200, output_tokens: 150 },
      }) + '\n')
      child.stdout.push(null)
      await tick()
      child.emit('close', 1)
      await req.catch(() => { /* ignore */ })
      await new Promise<void>((r) => setTimeout(r, 40))

      const rows = invocationRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].surface).toBe('quick-spec')
      // The salvage delivered a ticket → success, not failed (LOW-13).
      expect(rows[0].status).toBe('success')
      expect(rows[0].ticket_id).not.toBeNull()

      // A ticket really was created from the salvaged buffer.
      const store = JSON.parse(fs.readFileSync(path.join(tmpDir, '.specrails', 'local-tickets.json'), 'utf8'))
      const titles = Object.values(store.tickets as Record<string, { title: string }>).map((t) => t.title)
      expect(titles).toContain('Dark Mode Toggle')
    })

    it('records status=failed when no ticket is delivered (empty output)', async () => {
      const ctx = makeContext(db, tmpDir)
      ctx.project.path = tmpDir
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      const { app } = createApp(ctx)

      const req = request(app)
        .post('/api/projects/proj-1/tickets/generate-spec')
        .send({ idea: 'Add dark mode toggle' })

      void req.then(() => undefined, () => undefined) // kick off the lazy supertest request
      await waitForSpawn()
      child.stdout.push(null)
      await tick()
      child.emit('close', 1)
      await req.catch(() => { /* ignore */ })
      await new Promise<void>((r) => setTimeout(r, 40))

      const rows = invocationRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].surface).toBe('quick-spec')
      expect(rows[0].status).toBe('failed')
      expect(rows[0].ticket_id).toBeNull()
    })
  })
})
