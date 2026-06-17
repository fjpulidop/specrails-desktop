/**
 * Focused test for the Gemini provider stream-handling path in project-router.
 *
 * Regression: POST /tickets/generate-spec previously hardcoded a codex branch +
 * a claude branch (matching `type:"assistant"`). Gemini emits assistant text as
 * `type:"message"` / `role:"assistant"`, so it matched NEITHER — the buffer never
 * accumulated and spec generation failed with "Empty response from AI". The
 * endpoint now routes non-claude/non-codex providers through the adapter-driven
 * path (the same one the ai-edit endpoint already used), so gemini streams and
 * produces a ticket.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import express from 'express'
import request from 'supertest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'

vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn() }))
vi.mock('uuid', () => ({ v4: vi.fn(() => 'gemini-req-uuid') }))

import { spawn as mockSpawn } from 'child_process'
import { createProjectRouter } from './project-router'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { DbInstance } from './db'

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 88888
  child.kill = vi.fn()
  return child
}

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function makeMinimalContext(db: DbInstance, projectPath: string): ProjectContext {
  return {
    project: {
      id: 'proj-gemini',
      slug: 'proj-gemini',
      name: 'Gemini Project',
      path: projectPath,
      db_path: ':memory:',
      added_at: '',
      last_seen_at: '',
      provider: 'gemini',
      providers: ['gemini'],
    },
    db,
    queueManager: {
      enqueue: vi.fn(() => ({ id: 'job-1', queuePosition: 0 })),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      reorder: vi.fn(),
      getJobs: vi.fn(() => []),
      isPaused: vi.fn(() => false),
      getActiveJobId: vi.fn(() => null),
      phasesForCommand: vi.fn(() => []),
    } as any,
    chatManager: { isActive: vi.fn(() => false), sendMessage: vi.fn(async () => {}), abort: vi.fn() } as any,
    setupManager: { isInstalling: vi.fn(() => false), isEnriching: vi.fn(() => false), isSettingUp: vi.fn(() => false) } as any,
    proposalManager: { isActive: vi.fn(() => false) } as any,
    specLauncherManager: { isActive: vi.fn(() => false) } as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast: vi.fn(),
  } as any
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
  return app
}

describe('gemini stream handling in project-router', () => {
  let db: DbInstance
  let tmpDir: string

  beforeEach(() => {
    vi.resetAllMocks()
    db = initDb(':memory:')
    tmpDir = '/tmp/specrails-gemini-test-' + process.pid + '-' + Math.floor(performance.now())
    mkdirSync(join(tmpDir, '.specrails'), { recursive: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  describe('POST /tickets/generate-spec with provider=gemini', () => {
    it('accumulates assistant text from gemini `type:"message"` events and creates a ticket', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      const ctx = makeMinimalContext(db, tmpDir)
      const app = createApp(ctx)

      const requestPromise = request(app)
        .post('/api/projects/proj-gemini/tickets/generate-spec')
        .send({ idea: 'Add a dark mode toggle' })

      // Let the handler dispatch + spawn the child + attach its stdout reader.
      // (A fixed tick — vi.waitFor's polling starves supertest's request dispatch.)
      await tick(60)

      // A full spec arrives as one gemini assistant message (`type:"message"`).
      const specText = [
        '## Spec Title',
        'Dark mode toggle',
        '',
        '## Estimated Complexity',
        'medium',
        '',
        '## Description',
        'Add a persistent dark mode toggle to settings.',
      ].join('\n')
      const typesSeen = () => vi.mocked(ctx.broadcast).mock.calls.map((c) => (c[0] as any)?.type)
      const waitForType = async (type: string) => {
        for (let i = 0; i < 100 && !typesSeen().includes(type); i++) await tick(20)
      }

      child.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', content: specText }) + '\n')
      child.stdout.write(JSON.stringify({ type: 'result', stats: { input_tokens: 10, output_tokens: 20 } }) + '\n')
      child.stdout.end()
      // Poll until the assistant text has streamed. THIS is the regression proof:
      // the legacy code only matched codex's `item.completed` / claude's
      // `type:"assistant"`, so gemini's `type:"message"` was dropped and nothing
      // streamed. The adapter-driven branch now accumulates it.
      await waitForType('spec_gen_stream')
      child.emit('close', 0)
      await requestPromise.catch(() => { /* ignore */ })

      const broadcasts = vi.mocked(ctx.broadcast).mock.calls.map((c) => c[0] as any)
      const streamMsgs = broadcasts.filter((m) => m?.type === 'spec_gen_stream')
      expect(streamMsgs.length).toBeGreaterThan(0)
      expect(streamMsgs.map((m) => m.delta).join('')).toContain('Dark mode toggle')

      // The spawn targeted the gemini binary with the gemini default model
      // (gemini-3.5-flash, the refreshed catalog default), not a claude one.
      const spawnArgs = vi.mocked(mockSpawn).mock.calls[0]
      expect(spawnArgs[0]).toBe('gemini')
      expect((spawnArgs[1] as string[]).join(' ')).toContain('gemini-3.5-flash')
    })
  })
})
