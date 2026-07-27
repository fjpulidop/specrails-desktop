import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from './db'
import { initDesktopDb } from './desktop-db'
import { createRailsRouter } from './rails-router'
import { PrContinuationIsolationError } from './rail-isolated-launch'
import { getRail, setRailTickets } from './rails-store'
import { createLoop, publishLoop } from './loops-store'
import { createLoopRun } from './loop-runs-store'
import { createPrDelivery, getActivePrDeliveryByRail, getPrDelivery, transitionDecision, type CreatePrDeliveryInput } from './rail-pr-store'
import type { LoopGraph } from './loop-graph'
import { beginProjectProcessQuiescence, openProjectProcessAdmission } from './process-admission'
import { ExplicitPrTargetError } from './active-pr-continuation'
import { withRepoLock } from './repo-lock'

const {
  mockExecRun,
  mockRepoStatus,
  mockLaunchIsolated,
  mockCommitWorktreeAndVerify,
  mockGetProjectGitInfo,
  mockInspectProjectCheckoutCleanliness,
  mockCheckoutProjectReviewBranch,
  mockReleaseRailWorktrees,
} = vi.hoisted(() => ({
  mockExecRun: vi.fn(),
  mockRepoStatus: vi.fn(),
  mockLaunchIsolated: vi.fn(),
  mockCommitWorktreeAndVerify: vi.fn(),
  mockGetProjectGitInfo: vi.fn(),
  mockInspectProjectCheckoutCleanliness: vi.fn(),
  mockCheckoutProjectReviewBranch: vi.fn(),
  mockReleaseRailWorktrees: vi.fn(),
}))
vi.mock('./pr-publisher', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  defaultExec: { run: mockExecRun },
}))
// Replace ONLY the git-repo probe + the isolated-launch entry point so the
// isolation branch is drivable without a real repository. The default probe
// result ('no-git', set in the top-level beforeEach) mirrors what the real
// probe returns for the fixture '/repo' path, so every pre-existing suite
// keeps exercising the shared-cwd fallback unchanged.
vi.mock('./worktree-manager', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  repoIsolationStatus: mockRepoStatus,
  commitWorktreeAndVerify: mockCommitWorktreeAndVerify,
}))
vi.mock('./rail-isolated-launch', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  launchIsolatedRail: mockLaunchIsolated,
}))
vi.mock('./project-git', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  getProjectGitInfo: mockGetProjectGitInfo,
  inspectProjectCheckoutCleanliness: mockInspectProjectCheckoutCleanliness,
  checkoutProjectReviewBranch: mockCheckoutProjectReviewBranch,
}))
vi.mock('./rail-worktree-release', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  releaseRailWorktrees: mockReleaseRailWorktrees,
}))

beforeEach(() => {
  mockRepoStatus.mockReset().mockResolvedValue('no-git')
  mockLaunchIsolated.mockReset()
  mockCommitWorktreeAndVerify.mockReset().mockResolvedValue({ staged: true, committed: true, clean: true, dirty: [] })
  mockGetProjectGitInfo.mockReset().mockResolvedValue({
    git: true,
    branch: 'main',
    detached: false,
    dirty: false,
    branches: ['main', 'feat/review'],
    lastCommit: null,
    worktrees: [],
  })
  mockInspectProjectCheckoutCleanliness.mockReset().mockResolvedValue({ ok: true, clean: true })
  mockCheckoutProjectReviewBranch.mockReset().mockResolvedValue({ ok: true })
  mockReleaseRailWorktrees.mockReset().mockResolvedValue([])
})

function appWith(
  db: DbInstance,
  opts?: {
    providers?: ('claude' | 'codex' | 'gemini' | 'kimi')[]
    queueManager?: { enqueue: (...args: unknown[]) => unknown }
    broadcast?: (msg: unknown) => void
    desktopDb?: DbInstance
    loopRunManager?: { run: (...args: unknown[]) => Promise<unknown>; cancel: (id: string) => void }
    railLoopRuns?: Map<string, { railIndex: number; ticketIds: number[] }>
    getTicketSpec?: (ticketId: number) => { title: string; description: string } | undefined
    onLoopRunFinished?: (runId: string, outcome: string) => void
  },
) {
  const providers = opts?.providers ?? ['claude']
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    // Minimal ProjectContext stand-in; the routes under test only touch db
    // (+ queueManager/broadcast for launch, + loop fields for loop mode).
    ;(req as unknown as { projectCtx: unknown }).projectCtx = {
      db,
      railJobs: new Map(),
      railLoopRuns: opts?.railLoopRuns ?? new Map(),
      project: { id: 'p1', slug: 's1', provider: providers[0], providers, path: '/repo' },
      queueManager: opts?.queueManager,
      broadcast: opts?.broadcast ?? (() => { /* noop */ }),
      desktopDb: opts?.desktopDb,
      loopRunManager: opts?.loopRunManager,
      getTicketSpec: opts?.getTicketSpec ?? (() => undefined),
      onLoopRunFinished: opts?.onLoopRunFinished ?? (() => { /* noop */ }),
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

// Loops are pinned OFF here: with Loops enabled (the default) a bare-mode launch
// now derives its factory loop and routes through the loop engine (see the
// "bare mode derives its factory loop" suite) — these tests keep guarding the
// loops-off legacy QueueManager path, where the engine plumbing must survive.
describe('rails-router POST /:railIndex/launch with aiEngine (loops off — legacy QueueManager path)', () => {
  let db: DbInstance
  const savedLoops = process.env.SPECRAILS_LOOPS_SECTION
  beforeEach(() => {
    db = initDb(':memory:')
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
  })
  afterEach(() => {
    db.close()
    if (savedLoops === undefined) delete process.env.SPECRAILS_LOOPS_SECTION
    else process.env.SPECRAILS_LOOPS_SECTION = savedLoops
  })

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

// Loops pinned OFF (same reason as the aiEngine suite above): bare freestyle with
// loops on derives factory:freestyle and runs through the loop engine instead.
describe('rails-router POST /:railIndex/launch freestyle mode (loops off — QueueManager fallback path)', () => {
  let db: DbInstance
  const savedLoops = process.env.SPECRAILS_LOOPS_SECTION
  beforeEach(() => {
    db = initDb(':memory:')
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
  })
  afterEach(() => {
    db.close()
    if (savedLoops === undefined) delete process.env.SPECRAILS_LOOPS_SECTION
    else process.env.SPECRAILS_LOOPS_SECTION = savedLoops
  })

  it('enqueues one claude job per ticket with an freestyle command and no profile', async () => {
    setRailTickets(db, 0, [5, 7])
    let n = 0
    const enqueue = vi.fn().mockImplementation(() => ({ id: `job-${++n}`, queuePosition: 0 }))
    const railJobs = new Map<string, unknown>()
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { projectCtx: unknown }).projectCtx = {
        db, railJobs, railLoopRuns: new Map(),
        project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude'], path: '/repo' },
        queueManager: { enqueue },
        broadcast: () => {},
      }
      next()
    })
    app.use('/rails', createRailsRouter())

    const res = await request(app).post('/rails/0/launch').send({ mode: 'freestyle' })
    expect(res.status).toBe(202)
    expect(res.body.jobIds).toEqual(['job-1', 'job-2'])
    expect(res.body.jobId).toBe('job-1')
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue.mock.calls[0][0]).toBe('/specrails:freestyle #5 --yes')
    expect(enqueue.mock.calls[1][0]).toBe('/specrails:freestyle #7 --yes')
    const opts = enqueue.mock.calls[0][2] as { provider?: string; profileName?: unknown }
    expect(opts.provider).toBe('claude')
    expect(opts.profileName).toBeNull()
    // Each job registered against the rail with its single ticket.
    expect(railJobs.size).toBe(2)
  })

  it('rejects freestyle when the effective engine is not claude', async () => {
    setRailTickets(db, 0, [1], 'implement', null, 'codex')
    const enqueue = vi.fn()
    const res = await request(appWith(db, { providers: ['claude', 'codex'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'freestyle', aiEngine: 'codex' })
    expect(res.status).toBe(400)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('rejects an unknown mode', async () => {
    setRailTickets(db, 0, [1])
    const res = await request(appWith(db, { queueManager: { enqueue: vi.fn() } }))
      .post('/rails/0/launch').send({ mode: 'bogus' })
    expect(res.status).toBe(400)
  })

  it('passes a valid freestyle model through to enqueue', async () => {
    setRailTickets(db, 0, [1])
    const enqueue = vi.fn().mockReturnValue({ id: 'job-1', queuePosition: 0 })
    const res = await request(appWith(db, { providers: ['claude'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'freestyle', model: 'opus' })
    expect(res.status).toBe(202)
    expect((enqueue.mock.calls[0][2] as { model?: string }).model).toBe('opus')
  })

  it('preserves an exact custom Kimi alias for freestyle without forwarding effort', async () => {
    setRailTickets(db, 0, [1])
    const customAlias = 'moonshot-team/private-coder:v2'
    const enqueue = vi.fn().mockReturnValue({ id: 'job-1', queuePosition: 0 })
    const res = await request(appWith(db, { providers: ['kimi'], queueManager: { enqueue } }))
      .post('/rails/0/launch')
      .send({ mode: 'freestyle', model: customAlias })

    expect(res.status).toBe(202)
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0][2]).toMatchObject({
      provider: 'kimi',
      model: customAlias,
    })
    expect(enqueue.mock.calls[0][2]).not.toHaveProperty('effort')
  })

  it('rejects an unsafe flag-like Kimi alias for freestyle', async () => {
    setRailTickets(db, 0, [1])
    const enqueue = vi.fn()
    const res = await request(appWith(db, { providers: ['kimi'], queueManager: { enqueue } }))
      .post('/rails/0/launch')
      .send({ mode: 'freestyle', model: '--yolo' })

    expect(res.status).toBe(400)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('rejects an invalid freestyle model', async () => {
    setRailTickets(db, 0, [1])
    const enqueue = vi.fn()
    const res = await request(appWith(db, { providers: ['claude'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'freestyle', model: 'gpt-5' })
    expect(res.status).toBe(400)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('omits model from enqueue when none is provided', async () => {
    setRailTickets(db, 0, [1])
    const enqueue = vi.fn().mockReturnValue({ id: 'job-1', queuePosition: 0 })
    const res = await request(appWith(db, { providers: ['claude'], queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'freestyle' })
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
        db, railJobs, railLoopRuns: new Map(),
        project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude'], path: '/repo' },
        queueManager: { cancel },
        broadcast: () => {},
      }
      next()
    })
    app.use('/rails', createRailsRouter())
    return app
  }

  it('cancels ALL jobs of the rail, not just the first', async () => {
    // Freestyle rail registered 3 jobs under railIndex 0 (+ one for another rail).
    const railJobs = new Map<string, unknown>([
      ['job-a', { railIndex: 0, mode: 'freestyle', ticketIds: [1] }],
      ['job-b', { railIndex: 0, mode: 'freestyle', ticketIds: [2] }],
      ['job-c', { railIndex: 0, mode: 'freestyle', ticketIds: [3] }],
      ['other', { railIndex: 1, mode: 'freestyle', ticketIds: [9] }],
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
      ['stale', { railIndex: 0, mode: 'freestyle', ticketIds: [1] }],
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

// Loops pinned OFF: these pin what the LEGACY QueueManager enqueue receives —
// with loops on a bare-mode launch never reaches enqueue (factory-loop derivation).
describe('rails-router POST /:railIndex/launch interactive (freestyle, loops off — QueueManager fallback path)', () => {
  let db: DbInstance
  const saved = process.env.SPECRAILS_INTERACTIVE_JOBS
  const savedLoops = process.env.SPECRAILS_LOOPS_SECTION
  beforeEach(() => {
    db = initDb(':memory:')
    setRailTickets(db, 0, [1], 'freestyle')
    delete process.env.SPECRAILS_INTERACTIVE_JOBS
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.SPECRAILS_INTERACTIVE_JOBS
    else process.env.SPECRAILS_INTERACTIVE_JOBS = saved
    if (savedLoops === undefined) delete process.env.SPECRAILS_LOOPS_SECTION
    else process.env.SPECRAILS_LOOPS_SECTION = savedLoops
  })

  function launch(body: Record<string, unknown>, enqueue = vi.fn(() => ({ id: 'j1', queuePosition: 0 }))) {
    const app = appWith(db, { queueManager: { enqueue } })
    return { app, enqueue }
  }

  it('passes no explicit interactive flag — QueueManager’s spawn-time default covers it', async () => {
    const { app, enqueue } = launch({})
    const res = await request(app).post('/rails/0/launch').send({ mode: 'freestyle' })
    expect(res.status).toBe(202)
    const opts = enqueue.mock.calls[0]?.[2] as Record<string, unknown>
    // The interactive-by-default flip moved the decision to QueueManager's
    // spawn-time gate (kill-switch + persistent-stdin capability) — the launch
    // no longer forwards a flag, so the default also survives a restart.
    expect(opts.interactive).toBeUndefined()
    expect(opts.provider).toBe('claude')
  })

  it('ignores the interactive body param on non-freestyle modes (wire compat)', async () => {
    const { app, enqueue } = launch({})
    const res = await request(app).post('/rails/0/launch').send({ mode: 'implement', interactive: true })
    // No 400 anymore: the param is accepted-and-ignored; the launch proceeds.
    expect(res.status).toBe(202)
    const opts = enqueue.mock.calls[0]?.[2] as Record<string, unknown>
    expect(opts.interactive).toBeUndefined()
  })

  it('omits interactive when the feature flag is off', async () => {
    process.env.SPECRAILS_INTERACTIVE_JOBS = 'false'
    const { app, enqueue } = launch({})
    const res = await request(app).post('/rails/0/launch').send({ mode: 'freestyle', interactive: true })
    expect(res.status).toBe(202)
    const opts = enqueue.mock.calls[0]?.[2] as Record<string, unknown>
    expect(opts.interactive).toBeUndefined()
  })
})

describe('rails-router loop mode', () => {
  let db: DbInstance
  let desktopDb: DbInstance

  function publishableGraph(): LoopGraph {
    return {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        // Spec-driven by default ({{spec.title}}) so it is rail-eligible (a rail
        // feeds the spec). graphWithPrompt() overrides this for scope-specific tests.
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Implement {{spec.title}}' } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 20 },
    }
  }

  beforeEach(() => {
    db = initDb(':memory:')
    desktopDb = initDesktopDb(':memory:')
    setRailTickets(db, 0, [7], 'loop')
  })
  afterEach(() => { db.close(); desktopDb.close() })

  function publishedLoop(): string {
    const loop = createLoop(desktopDb, { id: 'loop-1', name: 'Ship', graph: publishableGraph() })
    publishLoop(desktopDb, loop.id)
    return loop.id
  }

  function graphWithPrompt(prompt: string): LoopGraph {
    const g = publishableGraph()
    const ai = g.nodes.find((n) => n.type === 'ai-step')!
    ai.data = { prompt }
    return g
  }

  it('launches a loop run per ticket and tracks it in railLoopRuns', async () => {
    const loopId = publishedLoop()
    const railLoopRuns = new Map<string, { railIndex: number; ticketIds: number[] }>()
    const run = vi.fn().mockResolvedValue({ runId: 'rid', outcome: 'success', iterations: 1, totalCostUsd: 0 })
    const app = appWith(db, {
      desktopDb,
      railLoopRuns,
      loopRunManager: { run, cancel: vi.fn() },
      getTicketSpec: () => ({ title: 'T', description: 'D' }),
    })
    const res = await request(app).post('/rails/0/launch').send({ mode: 'loop', loopId, reasoning_effort: 'high' })
    expect(res.status).toBe(202)
    expect(res.body.loopRunIds).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
    const runArg = run.mock.calls[0][0] as Record<string, unknown>
    expect(runArg.loopId).toBe(loopId)
    expect(runArg.effort).toBe('high')
    expect((runArg.spec as { title: string }).title).toBe('T')
    expect(railLoopRuns.size).toBe(1)
  })

  it('rejects launching an unpublished loop (400)', async () => {
    createLoop(desktopDb, { id: 'draft-1', name: 'Draft', graph: publishableGraph() }) // not published
    const app = appWith(db, { desktopDb, loopRunManager: { run: vi.fn(), cancel: vi.fn() } })
    const res = await request(app).post('/rails/0/launch').send({ mode: 'loop', loopId: 'draft-1' })
    expect(res.status).toBe(400)
  })

  it('404s when the loop does not exist', async () => {
    const app = appWith(db, { desktopDb, loopRunManager: { run: vi.fn(), cancel: vi.fn() } })
    const res = await request(app).post('/rails/0/launch').send({ mode: 'loop', loopId: 'ghost' })
    expect(res.status).toBe(404)
  })

  it('rejects launching a standalone (spec-less) loop on a rail (400)', async () => {
    // No {{spec.*}} and no ticket command → standalone; belongs on the Loops page Run.
    const loop = createLoop(desktopDb, { id: 'standalone-1', name: 'Lint repo', graph: graphWithPrompt('Lint the whole repo until clean') })
    publishLoop(desktopDb, loop.id)
    const run = vi.fn()
    const app = appWith(db, { desktopDb, loopRunManager: { run, cancel: vi.fn() } })
    const res = await request(app).post('/rails/0/launch').send({ mode: 'loop', loopId: 'standalone-1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/standalone/i)
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects an invalid reasoning_effort (400)', async () => {
    const loopId = publishedLoop()
    const app = appWith(db, { desktopDb, loopRunManager: { run: vi.fn(), cancel: vi.fn() } })
    const res = await request(app).post('/rails/0/launch').send({ mode: 'loop', loopId, reasoning_effort: 'turbo' })
    expect(res.status).toBe(400)
  })

  it('rejects Kimi effort when the selected loop model is not K3', async () => {
    const loopId = publishedLoop()
    const run = vi.fn()
    const app = appWith(db, {
      desktopDb,
      providers: ['kimi'],
      loopRunManager: { run, cancel: vi.fn() },
    })
    const res = await request(app).post('/rails/0/launch').send({
      mode: 'loop',
      loopId,
      model: 'kimi-for-coding',
      reasoning_effort: 'high',
    })
    expect(res.status).toBe(400)
    expect(res.body.allowed).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it('preserves an exact custom Kimi alias for a rail loop and omits effort', async () => {
    const loopId = publishedLoop()
    const customAlias = 'moonshot-team/private-coder:v2'
    const run = vi.fn().mockResolvedValue({
      runId: 'kimi-custom-run',
      outcome: 'success',
      iterations: 1,
      totalCostUsd: null,
    })
    const app = appWith(db, {
      desktopDb,
      providers: ['kimi'],
      loopRunManager: { run, cancel: vi.fn() },
    })
    const res = await request(app).post('/rails/0/launch').send({
      mode: 'loop',
      loopId,
      model: customAlias,
    })

    expect(res.status).toBe(202)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toMatchObject({
      provider: 'kimi',
      model: customAlias,
      effort: undefined,
    })
  })

  it('rejects effort and unsafe flag-like values for a custom Kimi rail-loop alias', async () => {
    const loopId = publishedLoop()
    const customAlias = 'moonshot-team/private-coder:v2'

    const effortRun = vi.fn()
    const withEffort = await request(appWith(db, {
      desktopDb,
      providers: ['kimi'],
      loopRunManager: { run: effortRun, cancel: vi.fn() },
    })).post('/rails/0/launch').send({
      mode: 'loop',
      loopId,
      model: customAlias,
      reasoning_effort: 'max',
    })
    expect(withEffort.status).toBe(400)
    expect(withEffort.body.allowed).toEqual([])
    expect(effortRun).not.toHaveBeenCalled()

    const unsafeRun = vi.fn()
    const unsafe = await request(appWith(db, {
      desktopDb,
      providers: ['kimi'],
      loopRunManager: { run: unsafeRun, cancel: vi.fn() },
    })).post('/rails/0/launch').send({
      mode: 'loop',
      loopId,
      model: '--yolo',
    })
    expect(unsafe.status).toBe(400)
    expect(unsafeRun).not.toHaveBeenCalled()
  })

  it('requires a loopId for loop mode (400)', async () => {
    const app = appWith(db, { desktopDb, loopRunManager: { run: vi.fn(), cancel: vi.fn() } })
    const res = await request(app).post('/rails/0/launch').send({ mode: 'loop' })
    expect(res.status).toBe(400)
  })

  it('the SDD Quick OpenSpec factory loop runs through the loop engine', async () => {
    setRailTickets(db, 0, [1], 'loop')
    const run = vi.fn().mockResolvedValue({ runId: 'r-sdd', outcome: 'success', iterations: 1, totalCostUsd: 0 })
    const app = appWith(db, {
      desktopDb,
      providers: ['claude'],
      loopRunManager: { run, cancel: vi.fn() },
      getTicketSpec: (id: number) => ({ id, title: 'T', description: 'D', metadata: { openspecChangeName: 'quick-change' } }),
    })

    const res = await request(app).post('/rails/0/launch').send({ mode: 'loop', loopId: 'factory:sdd-quick-openspec' })

    expect(res.status).toBe(202)
    expect(res.body.mode).toBe('loop')
    expect(run).toHaveBeenCalledTimes(1)
    const req = run.mock.calls[0][0] as { loopId: string; spec: { ticketIds: number[]; metadata?: { openspecChangeName?: string } } }
    expect(req.loopId).toBe('factory:sdd-quick-openspec')
    expect(req.spec.ticketIds).toEqual([1])
    expect(req.spec.metadata?.openspecChangeName).toBe('quick-change')
  })

  it('a factory loop runs through the loop engine (autonomous fix-loop), deriving its mode', async () => {
    setRailTickets(db, 0, [1, 2], 'loop')
    const enqueue = vi.fn()
    const run = vi.fn().mockResolvedValue({ runId: 'r', outcome: 'success', iterations: 1, totalCostUsd: 0 })
    const app = appWith(db, {
      desktopDb,
      providers: ['claude'],
      queueManager: { enqueue },
      loopRunManager: { run, cancel: vi.fn() },
      getTicketSpec: (id: number) => ({ id, title: 'T', description: 'D' }),
    })
    const res = await request(app).post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(res.status).toBe(202)
    expect(res.body.mode).toBe('implement') // derived for back-compat (rails.mode column)
    expect(run).toHaveBeenCalledTimes(1) // loop engine; implement is all-scope → ONE run
    expect(enqueue).not.toHaveBeenCalled() // NOT the QueueManager path
    expect((run.mock.calls[0][0] as { spec: { ticketIds: number[] } }).spec.ticketIds).toEqual([1, 2])
  })

  it('falls back to the QueueManager mode when Loops are disabled', async () => {
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    setRailTickets(db, 0, [1, 2], 'loop')
    const enqueue = vi.fn().mockReturnValue({ id: 'job-x', queuePosition: 0 })
    const run = vi.fn()
    const app = appWith(db, { desktopDb, providers: ['claude'], queueManager: { enqueue }, loopRunManager: { run, cancel: vi.fn() } })
    const res = await request(app).post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(res.status).toBe(202)
    expect(enqueue).toHaveBeenCalledTimes(1) // legacy QueueManager path
    expect(run).not.toHaveBeenCalled()
    delete process.env.SPECRAILS_LOOPS_SECTION
  })

  it('an all-scope custom loop launches ONE run over all the rail tickets', async () => {
    setRailTickets(db, 0, [3, 4], 'loop')
    const loop = createLoop(desktopDb, { id: 'all-loop', name: 'All', graph: graphWithPrompt('{{cmd:implement}}') })
    publishLoop(desktopDb, loop.id)
    const run = vi.fn().mockResolvedValue({ runId: 'r', outcome: 'success', iterations: 1, totalCostUsd: 0 })
    const app = appWith(db, {
      desktopDb,
      providers: ['claude'],
      loopRunManager: { run, cancel: vi.fn() },
      getTicketSpec: (id: number) => ({ id, title: 'T', description: 'D' }),
    })
    const res = await request(app).post('/rails/0/launch').send({ mode: 'loop', loopId: 'all-loop' })
    expect(res.status).toBe(202)
    expect(res.body.loopRunIds).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect((run.mock.calls[0][0] as { spec: { ticketIds: number[] } }).spec.ticketIds).toEqual([3, 4])
  })

  it('rejects a claude-only loop on a non-claude rail (400)', async () => {
    setRailTickets(db, 0, [5], 'loop')
    const loop = createLoop(desktopDb, { id: 'freestyle-loop', name: 'U', graph: graphWithPrompt('{{cmd:freestyle}}') })
    publishLoop(desktopDb, loop.id)
    const run = vi.fn()
    const app = appWith(db, {
      desktopDb,
      providers: ['claude', 'codex'],
      loopRunManager: { run, cancel: vi.fn() },
      getTicketSpec: () => ({ title: 'T', description: 'D' }),
    })
    const res = await request(app).post('/rails/0/launch').send({ mode: 'loop', loopId: 'freestyle-loop', aiEngine: 'codex' })
    expect(res.status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects an invalid model for a custom loop launch with 400 and the provider allow-list', async () => {
    const loopId = publishedLoop()
    const run = vi.fn()
    const app = appWith(db, { desktopDb, loopRunManager: { run, cancel: vi.fn() } })
    const res = await request(app)
      .post('/rails/0/launch')
      .send({ mode: 'loop', loopId, model: 'not-a-real-model' })
    expect(res.status).toBe(400)
    expect(res.body.allowed).toBeDefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('stop cancels an active loop run and broadcasts loop.run_stopped', async () => {
    const railLoopRuns = new Map([['rid-1', { railIndex: 0, ticketIds: [7] }]])
    const cancel = vi.fn()
    const broadcast = vi.fn()
    const app = appWith(db, { railLoopRuns, loopRunManager: { run: vi.fn(), cancel }, broadcast })
    const res = await request(app).post('/rails/0/stop').send({})
    expect(res.status).toBe(200)
    expect(cancel).toHaveBeenCalledWith('rid-1')
    expect(broadcast.mock.calls.some(([m]) => (m as { type: string }).type === 'loop.run_stopped')).toBe(true)
  })
})

describe('rails-router GET / — activeLoopRuns enrichment (mirror labelling)', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('enriches each active loop run with loop identity + resolved provider/model + iteration', async () => {
    createLoopRun(db, {
      id: 'run-1', projectId: 'p1', loopId: 'factory:implement', loopName: 'Implement',
      railIndex: 2, ticketId: 7, provider: 'codex', model: 'gpt-5.5', iterationLimit: 12,
      startedAt: new Date(1000).toISOString(),
    })
    const railLoopRuns = new Map([['run-1', { railIndex: 2, ticketIds: [7] }]])
    const app = appWith(db, { railLoopRuns })
    const res = await request(app).get('/rails')
    expect(res.status).toBe(200)
    expect(res.body.activeLoopRuns['2']).toMatchObject({
      loopRunId: 'run-1', loopId: 'factory:implement', loopName: 'Implement',
      provider: 'codex', model: 'gpt-5.5', iteration: 0,
    })
  })

  it('falls back to a bare loopRunId when the loop_runs row is missing', async () => {
    const railLoopRuns = new Map([['ghost', { railIndex: 0, ticketIds: [] }]])
    const res = await request(appWith(db, { railLoopRuns })).get('/rails')
    expect(res.body.activeLoopRuns['0']).toEqual({ loopRunId: 'ghost', steps: 0, lines: 0 })
  })

  it('surfaces a DB running run NOT tracked in-memory (survives a server restart)', async () => {
    createLoopRun(db, {
      id: 'run-db', projectId: 'p1', loopId: 'loop-x', loopName: 'X',
      railIndex: 1, ticketId: 5, provider: 'claude', model: 'sonnet', iterationLimit: 10,
      startedAt: new Date(2000).toISOString(),
    })
    // railLoopRuns EMPTY (as right after a server restart) — the run must still
    // appear, sourced from the DB (status='running').
    const res = await request(appWith(db, { railLoopRuns: new Map() })).get('/rails')
    expect(res.body.activeLoopRuns['1']).toMatchObject({ loopRunId: 'run-db', loopId: 'loop-x', steps: 0, lines: 0 })
    expect(res.body.activeLoopRuns['1'].startedAt).toBeTruthy()
  })
})

describe('rails-router POST /:railIndex/launch — ask-first PR delivery (safe-pr-review-flow)', () => {
  let db: DbInstance
  let desktopDb: DbInstance
  const ORIG_PR = process.env.SPECRAILS_RAIL_DELIVER_PR

  beforeEach(() => {
    db = initDb(':memory:')
    desktopDb = initDesktopDb(':memory:')
    setRailTickets(db, 0, [1, 2], 'loop')
    delete process.env.SPECRAILS_RAIL_DELIVER_PR // default-on
  })
  afterEach(() => {
    openProjectProcessAdmission('p1')
    db.close(); desktopDb.close()
    if (ORIG_PR === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
    else process.env.SPECRAILS_RAIL_DELIVER_PR = ORIG_PR
  })

  const mkDelivery = (extra: Partial<CreatePrDeliveryInput> = {}) =>
    createPrDelivery(db, {
      railIndex: 0, loopId: 'factory:implement', railKey: '0-factory:implement',
      ticketIds: [1, 2], baseBranch: 'main', loopName: 'Implement',
      originSurface: 'dashboard', ...extra,
    })

  const launchApp = (opts: Parameters<typeof appWith>[1] = {}) =>
    appWith(db, {
      desktopDb,
      loopRunManager: { run: vi.fn().mockResolvedValue({ runId: 'r', outcome: 'success', iterations: 1, totalCostUsd: 0 }), cancel: vi.fn() },
      getTicketSpec: () => ({ title: 'T', description: 'D' }),
      ...opts,
    })

  it('rejects launch admission while startup recovery still owns the project', async () => {
    beginProjectProcessQuiescence('p1')

    const res = await request(launchApp()).post('/rails/0/launch').send({ loopId: 'factory:implement' })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'project_recovery_in_progress' })
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
    expect(mockRepoStatus).not.toHaveBeenCalled()
  })

  it('409 pr_decision_pending when the slot has an unresolved delivery (before any git probe)', async () => {
    const row = mkDelivery()
    const res = await request(launchApp()).post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'pr_decision_pending', prDeliveryId: row.id })
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
    expect(mockRepoStatus).not.toHaveBeenCalled() // the guard sits before the probe
  })

  it('allows relaunch when the active delivery is a published PR covering the rail tickets', async () => {
    const row = mkDelivery()
    transitionDecision(db, row.id, 'building', 'on_review', {
      branches: [
        { ticketId: 1, branch: 'feat/open-pr', succeeded: true },
        { ticketId: 2, branch: 'feat/open-pr', succeeded: true },
      ],
      worktreeIds: [],
    })
    transitionDecision(db, row.id, 'on_review', 'pr_draft', {
      branch: 'feat/open-pr',
      prUrl: 'https://github.com/o/r/pull/521',
      prNumber: 521,
      prState: 'pr-created',
      deliverySha: 'a'.repeat(40),
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_ready')
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockResolvedValue(['run-cont'])

    const res = await request(launchApp()).post('/rails/0/launch').send({ loopId: 'factory:implement' })

    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ loopRunIds: ['run-cont'], isolated: true })
    expect(mockLaunchIsolated).toHaveBeenCalledTimes(1)
    expect(mockLaunchIsolated).toHaveBeenCalledWith(expect.objectContaining({
      requiredPrContinuation: expect.objectContaining({
        deliveryId: row.id,
        decision: 'pr_ready',
        branch: 'feat/open-pr',
        prUrl: 'https://github.com/o/r/pull/521',
        prNumber: 521,
      }),
    }))
  })

  it('still blocks an active PR delivery that does not cover every ticket on the rail', async () => {
    const row = mkDelivery({ ticketIds: [1] })
    transitionDecision(db, row.id, 'building', 'on_review', {
      branches: [{ ticketId: 1, branch: 'feat/partial-pr', succeeded: true }],
      worktreeIds: [],
    })
    transitionDecision(db, row.id, 'on_review', 'pr_draft', {
      branch: 'feat/partial-pr',
      prUrl: 'https://github.com/o/r/pull/522',
      prNumber: 522,
      prState: 'pr-created',
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_ready')

    const res = await request(launchApp()).post('/rails/0/launch').send({ loopId: 'factory:implement' })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'pr_decision_pending', prDeliveryId: row.id })
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
    expect(mockRepoStatus).not.toHaveBeenCalled()
  })

  it('does not orphan omitted tickets by continuing only a subset of an active PR delivery', async () => {
    const row = mkDelivery({ ticketIds: [1, 2] })
    transitionDecision(db, row.id, 'building', 'on_review', {
      branches: [
        { ticketId: 1, branch: 'feat/shared-pr', succeeded: true },
        { ticketId: 2, branch: 'feat/shared-pr', succeeded: true },
      ],
      worktreeIds: [],
    })
    transitionDecision(db, row.id, 'on_review', 'pr_draft', {
      branch: 'feat/shared-pr', prUrl: 'https://github.com/o/r/pull/523',
      prNumber: 523, prState: 'pr-created',
    })
    setRailTickets(db, 0, [1], 'loop')

    const res = await request(launchApp()).post('/rails/0/launch').send({ loopId: 'factory:implement' })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'pr_decision_pending', prDeliveryId: row.id })
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
    expect(mockRepoStatus).not.toHaveBeenCalled()
  })

  it('a TERMINAL delivery on the slot does not block relaunch', async () => {
    const row = mkDelivery()
    transitionDecision(db, row.id, 'building', 'discarded')
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockResolvedValue(['run-1'])
    const res = await request(launchApp()).post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ loopRunIds: ['run-1'], isolated: true })
  })

  it('threads originSurface/originConversationId into launchIsolatedRail', async () => {
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockResolvedValue(['run-1'])
    const res = await request(launchApp()).post('/rails/0/launch')
      .send({ loopId: 'factory:implement', originSurface: 'agent-chat', originConversationId: 'conv-42' })
    expect(res.status).toBe(202)
    expect(mockLaunchIsolated).toHaveBeenCalledWith(expect.objectContaining({
      railIndex: 0, scope: 'all',
      originSurface: 'agent-chat', originConversationId: 'conv-42',
    }))
  })

  it('defaults origin to dashboard / null when the body omits the fields', async () => {
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockResolvedValue(['run-1'])
    await request(launchApp()).post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(mockLaunchIsolated).toHaveBeenCalledWith(expect.objectContaining({
      originSurface: 'dashboard', originConversationId: null,
    }))
  })

  it("an isolated-launch failure falls back to shared cwd and SURFACES isolationUnavailable:'error' + detail", async () => {
    // The silent-missing-cards trap: launchIsolatedRail throwing means NO
    // rail_pr_deliveries row (no implementation card anywhere). The 202 must
    // carry the reason so the client can toast it instead of failing mute.
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockRejectedValue(new Error('git worktree add failed for feat/x: boom'))
    const res = await request(launchApp()).post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(res.status).toBe(202)
    expect(res.body.isolationUnavailable).toBe('error')
    expect(res.body.isolationUnavailableDetail).toContain('git worktree add failed')
    expect(res.body.isolated).toBeUndefined()
  })

  it('refuses shared-cwd fallback when an existing PR continuation cannot get a verified worktree', async () => {
    const existing = mkDelivery()
    transitionDecision(db, existing.id, 'building', 'on_review', {
      branches: [
        { ticketId: 1, branch: 'feat/open-pr', succeeded: true },
        { ticketId: 2, branch: 'feat/open-pr', succeeded: true },
      ],
      worktreeIds: [],
    })
    transitionDecision(db, existing.id, 'on_review', 'pr_draft', {
      branch: 'feat/open-pr',
      prUrl: 'https://github.com/o/r/pull/521',
      prNumber: 521,
      prState: 'pr-created',
      deliverySha: 'a'.repeat(40),
    })
    transitionDecision(db, existing.id, 'pr_draft', 'pr_ready')
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockRejectedValue(new PrContinuationIsolationError(
      'cannot allocate a verified worktree for PR branch feat/open-pr: already checked out',
    ))
    const run = vi.fn()

    const res = await request(launchApp({
      loopRunManager: { run, cancel: vi.fn() },
    })).post('/rails/0/launch').send({ loopId: 'factory:implement' })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      error: 'pr_continuation_isolation_required',
      detail: expect.stringContaining('already checked out'),
      action: expect.stringContaining('dedicated git worktree'),
    })
    expect(run).not.toHaveBeenCalled()
    expect(mockExecRun).not.toHaveBeenCalled()
    expect(getPrDelivery(db, existing.id)?.decision).toBe('pr_ready')
  })

  it('refuses an existing PR continuation before launch when the repo cannot isolate it', async () => {
    const existing = mkDelivery()
    transitionDecision(db, existing.id, 'building', 'on_review', {
      branches: [{ ticketId: 1, branch: 'feat/open-pr', succeeded: true }, { ticketId: 2, branch: 'feat/open-pr', succeeded: true }],
      worktreeIds: [],
    })
    transitionDecision(db, existing.id, 'on_review', 'pr_draft', {
      branch: 'feat/open-pr', prUrl: 'https://github.com/o/r/pull/521', prNumber: 521, prState: 'pr-created',
      deliverySha: 'a'.repeat(40),
    })
    transitionDecision(db, existing.id, 'pr_draft', 'pr_ready')
    mockRepoStatus.mockResolvedValue('no-commits')
    const run = vi.fn()

    const res = await request(launchApp({ loopRunManager: { run, cancel: vi.fn() } }))
      .post('/rails/0/launch').send({ loopId: 'factory:implement' })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      error: 'pr_continuation_isolation_required',
      detail: expect.stringContaining('no-commits'),
    })
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('does not bypass the continuation guard when the worktree kill-switch is off', async () => {
    const existing = mkDelivery()
    transitionDecision(db, existing.id, 'building', 'on_review', {
      branches: [{ ticketId: 1, branch: 'feat/open-pr', succeeded: true }, { ticketId: 2, branch: 'feat/open-pr', succeeded: true }],
      worktreeIds: [],
    })
    transitionDecision(db, existing.id, 'on_review', 'pr_draft', {
      branch: 'feat/open-pr', prUrl: 'https://github.com/o/r/pull/521', prNumber: 521, prState: 'pr-created',
      deliverySha: 'a'.repeat(40),
    })
    transitionDecision(db, existing.id, 'pr_draft', 'pr_ready')
    const saved = process.env.SPECRAILS_RAIL_WORKTREES
    process.env.SPECRAILS_RAIL_WORKTREES = '0'
    try {
      const run = vi.fn()
      const res = await request(launchApp({ loopRunManager: { run, cancel: vi.fn() } }))
        .post('/rails/0/launch').send({ loopId: 'factory:implement' })

      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({
        error: 'pr_continuation_isolation_required',
        detail: expect.stringContaining('isolation is disabled'),
      })
      expect(mockRepoStatus).not.toHaveBeenCalled()
      expect(mockLaunchIsolated).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
    } finally {
      if (saved === undefined) delete process.env.SPECRAILS_RAIL_WORKTREES
      else process.env.SPECRAILS_RAIL_WORKTREES = saved
    }
  })

  it('400 on a malformed originConversationId (charset / length / type / empty)', async () => {
    for (const bad of ['not valid!', 'x'.repeat(65), 42, '']) {
      const res = await request(launchApp()).post('/rails/0/launch')
        .send({ loopId: 'factory:implement', originConversationId: bad })
      expect(res.status).toBe(400)
    }
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })

  it('400 on an unknown originSurface', async () => {
    const res = await request(launchApp()).post('/rails/0/launch')
      .send({ loopId: 'factory:implement', originSurface: 'mobile' })
    expect(res.status).toBe(400)
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })

  it('origin fields are accepted (and ignored) on the loops-off legacy QueueManager path', async () => {
    // Loops pinned off for this one test: with loops on, a bare mode derives its
    // factory loop and never reaches the QueueManager branch under test here.
    const savedLoops = process.env.SPECRAILS_LOOPS_SECTION
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    try {
      const enqueue = vi.fn().mockReturnValue({ id: 'job-1', queuePosition: 0 })
      const res = await request(appWith(db, { queueManager: { enqueue } }))
        .post('/rails/0/launch')
        .send({ mode: 'implement', originSurface: 'agent-chat', originConversationId: 'conv-1' })
      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledTimes(1)
    } finally {
      if (savedLoops === undefined) delete process.env.SPECRAILS_LOOPS_SECTION
      else process.env.SPECRAILS_LOOPS_SECTION = savedLoops
    }
  })

  it('kill-switch off: a pending delivery does NOT block (legacy shared-cwd launch, no isolation)', async () => {
    process.env.SPECRAILS_RAIL_DELIVER_PR = 'off'
    mkDelivery()
    const run = vi.fn().mockResolvedValue({ runId: 'r', outcome: 'success', iterations: 1, totalCostUsd: 0 })
    const res = await request(launchApp({ loopRunManager: { run, cancel: vi.fn() } }))
      .post('/rails/0/launch').send({ loopId: 'factory:implement' })
    expect(res.status).toBe(202)
    expect(run).toHaveBeenCalledTimes(1) // scope=all isolation is off with the flag → shared cwd
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })
})

describe('rails-router POST /:railIndex/launch — explicit target PR (deliver-rail-into-existing-pr)', () => {
  let db: DbInstance
  let desktopDb: DbInstance
  const ORIG_PR = process.env.SPECRAILS_RAIL_DELIVER_PR

  beforeEach(() => {
    db = initDb(':memory:')
    desktopDb = initDesktopDb(':memory:')
    setRailTickets(db, 0, [1, 2], 'loop')
    delete process.env.SPECRAILS_RAIL_DELIVER_PR // default-on
  })
  afterEach(() => {
    db.close(); desktopDb.close()
    if (ORIG_PR === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
    else process.env.SPECRAILS_RAIL_DELIVER_PR = ORIG_PR
  })

  const launchApp = (opts: Parameters<typeof appWith>[1] = {}) =>
    appWith(db, {
      desktopDb,
      loopRunManager: { run: vi.fn().mockResolvedValue({ runId: 'r', outcome: 'success', iterations: 1, totalCostUsd: 0 }), cancel: vi.fn() },
      getTicketSpec: () => ({ title: 'T', description: 'D' }),
      ...opts,
    })

  it.each([
    ['a string', 'abc'],
    ['a float', 1.5],
    ['zero', 0],
    ['negative', -3],
    ['out of bounds', 2_000_000_000],
  ])('400 invalid_target_pr when targetPrNumber is %s', async (_label, value) => {
    const res = await request(launchApp()).post('/rails/0/launch')
      .send({ loopId: 'factory:implement', targetPrNumber: value })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_target_pr')
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })

  it('400 target_pr_requires_pr_mode when PR delivery is switched off', async () => {
    process.env.SPECRAILS_RAIL_DELIVER_PR = '0'
    const res = await request(launchApp()).post('/rails/0/launch')
      .send({ loopId: 'factory:implement', targetPrNumber: 151 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('target_pr_requires_pr_mode')
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })

  it('400 target_pr_requires_pr_mode when worktree isolation is unavailable — never a silent fresh launch', async () => {
    mockRepoStatus.mockResolvedValue('no-git')
    const res = await request(launchApp()).post('/rails/0/launch')
      .send({ loopId: 'factory:implement', targetPrNumber: 151 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('target_pr_requires_pr_mode')
    expect(res.body.detail).toMatch(/no-git/)
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })

  it('threads explicitPrTarget into the isolated launch', async () => {
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockResolvedValue(['run-explicit'])
    const res = await request(launchApp()).post('/rails/0/launch')
      .send({ loopId: 'factory:implement', targetPrNumber: 151 })
    expect(res.status).toBe(202)
    expect(mockLaunchIsolated).toHaveBeenCalledWith(expect.objectContaining({
      explicitPrTarget: { prNumber: 151 },
    }))
  })

  it.each([
    ['target_pr_not_found', 404],
    ['target_pr_not_open', 409],
    ['target_pr_fork', 409],
    ['target_pr_invalid', 409],
    ['target_pr_unfetchable', 409],
  ] as const)('maps ExplicitPrTargetError %s to %d without falling back to shared cwd', async (code, status) => {
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockRejectedValue(new ExplicitPrTargetError(code, `boom: ${code}`))
    const res = await request(launchApp()).post('/rails/0/launch')
      .send({ loopId: 'factory:implement', targetPrNumber: 151 })
    expect(res.status).toBe(status)
    expect(res.body).toEqual({ error: code, detail: `boom: ${code}` })
  })

  it('409 pr_decision_pending when the slot has an undecided delivery for a DIFFERENT PR', async () => {
    const row = createPrDelivery(db, {
      railIndex: 0, loopId: 'factory:implement', railKey: '0-factory:implement',
      ticketIds: [1, 2], baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard',
    })
    transitionDecision(db, row.id, 'building', 'on_review', {
      branches: [
        { ticketId: 1, branch: 'feat/open-pr', succeeded: true },
        { ticketId: 2, branch: 'feat/open-pr', succeeded: true },
      ],
      worktreeIds: [],
    })
    transitionDecision(db, row.id, 'on_review', 'pr_draft', {
      branch: 'feat/open-pr', prUrl: 'https://github.com/o/r/pull/521', prNumber: 521,
      prState: 'pr-created', deliverySha: 'a'.repeat(40),
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_ready')

    const res = await request(launchApp()).post('/rails/0/launch')
      .send({ loopId: 'factory:implement', targetPrNumber: 151 })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'pr_decision_pending', prDeliveryId: row.id })
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })

  it('SAME PR as the continuable delivery proceeds via the continuation contract, not explicitPrTarget', async () => {
    const row = createPrDelivery(db, {
      railIndex: 0, loopId: 'factory:implement', railKey: '0-factory:implement',
      ticketIds: [1, 2], baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard',
    })
    transitionDecision(db, row.id, 'building', 'on_review', {
      branches: [
        { ticketId: 1, branch: 'feat/open-pr', succeeded: true },
        { ticketId: 2, branch: 'feat/open-pr', succeeded: true },
      ],
      worktreeIds: [],
    })
    transitionDecision(db, row.id, 'on_review', 'pr_draft', {
      branch: 'feat/open-pr', prUrl: 'https://github.com/o/r/pull/521', prNumber: 521,
      prState: 'pr-created', deliverySha: 'a'.repeat(40),
    })
    transitionDecision(db, row.id, 'pr_draft', 'pr_ready')
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockResolvedValue(['run-cont'])

    const res = await request(launchApp()).post('/rails/0/launch')
      .send({ loopId: 'factory:implement', targetPrNumber: 521 })
    expect(res.status).toBe(202)
    const call = mockLaunchIsolated.mock.calls[0][0]
    expect(call.requiredPrContinuation).toMatchObject({ prNumber: 521 })
    expect(call.explicitPrTarget).toBeUndefined()
  })
})

describe('rails-router GET /:railIndex/pr-candidates', () => {
  let db: DbInstance
  let desktopDb: DbInstance

  beforeEach(() => {
    db = initDb(':memory:')
    desktopDb = initDesktopDb(':memory:')
    setRailTickets(db, 0, [112], 'loop')
  })
  afterEach(() => { db.close(); desktopDb.close() })

  it('returns matched-first display candidates with fork flags', async () => {
    mockExecRun.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[1] === 'list') {
        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 7, title: 'Other', headRefName: 'feat/x', baseRefName: 'main', url: 'https://github.com/e/r/pull/7', isDraft: false, isCrossRepository: false, state: 'OPEN' },
            { number: 151, title: 'Skills', headRefName: 'feat/skills', baseRefName: 'develop', url: 'https://github.com/e/r/pull/151', isDraft: true, isCrossRepository: false, state: 'OPEN' },
          ]),
          stderr: '',
        }
      }
      return { code: 1, stdout: '', stderr: '' }
    })
    const app = appWith(db, {
      desktopDb,
      getTicketSpec: () => ({ title: 'extend PR #151', description: 'see PR #151', status: 'todo' }),
    })
    const res = await request(app).get('/rails/0/pr-candidates')
    expect(res.status).toBe(200)
    expect(res.body.candidates.map((c: { number: number }) => c.number)).toEqual([151, 7])
  })

  it('400 on an out-of-range rail index', async () => {
    const res = await request(appWith(db, { desktopDb })).get('/rails/99/pr-candidates')
    expect(res.status).toBe(400)
  })
})

// The behavioral fix under test: with Loops enabled (the DEFAULT), a bare legacy
// mode from ANY launch door (MCP tools, mobile, direct REST — no loopId) derives
// its factory loop and routes through the loop engine, so worktree isolation and
// the ask-first PR flow apply identically to the dashboard (which always sends
// factory:<mode>). Pre-fix, an agent-launched bare implement fell into the bare
// QueueManager branch: shared cwd, SPECRAILS_GIT_AUTO=false injected, no
// rail_pr_deliveries row — stranded uncommitted work in the user's repo.
describe('rails-router POST /:railIndex/launch — bare mode derives its factory loop (loops on, default)', () => {
  let db: DbInstance
  let desktopDb: DbInstance
  const savedLoops = process.env.SPECRAILS_LOOPS_SECTION
  const savedPr = process.env.SPECRAILS_RAIL_DELIVER_PR

  beforeEach(() => {
    db = initDb(':memory:')
    desktopDb = initDesktopDb(':memory:')
    delete process.env.SPECRAILS_LOOPS_SECTION   // loops ON (default)
    delete process.env.SPECRAILS_RAIL_DELIVER_PR // PR delivery ON (default)
  })
  afterEach(() => {
    db.close(); desktopDb.close()
    if (savedLoops === undefined) delete process.env.SPECRAILS_LOOPS_SECTION
    else process.env.SPECRAILS_LOOPS_SECTION = savedLoops
    if (savedPr === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
    else process.env.SPECRAILS_RAIL_DELIVER_PR = savedPr
  })

  const loopApp = (enqueue = vi.fn()) =>
    appWith(db, {
      desktopDb,
      queueManager: { enqueue },
      loopRunManager: { run: vi.fn().mockResolvedValue({ runId: 'r', outcome: 'success', iterations: 1, totalCostUsd: 0 }), cancel: vi.fn() },
      getTicketSpec: () => ({ title: 'T', description: 'D' }),
    })

  it('bare implement derives factory:implement and launches ISOLATED through the loop branch', async () => {
    setRailTickets(db, 0, [1, 2])
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockResolvedValue(['run-1'])
    const enqueue = vi.fn()
    const res = await request(loopApp(enqueue)).post('/rails/0/launch').send({ mode: 'implement' })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ loopRunIds: ['run-1'], mode: 'implement', isolated: true })
    expect(mockLaunchIsolated).toHaveBeenCalledWith(expect.objectContaining({
      loopId: 'factory:implement', scope: 'all', ticketIds: [1, 2],
    }))
    expect(enqueue).not.toHaveBeenCalled() // NOT the bare QueueManager branch
  })

  it('bare freestyle derives factory:freestyle (per-ticket isolation)', async () => {
    setRailTickets(db, 0, [5])
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockResolvedValue(['run-u'])
    const enqueue = vi.fn()
    const res = await request(loopApp(enqueue)).post('/rails/0/launch').send({ mode: 'freestyle' })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ loopRunIds: ['run-u'], mode: 'freestyle', isolated: true })
    expect(mockLaunchIsolated).toHaveBeenCalledWith(expect.objectContaining({
      loopId: 'factory:freestyle', scope: 'per-ticket',
    }))
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('an explicit custom loopId is honored — never overridden by the derivation', async () => {
    setRailTickets(db, 0, [7], 'loop')
    const loop = createLoop(desktopDb, {
      id: 'custom-1', name: 'Mine',
      graph: {
        nodes: [
          { id: 's', type: 'start', position: { x: 0, y: 0 } },
          { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Implement {{spec.title}}' } },
          { id: 'e', type: 'end', position: { x: 0, y: 2 } },
        ],
        edges: [
          { id: 'e1', source: 's', target: 'ai' },
          { id: 'e2', source: 'ai', target: 'e' },
        ],
        config: { maxIterations: 5, timeoutMinutes: 20 },
      },
    })
    publishLoop(desktopDb, loop.id)
    mockRepoStatus.mockResolvedValue('ok')
    mockLaunchIsolated.mockResolvedValue(['run-c'])
    const res = await request(loopApp()).post('/rails/0/launch').send({ mode: 'loop', loopId: 'custom-1' })
    expect(res.status).toBe(202)
    expect(mockLaunchIsolated).toHaveBeenCalledWith(expect.objectContaining({ loopId: 'custom-1' }))
  })

  it('mode=loop without a loopId is still 400 (no factory loop to fall back to)', async () => {
    setRailTickets(db, 0, [1], 'loop')
    const res = await request(loopApp()).post('/rails/0/launch').send({ mode: 'loop' })
    expect(res.status).toBe(400)
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })
})

describe('rails-router GET / — prDeliveries enrichment (ask-first PR decisions)', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  const mk = (id: string, railIndex: number, extra: Partial<CreatePrDeliveryInput> = {}) =>
    createPrDelivery(db, {
      id, railIndex, loopId: 'l', railKey: `${railIndex}-l`, ticketIds: [1],
      baseBranch: 'main', loopName: 'L', originSurface: 'dashboard', ...extra,
    })

  it('returns ACTIVE deliveries keyed by railIndex as camelCase snapshots; terminal rows excluded', async () => {
    mk('d0', 0)
    mk('d1', 1, { ticketIds: [2, 3], baseBranch: 'develop', originSurface: 'agent-chat', originConversationId: 'conv-9' })
    transitionDecision(db, 'd1', 'building', 'on_review', {
      branches: [{ ticketId: 2, branch: 'b2', succeeded: true }], worktreeIds: ['w1'],
    })
    mk('d2', 2)
    transitionDecision(db, 'd2', 'building', 'discarded')

    const res = await request(appWith(db)).get('/rails')
    expect(res.status).toBe(200)
    expect(res.body.prDeliveries['0']).toMatchObject({ id: 'd0', decision: 'building', ticketIds: [1], baseBranch: 'main' })
    expect(res.body.prDeliveries['1']).toMatchObject({
      id: 'd1', decision: 'on_review', ticketIds: [2, 3], baseBranch: 'develop',
      branches: [{ ticketId: 2, branch: 'b2', succeeded: true }], worktreeIds: ['w1'],
      originSurface: 'agent-chat', originConversationId: 'conv-9',
    })
    expect(res.body.prDeliveries['2']).toBeUndefined() // terminal → not surfaced
  })

  it('keeps the NEWEST active delivery when a slot has several rows', async () => {
    mk('older', 0)
    transitionDecision(db, 'older', 'building', 'superseded')
    mk('newer', 0)
    const res = await request(appWith(db)).get('/rails')
    expect(res.body.prDeliveries['0'].id).toBe('newer')
  })

  it('is an empty object when no deliveries exist', async () => {
    const res = await request(appWith(db)).get('/rails')
    expect(res.body.prDeliveries).toEqual({})
  })
})

describe('rails-router POST /pr-decision', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:'); mockExecRun.mockReset() })
  afterEach(() => { openProjectProcessAdmission('p1'); db.close() })

  const url = 'https://github.com/o/r/pull/7'
  const deliverySha = 'a'.repeat(40)

  function prLifecycle(isDraft: boolean): string {
    return JSON.stringify({
      state: 'OPEN', isDraft, headRefName: 'sr/s1/ticket-1', baseRefName: 'main',
      isCrossRepository: false,
      headRefOid: deliverySha, mergeCommit: null, commits: [{ oid: deliverySha }],
    })
  }

  /** A delivery row parked at pr_draft with a live PR URL (approve-ready). */
  function mkDraft(): string {
    const row = createPrDelivery(db, {
      railIndex: 0, loopId: 'l', railKey: '0-l', ticketIds: [1],
      baseBranch: 'main', loopName: 'L', originSurface: 'dashboard',
    })
    transitionDecision(db, row.id, 'building', 'on_review', {
      branches: [{ ticketId: 1, branch: 'sr/s1/ticket-1', succeeded: true }], worktreeIds: [],
    })
    transitionDecision(db, row.id, 'on_review', 'pr_draft', {
      branch: 'sr/s1/ticket-1', prUrl: url, prNumber: 7, prState: 'pr-created',
      deliverySha,
    })
    return row.id
  }

  it('the legacy /pr-review route is GONE (404)', async () => {
    const res = await request(appWith(db)).post('/rails/pr-review').send({ prUrl: url, action: 'ready' })
    expect(res.status).toBe(404)
  })

  it('rejects decisions while startup recovery owns the repository', async () => {
    const id = mkDraft()
    beginProjectProcessQuiescence('p1')

    const res = await request(appWith(db)).post('/rails/pr-decision')
      .send({ prDeliveryId: id, action: 'publish', expectedDecision: 'pr_draft' })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'project_recovery_in_progress' })
    expect(mockExecRun).not.toHaveBeenCalled()
    expect(getPrDelivery(db, id)?.decision).toBe('pr_draft')
  })

  it('400 when prDeliveryId is missing or not a string', async () => {
    for (const bad of [{}, { prDeliveryId: 42 }, { prDeliveryId: '' }]) {
      const res = await request(appWith(db)).post('/rails/pr-decision')
        .send({ ...bad, action: 'publish', expectedDecision: 'pr_draft' })
      expect(res.status).toBe(400)
    }
  })

  it('400 on an invalid action (incl. the retired ready/approve values)', async () => {
    for (const action of ['ready', 'merge', 'approve', 42, null, undefined]) {
      const res = await request(appWith(db)).post('/rails/pr-decision')
        .send({ prDeliveryId: 'd1', action, expectedDecision: 'pr_draft' })
      expect(res.status).toBe(400)
    }
  })

  it('400 when expectedDecision is missing', async () => {
    const res = await request(appWith(db)).post('/rails/pr-decision')
      .send({ prDeliveryId: 'd1', action: 'publish' })
    expect(res.status).toBe(400)
  })

  it('404 on an unknown prDeliveryId', async () => {
    const res = await request(appWith(db)).post('/rails/pr-decision')
      .send({ prDeliveryId: 'ghost', action: 'publish', expectedDecision: 'pr_draft' })
    expect(res.status).toBe(404)
  })

  it('409 stale_decision with the current decision when expectedDecision mismatches', async () => {
    const id = mkDraft()
    const res = await request(appWith(db)).post('/rails/pr-decision')
      .send({ prDeliveryId: id, action: 'create-pr', expectedDecision: 'on_review' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'stale_decision', current: 'pr_draft' })
    expect(res.body.snapshot).toMatchObject({ id, decision: 'pr_draft' })
    expect(mockExecRun).not.toHaveBeenCalled()
  })

  it('409 stale_decision + illegal_action for an action the state machine forbids', async () => {
    const id = mkDraft() // pr_draft WITH a prUrl → create-pr is not legal
    const res = await request(appWith(db)).post('/rails/pr-decision')
      .send({ prDeliveryId: id, action: 'create-pr', expectedDecision: 'pr_draft' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'stale_decision', current: 'pr_draft', reason: 'illegal_action' })
    expect(res.body.snapshot).toMatchObject({ id, decision: 'pr_draft' })
  })

  it('publish → runs gh pr ready, transitions to pr_ready and broadcasts rail.pr_state', async () => {
    const id = mkDraft()
    let viewCount = 0
    mockExecRun.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[1] === 'view') {
        viewCount++
        return { code: 0, stdout: prLifecycle(viewCount === 1), stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const broadcast = vi.fn()
    const res = await request(appWith(db, { broadcast })).post('/rails/pr-decision')
      .send({ prDeliveryId: id, action: 'publish', expectedDecision: 'pr_draft' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, decision: 'pr_ready', prUrl: url })
    expect(res.body.snapshot).toMatchObject({ id, decision: 'pr_ready', deliveryOutcome: 'delivered' })
    expect(mockExecRun).toHaveBeenCalledWith('gh', ['pr', 'ready', url], '/repo')
    expect(getPrDelivery(db, id)?.decision).toBe('pr_ready')
    const msg = broadcast.mock.calls.map((c) => c[0] as { type: string; decision?: string })
      .find((m) => m.type === 'rail.pr_state')
    expect(msg).toMatchObject({ decision: 'pr_ready', prDeliveryId: id, projectId: 'p1' })
  })

  it('502 gh_failed (no transition) when gh fails', async () => {
    const id = mkDraft()
    mockExecRun.mockResolvedValue({ code: 1, stdout: '', stderr: 'gh: not authenticated' })
    const res = await request(appWith(db)).post('/rails/pr-decision')
      .send({ prDeliveryId: id, action: 'publish', expectedDecision: 'pr_draft' })
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('gh_failed')
    expect(res.body.detail).toContain('not authenticated')
    expect(getPrDelivery(db, id)?.decision).toBe('pr_draft')
  })
})

// ── Dynamic rails: POST / (create) + DELETE /:railIndex ───────────────────────

describe('rails-router POST / (create rail)', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  it('creates the next rail and broadcasts rail.updated for it', async () => {
    const broadcast = vi.fn()
    const res = await request(appWith(db, { broadcast })).post('/rails').send({})
    expect(res.status).toBe(201)
    expect(res.body.rail).toMatchObject({ railIndex: 3, ticketIds: [], mode: 'implement' })
    const msg = broadcast.mock.calls.map((c) => c[0] as { type: string; railIndex?: number })
      .find((m) => m.type === 'rail.updated')
    expect(msg).toMatchObject({ railIndex: 3, projectId: 'p1' })
    // Listed by GET /rails from now on.
    const list = await request(appWith(db)).get('/rails')
    expect(list.body.rails.map((r: { railIndex: number }) => r.railIndex)).toEqual([0, 1, 2, 3])
  })

  it('accepts an optional initial name', async () => {
    const res = await request(appWith(db)).post('/rails').send({ name: 'Backend' })
    expect(res.status).toBe(201)
    expect(res.body.rail.name).toBe('Backend')
  })

  it('rejects a non-string name and an over-long name', async () => {
    expect((await request(appWith(db)).post('/rails').send({ name: 42 })).status).toBe(400)
    expect((await request(appWith(db)).post('/rails').send({ name: 'x'.repeat(61) })).status).toBe(400)
  })

  it('enforces the MAX_RAILS cap with rail_limit_reached', async () => {
    const app = appWith(db)
    // 3 base rails exist; create up to the cap of 12 → 9 more succeed.
    for (let i = 0; i < 9; i++) {
      expect((await request(app).post('/rails').send({})).status).toBe(201)
    }
    const res = await request(app).post('/rails').send({})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'rail_limit_reached', maxRails: 12 })
  })
})

describe('rails-router DELETE /:railIndex', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  it('deletes an empty idle rail and broadcasts rail.removed', async () => {
    await request(appWith(db)).post('/rails').send({}) // rail 3
    const broadcast = vi.fn()
    const res = await request(appWith(db, { broadcast })).delete('/rails/3')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, railIndex: 3 })
    expect(broadcast.mock.calls.map((c) => c[0] as { type: string; railIndex?: number }))
      .toContainEqual({ type: 'rail.removed', projectId: 'p1', railIndex: 3 })
    const list = await request(appWith(db)).get('/rails')
    expect(list.body.rails.map((r: { railIndex: number }) => r.railIndex)).toEqual([0, 1, 2])
  })

  it('base rails are deletable too (empty + idle), but never the last one', async () => {
    expect((await request(appWith(db)).delete('/rails/0')).status).toBe(200)
    expect((await request(appWith(db)).delete('/rails/1')).status).toBe(200)
    const res = await request(appWith(db)).delete('/rails/2')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('cannot_delete_last_rail')
  })

  it('404 on an unknown rail, 400 out of range', async () => {
    expect((await request(appWith(db)).delete('/rails/7')).status).toBe(404)
    expect((await request(appWith(db)).delete('/rails/12')).status).toBe(400)
    expect((await request(appWith(db)).delete('/rails/-1')).status).toBe(400)
  })

  it('atomically releases ticket assignments when deleting a non-empty rail', async () => {
    setRailTickets(db, 1, [5])
    const res = await request(appWith(db)).delete('/rails/1')
    expect(res.status).toBe(200)
    expect(getRail(db, 1).ticketIds).toEqual([])
    expect((await request(appWith(db)).get('/rails')).body.rails.map((r: { railIndex: number }) => r.railIndex))
      .toEqual([0, 2])
  })

  it('validates the last-rail guard before releasing its tickets', async () => {
    expect((await request(appWith(db)).delete('/rails/0')).status).toBe(200)
    expect((await request(appWith(db)).delete('/rails/1')).status).toBe(200)
    setRailTickets(db, 2, [5, 6])

    const res = await request(appWith(db)).delete('/rails/2')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('cannot_delete_last_rail')
    expect(getRail(db, 2).ticketIds).toEqual([5, 6])
  })

  it('409 rail_active when the rail has an active loop run', async () => {
    const railLoopRuns = new Map([['run-1', { railIndex: 1, ticketIds: [5] }]])
    const res = await request(appWith(db, { railLoopRuns })).delete('/rails/1')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('rail_active')
  })

  it('409 pr_decision_pending when the slot has an undecided delivery', async () => {
    const row = createPrDelivery(db, {
      railIndex: 1, loopId: 'factory:implement', railKey: '1-factory:implement',
      ticketIds: [5], baseBranch: 'main', loopName: 'Implement',
      originSurface: 'dashboard', originConversationId: null,
    } as CreatePrDeliveryInput)
    const res = await request(appWith(db)).delete('/rails/1')
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'pr_decision_pending', prDeliveryId: row.id })
  })
})

describe('rails-router launch — concurrent-launch ticket guard', () => {
  let db: DbInstance
  const savedLoops = process.env.SPECRAILS_LOOPS_SECTION
  beforeEach(() => {
    db = initDb(':memory:')
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
  })
  afterEach(() => {
    db.close()
    if (savedLoops === undefined) delete process.env.SPECRAILS_LOOPS_SECTION
    else process.env.SPECRAILS_LOOPS_SECTION = savedLoops
  })

  it('400 rail_ticket_cap_exceeded when the rail carries more than 3 specs', async () => {
    setRailTickets(db, 0, [1, 2, 3, 4])
    const enqueue = vi.fn()
    const res = await request(appWith(db, { queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'batch-implement' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'rail_ticket_cap_exceeded', max: 3, ticketCount: 4 })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('launches a rail with exactly 3 specs (cap is inclusive)', async () => {
    setRailTickets(db, 0, [1, 2, 3])
    const enqueue = vi.fn().mockReturnValue({ id: 'job-cap', queuePosition: 0 })
    const res = await request(appWith(db, { queueManager: { enqueue } }))
      .post('/rails/0/launch').send({ mode: 'batch-implement' })
    expect(res.status).not.toBe(400)
  })

  it('409 tickets_in_flight when a rail ticket is already worked by an active loop run', async () => {
    setRailTickets(db, 0, [1, 2])
    const enqueue = vi.fn()
    // Ticket 2 is in-flight on ANOTHER rail — launching rail 0 would spawn a
    // second concurrent writer on the same per-ticket worktree.
    const railLoopRuns = new Map([['run-9', { railIndex: 1, ticketIds: [2] }]])
    const res = await request(appWith(db, { queueManager: { enqueue }, railLoopRuns }))
      .post('/rails/0/launch').send({ mode: 'implement' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'tickets_in_flight', ticketIds: [2] })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('launches normally when no ticket overlaps an active run', async () => {
    setRailTickets(db, 0, [1])
    const enqueue = vi.fn().mockReturnValue({ id: 'job-1', queuePosition: 0 })
    const railLoopRuns = new Map([['run-9', { railIndex: 1, ticketIds: [2] }]])
    const res = await request(appWith(db, { queueManager: { enqueue }, railLoopRuns }))
      .post('/rails/0/launch').send({ mode: 'implement' })
    expect(res.status).toBe(202)
  })

  it('rejects an out-of-range rail index on launch (MAX_RAILS cap)', async () => {
    const res = await request(appWith(db)).post('/rails/12/launch').send({ mode: 'implement' })
    expect(res.status).toBe(400)
  })
})

describe('rails-router POST /pr-checkout generation guard', () => {
  let db: DbInstance

  beforeEach(() => { db = initDb(':memory:') })
  afterEach(() => { db.close() })

  function checkoutDelivery(input: { id: string; deliveryOutcome: 'blocked' | 'delivered'; deliverySha: string | null }) {
    const delivery = createPrDelivery(db, {
      id: input.id, railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'dashboard',
    })
    transitionDecision(db, delivery.id, 'building', 'on_review', {
      branch: 'feat/review', implementationOutcome: 'succeeded',
      deliveryOutcome: 'ready', statusCode: 'ready_for_review',
      deliverySha: input.deliverySha,
    })
    transitionDecision(db, delivery.id, 'on_review', 'pr_ready', {
      prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'pr-created',
      deliveryOutcome: input.deliveryOutcome,
      statusCode: input.deliveryOutcome === 'blocked' ? 'settlement_interrupted' : 'pr_ready',
    })
    return delivery
  }

  it.each([
    ['blocked delivery', 'blocked', 'a'.repeat(40)],
    ['delivery without a verified SHA', 'delivered', null],
  ] as const)('rejects a %s before repository inspection or mutation', async (_label, deliveryOutcome, deliverySha) => {
    const delivery = checkoutDelivery({ id: `checkout-${deliveryOutcome}-${deliverySha ? 'sha' : 'no-sha'}`, deliveryOutcome, deliverySha })

    const res = await request(appWith(db)).post('/rails/pr-checkout').send({
      prDeliveryId: delivery.id,
    })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'checkout_not_deliverable' })
    expect(mockGetProjectGitInfo).not.toHaveBeenCalled()
    expect(mockReleaseRailWorktrees).not.toHaveBeenCalled()
    expect(mockCheckoutProjectReviewBranch).not.toHaveBeenCalled()
  })

  it('keeps a dirty primary checkout untouched and returns the stable dirty error', async () => {
    const delivery = checkoutDelivery({ id: 'checkout-dirty', deliveryOutcome: 'delivered', deliverySha: 'b'.repeat(40) })
    mockInspectProjectCheckoutCleanliness.mockResolvedValueOnce({ ok: true, clean: false })

    const res = await request(appWith(db)).post('/rails/pr-checkout').send({
      prDeliveryId: delivery.id,
    })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'checkout_dirty',
      detail: 'Working tree has uncommitted changes. Commit or stash them before checkout.',
    })
    expect(mockInspectProjectCheckoutCleanliness).toHaveBeenCalledOnce()
    expect(mockGetProjectGitInfo).not.toHaveBeenCalled()
    expect(mockReleaseRailWorktrees).not.toHaveBeenCalled()
    expect(mockCheckoutProjectReviewBranch).not.toHaveBeenCalled()
  })

  it('fails closed when main-checkout cleanliness cannot be proved', async () => {
    const delivery = checkoutDelivery({ id: 'checkout-status-unknown', deliveryOutcome: 'delivered', deliverySha: 'c'.repeat(40) })
    mockInspectProjectCheckoutCleanliness.mockResolvedValueOnce({
      ok: false,
      detail: 'Working tree cleanliness could not be verified: status timed out',
    })

    const res = await request(appWith(db)).post('/rails/pr-checkout').send({ prDeliveryId: delivery.id })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'checkout_safety_unknown',
      detail: 'Working tree cleanliness could not be verified: status timed out',
    })
    expect(mockGetProjectGitInfo).not.toHaveBeenCalled()
    expect(mockReleaseRailWorktrees).not.toHaveBeenCalled()
    expect(mockCheckoutProjectReviewBranch).not.toHaveBeenCalled()
  })

  it('clears stale cleanup_incomplete evidence after a warning-free release', async () => {
    const deliverySha = 'f'.repeat(40)
    const delivery = checkoutDelivery({ id: 'checkout-clears-stale', deliveryOutcome: 'delivered', deliverySha })
    // Earlier failed release attempts persisted a warning + cleanup_incomplete.
    transitionDecision(db, delivery.id, 'pr_ready', 'pr_ready', {
      cleanupWarnings: ['worktree /wt/old: preserved because the worktree contains changes made after settlement'],
      statusCode: 'cleanup_incomplete',
    })
    mockReleaseRailWorktrees.mockResolvedValueOnce([])
    mockCheckoutProjectReviewBranch.mockResolvedValueOnce({ ok: true })

    const res = await request(appWith(db)).post('/rails/pr-checkout').send({ prDeliveryId: delivery.id })

    expect(res.status).toBe(200)
    const row = getPrDelivery(db, delivery.id)!
    expect(JSON.parse(row.cleanup_warnings)).toEqual([])
    expect(row.status_code).toBeNull()
  })

  it('passes the immutable delivery SHA to checkout and relays a divergent-ref refusal', async () => {
    const deliverySha = 'e'.repeat(40)
    const delivery = checkoutDelivery({ id: 'checkout-divergent-ref', deliveryOutcome: 'delivered', deliverySha })
    mockCheckoutProjectReviewBranch.mockResolvedValueOnce({
      ok: false,
      error: 'Local branch points to another commit. It was preserved and not checked out.',
    })

    const res = await request(appWith(db)).post('/rails/pr-checkout').send({ prDeliveryId: delivery.id })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'checkout_failed',
      detail: 'Local branch points to another commit. It was preserved and not checked out.',
    })
    expect(mockCheckoutProjectReviewBranch).toHaveBeenCalledWith('/repo', 'feat/review', deliverySha)
  })

  it('uses the current attached branch after waiting for the repository lock', async () => {
    const delivery = checkoutDelivery({ id: 'checkout-queued', deliveryOutcome: 'delivered', deliverySha: 'd'.repeat(40) })
    let releaseBlocker!: () => void
    let blockerEntered!: () => void
    const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve })
    const entered = new Promise<void>((resolve) => { blockerEntered = resolve })
    const blocker = withRepoLock('/repo', async () => {
      blockerEntered()
      await blockerGate
    })
    await entered

    const pendingResponse = request(appWith(db)).post('/rails/pr-checkout')
      .send({ prDeliveryId: delivery.id })
      .then((response) => response)
    await new Promise<void>((resolve) => setImmediate(resolve))
    transitionDecision(db, delivery.id, 'pr_ready', 'pr_ready', {
      branch: 'feat/current-review',
      prUrl: 'https://github.com/o/r/pull/2',
      prNumber: 2,
      prState: 'pr-created',
      deliveryOutcome: 'delivered',
      deliverySha: 'd'.repeat(40),
    })
    releaseBlocker()
    await blocker

    const res = await pendingResponse

    expect(res.status).toBe(200)
    expect(mockCheckoutProjectReviewBranch).toHaveBeenCalledWith(
      '/repo',
      'feat/current-review',
      'd'.repeat(40),
    )
    expect(mockCheckoutProjectReviewBranch).not.toHaveBeenCalledWith(
      '/repo',
      'feat/review',
      expect.anything(),
    )
  })

  it('rejects checkout for superseded generation A after generation B becomes active', async () => {
    const generationA = createPrDelivery(db, {
      id: 'generation-a', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'dashboard',
    })
    transitionDecision(db, generationA.id, 'building', 'on_review', {
      branch: 'feat/generation-a', implementationOutcome: 'succeeded',
      deliveryOutcome: 'ready', statusCode: 'ready_for_review',
      deliverySha: 'a'.repeat(40),
    })
    transitionDecision(db, generationA.id, 'on_review', 'pr_ready', {
      prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'pr-created',
      deliveryOutcome: 'delivered', statusCode: 'pr_ready',
    })
    transitionDecision(db, generationA.id, 'pr_ready', 'superseded')
    createPrDelivery(db, {
      id: 'generation-b', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'dashboard', supersedesDeliveryId: generationA.id,
    })

    const res = await request(appWith(db)).post('/rails/pr-checkout').send({
      prDeliveryId: generationA.id,
    })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'stale_decision', current: 'building', currentPrDeliveryId: 'generation-b',
    })
  })
})

describe('rails-router GET /pr-deliveries/:id/packet', () => {
  let db: DbInstance
  const ORIG_FLAG = process.env.SPECRAILS_REVIEW_PACKET
  beforeEach(() => {
    db = initDb(':memory:')
    mockExecRun.mockReset()
    delete process.env.SPECRAILS_REVIEW_PACKET // default-on
  })
  afterEach(() => {
    if (ORIG_FLAG === undefined) delete process.env.SPECRAILS_REVIEW_PACKET
    else process.env.SPECRAILS_REVIEW_PACKET = ORIG_FLAG
    db.close()
  })

  /** A delivery parked at on_review with durable units + launch snapshot. */
  function mkOnReview(): string {
    const row = createPrDelivery(db, {
      railIndex: 0, loopId: 'factory:implement', railKey: '0-factory:implement', ticketIds: [1],
      baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard',
      specSnapshot: [{ ticketId: 1, title: 'Add login', description: 'No login today.\n\nAdd a form.', labels: ['auth'] }],
    })
    transitionDecision(db, row.id, 'building', 'on_review', {
      branches: [{ ticketId: 1, branch: 'feat/1-login', succeeded: true, runId: 'run-1', implementationOutcome: 'succeeded', deliveryOutcome: 'ready' }],
      runIds: ['run-1'],
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'ready',
      statusCode: 'ready_for_review',
      settleEvidence: {
        schemaVersion: 1, harvest: 'ok', harvestedAt: '2026-07-27T12:00:00.000Z',
        units: [{ ticketId: 1, runId: 'run-1', sentinel: 'pass', sentinelDetail: null, verifyTail: 'VERIFICATION: PASS', confidence: null }],
      },
    })
    return row.id
  }

  function ghAvailable(): void {
    mockExecRun.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'remote') return { code: 0, stdout: 'origin\n', stderr: '' }
      if (cmd === 'gh') return { code: 0, stdout: 'gho_x', stderr: '' }
      return { code: 1, stdout: '', stderr: 'unexpected' }
    })
  }

  it('returns the composed packet, the pre-resolved Accept ladder and the authoritative snapshot', async () => {
    const id = mkOnReview()
    ghAvailable()
    const res = await request(appWith(db)).get(`/rails/pr-deliveries/${id}/packet`)
    expect(res.status).toBe(200)
    expect(res.body.packet).toMatchObject({
      schemaVersion: 1, prDeliveryId: id, variant: 'success', decision: 'on_review',
      headlineCode: 'headline.success', baseBranch: 'main', loopName: 'Implement',
    })
    expect(res.body.packet.sections[0]).toMatchObject({ ticketId: 1, title: 'Add login' })
    expect(res.body.acceptCapability).toMatchObject({ target: 'create-pr', irreversible: false })
    expect(res.body.snapshot).toMatchObject({ id, decision: 'on_review' })
  })

  it('resolves Accept to the irreversible local path when the repo has no remote', async () => {
    const id = mkOnReview()
    mockExecRun.mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }))
    const res = await request(appWith(db)).get(`/rails/pr-deliveries/${id}/packet`)
    expect(res.body.acceptCapability).toMatchObject({
      target: 'merge-local', hasRemote: false, irreversible: true, reasonCode: 'no-remote',
    })
  })

  it('never spends a model call composing (read-only route)', async () => {
    const id = mkOnReview()
    ghAvailable()
    await request(appWith(db)).get(`/rails/pr-deliveries/${id}/packet`)
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_invocations').get()).toEqual({ n: 0 })
  })

  it('404s an unknown delivery', async () => {
    const res = await request(appWith(db)).get('/rails/pr-deliveries/nope/packet')
    expect(res.status).toBe(404)
  })

  it('404s entirely when the feature flag is off (existing strip keeps working)', async () => {
    const id = mkOnReview()
    process.env.SPECRAILS_REVIEW_PACKET = 'false'
    const res = await request(appWith(db)).get(`/rails/pr-deliveries/${id}/packet`)
    expect(res.status).toBe(404)
  })

  it('still composes for a still-building delivery (no evidence yet)', async () => {
    const row = createPrDelivery(db, {
      railIndex: 1, loopId: 'l', railKey: '1-l', ticketIds: [2],
      baseBranch: 'main', loopName: 'L', originSurface: 'dashboard',
    })
    ghAvailable()
    const res = await request(appWith(db)).get(`/rails/pr-deliveries/${row.id}/packet`)
    expect(res.status).toBe(200)
    expect(res.body.packet.decision).toBe('building')
    expect(res.body.packet.evidenceUnavailable).toBe(true)
  })
})
