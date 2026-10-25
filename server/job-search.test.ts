import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { initDb, createJob, finishJob, upsertPhase, deleteJob, purgeJobs, type DbInstance } from './db'
import {
  JOB_SEARCH_MAX_DOCS, JOB_SEARCH_MAX_PHASES, createJobSearchSchema, indexJob, pruneJobSearch, rebuildJobSearchIndex, searchJobs,
} from './db/job-search'
import { createLoopRun, finishLoopRun } from './modules/loops/runtime/loop-runs-store'
import { createProjectRouter } from './project-router'
import { initDesktopDb } from './desktop-db'
import { resolveTicketStoragePath, mutateStore, type Ticket } from './modules/specs/runtime/ticket-store'
import type { ProjectRegistry, ProjectContext } from './project-registry'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => { db.close() })

const docCount = (d: DbInstance = db) => (d.prepare('SELECT COUNT(*) AS n FROM job_search_docs').get() as { n: number }).n
const ftsCount = (d: DbInstance = db) => (d.prepare('SELECT COUNT(*) AS n FROM job_search_fts').get() as { n: number }).n
const result = { status: 'completed' as const, exit_code: 0 }

function job(id: string, command: string) {
  createJob(db, { id, command, started_at: '2026-10-01T00:00:00.000Z' })
}

describe('migration 86: job-log search index', () => {
  it('applies on a fresh database and is recorded as version 86', () => {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }
    expect(row.v).toBeGreaterThanOrEqual(86)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='job_search_fts'").get()).toBeTruthy()
    expect(searchJobs(db, 'anything')).toEqual([])
  })

  it('the backfill indexes pre-existing jobs, phases and failure diagnoses, and is idempotent', () => {
    job('j1', '/specrails:implement #12 gravity flip')
    db.prepare("INSERT INTO job_phases (job_id, phase, state, updated_at) VALUES ('j1','architect','done','2026-10-01')").run()
    createLoopRun(db, { id: 'j1', projectId: 'p', loopId: 'l', loopName: 'Ship the checkout', iterationLimit: 3, startedAt: '2026-10-01T00:00:00.000Z' })
    finishLoopRun(db, 'j1', {
      outcome: 'failed', finishedAt: '2026-10-01T01:00:00.000Z',
      failureDiagnosis: JSON.stringify({ kind: 'provider_limit', phase: 'developer', detail: 'Session limit reached, resets at 9pm' }),
    })
    db.prepare('DELETE FROM job_search_docs').run()
    expect(ftsCount()).toBe(0)

    const first = rebuildJobSearchIndex(db)
    const docsAfterFirst = docCount()
    const second = rebuildJobSearchIndex(db)
    expect(first).toBe(1)
    expect(second).toBe(1)
    expect(docCount()).toBe(docsAfterFirst)
    expect(ftsCount()).toBe(docsAfterFirst)
    expect(searchJobs(db, 'gravity flip')[0]).toMatchObject({ jobId: 'j1', field: 'command' })
    expect(searchJobs(db, 'checkout')[0]).toMatchObject({ jobId: 'j1', field: 'loop' })
    expect(searchJobs(db, 'provider limit')[0]).toMatchObject({ jobId: 'j1', field: 'failure' })
    expect(searchJobs(db, 'resets at 9pm')[0]).toMatchObject({ jobId: 'j1', field: 'detail' })
    expect(searchJobs(db, 'architect')[0]).toMatchObject({ jobId: 'j1', field: 'phase' })
  })

  it('createJobSearchSchema can run twice (IF NOT EXISTS)', () => {
    expect(() => createJobSearchSchema(db)).not.toThrow()
  })
})

describe('incremental indexing', () => {
  it('indexes the command at create, phases as they arrive and the diagnosis at settle', () => {
    job('j1', '/specrails:implement login form')
    expect(searchJobs(db, 'login form').map((h) => h.jobId)).toEqual(['j1'])

    upsertPhase(db, 'j1', 'security-review', 'running')
    upsertPhase(db, 'j1', 'security-review', 'done')
    expect(searchJobs(db, 'security-review')).toHaveLength(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_search_docs WHERE field='phase'").get()).toEqual({ n: 1 })

    createLoopRun(db, { id: 'j1', projectId: 'p', loopId: 'l', loopName: null, iterationLimit: 1, startedAt: '2026-10-01T00:00:00.000Z' })
    finishLoopRun(db, 'j1', { outcome: 'failed', finishedAt: '2026-10-01T02:00:00.000Z', failureDiagnosis: JSON.stringify({ kind: 'environment', detail: 'Playwright browsers are not installed' }) })
    finishJob(db, 'j1', { ...result, status: 'failed', exit_code: 1 })
    const hit = searchJobs(db, 'playwright browsers')[0]
    expect(hit).toMatchObject({ jobId: 'j1', field: 'detail', status: 'failed' })
    expect(hit.snippet.ranges.length).toBe(1)
    const [start, end] = hit.snippet.ranges[0]
    expect(hit.snippet.text.slice(start, end).toLowerCase()).toBe('playwright browsers')
  })

  it('re-indexing replaces a job’s documents instead of duplicating them', () => {
    job('j1', 'alpha beta')
    const before = docCount()
    indexJob(db, 'j1'); indexJob(db, 'j1')
    expect(docCount()).toBe(before)
    expect(ftsCount()).toBe(before)
  })

  it('forgets jobs that are deleted or purged', () => {
    job('gone', 'remove me please')
    job('purged', 'purge me please')
    finishJob(db, 'purged', result)
    deleteJob(db, 'gone')
    expect(searchJobs(db, 'remove me')).toEqual([])
    expect(purgeJobs(db)).toBe(1)
    expect(searchJobs(db, 'purge me')).toEqual([])
    expect(docCount()).toBe(0)
    expect(ftsCount()).toBe(0)
  })

  it('never indexes raw event payloads (token streams)', () => {
    job('j1', 'plain command')
    db.prepare("INSERT INTO events (job_id, seq, event_type, payload) VALUES ('j1', 1, 'log', 'zzz-secret-token-stream-line')").run()
    finishJob(db, 'j1', result)
    expect(searchJobs(db, 'secret-token-stream')).toEqual([])
  })

  it('an indexing failure never fails the write that triggered it', () => {
    db.exec('DROP TABLE job_search_fts; DROP TABLE job_search_docs;')
    expect(() => job('j1', 'still works')).not.toThrow()
    expect(() => upsertPhase(db, 'j1', 'p', 'done')).not.toThrow()
    expect(() => finishJob(db, 'j1', result)).not.toThrow()
    expect(() => deleteJob(db, 'j1')).not.toThrow()
  })
})

describe('bounds', () => {
  it('keeps at most JOB_SEARCH_MAX_PHASES phase documents per job', () => {
    job('j1', 'busy job')
    for (let i = 0; i < JOB_SEARCH_MAX_PHASES + 10; i++) upsertPhase(db, 'j1', `phase-${i}`, 'done')
    expect(db.prepare("SELECT COUNT(*) AS n FROM job_search_docs WHERE field='phase'").get()).toEqual({ n: JOB_SEARCH_MAX_PHASES })
  })

  it('truncates long text and drops the oldest tenth when over budget', () => {
    job('j1', 'x'.repeat(5000))
    const { len } = db.prepare("SELECT LENGTH(text) AS len FROM job_search_docs WHERE field='command'").get() as { len: number }
    expect(len).toBeLessThanOrEqual(300)

    const insert = db.prepare("INSERT INTO job_search_docs (job_id, field, text) VALUES ('j1','phase',?)")
    db.transaction(() => { for (let i = 0; i < JOB_SEARCH_MAX_DOCS + 5; i++) insert.run(`filler ${i}`) })()
    pruneJobSearch(db)
    expect(docCount()).toBeLessThanOrEqual(JOB_SEARCH_MAX_DOCS)
    expect(ftsCount()).toBe(docCount())
  })
})

describe('searchJobs', () => {
  it('returns one hit per job, escapes FTS syntax and handles 1-2 character queries', () => {
    job('j1', 'fix "quoted" AND NOT thing')
    upsertPhase(db, 'j1', 'fix-loop', 'done')
    expect(searchJobs(db, '"quoted" AND NOT').map((h) => h.jobId)).toEqual(['j1'])
    expect(searchJobs(db, 'fix').map((h) => h.jobId)).toEqual(['j1'])
    expect(searchJobs(db, 'fi').map((h) => h.jobId)).toEqual(['j1'])
    expect(searchJobs(db, '   ')).toEqual([])
  })

  it('matches without diacritics and caps the result count', () => {
    for (let i = 0; i < 12; i++) job(`j${i}`, `déploiement ${i}`)
    expect(searchJobs(db, 'deploiement', 5)).toHaveLength(5)
    expect(searchJobs(db, 'deploiement', 999).length).toBeLessThanOrEqual(30)
  })

  it('is isolated per project database', () => {
    const other = initDb(':memory:')
    try {
      job('only-here', 'secret payroll migration')
      expect(searchJobs(db, 'payroll')).toHaveLength(1)
      expect(searchJobs(other, 'payroll')).toEqual([])
    } finally { other.close() }
  })
})

describe('GET /api/projects/:id/search/{jobs,specs}', () => {
  let tmp: string
  let app: express.Express
  let ctxDb: DbInstance
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'search-routes-'))
    ctxDb = initDb(':memory:')
    createJob(ctxDb, { id: 'jobx', command: '/specrails:implement websocket reconnect', started_at: '2026-10-01T00:00:00.000Z' })
    const ctx = {
      project: { id: 'proj-1', slug: 'proj', name: 'T', path: tmp, db_path: ':memory:', added_at: '', last_seen_at: '' },
      db: ctxDb,
      queueManager: {} as any, chatManager: {} as any, setupManager: {} as any, proposalManager: {} as any, specLauncherManager: {} as any,
      ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
      broadcast: vi.fn(),
    } as unknown as ProjectContext
    const registry = {
      desktopDb: initDesktopDb(':memory:'),
      getContext: vi.fn((id: string) => (id === 'proj-1' ? ctx : undefined)),
      getContextByPath: vi.fn(), addProject: vi.fn(), removeProject: vi.fn(), touchProject: vi.fn(),
      listContexts: vi.fn(() => [ctx]),
    } as unknown as ProjectRegistry
    app = express()
    app.use(express.json())
    app.use('/api/projects', createProjectRouter(registry))
    const ticketPath = resolveTicketStoragePath(tmp)
    mutateStore(ticketPath, (s) => {
      const id = s.next_id++
      s.tickets[String(id)] = {
        id, title: 'Rate limiter', description: 'Throttle the API per token', status: 'todo', priority: 'high', labels: [], assignee: null,
        prerequisites: [], metadata: {}, comments: [], origin_conversation_id: null, is_epic: false, parent_epic_id: null,
        execution_order: null, short_summary: null, created_at: '', updated_at: '', created_by: 't', source: 'manual',
      } as Ticket
    })
  })
  afterEach(() => { ctxDb.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

  it('serves job hits and validates the query', async () => {
    const ok = await request(app).get('/api/projects/proj-1/search/jobs').query({ q: 'reconnect' })
    expect(ok.status).toBe(200)
    expect(ok.body.results[0]).toMatchObject({ jobId: 'jobx', field: 'command' })
    expect((await request(app).get('/api/projects/proj-1/search/jobs')).status).toBe(400)
    expect((await request(app).get('/api/projects/proj-1/search/jobs').query({ q: 'a'.repeat(300) })).status).toBe(400)
  })

  it('serves spec hits', async () => {
    const res = await request(app).get('/api/projects/proj-1/search/specs').query({ q: 'throttle' })
    expect(res.status).toBe(200)
    expect(res.body.results[0]).toMatchObject({ id: 1, field: 'description', title: 'Rate limiter' })
    expect((await request(app).get('/api/projects/proj-1/search/specs').query({ q: '   ' })).status).toBe(400)
  })
})
