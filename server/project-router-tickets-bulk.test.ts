import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { createProjectRouter } from './project-router'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import { mergedDescription, parseBulkPatch, patchedLabels } from './project-router-tickets-bulk'

// POST /tickets/bulk: one operation over a selection, same validators and
// events as the single-item routes (MCP v2 specrails_specs bulk_update/purge).

let tmpDir: string
let app: express.Express
let broadcast: ReturnType<typeof vi.fn>
let onSpecEdited: ReturnType<typeof vi.fn>

function createApp(): express.Express {
  broadcast = vi.fn()
  onSpecEdited = vi.fn()
  const ctx = {
    project: { id: 'proj-1', slug: 'proj', name: 'Test', path: tmpDir, db_path: ':memory:', added_at: '', last_seen_at: '' },
    db: initDb(':memory:'),
    queueManager: { getJobs: vi.fn(() => []) } as any,
    chatManager: { forgetSpecDraft: vi.fn(), forgetExploreLifecycle: vi.fn() } as any,
    setupManager: {} as any,
    proposalManager: {} as any,
    specLauncherManager: {} as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    jiraSyncManager: { onSpecEdited } as any,
    broadcast,
  } as unknown as ProjectContext
  const registry = {
    desktopDb: initDesktopDb(':memory:'),
    getContext: vi.fn(() => ctx),
    getContextByPath: vi.fn(() => undefined),
    touchProject: vi.fn(),
    listContexts: vi.fn(() => [ctx]),
  } as unknown as ProjectRegistry
  const server = express()
  server.use(express.json())
  server.use('/api/projects', createProjectRouter(registry))
  return server
}

const bulk = (body: Record<string, unknown>) => request(app).post('/api/projects/proj-1/tickets/bulk').send(body)
async function seed(specs: Array<Record<string, unknown>>): Promise<number[]> {
  const ids: number[] = []
  for (const spec of specs) {
    const res = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'T', status: 'todo', priority: 'medium', ...spec })
    ids.push(res.body.ticket.id)
  }
  return ids
}
const ticket = async (id: number) => (await request(app).get(`/api/projects/proj-1/tickets/${id}`)).body.ticket

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-bulk-'))
  app = createApp()
})
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

describe('POST /tickets/bulk', () => {
  it('rejects bad input with a typed error', async () => {
    expect((await bulk({ op: 'explode', ids: [1] })).body.error).toBe('invalid_op')
    expect((await bulk({ op: 'update', ids: [], patch: { status: 'done' } })).body.error).toBe('invalid_ids')
    expect((await bulk({ op: 'update', ids: [1], patch: { title: 'x' } })).body.error).toBe('invalid_patch')
    expect((await bulk({ op: 'update', ids: [1], patch: { status: 'bogus' } })).body.error).toBe('invalid_patch')
    expect((await bulk({ op: 'trash', ids: Array.from({ length: 201 }, (_, i) => i + 1) })).body.error).toBe('too_many')
  })

  it('updates a selection in one write, skipping what it cannot change, and queues the Jira write-back', async () => {
    const ids = await seed([{ labels: ['M1', 'ui'] }, { status: 'draft', priority: null }, { priority: 'high' }])
    const res = await bulk({ op: 'update', ids: [...ids, 99], patch: { priority: 'high', milestone: 2, addLabels: ['q4'] } })
    expect(res.status).toBe(200)
    expect(res.body.changed).toEqual(ids)
    expect(res.body.skipped).toEqual([{ id: 99, reason: 'not_found' }])
    expect((await ticket(ids[0])).labels).toEqual(['ui', 'M2', 'q4'])
    expect(res.body.previous[String(ids[0])]).toEqual({ priority: 'medium', labels: ['M1', 'ui'] })
    expect(broadcast.mock.calls.filter(([msg]) => msg.type === 'ticket_updated')).toHaveLength(3)
    expect(onSpecEdited).toHaveBeenCalledWith(ids[0], { priority: 'high', labels: ['ui', 'M2', 'q4'] }, {})
    expect(onSpecEdited).toHaveBeenCalledWith(ids[2], { labels: ['M2', 'q4'] }, { holdMs: 10_000 })
  })

  it('applies the per-spec rule: leaving draft needs a priority', async () => {
    const [draft] = await seed([{ status: 'draft', priority: null }])
    const res = await bulk({ op: 'update', ids: [draft], patch: { status: 'todo' } })
    expect(res.body.changed).toEqual([])
    expect(res.body.skipped[0].reason).toMatch(/priority/)
  })

  it('refuses the whole call when a spec changed since it was read', async () => {
    const [id] = await seed([{}])
    const res = await bulk({ op: 'update', ids: [id], patch: { status: 'done' }, expected: { [id]: 'old' } })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'stale', changed: [id] })
    expect((await ticket(id)).status).toBe('todo')
  })

  it('restores earlier values per spec through items', async () => {
    const ids = await seed([{ priority: 'low' }, { priority: 'high' }])
    const res = await bulk({ op: 'update', items: [{ id: ids[0], patch: { priority: 'critical' } }, { id: ids[1], patch: { status: 'done' } }] })
    expect(res.body.changed).toEqual(ids)
    expect((await ticket(ids[1])).status).toBe('done')
  })

  it('trashes, restores and purges', async () => {
    const ids = await seed([{}, {}])
    expect((await bulk({ op: 'trash', ids })).body).toMatchObject({ changed: ids, restorable: true })
    expect((await bulk({ op: 'trash', ids })).body.skipped.map((s: { reason: string }) => s.reason)).toEqual(['already_trashed', 'already_trashed'])
    expect((await bulk({ op: 'restore', ids: [ids[0]] })).body.changed).toEqual([ids[0]])
    const purge = await bulk({ op: 'purge', ids })
    expect(purge.body.changed).toEqual([ids[1]])
    expect(purge.body.skipped).toEqual([{ id: ids[0], reason: 'not_in_trash' }])
    const trash = await request(app).get('/api/projects/proj-1/tickets/trash')
    expect(trash.body.items).toHaveLength(0)
  })

  it('merges into a target: bodies, labels, prerequisites and dependents follow', async () => {
    const [target, a, b] = await seed([{ title: 'Target', description: 'Main', labels: ['x'] }, { title: 'A', description: 'Body A', labels: ['y'] }, { title: 'B', description: 'Body B' }])
    const [dependent] = await seed([{ prerequisites: [a, target] }])
    const res = await bulk({ op: 'merge', targetId: target, ids: [a, b] })
    expect(res.status).toBe(200)
    const merged = await ticket(target)
    expect(merged.description).toBe(`Main\n\n## Merged from #${a}: A\n\nBody A\n\n## Merged from #${b}: B\n\nBody B`)
    expect(merged.labels).toEqual(['x', 'y'])
    expect((await ticket(dependent)).prerequisites).toEqual([target])
    expect((await request(app).get(`/api/projects/proj-1/tickets/${a}`)).status).toBe(404)
    expect((await bulk({ op: 'merge', targetId: target, ids: [target] })).body.error).toBe('invalid_ids')
  })

  it('refuses to merge a running spec', async () => {
    const [target, running] = await seed([{}, { status: 'in_progress' }])
    const res = await bulk({ op: 'merge', targetId: target, ids: [running] })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('spec_in_progress')
  })

  it('reorders by position', async () => {
    const ids = await seed([{}, {}, {}])
    const res = await bulk({ op: 'reorder', ids: [ids[2], ids[0], ids[1]] })
    expect(res.body.changed).toHaveLength(3)
    expect((await ticket(ids[2])).execution_order).toBe(1)
    expect((await bulk({ op: 'reorder', ids: [ids[2]] })).body.skipped).toEqual([{ id: ids[2], reason: 'unchanged' }])
  })
})

describe('bulk helpers', () => {
  it('parses and applies label patches', () => {
    expect(() => parseBulkPatch({})).toThrow(/changes nothing/)
    expect(patchedLabels(['M1', 'Api'], { milestone: null, removeLabels: ['api'], addLabels: ['new', 'NEW'] })).toEqual(['new'])
    expect(patchedLabels(['a'], { labels: ['b'], milestone: 3 })).toEqual(['b', 'M3'])
  })

  it('merges descriptions as sections', () => {
    expect(mergedDescription({ description: '' } as never, [{ id: 2, title: 'T', description: '' } as never])).toBe('## Merged from #2: T')
  })
})
