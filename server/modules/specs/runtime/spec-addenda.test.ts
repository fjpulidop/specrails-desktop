import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express, { type Request } from 'express'
import request from 'supertest'

import {
  parseSpecAddendumInput,
  deriveAddendumTitle,
  readSpecAddenda,
  readSpecAddendaSnapshot,
  injectableAddenda,
  openAddenda,
  renderSpecAddendaBriefing,
  parseSpecAddendaReport,
  snapshotSpecAddenda,
  SpecAddendumValidationError,
  SPEC_ADDENDUM_MAX_BODY_CHARS,
  SPEC_ADDENDA_MAX_PER_TICKET,
  type SpecAddendum,
} from './spec-addenda-core'
import {
  buildSpecAddendum,
  appendSpecAddendum,
  editSpecAddendum,
  setSpecAddendumStatus,
  removeSpecAddendum,
  planSpecAddendaAt,
  claimSpecAddendaForRun,
  settleSpecAddendaAt,
  reopenSpecAddenda,
  specAddendumHash,
  broadcastSpecAddendaChange,
} from './spec-addenda'
import { mutateStore, readStore, type Ticket } from './ticket-store'
import { registerTicketsRoutes } from '../../../project-router-tickets'
import { initDb } from '../../../db'
import type { ProjectContext } from '../../../project-registry'
import type { ProjectRoutesDeps } from '../../../project-router-helpers'

function makeTicket(id: number, overrides: Partial<Ticket> = {}): Ticket {
  const now = '2026-09-21T10:00:00.000Z'
  return {
    id,
    title: `Spec ${id}`,
    description: 'Original description that must never change.',
    status: 'todo',
    priority: 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    origin_conversation_id: null,
    is_epic: false,
    parent_epic_id: null,
    execution_order: null,
    short_summary: null,
    created_at: now,
    updated_at: now,
    created_by: 'test',
    source: 'manual',
    ...overrides,
  }
}

function addendum(over: Partial<SpecAddendum> = {}): SpecAddendum {
  const base = buildSpecAddendum(
    { kind: 'change-request', title: 'Use idempotency keys', body: 'Send an Idempotency-Key header on POST /lesson-content.' },
    { createdBy: 'user', now: '2026-09-21T10:00:00.000Z' },
  )
  return { ...base, ...over }
}

// ─── Pure contract ───────────────────────────────────────────────────────────

describe('spec-addenda-core: validation', () => {
  it('accepts a minimal body and derives the title + default kind', () => {
    const parsed = parseSpecAddendumInput({ body: '  # Fix the counter\n\nThe channel counter never decrements.  ' })
    expect(parsed).toEqual({ kind: 'change-request', title: 'Fix the counter', body: '# Fix the counter\n\nThe channel counter never decrements.' })
  })

  it('normalises CRLF, collapses title whitespace and keeps an explicit kind', () => {
    const parsed = parseSpecAddendumInput({ kind: 'review-feedback', title: '  two   words ', body: 'a\r\nb' })
    expect(parsed).toEqual({ kind: 'review-feedback', title: 'two words', body: 'a\nb' })
  })

  it.each([
    [null, 'not_object'],
    [{ body: '' }, 'body_required'],
    [{ body: 42 }, 'body_required'],
    [{ body: 'x', kind: 'bogus' }, 'invalid_kind'],
    [{ body: 'x', version: 2 }, 'unsupported_version'],
    [{ body: 'x', title: 7 }, 'title_required'],
    [{ body: 'x'.repeat(SPEC_ADDENDUM_MAX_BODY_CHARS + 1) }, 'body_too_long'],
    [{ body: 'x', title: 't'.repeat(201) }, 'title_too_long'],
  ])('rejects %j with %s', (raw, code) => {
    expect(() => parseSpecAddendumInput(raw)).toThrowError(SpecAddendumValidationError)
    try { parseSpecAddendumInput(raw) } catch (err) { expect((err as SpecAddendumValidationError).code).toBe(code) }
  })

  it('derives a capped title from the first meaningful line', () => {
    expect(deriveAddendumTitle('\n\n- > first line here\nsecond')).toBe('first line here')
    expect(deriveAddendumTitle('')).toBe('Addendum')
    expect(deriveAddendumTitle('w'.repeat(200))).toHaveLength(118)
  })

  it('reads persisted addenda defensively (drops malformed + duplicate ids, defaults status)', () => {
    const good = addendum()
    const list = readSpecAddenda([good, { ...good }, { id: 'x', hash: 'h', body: '' }, 'junk', { ...good, id: 'y', status: 'weird' }])
    expect(list.map((a) => a.id)).toEqual([good.id, 'y'])
    expect(list[1].status).toBe('open')
    expect(readSpecAddenda(undefined)).toEqual([])
  })

  it('reads a persisted snapshot column defensively', () => {
    const snap = snapshotSpecAddenda([{ ticketId: 3, title: 'T', status: 'todo', addenda: [addendum()] }])
    expect(readSpecAddendaSnapshot(JSON.stringify(snap))).toEqual(snap)
    expect(readSpecAddendaSnapshot('not json')).toBeNull()
    expect(readSpecAddendaSnapshot('[]')).toBeNull()
    expect(readSpecAddendaSnapshot(JSON.stringify([{ ticketId: 'x' }]))).toBeNull()
  })

  it('injectable = open ones plus in-flight ones owned by the same run', () => {
    const a = addendum({ id: 'a' })
    const b = addendum({ id: 'b', status: 'in_flight', run_id: 'run-1' })
    const c = addendum({ id: 'c', status: 'in_flight', run_id: 'run-2' })
    const d = addendum({ id: 'd', status: 'applied' })
    const e = addendum({ id: 'e', status: 'dismissed' })
    expect(injectableAddenda([a, b, c, d, e], 'run-1').map((x) => x.id)).toEqual(['a', 'b'])
    expect(injectableAddenda([a, b, c, d, e]).map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(openAddenda([a, b, c, d, e]).map((x) => x.id)).toEqual(['a'])
  })
})

describe('spec-addenda-core: briefing + report', () => {
  const entries = [
    { ticketId: 191, title: 'Promote tab', status: 'on_review', addenda: [addendum({ id: 'a1' }), addendum({ id: 'a2', kind: 'review-feedback', title: 'Ambiguous writes', body: 'Classify 502 after a PUT as unknown.\n```\nnot an escape\n```' })] },
    { ticketId: 7, title: 'Fresh', status: 'todo', addenda: [addendum({ id: 'a3', kind: 'constraint', title: 'No new deps' })] },
  ]

  it('renders a deterministic briefing that states precedence and the delivered-work rule', () => {
    const text = renderSpecAddendaBriefing(entries)
    expect(renderSpecAddendaBriefing(entries)).toBe(text)
    expect(text).toContain('## SPEC ADDENDA (authoritative for this run)')
    expect(text).toContain('3 addenda on specs #191, #7')
    expect(text).toContain('NEVER edit the spec, its description')
    expect(text).toContain('### Spec #191 — Promote tab (status: on_review)')
    expect(text).toContain('ALREADY HAS DELIVERED WORK')
    expect(text).toContain('### Spec #7 — Fresh (status: todo)')
    expect(text).toContain('one coherent change')
    expect(text).toContain('#### [a1] Change request — Use idempotency keys (hash ')
    expect(text).toContain('#### [a2] Review feedback — Ambiguous writes')
    // A body containing a fence is wrapped in a longer fence so it cannot close early.
    expect(text).toContain('````text\nClassify 502 after a PUT as unknown.\n```\nnot an escape\n```\n````')
    expect(text).toContain('`ADDENDA REPORT`')
    expect(renderSpecAddendaBriefing([])).toBe('')
    expect(renderSpecAddendaBriefing([{ ticketId: 1, title: null, status: null, addenda: [] }])).toBe('')
  })

  it('parses the ADDENDA REPORT lines (last wins, unknown ids ignored, null when silent)', () => {
    const ids = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]
    expect(parseSpecAddendaReport(null, ids)).toBeNull()
    expect(parseSpecAddendaReport('all good, tests pass', ids)).toBeNull()
    expect(parseSpecAddendaReport('- [a1] applied', [])).toBeNull()
    const out = parseSpecAddendaReport([
      'ADDENDA REPORT',
      '- [a1] partial — files: lib/api.ts — tests: api.test.ts — notes: key per pair',
      '- [zz] applied — files: nope',
      '- [a1] applied — files: lib/api.ts, lib/promoteRun.ts — tests: promote.test.ts',
      '* [a3] blocked — notes: needs the upstream contract',
    ].join('\n'), ids)
    expect(out).toEqual([
      { addendumId: 'a1', verdict: 'applied', files: 'lib/api.ts, lib/promoteRun.ts', tests: 'promote.test.ts', notes: null },
      { addendumId: 'a3', verdict: 'blocked', files: null, tests: null, notes: 'needs the upstream contract' },
    ])
  })
})

// ─── Store lifecycle ─────────────────────────────────────────────────────────

describe('spec-addenda: ticket-store lifecycle', () => {
  let dir: string
  let storePath: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-addenda-'))
    storePath = path.join(dir, 'local-tickets.json')
    mutateStore(storePath, (s) => {
      s.tickets['1'] = makeTicket(1)
      s.tickets['2'] = makeTicket(2, { status: 'on_review' })
      s.next_id = 3
    })
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('hash is content-only and stable', () => {
    const a = buildSpecAddendum({ kind: 'change-request', title: 'T', body: 'B' }, { createdBy: 'user' })
    expect(a.hash).toBe(specAddendumHash({ kind: 'change-request', title: 'T', body: 'B' }))
    expect(a.hash).not.toBe(specAddendumHash({ kind: 'constraint', title: 'T', body: 'B' }))
    expect(a.status).toBe('open')
    expect(a.run_id).toBeNull()
  })

  it('append enforces the per-ticket cap and bumps updated_at; the description is untouched', () => {
    const store = mutateStore(storePath, (s) => {
      for (let i = 0; i < SPEC_ADDENDA_MAX_PER_TICKET; i++) appendSpecAddendum(s.tickets['1'], addendum({ id: `id-${i}` }))
      expect(() => appendSpecAddendum(s.tickets['1'], addendum({ id: 'overflow' }))).toThrowError(SpecAddendumValidationError)
    })
    expect(store.tickets['1'].addenda).toHaveLength(SPEC_ADDENDA_MAX_PER_TICKET)
    expect(store.tickets['1'].description).toBe('Original description that must never change.')
    expect(readStore(storePath).schema_version).toBe('1.4')
  })

  it('edit/status/remove honour the lifecycle rules', () => {
    mutateStore(storePath, (s) => {
      const t = s.tickets['1']
      appendSpecAddendum(t, addendum({ id: 'open' }))
      appendSpecAddendum(t, addendum({ id: 'flying', status: 'in_flight', run_id: 'r1' }))
      appendSpecAddendum(t, addendum({ id: 'done', status: 'applied', run_id: 'r0', applied_at: '2026-09-20T00:00:00.000Z' }))
      appendSpecAddendum(t, addendum({ id: 'gone', status: 'dismissed' }))

      const edited = editSpecAddendum(t, 'open', { kind: 'constraint', title: 'New', body: 'New body' }, '2026-09-21T11:00:00.000Z')
      expect(typeof edited === 'object' && edited.hash).toBe(specAddendumHash({ kind: 'constraint', title: 'New', body: 'New body' }))
      expect(editSpecAddendum(t, 'flying', { kind: 'constraint', title: 'x', body: 'y' })).toBe('in_flight')
      expect(editSpecAddendum(t, 'done', { kind: 'constraint', title: 'x', body: 'y' })).toBe('applied')
      expect(editSpecAddendum(t, 'nope', { kind: 'constraint', title: 'x', body: 'y' })).toBe('not_found')
      expect(typeof editSpecAddendum(t, 'gone', { kind: 'constraint', title: 'x', body: 'y' })).toBe('object')

      expect(setSpecAddendumStatus(t, 'flying', 'dismissed')).toBe('in_flight')
      const released = setSpecAddendumStatus(t, 'flying', 'open', undefined, { force: true })
      expect(typeof released === 'object' && released.status).toBe('open')
      expect(typeof released === 'object' && released.run_id).toBeNull()
      // Put the claim back so the remaining assertions exercise the frozen state.
      t.addenda = readSpecAddenda(t.addenda).map((a) => (a.id === 'flying' ? { ...a, status: 'in_flight' as const, run_id: 'r1' } : a))
      const reopened = setSpecAddendumStatus(t, 'done', 'open')
      expect(typeof reopened === 'object' && reopened.status).toBe('open')
      expect(typeof reopened === 'object' && reopened.run_id).toBeNull()
      expect(typeof reopened === 'object' && reopened.applied_at).toBeNull()
      const dismissed = setSpecAddendumStatus(t, 'open', 'dismissed')
      expect(typeof dismissed === 'object' && dismissed.status).toBe('dismissed')

      expect(removeSpecAddendum(t, 'flying')).toBe('in_flight')
      expect(removeSpecAddendum(t, 'missing')).toBe('not_found')
      expect(removeSpecAddendum(t, 'gone')).toBe(true)
      expect(readSpecAddenda(t.addenda).map((a) => a.id)).toEqual(['open', 'flying', 'done'])
    })
  })

  it('plan → claim → settle(completed) marks applied with the run id; a second claim by the same run is idempotent', () => {
    mutateStore(storePath, (s) => {
      appendSpecAddendum(s.tickets['1'], addendum({ id: 'a' }))
      appendSpecAddendum(s.tickets['1'], addendum({ id: 'dismissed', status: 'dismissed' }))
      appendSpecAddendum(s.tickets['2'], addendum({ id: 'b' }))
    })
    expect(planSpecAddendaAt(storePath, [1, 2, 99]).map((e) => [e.ticketId, e.addenda.map((a) => a.id)])).toEqual([[1, ['a']], [2, ['b']]])
    expect(planSpecAddendaAt(path.join(dir, 'missing.json'), [1])).toEqual([])

    const claimed = claimSpecAddendaForRun(storePath, [1, 2], 'run-1')
    expect(claimed.changedTicketIds).toEqual([1, 2])
    expect(claimed.snapshot.map((e) => e.id)).toEqual(['a', 'b'])
    expect(claimed.briefing).toContain('#### [a]')
    expect(claimed.briefing).toContain('### Spec #2 — Spec 2 (status: on_review)')
    let store = readStore(storePath)
    expect(readSpecAddenda(store.tickets['1'].addenda).find((a) => a.id === 'a')).toMatchObject({ status: 'in_flight', run_id: 'run-1' })
    expect(readSpecAddenda(store.tickets['1'].addenda).find((a) => a.id === 'dismissed')?.status).toBe('dismissed')

    const again = claimSpecAddendaForRun(storePath, [1, 2], 'run-1')
    expect(again.changedTicketIds).toEqual([])
    expect(again.briefing).toBe(claimed.briefing)

    // Another run cannot steal an in-flight addendum, and sees nothing to inject.
    const other = claimSpecAddendaForRun(storePath, [1], 'run-2')
    expect(other.briefing).toBe('')
    expect(other.changedTicketIds).toEqual([])

    const wrongRun = settleSpecAddendaAt(storePath, [1, 2], 'run-2', 'completed')
    expect(wrongRun.changedTicketIds).toEqual([])
    const settled = settleSpecAddendaAt(storePath, [1, 2], 'run-1', 'completed')
    expect(settled.changedTicketIds).toEqual([1, 2])
    store = readStore(storePath)
    const a = readSpecAddenda(store.tickets['1'].addenda).find((x) => x.id === 'a')!
    expect(a.status).toBe('applied')
    expect(a.run_id).toBe('run-1')
    expect(a.applied_at).toBeTruthy()
    expect(store.tickets['1'].description).toBe('Original description that must never change.')
    // Settling twice is a no-op (no lock, no rewrite).
    expect(settleSpecAddendaAt(storePath, [1, 2], 'run-1', 'completed').changedTicketIds).toEqual([])
  })

  it('a failed / canceled run reopens what it claimed; a discarded delivery reopens applied ones by snapshot', () => {
    mutateStore(storePath, (s) => {
      appendSpecAddendum(s.tickets['1'], addendum({ id: 'a' }))
      appendSpecAddendum(s.tickets['1'], addendum({ id: 'later' }))
    })
    const claimed = claimSpecAddendaForRun(storePath, [1], 'run-1')
    expect(claimed.snapshot.map((e) => e.id)).toEqual(['a', 'later'])
    settleSpecAddendaAt(storePath, [1], 'run-1', 'failed')
    let list = readSpecAddenda(readStore(storePath).tickets['1'].addenda)
    expect(list.map((x) => [x.id, x.status, x.run_id])).toEqual([['a', 'open', null], ['later', 'open', null]])

    claimSpecAddendaForRun(storePath, [1], 'run-2')
    settleSpecAddendaAt(storePath, [1], 'run-2', 'completed')
    list = readSpecAddenda(readStore(storePath).tickets['1'].addenda)
    expect(list.every((x) => x.status === 'applied')).toBe(true)

    const store = mutateStore(storePath, (s) => {
      const changed = reopenSpecAddenda(s, [{ ticketId: 1, id: 'a', kind: 'change-request', title: 'T', hash: 'h' }, { ticketId: 42, id: 'zz', kind: 'constraint', title: 'x', hash: 'h' }])
      expect(changed).toEqual([1])
    })
    list = readSpecAddenda(store.tickets['1'].addenda)
    expect(list.find((x) => x.id === 'a')).toMatchObject({ status: 'open', run_id: null, applied_at: null })
    expect(list.find((x) => x.id === 'later')?.status).toBe('applied')
  })

  it('claim with an explicit frozen plan ignores addenda added after the plan', () => {
    mutateStore(storePath, (s) => appendSpecAddendum(s.tickets['1'], addendum({ id: 'a' })))
    const plan = planSpecAddendaAt(storePath, [1])
    mutateStore(storePath, (s) => appendSpecAddendum(s.tickets['1'], addendum({ id: 'late' })))
    const claimed = claimSpecAddendaForRun(storePath, [1], 'run-1', { plan })
    expect(claimed.snapshot.map((e) => e.id)).toEqual(['a'])
    const list = readSpecAddenda(readStore(storePath).tickets['1'].addenda)
    expect(list.find((x) => x.id === 'late')?.status).toBe('open')
  })

  it('claim/settle never throw on an unreadable store and broadcast only changed tickets', () => {
    fs.writeFileSync(storePath, '{broken')
    expect(claimSpecAddendaForRun(storePath, [1], 'r').briefing).toBe('')
    expect(settleSpecAddendaAt(storePath, [1], 'r', 'completed').changedTicketIds).toEqual([])
    const broadcast = vi.fn()
    broadcastSpecAddendaChange(broadcast, 'p1', { changedTicketIds: [1, 5], store: { tickets: { '1': makeTicket(1) } } as never })
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls[0][0]).toMatchObject({ type: 'ticket_updated', projectId: 'p1' })
  })
})

// ─── REST routes ─────────────────────────────────────────────────────────────

describe('spec-addenda: REST routes', () => {
  let dir: string
  let storePath: string
  let app: express.Express
  let broadcast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-addenda-routes-'))
    storePath = path.join(dir, 'local-tickets.json')
    mutateStore(storePath, (s) => { s.tickets['1'] = makeTicket(1); s.next_id = 2 })
    broadcast = vi.fn()
    const db = initDb(':memory:')
    const ctx = () => ({
      project: { id: 'p1', slug: 'proj', path: dir, name: 'Proj', provider: 'claude', providers: ['claude'] },
      db,
      broadcast,
      ticketWatcher: { notifyDesktopWrite: vi.fn() },
      jiraSyncManager: { onSpecEdited: vi.fn(), isActive: () => false },
    }) as unknown as ProjectContext
    const router = express.Router()
    registerTicketsRoutes({ router, registry: {} as never, ctx, ticketPath: (_req: Request) => storePath } as ProjectRoutesDeps)
    app = express()
    app.use(express.json())
    app.use('/api/projects', router)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('POST creates, GET lists, PATCH edits/dismisses/reopens, DELETE removes — never touching the description', async () => {
    const created = await request(app).post('/api/projects/p1/tickets/1/addenda').send({ body: 'Send an Idempotency-Key header.', kind: 'review-feedback', createdBy: 'agent', originConversationId: 'conv-1' })
    expect(created.status).toBe(201)
    expect(created.body.addendum).toMatchObject({ kind: 'review-feedback', title: 'Send an Idempotency-Key header.', status: 'open', created_by: 'agent', origin_conversation_id: 'conv-1' })
    expect(created.body.ticket.description).toBe('Original description that must never change.')
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket_updated', projectId: 'p1' }))
    const id = created.body.addendum.id as string

    const listed = await request(app).get('/api/projects/p1/tickets/1/addenda')
    expect(listed.status).toBe(200)
    expect(listed.body.addenda).toHaveLength(1)

    const edited = await request(app).patch(`/api/projects/p1/tickets/1/addenda/${id}`).send({ title: 'Idempotency', body: 'Generate one stable key per pair.' })
    expect(edited.status).toBe(200)
    expect(edited.body.addendum).toMatchObject({ title: 'Idempotency', kind: 'review-feedback' })
    expect(edited.body.addendum.hash).not.toBe(created.body.addendum.hash)

    const dismissed = await request(app).patch(`/api/projects/p1/tickets/1/addenda/${id}`).send({ status: 'dismissed' })
    expect(dismissed.body.addendum.status).toBe('dismissed')
    const reopened = await request(app).patch(`/api/projects/p1/tickets/1/addenda/${id}`).send({ status: 'open' })
    expect(reopened.body.addendum.status).toBe('open')

    const removed = await request(app).delete(`/api/projects/p1/tickets/1/addenda/${id}`)
    expect(removed.status).toBe(200)
    expect(readSpecAddenda(readStore(storePath).tickets['1'].addenda)).toEqual([])
  })

  it('validates input and ids, and answers 404 / 409 for the lifecycle', async () => {
    expect((await request(app).post('/api/projects/p1/tickets/1/addenda').send({ body: '' })).status).toBe(400)
    expect((await request(app).post('/api/projects/p1/tickets/1/addenda').send({ body: 'x', kind: 'nope' })).body).toMatchObject({ error: 'invalid_addendum', code: 'invalid_kind' })
    expect((await request(app).post('/api/projects/p1/tickets/abc/addenda').send({ body: 'x' })).status).toBe(400)
    expect((await request(app).post('/api/projects/p1/tickets/9/addenda').send({ body: 'x' })).status).toBe(404)
    expect((await request(app).get('/api/projects/p1/tickets/9/addenda')).status).toBe(404)
    expect((await request(app).patch('/api/projects/p1/tickets/1/addenda/bad id').send({ status: 'open' })).status).toBe(400)
    expect((await request(app).patch('/api/projects/p1/tickets/1/addenda/missing').send({ status: 'open' })).status).toBe(404)
    expect((await request(app).patch('/api/projects/p1/tickets/1/addenda/missing').send({})).status).toBe(400)
    expect((await request(app).patch('/api/projects/p1/tickets/1/addenda/missing').send({ status: 'applied' })).body.code).toBe('invalid_status')
    expect((await request(app).delete('/api/projects/p1/tickets/1/addenda/missing')).status).toBe(404)

    mutateStore(storePath, (s) => {
      appendSpecAddendum(s.tickets['1'], addendum({ id: 'flying', status: 'in_flight', run_id: 'r1' }))
      appendSpecAddendum(s.tickets['1'], addendum({ id: 'done', status: 'applied' }))
    })
    expect((await request(app).patch('/api/projects/p1/tickets/1/addenda/flying').send({ body: 'y' })).body.error).toBe('addendum_in_flight')
    expect((await request(app).patch('/api/projects/p1/tickets/1/addenda/flying').send({ status: 'dismissed' })).status).toBe(409)
    // The escape hatch: an explicit force releases a claim whose run vanished.
    expect((await request(app).patch('/api/projects/p1/tickets/1/addenda/flying').send({ status: 'open', force: true })).body.addendum).toMatchObject({ status: 'open', run_id: null })
    mutateStore(storePath, (s) => { s.tickets['1'].addenda = readSpecAddenda(s.tickets['1'].addenda).map((a) => (a.id === 'flying' ? { ...a, status: 'in_flight' as const, run_id: 'r1' } : a)) })
    expect((await request(app).delete('/api/projects/p1/tickets/1/addenda/flying')).status).toBe(409)
    expect((await request(app).patch('/api/projects/p1/tickets/1/addenda/done').send({ body: 'y' })).body.error).toBe('addendum_applied')
    // Reopening an applied one is allowed (it rides the next launch again).
    expect((await request(app).patch('/api/projects/p1/tickets/1/addenda/done').send({ status: 'open' })).body.addendum.status).toBe('open')
  })

  it('GET /tickets/:id exposes addenda and PATCH /tickets/:id cannot overwrite them', async () => {
    await request(app).post('/api/projects/p1/tickets/1/addenda').send({ body: 'keep me' })
    const patched = await request(app).patch('/api/projects/p1/tickets/1').send({ description: 'edited', addenda: [] })
    expect(patched.status).toBe(200)
    const got = await request(app).get('/api/projects/p1/tickets/1')
    expect(got.body.ticket.addenda).toHaveLength(1)
    expect(got.body.ticket.description).toBe('edited')
  })
})
