import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { initDb, type DbInstance } from '../../../db'
import { createPrDelivery, transitionDecision, updatePrDeliverySettleEvidence } from '../../delivery/runtime/rail-pr-store'
import { createLoopRun, finishLoopRun } from '../../loops/runtime/loop-runs-store'
import { recordInvocation } from '../../accounting/runtime/ai-invocations'
import { deriveFailureDiagnosis, serializeDiagnosis } from '../../recovery'
import { buildSpecAddendum } from './spec-addenda'
import { mutateStore, type Ticket } from './ticket-store'
import { collectSpecHistory, baseRunId } from './spec-history'
import { buildHandoffModel, renderHandoff, parseHandoffFormat, parsePlanProviders } from './spec-handoff'
import { registerSpecTimelineRoutes } from '../adapters/timeline-http'
import { HANDOFF_LOCALES, handoffLabels, resolveHandoffLocale } from '../domain/handoff-labels'
import { decodeCursor, pageTimeline, sortTimeline } from '../domain/timeline'

// Fake credentials: these prove the export scrubs secrets. The file is on the
// gitleaks allowlist (.gitleaks.toml) next to the other redaction tests.
const FAKE_ANTHROPIC = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD'
const FAKE_GITHUB = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const FAKE_AWS = 'AKIAABCDEFGHIJKLMNOP'
const FAKE_URL_PASSWORD = 'hunter2hunter2'

const T0 = '2026-10-20T09:00:00.000Z'
const at = (hours: number): string => new Date(Date.parse(T0) + hours * 3_600_000).toISOString()

function makeTicket(id: number, over: Partial<Ticket> = {}): Ticket {
  return {
    id, title: `Spec ${id}`, description: 'Build the lesson counter.', status: 'in_progress', priority: 'medium', labels: ['web'],
    assignee: null, prerequisites: [], metadata: {}, origin_conversation_id: null, is_epic: false, parent_epic_id: null,
    execution_order: null, short_summary: 'A counter', created_at: T0, updated_at: T0, created_by: 'user', source: 'manual', ...over,
  }
}

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

function inv(over: Partial<Parameters<typeof recordInvocation>[1]> & { id: string }) {
  recordInvocation(db, {
    project_id: 'p1', provider: 'claude', surface: 'job', status: 'success', started_at: at(1), ...over,
  } as Parameters<typeof recordInvocation>[1])
}

function conversation(id: string, title: string) {
  db.prepare('INSERT INTO chat_conversations (id, title, model) VALUES (?, ?, ?)').run(id, title, 'sonnet')
}

function run(id: string, ticketId: number, started: string, outcome?: 'completed' | 'failed') {
  createLoopRun(db, { id, projectId: 'p1', loopId: 'loop-a', loopName: 'Implement', railIndex: 0, ticketIds: [ticketId], iterationLimit: 3, startedAt: started })
  if (outcome === 'failed') finishLoopRun(db, id, { outcome: 'failed', finishedAt: at(3), failureDiagnosis: serializeDiagnosis(deriveFailureDiagnosis({ outcome: 'failed' })) })
  else if (outcome) finishLoopRun(db, id, { outcome: 'completed', finishedAt: at(3) })
}

function delivery(id: string, ticketIds: number[], decision: Parameters<typeof transitionDecision>[3] = 'on_review', patch: Parameters<typeof transitionDecision>[4] = {}, rail = 0) {
  createPrDelivery(db, { id, railIndex: rail, loopId: 'loop-a', railKey: `0-${id}`, ticketIds, baseBranch: 'main', loopName: 'Implement', originSurface: 'agent', originConversationId: null })
  transitionDecision(db, id, 'building', decision, patch)
}

function evidence(ticketId: number, over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, harvest: 'ok', harvestedAt: at(5),
    units: [{
      ticketId, runId: 'run-1', sentinel: 'pass', sentinelDetail: null, verifyTail: null, confidence: null,
      runtime: {
        commands: [], checks: [], findings: ['Missing null check', `Leaked key ${FAKE_ANTHROPIC} in logs`], findingLocations: [{ finding: 0, path: 'src/counter.ts', line: 12, endLine: 14 }],
        review: { approved: false, score: 0.6, aspects: {}, issues: [], summary: 'Two findings remain.' },
      },
      ...over,
    }],
  }
}

describe('baseRunId', () => {
  it('strips multi-ticket and merge suffixes', () => {
    expect(baseRunId('job-1#t7')).toBe('job-1')
    expect(baseRunId('job-1:merge:step')).toBe('job-1')
    expect(baseRunId('job-1')).toBe('job-1')
    expect(baseRunId(null)).toBeNull()
  })
})

describe('spec history projection', () => {
  it('projects the ticket itself: creation, last edit, comment, and the mission it came from', () => {
    const ticket = makeTicket(7, {
      origin_conversation_id: 'conv-origin', updated_at: at(2), created_by: 'agent',
      comments: [{ id: 1, body: 'Please keep it small', created_at: at(1), created_by: 'user' }],
    })
    const { entries } = collectSpecHistory(db, ticket)
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]))
    expect(byId['spec:created']).toMatchObject({ kind: 'spec_edit', event: 'spec.created', link: { place: 'mission', id: 'conv-origin' }, actor: { type: 'agent' } })
    expect(byId['spec:updated']).toMatchObject({ kind: 'spec_edit', event: 'spec.updated', link: { place: 'spec', id: '7' } })
    expect(byId['spec:comment:1']).toMatchObject({ summary: 'Please keep it small' })
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort().reverse())
  })

  it('projects addenda: creation, then the status change with the run that delivered it', () => {
    const a = buildSpecAddendum({ kind: 'clarification', title: 'Use UTC', body: 'All times are UTC.' }, { createdBy: 'user', now: at(1) })
    const applied = { ...a, status: 'applied' as const, run_id: 'run-9', applied_at: at(4), updated_at: at(4) }
    const open = buildSpecAddendum({ kind: 'change-request', title: 'Add a reset', body: 'Add reset.' }, { createdBy: 'agent', now: at(2) })
    const { entries } = collectSpecHistory(db, makeTicket(7, { addenda: [applied, open] }))
    const addenda = entries.filter((e) => e.kind === 'addendum')
    expect(addenda.map((e) => e.event).sort()).toEqual(['addendum.applied', 'addendum.created', 'addendum.created'])
    expect(addenda.find((e) => e.event === 'addendum.applied')).toMatchObject({ tone: 'ok', link: { place: 'job', id: 'run-9' }, at: at(4) })
  })

  it('groups mission turns per conversation with a count, cost split and a mission link', () => {
    conversation('conv-1', 'Counter mission')
    inv({ id: 'i1', surface: 'explore-spec', conversation_id: 'conv-1', ticket_id: 7, total_cost_usd: 0.1, started_at: at(1), num_turns: 2 })
    inv({ id: 'i2', surface: 'chat-sidebar', conversation_id: 'conv-1', ticket_id: 7, total_cost_usd: 0.05, total_cost_usd_estimated: true, started_at: at(2), num_turns: 1 })
    inv({ id: 'i3', surface: 'explore-spec', conversation_id: 'conv-gone', ticket_id: 7, total_cost_usd: 1, started_at: at(3) })
    inv({ id: 'i4', surface: 'explore-spec', conversation_id: 'conv-1', ticket_id: 8, total_cost_usd: 9, started_at: at(3) })
    const missions = collectSpecHistory(db, makeTicket(7)).entries.filter((e) => e.kind === 'mission_turn')
    expect(missions).toHaveLength(1)
    expect(missions[0]).toMatchObject({
      id: 'mission:conv-1', title: 'Counter mission', count: 2, at: at(2), link: { place: 'mission', id: 'conv-1' },
      costKind: 'estimated', turns: 3,
    })
    expect(missions[0]!.costUsd).toBeCloseTo(0.15)
    expect(missions[0]!.costEstimatedUsd).toBeCloseTo(0.05)
    expect(missions[0]!.items).toHaveLength(2)
  })

  it('projects runs with status, failure diagnosis, ticket-attributed cost, phases and audit groups', () => {
    run('run-ok', 7, at(1), 'completed')
    run('run-bad', 7, at(5), 'failed')
    run('run-other', 8, at(2), 'completed')
    inv({ id: 'a', surface_ref_id: 'run-ok#t7', ticket_id: 7, total_cost_usd: 0.4, num_turns: 5 })
    inv({ id: 'b', surface_ref_id: 'run-ok#t8', ticket_id: 8, total_cost_usd: 0.4 })
    inv({ id: 'c', surface_ref_id: 'run-bad', ticket_id: 7 })
    db.prepare('INSERT INTO jobs (id, command, started_at) VALUES (?, ?, ?)').run('run-bad', 'implement', at(5))
    for (const [phase, state] of [['plan', 'done'], ['implement', 'done'], ['review', 'failed']]) {
      db.prepare('INSERT INTO job_phases (job_id, phase, state, updated_at) VALUES (?, ?, ?, ?)').run('run-bad', phase, state, at(5))
    }
    const insertAction = db.prepare('INSERT INTO agent_actions (run_id, job_id, role, kind, target, ts, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
    insertAction.run('run-ok', 'run-ok', 'developer', 'write', 'src/counter.ts', at(2), 'claude-stream')
    insertAction.run('run-ok', null, 'developer', 'read', 'src/a.ts', at(2), 'claude-stream')
    insertAction.run('run-other', null, 'developer', 'write', 'src/other.ts', at(2), 'claude-stream')
    const { entries, runIds } = collectSpecHistory(db, makeTicket(7))
    expect(runIds.sort()).toEqual(['run-bad', 'run-ok'])
    const ok = entries.find((e) => e.id === 'job:run-ok')!
    expect(ok).toMatchObject({ kind: 'job', tone: 'ok', link: { place: 'job', id: 'run-ok' }, costKind: 'billed', turns: 5 })
    expect(ok.costUsd).toBeCloseTo(0.4)
    const bad = entries.find((e) => e.id === 'job:run-bad')!
    expect(bad).toMatchObject({ tone: 'failure', params: { failureKind: 'unknown' } })
    expect(bad.costUsd).toBeUndefined() // reported no cost: absent, never zero
    expect(entries.find((e) => e.id === 'phases:run-bad')).toMatchObject({ kind: 'phase', count: 3, tone: 'failure', params: { failed: 1 } })
    expect(entries.find((e) => e.id === 'audit:run-ok')).toMatchObject({ kind: 'audit', count: 2, params: { write: 1, read: 1 } })
    expect(entries.find((e) => e.id === 'audit:run-ok')!.items).toEqual([expect.objectContaining({ label: 'write', detail: 'src/counter.ts' })])
    expect(entries.some((e) => e.id.includes('run-other'))).toBe(false)
  })

  it('projects PR events and the reviewer verdict with finding locations', () => {
    delivery('d1', [7], 'pr_draft', { prUrl: 'https://github.com/o/r/pull/12', prNumber: 12, branch: 'specrails/7', onReviewAt: at(4), publishedAt: at(5) })
    delivery('d2', [9], 'on_review', {}, 1)
    db.prepare('UPDATE rail_pr_deliveries SET on_review_at = ?, published_at = ? WHERE id = ?').run(at(4), at(5), 'd1')
    updatePrDeliverySettleEvidence(db, 'd1', evidence(7) as never)
    const { entries, deliveries } = collectSpecHistory(db, makeTicket(7))
    expect(deliveries.map((d) => d.id)).toEqual(['d1'])
    expect(entries.filter((e) => e.kind === 'pr_event').map((e) => e.event).sort()).toEqual(['pr.delivery_started', 'pr.published', 'pr.ready_for_review'])
    expect(entries.find((e) => e.event === 'pr.published')).toMatchObject({ url: 'https://github.com/o/r/pull/12', link: { place: 'review', id: 'd1' } })
    const review = entries.find((e) => e.kind === 'review')!
    expect(review).toMatchObject({ params: { verdict: 'changes_requested', findings: 2 }, tone: 'review', link: { place: 'review', id: 'd1' }, count: 2 })
    expect(review.items![0]).toMatchObject({ label: 'Missing null check', detail: 'src/counter.ts:12-14' })
    expect(JSON.stringify(review)).not.toContain(FAKE_ANTHROPIC)
  })

  it('isolates projects: another database never leaks into this spec', () => {
    const other = initDb(':memory:')
    other.prepare('INSERT INTO chat_conversations (id, title, model) VALUES (?, ?, ?)').run('c-x', 'Other project mission', 'sonnet')
    recordInvocation(other, { id: 'x1', project_id: 'p2', provider: 'claude', surface: 'explore-spec', conversation_id: 'c-x', ticket_id: 7, status: 'success', started_at: at(1), total_cost_usd: 5 } as never)
    const mine = collectSpecHistory(db, makeTicket(7))
    expect(mine.entries.some((e) => e.kind === 'mission_turn')).toBe(false)
    expect(mine.invocations).toEqual([])
    expect(collectSpecHistory(other, makeTicket(7)).entries.some((e) => e.kind === 'mission_turn')).toBe(true)
  })
})

describe('timeline paging', () => {
  it('pages newest first with a stable cursor, filters by kind and counts every kind', () => {
    conversation('conv-1', 'M')
    for (let i = 0; i < 5; i++) inv({ id: `m${i}`, surface: 'ai-edit', ticket_id: 7, started_at: at(10 + i) })
    inv({ id: 'mm', surface: 'explore-spec', conversation_id: 'conv-1', ticket_id: 7, started_at: at(20) })
    const all = collectSpecHistory(db, makeTicket(7)).entries
    const first = pageTimeline(all, { kinds: [], limit: 3, cursor: null })
    expect(first.entries).toHaveLength(3)
    expect(first.nextCursor).not.toBeNull()
    const seen = [...first.entries]
    let cursor = first.nextCursor
    while (cursor) {
      const page = pageTimeline(all, { kinds: [], limit: 3, cursor: decodeCursor(cursor) })
      seen.push(...page.entries)
      cursor = page.nextCursor
    }
    expect(seen.map((e) => e.id)).toEqual(sortTimeline(all).map((e) => e.id))
    expect(new Set(seen.map((e) => e.id)).size).toBe(all.length)
    const onlyMissions = pageTimeline(all, { kinds: ['mission_turn'], limit: 50, cursor: null })
    expect(onlyMissions.entries.every((e) => e.kind === 'mission_turn')).toBe(true)
    expect(onlyMissions.counts.spec_edit).toBeGreaterThan(0) // chips keep counting the other kinds
  })
})

describe('hand-off export', () => {
  async function model(ticket: Ticket, planProviders: string[] = []) {
    return buildHandoffModel({
      ticket, history: collectSpecHistory(db, ticket), planProviders: new Set(planProviders), now: new Date(at(30)),
      diffFor: async () => ({ files: 3, additions: 40, deletions: 5, top: [{ path: 'src/counter.ts', status: 'modified', additions: 30, deletions: 2 }] }),
    })
  }

  it('summarises decisions, diff stats, cost and open follow-ups', async () => {
    const decided = buildSpecAddendum({ kind: 'clarification', title: 'Use UTC', body: 'All times are UTC.' }, { createdBy: 'user', now: at(1) })
    const open = buildSpecAddendum({ kind: 'change-request', title: 'Add a reset button', body: 'Please.' }, { createdBy: 'user', now: at(2) })
    delivery('d1', [7], 'pr_draft', { prUrl: 'https://github.com/o/r/pull/12', prNumber: 12, branch: 'specrails/7' })
    updatePrDeliverySettleEvidence(db, 'd1', evidence(7) as never)
    inv({ id: 'a', surface_ref_id: 'run-1', ticket_id: 7, total_cost_usd: 1.5, num_turns: 4 })
    const ticket = makeTicket(7, { addenda: [{ ...decided, status: 'applied' }, open], nonGoals: ['No dark mode'] })
    const md = renderHandoff(await model(ticket), 'md', 'en')
    expect(md).toMatchObject({ filename: 'spec-7-handoff.md', contentType: expect.stringContaining('markdown') })
    expect(md.body).toContain('# Hand-off: #7 Spec 7')
    expect(md.body).toContain('Use UTC')
    expect(md.body).toContain('3 files · +40 / −5')
    expect(md.body).toContain('PR #12')
    expect(md.body).toContain('Changes requested')
    expect(md.body).toContain('- [ ] Add a reset button')
    expect(md.body).toContain('- [ ] Missing null check (`src/counter.ts:12-14`)')
    expect(md.body).toContain('No dark mode')
    expect(md.body).toContain('Billed (provider-reported): $1.50')
  })

  it('keeps billed and estimated cost apart and shows turns, not dollars, for a plan provider', async () => {
    inv({ id: 'a', surface_ref_id: 'r1', ticket_id: 7, total_cost_usd: 1, num_turns: 3 })
    inv({ id: 'b', surface_ref_id: 'r2', ticket_id: 7, total_cost_usd: 0.25, total_cost_usd_estimated: true, num_turns: 2 })
    inv({ id: 'c', surface_ref_id: 'r3', ticket_id: 7, num_turns: 1 })
    inv({ id: 'd', surface_ref_id: 'r4', ticket_id: 7, provider: 'codex', total_cost_usd: 7.77, num_turns: 9 })
    const m = await model(makeTicket(7), ['codex'])
    const claude = m.cost.find((c) => c.provider === 'claude')!
    expect(claude).toMatchObject({ mode: 'dollars', billedUsd: 1, estimatedUsd: 0.25, unpricedRuns: 1, turns: 6 })
    expect(m.cost.find((c) => c.provider === 'codex')).toMatchObject({ mode: 'turns', billedUsd: null, estimatedUsd: null, turns: 9 })
    const body = renderHandoff(m, 'md', 'en').body
    expect(body).toContain('Billed (provider-reported): $1.00')
    expect(body).toContain('Estimated (pricing table): ~$0.2500')
    expect(body).toContain('1 runs reported no cost')
    expect(body).toContain('codex: 9 turns')
    expect(body).not.toContain('7.77')
    expect(body).not.toContain('$1.25') // never summed
  })

  it('redacts secrets from every exported format', async () => {
    const a = buildSpecAddendum({ kind: 'constraint', title: `Deploy with ${FAKE_GITHUB}`, body: `Use API_KEY=supersecretvalue99 and ${FAKE_AWS}\nDB: postgres://admin:${FAKE_URL_PASSWORD}@db.internal/app\nAuthorization: Bearer abcdefghijklmnop1234567890` }, { createdBy: 'user', now: at(1) })
    delivery('d1', [7], 'on_review')
    updatePrDeliverySettleEvidence(db, 'd1', evidence(7) as never)
    const ticket = makeTicket(7, { description: `Token is ${FAKE_ANTHROPIC}`, addenda: [a] })
    const m = await model(ticket)
    for (const format of ['md', 'html', 'pr'] as const) {
      const out = renderHandoff(m, format, 'en')
      for (const secret of [FAKE_ANTHROPIC, FAKE_GITHUB, FAKE_AWS, FAKE_URL_PASSWORD, 'supersecretvalue99', 'abcdefghijklmnop1234567890']) {
        expect(out.body, `${format} leaks ${secret}`).not.toContain(secret)
      }
      expect(out.redactions).toBeGreaterThan(0)
    }
  })

  it('renders a self-contained, escaped HTML bundle', async () => {
    const ticket = makeTicket(7, { title: 'A <script>alert(1)</script> title', description: '<img src=x onerror=alert(1)>' })
    const html = renderHandoff(await model(ticket), 'html', 'en')
    expect(html).toMatchObject({ filename: 'spec-7-handoff.html', contentType: expect.stringContaining('text/html') })
    expect(html.body).toMatch(/^<!doctype html>/)
    expect(html.body).not.toContain('<script')
    expect(html.body).not.toContain('<img')
    expect(html.body).toContain('&lt;script&gt;')
    expect(html.body).not.toMatch(/(src|href)="https?:\/\/(?!github)/) // no remote resources
    expect(html.body).toContain('<style>')
  })

  it('has a concise PR variant without the full request text', async () => {
    const ticket = makeTicket(7, { description: 'Line\n'.repeat(40) })
    const pr = renderHandoff(await model(ticket), 'pr', 'en')
    const full = renderHandoff(await model(ticket), 'md', 'en')
    expect(pr.filename).toBe('spec-7-pr-description.md')
    expect(pr.body).not.toContain('# Hand-off')
    expect(pr.body).not.toContain('## What was asked')
    expect(pr.body.length).toBeLessThan(full.body.length)
  })

  it('localizes headings to the UI locale in all 8 locales', async () => {
    const m = await model(makeTicket(7))
    const seen = new Set<string>()
    for (const locale of HANDOFF_LOCALES) {
      const labels = handoffLabels(locale)
      const out = renderHandoff(m, 'md', locale)
      expect(out.locale).toBe(locale)
      expect(out.body).toContain(`## ${labels.decisions}`)
      expect(Object.values(labels).every((v) => typeof v === 'string' && v.length > 0)).toBe(true)
      seen.add(labels.decisions)
    }
    expect(seen.size).toBe(8)
    expect(resolveHandoffLocale('es-ES')).toBe('es')
    expect(resolveHandoffLocale('xx')).toBe('en')
    expect(renderHandoff(m, 'html', 'ja').body).toContain('<html lang="ja">')
  })

  it('parses its query inputs strictly', () => {
    expect(parseHandoffFormat(undefined)).toBe('md')
    expect(parseHandoffFormat('pdf')).toBeNull()
    expect([...parsePlanProviders('claude, codex,bad value!')]).toEqual(['claude', 'codex'])
  })
})

describe('timeline and hand-off routes', () => {
  let dir: string
  let ticketFile: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-timeline-'))
    ticketFile = path.join(dir, 'tickets.json')
    mutateStore(ticketFile, (store) => { store.tickets['7'] = makeTicket(7, { description: `Secret ${FAKE_ANTHROPIC}`, created_at: at(0), updated_at: at(0) }); store.nextId = 8 })
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  async function withServer<T>(fn: (base: string) => Promise<T>, scopeDb: DbInstance = db): Promise<T> {
    const router = express.Router()
    registerSpecTimelineRoutes(router, { ctx: () => ({ db: scopeDb, project: { path: dir } }), ticketPath: () => ticketFile })
    const app = express(); app.use('/api/projects', router)
    const server = app.listen(0)
    try { return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/p1/tickets`) } finally { server.close() }
  }

  it('serves the paged timeline with counts and rejects malformed input', async () => {
    for (let i = 0; i < 4; i++) inv({ id: `e${i}`, surface: 'ai-edit', ticket_id: 7, started_at: at(i + 1) })
    await withServer(async (base) => {
      const page = await (await fetch(`${base}/7/timeline?limit=2`)).json() as { entries: Array<{ id: string }>; nextCursor: string | null; counts: Record<string, number>; total: number }
      expect(page.entries).toHaveLength(2)
      expect(page.nextCursor).toBeTruthy()
      expect(page.counts.spec_edit).toBe(5)
      const next = await (await fetch(`${base}/7/timeline?limit=2&cursor=${page.nextCursor}`)).json() as { entries: Array<{ id: string }> }
      expect(next.entries.map((e) => e.id)).not.toContain(page.entries[0]!.id)
      const filtered = await (await fetch(`${base}/7/timeline?kinds=addendum`)).json() as { entries: unknown[] }
      expect(filtered.entries).toEqual([])
      expect((await fetch(`${base}/7/timeline?kinds=nope`)).status).toBe(400)
      expect((await fetch(`${base}/7/timeline?limit=0`)).status).toBe(400)
      expect((await fetch(`${base}/7/timeline?cursor=garbage`)).status).toBe(400)
      expect((await fetch(`${base}/abc/timeline`)).status).toBe(400)
      expect((await fetch(`${base}/99/timeline`)).status).toBe(404)
    })
  })

  it('serves a redacted, localized hand-off and respects plan providers', async () => {
    inv({ id: 'a', surface_ref_id: 'r1', ticket_id: 7, provider: 'codex', total_cost_usd: 3.21, num_turns: 4 })
    await withServer(async (base) => {
      const res = await (await fetch(`${base}/7/handoff?format=md&locale=es&planProviders=codex`)).json() as { body: string; filename: string; redactions: number; locale: string }
      expect(res).toMatchObject({ filename: 'spec-7-handoff.md', locale: 'es' })
      expect(res.body).toContain('## Decisiones')
      expect(res.body).not.toContain(FAKE_ANTHROPIC)
      expect(res.body).not.toContain('3.21')
      expect(res.body).toContain('codex: 4 turnos')
      const priced = await (await fetch(`${base}/7/handoff?format=pr`)).json() as { body: string }
      expect(priced.body).toContain('$3.21')
      expect((await fetch(`${base}/7/handoff?format=pdf`)).status).toBe(400)
      expect((await fetch(`${base}/99/handoff`)).status).toBe(404)
    })
  })

  it('reads only the database of the project it is mounted for', async () => {
    inv({ id: 'a', surface: 'ai-edit', ticket_id: 7 })
    const empty = initDb(':memory:')
    await withServer(async (base) => {
      const page = await (await fetch(`${base}/7/timeline`)).json() as { counts: Record<string, number> }
      expect(page.counts.spec_edit).toBe(1) // only the creation entry
    }, empty)
  })
})
