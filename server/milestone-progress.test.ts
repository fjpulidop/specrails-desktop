import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from './db'
import {
  deriveMilestoneProgress,
  readMilestoneProgress,
  markMilestoneDone,
  resolveBlueprintWorkspace,
  MilestoneProgressBroadcaster,
  MILESTONE_PROGRESS_TRIGGERS,
  type MilestoneChainSnapshot,
  type MilestoneProgress,
} from './milestone-progress'
import { writeBlueprintPair, readBlueprint } from './blueprint-render'
import { mutateStore } from './ticket-store'
import { createPrDelivery, transitionDecision, toPrDeliverySnapshot, getPrDelivery, type PrDeliverySnapshot } from './rail-pr-store'
import { createLoopRun } from './loop-runs-store'
import { setRailName, setRailTickets } from './rails-store'
import { workspacePathFor } from './workspace-manager'
import type { Blueprint } from './blueprint-types'
import type { WsMessage } from './types'

function blueprint(over: Partial<Blueprint> = {}): Blueprint {
  return {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'Recipes from your pantry', audience: 'home cooks' },
    coreFlow: 'add pantry → suggest recipes',
    platform: 'web',
    stack: { language: 'ts', framework: 'react', db: 'sqlite' },
    assumptions: [],
    milestones: [
      { id: 'm1', title: 'Walking skeleton', goal: 'end-to-end', status: 'committed', plannedSpecs: [] },
      { id: 'm2', title: 'Pantry', goal: 'pantry CRUD', status: 'planned', plannedSpecs: ['a', 'b'] },
    ],
    specsComplete: true,
    m1Specs: [],
    ...over,
  }
}

function ticket(id: number, status: string, labels: string[] = ['M1']) {
  return { id, status, labels }
}

function delivery(over: Partial<PrDeliverySnapshot> & { ticketIds: number[]; railIndex: number }): PrDeliverySnapshot {
  return {
    id: over.id ?? `d-${over.railIndex}`,
    loopId: null,
    railKey: `rail-${over.railIndex}`,
    baseBranch: 'main',
    branch: null,
    prUrl: null,
    prNumber: null,
    prState: 'none',
    decision: 'on_review',
    implementationOutcome: 'succeeded',
    deliveryOutcome: 'ready',
    statusCode: null,
    statusDetail: null,
    deliverySha: null,
    isContinuation: false,
    supersedesDeliveryId: null,
    restoredFromDeliveryId: null,
    operation: null,
    cleanupWarnings: [],
    safetyArchives: [],
    branches: [],
    units: [],
    loopName: 'Batch',
    worktreeIds: [],
    runIds: [],
    originSurface: 'dashboard',
    originConversationId: null,
    createdAt: '2026-09-04T10:00:00.000Z',
    updatedAt: '2026-09-04T10:00:00.000Z',
    ...over,
  } as PrDeliverySnapshot
}

const base = { deliveries: [] as PrDeliverySnapshot[], activeRuns: [], rails: [], chains: [] as MilestoneChainSnapshot[] }

describe('deriveMilestoneProgress — counts and state', () => {
  it('a delivered milestone is delivered, never done (0 done / 8 in review)', () => {
    const tickets = Array.from({ length: 8 }, (_, i) => ticket(i + 1, 'on_review'))
    const [m1, m2] = deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets })
    expect(m1.counts).toEqual({ total: 8, done: 0, onReview: 8, inProgress: 0, todo: 0, failed: 0 })
    expect(m1.state).toBe('delivered')
    expect(m1.storedStatus).toBe('committed')
    expect(m2.state).toBe('planned')
    expect(m2.counts.total).toBe(0)
  })

  it('a partial launch is running with 3 in progress and 5 pending', () => {
    const tickets = [1, 2, 3].map((id) => ticket(id, 'in_progress')).concat([4, 5, 6, 7, 8].map((id) => ticket(id, 'todo')))
    const [m1] = deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets })
    expect(m1.counts).toMatchObject({ inProgress: 3, todo: 5 })
    expect(m1.state).toBe('running')
  })

  it('every spec done ⇒ done; a manual regression is honest', () => {
    const done = [1, 2, 3].map((id) => ticket(id, 'done'))
    expect(deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets: done })[0].state).toBe('done')
    const regressed = [ticket(1, 'todo'), ticket(2, 'done'), ticket(3, 'done')]
    const bp = blueprint()
    bp.milestones[0].status = 'done'
    const [m1] = deriveMilestoneProgress({ ...base, blueprint: bp, tickets: regressed })
    expect(m1.state).toBe('committed')
    expect(m1.storedStatus).toBe('done')
    expect(m1.counts.done).toBe(2)
  })

  it('done + on_review mixes stay delivered; committed when nothing launched; stored status when no tickets', () => {
    const mixed = [ticket(1, 'done'), ticket(2, 'on_review')]
    expect(deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets: mixed })[0].state).toBe('delivered')
    const idle = [ticket(1, 'todo'), ticket(2, 'todo')]
    expect(deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets: idle })[0].state).toBe('committed')
    expect(deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets: [] })[0].state).toBe('committed')
  })

  it('a live chain makes the milestone running even between chunks', () => {
    const tickets = [ticket(1, 'on_review'), ticket(2, 'todo')]
    const chain: MilestoneChainSnapshot = {
      id: 'c1', milestoneN: 1, mode: 'sequential', status: 'waiting', pauseReason: null,
      nextChunk: 1, totalChunks: 2, currentRailIndex: 2, headBranch: 'feat/1-batch', launched: [], updatedAt: 'x',
    }
    const [m1] = deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets, chains: [chain] })
    expect(m1.state).toBe('running')
    expect(m1.chain?.id).toBe('c1')
    const paused = { ...chain, status: 'paused' as const }
    expect(deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets, chains: [paused] })[0].state).toBe('committed')
  })

  it('ignores tickets of other milestones and malformed labels', () => {
    const tickets = [ticket(1, 'done', ['M1']), ticket(2, 'done', ['M2']), { id: 3, status: 'done', labels: undefined as unknown as string[] }]
    const [m1, m2] = deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets })
    expect(m1.counts.total).toBe(1)
    expect(m2.counts.total).toBe(1)
  })
})

describe('deriveMilestoneProgress — failed attempts', () => {
  it('counts a todo spec whose NEWEST delivery unit failed, once', () => {
    const tickets = [ticket(1, 'todo'), ticket(2, 'todo'), ticket(3, 'todo')]
    const older = delivery({ id: 'old', railIndex: 1, ticketIds: [1, 2], decision: 'discarded', createdAt: '2026-09-01T00:00:00.000Z',
      units: [{ ticketId: 1, branch: 'b', succeeded: false, implementationOutcome: 'failed' }, { ticketId: 2, branch: 'b', succeeded: true, implementationOutcome: 'succeeded' }] })
    const newer = delivery({ id: 'new', railIndex: 1, ticketIds: [1, 2], decision: 'discarded', createdAt: '2026-09-02T00:00:00.000Z',
      units: [{ ticketId: 1, branch: 'b', succeeded: true, implementationOutcome: 'succeeded' }, { ticketId: 2, branch: 'b', succeeded: false, implementationOutcome: 'failed' }] })
    const [m1] = deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets, deliveries: [older, newer] })
    // #1 succeeded on the newest attempt (older failure is history); #2 failed
    // on the newest; #3 was never attempted.
    expect(m1.counts.failed).toBe(1)
  })

  it('implementation_failed / blocked / legacy succeeded=false all count; on_review never does', () => {
    const tickets = [ticket(1, 'todo'), ticket(2, 'todo'), ticket(3, 'todo'), ticket(4, 'on_review')]
    const deliveries = [
      delivery({ id: 'a', railIndex: 1, ticketIds: [1], decision: 'implementation_failed', units: [] }),
      delivery({ id: 'b', railIndex: 2, ticketIds: [2], decision: 'discarded', units: [{ ticketId: 2, branch: 'x', succeeded: false, deliveryOutcome: 'blocked' }] }),
      delivery({ id: 'c', railIndex: 3, ticketIds: [3], decision: 'discarded', units: [{ ticketId: 3, branch: 'x', succeeded: false }] }),
      delivery({ id: 'd', railIndex: 4, ticketIds: [4], decision: 'on_review', units: [{ ticketId: 4, branch: 'x', succeeded: false, implementationOutcome: 'failed' }] }),
    ]
    const [m1] = deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets, deliveries })
    expect(m1.counts.failed).toBe(3)
  })

  it('a unit-less delivery falls back to the delivery outcome', () => {
    const tickets = [ticket(1, 'todo')]
    const d = delivery({ id: 'a', railIndex: 1, ticketIds: [1], decision: 'discarded', implementationOutcome: 'failed', units: [] })
    expect(deriveMilestoneProgress({ ...base, blueprint: blueprint(), tickets, deliveries: [d] })[0].counts.failed).toBe(1)
  })
})

describe('deriveMilestoneProgress — rails', () => {
  it('lists active runs and non-terminal deliveries, chunk-ordered, terminal deliveries excluded', () => {
    const tickets = [1, 2, 3, 4, 5, 6].map((id) => ticket(id, id <= 3 ? 'on_review' : 'in_progress'))
    const chain: MilestoneChainSnapshot = {
      id: 'c1', milestoneN: 1, mode: 'sequential', status: 'waiting', pauseReason: null, nextChunk: 2, totalChunks: 3,
      currentRailIndex: 5, headBranch: 'feat/1', updatedAt: 'x',
      launched: [{ chunk: 1, railIndex: 7, ticketIds: [1, 2, 3], runIds: ['r1'], deliveryId: 'd7' }, { chunk: 2, railIndex: 5, ticketIds: [4, 5, 6], runIds: ['r2'], deliveryId: 'd5' }],
    }
    const [m1] = deriveMilestoneProgress({
      blueprint: blueprint(),
      tickets,
      deliveries: [
        delivery({ id: 'd7', railIndex: 7, ticketIds: [1, 2, 3], decision: 'on_review' }),
        delivery({ id: 'd5', railIndex: 5, ticketIds: [4, 5, 6], decision: 'building' }),
        delivery({ id: 'old', railIndex: 9, ticketIds: [1], decision: 'discarded' }),
      ],
      activeRuns: [{ runId: 'r2', railIndex: 5, ticketIds: [4, 5, 6], startedAt: '2026-09-04T11:00:00.000Z' }],
      rails: [{ railIndex: 5, name: 'M1 · 2' }, { railIndex: 7, name: 'M1 · 1' }],
      chains: [chain],
    })
    expect(m1.rails.map((r) => r.railIndex)).toEqual([7, 5])
    expect(m1.rails[0]).toMatchObject({ name: 'M1 · 1', active: false, runId: null, chunkIndex: 1, ticketIds: [1, 2, 3] })
    expect(m1.rails[0].delivery?.id).toBe('d7')
    expect(m1.rails[1]).toMatchObject({ name: 'M1 · 2', active: true, runId: 'r2', chunkIndex: 2, startedAt: '2026-09-04T11:00:00.000Z' })
    expect(m1.rails[1].delivery?.id).toBe('d5')
  })

  it('a rail carrying no milestone ticket is not listed', () => {
    const [m1] = deriveMilestoneProgress({
      ...base, blueprint: blueprint(), tickets: [ticket(1, 'todo')],
      activeRuns: [{ runId: 'r', railIndex: 1, ticketIds: [99], startedAt: null }],
      deliveries: [delivery({ id: 'x', railIndex: 2, ticketIds: [98] })],
    })
    expect(m1.rails).toEqual([])
  })
})

// ─── Durable sources ──────────────────────────────────────────────────────────

describe('readMilestoneProgress / markMilestoneDone (real rows)', () => {
  let db: DbInstance
  let tmp: string
  let priorHome: string | undefined
  const project = { id: 'p1', slug: 'recipely', path: '' }

  beforeEach(() => {
    db = initDb(':memory:')
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'))
    priorHome = process.env.SPECRAILS_REGISTRY_HOME
    process.env.SPECRAILS_REGISTRY_HOME = tmp
    project.path = path.join(tmp, 'repo')
    fs.mkdirSync(project.path, { recursive: true })
  })
  afterEach(() => {
    if (priorHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = priorHome
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const src = (ticketsPath: string) => ({
    db,
    projectId: project.id,
    workspaceDir: () => resolveBlueprintWorkspace(project),
    ticketsPath: () => ticketsPath,
  })

  it('returns null without a blueprint (ordinary projects)', () => {
    expect(readMilestoneProgress(src(path.join(project.path, 'tickets.json')))).toBeNull()
  })

  it('derives from the ticket store, deliveries, live runs and rail names', () => {
    const ws = workspacePathFor(project.slug)
    fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
    writeBlueprintPair(ws, blueprint())
    const ticketsPath = path.join(project.path, '.specrails', 'local-tickets.json')
    fs.mkdirSync(path.dirname(ticketsPath), { recursive: true })
    mutateStore(ticketsPath, (s) => {
      for (const [id, status] of [[1, 'on_review'], [2, 'on_review'], [3, 'in_progress'], [4, 'todo']] as Array<[number, string]>) {
        s.tickets[String(id)] = {
          id, title: `t${id}`, description: '', status: status as never, priority: 'medium', labels: ['M1'], assignee: null,
          prerequisites: [], metadata: {}, created_at: 'x', updated_at: 'x', created_by: 'project-builder', source: 'project-builder',
        } as never
      }
    })
    setRailTickets(db, 3, [3])
    setRailName(db, 3, 'M1 · 2')
    const d = createPrDelivery(db, { railIndex: 2, railKey: 'rail-2', ticketIds: [1, 2], baseBranch: 'main', loopName: 'Batch', originSurface: 'dashboard' })
    expect(transitionDecision(db, d.id, 'building', 'on_review', { branch: 'feat/1-batch' })).toBe(true)
    createLoopRun(db, { id: 'run-3', projectId: project.id, loopId: 'factory:batch', railIndex: 3, ticketIds: [3], iterationLimit: 1, startedAt: '2026-09-04T12:00:00.000Z' })

    const snap = readMilestoneProgress({ ...src(ticketsPath), railLoopRuns: new Map([['run-3', { railIndex: 3, ticketIds: [3] }]]) })!
    expect(snap.blueprint.product.name).toBe('Recipely')
    const m1 = snap.progress[0]
    expect(m1.counts).toMatchObject({ total: 4, onReview: 2, inProgress: 1, todo: 1 })
    expect(m1.state).toBe('running')
    expect(m1.rails.map((r) => r.railIndex).sort()).toEqual([2, 3])
    const rail3 = m1.rails.find((r) => r.railIndex === 3)!
    expect(rail3).toMatchObject({ active: true, runId: 'run-3', name: 'M1 · 2', startedAt: '2026-09-04T12:00:00.000Z' })
    const rail2 = m1.rails.find((r) => r.railIndex === 2)!
    expect(rail2.delivery?.decision).toBe('on_review')
    expect(rail2.delivery?.branch).toBe('feat/1-batch')
  })

  it('DB-only active runs (after a restart) and rail jobs are surfaced too', () => {
    const ws = workspacePathFor(project.slug)
    fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
    writeBlueprintPair(ws, blueprint())
    const ticketsPath = path.join(project.path, 't.json')
    mutateStore(ticketsPath, (s) => {
      s.tickets['1'] = { id: 1, title: 't', description: '', status: 'in_progress', priority: 'medium', labels: ['M1'], assignee: null, prerequisites: [], metadata: {}, created_at: 'x', updated_at: 'x' } as never
      s.tickets['2'] = { id: 2, title: 't', description: '', status: 'in_progress', priority: 'medium', labels: ['M1'], assignee: null, prerequisites: [], metadata: {}, created_at: 'x', updated_at: 'x' } as never
    })
    createLoopRun(db, { id: 'run-db', projectId: project.id, loopId: 'l', railIndex: 4, ticketIds: [1], iterationLimit: 1, startedAt: '2026-09-04T12:00:00.000Z' })
    const snap = readMilestoneProgress({ ...src(ticketsPath), railJobs: new Map([['job-9', { railIndex: 6, ticketIds: [2] }]]) })!
    expect(snap.progress[0].rails.map((r) => [r.railIndex, r.runId])).toEqual([[4, 'run-db'], [6, 'job-9']])
  })

  it('an unreadable ticket store degrades to zero tickets, never throws', () => {
    const ws = workspacePathFor(project.slug)
    fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
    writeBlueprintPair(ws, blueprint())
    const bad = path.join(project.path, 'bad.json')
    fs.writeFileSync(bad, '{not json')
    expect(readMilestoneProgress(src(bad))!.progress[0].counts.total).toBe(0)
  })

  it('markMilestoneDone persists once and re-renders the pair', () => {
    const ws = workspacePathFor(project.slug)
    fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
    writeBlueprintPair(ws, blueprint())
    expect(markMilestoneDone(ws, 'm1')?.milestones[0].status).toBe('done')
    expect(readBlueprint(ws)?.milestones[0].status).toBe('done')
    expect(markMilestoneDone(ws, 'm1')).toBeNull()
    expect(markMilestoneDone(ws, 'nope')).toBeNull()
    expect(markMilestoneDone(null, 'm1')).toBeNull()
    expect(fs.readFileSync(path.join(ws, '.specrails', 'blueprint.md'), 'utf-8')).toContain('Walking skeleton')
  })
})

// ─── Broadcaster ──────────────────────────────────────────────────────────────

describe('MilestoneProgressBroadcaster', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function progress(state: MilestoneProgress['state'], storedStatus: MilestoneProgress['storedStatus'] = 'committed'): MilestoneProgress {
    return { id: 'm1', n: 1, title: 'Walking skeleton', storedStatus, state, counts: { total: 1, done: state === 'done' ? 1 : 0, onReview: 0, inProgress: 0, todo: 0, failed: 0 }, rails: [], chain: null }
  }

  function make(read: () => ReturnType<MilestoneProgressBroadcaster['flush']>, persistDone = vi.fn(() => true)) {
    const sent: WsMessage[] = []
    const b = new MilestoneProgressBroadcaster({ projectId: 'p1', read, broadcast: (m) => sent.push(m), persistDone, debounceMs: 100, now: () => 1_700_000_000_000 })
    return { b, sent, persistDone }
  }

  it('coalesces a burst of triggers into ONE debounced broadcast', () => {
    const read = vi.fn(() => ({ blueprint: blueprint(), progress: [progress('running')] }))
    const { b, sent } = make(read)
    for (let i = 0; i < 5; i++) b.observe({ type: 'ticket_updated' } as WsMessage)
    b.observe({ type: 'rail.pr_state' } as WsMessage)
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(99)
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(2)
    expect(read).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'blueprint.milestone_progress', projectId: 'p1', timestamp: '2023-11-14T22:13:20.000Z' })
    expect((sent[0] as { progress: MilestoneProgress[] }).progress[0].state).toBe('running')
  })

  it('ignores non-trigger messages and its own outputs', () => {
    const read = vi.fn(() => ({ blueprint: blueprint(), progress: [] }))
    const { b, sent } = make(read)
    b.observe({ type: 'log' } as WsMessage)
    b.observe({ type: 'queue' } as WsMessage)
    b.observe({ type: 'blueprint.milestone_progress' } as WsMessage)
    vi.advanceTimersByTime(500)
    expect(read).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
    expect(MILESTONE_PROGRESS_TRIGGERS.has('blueprint.milestone_progress')).toBe(false)
  })

  it('remembers a blueprint-less project as absent until invalidated', () => {
    const read = vi.fn(() => null)
    const { b, sent } = make(read)
    b.observe({ type: 'ticket_updated' } as WsMessage)
    vi.advanceTimersByTime(150)
    expect(read).toHaveBeenCalledTimes(1)
    b.observe({ type: 'ticket_updated' } as WsMessage)
    vi.advanceTimersByTime(150)
    expect(read).toHaveBeenCalledTimes(1) // memoized absence — no re-read
    b.invalidate()
    b.observe({ type: 'ticket_updated' } as WsMessage)
    vi.advanceTimersByTime(150)
    expect(read).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(0)
  })

  it('persists a newly-done milestone ONCE and announces it after the progress', () => {
    const persistDone = vi.fn(() => true)
    const read = vi.fn(() => ({ blueprint: blueprint(), progress: [progress('done')] }))
    const { b, sent } = make(read, persistDone)
    b.flush()
    expect(persistDone).toHaveBeenCalledWith('m1')
    expect(sent.map((m) => m.type)).toEqual(['blueprint.milestone_progress', 'blueprint.milestone_completed'])
    expect((sent[0] as { progress: MilestoneProgress[] }).progress[0].storedStatus).toBe('done')
    expect(sent[1]).toMatchObject({ milestoneId: 'm1', n: 1, title: 'Walking skeleton' })
    // Already stored done ⇒ no second write, no second announcement.
    read.mockReturnValue({ blueprint: blueprint(), progress: [progress('done', 'done')] })
    b.flush()
    expect(persistDone).toHaveBeenCalledTimes(1)
    expect(sent.filter((m) => m.type === 'blueprint.milestone_completed')).toHaveLength(1)
  })

  it('a persist that wrote nothing announces nothing; read errors are swallowed', () => {
    const { b, sent } = make(() => ({ blueprint: blueprint(), progress: [progress('done')] }), vi.fn(() => false))
    b.flush()
    expect(sent.map((m) => m.type)).toEqual(['blueprint.milestone_progress'])
    const boom = make(() => { throw new Error('disk') })
    expect(boom.b.flush()).toBeNull()
    expect(boom.sent).toHaveLength(0)
  })

  it('dispose cancels a pending flush', () => {
    const read = vi.fn(() => ({ blueprint: blueprint(), progress: [] }))
    const { b } = make(read)
    b.observe({ type: 'ticket_updated' } as WsMessage)
    b.dispose()
    vi.advanceTimersByTime(500)
    expect(read).not.toHaveBeenCalled()
    b.observe({ type: 'ticket_updated' } as WsMessage)
    expect(b.flush()).toBeNull()
  })
})

describe('toPrDeliverySnapshot round-trip used by the reader', () => {
  it('keeps the created row readable after a transition', () => {
    const db = initDb(':memory:')
    const d = createPrDelivery(db, { railIndex: 1, railKey: 'k', ticketIds: [1], baseBranch: 'main', loopName: 'L', originSurface: 'dashboard' })
    transitionDecision(db, d.id, 'building', 'on_review', {})
    expect(toPrDeliverySnapshot(getPrDelivery(db, d.id)!).decision).toBe('on_review')
  })
})
