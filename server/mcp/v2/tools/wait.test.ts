import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'v2-wait-test-token-no-filesystem-access' }))
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { initDb } from '../../../db'
import { createJob } from '../../../db/jobs'
import { startEventJournal, stopEventJournal, type JournalEvent } from '../../../modules/events-journal'
import { buildToolSpecs } from '../../tools/catalog'
import { createHarness, call, type Harness } from '../__fixtures__/harness'
import { approxTokens, RESPONSE_BUDGET } from '../core/size-guard'
import { registerV2Surface, v2Catalog } from '../index'
import { canonicalOf, nextOf, registerWaitNotifications, WAIT_MAX_MS } from './wait'

const harnesses: Harness[] = []
afterEach(() => { for (const h of harnesses.splice(0)) stopEventJournal(h.db) })

async function setup(options: { notifications?: boolean } = {}): Promise<{ h: Harness; client: Client; publish: (msg: Record<string, unknown>) => void }> {
  const h = createHarness({ projects: [
    { id: 'p1', slug: 'shop-api', name: 'Shop API', path: '/tmp/v2-shop-api' },
    { id: 'p2', slug: 'web', name: 'Web', path: '/tmp/v2-web' },
  ] })
  harnesses.push(h)
  startEventJournal(h.db, h.ctx.eventBus) // what server/index.ts does at boot
  registerV2Surface(h.server, h.ctx, buildToolSpecs(), { inApp: false })
  if (options.notifications) registerWaitNotifications(h.server, h.ctx)
  const client = await h.connect()
  return { h, client, publish: (msg) => h.ctx.eventBus.publish(msg as never) }
}

const wait = (client: Client, args: Record<string, unknown>) => call(client, 'specrails_wait', args)
const started = (jobId: string, projectId = 'p1') => ({ type: 'rail.job_started', projectId, railIndex: 0, jobId, mode: 'implement' })
const completed = (jobId: string, status = 'completed', projectId = 'p1') => ({ type: 'rail.job_completed', projectId, railIndex: 0, jobId, status, ticketIds: [7] })
const asked = (loopRunId: string, text = 'Which database?', projectId = 'p1', interruptId = `q-${loopRunId}`) => ({
  type: 'loop.run_paused', projectId, loopRunId, railIndex: 0, reason: 'question', ticketIds: [],
  question: { interruptId, kind: 'question', asker: 'planner', text, options: [{ id: 'pg', label: 'PostgreSQL' }, { id: 'sqlite', label: 'SQLite' }], recommended: 'pg', endsRun: [], mayEndRun: false, canReject: false },
})
const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('specrails_wait(until)', () => {
  it('returns at once for refs that already settled, with the next call and nothing pending', async () => {
    const { client, publish } = await setup()
    publish(started('j1'))
    publish(completed('j1', 'failed'))
    await tick()
    const t0 = Date.now()
    const { envelope, isError } = await wait(client, { action: 'until', refs: ['run:shop-api/j1'] })
    expect(isError).toBe(false)
    expect(Date.now() - t0).toBeLessThan(300)
    expect(envelope.data.timedOut).toBe(false)
    expect(envelope.data.fired).toEqual([expect.objectContaining({
      ref: 'run:shop-api/j1', status: 'failed', label: 'Failed', needs: 'failed', what: 'run.status',
      next: { tool: 'specrails_runs', args: { action: 'diagnose', ref: 'run:shop-api/j1' } },
    })])
    expect(envelope.data.pending).toBeUndefined()
    expect(envelope.summary).toBe('run:shop-api/j1 is Failed.')
  })

  it('blocks, wakes within 500 ms of the transition and resumes from the cursor', async () => {
    const { client, publish } = await setup()
    publish(started('j2'))
    await tick()
    const pending = wait(client, { action: 'until', refs: ['run:shop-api/j2', 'run:web/x9'], timeoutMs: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    publish(completed('other'))
    const sent = Date.now()
    publish(completed('j2'))
    const { envelope } = await pending
    expect(Date.now() - sent).toBeLessThan(500)
    expect(envelope.data.fired).toEqual([expect.objectContaining({ ref: 'run:shop-api/j2', status: 'succeeded', from: 'running' })])
    expect(envelope.data.pending).toEqual(['run:web/x9'])
    const cursor = envelope.data.cursor as string

    // What lands between two calls is not lost: the cursor returns it at once.
    publish(started('x9', 'p2'))
    publish(completed('x9', 'canceled', 'p2'))
    const next = await wait(client, { action: 'until', refs: ['run:shop-api/j2', 'run:web/x9'], since: cursor })
    expect(next.envelope.data.fired).toEqual([expect.objectContaining({ ref: 'run:web/x9', status: 'cancelled', from: 'running' })])
    expect(next.envelope.data.pending).toBeUndefined()
  })

  it('waits app-wide for anything that needs the person, carrying the question to answer', async () => {
    const { client, publish } = await setup()
    const pending = wait(client, { action: 'until', timeoutMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    publish(started('r5', 'p2'))
    publish(asked('r5', 'Which database?', 'p2'))
    const { envelope } = await pending
    const [item] = envelope.data.fired
    expect(item).toMatchObject({
      ref: 'run:web/r5', status: 'needs_you', needs: 'question', reason: 'The run asked you a question.',
      question: { id: 'q-r5', kind: 'question', text: 'Which database?', options: [{ id: 'pg', label: 'PostgreSQL' }, { id: 'sqlite', label: 'SQLite' }], recommended: 'pg' },
      next: { tool: 'specrails_runs', args: { action: 'answer', ref: 'run:web/r5' }, needs: ['answer|optionId'] },
    })
    expect(envelope.data.fired).toHaveLength(1)
    expect(envelope.untrusted).toEqual(['/data/fired/*/title', '/data/fired/*/detail', '/data/fired/*/question'])
  })

  it('scopes to a project and supports changed and any', async () => {
    const { client, publish } = await setup()
    const scoped = wait(client, { action: 'until', project: 'shop', timeoutMs: 3_000 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    publish(asked('w1', 'x', 'p2'))
    publish(asked('s1', 'y', 'p1'))
    expect((await scoped).envelope.data.fired.map((i: { ref: string }) => i.ref)).toEqual(['run:shop-api/s1'])

    publish(started('c1'))
    await tick()
    const changed = wait(client, { action: 'until', refs: ['run:shop-api/c1'], for: 'changed', timeoutMs: 3_000 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    publish({ type: 'loop.run_paused', projectId: 'p1', loopRunId: 'c1', reason: 'by you', pauseKind: 'user_paused', ticketIds: [] })
    const changedItem = (await changed).envelope.data.fired[0]
    expect(changedItem).toMatchObject({ ref: 'run:shop-api/c1', status: 'paused', reason: 'Paused.' })
    expect(changedItem.next).toBeUndefined()

    const any = wait(client, { action: 'until', refs: ['run:shop-api/c1'], for: 'any', timeoutMs: 3_000 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    publish({ type: 'daily_budget_exceeded', projectId: 'p2', dailySpend: 12, budget: 10, queuePaused: true })
    expect((await any).envelope.data.fired[0]).toMatchObject({ ref: 'project:web', status: 'blocked', needs: 'budget', next: { tool: 'specrails_insights', args: { action: 'budget_get', ref: 'project:web' } } })
  })

  it('times out without failing and keeps the cursor at the head', async () => {
    const { client, publish } = await setup()
    publish(started('t1'))
    await tick()
    const t0 = Date.now()
    const { envelope, isError } = await wait(client, { action: 'until', refs: ['run:shop-api/t1'], timeoutMs: 1_000 })
    expect(isError).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950)
    expect(envelope.data).toMatchObject({ fired: [], timedOut: true, pending: ['run:shop-api/t1'] })
    expect(envelope.summary).toMatch(/Nothing changed in 1 s/)
    const again = await wait(client, { action: 'until', refs: ['run:shop-api/t1'], since: envelope.data.cursor, timeoutMs: 1_000 })
    expect(again.envelope.data.timedOut).toBe(true)
  })

  it('keeps a burst of wake-ups under 800 tokens and loses nothing across calls', async () => {
    const { client, publish } = await setup()
    const head = await wait(client, { action: 'events' })
    for (let i = 0; i < 20; i++) publish(asked(`b${i}`, `${'Long question about the schema migration plan '.repeat(8)}#${i}`))
    await tick()
    const seen = new Set<string>()
    let cursor = head.envelope.data.cursor as string
    for (let round = 0; round < 20 && seen.size < 20; round++) {
      const { envelope, text } = await wait(client, { action: 'until', since: cursor, timeoutMs: 1_000 })
      expect(approxTokens(text)).toBeLessThanOrEqual(RESPONSE_BUDGET.waitWake)
      expect(envelope.page).toBeUndefined()
      for (const item of envelope.data.fired) seen.add(item.ref)
      cursor = envelope.data.cursor
      if (envelope.data.timedOut) break
    }
    expect(seen.size).toBe(20)
  })

  it('reads the durable job row for a run the journal never saw', async () => {
    const { h, client } = await setup()
    const db = initDb(':memory:')
    ;(h.ctx.registry.getContext('p1') as unknown as { db: unknown }).db = db
    createJob(db, { id: 'legacy-1', command: '/implement', started_at: '2026-11-20T10:00:00Z' })
    db.prepare("UPDATE jobs SET status = 'completed', finished_at = '2026-11-20T10:30:00Z' WHERE id = 'legacy-1'").run()
    const { envelope } = await wait(client, { action: 'until', refs: ['run:shop-api/legacy-1'] })
    expect(envelope.data.fired).toEqual([expect.objectContaining({ ref: 'run:shop-api/legacy-1', status: 'succeeded', at: '2026-11-20T10:30:00Z' })])
    db.close()
  })

  it('resumes a cursor after the journal restarts', async () => {
    const { h, client, publish } = await setup()
    publish(started('k1'))
    await tick()
    const first = await wait(client, { action: 'events' })
    stopEventJournal(h.db) // process restart: boot reopens the journal on the same database
    startEventJournal(h.db, h.ctx.eventBus)
    const pending = wait(client, { action: 'until', refs: ['run:shop-api/k1'], since: first.envelope.data.cursor, timeoutMs: 3_000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    publish(completed('k1'))
    const { envelope } = await pending
    expect(envelope.warnings).toBeUndefined()
    expect(envelope.data.fired).toEqual([expect.objectContaining({ ref: 'run:shop-api/k1', status: 'succeeded', from: 'running' })])
  })

  it('rejects bad refs, unsupported kinds, too many refs and foreign cursors', async () => {
    const { client } = await setup()
    expect((await wait(client, { action: 'until', refs: ['nonsense'] })).envelope.error.code).toBe('invalid_input')
    const kind = await wait(client, { action: 'until', refs: ['rail:shop-api/0'] })
    expect(kind.envelope.error).toMatchObject({ code: 'invalid_input' })
    expect(kind.envelope.error.message).toMatch(/Supported: run, delivery/)
    expect((await wait(client, { action: 'until', refs: Array.from({ length: 21 }, (_, i) => `run:shop-api/${i}`) })).envelope.error.code).toBe('invalid_input')
    expect((await wait(client, { action: 'until', refs: ['run:nope/1'] })).envelope.error.code).toBe('not_found')
    expect((await wait(client, { action: 'until', since: 'garbage!' })).envelope.error.code).toBe('invalid_input')
    expect((await wait(client, { action: 'until', timeoutMs: WAIT_MAX_MS + 1 })).isError).toBe(true)
    const foreign = Buffer.from(JSON.stringify({ v: 1, o: 3, k: 'journal', i: 'other-epoch' })).toString('base64url')
    const reset = await wait(client, { action: 'until', since: foreign, timeoutMs: 1_000 })
    expect(reset.envelope.warnings).toEqual(['The cursor belongs to another journal; waiting from now on.'])
  })
})

describe('specrails_wait(events)', () => {
  it('pages the journal oldest first after a cursor, and tails it without one', async () => {
    const { client, publish } = await setup()
    for (let i = 0; i < 6; i++) { publish(started(`e${i}`)); publish(completed(`e${i}`)) }
    publish({ type: 'log', line: 'never journaled' })
    await tick()
    const tail = await wait(client, { action: 'events', limit: 3 })
    expect(tail.envelope.data.items.map((i: { ref: string; status: string }) => `${i.ref}:${i.status}`)).toEqual(['run:shop-api/e4:succeeded', 'run:shop-api/e5:running', 'run:shop-api/e5:succeeded'])
    expect(tail.envelope.summary).toBe('3 events.')

    const start = Buffer.from(JSON.stringify({ v: 1, o: 0, k: 'journal', i: tail.envelope.data.cursor && JSON.parse(Buffer.from(tail.envelope.data.cursor, 'base64url').toString()).i })).toString('base64url')
    const page1 = await wait(client, { action: 'events', since: start, limit: 5 })
    expect(page1.envelope.data.items).toHaveLength(5)
    expect(page1.envelope.page).toMatchObject({ truncated: true })
    const page2 = await wait(client, { action: 'events', since: page1.envelope.page.cursor, limit: 100 })
    expect(page2.envelope.data.items).toHaveLength(7)
    expect(page2.envelope.data.items[0]).toMatchObject({ ref: 'run:shop-api/e2', status: 'succeeded', from: 'running' })
    expect(page2.envelope.page).toMatchObject({ cursor: null, truncated: false })

    const failures = await wait(client, { action: 'events', since: start, for: 'needs_you' })
    expect(failures.envelope.data.items).toEqual([])
    expect(failures.envelope.summary).toBe('No events.')
  })

  it('stays inside the summary budget with a full page of long rows', async () => {
    const { client, publish } = await setup()
    for (let i = 0; i < 100; i++) publish(asked(`L${i}`, 'q'.repeat(300)))
    await tick()
    const { envelope, text } = await wait(client, { action: 'events', limit: 100 })
    expect(approxTokens(text)).toBeLessThanOrEqual(RESPONSE_BUDGET.summaryCap)
    expect(envelope.data.more).toBe(true)
  })
})

describe('wake-up wording and offers', () => {
  it('maps journal rows through the core status vocabulary', () => {
    const row = (refKind: JournalEvent['refKind'], status: string, hold: string | null = null) => ({ refKind, status, hold, attention: null })
    expect(canonicalOf(row('run', 'running', 'question'))).toBe('needs_you')
    expect(canonicalOf(row('run', 'running', 'provider_limit'))).toBe('blocked')
    expect(canonicalOf(row('run', 'running', 'stuck'))).toBe('blocked')
    expect(canonicalOf(row('run', 'queued', 'queued'))).toBe('queued')
    expect(canonicalOf(row('delivery', 'on_review'))).toBe('ready_for_review')
    expect(canonicalOf(row('chain', 'awaiting_approval'))).toBe('needs_you')
    expect(canonicalOf(row('spec', 'deleted'))).toBe('discarded')
    expect(canonicalOf(row('intent', 'needs-review'))).toBe('ready_for_review')
    expect(canonicalOf(row('project', 'cap_reached'))).toBe('blocked')
    expect(canonicalOf(row('mission', 'completed'))).toBe('succeeded')
  })

  it('only ever points at catalog actions', () => {
    const catalog = v2Catalog()
    const kinds = ['run', 'delivery', 'chain', 'intent', 'spec', 'mission', 'project', 'blueprint', 'milestone'] as const
    const holds = [null, 'question', 'approval', 'provider_limit', 'budget', 'stuck'] as const
    for (const refKind of kinds) for (const hold of holds) for (const kind of ['x', 'project.budget']) {
      const next = nextOf({ refKind, hold, attention: 'failed', kind }, `${refKind}:x`)
      expect(catalog.byName.get(next.tool)?.actions[String(next.args.action)], `${next.tool}(${next.args.action})`).toBeDefined()
    }
  })
})

describe('notifications', () => {
  it('sends a notice for rows that need the person', async () => {
    const { client, publish } = await setup({ notifications: true })
    const notices: unknown[] = []
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { notices.push(notification.params) })
    publish(started('n1'))
    publish(asked('n1'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(notices).toEqual([expect.objectContaining({ level: 'notice', logger: 'specrails', data: expect.objectContaining({ ref: 'run:shop-api/n1', needs: 'question', status: 'needs_you' }) })])
  })
})
