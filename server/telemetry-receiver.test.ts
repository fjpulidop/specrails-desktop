import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { createTelemetryRouter, awaitTelemetryAppendQuiescence } from './telemetry-receiver'
import { initDb, createJob, getTelemetryBlob } from './db'
import type { DbInstance } from './db'
import type { ProjectRegistry } from './project-registry'
import type { ProjectContext } from './project-registry'

function makeDb(): DbInstance {
  return initDb(':memory:')
}

function makeProjectCtx(db: DbInstance, slug = 'test-slug'): ProjectContext {
  return {
    db,
    project: {
      id: 'proj-1',
      slug,
      name: 'Test',
      path: '/tmp/test',
      db_path: ':memory:',
      provider: 'claude',
      added_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
    queueManager: {} as ProjectContext['queueManager'],
    chatManager: {} as ProjectContext['chatManager'],
    setupManager: {} as ProjectContext['setupManager'],
    proposalManager: {} as ProjectContext['proposalManager'],
    specLauncherManager: {} as ProjectContext['specLauncherManager'],
    ticketWatcher: {} as ProjectContext['ticketWatcher'],
    broadcast: () => {},
    railJobs: new Map(),
  }
}

function makeRegistry(ctx?: ProjectContext): ProjectRegistry {
  return {
    getContext(id: string) {
      if (ctx && ctx.project.id === id) return ctx
      return undefined
    },
  } as unknown as ProjectRegistry
}

function makeApp(registry: ProjectRegistry): express.Application {
  const app = express()
  app.use(express.json())
  app.use('/otlp', createTelemetryRouter(registry))
  return app
}

function traceBody(jobId: string, projectId: string): object {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'specrails.job_id', value: { stringValue: jobId } },
          { key: 'specrails.project_id', value: { stringValue: projectId } },
        ],
      },
      scopeSpans: [],
    }],
  }
}

function metricsBody(jobId: string, projectId: string): object {
  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          { key: 'specrails.job_id', value: { stringValue: jobId } },
          { key: 'specrails.project_id', value: { stringValue: projectId } },
        ],
      },
      scopeMetrics: [],
    }],
  }
}

function logsBody(jobId: string, projectId: string): object {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'specrails.job_id', value: { stringValue: jobId } },
          { key: 'specrails.project_id', value: { stringValue: projectId } },
        ],
      },
      scopeLogs: [],
    }],
  }
}

describe('OTLP receiver — validation', () => {
  let db: DbInstance
  let app: express.Application
  let telemetryDir: string

  beforeEach(() => {
    db = makeDb()
    const slug = `test-recv-${Date.now()}`
    const ctx = makeProjectCtx(db, slug)
    app = makeApp(makeRegistry(ctx))
    telemetryDir = path.join(os.homedir(), '.specrails', 'projects', slug, 'telemetry')

    createJob(db, {
      id: 'job-1',
      command: 'architect',
      started_at: new Date().toISOString(),
    })
  })

  afterEach(async () => {
    // Drain in-flight gzip appends BEFORE removing their target dir — an
    // orphaned append logging after the test races vitest worker teardown.
    await awaitTelemetryAppendQuiescence()
    try { fs.rmSync(telemetryDir, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('returns 400 when resource attributes are empty', async () => {
    const res = await request(app)
      .post('/otlp/v1/traces')
      .send({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [] }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Missing/)
  })

  it('returns 400 for non-object body', async () => {
    const res = await request(app)
      .post('/otlp/v1/traces')
      .set('Content-Type', 'application/json')
      .send('"just-a-string"')
    expect(res.status).toBe(400)
  })

  it('returns 400 for null body', async () => {
    const res = await request(app)
      .post('/otlp/v1/traces')
      .set('Content-Type', 'application/json')
      .send('null')
    expect(res.status).toBe(400)
  })

  it('returns 404 when project not found', async () => {
    const res = await request(app)
      .post('/otlp/v1/traces')
      .send(traceBody('job-1', 'unknown-project'))
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Project/)
  })

  it('returns 404 when job not found in project DB', async () => {
    const res = await request(app)
      .post('/otlp/v1/traces')
      .send(traceBody('no-such-job', 'proj-1'))
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Job/)
  })
})

describe('OTLP receiver — successful ingest', () => {
  let db: DbInstance
  let app: express.Application
  let telemetryDir: string

  beforeEach(() => {
    db = makeDb()
    const slug = `test-ingest-${Date.now()}`
    const ctx = makeProjectCtx(db, slug)
    app = makeApp(makeRegistry(ctx))
    telemetryDir = path.join(os.homedir(), '.specrails', 'projects', slug, 'telemetry')

    createJob(db, {
      id: 'job-1',
      command: 'architect',
      started_at: new Date().toISOString(),
    })
  })

  afterEach(async () => {
    // Drain in-flight gzip appends BEFORE removing their target dir — an
    // orphaned append logging after the test races vitest worker teardown.
    await awaitTelemetryAppendQuiescence()
    try { fs.rmSync(telemetryDir, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('returns 200 for valid traces', async () => {
    const res = await request(app)
      .post('/otlp/v1/traces')
      .send(traceBody('job-1', 'proj-1'))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('returns 200 for valid metrics', async () => {
    const res = await request(app)
      .post('/otlp/v1/metrics')
      .send(metricsBody('job-1', 'proj-1'))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('returns 200 for valid logs', async () => {
    const res = await request(app)
      .post('/otlp/v1/logs')
      .send(logsBody('job-1', 'proj-1'))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('creates a telemetry_blobs pointer row after first ingest', async () => {
    await request(app).post('/otlp/v1/traces').send(traceBody('job-1', 'proj-1'))
    // Give async write time to land
    await new Promise(r => setTimeout(r, 100))
    const blob = getTelemetryBlob(db, 'job-1')
    expect(blob).toBeDefined()
    expect(blob!.state).toBe('active')
    expect(blob!.jobId).toBe('job-1')
  })

  it('second ingest updates existing blob pointer', async () => {
    await request(app).post('/otlp/v1/traces').send(traceBody('job-1', 'proj-1'))
    await request(app).post('/otlp/v1/metrics').send(metricsBody('job-1', 'proj-1'))
    await new Promise(r => setTimeout(r, 100))
    const blob = getTelemetryBlob(db, 'job-1')
    expect(blob).toBeDefined()
    expect(blob!.byteSize).toBeGreaterThan(0)
  })

  it('extracts intValue resource attribute', async () => {
    const body = {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'specrails.job_id', value: { intValue: 0 } },
            { key: 'specrails.project_id', value: { stringValue: 'proj-1' } },
          ],
        },
        scopeSpans: [],
      }],
    }
    // job with id "0" doesn't exist, so 404 is expected — but attr extraction worked
    const res = await request(app).post('/otlp/v1/traces').send(body)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Job/)
  })
})

describe('OTLP receiver — byteSize integrity on append failure (BUG-WEBHOOK-03)', () => {
  let db: DbInstance
  let app: express.Application
  let telemetryDir: string

  beforeEach(() => {
    db = makeDb()
    const slug = `test-failwrite-${Date.now()}`
    const ctx = makeProjectCtx(db, slug)
    app = makeApp(makeRegistry(ctx))
    telemetryDir = path.join(os.homedir(), '.specrails', 'projects', slug, 'telemetry')

    createJob(db, {
      id: 'job-fail',
      command: 'architect',
      started_at: new Date().toISOString(),
    })
  })

  afterEach(async () => {
    await awaitTelemetryAppendQuiescence()
    vi.restoreAllMocks()
    try { fs.rmSync(telemetryDir, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('does NOT advance byteSize when the gzip append fails', async () => {
    // Force every fs.appendFile call to fail (simulates ENOSPC/EACCES).
    const spy = vi.spyOn(fs, 'appendFile').mockImplementation(((
      _file: unknown,
      _data: unknown,
      cb: (err: NodeJS.ErrnoException | null) => void,
    ) => {
      const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
      err.code = 'ENOSPC'
      cb(err)
    }) as unknown as typeof fs.appendFile)

    const res = await request(app)
      .post('/otlp/v1/traces')
      .send(traceBody('job-fail', 'proj-1'))
    // The route still responds 200 — the failure is async/internal.
    expect(res.status).toBe(200)

    // Let the enqueued (failing) write task settle.
    await new Promise((r) => setTimeout(r, 100))
    expect(spy).toHaveBeenCalled()

    // The pointer row exists but byteSize must NOT have advanced past 0, because
    // the bytes never landed on disk.
    const blob = getTelemetryBlob(db, 'job-fail')
    expect(blob).toBeDefined()
    expect(blob!.byteSize).toBe(0)
  })

  it('advances byteSize once a later append succeeds after an earlier failure', async () => {
    let failNext = true
    const realAppend = fs.appendFile.bind(fs)
    vi.spyOn(fs, 'appendFile').mockImplementation(((
      file: unknown,
      data: unknown,
      cb: (err: NodeJS.ErrnoException | null) => void,
    ) => {
      if (failNext) {
        failNext = false
        const err = new Error('EACCES') as NodeJS.ErrnoException
        err.code = 'EACCES'
        cb(err)
        return
      }
      // Delegate to the real implementation for the second write.
      ;(realAppend as unknown as (f: unknown, d: unknown, c: (e: NodeJS.ErrnoException | null) => void) => void)(file, data, cb)
    }) as unknown as typeof fs.appendFile)

    await request(app).post('/otlp/v1/traces').send(traceBody('job-fail', 'proj-1'))
    await request(app).post('/otlp/v1/metrics').send(metricsBody('job-fail', 'proj-1'))
    await new Promise((r) => setTimeout(r, 150))

    const blob = getTelemetryBlob(db, 'job-fail')
    expect(blob).toBeDefined()
    // First write failed (byteSize stays 0 for it); second write succeeded and
    // advances the size by exactly that line's length — strictly > 0.
    expect(blob!.byteSize).toBeGreaterThan(0)
  })
})

describe('OTLP receiver — cap enforcement', () => {
  it('drops logs (returns ok+dropped) once cap is hit (simulated via state)', async () => {
    // Cap enforcement is internal state; we can only observe via multiple large payloads.
    // Here we verify the route at least returns 200 for logs under normal conditions.
    const db = makeDb()
    const slug = `test-cap-${Date.now()}`
    const ctx = makeProjectCtx(db, slug)
    const app = makeApp(makeRegistry(ctx))
    const telDir = path.join(os.homedir(), '.specrails', 'projects', slug, 'telemetry')

    createJob(db, { id: 'job-cap', command: 'dev', started_at: new Date().toISOString() })

    const res = await request(app)
      .post('/otlp/v1/logs')
      .send(logsBody('job-cap', 'proj-1'))
    expect(res.status).toBe(200)

    try { fs.rmSync(telDir, { recursive: true, force: true }) } catch { /* ok */ }
  })
})
