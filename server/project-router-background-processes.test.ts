import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express, { Router, type Express } from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from './db'
import { createLoopRun } from './loop-runs-store'
import { registerJobsRoutes } from './project-router-jobs'
import type { ProjectRoutesDeps } from './project-router-helpers'
import { startBackgroundProcess, killOwnedBackgroundProcess, getBackgroundProcessLogs, getBackgroundProcess, listBackgroundProcesses } from './transient-children'

vi.mock('./transient-children', () => ({
  startBackgroundProcess: vi.fn(),
  killOwnedBackgroundProcess: vi.fn(),
  getBackgroundProcessLogs: vi.fn(),
  getBackgroundProcess: vi.fn(),
  listBackgroundProcesses: vi.fn(),
}))

let db: DbInstance
let broadcast: ReturnType<typeof vi.fn>

function buildApp(activeJobId: string | null = null, repositories?: import('./project-repositories').ProjectRepository[]): Express {
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
      repositories,
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
      processId: `execution-${pid}`,
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
      processId: `execution-${pid}`,
      sequence: 1,
      at: 11,
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
  vi.mocked(getBackgroundProcessLogs).mockReset()
  vi.mocked(getBackgroundProcess).mockReset()
  vi.mocked(listBackgroundProcesses).mockReset().mockReturnValue([])
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

describe('GET /:projectId/background-processes/:pid/logs', () => {
  it('returns bounded logs for the same project/chat owner', async () => {
    vi.mocked(getBackgroundProcessLogs).mockReturnValue({
      process: {
        pid: 910,
        processId: 'execution-910',
        command: 'npm run dev',
        cwd: '/repo',
        startedAt: 10,
        status: 'failed',
        chatId: 'chat-1',
        projectId: 'p1',
        exitCode: 1,
      },
      lines: [
        { sequence: 1, at: 11, source: 'stdout', line: 'starting dev server' },
        { sequence: 2, at: 12, source: 'stderr', line: 'error: missing script dev' },
      ],
      truncated: false,
      droppedLines: 0,
      maxLines: 500,
      maxLineChars: 1000,
      retentionMs: 600000,
      nextSequence: 2,
    })
    const app = buildApp()

    const res = await request(app)
      .get('/api/projects/p1/background-processes/910/logs')
      .query({ chatId: 'chat-1', limit: 50 })

    expect(res.status).toBe(200)
    expect(getBackgroundProcessLogs).toHaveBeenCalledWith(910, {
      projectId: 'p1',
      chatId: 'chat-1',
      limit: 50,
    })
    expect(res.body.process.status).toBe('failed')
    expect(res.body.lines).toEqual([
      expect.objectContaining({ source: 'stdout', line: 'starting dev server' }),
      expect.objectContaining({ source: 'stderr', line: 'error: missing script dev' }),
    ])
  })

  it('requires chat ownership and reports missing/expired logs', async () => {
    vi.mocked(getBackgroundProcessLogs).mockReturnValue(null)
    const app = buildApp()

    const missingChat = await request(app).get('/api/projects/p1/background-processes/910/logs')
    expect(missingChat.status).toBe(400)
    expect(missingChat.body.error).toMatch(/chatId/)

    const missingLogs = await request(app)
      .get('/api/projects/p1/background-processes/910/logs')
      .query({ chatId: 'chat-1' })
    expect(missingLogs.status).toBe(404)
    expect(missingLogs.body.error).toMatch(/not found/)
  })
})

describe('background execution stop and discovery', () => {
  const live = { pid: 910, processId: 'execution-910', command: 'npm run dev', cwd: '/repo',
    startedAt: 10, status: 'running' as const, chatId: 'chat-1', projectId: 'p1' }

  it('returns stopping until confirmed, then makes a repeated stop idempotent', async () => {
    const app = buildApp()
    vi.mocked(getBackgroundProcess).mockReturnValue(live)
    vi.mocked(killOwnedBackgroundProcess).mockImplementation(() => {
      vi.mocked(getBackgroundProcess).mockReturnValue({ ...live, status: 'stopping' })
      return true
    })
    const response = await request(app).delete('/api/projects/p1/background-processes/910').query({ chatId: 'chat-1', processId: 'execution-910' })
    expect(response.status).toBe(202)
    expect(response.body.process).toMatchObject({ processId: 'execution-910', status: 'stopping' })
    expect(killOwnedBackgroundProcess).toHaveBeenCalledWith(910, { projectId: 'p1', chatId: 'chat-1', processId: 'execution-910' })
    vi.mocked(getBackgroundProcess).mockReturnValue({ ...live, status: 'killed', endedAt: 20 })
    const repeated = await request(app).delete('/api/projects/p1/background-processes/910').query({ chatId: 'chat-1', processId: 'execution-910' })
    expect(repeated.status).toBe(200)
    expect(repeated.body.status).toBe('killed')
    expect(killOwnedBackgroundProcess).toHaveBeenCalledOnce()
  })

  it('rejects foreign and reused execution identities without signalling', async () => {
    const app = buildApp()
    vi.mocked(getBackgroundProcess).mockReturnValue(live)
    for (const query of [{ chatId: 'other' }, { chatId: 'chat-1', processId: 'older-execution' }]) {
      expect((await request(app).delete('/api/projects/p1/background-processes/910').query(query)).status).toBe(404)
    }
    expect(killOwnedBackgroundProcess).not.toHaveBeenCalled()
  })

  it('surfaces signalling failures instead of acknowledging a successful close', async () => {
    const app = buildApp()
    vi.mocked(getBackgroundProcess).mockReturnValue(live)
    vi.mocked(killOwnedBackgroundProcess).mockImplementation(() => { throw new Error('permission denied') })
    const response = await request(app).delete('/api/projects/p1/background-processes/910').query({ chatId: 'chat-1' })
    expect(response.status).toBe(500)
    expect(response.body.error).toContain('permission denied')
  })

  it('rejects invalid process ids and log limits before reading or signalling', async () => {
    const app = buildApp()
    for (const pid of ['0', '-1', '1.5', 'Infinity', 'no-pid']) {
      expect((await request(app).delete(`/api/projects/p1/background-processes/${pid}`).query({ chatId: 'chat-1' })).status).toBe(400)
      expect((await request(app).get(`/api/projects/p1/background-processes/${pid}/logs`).query({ chatId: 'chat-1' })).status).toBe(400)
    }
    expect((await request(app).get('/api/projects/p1/background-processes/910/logs').query({ chatId: 'chat-1', limit: '1.5' })).status).toBe(400)
    expect(getBackgroundProcessLogs).not.toHaveBeenCalled()
    expect(killOwnedBackgroundProcess).not.toHaveBeenCalled()
  })

  it('scopes retained discovery and log reads to execution identity', async () => {
    const app = buildApp()
    await request(app).get('/api/projects/p1/background-processes').query({ chatId: 'chat-1', includeFinished: 'true' })
    expect(listBackgroundProcesses).toHaveBeenCalledWith({ projectId: 'p1', chatId: 'chat-1', includeFinished: true })
    await request(app).get('/api/projects/p1/background-processes/910/logs').query({ chatId: 'chat-1', processId: 'execution-910', limit: 100 })
    expect(getBackgroundProcessLogs).toHaveBeenCalledWith(910, { projectId: 'p1', chatId: 'chat-1', processId: 'execution-910', limit: 100 })
  })

  it('keeps recovered executions readable but refuses to signal their historical PID', async () => {
    const recovered = { ...live, status: 'interrupted' as const, recoveredAt: 200,
      error: 'Supervision ended when Specrails restarted; current OS state is unknown.' }
    vi.mocked(getBackgroundProcess).mockReturnValue(recovered)
    vi.mocked(listBackgroundProcesses).mockReturnValue([recovered])
    vi.mocked(getBackgroundProcessLogs).mockReturnValue({ process: recovered,
      lines: [{ sequence: 1, at: 11, source: 'stderr', line: 'Backend startup failed' }],
      nextSequence: 1, truncated: false, droppedLines: 0, maxLines: 10000, maxLineChars: 4000, retentionMs: 30 * 86400000 })
    const app = buildApp()
    const query = { chatId: live.chatId, processId: live.processId }
    const logs = await request(app).get(`/api/projects/p1/background-processes/${live.pid}/logs`).query(query)
    expect(logs.status).toBe(200)
    expect(logs.body.lines[0].line).toBe('Backend startup failed')
    const stop = await request(app).delete(`/api/projects/p1/background-processes/${live.pid}`).query(query)
    expect(stop.status).toBe(409)
    expect(stop.body.error).toMatch(/current OS state is unknown/)
    expect(killOwnedBackgroundProcess).not.toHaveBeenCalled()
  })

  it('selects the repository explicitly and carries its identity into the process', async () => {
    const repositories = ['front', 'back'].map((id, i) => ({ id, projectId: 'p1', name: id,
      path: `/tmp/${id}`, isPrimary: i === 0, kind: 'git' as const, integrationBranch: null, addedAt: '' }))
    const app = buildApp(null, repositories)
    const body = { command: 'npm run dev', confirmed: true, chatId: 'chat-1' }
    expect((await request(app).post('/api/projects/p1/background-processes').send(body)).status).toBe(400)
    expect((await request(app).post('/api/projects/p1/background-processes').send({ ...body, repositoryId: 'back', cwd: '../front' })).status).toBe(400)
    const response = await request(app).post('/api/projects/p1/background-processes').send({ ...body, repositoryId: 'back', cwd: 'server' })
    expect(response.status).toBe(202)
    expect(startBackgroundProcess).toHaveBeenCalledWith('npm run dev', '/tmp/back/server', 'chat-1', 'p1', expect.objectContaining({ onUpdated: expect.any(Function) }), { repositoryId: 'back', repositoryName: 'back' })
    const hooks = vi.mocked(startBackgroundProcess).mock.calls[0][4]
    hooks?.onUpdated?.({ ...live, status: 'stopping' })
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'background_process.updated', process: expect.objectContaining({ status: 'stopping' }) }))
  })
})
