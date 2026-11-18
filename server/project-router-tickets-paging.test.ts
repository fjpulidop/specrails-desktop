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
import type { DbInstance } from './db'

function makeContext(db: DbInstance, projectPath: string): ProjectContext {
  return {
    project: { id: 'proj-1', slug: 'proj', name: 'Test', path: projectPath, db_path: ':memory:', added_at: '', last_seen_at: '' },
    db,
    queueManager: { enqueue: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), reorder: vi.fn(), getJobs: vi.fn(() => []), isPaused: vi.fn(() => false), getActiveJobId: vi.fn(() => null), phasesForCommand: vi.fn(() => []) } as any,
    chatManager: { isActive: vi.fn(() => false), sendMessage: vi.fn(), abort: vi.fn(), forgetSpecDraft: vi.fn(), forgetExploreLifecycle: vi.fn() } as any,
    setupManager: {} as any,
    proposalManager: {} as any,
    specLauncherManager: {} as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast: vi.fn(),
  }
}

function makeRegistry(ctx: ProjectContext): ProjectRegistry {
  const desktopDb = initDesktopDb(':memory:')
  const map = new Map([[ctx.project.id, ctx]])
  return {
    desktopDb,
    getContext: vi.fn((id: string) => map.get(id)),
    getContextByPath: vi.fn(() => undefined),
    addProject: vi.fn() as any,
    removeProject: vi.fn(),
    touchProject: vi.fn(),
    listContexts: vi.fn(() => Array.from(map.values())),
  } as unknown as ProjectRegistry
}

function createApp(ctx: ProjectContext) {
  const registry = makeRegistry(ctx)
  const router = createProjectRouter(registry)
  const app = express()
  app.use(express.json())
  app.use('/api/projects', router)
  return app
}

import { encodePageCursor } from './util/page-cursor'

// GET /tickets keeps its full default response; limit/cursor and groupBy=status
// are opt-in (used by the MCP specs list, context backlog and board).
describe('GET /tickets optional paging and board grouping', () => {
  let tmpDir: string
  let app: express.Express

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-paging-'))
    app = createApp(makeContext(initDb(':memory:'), tmpDir))
    const statuses = ['todo', 'todo', 'in_progress', 'done', 'todo']
    for (const [index, status] of statuses.entries()) {
      const created = await request(app).post('/api/projects/proj-1/tickets').send({ title: `T${index}`, status, priority: 'medium' })
      expect(created.status).toBe(201)
    }
  })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it('returns every ticket and no paging fields by default', async () => {
    const res = await request(app).get('/api/projects/proj-1/tickets')
    expect(res.status).toBe(200)
    expect(res.body.tickets).toHaveLength(5)
    expect(Object.keys(res.body).sort()).toEqual(['revision', 'tickets', 'total'])
  })

  it('pages with limit and an opaque cursor, with status counts of the whole match', async () => {
    const first = await request(app).get('/api/projects/proj-1/tickets?limit=2')
    expect(first.body).toMatchObject({ total: 5, matched: 5, offset: 0, limit: 2, nextOffset: 2, statusCounts: { todo: 3, in_progress: 1, done: 1 } })
    expect(first.body.tickets).toHaveLength(2)
    const seen = new Set(first.body.tickets.map((ticket: { id: number }) => ticket.id))
    let cursor = first.body.nextCursor as string | null
    while (cursor) {
      const page = await request(app).get(`/api/projects/proj-1/tickets?limit=2&cursor=${cursor}`)
      for (const ticket of page.body.tickets) seen.add(ticket.id)
      cursor = page.body.nextCursor
    }
    expect(seen.size).toBe(5)
    const filtered = await request(app).get('/api/projects/proj-1/tickets?status=todo&limit=10')
    expect(filtered.body).toMatchObject({ matched: 3, nextCursor: null, statusCounts: { todo: 3 } })
    const counts = await request(app).get('/api/projects/proj-1/tickets?limit=0')
    expect(counts.body.tickets).toEqual([])
    expect(counts.body.statusCounts).toEqual({ todo: 3, in_progress: 1, done: 1 })
  })

  it('flags a cursor from an older revision and rejects a malformed one', async () => {
    const stale = await request(app).get(`/api/projects/proj-1/tickets?limit=2&cursor=${encodePageCursor(2, -1)}`)
    expect(stale.body).toMatchObject({ offset: 2, cursorStale: true })
    const bad = await request(app).get('/api/projects/proj-1/tickets?limit=2&cursor=%%%')
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_cursor')
  })

  it('groups by status with a bounded number of newest items per column', async () => {
    const res = await request(app).get('/api/projects/proj-1/tickets?groupBy=status&perGroup=2')
    const todo = res.body.groups.find((group: { status: string }) => group.status === 'todo')
    expect(todo.count).toBe(3)
    expect(todo.tickets).toHaveLength(2)
    expect(res.body).toMatchObject({ total: 5, matched: 5, perGroup: 2 })
    const countsOnly = await request(app).get('/api/projects/proj-1/tickets?groupBy=status&perGroup=0')
    expect(countsOnly.body.groups.every((group: { tickets: unknown[] }) => group.tickets.length === 0)).toBe(true)
  })
})
