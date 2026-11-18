import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createPrDelivery, transitionDecision } from '../../delivery/runtime/rail-pr-store'
import { createLoopRun, finishLoopRun, pauseLoopRun } from '../../loops/runtime/loop-runs-store'
import { collectInbox } from '../../inbox'
import { createInboxSources } from '../../inbox/adapters/http'
import { collectLiveBoard } from '../application'
import type { DayWindow, LiveBoardSnapshot } from '../domain'
import { createMissionDirectory } from '../adapters/missions'
import { createProjectLiveBoardSource } from '../adapters/project-source'
import { registerLiveBoardRoutes } from '../adapters/http'
import { listenOnLoopback } from '../../../__fixtures__/loopback-test-server'

const NOW = new Date('2026-11-18T12:00:00.000Z')
const DAY: DayWindow = { from: '2026-11-18T00:00:00.000Z', to: '2026-11-19T00:00:00.000Z' }
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString()
const HOUR = 3_600_000

let alpha: DbInstance
let beta: DbInstance
let desktop: DbInstance
beforeEach(() => {
  alpha = initDb(':memory:')
  beta = initDb(':memory:')
  desktop = initDesktopDb(':memory:')
})
afterEach(() => vi.restoreAllMocks())

function loopRun(db: DbInstance, projectId: string, id: string, patch: { rail?: number | null; startedAt?: string; provider?: string } = {}) {
  createLoopRun(db, { id, projectId, loopId: 'loop-a', loopName: 'Implement', railIndex: patch.rail ?? null, ticketIds: [7], iterationLimit: 3, startedAt: patch.startedAt ?? at(-HOUR), provider: patch.provider ?? 'claude' })
}

function queueJob(db: DbInstance, id: string, status: string, patch: { startedAt?: string; finishedAt?: string | null; cost?: number | null } = {}) {
  db.prepare(`INSERT INTO jobs (id, command, started_at, finished_at, status, total_cost_usd, provider, owner) VALUES (?, ?, ?, ?, ?, ?, 'codex', 'queue')`)
    .run(id, `/sr:implement #${id}`, patch.startedAt ?? at(-HOUR), patch.finishedAt ?? null, status, patch.cost ?? null)
}

function mission(id: string, title: string, provider = 'claude') {
  desktop.prepare(`INSERT INTO agent_conversations (id, title, provider) VALUES (?, ?, ?)`).run(id, title, provider)
}

const contexts = () => [
  { project: { id: 'p1', name: 'Alpha' }, db: alpha, railLoopRuns: new Map<string, { originConversationId?: string }>() },
  { project: { id: 'p2', name: 'Beta' }, db: beta, railLoopRuns: new Map<string, { originConversationId?: string }>() },
]

function snapshot(list = contexts()): LiveBoardSnapshot {
  const inbox = collectInbox(createInboxSources({ listContexts: () => list } as never, () => NOW.getTime()), () => NOW)
  return collectLiveBoard({
    sources: list.map((ctx) => createProjectLiveBoardSource({ project: ctx.project, db: ctx.db, liveRunMissions: () => ctx.railLoopRuns })),
    attention: inbox.items,
    missions: createMissionDirectory(desktop),
    todaySpend: { read: () => ({ costUsd: 4.82, estimated: false }) },
    day: DAY,
    now: () => NOW,
  })
}

describe('live board projection', () => {
  it('collects every kind of run across projects, each card in one column', () => {
    mission('m1', 'Records and screens')
    // Alpha: a rail delivery waiting for review, a live shared-checkout rail run, a paused run asking, a run done today.
    loopRun(alpha, 'p1', 'r-deliv', { rail: 0 })
    finishLoopRun(alpha, 'r-deliv', { outcome: 'success', finishedAt: at(-30 * 60_000) })
    createPrDelivery(alpha, { id: 'd1', railIndex: 0, loopId: 'loop-a', railKey: '0-loop-a', ticketIds: [7], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent', originConversationId: 'm1' })
    alpha.prepare(`UPDATE rail_pr_deliveries SET run_ids = '["r-deliv"]' WHERE id = 'd1'`).run()
    expect(transitionDecision(alpha, 'd1', 'building', 'on_review')).toBe(true)
    loopRun(alpha, 'p1', 'r-live', { rail: 1 })
    loopRun(alpha, 'p1', 'r-ask')
    pauseLoopRun(alpha, 'r-ask')
    loopRun(alpha, 'p1', 'r-done', { startedAt: at(-3 * HOUR) })
    finishLoopRun(alpha, 'r-done', { outcome: 'success', finishedAt: at(-2 * HOUR) })
    loopRun(alpha, 'p1', 'r-yesterday', { startedAt: at(-30 * HOUR) })
    finishLoopRun(alpha, 'r-yesterday', { outcome: 'success', finishedAt: at(-26 * HOUR) })
    // Beta: a queued and a running board job, an open Intent session.
    queueJob(beta, 'j-run', 'running')
    queueJob(beta, 'j-queued', 'queued')
    beta.prepare(`INSERT INTO job_phases (job_id, phase, state, updated_at) VALUES ('j-run','architect','done',?),('j-run','developer','running',?),('j-run','reviewer','idle',?)`).run(at(0), at(0), at(0))
    beta.prepare(`INSERT INTO flow_sessions (id, conversation_id, state, created_at, updated_at) VALUES ('f1','m2','active',?,?)`).run(at(-HOUR), at(-HOUR))
    mission('m2', 'Pricing page', 'codex')

    const list = contexts()
    list[0].railLoopRuns.set('r-live', { originConversationId: 'm1' })
    const board = snapshot(list)
    const byId = Object.fromEntries(board.cards.map((c) => [c.id, c]))

    expect(byId['p1:delivery:d1']).toMatchObject({ column: 'needs', kind: 'rail', conversationId: 'm1', jobId: 'r-deliv', attention: { kind: 'review', subjectId: 'd1' } })
    // The delivery speaks for its run: the run is not a second card.
    expect(byId['p1:loop-run:r-deliv']).toBeUndefined()
    expect(byId['p1:loop-run:r-live']).toMatchObject({ column: 'working', kind: 'rail', conversationId: 'm1' })
    expect(byId['p1:loop-run:r-ask']).toMatchObject({ column: 'needs', attention: { kind: 'question' } })
    expect(byId['p1:loop-run:r-done']).toMatchObject({ column: 'done', kind: 'loop' })
    expect(byId['p1:loop-run:r-yesterday']).toBeUndefined()
    expect(byId['p2:job:j-run']).toMatchObject({ column: 'working', kind: 'job', phase: 'developer', steps: { done: 1, total: 3 }, provider: 'codex' })
    expect(byId['p2:job:j-queued']).toMatchObject({ column: 'working', status: { source: 'job', status: 'queued' } })
    // An Intent session is named by its mission.
    expect(byId['p2:intent:f1']).toMatchObject({ column: 'working', kind: 'intent', title: 'Pricing page', conversationId: 'm2' })

    expect(board.totals).toMatchObject({ needsYou: 2, inProgress: 4, doneToday: 1, costTodayUsd: 4.82 })
    expect(board.projects).toEqual([{ projectId: 'p1', projectName: 'Alpha', count: 4 }, { projectId: 'p2', projectName: 'Beta', count: 3 }])
    // Lanes: the mission with something that needs a decision first, the free runs last.
    expect(board.lanes.map((lane) => lane.conversationId)).toEqual(['m1', 'm2', null])
    expect(board.lanes[0]).toMatchObject({ title: 'Records and screens', provider: 'claude', cardIds: ['p1:delivery:d1', 'p1:loop-run:r-live'] })
  })

  it('agrees with the inbox: every inbox item is on the board exactly once', () => {
    loopRun(alpha, 'p1', 'r-old-fail', { rail: 3, startedAt: at(-40 * HOUR) })
    finishLoopRun(alpha, 'r-old-fail', { outcome: 'failed', finishedAt: at(-36 * HOUR) })
    loopRun(alpha, 'p1', 'r-budget')
    pauseLoopRun(alpha, 'r-budget', undefined, 'budget_paused')
    const inbox = collectInbox(createInboxSources({ listContexts: contexts } as never, () => NOW.getTime()), () => NOW)
    const board = snapshot()
    const onBoard = board.cards.flatMap((c) => (c.attention ? [c.attention.id] : []))
    expect(onBoard.sort()).toEqual(inbox.items.map((i) => i.id).sort())
    // A failure older than today still needs the person: it shows as the inbox item itself.
    expect(board.cards.find((c) => c.attention?.subjectId === 'r-old-fail')).toMatchObject({ column: 'needs', status: { source: 'attention' }, kind: 'rail' })
  })

  it('isolates a broken project: the others still answer', () => {
    loopRun(beta, 'p2', 'r-beta')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = { project: { id: 'p1', name: 'Alpha' }, db: { prepare: () => { throw new Error('database is locked') } } as unknown as DbInstance, railLoopRuns: new Map() }
    const board = snapshot([broken, contexts()[1]])
    expect(board.cards.map((c) => c.id)).toEqual(['p2:loop-run:r-beta'])
    expect(board.projects.map((p) => p.count)).toEqual([0, 1])
  })

  it('reads only its own project: rows of another project in the same database are ignored', () => {
    loopRun(alpha, 'p-other', 'r-foreign')
    expect(snapshot().cards).toEqual([])
  })

  it('records the question a paused run asks, when its runtime has one', () => {
    loopRun(alpha, 'p1', 'r-q')
    pauseLoopRun(alpha, 'r-q')
    alpha.prepare(`UPDATE loop_runs SET runtime_status_json = ? WHERE id = 'r-q'`).run(JSON.stringify({ pendingInterrupts: [{ id: 'i1', nodePath: 'plan', kind: 'question', value: { question: 'Per device or synced?' } }] }))
    expect(snapshot().cards[0]).toMatchObject({ question: 'Per device or synced?', column: 'needs' })
  })

  it('adds a mission\'s own turns today to its lane and survives a missing mission', () => {
    mission('m1', 'Seasons')
    desktop.prepare(`INSERT INTO agent_invocations (id, conversation_id, status, started_at, total_cost_usd) VALUES ('a1','m1','completed',?,1.25),('a2','m1','completed',?,9)`).run(at(-HOUR), at(-30 * HOUR))
    loopRun(alpha, 'p1', 'r1', { rail: 0 })
    loopRun(alpha, 'p1', 'r2', { rail: 1 })
    alpha.prepare(`INSERT INTO ai_invocations (id, project_id, surface, status, started_at, total_cost_usd, loop_run_id) VALUES ('i1','p1','loop','completed',?,0.5,'r1')`).run(at(-HOUR))
    const list = contexts()
    list[0].railLoopRuns.set('r1', { originConversationId: 'm1' })
    list[0].railLoopRuns.set('r2', { originConversationId: 'gone' })
    const board = snapshot(list)
    expect(board.lanes.find((l) => l.conversationId === 'm1')).toMatchObject({ title: 'Seasons', todayCostUsd: 1.75 })
    expect(board.lanes.find((l) => l.conversationId === 'gone')).toMatchObject({ title: null })
  })
})

describe('GET /api/live-board', () => {
  it('answers the projection for the registered projects', async () => {
    loopRun(alpha, 'p1', 'r1')
    const router = express.Router()
    const registry = {
      listContexts: () => [{ project: { id: 'p1', name: 'Alpha' }, db: alpha, railLoopRuns: new Map() }],
      desktopDb: desktop,
    }
    registerLiveBoardRoutes(router, registry as never)
    const app = express(); app.use('/api', router)
    const fixture = await listenOnLoopback(app)
    try {
      const res = await fetch(`${fixture.baseUrl}/api/live-board`)
      expect(res.status).toBe(200)
      const body = await res.json() as LiveBoardSnapshot
      expect(body.cards.map((c) => c.id)).toEqual(['p1:loop-run:r1'])
      expect(body.totals).toMatchObject({ inProgress: 1, costTodayUsd: 0 })
      expect(body.day.from < body.day.to).toBe(true)
      expect(body.lanes).toHaveLength(1)
    } finally {
      await fixture.close()
    }
  })
})
