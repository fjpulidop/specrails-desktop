import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'v2-wp2-inbox-test-token' }))
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createHarness, call, type Harness } from '../__fixtures__/harness'
import { registerV2Surface, v2Catalog } from '../index'
import { buildToolSpecs } from '../../tools/catalog'
import { approxTokens } from '../core/size-guard'
import { matchesPointer } from '../core/untrusted'
import { buildDecisionState } from '../core/decision-state'
import { translator } from '../core/lang'
import { createLoopRun, finishLoopRun, pauseLoopRun } from '../../../modules/loops/runtime/loop-runs-store'
import { createPrDelivery, transitionDecision } from '../../../modules/delivery/runtime/rail-pr-store'
import { saveLimitPause } from '../../../modules/loops/runtime/loop-limit-pauses'
import { readInboxDismissals } from '../../../mobile/mobile-inbox'
import type { InboxItem } from '../../../modules/inbox'
import { compareUrgency, holdOfItem, inboxStateInput, snoozeUntil } from './inbox'
import { manyProjects, startDesktop, type FakeDesktop } from './__fixtures__/wp2-desktop'
import type { DbInstance } from '../../../db'

// specrails_inbox over the REAL inbox route and project databases (fake desktop),
// so every item, hold and offer comes from the app's own projection and domain rules.

const HOUR = 3_600_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

let h: Harness
let desktop: FakeDesktop
let client: Client
let alpha: DbInstance
let beta: DbInstance

const status = (pending: unknown[]) => JSON.stringify({ pendingInterrupts: pending })
const QUESTION = { id: 'q1', nodePath: 'developer', kind: 'question', value: { kind: 'question', prompt: 'Implement touch controls or drop task 2.1?', text: 'Implement touch controls or drop task 2.1?', asker: 'build', options: [{ id: 'implement', label: 'Implement' }, { id: 'drop', label: 'Drop 2.1' }], recommended: 'drop' } }
const APPROVAL = { id: 'a1', nodePath: 'developer', kind: 'approval', value: { kind: 'approval', prompt: 'Run the migration?', text: 'Run the migration?', rejectable: true } }

function run(db: DbInstance, projectId: string, id: string, rail: number | null = 0, startedAt = ago(HOUR)) {
  createLoopRun(db, { id, projectId, loopId: 'loop-a', loopName: 'Implement', railIndex: rail, ticketIds: [7], iterationLimit: 3, startedAt })
}
function asking(db: DbInstance, projectId: string, id: string, card: unknown, startedAt?: string) {
  run(db, projectId, id, null, startedAt)
  pauseLoopRun(db, id)
  db.prepare('UPDATE loop_runs SET runtime_status_json=? WHERE id=?').run(status([card]), id)
}
function delivery(db: DbInstance, id: string, rail: number, decision: Parameters<typeof transitionDecision>[3]) {
  createPrDelivery(db, { id, railIndex: rail, loopId: 'loop-a', railKey: `${rail}-loop-a`, ticketIds: [rail + 1], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent', originConversationId: null })
  expect(transitionDecision(db, id, 'building', decision)).toBe(true)
}

beforeEach(async () => {
  h = createHarness({ projects: [{ id: 'p1', slug: 'shop-api', name: 'Shop API', path: '/tmp/v2-shop-api' }, { id: 'p2', slug: 'blog', name: 'Blog', path: '/tmp/v2-blog' }] })
  desktop = await startDesktop(h)
  alpha = desktop.dbs.get('p1')!
  beta = desktop.dbs.get('p2')!
  registerV2Surface(h.server, h.ctx, buildToolSpecs(), { inApp: false })
  client = await h.connect()
})
afterEach(async () => { await client.close(); await desktop.close() })

const inbox = (args: Record<string, unknown>) => call(client, 'specrails_inbox', args)

function seedMixed() {
  asking(alpha, 'p1', 'r-ask', QUESTION, ago(2 * HOUR))
  delivery(alpha, 'd-review', 0, 'on_review')
  run(beta, 'p2', 'r-fail', 3)
  finishLoopRun(beta, 'r-fail', { outcome: 'failed', finishedAt: ago(HOUR / 2) })
  run(beta, 'p2', 'r-budget', 4)
  pauseLoopRun(beta, 'r-budget', undefined, 'budget_paused')
}

describe('specrails_inbox(list)', () => {
  it('lists every kind, most urgent first, lean, with the domain offers and the recommended one', async () => {
    seedMixed()
    const { envelope, isError } = await inbox({ action: 'list' })
    expect(isError).toBe(false)
    const items = envelope.data.items as Array<Record<string, any>>
    expect(items.map((item) => [item.kind, item.project])).toEqual([['question', 'shop-api'], ['review', 'shop-api'], ['budget', 'blog'], ['failed', 'blog']])
    const [question, review, budget, failed] = items
    expect(question).toMatchObject({ ref: 'inbox:p1:question:r-ask', status: 'needs_you', subject: 'run:shop-api/r-ask', recommended: 'answer.drop' })
    expect(question.offers.map((offer: { id: string }) => offer.id)).toEqual(['answer.implement', 'answer.drop', 'answer'])
    expect(question.offers.find((offer: { id: string }) => offer.id === 'answer').needs).toEqual(['answer'])
    // The delivery's legal decisions (decision-policy actionAllowed on the real row).
    expect(review.subject).toBe('delivery:shop-api/d-review')
    expect(review.offers.map((offer: { id: string }) => offer.id)).toEqual(expect.arrayContaining(['decide.create_pr', 'decide.merge_local', 'decide.discard']))
    expect(review.offers.find((offer: { id: string }) => offer.id === 'decide.create_pr').confirm).toBe(true)
    expect(budget).toMatchObject({ status: 'paused', why: expect.stringContaining('budget') })
    expect(budget.offers.map((offer: { id: string }) => offer.id)).toEqual(['budget.once', 'budget.ignore', 'budget.raise'])
    expect(failed.status).toBe('failed')
    expect(failed.offers.map((offer: { id: string }) => offer.id)).toContain('diagnose')
    expect(question.why).toBeUndefined()
    expect(envelope.data).toMatchObject({ total: 4, byKind: { question: 1, review: 1, budget: 1, failed: 1 } })
    expect(envelope.summary).toMatch(/^4 things need the person: .*Most urgent: “Implement · #7” in Shop API\.$/)
    // Run/model text is marked untrusted.
    expect(envelope.untrusted.some((pattern: string) => matchesPointer(pattern, '/data/items/0/title'))).toBe(true)
    expect(envelope.untrusted.some((pattern: string) => matchesPointer(pattern, '/data/items/0/offers/1/label'))).toBe(true)
  })

  it('detail carries each item\'s full DecisionState and question card', async () => {
    seedMixed()
    const { envelope } = await inbox({ action: 'list', view: 'detail', filter: { kind: 'question' } })
    const [item] = envelope.data.items
    expect(item.state).toMatchObject({ status: 'needs_you', appState: 'needs-input', recommended: 'answer.drop', hold: { kind: 'question' } })
    expect(item.state.offers[0]).toMatchObject({ id: 'answer.implement', label: 'Implement', call: { tool: 'specrails_inbox', args: { action: 'answer', ref: 'inbox:p1:question:r-ask', optionId: 'implement' } }, tier: 'write', needsConfirm: false })
    expect(item.question).toMatchObject({ kind: 'question', text: 'Implement touch controls or drop task 2.1?', recommended: 'drop' })
  })

  it('filters by project and kind (v1 projectId / kind keep working)', async () => {
    seedMixed()
    expect((await inbox({ action: 'list', filter: { project: 'blog' } })).envelope.data.items.map((item: { kind: string }) => item.kind)).toEqual(['budget', 'failed'])
    expect((await inbox({ action: 'list', filter: { kind: ['review', 'failed'] } })).envelope.data.total).toBe(2)
    expect((await inbox({ action: 'list', projectId: 'p1', kind: 'review' })).envelope.data.items.map((item: { ref: string }) => item.ref)).toEqual(['inbox:p1:review:d-review'])
    expect((await inbox({ action: 'list', filter: { project: 'nope' } })).envelope.error.code).toBe('not_found')
  })

  it('says so when nothing waits', async () => {
    const { envelope } = await inbox({ action: 'list', lang: 'en' })
    expect(envelope).toMatchObject({ ok: true, summary: 'Nothing needs the person right now.', data: { items: [], total: 0 } })
  })

  it('pages with a cursor and stays under the summary budget at 100 items', async () => {
    for (let i = 0; i < 100; i++) asking(alpha, 'p1', `r-${String(i).padStart(3, '0')}`, QUESTION, ago(HOUR + i * 1000))
    const first = await inbox({ action: 'list' })
    expect(first.envelope.data.items).toHaveLength(8)
    expect(first.envelope.page).toMatchObject({ total: 50, truncated: true }) // the inbox keeps 50 per project
    expect(approxTokens(first.text)).toBeLessThanOrEqual(1500)
    const second = await inbox({ action: 'list', cursor: first.envelope.page.cursor })
    expect(second.envelope.data.items[0].ref).not.toBe(first.envelope.data.items[0].ref)
    // A cursor minted for another filter is refused.
    expect((await inbox({ action: 'list', cursor: first.envelope.page.cursor, filter: { kind: 'review' } })).envelope.error.code).toBe('invalid_input')
    const detail = await inbox({ action: 'list', view: 'detail', limit: 100 })
    expect(approxTokens(detail.text)).toBeLessThanOrEqual(10_000)
  })
})

describe('specrails_inbox(open)', () => {
  it('opens one item with its state, refs and untrusted pointers; a run ref finds its item', async () => {
    seedMixed()
    const { envelope } = await inbox({ action: 'open', ref: 'run:shop-api/r-ask' })
    expect(envelope.state.recommended).toBe('answer.drop')
    expect(envelope.refs).toMatchObject({ item: 'inbox:p1:question:r-ask', project: 'project:shop-api', subject: 'run:shop-api/r-ask' })
    expect(envelope.data.question.options.map((option: { id: string }) => option.id)).toEqual(['implement', 'drop'])
    expect(envelope.untrusted).toContain('/data/question')
    const review = await inbox({ action: 'open', ref: 'inbox:p1:review:d-review' })
    expect(review.envelope.data.delivery).toMatchObject({ decision: 'on_review', specs: ['spec:shop-api/1'] })
    expect(review.envelope.state.hold.kind).toBe('pr_decision')
  })

  it('answers not_found with the current items as choices', async () => {
    seedMixed()
    const { envelope } = await inbox({ action: 'open', ref: 'inbox:p1:question:gone' })
    expect(envelope.error.code).toBe('not_found')
    expect(envelope.error.choices[0]).toEqual({ ref: 'inbox:p1:question:r-ask', title: 'Implement · #7' })
  })

  it('needs ref', async () => {
    expect((await inbox({ action: 'open' })).envelope.error.code).toBe('invalid_input')
  })
})

describe('specrails_inbox(answer / approve / reject)', () => {
  it('sends a chosen option like the question card: live turn door first', async () => {
    asking(alpha, 'p1', 'r-ask', QUESTION)
    desktop.on('POST', '/projects/p1/jobs/r-ask/messages', { ok: true })
    const { envelope } = await inbox({ action: 'answer', ref: 'inbox:p1:question:r-ask', optionId: 'drop' })
    expect(envelope).toMatchObject({ ok: true, data: { run: 'run:shop-api/r-ask', via: 'live' }, refs: { run: 'run:shop-api/r-ask' } })
    expect(desktop.calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/projects/p1/jobs/r-ask/messages', body: { text: 'Drop 2.1', interruptId: 'q1', optionId: 'drop' } }])
    expect(h.broadcasts.some((message) => (message as { type: string }).type === 'mcp.activity')).toBe(true)
  })

  it('falls back to resuming the retained run when no live turn door takes it', async () => {
    asking(alpha, 'p1', 'r-ask', QUESTION)
    desktop.on('POST', '/projects/p1/jobs/r-ask/messages', (_req: unknown, res: { status(code: number): { json(body: unknown): void } }) => { res.status(409).json({ error: 'not_paused_here' }) })
    desktop.on('POST', '/projects/p1/loop-runs/r-ask/resume', { loopRunId: 'r-ask' })
    const { envelope } = await inbox({ action: 'answer', ref: 'inbox:p1:question:r-ask', answer: 'Keep it minimal' })
    expect(envelope.data.via).toBe('retained')
    expect(desktop.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body])).toEqual([
      ['/projects/p1/jobs/r-ask/messages', { text: 'Keep it minimal', interruptId: 'q1' }],
      ['/projects/p1/loop-runs/r-ask/resume', { answer: 'Keep it minimal', interruptId: 'q1' }],
    ])
  })

  it('refuses an option the question did not offer, a missing answer and a non-question item', async () => {
    seedMixed()
    expect((await inbox({ action: 'answer', ref: 'inbox:p1:question:r-ask', optionId: 'maybe' })).envelope.error).toMatchObject({ code: 'invalid_input', message: expect.stringContaining('implement, drop') })
    expect((await inbox({ action: 'answer', ref: 'inbox:p1:question:r-ask' })).envelope.error.code).toBe('invalid_input')
    expect((await inbox({ action: 'answer', ref: 'inbox:p1:review:d-review', answer: 'x' })).envelope.error.code).toBe('invalid_input')
    expect(desktop.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('approves and rejects an approval (with the reason); answer is refused on it', async () => {
    asking(alpha, 'p1', 'r-gate', APPROVAL)
    desktop.on('POST', '/projects/p1/jobs/r-gate/messages', { ok: true })
    const listed = (await inbox({ action: 'list' })).envelope.data.items[0]
    expect(listed.offers.map((offer: { id: string }) => offer.id)).toEqual(['approve', 'reject'])
    expect((await inbox({ action: 'answer', ref: listed.ref, answer: 'yes' })).envelope.error.code).toBe('invalid_input')
    expect((await inbox({ action: 'approve', ref: listed.ref })).envelope.ok).toBe(true)
    expect((await inbox({ action: 'reject', ref: listed.ref, options: { reason: 'Not on prod' } })).envelope.ok).toBe(true)
    expect(desktop.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { text: '', interruptId: 'a1', approve: true },
      { text: 'Not on prod', interruptId: 'a1', reject: true },
    ])
  })
})

describe('specrails_inbox(snooze / done)', () => {
  it('done hides an item until its version changes; undo brings it back; includeDismissed shows it', async () => {
    seedMixed()
    expect((await inbox({ action: 'done', ref: 'inbox:p1:review:d-review' })).envelope.summary).toMatch(/Marked done/)
    const after = await inbox({ action: 'list' })
    expect(after.envelope.data).toMatchObject({ total: 3, dismissed: 1 })
    const all = await inbox({ action: 'list', options: { includeDismissed: true } })
    expect(all.envelope.data.items.find((item: { ref: string }) => item.ref === 'inbox:p1:review:d-review').dismissed.kind).toBe('done')
    // A new state re-arms it.
    alpha.prepare(`UPDATE rail_pr_deliveries SET pr_state = 'open' WHERE id = 'd-review'`).run()
    expect((await inbox({ action: 'list' })).envelope.data.total).toBe(4)
    await inbox({ action: 'done', ref: 'inbox:p1:review:d-review' })
    expect((await inbox({ action: 'done', ref: 'inbox:p1:review:d-review', options: { undo: true } })).envelope.data.restored).toBe(true)
    expect((await inbox({ action: 'list' })).envelope.data.total).toBe(4)
  })

  it('snoozes until a time (relative forms too) and refuses a past one', async () => {
    seedMixed()
    const { envelope } = await inbox({ action: 'snooze', ref: 'inbox:p1:question:r-ask', until: '3h' })
    expect(envelope.data.dismissed.kind).toBe('snooze')
    expect(Object.keys(readInboxDismissals(h.db))).toEqual(['p1:question:r-ask'])
    expect((await inbox({ action: 'list' })).envelope.data.items[0].kind).toBe('review')
    expect((await inbox({ action: 'snooze', ref: 'inbox:p1:question:r-ask', until: '2001-01-01T00:00:00Z' })).envelope.error.code).toBe('invalid_input')
    expect((await inbox({ action: 'snooze', ref: 'inbox:p1:question:r-ask' })).envelope.error.code).toBe('invalid_input')
  })

  it('parses snooze times', () => {
    const now = new Date('2026-11-21T10:00:00.000Z')
    expect(snoozeUntil('1h', now)).toBe('2026-11-21T11:00:00.000Z')
    expect(snoozeUntil('30m', now)).toBe('2026-11-21T10:30:00.000Z')
    expect(snoozeUntil('2026-11-22T00:00:00Z', now)).toBe('2026-11-22T00:00:00.000Z')
    expect(snoozeUntil('2026-11-20T00:00:00Z', now)).toBeNull()
    expect(snoozeUntil('later', now)).toBeNull()
    expect(snoozeUntil('tomorrow', now)).toBe(new Date(2026, 10, 22, 9).toISOString())
  })
})

describe('specrails_inbox(act)', () => {
  it('runs an offer through the catalog: the target tool\'s own handler answers', async () => {
    asking(alpha, 'p1', 'r-ask', QUESTION)
    desktop.on('POST', '/projects/p1/jobs/r-ask/messages', { ok: true })
    const { envelope } = await inbox({ action: 'act', ref: 'inbox:p1:question:r-ask', offerId: 'answer.implement' })
    expect(envelope).toMatchObject({ ok: true, summary: expect.stringMatching(/^Answer delivered/), data: { via: 'live' } })
    expect(desktop.calls.find((c) => c.method === 'POST')?.body).toEqual({ text: 'Implement', interruptId: 'q1', optionId: 'implement' })
    // What offer.needs names comes with act.
    expect((await inbox({ action: 'act', ref: 'inbox:p1:question:r-ask', offerId: 'answer', answer: 'Both' })).envelope.ok).toBe(true)
  })

  it('keeps the target\'s confirmation protocol: an external offer asks, and the token round-trips through act', async () => {
    delivery(alpha, 'd-review', 0, 'on_review')
    const first = await inbox({ action: 'act', ref: 'inbox:p1:review:d-review', offerId: 'decide.create_pr' })
    expect(first.envelope.error).toMatchObject({ code: 'confirmation_required', confirmToken: expect.stringMatching(/^ct1\./), preview: { class: 'external' } })
    const second = await inbox({ action: 'act', ref: 'inbox:p1:review:d-review', offerId: 'decide.create_pr', confirm: first.envelope.error.confirmToken })
    // The token verified (no confirmation_required); the stub target then answers as itself.
    expect(second.envelope.error.code).not.toBe('confirmation_required')
    expect(second.envelope.error.code).not.toBe('stale')
  })

  it('refuses an unknown offer and a stale version', async () => {
    seedMixed()
    const unknown = await inbox({ action: 'act', ref: 'inbox:p1:question:r-ask', offerId: 'merge' })
    expect(unknown.envelope.error).toMatchObject({ code: 'invalid_input', message: expect.stringContaining('answer.implement') })
    const stale = await inbox({ action: 'act', ref: 'inbox:p1:question:r-ask', offerId: 'answer', answer: 'x', options: { version: '0000000000000000' } })
    expect(stale.envelope.error.code).toBe('stale')
    expect(stale.envelope.error.state.offers.length).toBeGreaterThan(0)
  })

  it('needs ref and offerId', async () => {
    expect((await inbox({ action: 'act', ref: 'inbox:p1:question:r-ask' })).envelope.error.code).toBe('invalid_input')
  })
})

describe('inbox projection against the domain', () => {
  const t = translator('en')
  const env = { translate: t, policyFor: v2Catalog().policyFor, confirmAboveUsd: 0.5 }
  const item = (over: Partial<InboxItem>): InboxItem => ({ id: 'p1:blocked:r1', projectId: 'p1', projectName: 'Shop', kind: 'blocked', title: 'Run', detail: null, at: '2026-11-21T10:00:00.000Z', version: 'v', action: 'resume-run', subjectId: 'r1', conversationId: null, diagnosis: null, ...over })

  it('reads the hold the inbox source classified', () => {
    expect(holdOfItem(item({ detail: 'held:restart:developer' }))).toMatchObject({ kind: 'restart', step: 'developer' })
    expect(holdOfItem(item({ detail: 'held:pausedByYou' }))).toMatchObject({ kind: 'paused', byYou: true })
    expect(holdOfItem(item({ kind: 'budget', detail: 'usage_limit:claude:2026-11-21T12:00:00.000Z' }))).toMatchObject({ kind: 'provider_limit', resumeAt: '2026-11-21T12:00:00.000Z' })
    expect(holdOfItem(item({ kind: 'budget', detail: null }))).toMatchObject({ kind: 'budget' })
    expect(holdOfItem(item({ kind: 'failed', action: 'open-run' }))).toBeNull()
  })

  it('every kind projects to offers the catalog knows (buildDecisionState never throws)', () => {
    const items: InboxItem[] = [
      item({ detail: 'held:restart' }), item({ detail: 'held:interrupted' }), item({ detail: 'held:pausedByYou' }),
      item({ kind: 'budget', detail: 'usage_limit:claude:' }), item({ kind: 'budget' }),
      item({ kind: 'question', action: 'open-run', question: { interruptId: 'q', kind: 'question', asker: 'run', text: 'Q?', options: [{ id: 'a', label: 'A' }], endsRun: [], mayEndRun: false, canReject: false } }),
      item({ kind: 'failed', action: 'open-run', diagnosis: { kind: 'tests_failed', confidence: 'high', phase: null, rounds: null, resetAt: null, detail: 'x', resumablePhase: null, source: 'core', remedies: ['continue', 'retry', 'open-logs', 'edit-spec'] } }),
      item({ kind: 'review', action: 'open-review', subjectId: 'd1' }),
      item({ kind: 'budget', action: 'raise-cap', subjectId: 'desktop:day', cap: { scope: 'desktop', period: 'day', budgetUsd: 5, spentUsd: 5.5, resetsAt: '2026-11-22T00:00:00.000Z' } }),
      item({ kind: 'jira', action: 'retry-jira', subjectId: '12' }),
    ]
    for (const entry of items) expect(() => buildDecisionState(inboxStateInput(entry, 'shop', {}, t), env)).not.toThrow()
    const failure = buildDecisionState(inboxStateInput(items[6], 'shop', {}, t), env)
    expect(failure.recommended).toBe('remedy.continue')
    const cap = buildDecisionState(inboxStateInput(items[8], 'shop', {}, t), env)
    expect(cap.hold?.reason).toBe('The app-wide daily spend limit is reached: 5.50 of 5.00 USD; it resets 2026-11-22T00:00:00.000Z.')
    // Scope and period words come translated, never as raw English inside another language.
    expect(buildDecisionState(inboxStateInput(items[8], 'shop', {}, translator('es')), { ...env, translate: translator('es') }).hold?.reason).toBe('Se alcanzó un límite de gasto (de toda la app, diario): 5.50 de 5.00 USD; se reinicia 2026-11-22T00:00:00.000Z.')
    expect(cap.offers.map((offer) => [offer.id, offer.call.args.scope, offer.needs])).toEqual([['budget.view', 'app', undefined], ['budget.raise', 'app', ['options.limits']]])
    const jira = buildDecisionState(inboxStateInput(items[9], 'shop', {}, t), env)
    expect(jira.offers[0]).toMatchObject({ id: 'jira.retry', external: true, needsConfirm: true, call: { args: { project: 'shop', id: '12' } } })
    // A delivery without its row offers only to open it (never a guessed decision).
    expect(buildDecisionState(inboxStateInput(items[7], 'shop', {}, t), env).offers.map((offer) => offer.id)).toEqual(['open'])
  })

  it('a usage-limited run offers the switch target its limit pause recorded', async () => {
    run(alpha, 'p1', 'r-limit', 1)
    pauseLoopRun(alpha, 'r-limit', undefined, 'limit_paused')
    saveLimitPause(alpha, 'r-limit', { providerId: 'claude', resumeAt: null, autoResume: false, message: 'limit', pausedAt: ago(1000), switchable: true, switchTargets: [{ provider: 'codex', model: 'gpt-5', effort: null }] })
    const { envelope } = await inbox({ action: 'open', ref: 'run:shop-api/r-limit' })
    expect(envelope.state.status).toBe('blocked')
    expect(envelope.state.offers.find((offer: { id: string }) => offer.id === 'limit.switch').call.args).toMatchObject({ action: 'limit', choice: 'switch', provider: 'codex', model: 'gpt-5' })
  })

  it('orders by urgency, then newest', () => {
    const list = [item({ id: 'a', kind: 'failed', at: '2026-11-21T12:00:00Z' }), item({ id: 'b', kind: 'question', at: '2026-11-20T12:00:00Z' }), item({ id: 'c', kind: 'failed', at: '2026-11-21T13:00:00Z' })]
    expect(list.sort(compareUrgency).map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('specrails_inbox at 100 projects', () => {
  it('lists across 100 projects within the latency and size budget', async () => {
    await client.close(); await desktop.close()
    h = createHarness({ projects: manyProjects(100) })
    desktop = await startDesktop(h)
    for (const [id, db] of desktop.dbs) {
      asking(db, id, `${id}-ask`, QUESTION)
      delivery(db, `${id}-d`, 0, 'on_review')
    }
    registerV2Surface(h.server, h.ctx, buildToolSpecs(), { inApp: false })
    client = await h.connect()
    await inbox({ action: 'list' })
    const started = performance.now()
    const { envelope, text } = await inbox({ action: 'list' })
    const elapsed = performance.now() - started
    expect(envelope.data.total).toBe(200)
    expect(approxTokens(text)).toBeLessThanOrEqual(1500)
    console.info(`[wp2 perf] inbox(list) 100 projects / 200 items: ${elapsed.toFixed(0)} ms, ~${approxTokens(text)} tokens`)
    expect(elapsed).toBeLessThan(1500)
  })
})
