import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

vi.mock('./smash-runner', async () => {
  const actual = await vi.importActual<typeof import('./smash-runner')>('./smash-runner')
  return {
    ...actual,
    runSmash: vi.fn(async () => ({ ok: true, ticketId: 1, runId: 'test-run', childrenIds: [] })),
  }
})

import { createProjectRouter } from './project-router'
import { initDb, createConversation, type DbInstance } from './db'
import { initDesktopDb } from './desktop-db'
import { runSmash } from './smash-runner'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import {
  mutateStore,
  readStore,
  resolveTicketStoragePath,
  CURRENT_SCHEMA_VERSION,
  type Ticket,
} from './ticket-store'

function makeContext(db: DbInstance, projectPath: string): ProjectContext {
  return {
    project: {
      id: 'proj-1', slug: 'proj', name: 'Test', path: projectPath,
      db_path: ':memory:', added_at: '', last_seen_at: '',
    },
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

function seedTicket(projectPath: string, opts: {
  id: number
  description?: string
  status?: Ticket['status']
  isEpic?: boolean
  parentEpicId?: number | null
  originConversationId?: string | null
} = { id: 1 }): void {
  const filePath = resolveTicketStoragePath(projectPath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  mutateStore(filePath, (s) => {
    s.schema_version = CURRENT_SCHEMA_VERSION
    if (s.next_id <= opts.id) s.next_id = opts.id + 1
    s.tickets[String(opts.id)] = {
      id: opts.id,
      title: 'Parent spec',
      description: opts.description ?? 'Body\n\n## Contract Layer\n\nstuff',
      status: opts.status ?? 'todo',
      priority: 'medium',
      labels: [],
      assignee: null,
      prerequisites: [],
      metadata: {},
      comments: [],
      origin_conversation_id: opts.originConversationId ?? null,
      is_epic: opts.isEpic ?? false,
      parent_epic_id: opts.parentEpicId ?? null,
      execution_order: null,
      short_summary: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: 'test',
      source: 'propose-spec',
    }
  })
}

describe('SMASH endpoints', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smash-ep-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
    vi.mocked(runSmash).mockClear()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.SPECRAILS_SMASH
  })

  describe('POST /tickets/:id/smash', () => {
    it('returns 400 for non-numeric id', async () => {
      const app = createApp(ctx)
      const res = await request(app).post('/api/projects/proj-1/tickets/abc/smash')
      expect(res.status).toBe(400)
    })

    it('returns 404 when ticket is missing', async () => {
      const app = createApp(ctx)
      const res = await request(app).post('/api/projects/proj-1/tickets/999/smash')
      expect(res.status).toBe(404)
      expect(res.body.reason).toBe('ticket-not-found')
    })

    it('returns 409 when ticket has no Contract Layer', async () => {
      seedTicket(tmpDir, { id: 1, description: 'plain body' })
      const app = createApp(ctx)
      const res = await request(app).post('/api/projects/proj-1/tickets/1/smash')
      expect(res.status).toBe(409)
      expect(res.body.reason).toBe('no-contract-layer')
    })

    it('returns 409 when ticket is a draft', async () => {
      seedTicket(tmpDir, { id: 1, status: 'draft' })
      const app = createApp(ctx)
      const res = await request(app).post('/api/projects/proj-1/tickets/1/smash')
      expect(res.status).toBe(409)
      expect(res.body.reason).toBe('is-draft')
    })

    it('returns 409 when ticket is a child of an épica', async () => {
      seedTicket(tmpDir, { id: 1, isEpic: true })
      seedTicket(tmpDir, { id: 2, parentEpicId: 1 })
      const app = createApp(ctx)
      const res = await request(app).post('/api/projects/proj-1/tickets/2/smash')
      expect(res.status).toBe(409)
      expect(res.body.reason).toBe('is-child')
    })

    it('returns 409 when épica still has children (re-smash blocked)', async () => {
      seedTicket(tmpDir, { id: 1, isEpic: true })
      seedTicket(tmpDir, { id: 2, parentEpicId: 1 })
      const app = createApp(ctx)
      const res = await request(app).post('/api/projects/proj-1/tickets/1/smash')
      expect(res.status).toBe(409)
      expect(res.body.reason).toBe('has-children')
    })

    it('returns 409 disabled when kill switch is on', async () => {
      seedTicket(tmpDir, { id: 1 })
      process.env.SPECRAILS_SMASH = '0'
      const app = createApp(ctx)
      const res = await request(app).post('/api/projects/proj-1/tickets/1/smash')
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('feature_disabled_by_env')
    })

    it('returns 202 scheduled for an eligible ticket', async () => {
      seedTicket(tmpDir, { id: 1 })
      const app = createApp(ctx)
      const res = await request(app).post('/api/projects/proj-1/tickets/1/smash')
      expect(res.status).toBe(202)
      expect(res.body.scheduled).toBe(true)
    })

    it('rejects a Kimi-origin SMASH in a Claude-primary mixed project before running the SMASH worker', async () => {
      ctx.project.provider = 'claude'
      ctx.project.providers = ['claude', 'kimi']
      createConversation(db, {
        id: 'conv-kimi',
        model: 'k3',
        kind: 'explore',
        provider: 'kimi',
      })
      seedTicket(tmpDir, { id: 1, originConversationId: 'conv-kimi' })
      const app = createApp(ctx)

      const res = await request(app).post('/api/projects/proj-1/tickets/1/smash').send({})
      await new Promise((resolve) => setImmediate(resolve))

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('smash_unsupported_for_kimi')
      expect(runSmash).not.toHaveBeenCalled()
    })
  })

  describe('POST /tickets/:id/smash/undo', () => {
    it('returns 400 without smashedAt body', async () => {
      const app = createApp(ctx)
      const res = await request(app).post('/api/projects/proj-1/tickets/1/smash/undo').send({})
      expect(res.status).toBe(400)
    })

    it('returns 409 disabled when kill switch is on', async () => {
      process.env.SPECRAILS_SMASH = '0'
      const app = createApp(ctx)
      const res = await request(app)
        .post('/api/projects/proj-1/tickets/1/smash/undo')
        .send({ smashedAt: '2026-05-16T12:00:00Z' })
      expect(res.status).toBe(409)
    })

    it('returns 404/409 when ticket is not an épica', async () => {
      seedTicket(tmpDir, { id: 1 })
      const app = createApp(ctx)
      const res = await request(app)
        .post('/api/projects/proj-1/tickets/1/smash/undo')
        .send({ smashedAt: '2026-05-16T12:00:00Z' })
      expect([404, 409]).toContain(res.status)
    })
  })

  describe('DELETE /tickets/:id/children', () => {
    it('deletes all children of an épica', async () => {
      seedTicket(tmpDir, { id: 1, isEpic: true })
      seedTicket(tmpDir, { id: 2, parentEpicId: 1 })
      seedTicket(tmpDir, { id: 3, parentEpicId: 1 })
      const app = createApp(ctx)
      const res = await request(app).delete('/api/projects/proj-1/tickets/1/children')
      expect(res.status).toBe(200)
      expect(res.body.deletedChildren).toHaveLength(2)
    })

    it('returns 409 when kill switch is on', async () => {
      process.env.SPECRAILS_SMASH = '0'
      const app = createApp(ctx)
      const res = await request(app).delete('/api/projects/proj-1/tickets/1/children')
      expect(res.status).toBe(409)
    })

    it('rejects unsupported Kimi Re-SMASH before deleting any children', async () => {
      seedTicket(tmpDir, { id: 1, isEpic: true })
      seedTicket(tmpDir, { id: 2, parentEpicId: 1 })
      ctx.project.provider = 'kimi'
      ctx.project.providers = ['kimi']
      const app = createApp(ctx)

      const res = await request(app).delete('/api/projects/proj-1/tickets/1/children')

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('smash_unsupported_for_kimi')
      const store = readStore(resolveTicketStoragePath(tmpDir))
      expect(store.tickets['2']).toBeDefined()
      expect(store.tickets['2'].parent_epic_id).toBe(1)
    })

    it('rejects Kimi-origin Re-SMASH in a Claude-primary mixed project with byte-identical ticket storage', async () => {
      ctx.project.provider = 'claude'
      ctx.project.providers = ['claude', 'kimi']
      createConversation(db, {
        id: 'conv-kimi',
        model: 'k3',
        kind: 'explore',
        provider: 'kimi',
      })
      seedTicket(tmpDir, { id: 1, isEpic: true, originConversationId: 'conv-kimi' })
      seedTicket(tmpDir, { id: 2, parentEpicId: 1 })
      const filePath = resolveTicketStoragePath(tmpDir)
      const before = fs.readFileSync(filePath)
      const app = createApp(ctx)

      const res = await request(app).delete('/api/projects/proj-1/tickets/1/children')

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('smash_unsupported_for_kimi')
      expect(fs.readFileSync(filePath).equals(before)).toBe(true)
      expect(ctx.ticketWatcher.notifyDesktopWrite).not.toHaveBeenCalled()
      expect(runSmash).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /tickets/:id épica orphaning', () => {
    it('orphans children when épica is deleted (does not cascade-delete)', async () => {
      seedTicket(tmpDir, { id: 1, isEpic: true })
      seedTicket(tmpDir, { id: 2, parentEpicId: 1 })
      seedTicket(tmpDir, { id: 3, parentEpicId: 1 })
      const app = createApp(ctx)
      const res = await request(app).delete('/api/projects/proj-1/tickets/1')
      expect(res.status).toBe(200)
      // Re-read store to confirm children survive
      const filePath = resolveTicketStoragePath(tmpDir)
      const { readStore } = await import('./ticket-store')
      const store = readStore(filePath)
      expect(store.tickets['1']).toBeUndefined()
      expect(store.tickets['2']).toBeDefined()
      expect(store.tickets['2'].parent_epic_id).toBeNull()
      expect(store.tickets['2'].execution_order).toBeNull()
      expect(store.tickets['3'].parent_epic_id).toBeNull()
    })
  })

  describe('GET /state featureFlags', () => {
    it('surfaces smash flag in featureFlags', async () => {
      const app = createApp(ctx)
      const res = await request(app).get('/api/projects/proj-1/state')
      expect(res.status).toBe(200)
      expect(res.body.featureFlags?.smash).toBe(true)
    })

    it('surfaces smash flag false when kill switch is on', async () => {
      process.env.SPECRAILS_SMASH = '0'
      const app = createApp(ctx)
      const res = await request(app).get('/api/projects/proj-1/state')
      expect(res.body.featureFlags?.smash).toBe(false)
    })
  })
})
