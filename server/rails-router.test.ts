import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from './db'
import { createRailsRouter } from './rails-router'
import { getRail, setRailTickets } from './rails-store'

function appWith(
  db: DbInstance,
  opts?: {
    providers?: ('claude' | 'codex')[]
    queueManager?: { enqueue: (...args: unknown[]) => unknown }
    broadcast?: (msg: unknown) => void
  },
) {
  const providers = opts?.providers ?? ['claude']
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    // Minimal ProjectContext stand-in; the routes under test only touch db
    // (+ queueManager/broadcast for launch).
    ;(req as unknown as { projectCtx: unknown }).projectCtx = {
      db,
      railJobs: new Map(),
      project: { id: 'p1', slug: 's1', provider: providers[0], providers },
      queueManager: opts?.queueManager,
      broadcast: opts?.broadcast ?? (() => { /* noop */ }),
    }
    next()
  })
  app.use('/rails', createRailsRouter())
  return app
}

describe('rails-router PUT /:railIndex/tickets', () => {
  let db: DbInstance

  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  it('preserves a previously-set profile and mode when reassigning tickets', async () => {
    setRailTickets(db, 0, [1, 2], 'batch-implement', 'prof-a')
    expect(getRail(db, 0).profileName).toBe('prof-a')

    const res = await request(appWith(db)).put('/rails/0/tickets').send({ ticketIds: [3, 4] })

    expect(res.status).toBe(200)
    const rail = getRail(db, 0)
    expect(rail.ticketIds).toEqual([3, 4])
    expect(rail.mode).toBe('batch-implement') // preserved (pre-fix reset to 'implement')
    expect(rail.profileName).toBe('prof-a')    // preserved (pre-fix wiped to null)
  })

  it('honors explicit mode/profileName overrides in the body', async () => {
    setRailTickets(db, 1, [1], 'implement', 'old')
    const res = await request(appWith(db))
      .put('/rails/1/tickets')
      .send({ ticketIds: [9], mode: 'batch-implement', profileName: 'new' })
    expect(res.status).toBe(200)
    const rail = getRail(db, 1)
    expect(rail.mode).toBe('batch-implement')
    expect(rail.profileName).toBe('new')
  })

  it('lets an explicit null profileName clear the stored profile', async () => {
    setRailTickets(db, 0, [1], 'implement', 'prof-a')
    const res = await request(appWith(db))
      .put('/rails/0/tickets')
      .send({ ticketIds: [2], profileName: null })
    expect(res.status).toBe(200)
    expect(getRail(db, 0).profileName).toBeNull()
  })

  it('rejects an invalid rail index', async () => {
    const res = await request(appWith(db)).put('/rails/abc/tickets').send({ ticketIds: [1] })
    expect(res.status).toBe(400)
  })

  it('rejects ticketIds that are not an array of numbers', async () => {
    const res = await request(appWith(db)).put('/rails/0/tickets').send({ ticketIds: ['x'] })
    expect(res.status).toBe(400)
  })

  it('preserves a previously-set ai engine when reassigning tickets', async () => {
    setRailTickets(db, 0, [1], 'implement', null, 'codex')
    expect(getRail(db, 0).aiEngine).toBe('codex')
    const res = await request(appWith(db, { providers: ['claude', 'codex'] }))
      .put('/rails/0/tickets').send({ ticketIds: [3] })
    expect(res.status).toBe(200)
    expect(getRail(db, 0).aiEngine).toBe('codex')
  })
})

describe('rails-router PUT /:railIndex/name', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  it('sets a rail name (even with no tickets assigned)', async () => {
    const res = await request(appWith(db)).put('/rails/0/name').send({ name: 'Backend' })
    expect(res.status).toBe(200)
    expect(res.body.rail.name).toBe('Backend')
    expect(getRail(db, 0).name).toBe('Backend')
  })

  it('clears the name when null', async () => {
    await request(appWith(db)).put('/rails/0/name').send({ name: 'X' })
    const res = await request(appWith(db)).put('/rails/0/name').send({ name: null })
    expect(res.status).toBe(200)
    expect(getRail(db, 0).name).toBeNull()
  })

  it('rejects a body without name', async () => {
    const res = await request(appWith(db)).put('/rails/0/name').send({})
    expect(res.status).toBe(400)
  })

  it('rejects a non-string, non-null name', async () => {
    const res = await request(appWith(db)).put('/rails/0/name').send({ name: 42 })
    expect(res.status).toBe(400)
  })

  it('rejects an over-long name', async () => {
    const res = await request(appWith(db)).put('/rails/0/name').send({ name: 'x'.repeat(61) })
    expect(res.status).toBe(400)
  })

  it('rejects an invalid rail index', async () => {
    const res = await request(appWith(db)).put('/rails/-1/name').send({ name: 'X' })
    expect(res.status).toBe(400)
  })
})

describe('rails-router rail.updated broadcasts', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  type RailUpdated = { type: string; railIndex: number; changed: string; ticketIds: number[]; name: string | null; aiEngine: string | null }
  const lastRailUpdated = (calls: unknown[][]): RailUpdated | undefined =>
    [...calls].reverse().map((c) => c[0] as RailUpdated).find((m) => m?.type === 'rail.updated')

  it('broadcasts changed:tickets with the new ticketIds on a tickets PUT', async () => {
    const broadcast = vi.fn()
    const res = await request(appWith(db, { broadcast })).put('/rails/0/tickets').send({ ticketIds: [1, 2] })
    expect(res.status).toBe(200)
    const msg = lastRailUpdated(broadcast.mock.calls)
    expect(msg).toBeDefined()
    expect(msg!.changed).toBe('tickets')
    expect(msg!.railIndex).toBe(0)
    expect(msg!.ticketIds).toEqual([1, 2])
  })

  it('broadcasts changed:name and carries the current ticketIds (so receivers do not drop them)', async () => {
    setRailTickets(db, 1, [7, 8])
    const broadcast = vi.fn()
    const res = await request(appWith(db, { broadcast })).put('/rails/1/name').send({ name: 'Bugfixes' })
    expect(res.status).toBe(200)
    const msg = lastRailUpdated(broadcast.mock.calls)
    expect(msg!.changed).toBe('name')
    expect(msg!.name).toBe('Bugfixes')
    // The snapshot still carries the rail's tickets — critical so a rename never
    // looks like an empty-rail update to the desktop merge.
    expect(msg!.ticketIds).toEqual([7, 8])
  })

  it('a tickets-change broadcast preserves the previously-set name', async () => {
    await request(appWith(db)).put('/rails/2/name').send({ name: 'Named' })
    const broadcast = vi.fn()
    await request(appWith(db, { broadcast })).put('/rails/2/tickets').send({ ticketIds: [3] })
    const msg = lastRailUpdated(broadcast.mock.calls)
    expect(msg!.changed).toBe('tickets')
    expect(msg!.name).toBe('Named')
  })

  it('broadcasts changed:engine on an engine PUT', async () => {
    setRailTickets(db, 0, [1])
    const broadcast = vi.fn()
    await request(appWith(db, { providers: ['claude', 'codex'], broadcast }))
      .put('/rails/0/engine').send({ aiEngine: 'codex' })
    const msg = lastRailUpdated(broadcast.mock.calls)
    expect(msg!.changed).toBe('engine')
    expect(msg!.aiEngine ?? null).toBe('codex')
  })
})

describe('rails-router PUT /:railIndex/engine', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  it('sets the AI engine for a rail', async () => {
    setRailTickets(db, 0, [1])
    const res = await request(appWith(db, { providers: ['claude', 'codex'] }))
      .put('/rails/0/engine').send({ aiEngine: 'codex' })
    expect(res.status).toBe(200)
    expect(getRail(db, 0).aiEngine).toBe('codex')
  })

  it('clears the engine when aiEngine is null', async () => {
    setRailTickets(db, 0, [1], 'implement', null, 'codex')
    const res = await request(appWith(db, { providers: ['claude', 'codex'] }))
      .put('/rails/0/engine').send({ aiEngine: null })
    expect(res.status).toBe(200)
    expect(getRail(db, 0).aiEngine).toBeNull()
  })

  it('rejects an engine not installed for the project', async () => {
    setRailTickets(db, 0, [1])
    const res = await request(appWith(db, { providers: ['claude'] }))
      .put('/rails/0/engine').send({ aiEngine: 'codex' })
    expect(res.status).toBe(400)
  })

  it('rejects a body without aiEngine', async () => {
    const res = await request(appWith(db, { providers: ['claude', 'codex'] }))
      .put('/rails/0/engine').send({})
    expect(res.status).toBe(400)
  })

  it('rejects an invalid rail index', async () => {
    const res = await request(appWith(db)).put('/rails/-1/engine').send({ aiEngine: 'claude' })
    expect(res.status).toBe(400)
  })
})

describe('rails-router POST /:railIndex/launch with aiEngine', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  it('passes the explicit aiEngine through to enqueue as provider', async () => {
    setRailTickets(db, 0, [1, 2])
    const enqueue = vi.fn().mockReturnValue({ id: 'job-1', queuePosition: 0 })
    const res = await request(appWith(db, { providers: ['claude', 'codex'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'implement', aiEngine: 'codex' })
    expect(res.status).toBe(202)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const opts = enqueue.mock.calls[0][2] as { provider?: string; profileName?: unknown }
    expect(opts.provider).toBe('codex')
    // Codex has no profiles → forced legacy (null) profile.
    expect(opts.profileName).toBeNull()
  })

  it('falls back to the stored rail engine when the body omits aiEngine', async () => {
    setRailTickets(db, 1, [3], 'implement', null, 'codex')
    const enqueue = vi.fn().mockReturnValue({ id: 'job-2', queuePosition: 0 })
    const res = await request(appWith(db, { providers: ['claude', 'codex'], queueManager: { enqueue } }))
      .post('/rails/1/launch').send({ mode: 'implement' })
    expect(res.status).toBe(202)
    expect((enqueue.mock.calls[0][2] as { provider?: string }).provider).toBe('codex')
  })

  it('rejects an aiEngine not installed for the project', async () => {
    setRailTickets(db, 0, [1])
    const enqueue = vi.fn()
    const res = await request(appWith(db, { providers: ['claude'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'implement', aiEngine: 'codex' })
    expect(res.status).toBe(400)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('omits provider (legacy path) when no engine is requested or stored', async () => {
    setRailTickets(db, 0, [1])
    const enqueue = vi.fn().mockReturnValue({ id: 'job-3', queuePosition: 0 })
    const res = await request(appWith(db, { providers: ['claude'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'implement' })
    expect(res.status).toBe(202)
    expect((enqueue.mock.calls[0][2] as { provider?: string }).provider).toBeUndefined()
  })
})

describe('rails-router POST /:railIndex/launch ultracode mode', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  it('enqueues one claude job per ticket with an ultracode command and no profile', async () => {
    setRailTickets(db, 0, [5, 7])
    let n = 0
    const enqueue = vi.fn().mockImplementation(() => ({ id: `job-${++n}`, queuePosition: 0 }))
    const railJobs = new Map<string, unknown>()
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { projectCtx: unknown }).projectCtx = {
        db, railJobs,
        project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude'] },
        queueManager: { enqueue },
        broadcast: () => {},
      }
      next()
    })
    app.use('/rails', createRailsRouter())

    const res = await request(app).post('/rails/0/launch').send({ mode: 'ultracode' })
    expect(res.status).toBe(202)
    expect(res.body.jobIds).toEqual(['job-1', 'job-2'])
    expect(res.body.jobId).toBe('job-1')
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue.mock.calls[0][0]).toBe('/specrails:ultracode #5 --yes')
    expect(enqueue.mock.calls[1][0]).toBe('/specrails:ultracode #7 --yes')
    const opts = enqueue.mock.calls[0][2] as { provider?: string; profileName?: unknown }
    expect(opts.provider).toBe('claude')
    expect(opts.profileName).toBeNull()
    // Each job registered against the rail with its single ticket.
    expect(railJobs.size).toBe(2)
  })

  it('rejects ultracode when the effective engine is not claude', async () => {
    setRailTickets(db, 0, [1], 'implement', null, 'codex')
    const enqueue = vi.fn()
    const res = await request(appWith(db, { providers: ['claude', 'codex'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'ultracode', aiEngine: 'codex' })
    expect(res.status).toBe(400)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('rejects an unknown mode', async () => {
    setRailTickets(db, 0, [1])
    const res = await request(appWith(db, { queueManager: { enqueue: vi.fn() } }))
      .post('/rails/0/launch').send({ mode: 'bogus' })
    expect(res.status).toBe(400)
  })

  it('passes a valid ultracode model through to enqueue', async () => {
    setRailTickets(db, 0, [1])
    const enqueue = vi.fn().mockReturnValue({ id: 'job-1', queuePosition: 0 })
    const res = await request(appWith(db, { providers: ['claude'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'ultracode', model: 'opus' })
    expect(res.status).toBe(202)
    expect((enqueue.mock.calls[0][2] as { model?: string }).model).toBe('opus')
  })

  it('rejects an invalid ultracode model', async () => {
    setRailTickets(db, 0, [1])
    const enqueue = vi.fn()
    const res = await request(appWith(db, { providers: ['claude'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'ultracode', model: 'gpt-5' })
    expect(res.status).toBe(400)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('omits model from enqueue when none is provided', async () => {
    setRailTickets(db, 0, [1])
    const enqueue = vi.fn().mockReturnValue({ id: 'job-1', queuePosition: 0 })
    const res = await request(appWith(db, { providers: ['claude'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'ultracode' })
    expect(res.status).toBe(202)
    expect((enqueue.mock.calls[0][2] as { model?: string }).model).toBeUndefined()
  })
})

describe('rails-router POST /:railIndex/stop (M19)', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  function appWithRailJobs(railJobs: Map<string, unknown>, cancel: ReturnType<typeof vi.fn>) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { projectCtx: unknown }).projectCtx = {
        db, railJobs,
        project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude'] },
        queueManager: { cancel },
        broadcast: () => {},
      }
      next()
    })
    app.use('/rails', createRailsRouter())
    return app
  }

  it('cancels ALL jobs of the rail, not just the first', async () => {
    // Ultracode rail registered 3 jobs under railIndex 0 (+ one for another rail).
    const railJobs = new Map<string, unknown>([
      ['job-a', { railIndex: 0, mode: 'ultracode', ticketIds: [1] }],
      ['job-b', { railIndex: 0, mode: 'ultracode', ticketIds: [2] }],
      ['job-c', { railIndex: 0, mode: 'ultracode', ticketIds: [3] }],
      ['other', { railIndex: 1, mode: 'ultracode', ticketIds: [9] }],
    ])
    const cancel = vi.fn().mockReturnValue('canceled')

    const res = await request(appWithRailJobs(railJobs, cancel)).post('/rails/0/stop').send({})

    expect(res.status).toBe(200)
    expect(cancel).toHaveBeenCalledTimes(3)
    expect(res.body.jobIds).toEqual(['job-a', 'job-b', 'job-c'])
    // All rail-0 entries removed; the other rail's entry is untouched.
    expect(railJobs.has('job-a')).toBe(false)
    expect(railJobs.has('job-b')).toBe(false)
    expect(railJobs.has('job-c')).toBe(false)
    expect(railJobs.has('other')).toBe(true)
  })

  it('still clears stale entries when cancel throws (unrecoverable-rail fix)', async () => {
    const railJobs = new Map<string, unknown>([
      ['stale', { railIndex: 0, mode: 'ultracode', ticketIds: [1] }],
    ])
    const cancel = vi.fn().mockImplementation(() => { throw new Error('already terminal') })

    const res = await request(appWithRailJobs(railJobs, cancel)).post('/rails/0/stop').send({})

    expect(res.status).toBe(200)
    expect(railJobs.has('stale')).toBe(false) // cleaned up despite the throw
  })

  it('404s when the rail has no jobs', async () => {
    const res = await request(appWithRailJobs(new Map(), vi.fn())).post('/rails/0/stop').send({})
    expect(res.status).toBe(404)
  })
})

describe('rails-router POST /:railIndex/launch interactive (ultracode)', () => {
  let db: DbInstance
  const saved = process.env.SPECRAILS_INTERACTIVE_JOBS
  beforeEach(() => {
    db = initDb(':memory:')
    setRailTickets(db, 0, [1], 'ultracode')
    delete process.env.SPECRAILS_INTERACTIVE_JOBS
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.SPECRAILS_INTERACTIVE_JOBS
    else process.env.SPECRAILS_INTERACTIVE_JOBS = saved
  })

  function launch(body: Record<string, unknown>, enqueue = vi.fn(() => ({ id: 'j1', queuePosition: 0 }))) {
    const app = appWith(db, { queueManager: { enqueue } })
    return { app, enqueue }
  }

  it('threads interactive:true into the ultracode enqueue', async () => {
    const { app, enqueue } = launch({})
    const res = await request(app).post('/rails/0/launch').send({ mode: 'ultracode', interactive: true })
    expect(res.status).toBe(202)
    const opts = enqueue.mock.calls[0]?.[2] as Record<string, unknown>
    expect(opts.interactive).toBe(true)
    expect(opts.provider).toBe('claude')
  })

  it('rejects interactive on a non-ultracode mode (400)', async () => {
    const { app, enqueue } = launch({})
    const res = await request(app).post('/rails/0/launch').send({ mode: 'implement', interactive: true })
    expect(res.status).toBe(400)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('rejects interactive when the feature flag is off (403)', async () => {
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    const { app, enqueue } = launch({})
    const res = await request(app).post('/rails/0/launch').send({ mode: 'ultracode', interactive: true })
    expect(res.status).toBe(403)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('omits interactive when not requested (back-compat)', async () => {
    const { app, enqueue } = launch({})
    const res = await request(app).post('/rails/0/launch').send({ mode: 'ultracode' })
    expect(res.status).toBe(202)
    const opts = enqueue.mock.calls[0]?.[2] as Record<string, unknown>
    expect(opts.interactive).toBeUndefined()
  })
})
