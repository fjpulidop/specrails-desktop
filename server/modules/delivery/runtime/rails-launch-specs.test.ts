// POST /rails/launch-specs: assign + launch in one call (MCP v2 runs(launch)).
// Runs the legacy queue path (loops off) so the launch door itself is real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createRailsRouter } from './rails-router'
import { createRail, getRail, getRails, railExists, setRailTickets } from './rails-store'
import { openProjectProcessAdmission } from '../../../process-admission'

vi.mock('../../agent-runtime/runtime/agent-runtime-loader', () => ({ loadCoreAgentRuntime: async () => ({ api: { capabilities: {} } }) }))

let db: DbInstance
let desktopDb: DbInstance
let projectPath: string
let savedLoops: string | undefined

beforeEach(() => {
  savedLoops = process.env.SPECRAILS_LOOPS_SECTION
  process.env.SPECRAILS_LOOPS_SECTION = 'false'
  db = initDb(':memory:')
  desktopDb = initDesktopDb(':memory:')
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-launch-specs-'))
})
afterEach(() => {
  openProjectProcessAdmission('p1')
  vi.restoreAllMocks()
  db.close(); desktopDb.close()
  fs.rmSync(projectPath, { recursive: true, force: true })
  if (savedLoops === undefined) delete process.env.SPECRAILS_LOOPS_SECTION
  else process.env.SPECRAILS_LOOPS_SECTION = savedLoops
})

function appWith(opts: { enqueue?: (...args: unknown[]) => unknown; railJobs?: Map<string, { railIndex: number; mode: string; ticketIds: number[] }>; broadcast?: (msg: unknown) => void } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { projectCtx: unknown }).projectCtx = {
      db, desktopDb,
      railJobs: opts.railJobs ?? new Map(),
      railLoopRuns: new Map(),
      project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude'], path: projectPath },
      queueManager: { enqueue: opts.enqueue ?? vi.fn(() => ({ id: 'job-1' })) },
      broadcast: opts.broadcast ?? (() => {}),
      loopRunManager: { run: vi.fn(), cancel: vi.fn() },
      getTicketSpec: (id: number) => ({ title: `Spec ${id}`, description: 'D' }),
      onLoopRunFinished: () => {},
      jiraSyncManager: { onRailLaunch: () => {} },
    }
    next()
  })
  app.use('/rails', createRailsRouter())
  return app
}

describe('POST /rails/launch-specs', () => {
  it('assigns the specs to the first idle empty rail and launches it', async () => {
    setRailTickets(db, 0, [9], 'implement')
    const enqueue = vi.fn(() => ({ id: 'job-1' }))
    const res = await request(appWith({ enqueue })).post('/rails/launch-specs').send({ specIds: [1, 2] })
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect(res.body).toMatchObject({ jobId: 'job-1', railIndex: 1, mode: 'implement' })
    expect(getRail(db, 1).ticketIds).toEqual([1, 2])
    expect(getRail(db, 0).ticketIds).toEqual([9])
    expect(enqueue).toHaveBeenCalledWith('/specrails:implement #1 #2 --yes', 'normal', expect.anything())
  })

  it('reuses an idle rail holding exactly these specs and moves a spec off other idle rails', async () => {
    setRailTickets(db, 0, [5, 1], 'implement')
    setRailTickets(db, 2, [1], 'implement')
    const res = await request(appWith()).post('/rails/launch-specs').send({ specIds: [1] })
    expect(res.status).toBe(202)
    expect(res.body.railIndex).toBe(2)
    expect(getRail(db, 0).ticketIds).toEqual([5])
  })

  it('creates a rail when every rail holds other specs, and removes it again when the launch is refused', async () => {
    for (const index of [0, 1, 2]) setRailTickets(db, index, [10 + index], 'implement')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = getRails(db).length
    const refused = await request(appWith({ enqueue: vi.fn(() => { throw new Error('boom') }) })).post('/rails/launch-specs').send({ specIds: [7] })
    expect(refused.status).toBe(500)
    expect(refused.body).toMatchObject({ error: 'Failed to launch rail job', railIndex: 3, railCreated: true })
    expect(railExists(db, 3)).toBe(false)
    expect(getRails(db).length).toBe(before)

    const ok = await request(appWith()).post('/rails/launch-specs').send({ specIds: [7], railName: '  Checkout  ' })
    expect(ok.status).toBe(202)
    expect(ok.body).toMatchObject({ railIndex: 3, railCreated: true })
    // A new rail takes the proposal's name (mission rail-launch cards).
    expect(getRail(db, 3).name).toBe('Checkout')
  })

  it('restores every touched rail when the launch is refused', async () => {
    setRailTickets(db, 0, [5, 1], 'implement')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await request(appWith({ enqueue: vi.fn(() => { throw new Error('boom') }) })).post('/rails/launch-specs').send({ specIds: [1], railIndex: 1 })
    expect(res.status).toBe(500)
    expect(getRail(db, 0).ticketIds).toEqual([5, 1])
    expect(getRail(db, 1).ticketIds).toEqual([])
  })

  it('refuses bad spec ids, an unknown rail and a busy rail without touching anything', async () => {
    setRailTickets(db, 0, [5], 'implement')
    expect((await request(appWith()).post('/rails/launch-specs').send({ specIds: [] })).body.error).toBe('invalid_spec_ids')
    expect((await request(appWith()).post('/rails/launch-specs').send({ specIds: [1.5] })).status).toBe(400)
    expect((await request(appWith()).post('/rails/launch-specs').send({ specIds: [1], railIndex: 11 })).status).toBe(404)
    const busy = await request(appWith({ railJobs: new Map([['j0', { railIndex: 0, mode: 'implement', ticketIds: [5] }]]) })).post('/rails/launch-specs').send({ specIds: [1], railIndex: 0 })
    expect(busy.status).toBe(409)
    expect(busy.body.error).toBe('rail_busy')
    expect(getRail(db, 0).ticketIds).toEqual([5])
  })

  it('refuses when no rail is free and the rail limit is reached', async () => {
    for (let index = 0; index < 12; index++) { if (!railExists(db, index)) createRail(db, null); setRailTickets(db, index, [100 + index], 'implement') }
    const res = await request(appWith()).post('/rails/launch-specs').send({ specIds: [1] })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('no_free_rail')
  })
})
