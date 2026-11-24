import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'v2-wp2-overview-test-token' }))
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createHarness, call, type Harness } from '../__fixtures__/harness'
import { registerV2Surface } from '../index'
import { buildToolSpecs } from '../../tools/catalog'
import { approxTokens } from '../core/size-guard'
import { matchesPointer } from '../core/untrusted'
import { createLoopRun, finishLoopRun, pauseLoopRun } from '../../../modules/loops/runtime/loop-runs-store'
import { createPrDelivery, transitionDecision } from '../../../modules/delivery/runtime/rail-pr-store'
import { dismissInboxItem } from '../../../mobile/mobile-inbox'
import type { DbInstance } from '../../../db'
import { cardStatus } from './overview'
import { manyProjects, startDesktop, type FakeDesktop } from './__fixtures__/wp2-desktop'

// specrails_overview over the REAL live-board and inbox routes (fake desktop with
// in-memory project databases): one call answers "what is going on".

const HOUR = 3_600_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const QUESTION = { id: 'q1', nodePath: 'developer', kind: 'question', value: { kind: 'question', prompt: 'Which database?', text: 'Which database?', asker: 'build', options: [{ id: 'pg', label: 'Postgres' }, { id: 'lite', label: 'SQLite' }], recommended: 'pg' } }

let h: Harness
let desktop: FakeDesktop
let client: Client
let alpha: DbInstance
let beta: DbInstance

function run(db: DbInstance, projectId: string, id: string, rail: number | null = null, startedAt = ago(HOUR)) {
  createLoopRun(db, { id, projectId, loopId: 'loop-a', loopName: 'Implement', railIndex: rail, ticketIds: [7], iterationLimit: 3, startedAt, provider: 'claude' })
}
function asking(db: DbInstance, projectId: string, id: string) {
  run(db, projectId, id)
  pauseLoopRun(db, id)
  db.prepare('UPDATE loop_runs SET runtime_status_json=? WHERE id=?').run(JSON.stringify({ pendingInterrupts: [QUESTION] }), id)
}
function review(db: DbInstance, id: string, rail: number) {
  createPrDelivery(db, { id, railIndex: rail, loopId: 'loop-a', railKey: `${rail}-loop-a`, ticketIds: [rail + 1], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent', originConversationId: null })
  expect(transitionDecision(db, id, 'building', 'on_review')).toBe(true)
}
function seed() {
  asking(alpha, 'p1', 'r-ask')
  review(alpha, 'd-review', 0)
  run(beta, 'p2', 'r-live', 1)
  run(beta, 'p2', 'r-done', 2, ago(2 * HOUR))
  finishLoopRun(beta, 'r-done', { outcome: 'success', finishedAt: ago(60_000) })
  run(beta, 'p2', 'r-fail', 3)
  finishLoopRun(beta, 'r-fail', { outcome: 'failed', finishedAt: ago(120_000) })
}

async function boot(projects?: Array<{ id: string; slug: string; name: string; path: string }>) {
  h = createHarness({ projects: projects ?? [{ id: 'p1', slug: 'shop-api', name: 'Shop API', path: '/tmp/v2-shop-api' }, { id: 'p2', slug: 'blog', name: 'Blog', path: '/tmp/v2-blog' }] })
  desktop = await startDesktop(h)
  alpha = desktop.dbs.get('p1')!
  beta = desktop.dbs.get('p2')!
  registerV2Surface(h.server, h.ctx, buildToolSpecs(), { inApp: false })
  client = await h.connect()
}
beforeEach(async () => { await boot() })
afterEach(async () => { await client.close(); await desktop.close() })

const overview = (args: Record<string, unknown>) => call(client, 'specrails_overview', args)

describe('specrails_overview(app)', () => {
  it('answers mood, counts, what needs the person with offers, running and delivered work, spend, quota and next calls', async () => {
    seed()
    desktop.quota = [{ providerId: 'claude', level: 'warning', usedPercent: 82.4, windowId: '5h', rejectedUntil: null, rejectedIndefinitely: false, windows: [], observedAt: null }, { providerId: 'codex', level: 'ok', usedPercent: 10, windowId: null, rejectedUntil: null, rejectedIndefinitely: false, windows: [], observedAt: null }]
    desktop.turns = [{ conversationId: 'c-1', startedAt: ago(1000) }]
    const { envelope, text, isError } = await overview({ action: 'app' })
    expect(isError).toBe(false)
    const data = envelope.data
    expect(data.mood).toBe('needs_you')
    expect(data.counts).toMatchObject({ needsYou: 3, failing: 1, projects: 2, missionsRunning: 1 })
    expect(data.counts.running).toBeGreaterThanOrEqual(1)
    expect(data.needsYou.map((item: { kind: string }) => item.kind)).toEqual(['question', 'review', 'failed'])
    expect(data.needsYou[0]).toMatchObject({ ref: 'inbox:p1:question:r-ask' })
    expect(data.needsYou[0].choices[0]).toMatchObject({ id: 'answer.pg', recommended: true })
    expect(data.running).toContainEqual(expect.objectContaining({ ref: 'run:blog/r-live', status: 'running', provider: 'claude' }))
    expect(data.delivered).toContainEqual(expect.objectContaining({ ref: 'run:blog/r-done', status: 'succeeded' }))
    expect(data.spend).toEqual({ todayUsd: 0 })
    expect(data.quota).toEqual([{ provider: 'claude', level: 'warning', usedPercent: 82 }])
    expect(data.missions).toEqual(['mission:c-1'])
    expect(data.next[0]).toMatchObject({ call: { tool: 'specrails_inbox', args: { action: 'act', ref: 'inbox:p1:question:r-ask', offerId: 'answer.pg' } } })
    expect(envelope.summary).toMatch(/waiting for you.*1 failed or blocked.*Most urgent: “Implement · #7” in Shop API\.$/)
    expect(envelope.untrusted.some((pattern: string) => matchesPointer(pattern, '/data/needsYou/0/title'))).toBe(true)
    expect(envelope.untrusted.some((pattern: string) => matchesPointer(pattern, '/data/running/0/title'))).toBe(true)
    expect(approxTokens(text)).toBeLessThanOrEqual(1500)
  })

  it('its next call runs as is (inbox act on the recommended offer)', async () => {
    seed()
    desktop.on('POST', '/projects/p1/jobs/r-ask/messages', { ok: true })
    const { envelope } = await overview({ action: 'app' })
    const next = await call(client, envelope.data.next[0].call.tool, envelope.data.next[0].call.args)
    expect(next.envelope.ok).toBe(true)
    expect(desktop.calls.find((c) => c.method === 'POST')?.body).toEqual({ text: 'Postgres', interruptId: 'q1', optionId: 'pg' })
  })

  it('is idle when nothing happens, and points at the projects', async () => {
    const { envelope } = await overview({ action: 'app', lang: 'en' })
    expect(envelope.data).toMatchObject({ mood: 'idle', needsYou: [], running: [], next: [{ call: { tool: 'specrails_projects', args: { action: 'list' } } }] })
    expect(envelope.summary).toBe('All quiet: nothing running and nothing waiting for you; 0.00 USD spent today.')
  })

  it('leaves out what the person snoozed or marked done server-side', async () => {
    seed()
    expect((await call(client, 'specrails_inbox', { action: 'done', ref: 'inbox:p1:question:r-ask' })).envelope.ok).toBe(true)
    dismissInboxItem(h.db, { itemId: 'p1:review:d-review', version: 'an-older-version' })
    const { envelope } = await overview({ action: 'app' })
    expect(envelope.data.needsYou.map((item: { ref: string }) => item.ref)).toEqual(['inbox:p1:review:d-review', 'inbox:p2:failed:r-fail'])
  })

  it('says which source was unavailable instead of failing', async () => {
    seed()
    desktop.on('GET', '/provider-quota', (_req: unknown, res: { status(code: number): { json(body: unknown): void } }) => { res.status(500).json({ error: 'boom' }) })
    desktop.on('GET', '/agent/active-turns', (_req: unknown, res: { status(code: number): { json(body: unknown): void } }) => { res.status(404).json({ error: 'Not Found' }) })
    const { envelope } = await overview({ action: 'app' })
    expect(envelope.ok).toBe(true)
    expect(envelope.warnings).toEqual(['partial: provider-quota unavailable (HTTP 500)'])
  })

  it('detail lists more and adds mission lanes', async () => {
    seed()
    const { envelope, text } = await overview({ action: 'app', view: 'detail', fields: ['lanes'] })
    expect(envelope.data.lanes.length).toBeGreaterThan(0)
    expect(envelope.data.running[0]).toHaveProperty('specs')
    expect(approxTokens(text)).toBeLessThanOrEqual(6000)
    expect((await overview({ action: 'app', view: 'detail', fields: ['bogus'] })).isError).toBe(true)
  })
})

describe('specrails_overview(live)', () => {
  it('shows the three columns, optionally for one project; detail adds lanes', async () => {
    seed()
    const all = await overview({ action: 'live' })
    expect(all.envelope.data.counts).toMatchObject({ needs: 3 })
    expect(all.envelope.data.done.map((card: { ref: string }) => card.ref)).toContain('run:blog/r-done')
    expect(all.envelope.data.needs.find((card: { item?: string }) => card.item === 'inbox:p1:review:d-review').ref).toBe('delivery:shop-api/d-review')
    const blog = await overview({ action: 'live', project: 'blog' })
    expect(blog.envelope.data.needs.every((card: { ref: string }) => /:blog\//.test(card.ref) || card.ref.startsWith('inbox:p2:'))).toBe(true)
    expect(blog.envelope.refs).toEqual({ project: 'project:blog' })
    expect(blog.envelope.summary).toMatch(/\(blog\)\.$/)
    const detail = await overview({ action: 'live', view: 'detail' })
    expect(detail.envelope.data.lanes.length).toBeGreaterThan(0)
  })
})

describe('specrails_overview(project)', () => {
  beforeEach(() => {
    desktop.on('GET', /^\/projects\/p1\/tickets\?groupBy=status/, { groups: [{ status: 'todo', count: 3, tickets: [{ id: 4, title: 'Add login', priority: 'high' }] }, { status: 'in_progress', count: 1, tickets: [] }], total: 4, matched: 4 })
    desktop.on('GET', '/projects/p1/rails', { rails: [{ railIndex: 0, name: 'UI', availability: 'busy', ticketIds: [4] }, { railIndex: 1, name: null, availability: 'free', ticketIds: [] }], activeJobs: {}, activeLoopRuns: { 0: { loopRunId: 'r-live', loopName: 'Implement', startedAt: '2026-11-21T10:00:00.000Z' } }, prDeliveries: { 1: { id: 'd1', decision: 'on_review' } } })
    desktop.on('GET', '/projects/p1/queue', { jobs: [{ id: 'j1', status: 'queued' }, { id: 'j2', status: 'running' }], paused: true, activeJobId: 'j2' })
    desktop.on('GET', '/projects/p1/blueprint', { blueprint: { product: { name: 'Shop' }, milestones: [{ title: 'M1', status: 'done' }, { title: 'M2' }] } })
  })

  it('answers columns, rails with run and delivery refs, and the queue', async () => {
    const { envelope } = await overview({ action: 'project', project: 'shop' })
    expect(envelope.data).toMatchObject({
      project: 'project:shop-api',
      specs: { total: 4, columns: { todo: 3, in_progress: 1 } },
      rails: [
        { ref: 'rail:shop-api/0', label: 'UI', specs: ['spec:shop-api/4'], running: { ref: 'run:shop-api/r-live', kind: 'loop' } },
        { ref: 'rail:shop-api/1', label: 'Rail 2', availability: 'free', delivery: { ref: 'delivery:shop-api/d1', status: 'ready_for_review' } },
      ],
      queue: { queued: 1, paused: true, active: 'run:shop-api/j2' },
    })
    expect(envelope.summary).toBe('Shop API: 4 specs (todo 3, in progress 1); 2 rails, 2 running, 1 awaiting review; 1 queued (queue paused).')
  })

  it('words the spec columns of the summary in the call\'s language', async () => {
    const { envelope } = await overview({ action: 'project', project: 'shop', lang: 'es' })
    expect(envelope.summary).toMatch(/\(por hacer 3, en curso 1\)/)
    expect(envelope.summary).not.toMatch(/todo|in progress/)
  })

  it('detail adds the newest specs per column and the blueprint', async () => {
    const { envelope } = await overview({ action: 'project', project: 'p1', view: 'detail' })
    expect(envelope.data.top).toEqual({ todo: [{ ref: 'spec:shop-api/4', title: 'Add login', priority: 'high' }] })
    expect(envelope.data.blueprint).toEqual({ product: 'Shop', milestones: [{ title: 'M1', status: 'done' }, { title: 'M2' }], total: 2 })
    expect(envelope.untrusted).toContain('/data/blueprint')
  })

  it('uses the session default project, and asks when there is none', async () => {
    expect((await overview({ action: 'project' })).envelope.error).toMatchObject({ code: 'ambiguous', choices: expect.any(Array) })
    await call(client, 'specrails_projects', { action: 'select', project: 'shop-api' })
    expect((await overview({ action: 'project' })).envelope.data.project).toBe('project:shop-api')
  })
})

describe('specrails_overview(context)', () => {
  it('summarizes the briefing; detail returns every section', async () => {
    desktop.on('GET', /^\/projects\/p1\/tickets\?limit=/, { tickets: [{ id: 4, title: 'Add login', status: 'todo' }], total: 1, statusCounts: { todo: 1 }, nextCursor: null })
    desktop.on('GET', '/projects/p1/rails', { rails: [{ railIndex: 0, name: 'UI' }], activeJobs: {}, activeLoopRuns: {}, prDeliveries: {} })
    desktop.on('GET', /^\/projects\/p1\/jobs\?limit=/, { jobs: [{ id: 'j1', command: '/sr:implement #4', status: 'completed' }], total: 1 })
    desktop.on('GET', '/projects/p1/git', { git: true, branch: 'main', dirty: true, worktrees: [] })
    desktop.on('GET', '/projects/p1/blueprint', { blueprint: { product: 'Shop', milestones: [] } })
    const { envelope } = await overview({ action: 'context', project: 'shop-api' })
    expect(envelope.data).toMatchObject({
      backlog: { total: 1, recent: [{ ref: 'spec:shop-api/4', title: 'Add login', status: 'todo' }] },
      rails: { total: 1 }, runs: { recent: [{ ref: 'run:shop-api/j1', status: 'succeeded' }] }, git: { branch: 'main', dirty: true },
    })
    expect(envelope.summary).toBe('Shop API briefing: 1 specs, 1 rails, branch main (uncommitted changes).')
    const detail = await overview({ action: 'context', project: 'shop-api', view: 'detail' })
    expect(Object.keys(detail.envelope.data.sections).sort()).toEqual(['backlog', 'blueprint', 'git', 'overview', 'runs'])
    expect(detail.envelope.untrusted).toContain('/data/sections')
  })
})

describe('card status mapping', () => {
  it('maps every card source through the status map', () => {
    expect(cardStatus({ source: 'job', status: 'running' })).toBe('running')
    expect(cardStatus({ source: 'loop-run', status: 'completed', outcome: 'failed', restartReason: null })).toBe('failed')
    expect(cardStatus({ source: 'loop-run', status: 'paused', outcome: null, restartReason: null })).toBe('paused')
    expect(cardStatus({ source: 'delivery', decision: 'building', statusCode: null, queued: { waitingFor: 'run_slots', position: 1 } })).toBe('queued')
    expect(cardStatus({ source: 'delivery', decision: 'merged', statusCode: null })).toBe('integrated')
    expect(cardStatus({ source: 'intent', state: 'needs-review' })).toBe('ready_for_review')
    expect(cardStatus({ source: 'attention' })).toBe('needs_you')
  })
})

describe('specrails_overview at 100 projects', () => {
  it('answers app and live within the latency and size budgets', async () => {
    await client.close(); await desktop.close()
    await boot(manyProjects(100))
    for (const [id, db] of desktop.dbs) {
      asking(db, id, `${id}-ask`)
      review(db, `${id}-d`, 0)
      run(db, id, `${id}-live`, 1)
      run(db, id, `${id}-done`, 2, ago(2 * HOUR))
      finishLoopRun(db, `${id}-done`, { outcome: 'success', finishedAt: ago(60_000) })
    }
    await overview({ action: 'app' })
    const timings: number[] = []
    let last = { text: '', envelope: {} as Record<string, any> }
    for (let i = 0; i < 5; i++) {
      const started = performance.now()
      last = await overview({ action: 'app' })
      timings.push(performance.now() - started)
    }
    const p95 = [...timings].sort((a, b) => a - b)[timings.length - 1]
    expect(last.envelope.data.counts).toMatchObject({ needsYou: 200, projects: 100 })
    expect(approxTokens(last.text)).toBeLessThanOrEqual(1500)
    const live = await overview({ action: 'live' })
    expect(approxTokens(live.text)).toBeLessThanOrEqual(1500)
    console.info(`[wp2 perf] overview(app) 100 projects / 500 runs: max ${p95.toFixed(0)} ms over 5, ~${approxTokens(last.text)} tokens; live ~${approxTokens(live.text)} tokens`)
    expect(p95).toBeLessThan(1500)
  // Fixture setup (100 migrated in-memory project DBs) takes ~10s alone; the latency budget is asserted
  // on the measured calls only, so give setup headroom under full-suite load.
  }, 60_000)
})
