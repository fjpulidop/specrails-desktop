import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'specs-v2-test-token' }))

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import express from 'express'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createProjectRouter } from '../../../project-router'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import type { ProjectContext, ProjectRegistry } from '../../../project-registry'
import { call, createHarness, type Harness } from '../__fixtures__/harness'
import { registerV2Tool } from '../core/registry'
import { approxTokens } from '../core/size-guard'
import { matchesPointer } from '../core/untrusted'
import { v2Catalog } from '../index'
import { bodyOf, criteriaOf, forecastFor, projectSpecState, specsTool } from './specs'

// End to end: the MCP tool → loopback HTTP → the real project router (ticket,
// trash, addenda, attachment, search, rails and bulk routes) on a temp project.

let server: Server
let port = 0
let tmpDir: string
let projectDb: DbInstance
let broadcast: ReturnType<typeof vi.fn>
let h: Harness
let client: Client

function makeContext(): ProjectContext {
  return {
    project: { id: 'p1', slug: 'shop-api', name: 'Shop API', path: tmpDir, db_path: ':memory:', added_at: '', last_seen_at: '' },
    db: projectDb,
    queueManager: { getJobs: vi.fn(() => []), phasesForCommand: vi.fn(() => []) } as any,
    chatManager: { isActive: vi.fn(() => false), forgetSpecDraft: vi.fn(), forgetExploreLifecycle: vi.fn() } as any,
    setupManager: {} as any,
    proposalManager: {} as any,
    specLauncherManager: {} as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    railJobs: new Map(),
    railLoopRuns: new Map(),
    broadcast: (msg: unknown) => broadcast(msg),
  } as unknown as ProjectContext
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specs-v2-'))
  projectDb = initDb(':memory:')
  const context = makeContext()
  const registry = {
    desktopDb: initDesktopDb(':memory:'),
    getContext: (id: string) => (id === 'p1' ? context : undefined),
    getContextByPath: () => undefined,
    listContexts: () => [context],
    touchProject: () => {},
    getProjectRow: () => context.project,
    listFailedProjects: () => [],
  } as unknown as ProjectRegistry
  const app = express()
  app.use(express.json())
  app.use('/api/projects', createProjectRouter(registry))
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  for (const name of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, name), { recursive: true, force: true })
  broadcast = vi.fn()
  h = createHarness()
  h.ctx.desktopPort = port
  h.ctx.sessionState = { activeProjectId: 'p1', sessionKey: 'session-a' } as never
  registerV2Tool(h.server, h.ctx, specsTool, { catalog: v2Catalog() })
  client = await h.connect()
})

afterEach(() => { vi.restoreAllMocks() })

const specs = (args: Record<string, unknown>) => call(client, 'specrails_specs', args)

async function seed(count: number, fields: (i: number) => Record<string, unknown> = () => ({})): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/p1/tickets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `Spec ${i}`, description: `Body ${i}`, status: 'todo', priority: 'medium', ...fields(i) }),
    })
    ids.push(((await res.json()) as { ticket: { id: number } }).ticket.id)
  }
  return ids
}

const ref = (id: number) => `spec:shop-api/${id}`
const tokens = (envelope: unknown) => approxTokens(JSON.stringify(envelope))

describe('specrails_specs list and search', () => {
  it('pages with an absolute cursor and no overlap', async () => {
    await seed(23)
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const { envelope } = await specs({ action: 'list', limit: 10, ...(cursor ? { cursor } : {}) })
      expect(envelope.ok).toBe(true)
      seen.push(...envelope.data.items.map((item: { ref: string }) => item.ref))
      expect(envelope.page.total).toBe(23)
      cursor = envelope.page.cursor ?? undefined
      pages += 1
    } while (cursor)
    expect(pages).toBe(3)
    expect(new Set(seen).size).toBe(23)
  })

  it('refuses a cursor minted for another query', async () => {
    await seed(3)
    const first = await specs({ action: 'list', limit: 1 })
    const other = await specs({ action: 'list', limit: 1, filter: { priority: 'high' }, cursor: first.envelope.page.cursor })
    expect(other.envelope.error.code).toBe('invalid_input')
  })

  it('filters by status, priority, label, milestone and rail', async () => {
    const ids = await seed(6, (i) => ({ priority: i < 2 ? 'high' : 'low', status: i === 5 ? 'done' : 'todo', labels: i % 2 ? ['M2', 'api'] : ['M1'] }))
    const high = await specs({ action: 'list', filter: { priority: 'high' } })
    expect(high.envelope.data.items).toHaveLength(2)
    const milestone = await specs({ action: 'list', filter: { milestone: 2, label: 'api' } })
    expect(milestone.envelope.data.items.map((i: { ref: string }) => i.ref).sort()).toEqual([ids[1], ids[3], ids[5]].map(ref).sort())
    const active = await specs({ action: 'list', filter: { status: ['active'] } })
    expect(active.envelope.data.items).toHaveLength(5)
    expect(active.envelope.summary).toMatch(/5 specs/)
    const bad = await specs({ action: 'list', filter: { status: 'nope' } })
    expect(bad.envelope.error.code).toBe('invalid_input')
    expect(bad.envelope.error.next).toBeUndefined()
    // Deleted specs alone: the list answers with the trash itself; mixed with live statuses it says where they are.
    const trashed = await specs({ action: 'list', filter: { status: ['trashed'] } })
    expect(trashed.envelope).toEqual(expect.objectContaining({ ok: true, data: expect.objectContaining({ items: expect.any(Array) }) }))
    expect(trashed.envelope).toEqual((await specs({ action: 'trash' })).envelope)
    const mixed = await specs({ action: 'list', filter: { status: ['todo', 'trashed'] } })
    expect(mixed.envelope.error.message).toMatch(/specrails_specs\(trash\)/)
    expect(mixed.envelope.error.next).toEqual([expect.objectContaining({ tool: 'specrails_specs', args: { action: 'trash' } })])
    await fetch(`http://127.0.0.1:${port}/api/projects/p1/rails/0/tickets`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticketIds: [ids[0], ids[4]] }) })
    const rail = await specs({ action: 'list', filter: { rail: 0 } })
    expect(rail.envelope.data.items.map((i: { ref: string }) => i.ref).sort()).toEqual([ids[0], ids[4]].map(ref).sort())
  })

  it('keeps a 100-spec page under the summary cap with an absolute cursor', async () => {
    await seed(100, (i) => ({ title: `A long spec title number ${i} that describes a fairly involved change`, labels: ['backend', 'M3', 'api'] }))
    const { envelope } = await specs({ action: 'list', limit: 100 })
    expect(tokens(envelope)).toBeLessThan(1_500)
    const shown = envelope.data.items.length
    expect(shown).toBeLessThan(100)
    expect(envelope.page.truncated).toBe(true)
    const next = await specs({ action: 'list', limit: 100, cursor: envelope.page.cursor })
    expect(next.envelope.data.items[0].ref).not.toBe(envelope.data.items[0].ref)
    const all = new Set([...envelope.data.items, ...next.envelope.data.items].map((i: { ref: string }) => i.ref))
    expect(all.size).toBe(shown + next.envelope.data.items.length)
  })

  it('searches ranked and marks titles untrusted', async () => {
    await seed(3, (i) => ({ title: i === 1 ? 'Checkout uses Stripe' : `Other ${i}` }))
    const { envelope } = await specs({ action: 'search', query: 'stripe' })
    expect(envelope.data.items).toHaveLength(1)
    expect(envelope.untrusted.some((p: string) => matchesPointer(p, '/data/items/0/title'))).toBe(true)
    const missing = await specs({ action: 'search' })
    expect(missing.envelope.error.code).toBe('invalid_input')
  })
})

describe('specrails_specs get', () => {
  it('returns the summary with decision state and offers', async () => {
    const [id] = await seed(1, () => ({ description: 'Intro\n\n## Acceptance Criteria\n- one\n- two\n\n## Notes\nx' }))
    const { envelope } = await specs({ action: 'get', ref: ref(id) })
    expect(envelope.ok).toBe(true)
    expect(envelope.data).toMatchObject({ ref: ref(id), status: 'todo', criteria: 2 })
    expect(envelope.state.status).toBe('queued')
    expect(envelope.state.recommended).toBe('launch')
    expect(envelope.state.offers.find((o: { id: string }) => o.id === 'launch').call).toEqual({ tool: 'specrails_runs', args: { action: 'launch', project: 'shop-api', target: { specIds: [ref(id)] } } })
    expect(envelope.untrusted.some((p: string) => matchesPointer(p, '/data/excerpt'))).toBe(true)
    expect(tokens(envelope)).toBeLessThan(1_500)
  })

  it('detail adds the body and the requested sections', async () => {
    const [id] = await seed(1)
    await specs({ action: 'addendum_add', ref: ref(id), body: 'Also handle refunds' })
    const { envelope } = await specs({ action: 'get', ref: ref(id), view: 'detail', fields: ['addenda', 'timeline', 'criteria'] })
    expect(envelope.data.body).toBe('Body 0')
    expect(envelope.data.addenda[0]).toMatchObject({ kind: 'change-request', status: 'open', body: 'Also handle refunds' })
    expect(envelope.data.addenda[0].ref).toMatch(/^addendum:shop-api\/\d+:/)
    expect(envelope.data.timeline.items.length).toBeGreaterThan(0)
    expect(envelope.state.offers.find((o: { id: string }) => o.id === 'launch').label).toMatch(/1 open addenda/)
    expect(tokens(envelope)).toBeLessThan(10_000)
  })

  it('fails clearly for a missing spec, a bad ref and the v1 id shape', async () => {
    expect((await specs({ action: 'get', ref: ref(999) })).envelope.error.code).toBe('not_found')
    expect((await specs({ action: 'get', ref: 'spec:shop-api/abc' })).envelope.error.code).toBe('invalid_input')
    // The v1 `id` shape keeps working as a bare ref (core v1 argument normalization).
    const [id] = await seed(1)
    const v1 = await specs({ action: 'get', id })
    expect(v1.envelope.ok).toBe(true)
    expect(v1.envelope.data.ref).toBe(ref(id))
  })
})

describe('specrails_specs create and update', () => {
  it('creates verbatim, idea and draft specs without AI', async () => {
    const verbatim = await specs({ action: 'create', mode: 'verbatim', title: 'Raw', body: 'Exactly this' })
    expect(verbatim.envelope.ok).toBe(true)
    expect(verbatim.envelope.refs.spec).toMatch(/^spec:shop-api\//)
    const idea = await specs({ action: 'create', mode: 'idea', body: 'Dark mode\nsome notes' })
    expect(idea.envelope.data).toMatchObject({ status: 'draft', title: 'Dark mode' })
    expect(idea.envelope.state.recommended).toBe('promote')
    const draft = await specs({ action: 'create', mode: 'draft', title: 'Authored', body: 'Full spec', options: { labels: ['api'], priority: 'high', criteria: ['works'] } })
    expect(draft.envelope.ok).toBe(true)
    expect(draft.envelope.data).toMatchObject({ title: 'Authored', priority: 'high', labels: ['api'] })
    const missing = await specs({ action: 'create', mode: 'verbatim' })
    expect(missing.envelope.error.code).toBe('invalid_input')
  })

  it('create(request) asks to confirm the unknown cost, then waits for the spec agent', async () => {
    const first = await specs({ action: 'create', mode: 'request', body: 'Users want CSV export' })
    expect(first.envelope.error.code).toBe('confirmation_required')
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/tickets/generate-spec')) {
        setTimeout(async () => {
          const res = await realFetch(`http://127.0.0.1:${port}/api/projects/p1/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'CSV export', status: 'todo', priority: 'medium' }) })
          const ticket = ((await res.json()) as { ticket: unknown }).ticket
          h.ctx.eventBus.publish({ type: 'spec_gen_done', projectId: 'p1', requestId: 'req-1', ticket } as never)
        }, 20)
        return new Response(JSON.stringify({ requestId: 'req-1' }), { status: 202 })
      }
      return realFetch(input, init)
    })
    const done = await specs({ action: 'create', mode: 'request', body: 'Users want CSV export', confirm: first.envelope.error.confirmToken })
    expect(done.envelope.ok).toBe(true)
    expect(done.envelope.data.title).toBe('CSV export')
    const again = await specs({ action: 'create', mode: 'request', body: 'Users want CSV export', confirm: first.envelope.error.confirmToken })
    expect(again.envelope.error.code).toBe('stale')
    expect(again.envelope.error.reason).toBe('replayed')
  })

  it('a pending AI result stays readable through get(options.request)', async () => {
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/ai-edit')) return new Response(JSON.stringify({ requestId: 'edit-1' }), { status: 202 })
      return realFetch(input, init)
    })
    const [id] = await seed(1)
    const preview = await specs({ action: 'ai_edit', ref: ref(id), body: 'Shorter', dryRun: true, options: { waitMs: 0 } })
    const pending = await specs({ action: 'ai_edit', ref: ref(id), body: 'Shorter', confirm: preview.envelope.data.confirmToken, options: { waitMs: 0 } })
    expect(pending.envelope.data).toMatchObject({ request: 'edit-1', status: 'pending' })
    h.ctx.eventBus.publish({ type: 'ticket_ai_edit_done', projectId: 'p1', ticketId: id, requestId: 'edit-1', fullText: 'New body' } as never)
    // The hint names only the request: that alone reads it (it remembers its project).
    const byRequest = await specs({ action: 'get', options: { request: 'edit-1' } })
    expect(byRequest.isError, JSON.stringify(byRequest.envelope)).toBe(false)
    expect(byRequest.envelope.data).toMatchObject({ request: 'edit-1' })
    const read = await specs({ action: 'get', ref: ref(id), options: { request: 'edit-1' } })
    expect(read.envelope.data).toMatchObject({ status: 'done', proposal: 'New body', spec: ref(id) })
    expect(read.envelope.untrusted).toContain('/data/proposal')
  })

  it('updates fields, milestone and rail, and returns an undo call', async () => {
    const [id] = await seed(1, () => ({ labels: ['M1', 'ui'] }))
    const { envelope } = await specs({ action: 'update', ref: ref(id), patch: { title: 'Renamed', status: 'done', milestone: 2, rail: 1 } })
    expect(envelope.ok).toBe(true)
    expect(envelope.data).toMatchObject({ title: 'Renamed', status: 'done', labels: ['ui', 'M2'], rail: { index: 1 } })
    expect(envelope.state.status).toBe('succeeded')
    const undo = envelope.data.undo
    expect(undo.args.patch).toMatchObject({ title: 'Spec 0', status: 'todo', labels: ['M1', 'ui'] })
    const back = await specs(undo.args)
    expect(back.envelope.data).toMatchObject({ title: 'Spec 0', status: 'todo', labels: ['M1', 'ui'] })
    const bad = await specs({ action: 'update', ref: ref(id), patch: { colour: 'red' } })
    expect(bad.envelope.error.code).toBe('invalid_input')
  })
})

describe('specrails_specs bulk_update', () => {
  it('edits a selection, reports skips and undoes per spec', async () => {
    const ids = await seed(3, (i) => ({ priority: i === 0 ? 'high' : 'low' }))
    const { envelope } = await specs({ action: 'bulk_update', refs: [...ids.map(ref), ref(999)], patch: { priority: 'high', addLabels: ['q4'] } })
    expect(envelope.ok).toBe(true)
    expect(envelope.data.changed).toEqual(ids.map(ref))
    expect(envelope.data.skipped).toEqual([{ ref: ref(999), reason: 'not_found' }])
    const undo = await specs(envelope.data.undo.args)
    expect(undo.envelope.data.changed).toHaveLength(3)
    const first = await specs({ action: 'get', ref: ref(ids[0]) })
    expect(first.envelope.data).toMatchObject({ priority: 'high' })
    expect(first.envelope.data.labels).toBeUndefined()
    const second = await specs({ action: 'get', ref: ref(ids[1]) })
    expect(second.envelope.data.priority).toBe('low')
  })

  it('trashes and restores a selection without confirmation (reversible)', async () => {
    const ids = await seed(2)
    const trashed = await specs({ action: 'bulk_update', refs: ids.map(ref), patch: { trash: true } })
    expect(trashed.envelope.data.changed).toEqual(ids.map(ref))
    const list = await specs({ action: 'trash' })
    expect(list.envelope.data.items).toHaveLength(2)
    const restored = await specs(trashed.envelope.data.undo.args)
    expect(restored.envelope.data.changed).toHaveLength(2)
    expect((await specs({ action: 'list' })).envelope.data.items).toHaveLength(2)
  })

  it('merge needs a confirmation bound to the specs, goes stale when they change, then merges', async () => {
    const ids = await seed(3)
    const args = { action: 'bulk_update', refs: [ref(ids[1]), ref(ids[2])], patch: { mergeInto: ref(ids[0]) } }
    const first = await specs(args)
    expect(first.envelope.error.code).toBe('confirmation_required')
    expect(first.envelope.error.preview.effect).toMatch(/Folds 2 specs/)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await specs({ action: 'update', ref: ref(ids[2]), patch: { title: 'Changed meanwhile' } })
    const stale = await specs({ ...args, confirm: first.envelope.error.confirmToken })
    expect(stale.envelope.error.code).toBe('stale')
    const done = await specs({ ...args, confirm: stale.envelope.error.confirmToken })
    expect(done.envelope.ok).toBe(true)
    expect(done.envelope.data.merged).toEqual([ref(ids[1]), ref(ids[2])])
    const target = await specs({ action: 'get', ref: ref(ids[0]), view: 'detail' })
    expect(target.envelope.data.body).toMatch(/## Merged from #\d+: Changed meanwhile/)
    expect((await specs({ action: 'list' })).envelope.data.items).toHaveLength(1)
  })

  it('reorders by refs order and refuses mixed operations', async () => {
    const ids = await seed(3)
    const { envelope } = await specs({ action: 'bulk_update', refs: [ids[2], ids[0], ids[1]].map(ref), patch: { reorder: true } })
    expect(envelope.data.order).toEqual([ids[2], ids[0], ids[1]].map(ref))
    const listed = await specs({ action: 'list', view: 'detail', options: { sort: 'id' } })
    expect(listed.envelope.data.items.map((i: { order: number }) => i.order)).toEqual([2, 3, 1])
    const dry = await specs({ action: 'bulk_update', refs: ids.map(ref), patch: { status: 'done' }, dryRun: true })
    expect(dry.envelope.data).toMatchObject({ wouldExecute: false, preview: { effect: expect.stringMatching(/3 specs/) } })
    expect(dry.envelope.data.confirmToken).toBeUndefined()
    const mixed = await specs({ action: 'bulk_update', refs: ids.map(ref), patch: { trash: true, status: 'done' } })
    expect(mixed.envelope.error.code).toBe('invalid_input')
    const perSpec = await specs({ action: 'bulk_update', refs: ids.map(ref), patch: { title: 'x' } })
    expect(perSpec.envelope.error.code).toBe('invalid_input')
  })
})

describe('specrails_specs trash, purge, addenda, attachments', () => {
  it('delete → restore round trip, purge is always confirmed and stale-checked', async () => {
    const [id, other] = await seed(2)
    const deleted = await specs({ action: 'delete', ref: ref(id) })
    expect(deleted.envelope.data.undo).toEqual({ tool: 'specrails_specs', args: { action: 'restore', ref: ref(id) } })
    expect((await specs({ action: 'restore', ref: ref(id) })).envelope.ok).toBe(true)
    await specs({ action: 'bulk_update', refs: [ref(id), ref(other)], patch: { trash: true } })
    const notTrashed = await specs({ action: 'purge', refs: [ref(id), ref(777)] })
    expect(notTrashed.envelope.error.code).toBe('not_found')
    const ask = await specs({ action: 'purge', refs: [ref(id), ref(other)] })
    expect(ask.envelope.error.code).toBe('confirmation_required')
    expect(ask.envelope.error.preview).toMatchObject({ class: 'irreversible', reversible: false })
    // Restoring and trashing again changes deletedAt: the token no longer matches.
    await specs({ action: 'restore', ref: ref(id) })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await specs({ action: 'delete', ref: ref(id) })
    const stale = await specs({ action: 'purge', refs: [ref(id), ref(other)], confirm: ask.envelope.error.confirmToken })
    expect(stale.envelope.error.code).toBe('stale')
    const done = await specs({ action: 'purge', refs: [ref(id), ref(other)], confirm: stale.envelope.error.confirmToken })
    expect(done.envelope.data.purged).toEqual([ref(id), ref(other)])
    expect((await specs({ action: 'trash' })).envelope.data.items).toHaveLength(0)
  })

  it('runs the addendum lifecycle', async () => {
    const [id] = await seed(1)
    const added = await specs({ action: 'addendum_add', ref: ref(id), body: 'Support EUR', title: 'Currency', options: { kind: 'constraint' } })
    expect(added.envelope.data).toMatchObject({ kind: 'constraint', status: 'open', title: 'Currency' })
    const aref = added.envelope.data.ref
    expect((await specs({ action: 'addendum_update', ref: aref, body: 'Support EUR and GBP' })).envelope.data.body).toBe('Support EUR and GBP')
    expect((await specs({ action: 'addendum_dismiss', ref: aref })).envelope.data.status).toBe('dismissed')
    expect((await specs({ action: 'addendum_reopen', ref: aref })).envelope.data.status).toBe('open')
    const ask = await specs({ action: 'addendum_delete', ref: aref })
    expect(ask.envelope.error.code).toBe('confirmation_required')
    const done = await specs({ action: 'addendum_delete', ref: aref, confirm: ask.envelope.error.confirmToken })
    expect(done.envelope.data.deleted).toBe(true)
  })

  it('attaches a local file and detaches it with confirmation', async () => {
    const [id] = await seed(1)
    const file = path.join(tmpDir, 'notes.txt')
    fs.writeFileSync(file, 'Notes')
    const attached = await specs({ action: 'attach', ref: ref(id), options: { file } })
    expect(attached.envelope.ok).toBe(true)
    expect(attached.envelope.data).toMatchObject({ name: 'notes.txt' })
    const detail = await specs({ action: 'get', ref: ref(id), fields: ['attachments'] })
    expect(detail.envelope.data.attachments[0].ref).toBe(attached.envelope.data.ref)
    const inline = await specs({ action: 'attach', ref: ref(id), options: { file: 'b.txt', base64: Buffer.from('hi').toString('base64') } })
    expect(inline.envelope.ok).toBe(true)
    const ask = await specs({ action: 'detach', ref: attached.envelope.data.ref })
    expect(ask.envelope.error.code).toBe('confirmation_required')
    const done = await specs({ action: 'detach', ref: attached.envelope.data.ref, confirm: ask.envelope.error.confirmToken })
    expect(done.envelope.data.deleted).toBe(true)
    expect((await specs({ action: 'attach', ref: ref(id) })).envelope.error.code).toBe('invalid_input')
  })
})

describe('spec domain projections', () => {
  const row = { id: 'p1', slug: 'shop-api', name: 'Shop API' } as never
  const ticket = (fields: Record<string, unknown>) => ({ id: 7, title: 't', description: '', status: 'todo', priority: 'medium', labels: [], parent_epic_id: null, is_epic: false, updated_at: 'u1', metadata: {}, ...fields })
  const offers = (fields: Record<string, unknown>, facts = {}) => projectSpecState(row, ticket(fields), facts).offers.map((o) => o.id)

  it('offers what each status allows, validated against the catalog', () => {
    expect(offers({ status: 'draft', priority: null })).toEqual(['promote', 'refine'])
    expect(projectSpecState(row, ticket({ status: 'draft', priority: null })).offers[0].call.args).toMatchObject({ patch: { status: 'todo', priority: 'medium' } })
    expect(offers({ status: 'todo' })).toEqual(['launch', 'triage', 'refine'])
    expect(offers({ status: 'todo', description: '## Contract Layer\nx', metadata: { triage: { status: 'ready' } } })).toEqual(['launch', 'smash'])
    expect(offers({ status: 'todo', description: '## Contract Layer', is_epic: true }, { children: 2 })).not.toContain('smash')
    expect(offers({ status: 'in_progress' })).toEqual(['runs'])
    expect(offers({ status: 'on_review' })).toEqual(['review'])
    expect(offers({ status: 'done' })).toEqual(['iterate', 'reopen'])
    expect(offers({ status: 'cancelled' })).toEqual(['reopen'])
    for (const status of ['draft', 'todo', 'in_progress', 'on_review', 'done', 'cancelled']) {
      const input = projectSpecState(row, ticket({ status, description: '## Contract Layer' }))
      for (const offer of input.offers) expect(v2Catalog().policyFor(offer.call.tool, String(offer.call.args.action), offer.call.args), `${status}:${offer.id}`).not.toBeNull()
    }
  })

  it('changes the version with the spec', () => {
    const a = projectSpecState(row, ticket({}))
    const b = projectSpecState(row, ticket({ updated_at: 'u2' }))
    expect(JSON.stringify(a.versionFacts)).not.toBe(JSON.stringify(b.versionFacts))
  })

  it('parses criteria and the Contract Layer', () => {
    expect(criteriaOf('x\n## Acceptance Criteria\n- [ ] a\n* b\n1. c\n## Next\n- d')).toEqual(['a', 'b', 'c'])
    expect(bodyOf('Body\n\n## Contract Layer\nstuff')).toEqual({ body: 'Body', contractLayer: true })
  })

  it('forecasts from at least three provider-reported costs', () => {
    const insert = projectDb.prepare(`INSERT INTO ai_invocations (id, project_id, provider, surface, status, started_at, total_cost_usd, total_cost_usd_estimated) VALUES (?, 'p1', 'claude', 'smash', 'success', ?, ?, 0)`)
    const ctx = { registry: { getContext: () => ({ db: projectDb }) } } as never
    insert.run('a', '2026-01-01', 0.1)
    insert.run('b', '2026-01-02', 0.2)
    expect(forecastFor(ctx, row, ['smash'])).toBeNull()
    insert.run('c', '2026-01-03', 0.4)
    expect(forecastFor(ctx, row, ['smash'])).toEqual([0.1, 0.4])
  })
})
