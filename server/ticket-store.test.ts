import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

import { createProjectRouter } from './project-router'
import { readStore, mutateStore, withLock } from './ticket-store'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { DbInstance } from './db'
import { vi } from 'vitest'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeQueueManager() {
  return {
    enqueue: vi.fn(() => ({ id: 'job-1', queuePosition: 0 })),
    cancel: vi.fn(() => 'canceled'),
    pause: vi.fn(),
    resume: vi.fn(),
    reorder: vi.fn(),
    getJobs: vi.fn(() => []),
    isPaused: vi.fn(() => false),
    getActiveJobId: vi.fn(() => null),
    phasesForCommand: vi.fn(() => []),
  }
}

function makeSetupManager() {
  return {
    isInstalling: vi.fn(() => false),
    isSettingUp: vi.fn(() => false),
    startInstall: vi.fn(),
    startSetup: vi.fn(),
    resumeSetup: vi.fn(),
    abort: vi.fn(),
    getCheckpointStatus: vi.fn(() => []),
    getInstallLog: vi.fn(() => []),
  }
}

function makeChatManager() {
  return {
    isActive: vi.fn(() => false),
    sendMessage: vi.fn(async () => {}),
    abort: vi.fn(),
  }
}

function makeProposalManager() {
  return {
    isActive: vi.fn(() => false),
    startExploration: vi.fn(async () => {}),
    sendRefinement: vi.fn(async () => {}),
    createIssue: vi.fn(async () => {}),
    cancel: vi.fn(),
  }
}

function makeSpecLauncherManager() {
  return {
    isActive: vi.fn(() => false),
    launch: vi.fn(async () => {}),
    cancel: vi.fn(),
  }
}

function makeContext(db: DbInstance, projectPath: string): ProjectContext {
  return {
    project: { id: 'proj-1', slug: 'proj', name: 'Test Project', path: projectPath, db_path: ':memory:', added_at: '', last_seen_at: '' },
    db,
    queueManager: makeQueueManager() as any,
    chatManager: makeChatManager() as any,
    setupManager: makeSetupManager() as any,
    proposalManager: makeProposalManager() as any,
    specLauncherManager: makeSpecLauncherManager() as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast: vi.fn(),
  } as any
}

function makeRegistry(contexts: Map<string, ProjectContext>): ProjectRegistry {
  const desktopDb = initDesktopDb(':memory:')
  return {
    desktopDb,
    getContext: vi.fn((id: string) => contexts.get(id)),
    getContextByPath: vi.fn(() => undefined),
    addProject: vi.fn() as any,
    removeProject: vi.fn(),
    touchProject: vi.fn(),
    listContexts: vi.fn(() => Array.from(contexts.values())),
  } as unknown as ProjectRegistry
}

function createApp(contexts: Map<string, ProjectContext> = new Map()) {
  const registry = makeRegistry(contexts)
  const router = createProjectRouter(registry)
  const app = express()
  app.use(express.json())
  app.use('/api/projects', router)
  return { app, registry }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ticket endpoints', () => {
  let db: DbInstance
  let tmpDir: string

  beforeEach(() => {
    db = initDb(':memory:')
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-desktop-ticket-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ─── GET /tickets ──────────────────────────────────────────────────────────

  describe('GET /:projectId/tickets', () => {
    it('returns empty list when no tickets file exists', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/tickets')
      expect(res.status).toBe(200)
      expect(res.body.tickets).toEqual([])
      expect(res.body.total).toBe(0)
      expect(res.body.revision).toBe(0)
    })

    it('returns tickets from existing file', async () => {
      const storeDir = path.join(tmpDir, '.specrails')
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(path.join(storeDir, 'local-tickets.json'), JSON.stringify({
        schema_version: '1.0',
        revision: 3,
        last_updated: '2026-01-01T00:00:00Z',
        next_id: 3,
        tickets: {
          '1': { id: 1, title: 'First', description: '', status: 'todo', priority: 'medium', labels: [], assignee: null, prerequisites: [], metadata: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'user', source: 'manual' },
          '2': { id: 2, title: 'Second', description: 'desc', status: 'in_progress', priority: 'high', labels: ['area:backend'], assignee: null, prerequisites: [], metadata: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', created_by: 'user', source: 'manual' },
        },
      }))

      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/tickets')
      expect(res.status).toBe(200)
      expect(res.body.tickets).toHaveLength(2)
      expect(res.body.total).toBe(2)
      expect(res.body.revision).toBe(3)
    })

    it('filters by status', async () => {
      const storeDir = path.join(tmpDir, '.specrails')
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(path.join(storeDir, 'local-tickets.json'), JSON.stringify({
        schema_version: '1.0', revision: 1, last_updated: '', next_id: 3,
        tickets: {
          '1': { id: 1, title: 'Todo', description: '', status: 'todo', priority: 'medium', labels: [], assignee: null, prerequisites: [], metadata: {}, created_at: '', updated_at: '', created_by: 'user', source: 'manual' },
          '2': { id: 2, title: 'Done', description: '', status: 'done', priority: 'medium', labels: [], assignee: null, prerequisites: [], metadata: {}, created_at: '', updated_at: '', created_by: 'user', source: 'manual' },
        },
      }))

      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/tickets?status=todo')
      expect(res.status).toBe(200)
      expect(res.body.tickets).toHaveLength(1)
      expect(res.body.tickets[0].title).toBe('Todo')
    })

    it('filters by label', async () => {
      const storeDir = path.join(tmpDir, '.specrails')
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(path.join(storeDir, 'local-tickets.json'), JSON.stringify({
        schema_version: '1.0', revision: 1, last_updated: '', next_id: 3,
        tickets: {
          '1': { id: 1, title: 'Frontend', description: '', status: 'todo', priority: 'medium', labels: ['area:frontend'], assignee: null, prerequisites: [], metadata: {}, created_at: '', updated_at: '', created_by: 'user', source: 'manual' },
          '2': { id: 2, title: 'Backend', description: '', status: 'todo', priority: 'medium', labels: ['area:backend'], assignee: null, prerequisites: [], metadata: {}, created_at: '', updated_at: '', created_by: 'user', source: 'manual' },
        },
      }))

      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/tickets?label=area:frontend')
      expect(res.status).toBe(200)
      expect(res.body.tickets).toHaveLength(1)
      expect(res.body.tickets[0].title).toBe('Frontend')
    })

    it('filters by search query', async () => {
      const storeDir = path.join(tmpDir, '.specrails')
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(path.join(storeDir, 'local-tickets.json'), JSON.stringify({
        schema_version: '1.0', revision: 1, last_updated: '', next_id: 3,
        tickets: {
          '1': { id: 1, title: 'Fix login bug', description: '', status: 'todo', priority: 'medium', labels: [], assignee: null, prerequisites: [], metadata: {}, created_at: '', updated_at: '', created_by: 'user', source: 'manual' },
          '2': { id: 2, title: 'Add feature', description: 'login related', status: 'todo', priority: 'medium', labels: [], assignee: null, prerequisites: [], metadata: {}, created_at: '', updated_at: '', created_by: 'user', source: 'manual' },
        },
      }))

      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/tickets?q=login')
      expect(res.status).toBe(200)
      expect(res.body.tickets).toHaveLength(2)
    })
  })

  // ─── GET /tickets/:id ──────────────────────────────────────────────────────

  describe('GET /:projectId/tickets/:id', () => {
    it('returns 400 for non-numeric id', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/tickets/abc')
      expect(res.status).toBe(400)
    })

    it('returns 404 for missing ticket', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/tickets/999')
      expect(res.status).toBe(404)
    })

    it('returns ticket by id', async () => {
      const storeDir = path.join(tmpDir, '.specrails')
      fs.mkdirSync(storeDir, { recursive: true })
      fs.writeFileSync(path.join(storeDir, 'local-tickets.json'), JSON.stringify({
        schema_version: '1.0', revision: 1, last_updated: '', next_id: 2,
        tickets: {
          '1': { id: 1, title: 'Test', description: 'desc', status: 'todo', priority: 'high', labels: ['bug'], assignee: null, prerequisites: [], metadata: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'user', source: 'manual' },
        },
      }))

      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/tickets/1')
      expect(res.status).toBe(200)
      expect(res.body.ticket.id).toBe(1)
      expect(res.body.ticket.title).toBe('Test')
      expect(res.body.ticket.priority).toBe('high')
    })
  })

  // ─── POST /tickets ─────────────────────────────────────────────────────────

  describe('POST /:projectId/tickets', () => {
    it('returns 400 when title is missing', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).post('/api/projects/proj-1/tickets').send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('title')
    })

    it('returns 400 for invalid status', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Test', status: 'invalid' })
      expect(res.status).toBe(400)
    })

    it('returns 400 for invalid priority', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Test', priority: 'extreme' })
      expect(res.status).toBe(400)
    })

    it('creates ticket with defaults', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'New ticket' })
      expect(res.status).toBe(201)
      expect(res.body.ticket.id).toBe(1)
      expect(res.body.ticket.title).toBe('New ticket')
      expect(res.body.ticket.status).toBe('todo')
      expect(res.body.ticket.priority).toBe('medium')
      expect(res.body.ticket.source).toBe('hub') // legacy on-disk wire value
      expect(res.body.revision).toBe(1)
    })

    it('creates ticket with all fields', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).post('/api/projects/proj-1/tickets').send({
        title: 'Full ticket',
        description: 'A detailed description',
        status: 'in_progress',
        priority: 'critical',
        labels: ['bug', 'area:frontend'],
        assignee: 'alice',
        prerequisites: [1, 2],
        metadata: { effort_level: 'Large' },
        source: 'product-backlog',
      })
      expect(res.status).toBe(201)
      expect(res.body.ticket.description).toBe('A detailed description')
      expect(res.body.ticket.status).toBe('in_progress')
      expect(res.body.ticket.priority).toBe('critical')
      expect(res.body.ticket.labels).toEqual(['bug', 'area:frontend'])
      expect(res.body.ticket.assignee).toBe('alice')
      expect(res.body.ticket.source).toBe('product-backlog')
    })

    it('increments next_id across creates', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      await request(app).post('/api/projects/proj-1/tickets').send({ title: 'First' })
      const res = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Second' })
      expect(res.body.ticket.id).toBe(2)
      expect(res.body.revision).toBe(2)
    })

    it('broadcasts ticket_created', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Broadcasted' })
      expect(ctx.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ticket_created', ticket: expect.objectContaining({ title: 'Broadcasted' }), timestamp: expect.any(String) })
      )
    })
  })

  // ─── PATCH /tickets/:id ────────────────────────────────────────────────────

  describe('PATCH /:projectId/tickets/:id', () => {
    it('returns 400 for non-numeric id', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).patch('/api/projects/proj-1/tickets/abc').send({ title: 'x' })
      expect(res.status).toBe(400)
    })

    it('returns 404 for missing ticket', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).patch('/api/projects/proj-1/tickets/999').send({ title: 'x' })
      expect(res.status).toBe(404)
    })

    it('returns 400 for invalid status', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).patch('/api/projects/proj-1/tickets/1').send({ status: 'bad' })
      expect(res.status).toBe(400)
    })

    it('returns 400 for empty title', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).patch('/api/projects/proj-1/tickets/1').send({ title: '' })
      expect(res.status).toBe(400)
    })

    it('updates ticket fields', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      // Create first
      await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Original' })

      // Update
      const res = await request(app).patch('/api/projects/proj-1/tickets/1').send({
        title: 'Updated',
        status: 'in_progress',
        priority: 'high',
        labels: ['area:backend'],
      })
      expect(res.status).toBe(200)
      expect(res.body.ticket.title).toBe('Updated')
      expect(res.body.ticket.status).toBe('in_progress')
      expect(res.body.ticket.priority).toBe('high')
      expect(res.body.ticket.labels).toEqual(['area:backend'])
    })

    it('merges metadata instead of replacing', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      await request(app).post('/api/projects/proj-1/tickets').send({
        title: 'Meta test',
        metadata: { effort_level: 'Small', area: 'backend' },
      })

      const res = await request(app).patch('/api/projects/proj-1/tickets/1').send({
        metadata: { effort_level: 'Large' },
      })
      expect(res.body.ticket.metadata.effort_level).toBe('Large')
      expect(res.body.ticket.metadata.area).toBe('backend')
    })

    it('broadcasts ticket_updated', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Track' })
      await request(app).patch('/api/projects/proj-1/tickets/1').send({ status: 'done' })

      expect(ctx.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ticket_updated', ticket: expect.objectContaining({ status: 'done' }), timestamp: expect.any(String) })
      )
    })
  })

  // ─── DELETE /tickets/:id ───────────────────────────────────────────────────

  describe('DELETE /:projectId/tickets/:id', () => {
    it('returns 400 for non-numeric id', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).delete('/api/projects/proj-1/tickets/abc')
      expect(res.status).toBe(400)
    })

    it('returns 404 for missing ticket', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).delete('/api/projects/proj-1/tickets/999')
      expect(res.status).toBe(404)
    })

    it('deletes existing ticket', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      // Create then delete
      await request(app).post('/api/projects/proj-1/tickets').send({ title: 'To delete' })
      const res = await request(app).delete('/api/projects/proj-1/tickets/1')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)

      // Verify it's gone
      const getRes = await request(app).get('/api/projects/proj-1/tickets/1')
      expect(getRes.status).toBe(404)
    })

    it('broadcasts ticket_deleted', async () => {
      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      await request(app).post('/api/projects/proj-1/tickets').send({ title: 'To delete' })
      await request(app).delete('/api/projects/proj-1/tickets/1')

      expect(ctx.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ticket_deleted', ticketId: 1, timestamp: expect.any(String) })
      )
    })
  })

  // ─── Integration contract path resolution ─────────────────────────────────

  describe('integration contract path resolution', () => {
    it('uses storagePath from integration-contract.json when available', async () => {
      const claudeDir = path.join(tmpDir, '.claude')
      fs.mkdirSync(claudeDir, { recursive: true })

      // Write contract with custom storage path
      fs.writeFileSync(path.join(claudeDir, 'integration-contract.json'), JSON.stringify({
        schemaVersion: '1.0',
        ticketProvider: {
          type: 'local',
          storagePath: '.claude/local-tickets.json',
          capabilities: ['crud'],
        },
      }))

      // Pre-populate tickets at the custom path
      fs.writeFileSync(path.join(claudeDir, 'local-tickets.json'), JSON.stringify({
        schema_version: '1.0', revision: 5, last_updated: '', next_id: 2,
        tickets: {
          '1': { id: 1, title: 'From contract path', description: '', status: 'todo', priority: 'medium', labels: [], assignee: null, prerequisites: [], metadata: {}, created_at: '', updated_at: '', created_by: 'user', source: 'manual' },
        },
      }))

      const ctx = makeContext(db, tmpDir)
      const { app } = createApp(new Map([['proj-1', ctx]]))

      const res = await request(app).get('/api/projects/proj-1/tickets')
      expect(res.status).toBe(200)
      expect(res.body.tickets).toHaveLength(1)
      expect(res.body.tickets[0].title).toBe('From contract path')
    })
  })

  describe('readStore per-entry resilience', () => {
    it('drops a single corrupt ticket entry instead of discarding the whole store', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-store-corrupt-'))
      const filePath = path.join(dir, 'local-tickets.json')
      // Two valid tickets plus a null and a scalar value — pre-fix the `in`
      // operator in normalizeTicket threw on these and the catch nuked
      // everything, returning emptyStore().
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          schema_version: '1.1',
          revision: 3,
          last_updated: new Date().toISOString(),
          next_id: 10,
          tickets: {
            '1': { id: 1, title: 'Valid one', status: 'todo', priority: 'high' },
            '2': null,
            '3': 42,
            '4': { id: 4, title: 'Valid two', status: 'todo', priority: 'low' },
          },
        }),
        'utf-8',
      )
      const store = readStore(filePath)
      const ids = Object.keys(store.tickets).sort()
      expect(ids).toEqual(['1', '4'])
      expect(store.tickets['1'].title).toBe('Valid one')
      expect(store.tickets['4'].title).toBe('Valid two')
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  // BUG-SQLITE-03: a present-but-unreadable store must THROW (preserving the
  // on-disk bytes) instead of returning emptyStore() — otherwise the next
  // mutateStore writes an empty store over real data.
  describe('readStore present-but-unreadable handling (BUG-SQLITE-03)', () => {
    let dir: string
    let filePath: string

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-store-sqlite03-'))
      filePath = path.join(dir, 'local-tickets.json')
    })
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('returns an empty store only when the file is genuinely absent (ENOENT)', () => {
      const store = readStore(filePath)
      expect(store.tickets).toEqual({})
      expect(store.next_id).toBe(1)
    })

    it('throws on a present-but-unparseable JSON file', () => {
      fs.writeFileSync(filePath, '{ this is not: valid json', 'utf-8')
      expect(() => readStore(filePath)).toThrow(/invalid JSON/i)
    })

    it('throws on a present file with a foreign top-level shape (no tickets / no revision)', () => {
      fs.writeFileSync(filePath, JSON.stringify({ some: 'other', tool: true }), 'utf-8')
      expect(() => readStore(filePath)).toThrow(/unexpected top-level shape/i)
    })

    it('throws on a present file that is a JSON array (foreign shape)', () => {
      fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf-8')
      expect(() => readStore(filePath)).toThrow(/unexpected top-level shape/i)
    })

    it('mutateStore aborts and PRESERVES the on-disk bytes when the file is corrupt', () => {
      const corrupt = '{ partial truncated write '
      fs.writeFileSync(filePath, corrupt, 'utf-8')
      expect(() =>
        mutateStore(filePath, (store) => {
          // Would have wiped everything pre-fix; the throw must prevent the write.
          store.tickets = {}
          store.next_id = 1
        }),
      ).toThrow()
      // The corrupt file must be untouched — never blanked into an empty store.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(corrupt)
      // And the advisory lock must have been released despite the throw.
      expect(fs.existsSync(filePath + '.lock')).toBe(false)
    })

    it('still reads a present, valid store normally', () => {
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          schema_version: '1.3',
          revision: 7,
          last_updated: new Date().toISOString(),
          next_id: 3,
          tickets: {
            '1': { id: 1, title: 'Real', status: 'todo', priority: 'high' },
          },
        }),
        'utf-8',
      )
      const store = readStore(filePath)
      expect(store.revision).toBe(7)
      expect(store.tickets['1'].title).toBe('Real')
    })
  })

  // BUG-SQLITE-02: a lock held by a DEAD pid must be reclaimable immediately
  // (ESRCH), not only after the mtime TTL ages out.
  describe('acquireLock owner-PID liveness (BUG-SQLITE-02)', () => {
    let dir: string
    let filePath: string

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-store-sqlite02-'))
      filePath = path.join(dir, 'local-tickets.json')
    })
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    function findDeadPid(): number {
      // Find a pid that does not exist on this host (process.kill(pid,0) ESRCH).
      for (let candidate = 999_999; candidate > 900_000; candidate--) {
        try {
          process.kill(candidate, 0)
        } catch (err: any) {
          if (err && err.code === 'ESRCH') return candidate
        }
      }
      throw new Error('could not find a dead pid for the test')
    }

    it('reclaims a lock whose owner pid is dead, even with a FRESH mtime', () => {
      const lockPath = filePath + '.lock'
      const deadPid = findDeadPid()
      // Stale-by-owner but NOT stale-by-mtime: write a dead pid with a just-now
      // mtime so the only path that lets the write proceed is the PID check.
      fs.writeFileSync(lockPath, String(deadPid), 'utf-8')
      const now = new Date()
      fs.utimesSync(lockPath, now, now)
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(1000)

      // withLock must acquire (reclaiming the dead lock) and complete quickly.
      const started = Date.now()
      const result = withLock(filePath, () => 'acquired')
      expect(result).toBe('acquired')
      // Far below the 10s mtime TTL — proves the PID path, not the TTL, freed it.
      expect(Date.now() - started).toBeLessThan(2000)
      // Lock released after the critical section.
      expect(fs.existsSync(lockPath)).toBe(false)
    })

    it('does NOT reclaim a fresh lock owned by a LIVE pid (our own process)', () => {
      const lockPath = filePath + '.lock'
      // Our own pid is alive; a fresh mtime means neither path should free it,
      // so acquireLock exhausts its retry budget and throws.
      fs.writeFileSync(lockPath, String(process.pid), 'utf-8')
      const now = new Date()
      fs.utimesSync(lockPath, now, now)
      expect(() => withLock(filePath, () => 'should-not-run')).toThrow(/Could not acquire lock/)
      // The live lock must survive the failed attempt.
      expect(fs.existsSync(lockPath)).toBe(true)
    })

    it('falls back to mtime TTL when the lock content is a malformed/foreign pid', () => {
      const lockPath = filePath + '.lock'
      // Non-numeric content => PID check cannot prove death; reclaim only via
      // the aged mtime TTL fallback.
      fs.writeFileSync(lockPath, 'not-a-pid', 'utf-8')
      const old = new Date(Date.now() - 60_000) // 60s ago, well past the 10s TTL
      fs.utimesSync(lockPath, old, old)
      const result = withLock(filePath, () => 'acquired-via-ttl')
      expect(result).toBe('acquired-via-ttl')
      expect(fs.existsSync(lockPath)).toBe(false)
    })
  })
})
