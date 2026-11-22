import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'v2-runs-test-token-no-filesystem-access' }))
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { setDesktopSetting } from '../../../desktop-db'
import { rankRemedies } from '../../../modules/recovery'
import { createHarness, call } from '../__fixtures__/harness'
import { registerV2Tool } from '../core/registry'
import { approxTokens } from '../core/size-guard'
import { ConfirmationLedger } from '../core/confirm'
import { v2Catalog } from '../index'
import { runsTool } from './runs'
import { railsTool } from './rails'

// specrails_runs through the shared harness: every read view, each offer path
// to the route the run window calls, the confirmation protocol and the budgets.

type Reply = { status?: number; body: unknown }
let routes: Map<string, Reply | ((body: unknown) => Reply)>
let calls: Array<{ method: string; path: string; body: unknown }>
let client: Client

const P = '/projects/p1'
const RUN = 'run:shop-api/r1'
const ev = (event_type: string, payload: unknown) => ({ event_type, payload: JSON.stringify(payload), timestamp: '2026-11-21T10:00:00Z' })
const say = (text: string) => ev('assistant', { type: 'assistant', message: { content: [{ type: 'text', text }] } })
const EVENTS = [
  ev('loop_step', { index: 1, title: 'plan' }), ev('log', { line: 'planning the change' }), say('I will add the login form.'), ev('loop_step_end', { status: 'succeeded' }),
  ev('loop_step', { index: 2, title: 'developer' }), ...Array.from({ length: 30 }, (_, i) => ev('log', { line: `dev line ${i}` })), ev('loop_step_end', { status: 'failed' }),
  ev('loop_step', { index: 3, title: 'review' }), ev('log', { line: 'review skipped' }),
]
const LOOP_RUN = { id: 'r1', loop_id: 'factory:implement', loop_name: 'Implement', rail_index: 0, provider: 'claude', model: 'sonnet', engine_version: 2, status: 'running', iteration_count: 1,
  runtime_status_json: JSON.stringify({ status: 'running', nextStep: 'developer', steps: { plan: { status: 'succeeded' }, developer: { status: 'running', visits: 2 } } }) }
const LIMIT = { providerId: 'claude', resumeAt: '2026-11-21T12:00:00Z', autoResume: true, message: 'limit', pausedAt: '2026-11-21T10:00:00Z', switchable: true, switchRoles: ['developer'], switchTargets: [{ provider: 'codex', model: 'gpt-5.5', effort: 'high' }] }
const base = { id: 'r1', command: 'loop: Implement', provider: 'claude', model: 'sonnet', total_cost_usd: 1.25, started_at: '2026-11-21T09:00:00Z', finished_at: null, tickets: [{ id: 12, title: 'Add login' }] }
const JOBS = {
  limit: { ...base, status: 'running', hold: { kind: 'provider_limit', step: 'developer', since: '2026-11-21T10:00:00Z', resumeAt: '2026-11-21T12:00:00Z' }, loopPauseLimit: LIMIT },
  budget: { ...base, status: 'running', hold: { kind: 'budget', step: 'developer', since: '2026-11-21T10:00:00Z' } },
  question: { ...base, status: 'running', hold: { kind: 'question', step: 'planner', since: '2026-11-21T10:00:00Z' },
    question: { interruptId: 'i1', kind: 'question', asker: 'planner', text: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sq', label: 'SQLite' }], recommended: 'pg', endsRun: [], mayEndRun: false, canReject: false } },
  approval: { ...base, status: 'running', hold: { kind: 'approval', step: 'developer', since: '2026-11-21T10:00:00Z' },
    question: { interruptId: 'a1', kind: 'approval', asker: 'developer', text: 'Run the migration?', options: [], endsRun: [], mayEndRun: true, canReject: true } },
  working: { ...base, status: 'running', pauseControl: 'pause' },
  failed: { ...base, status: 'failed', finished_at: '2026-11-21T10:30:00Z',
    failureDiagnosis: { kind: 'tests_failed', detail: '2 tests failed', phase: 'developer', confidence: 'high', remedies: rankRemedies({ kind: 'tests_failed', confidence: 'high', resumablePhase: 'verify' }), failingTests: ['a.test.ts › logs in'] } },
}
const ANALYSIS = { status: 'ready', provider: 'claude', createdAt: '2026-11-21T10:31:00Z', stale: false,
  analysis: { headline: 'The login test expects a redirect', cause: 'c', category: 'tests', failedStep: 'developer', evidence: [], nextSteps: [],
    options: [{ id: 'fix-redirect', kind: 'continue-with-guidance', label: 'Fix the redirect', does: 'd', consequence: 'Keeps the work', risk: 'low', recommended: true, guidance: 'g' }] } }
const ATTEMPTS = { chain: { runId: 'r1', attempt: 2, attempts: [{ runId: 'r0', attempt: 1, status: 'completed', outcome: 'failed', costUsd: 0.5 }, { runId: 'r1', attempt: 2, status: 'completed', outcome: 'failed', costUsd: 0.75 }] },
  continuable: true, resolution: { attempts: 2, costUsd: 1.25 }, providerSwitch: { providerId: 'claude', roles: ['developer'], targets: [{ provider: 'codex', model: 'gpt-5.5', effort: null }], via: 'fork' } }
const FORECAST = { time: { p25Ms: 360_000, p75Ms: 540_000 }, cost: { lowUsd: 0.1, highUsd: 0.3, sampleCount: 6 }, minSamples: 5 }
const PREFLIGHT = { chips: [{ id: 'quota:claude', kind: 'quota', state: 'warn', providerId: 'claude', level: 'warning', usedPercent: 85, rejectedUntil: null }], blocking: false }

function useJob(job: Record<string, unknown>, extra: { events?: unknown[]; loopRun?: Record<string, unknown> } = {}) {
  routes.set(`GET ${P}/jobs/r1`, { body: { job, events: extra.events ?? EVENTS } })
  routes.set(`GET ${P}/loop-runs/r1`, { body: { loopRun: { ...LOOP_RUN, status: job.status === 'running' ? 'running' : 'completed', ...extra.loopRun } } })
}

beforeAll(async () => {
  const harness = createHarness()
  harness.ctx.sessionState = { activeProjectId: 'p1', sessionKey: 'session-a' } as never
  setDesktopSetting(harness.db, 'mcp_confirm_above_usd', '0.5')
  const ledger = new ConfirmationLedger()
  for (const def of [runsTool, railsTool]) registerV2Tool(harness.server, harness.ctx, def, { catalog: v2Catalog(), ledger })
  client = await harness.connect()
})

beforeEach(() => {
  calls = []
  routes = new Map<string, Reply | ((body: unknown) => Reply)>([
    [`GET ${P}/loop-runs/r1/attempts`, { body: ATTEMPTS }],
    [`GET ${P}/jobs/r1/failure-analysis`, { body: ANALYSIS }],
    [`GET ${P}/agent-runtime/runs/r1`, { body: { runs: [{ runId: 'r1', engineVersion: 2, status: 'paused', recoverableSteps: ['att-1'], canResume: true, canCancel: false, canSettle: false, completion: { ok: false, verified: false, reasons: ['tests failed'] } }] } }],
    [`GET ${P}/launch-forecast`, { body: FORECAST }],
    ['GET /launch-preflight', { body: PREFLIGHT }],
    ['GET /capacity', { body: { enabled: false } }],
  ])
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const full = String(url).replace(/^http:\/\/127\.0\.0\.1:\d+\/api/, '')
    const path = full.split('?')[0]
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path: full, body })
    const route = routes.get(`${method} ${path}`)
    const reply = typeof route === 'function' ? route(body) : route ?? { status: 404, body: { error: 'not_found' } }
    return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, text: async () => JSON.stringify(reply.body) }
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

const runs = (args: Record<string, unknown>) => call(client, 'specrails_runs', args)
const posts = () => calls.filter((entry) => entry.method !== 'GET')
const offer = (envelope: Record<string, any>, id: string) => envelope.state.offers.find((candidate: { id: string }) => candidate.id === id)
/** Runs an offer's exact call, confirming when the server asks. */
async function act(call: { tool: string; args: Record<string, unknown> }, extra: Record<string, unknown> = {}) {
  const first = await runs({ ...call.args, ...extra })
  if (first.envelope.error?.code !== 'confirmation_required') return first
  return runs({ ...call.args, ...extra, confirm: first.envelope.error.confirmToken })
}

describe('specrails_runs reads', () => {
  it('lists a page with v2 statuses, holds, refs and a cursor', async () => {
    routes.set(`GET ${P}/jobs`, { body: { total: 3, jobs: [{ ...JOBS.limit, ticketId: 12 }, { ...JOBS.failed, id: 'r2' }] } })
    const { envelope } = await runs({ action: 'list', limit: 2 })
    expect(envelope.ok).toBe(true)
    expect(envelope.data.items).toMatchObject([
      { ref: RUN, status: 'blocked', hold: 'provider_limit', spec: 'spec:shop-api/12', title: '#12 Add login' },
      { ref: 'run:shop-api/r2', status: 'failed' },
    ])
    expect(envelope.page).toMatchObject({ total: 3, truncated: true })
    await runs({ action: 'list', limit: 2, cursor: envelope.page.cursor })
    expect(calls.at(-1)?.path).toContain('offset=2')
  })

  it('narrows by v2 status and needsYou, searches the logs, and lists app-wide without a project', async () => {
    routes.set(`GET ${P}/jobs`, { body: { total: 2, jobs: [JOBS.question, { ...JOBS.working, id: 'r3' }] } })
    const needs = await runs({ action: 'list', filter: { needsYou: true, status: ['needs_you'] } })
    expect(calls.at(-1)?.path).toContain('status=running')
    expect(needs.envelope.data.items.map((item: { ref: string }) => item.ref)).toEqual([RUN])

    routes.set(`GET ${P}/search/jobs`, { body: { results: [{ jobId: 'r1', command: 'loop: Implement', status: 'failed', startedAt: 'x', field: 'log', snippet: { text: 'TypeError at login' } }] } })
    const found = await runs({ action: 'list', filter: { q: 'TypeError' } })
    expect(found.envelope.data.items[0]).toMatchObject({ ref: RUN, status: 'failed', snippet: 'TypeError at login' })
    expect(found.envelope.untrusted).toContain('/data/items/*/snippet')

    routes.set('GET /runs', { body: {
      runs: [
        { id: 'r7', projectId: 'p1', command: '/specrails:implement #2', status: 'running', hold: { kind: 'question' }, started_at: '2026-11-21T10:00:00Z' },
        { id: 'j9', projectId: 'p1', command: '/specrails:implement #1', status: 'completed' },
      ],
      next: 'opaque-after', projects: { loaded: 1, notLoaded: 2, failed: [] },
    } })
    const harness = createHarness()
    harness.ctx.sessionState = { activeProjectId: null, sessionKey: 's-b' } as never
    registerV2Tool(harness.server, harness.ctx, runsTool, { catalog: v2Catalog() })
    const appClient = await harness.connect()
    const appWide = await call(appClient, 'specrails_runs', { action: 'list', limit: 2 })
    // Live runs carry their hold (decision vocabulary) like a project's list.
    expect(appWide.envelope.data.items).toEqual([
      expect.objectContaining({ ref: 'run:shop-api/r7', project: 'project:shop-api', status: 'needs_you', hold: 'question' }),
      expect.objectContaining({ ref: 'run:shop-api/j9', project: 'project:shop-api', status: 'succeeded' }),
    ])
    expect(appWide.envelope.page).toMatchObject({ truncated: true })
    expect(appWide.envelope.warnings).toEqual(['2 project(s) still loading: their runs are not listed yet.'])
    // The cursor carries the read model's keyset position; needsYou reads the live tier.
    await call(appClient, 'specrails_runs', { action: 'list', limit: 2, cursor: appWide.envelope.page.cursor })
    expect(calls.filter((entry) => entry.path.startsWith('/runs?')).map((entry) => entry.path)).toEqual(['/runs?limit=2', '/runs?limit=2&after=opaque-after'])
    await call(appClient, 'specrails_runs', { action: 'list', filter: { needsYou: true } })
    expect(calls[calls.length - 1].path).toBe('/runs?limit=25&status=running')
  })

  it('gets a limit-paused run: decision state, localized reason, offers and a lean summary', async () => {
    useJob(JOBS.limit)
    const { envelope, text } = await runs({ action: 'get', ref: RUN })
    expect(envelope.ok).toBe(true)
    expect(envelope.state).toMatchObject({ status: 'blocked', appState: 'blocked', hold: { kind: 'provider_limit', resumeAt: '2026-11-21T12:00:00Z' } })
    expect(envelope.state.offers.map((o: { id: string }) => o.id)).toEqual(['limit.resume_now', 'limit.auto', 'limit.switch', 'stop'])
    expect(envelope.summary).toContain('usage limit')
    expect(envelope.data).toMatchObject({ ref: RUN, specs: ['spec:shop-api/12'], rail: 'rail:shop-api/0', limit: { provider: 'claude', switchTargets: [{ provider: 'codex' }] }, step: { title: 'review', of: 3 } })
    expect(envelope.refs).toMatchObject({ run: RUN, spec: 'spec:shop-api/12', rail: 'rail:shop-api/0' })
    expect(envelope.untrusted).toEqual(expect.arrayContaining(['/data/title', '/data/logs/lines/*']))
    expect(approxTokens(text)).toBeLessThan(1500)
    // A summary never reads the attempts, the analysis or the runtime of a working run.
    expect(calls.map((entry) => entry.path.split('?')[0])).toEqual([`${P}/jobs/r1`, `${P}/loop-runs/r1`])
  })

  it('reports the engine a run moved to at a usage limit, not its launch engine', async () => {
    useJob(JOBS.working, { events: [...EVENTS, ev('provider_switched', { fromProvider: 'claude', provider: 'codex', model: 'gpt-6.2-sol', effort: 'medium', roles: ['developer', 'reviewer'] })] })
    const { envelope } = await runs({ action: 'get', ref: RUN })
    expect(envelope.data).toMatchObject({ provider: 'codex', model: 'gpt-6.2-sol', effort: 'medium', switchedFrom: 'claude' })
    useJob(JOBS.working)
    expect((await runs({ action: 'get', ref: RUN })).envelope.data).toMatchObject({ provider: 'claude', model: 'sonnet' })
  })

  it('gets a failed run with analysis options, attempts and the settled provider switch', async () => {
    useJob(JOBS.failed)
    routes.set(`GET ${P}/loop-runs/r0`, { body: { loopRun: { id: 'r0', provider: 'codex', model: 'gpt-5.5' } } })
    const { envelope } = await runs({ action: 'get', ref: RUN, view: 'detail', fields: ['attempts', 'cost', 'verification'] })
    expect(envelope.state.status).toBe('failed')
    expect(envelope.state.recommended).toBe('resolution.fix-redirect')
    expect(envelope.state.offers.map((o: { id: string }) => o.id)).toEqual(expect.arrayContaining(['resolution.fix-redirect', 'remedy.switch', 'remedy.retry', 'diagnose']))
    expect(envelope.data.failure).toMatchObject({ kind: 'tests_failed', failingTests: ['a.test.ts › logs in'] })
    expect(envelope.data.attempts).toMatchObject({ attempt: 2, continuable: true, attempts: [{ ref: 'run:shop-api/r0', n: 1 }, { ref: RUN, n: 2 }] })
    expect(envelope.data.cost).toMatchObject({ totalUsd: 1.25, chainUsd: 1.25 })
    expect(envelope.data.cost.byProvider).toEqual([
      expect.objectContaining({ provider: 'codex', costUsd: 0.5, runs: 1 }), expect.objectContaining({ provider: 'claude', costUsd: 0.75, runs: 1 })])
    expect(envelope.data.verification.completion).toMatchObject({ verified: false })
  })

  it('pages the log newest first with the failed step first, filters a step and refuses an unknown one', async () => {
    useJob(JOBS.failed)
    const first = await runs({ action: 'get', ref: RUN, view: 'detail', fields: ['logs'], options: { lines: 10 } })
    const logs = first.envelope.data.logs
    expect(logs.steps.map((step: { title: string }) => step.title)).toEqual(['developer', 'review'])
    expect(logs.lines.at(-1)).toBe('review skipped')
    expect(logs.lines).toHaveLength(10)
    const second = await runs({ action: 'get', ref: RUN, view: 'detail', fields: ['logs'], options: { lines: 10 }, cursor: logs.next })
    expect(second.envelope.data.logs.to).toBe(logs.from)
    const plan = await runs({ action: 'get', ref: RUN, view: 'detail', fields: ['logs'], options: { step: 'plan' } })
    expect(plan.envelope.data.logs.steps).toEqual([{ index: 1, title: 'plan', status: 'succeeded' }])
    expect(plan.envelope.data.logs.lines).toContain('planning the change')
    const unknown = await runs({ action: 'get', ref: RUN, view: 'detail', fields: ['logs'], options: { step: 'deploy' } })
    expect(unknown.envelope.error).toMatchObject({ code: 'invalid_input' })
  })

  it('keeps a huge log page inside the 4k logs budget', async () => {
    useJob(JOBS.failed, { events: [ev('loop_step', { index: 1, title: 'developer' }), ...Array.from({ length: 3000 }, (_, i) => ev('log', { line: `${i} ${'x'.repeat(380)}` })), ev('loop_step_end', { status: 'failed' })] })
    const { text, envelope } = await runs({ action: 'get', ref: RUN, view: 'detail', fields: ['logs'], options: { lines: 400 } })
    expect(envelope.data.logs.next).toBeTruthy()
    expect(approxTokens(JSON.stringify(envelope.data.logs))).toBeLessThan(4000)
    expect(approxTokens(text)).toBeLessThan(6000)
  })

  it('narrates steps, draws the graph and pages events', async () => {
    useJob(JOBS.working)
    const { envelope } = await runs({ action: 'get', ref: RUN, view: 'detail', fields: ['narrated', 'graph', 'steps', 'events'] })
    expect(envelope.data.narrated[0]).toMatchObject({ title: 'plan', status: 'succeeded', said: ['I will add the login form.'] })
    expect(envelope.data.graph).toMatchObject({ loop: { id: 'factory:implement' }, nextStep: 'developer', nodes: [{ id: 'plan', status: 'succeeded' }, { id: 'developer', status: 'running', visits: 2 }] })
    expect(envelope.data.steps).toHaveLength(3)
    expect(envelope.data.events.items).toHaveLength(25)
    expect(envelope.data.events.next).toBeTruthy()
    expect(envelope.state.offers.map((o: { id: string }) => o.id)).toEqual(['pause', 'stop'])
  })

  it('requires ref and rejects unknown detail sections', async () => {
    expect((await runs({ action: 'get' })).envelope.error.code).toBe('invalid_input')
    useJob(JOBS.working)
    expect((await runs({ action: 'get', ref: RUN, view: 'detail', fields: ['nope'] })).isError).toBe(true)
  })
})

describe('specrails_runs offers execute the run window\'s routes', () => {
  it('provider limit: try now, auto resume, switch (costly, confirmed)', async () => {
    useJob(JOBS.limit)
    routes.set(`POST ${P}/loop-runs/r1/limit`, { status: 202, body: { loopRunId: 'r1', resumed: true } })
    const state = (await runs({ action: 'get', ref: RUN })).envelope
    await act(offer(state, 'limit.resume_now').call)
    expect(posts().at(-1)).toMatchObject({ path: `${P}/loop-runs/r1/limit`, body: { action: 'resume' } })
    await act(offer(state, 'limit.auto').call)
    expect(posts().at(-1)?.body).toEqual({ action: 'auto', enabled: true })
    // Runs like this cost up to $0.30 here: under the $0.50 threshold the switch needs no token…
    await runs(offer(state, 'limit.switch').call.args)
    expect(posts().at(-1)?.body).toEqual({ action: 'switch', provider: 'codex', model: 'gpt-5.5', effort: 'high' })
    // …above it, it does.
    routes.set(`GET ${P}/launch-forecast`, { body: { ...FORECAST, cost: { lowUsd: 1, highUsd: 4, sampleCount: 6 } } })
    const first = await runs(offer(state, 'limit.switch').call.args)
    expect(first.envelope.error).toMatchObject({ code: 'confirmation_required', preview: { refs: [RUN], cost: { forecastUsd: [1, 4] } } })
    expect(first.envelope.error.preview.effect).toContain('1.00')
    await act(offer(state, 'limit.switch').call)
    expect(posts().at(-1)?.body).toEqual({ action: 'switch', provider: 'codex', model: 'gpt-5.5', effort: 'high' })
  })

  it('budget: run the next step only, ignore the cap, raise it', async () => {
    useJob(JOBS.budget)
    routes.set(`POST ${P}/loop-runs/r1/resume`, { status: 202, body: { loopRunId: 'r1', resumed: true } })
    const state = (await runs({ action: 'get', ref: RUN })).envelope
    expect(offer(state, 'budget.raise').needs).toEqual(['options.runCapUsd'])
    await act(offer(state, 'budget.once').call)
    expect(posts().at(-1)).toMatchObject({ path: `${P}/loop-runs/r1/resume`, body: { runCap: 'once' } })
    await act(offer(state, 'budget.raise').call, { options: { runCapUsd: 5 } })
    expect(posts().at(-1)?.body).toEqual({ runCapUsd: 5 })
    // Under the $0.50 threshold (forecast up to $0.30) a resume runs without a token.
    const direct = await runs({ action: 'resume', ref: RUN, options: { runCap: 'ignore' } })
    expect(direct.envelope.ok).toBe(true)
  })

  it('confirms a resume whose cost is unknown, then goes stale when the hold changes', async () => {
    useJob(JOBS.budget)
    routes.set(`GET ${P}/launch-forecast`, { body: { time: null, cost: null, minSamples: 5 } })
    routes.set(`POST ${P}/loop-runs/r1/resume`, { status: 202, body: { resumed: true } })
    const first = await runs({ action: 'resume', ref: RUN })
    expect(first.envelope.error.code).toBe('confirmation_required')
    expect(first.envelope.error.preview.effect).toContain('cannot be estimated')
    useJob({ ...JOBS.budget, hold: { kind: 'budget', step: 'developer', since: '2026-11-21T11:00:00Z' } })
    const stale = await runs({ action: 'resume', ref: RUN, confirm: first.envelope.error.confirmToken })
    expect(stale.envelope.error.code).toBe('stale')
    const ok = await runs({ action: 'resume', ref: RUN, confirm: stale.envelope.error.confirmToken })
    expect(ok.envelope.ok).toBe(true)
    expect((await runs({ action: 'resume', ref: RUN, confirm: stale.envelope.error.confirmToken })).envelope.error.code).toBe('stale')
  })

  it('answers with a structured option or free text, and refuses when nothing is asked', async () => {
    useJob(JOBS.question)
    routes.set(`POST ${P}/loop-runs/r1/resume`, { status: 202, body: { loopRunId: 'r1', resumed: true } })
    const state = (await runs({ action: 'get', ref: RUN })).envelope
    expect(state.data.question).toMatchObject({ text: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sq', label: 'SQLite' }], recommended: 'pg' })
    expect(offer(state, 'answer').needs).toEqual(['answer|optionId'])
    await runs({ ...offer(state, 'answer').call.args, optionId: 'pg' })
    expect(posts().at(-1)?.body).toEqual({ answer: 'Postgres', interruptId: 'i1', optionId: 'pg' })
    await runs({ action: 'answer', ref: RUN, answer: 'Use MySQL' })
    expect(posts().at(-1)?.body).toEqual({ answer: 'Use MySQL', interruptId: 'i1' })
    expect((await runs({ action: 'answer', ref: RUN, optionId: 'nope' })).envelope.error.code).toBe('invalid_input')
    useJob(JOBS.working)
    const held = await runs({ action: 'answer', ref: RUN, answer: 'x' })
    expect(held.envelope.error).toMatchObject({ code: 'held', state: { status: 'running' } })
  })

  it('without an answer the question is a menu: its options (recommended first) and a free answer', async () => {
    useJob(JOBS.question)
    routes.set(`POST ${P}/loop-runs/r1/resume`, { status: 202, body: { loopRunId: 'r1', resumed: true } })
    const menu = (await runs({ action: 'answer', ref: RUN })).envelope
    expect(menu).toMatchObject({ ok: true, data: { question: 'Which database?', other: { field: 'answer', call: { tool: 'specrails_runs', args: { action: 'answer', ref: RUN } } } } })
    expect(menu.data.choices).toEqual([
      { id: 'pg', label: 'Postgres', effect: 'Sends your answer; the run continues.', recommended: true, call: { tool: 'specrails_runs', args: { action: 'answer', ref: RUN, optionId: 'pg' } } },
      { id: 'sq', label: 'SQLite', effect: 'Sends your answer; the run continues.', call: { tool: 'specrails_runs', args: { action: 'answer', ref: RUN, optionId: 'sq' } } },
    ])
    expect(posts()).toEqual([])
    // The menu's call is the answer (keyboard: the person said "2").
    await runs(menu.data.choices[1].call.args)
    expect(posts().at(-1)?.body).toEqual({ answer: 'SQLite', interruptId: 'i1', optionId: 'sq' })
    useJob(JOBS.approval)
    const approval = (await runs({ action: 'answer', ref: RUN })).envelope
    expect(approval.data.choices.map((c: { id: string; label: string }) => [c.id, c.label])).toEqual([['approve', 'Approve']])
    expect(approval.data.other).toMatchObject({ field: 'answer', call: { args: { action: 'reject', ref: RUN } } })
  })

  it('without a choice a provider limit is a menu: try now, wait for the reset, or continue on each provider', async () => {
    useJob({ ...JOBS.limit, loopPauseLimit: { ...LIMIT, switchTargets: [{ provider: 'codex', model: 'gpt-5.5' }, { provider: 'gemini' }] } })
    const menu = (await runs({ action: 'limit', ref: RUN })).envelope
    expect(menu.ok).toBe(true)
    expect(menu.data.choices.map((c: { id: string; label: string }) => [c.id, c.label])).toEqual([
      ['limit.resume_now', 'Try again now'], ['limit.auto', 'Resume when the limit resets'], ['limit.switch', 'Continue on codex'], ['limit.switch.gemini', 'Continue on gemini'],
    ])
    expect(menu.data.choices[3].call.args).toEqual({ action: 'limit', ref: RUN, choice: 'switch', provider: 'gemini' })
    expect(menu.data.question).toContain('—')
    useJob(JOBS.working)
    expect((await runs({ action: 'limit', ref: RUN })).envelope.error.code).toBe('invalid_input')
  })

  it('approves and rejects (with a reason) the pending approval', async () => {
    useJob(JOBS.approval)
    routes.set(`POST ${P}/loop-runs/r1/resume`, { status: 202, body: { resumed: true } })
    await runs({ action: 'approve', ref: RUN })
    expect(posts().at(-1)?.body).toEqual({ approve: ['a1'] })
    expect((await runs({ action: 'reject', ref: RUN })).envelope.error.code).toBe('invalid_input')
    await runs({ action: 'reject', ref: RUN, answer: 'Not on prod' })
    expect(posts().at(-1)?.body).toEqual({ reject: 'a1', reason: 'Not on prod' })
  })

  it('a Continue that forks answers with the new attempt, so the agent follows it', async () => {
    useJob(JOBS.failed)
    routes.set(`POST ${P}/loop-runs/r1/remedy`, { status: 201, body: { loopRunId: 'fork-1', remedy: 'continue', mode: 'fork', fromStep: 'architect', resumed: true } })
    routes.set(`GET ${P}/jobs/fork-1`, { body: { job: { ...JOBS.working, id: 'fork-1' }, events: EVENTS } })
    const state = (await runs({ action: 'get', ref: RUN })).envelope
    const out = await act(offer(state, 'remedy.continue').call)
    expect(out.envelope.refs.run).toBe('run:shop-api/fork-1')
    expect(out.envelope.data).toMatchObject({ run: 'run:shop-api/fork-1', source: RUN, status: 'running' })
  })

  it('remedies a failed run: analysis option, provider switch, start over, edit spec', async () => {
    useJob(JOBS.failed)
    routes.set(`POST ${P}/loop-runs/r1/remedy`, { status: 202, body: { loopRunId: 'r2' } })
    routes.set(`POST ${P}/rails/0/relaunch`, { status: 202, body: { loopRunIds: ['r3'] } })
    const state = (await runs({ action: 'get', ref: RUN })).envelope
    await act(offer(state, 'resolution.fix-redirect').call)
    expect(posts().at(-1)).toMatchObject({ path: `${P}/loop-runs/r1/remedy`, body: { optionId: 'fix-redirect' } })
    await act(offer(state, 'remedy.switch').call)
    expect(posts().at(-1)?.body).toEqual({ remedy: 'continue', switch: { provider: 'codex', model: 'gpt-5.5' } })
    const retry = await act(offer(state, 'remedy.retry').call)
    expect(posts().at(-1)).toMatchObject({ path: `${P}/rails/0/relaunch`, body: { sourceId: 'r1' } })
    expect(retry.envelope.data.runs).toEqual(['run:shop-api/r3'])
    const before = posts().length
    const edit = await runs({ action: 'remedy', ref: RUN, choice: 'edit_spec' })
    expect(edit.envelope.data.next).toEqual({ tool: 'specrails_specs', args: { action: 'update', ref: 'spec:shop-api/12' } })
    expect(posts().length).toBe(before)
    expect((await runs({ action: 'remedy', ref: RUN, choice: 'change_model' })).envelope.error.code).toBe('invalid_input')
  })

  it('says a continue cannot work when the run lost its saved state, and offers a fresh launch', async () => {
    useJob(JOBS.failed)
    routes.set(`POST ${P}/loop-runs/r1/remedy`, { status: 503, body: { error: 'runtime_status_unavailable', detail: 'ENOENT desktop-context.json' } })
    const state = (await runs({ action: 'get', ref: RUN })).envelope
    const out = await act(offer(state, 'remedy.continue').call)
    expect(out.envelope.error).toMatchObject({ code: 'conflict', retryable: false, next: [{ tool: 'specrails_runs', args: { action: 'launch', target: { specIds: ['spec:shop-api/12'] } } }] })
    expect(out.envelope.error.message).toMatch(/no longer continue/)
  })

  it('refuses a continue the run cannot take (held, with the state)', async () => {
    useJob(JOBS.failed)
    routes.set(`GET ${P}/loop-runs/r1/attempts`, { body: { ...ATTEMPTS, continuable: false, providerSwitch: null } })
    const confirmed = await runs({ action: 'remedy', ref: RUN, choice: 'continue' })
    expect(confirmed.envelope.error).toMatchObject({ code: 'held' })
    expect(posts()).toHaveLength(0)
    expect(confirmed.envelope.error.state.offers.map((o: { id: string }) => o.id)).not.toContain('remedy.continue')
    // The message names what the run does offer.
    expect(confirmed.envelope.error.message).toMatch(/It offers: .*runs\(remedy start_over\)/)
    expect(confirmed.envelope.error.message).not.toMatch(/remedy continue\b/)
  })

  it('pauses, stops and plays a rail through its active run', async () => {
    routes.set(`GET ${P}/rails`, { body: { rails: [{ railIndex: 0, ticketIds: [12] }], activeJobs: {}, activeLoopRuns: { 0: { loopRunId: 'r1' } }, prDeliveries: {} } })
    routes.set(`POST ${P}/loop-runs/r1/pause`, { status: 202, body: { loopRunId: 'r1', pausing: true } })
    routes.set(`POST ${P}/rails/0/stop`, { body: { ok: true, loopRunIds: ['r1'] } })
    routes.set(`POST ${P}/jobs/r1/cancel`, { body: { status: 'canceling' } })
    useJob(JOBS.working)
    const paused = await runs({ action: 'pause', ref: 'rail:shop-api/0', options: { waitMs: 0 } })
    expect(paused.envelope.data).toMatchObject({ ref: RUN, pausing: true, status: 'running' })
    // The control answers with the run's fresh state, so the agent needs no get afterwards.
    expect(paused.envelope.state).toMatchObject({ status: 'running', offers: expect.any(Array) })
    expect(paused.envelope.summary).toMatch(/^Pause accepted\. .+: /)
    await runs({ action: 'stop', ref: 'rail:shop-api/0' })
    expect(posts().at(-1)?.path).toBe(`${P}/rails/0/stop`)
    await runs({ action: 'stop', ref: RUN })
    expect(posts().at(-1)?.path).toBe(`${P}/jobs/r1/cancel`)
    useJob({ ...JOBS.working, hold: { kind: 'paused', step: 'x', since: 's', byYou: true }, pauseControl: 'resume' })
    routes.set(`POST ${P}/loop-runs/r1/resume`, { status: 202, body: { resumed: true } })
    await act({ tool: 'specrails_runs', args: { action: 'resume', ref: 'rail:shop-api/0' } })
    expect(posts().at(-1)?.path).toBe(`${P}/loop-runs/r1/resume`)
    routes.set(`GET ${P}/rails`, { body: { rails: [{ railIndex: 0, ticketIds: [] }], activeJobs: {}, activeLoopRuns: {}, prDeliveries: {} } })
    expect((await runs({ action: 'pause', ref: 'rail:shop-api/0', options: { waitMs: 0 } })).envelope.error.code).toBe('conflict')
    // By default the pause answers once the run holds (here at once), with that hold in its state.
    routes.set(`GET ${P}/rails`, { body: { rails: [{ railIndex: 0, ticketIds: [12] }], activeJobs: {}, activeLoopRuns: { 0: { loopRunId: 'r1' } }, prDeliveries: {} } })
    useJob({ ...JOBS.working, hold: { kind: 'paused', step: 'x', since: 's', byYou: true }, pauseControl: 'resume' })
    const held = await runs({ action: 'pause', ref: RUN })
    expect(held.envelope.state.hold).toMatchObject({ kind: 'paused' })
    expect(held.envelope.state.offers.map((o: { id: string }) => o.id)).toContain('resume')
  })

  it('cancels only after confirmation, through the owning runtime', async () => {
    useJob(JOBS.working)
    routes.set(`POST ${P}/loop-runs/r1/cancel`, { status: 202, body: { cancellationRequested: true } })
    const first = await runs({ action: 'cancel', ref: RUN })
    expect(first.envelope.error).toMatchObject({ code: 'confirmation_required', preview: { reversible: false } })
    expect(posts()).toHaveLength(0)
    await runs({ action: 'cancel', ref: RUN, confirm: first.envelope.error.confirmToken })
    expect(posts().at(-1)?.path).toBe(`${P}/loop-runs/r1/cancel`)
  })

  it('steers, forks, diagnoses, settles and recovers', async () => {
    useJob(JOBS.failed)
    routes.set(`POST ${P}/agent-runtime/runs/r1/steer`, { status: 202, body: { accepted: true } })
    routes.set(`POST ${P}/loop-runs/r1/fork`, { status: 201, body: { loopRunId: 'r9', resumed: true } })
    routes.set(`POST ${P}/jobs/r1/failure-analysis`, { body: ANALYSIS })
    routes.set(`POST ${P}/agent-runtime/runs/r1/settle`, { body: { settled: true } })
    routes.set(`POST ${P}/agent-runtime/runs/r1/recovery`, (body) => ({ body: { echo: body } }))
    await runs({ action: 'steer', ref: RUN, message: 'Keep the API stable' })
    expect(posts().at(-1)?.body).toMatchObject({ text: 'Keep the API stable', requestId: expect.stringMatching(/^mcp-steer-/) })
    expect((await runs({ action: 'fork', ref: RUN, confirm: 'x' })).isError).toBe(true)
    const fork = await act({ tool: 'specrails_runs', args: { action: 'fork', ref: RUN, options: { fromStep: 'developer' } } })
    expect(fork.envelope.refs).toMatchObject({ run: 'run:shop-api/r9', source: RUN })
    const diagnosis = await runs({ action: 'diagnose', ref: RUN })
    expect(diagnosis.envelope.data.analysis).toMatchObject({ headline: 'The login test expects a redirect', options: [{ id: 'fix-redirect', recommended: true }] })
    expect(diagnosis.envelope.summary).toContain('redirect')
    expect(posts().some((entry) => entry.path.endsWith('/failure-analysis'))).toBe(false)
    await runs({ action: 'settle', ref: RUN })
    expect(posts().at(-1)?.path).toBe(`${P}/agent-runtime/runs/r1/settle`)
    const read = await runs({ action: 'recovery_read', ref: RUN, options: { path: 'src/a.ts', repositoryId: 'main', startLine: 1 } })
    expect(read.envelope.data.echo).toEqual({ action: 'read_file', repositoryId: 'main', path: 'src/a.ts', startLine: 1 })
    const patch = await runs({ action: 'recovery_patch', ref: RUN, options: { patch: { path: 'a', oldText: 'x', newText: 'y', expectedHash: 'h', operationId: 'u', reason: 'r' } } })
    expect(patch.envelope.data.echo).toMatchObject({ action: 'patch', oldText: 'x', newText: 'y' })
    expect((await runs({ action: 'recovery_read', ref: RUN })).envelope.error.code).toBe('invalid_input')
    // recovery_check executes the project's own commands: it is confirmed like v1's destructive check.
    const check = await runs({ action: 'recovery_check', ref: RUN, options: { kind: 'verification', checkId: 'c1' } })
    expect(check.envelope.error).toMatchObject({ code: 'confirmation_required', preview: { class: 'irreversible', refs: [RUN], effect: expect.stringContaining("executes the project's own commands") } })
    expect(posts().some((entry) => (entry.body as { action?: string } | undefined)?.action === 'check')).toBe(false)
    const checked = await act({ tool: 'specrails_runs', args: { action: 'recovery_check', ref: RUN, options: { kind: 'verification', checkId: 'c1' } } })
    expect(checked.envelope.data.echo).toMatchObject({ action: 'check', kind: 'verification', checkId: 'c1' })
  })

  it('reads and drives the queue, deletes history only after confirmation', async () => {
    routes.set(`GET ${P}/queue`, { body: { paused: false, activeJobId: 'r1', jobs: [{ id: 'q1', command: '/specrails:implement #3', status: 'queued', queuePosition: 1, priority: 'normal' }] } })
    routes.set(`POST ${P}/queue/pause`, { body: { ok: true } })
    routes.set(`PATCH ${P}/jobs/q1/priority`, { body: { ok: true } })
    routes.set(`DELETE ${P}/jobs/r1`, { body: { deleted: true } })
    useJob(JOBS.failed)
    const queue = await runs({ action: 'queue' })
    expect(queue.envelope.data).toMatchObject({ paused: false, active: RUN, items: [{ ref: 'run:shop-api/q1', position: 1 }] })
    await runs({ action: 'queue', options: { op: 'pause' } })
    await runs({ action: 'queue', ref: 'run:shop-api/q1', options: { op: 'priority', priority: 'high' } })
    expect(posts().map((entry) => entry.path)).toEqual([`${P}/queue/pause`, `${P}/jobs/q1/priority`])
    const first = await runs({ action: 'delete_history', ref: RUN })
    expect(first.envelope.error.code).toBe('confirmation_required')
    await runs({ action: 'delete_history', ref: RUN, confirm: first.envelope.error.confirmToken })
    expect(posts().at(-1)).toMatchObject({ method: 'DELETE', path: `${P}/jobs/r1` })
  })
})

describe('specrails_runs launch', () => {
  it('launches one spec in one call without a token when the forecast is under the threshold', async () => {
    routes.set(`POST ${P}/rails/launch-specs`, { status: 202, body: { loopRunIds: ['r5'], railIndex: 1, isolated: true, prDeliveryId: null } })
    const { envelope } = await runs({ action: 'launch', target: { specIds: ['spec:shop-api/12'] }, provider: 'codex', model: 'gpt-5.5', effort: 'high', options: { runCapUsd: 3 } })
    expect(envelope.ok).toBe(true)
    expect(posts().at(-1)).toMatchObject({ path: `${P}/rails/launch-specs`, body: { specIds: [12], aiEngine: 'codex', model: 'gpt-5.5', reasoning_effort: 'high', runCapUsd: 3 } })
    expect(envelope.data.launched).toEqual([{ runs: ['run:shop-api/r5'], rail: 'rail:shop-api/1', railLabel: 'Rail 2', isolated: true }])
    expect(envelope.refs).toEqual({ run1: 'run:shop-api/r5' })
    expect(envelope.summary).toContain('specrails_wait')
    expect(approxTokens(JSON.stringify(envelope))).toBeLessThan(600)
  })

  it('confirms a parallel launch (several runs) with forecast, preflight and capacity in the preview', async () => {
    routes.set('GET /capacity', { body: { enabled: true, running: [{}, {}], queued: [{}] } })
    let n = 0
    routes.set(`POST ${P}/rails/launch-specs`, () => ({ status: 202, body: { loopRunIds: [`p${++n}`], railIndex: n } }))
    const dry = await runs({ action: 'launch', target: { specIds: [1, 2] }, options: { parallel: true }, dryRun: true })
    expect(dry.envelope.data.preview).toMatchObject({ class: 'costly', cost: { forecastUsd: [0.2, 0.6], runs: 2 } })
    expect(dry.envelope.data.preview.effect).toMatch(/2 run\(s\).*6–9 min.*claude quota warning.*busy/s)
    expect(posts()).toHaveLength(0)
    const first = await runs({ action: 'launch', target: { specIds: [1, 2] }, options: { parallel: true } })
    expect(first.envelope.error.code).toBe('confirmation_required')
    const done = await runs({ action: 'launch', target: { specIds: [1, 2] }, options: { parallel: true }, confirm: first.envelope.error.confirmToken })
    expect(posts().map((entry) => entry.body)).toEqual([{ specIds: [1] }, { specIds: [2] }])
    expect(Object.values(done.envelope.refs)).toEqual(['run:shop-api/p1', 'run:shop-api/p2'])
  })

  it('reports refused groups of a parallel launch and launches rails, loops, commands and templates', async () => {
    routes.set(`POST ${P}/rails/launch-specs`, (body) => (body as { specIds: number[] }).specIds[0] === 2 ? { status: 409, body: { error: 'tickets_in_flight', detail: 'busy' } } : { status: 202, body: { loopRunIds: ['a'], railIndex: 0 } })
    const dry = await runs({ action: 'launch', target: { specIds: [1, 2] }, options: { parallel: true }, dryRun: true })
    const partial = await runs({ action: 'launch', target: { specIds: [1, 2] }, options: { parallel: true }, confirm: dry.envelope.data.confirmToken })
    expect(partial.envelope.data.refused).toEqual([{ specs: ['spec:shop-api/2'], error: 'tickets_in_flight', detail: 'busy' }])
    routes.set(`POST ${P}/rails/3/launch`, { status: 202, body: { loopRunIds: ['b'], railIndex: 3 } })
    routes.set(`GET ${P}/rails`, { body: { rails: [{ railIndex: 0, ticketIds: [] }, { railIndex: 3, ticketIds: [7] }], activeJobs: {}, activeLoopRuns: {}, prDeliveries: {} } })
    // An empty rail is refused at preview time, before the person is asked to agree.
    const empty = await runs({ action: 'launch', target: { rail: 'rail:shop-api/0' } })
    expect(empty.envelope.error).toMatchObject({ code: 'invalid_input', next: [expect.objectContaining({ tool: 'specrails_rails' })] })
    expect(empty.envelope.error.message).toMatch(/Rail 1 has no specs/)
    // Several specs without options.parallel run in one run: the preview says so and how to split them.
    const together = await runs({ action: 'launch', target: { specIds: [1, 2] }, dryRun: true })
    expect(together.envelope.data.preview.effect).toMatch(/one after another.*options\.parallel: true/)
    const split = await runs({ action: 'launch', target: { specIds: [1, 2] }, options: { parallel: true }, dryRun: true })
    expect(split.envelope.data.preview.effect).not.toMatch(/one after another/)
    routes.set(`POST ${P}/loop-runs`, { status: 202, body: { loopRunId: 'c' } })
    routes.set(`POST ${P}/spawn`, { status: 202, body: { jobId: 'd' } })
    routes.set(`POST ${P}/templates/t1/run`, { status: 202, body: { jobId: 'e' } })
    for (const target of [{ rail: 'rail:shop-api/3' }, { loopId: 'lib:review' }, { command: '/specrails:health' }, { template: 't1' }]) {
      const result = await act({ tool: 'specrails_runs', args: { action: 'launch', target } })
      expect(result.envelope.ok, JSON.stringify(result.envelope)).toBe(true)
    }
    expect(posts().slice(-4).map((entry) => entry.path)).toEqual([`${P}/rails/3/launch`, `${P}/loop-runs`, `${P}/spawn`, `${P}/templates/t1/run`])
    expect((await runs({ action: 'launch', target: {} })).envelope.error.code).toBe('invalid_input')
  })

  it('launch_all starts every eligible rail with its own settings (always confirmed for several)', async () => {
    routes.set(`GET ${P}/rails`, { body: { rails: [{ railIndex: 0, ticketIds: [1], mode: 'implement' }, { railIndex: 1, ticketIds: [] }, { railIndex: 2, ticketIds: [3] }, { railIndex: 3, ticketIds: [4] }],
      activeJobs: {}, activeLoopRuns: { 2: { loopRunId: 'x' } }, prDeliveries: {} } })
    routes.set(`POST ${P}/rails/0/launch`, { status: 202, body: { loopRunIds: ['l0'] } })
    routes.set(`POST ${P}/rails/3/launch`, { status: 202, body: { loopRunIds: ['l3'] } })
    const first = await runs({ action: 'launch_all' })
    expect(first.envelope.error).toMatchObject({ code: 'confirmation_required', preview: { cost: { runs: 2 } } })
    const done = await runs({ action: 'launch_all', confirm: first.envelope.error.confirmToken })
    expect(done.envelope.data.results.map((item: { index: number; outcome: string }) => [item.index, item.outcome])).toEqual([[0, 'launched'], [1, 'skipped'], [2, 'skipped'], [3, 'launched']])
    expect(posts().at(0)?.body).toEqual({ mode: 'implement' })
  })
})
