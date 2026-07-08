import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express, { Router, type Express } from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from './db'
import { createLoopRun } from './loop-runs-store'
import { registerJobsRoutes } from './project-router-jobs'
import type { ProjectRoutesDeps } from './project-router-helpers'
import { startBackgroundProcess, killOwnedBackgroundProcess } from './transient-children'

vi.mock('./transient-children', () => ({
  startBackgroundProcess: vi.fn(),
  killOwnedBackgroundProcess: vi.fn(),
}))

let db: DbInstance
let broadcast: ReturnType<typeof vi.fn>

function buildApp(activeJobId: string | null = null): Express {
  const app = express()
  app.use(express.json())
  const router = Router()
  broadcast = vi.fn()
  const queueManager = {
    getActiveJobId: vi.fn(() => activeJobId),
  }
  const ctx = () => ({
    db,
    project: {
      id: 'p1',
      slug: 'p1',
      name: 'Project One',
      path: '/tmp/specrails-background-route',
      provider: 'claude',
      providers: ['claude'],
    },
    queueManager,
    broadcast,
  })
  registerJobsRoutes({ router, ctx, ticketPath: () => undefined } as unknown as ProjectRoutesDeps)
  app.use('/api/projects', router)
  return app
}

function mockStartedProcess(pid = 910): void {
  vi.mocked(startBackgroundProcess).mockImplementation((command, cwd, chatId, projectId, hooks) => {
    const process = {
      pid,
      command,
      cwd,
      startedAt: 10,
      status: 'running' as const,
      chatId,
      projectId,
    }
    hooks?.onStarted?.(process)
    hooks?.onOutput?.({
      pid,
      chatId,
      projectId,
      source: 'stdout',
      line: 'this should not be broadcast by the REST route',
    })
    return process
  })
}

beforeEach(() => {
  db = initDb(':memory:')
  vi.mocked(startBackgroundProcess).mockReset()
  vi.mocked(killOwnedBackgroundProcess).mockReset()
  mockStartedProcess()
})

afterEach(() => {
  db.close()
})

describe('POST /:projectId/background-processes', () => {
  it('requires an explicit confirmation bit before spawning a chip command', async () => {
    const app = buildApp()

    const res = await request(app)
      .post('/api/projects/p1/background-processes')
      .send({ command: 'npm run dev', chatId: 'chat-1' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/confirmed/)
    expect(startBackgroundProcess).not.toHaveBeenCalled()
  })

  it('blocks while a queue job is active unless the concurrent run is explicitly allowed', async () => {
    const app = buildApp('job-1')

    const blocked = await request(app)
      .post('/api/projects/p1/background-processes')
      .send({ command: 'npm run dev', chatId: 'chat-1', confirmed: true })

    expect(blocked.status).toBe(409)
    expect(blocked.body.reason).toContain('job job-1')
    expect(startBackgroundProcess).not.toHaveBeenCalled()

    const allowed = await request(app)
      .post('/api/projects/p1/background-processes')
      .send({ command: 'npm run dev', chatId: 'chat-1', confirmed: true, allowWhileBusy: true })

    expect(allowed.status).toBe(202)
    expect(allowed.body.process.pid).toBe(910)
    expect(startBackgroundProcess).toHaveBeenCalledTimes(1)
  })

  it('blocks while a loop run is active', async () => {
    const app = buildApp()
    createLoopRun(db, {
      id: 'loop-run-1',
      projectId: 'p1',
      loopId: 'loop-1',
      iterationLimit: 5,
      startedAt: new Date().toISOString(),
    })

    const res = await request(app)
      .post('/api/projects/p1/background-processes')
      .send({ command: 'npm run dev', chatId: 'chat-1', confirmed: true })

    expect(res.status).toBe(409)
    expect(res.body.reason).toContain('loop run loop-run-1')
    expect(startBackgroundProcess).not.toHaveBeenCalled()
  })

  it('broadcasts lifecycle events without forwarding stdout/stderr frames', async () => {
    const app = buildApp()

    const res = await request(app)
      .post('/api/projects/p1/background-processes')
      .send({ command: 'npm run dev', chatId: 'chat-1', confirmed: true })

    expect(res.status).toBe(202)
    const hooks = vi.mocked(startBackgroundProcess).mock.calls[0][4]
    expect(hooks?.onOutput).toBeUndefined()
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'background_process.started',
      process: expect.objectContaining({ pid: 910, chatId: 'chat-1' }),
    }))
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'background_process.output',
    }))
  })
})
