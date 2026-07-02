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

describe('POST /tickets/from-draft', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fromdraft-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a ticket with the supplied fields and returns 201', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({
        title: 'Add dark mode',
        description: '## Problem Statement\nUsers cannot override OS theme.\n\n## Proposed Solution\nA toggle in settings.',
        labels: ['ui', 'theme'],
        priority: 'high',
        acceptanceCriteria: ['Toggle visible', 'Persists across reload'],
      })
    expect(res.status).toBe(201)
    expect(res.body.ticket.title).toBe('Add dark mode')
    expect(res.body.ticket.priority).toBe('high')
    expect(res.body.ticket.labels).toEqual(['ui', 'theme'])
    expect(res.body.ticket.source).toBe('propose-spec')
    expect(res.body.ticket.created_by).toBe('sr-explore-spec')
    // Title is its own field — must NOT be echoed as `## Spec Title` heading.
    expect(res.body.ticket.description).not.toContain('## Spec Title')
    expect(res.body.ticket.description).toContain('## Problem Statement')
    expect(res.body.ticket.description).toContain('## Proposed Solution')
    expect(res.body.ticket.description).toContain('## Acceptance Criteria')
    expect(res.body.ticket.description).toContain('- Toggle visible')
  })

  it('rejects empty title with 400', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: '' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('title')
  })

  it('rejects whitespace-only title with 400', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: '   ' })
    expect(res.status).toBe(400)
  })

  it('normalises invalid priority to medium', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'X', priority: 'urgent' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.priority).toBe('medium')
  })

  it('defaults missing labels and acceptanceCriteria', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Y' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.labels).toEqual([])
    // No body / AC supplied → description is empty (title lives in its own field).
    expect(res.body.ticket.description).toBe('')
  })

  it('assigns monotonic ids when called twice', async () => {
    const app = createApp(ctx)
    const r1 = await request(app).post('/api/projects/proj-1/tickets/from-draft').send({ title: 'A' })
    const r2 = await request(app).post('/api/projects/proj-1/tickets/from-draft').send({ title: 'B' })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.body.ticket.id).toBe(r1.body.ticket.id + 1)
  })

  it('broadcasts a ticket_created WS message', async () => {
    const app = createApp(ctx)
    await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Z' })
    expect(ctx.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ticket_created', projectId: 'proj-1' }),
    )
  })

  it('B62: a second commit for the same conversation does not insert a duplicate', async () => {
    // conversationId must reference a real chat conversation (B5 guard).
    createConversation(db, { id: 'conv-dup', model: 'sonnet', kind: 'explore' })
    const app = createApp(ctx)
    const r1 = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'A', conversationId: 'conv-dup' })
    const r2 = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'A again', conversationId: 'conv-dup' })
    expect(r1.status).toBe(201)
    // Idempotent on the conversation: same ticket id, no second row.
    expect(r2.body.ticket.id).toBe(r1.body.ticket.id)
    const listed = await request(app).get('/api/projects/proj-1/tickets')
    const matching = (listed.body.tickets as Array<{ origin_conversation_id?: string }>)
      .filter((t) => t.origin_conversation_id === 'conv-dup')
    expect(matching).toHaveLength(1)
  })

  it('drops non-string labels', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'X', labels: ['ui', 42, null, 'theme'] })
    expect(res.status).toBe(201)
    expect(res.body.ticket.labels).toEqual(['ui', 'theme'])
  })

  it('persists short_summary from explicit body field', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({
        title: 'With summary',
        description: '## Problem Statement\nfoo',
        shortSummary: '  Crisp one-liner with extra whitespace.  ',
      })
    expect(res.status).toBe(201)
    expect(res.body.ticket.short_summary).toBe('Crisp one-liner with extra whitespace.')
  })

  it('extracts short_summary from a Short Summary section in the description', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({
        title: 'Extract from desc',
        description: '## Problem Statement\nfoo\n\n## Short Summary\nDerived from description.',
      })
    expect(res.status).toBe(201)
    expect(res.body.ticket.short_summary).toBe('Derived from description.')
    // The section is stripped from the stored description.
    expect(res.body.ticket.description).not.toContain('Short Summary')
    expect(res.body.ticket.description).toContain('Problem Statement')
  })

  it('derives short_summary when neither body nor description provide an explicit one', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({
        title: 'No explicit summary',
        description: '## Problem Statement\nUsers need a clear postit summary immediately after creation.',
      })
    expect(res.status).toBe(201)
    expect(res.body.ticket.short_summary).toBe('Users need a clear postit summary immediately after creation.')
  })

  it('400 when conversationId does not reference a real chat conversation (B5 guard)', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Bad origin', conversationId: 'agent-conv-not-in-chat' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(
      "conversationId not found in this project's chat conversations — agent conversations are not valid origins; omit conversationId",
    )
    expect(ctx.broadcast).not.toHaveBeenCalled()
  })

  it('accepts optional assignee/prerequisites/metadata on the legacy insert (one-shot commit_draft)', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({
        title: 'One shot',
        assignee: 'sr-developer',
        prerequisites: [3, 'x', 7, null],
        metadata: { area: 'server' },
      })
    expect(res.status).toBe(201)
    expect(res.body.ticket.assignee).toBe('sr-developer')
    // Non-number entries are dropped (same normalization as PATCH).
    expect(res.body.ticket.prerequisites).toEqual([3, 7])
    expect(res.body.ticket.metadata).toEqual({ area: 'server' })
  })

  it('defaults assignee/prerequisites/metadata when omitted', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Defaults' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.assignee).toBeNull()
    expect(res.body.ticket.prerequisites).toEqual([])
    expect(res.body.ticket.metadata).toEqual({})
  })

  it('accepts pendingSpecId without crashing when no attachments exist', async () => {
    // Migration is a no-op when the pending dir is empty (renameTicketDir
    // returns []). The endpoint must still succeed and produce a ticket.
    // Full attachment-migration coverage lives in attachment-manager tests
    // because the path resolves under the user's home dir, which we don't
    // override here.
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Pending OK', pendingSpecId: 'pending-zzz' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.title).toBe('Pending OK')
  })
})

// ─── Flip-in-place path (save-as-draft → from-draft) ─────────────────────────

import { mutateStore, resolveTicketStoragePath } from './ticket-store'
import { addMessage, createConversation } from './db'

describe('POST /tickets/from-draft — flip-in-place', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fromdraft-flip-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedDraft(opts: { conversationId: string; title?: string }): number {
    const filePath = resolveTicketStoragePath(tmpDir)
    let id = 0
    mutateStore(filePath, (s) => {
      id = s.next_id++
      s.tickets[String(id)] = {
        id,
        title: opts.title ?? 'Draft seed',
        description: '',
        status: 'draft',
        priority: null,
        labels: [],
        assignee: null,
        prerequisites: [],
        metadata: {},
        comments: [],
        origin_conversation_id: opts.conversationId,
        is_epic: false,
        parent_epic_id: null,
        execution_order: null,
        short_summary: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        created_by: 'sr-explore-spec',
        source: 'explore-draft',
      }
    })
    return id
  }

  it('flips an existing draft ticket to todo in place', async () => {
    const draftId = seedDraft({ conversationId: 'conv-A' })
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Final', description: 'Body', priority: 'high', draftTicketId: draftId })
    expect(res.status).toBe(201)
    expect(res.body.ticket.id).toBe(draftId)
    expect(res.body.ticket.status).toBe('todo')
    expect(res.body.ticket.priority).toBe('high')
    expect(res.body.ticket.title).toBe('Final')
  })

  it('preserves origin_conversation_id across the flip', async () => {
    const draftId = seedDraft({ conversationId: 'conv-keep' })
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Final', priority: 'medium', draftTicketId: draftId })
    expect(res.status).toBe(201)
    expect(res.body.ticket.origin_conversation_id).toBe('conv-keep')
  })

  it('falls back to looking up the draft by conversationId', async () => {
    createConversation(db, { id: 'conv-fallback', model: 'sonnet', kind: 'explore' })
    const draftId = seedDraft({ conversationId: 'conv-fallback' })
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Final', priority: 'low', conversationId: 'conv-fallback' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.id).toBe(draftId)
    expect(res.body.ticket.status).toBe('todo')
  })

  it('applies assignee/prerequisites/metadata on the flip (merging metadata keys)', async () => {
    const draftId = seedDraft({ conversationId: 'conv-fields' })
    const filePath = resolveTicketStoragePath(tmpDir)
    mutateStore(filePath, (s) => {
      s.tickets[String(draftId)].metadata = { area: 'client' }
    })
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({
        title: 'Final',
        priority: 'high',
        draftTicketId: draftId,
        assignee: 'sr-developer',
        prerequisites: [1, 2],
        metadata: { effort_level: 'low' },
      })
    expect(res.status).toBe(201)
    expect(res.body.ticket.assignee).toBe('sr-developer')
    expect(res.body.ticket.prerequisites).toEqual([1, 2])
    // Metadata merges (PATCH semantics), preserving pre-existing keys.
    expect(res.body.ticket.metadata).toEqual({ area: 'client', effort_level: 'low' })
  })

  it('leaves assignee/prerequisites/metadata untouched on flip when omitted', async () => {
    const draftId = seedDraft({ conversationId: 'conv-untouched' })
    const filePath = resolveTicketStoragePath(tmpDir)
    mutateStore(filePath, (s) => {
      s.tickets[String(draftId)].assignee = 'keep-me'
      s.tickets[String(draftId)].prerequisites = [9]
      s.tickets[String(draftId)].metadata = { area: 'server' }
    })
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Final', priority: 'medium', draftTicketId: draftId })
    expect(res.status).toBe(201)
    expect(res.body.ticket.assignee).toBe('keep-me')
    expect(res.body.ticket.prerequisites).toEqual([9])
    expect(res.body.ticket.metadata).toEqual({ area: 'server' })
  })

  it('legacy path (no draftTicketId, no matching draft) still inserts a new ticket', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Legacy' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.status).toBe('todo')
    expect(res.body.ticket.priority).toBe('medium')
  })

  it('returns 404 when explicit draftTicketId points at a non-existent ticket', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'X', draftTicketId: 9999 })
    expect(res.status).toBe(404)
  })

  it('broadcasts a ticket_updated message on flip (not ticket_created)', async () => {
    const draftId = seedDraft({ conversationId: 'conv-bc' })
    const app = createApp(ctx)
    await request(app)
      .post('/api/projects/proj-1/tickets/from-draft')
      .send({ title: 'Bc', draftTicketId: draftId, priority: 'medium' })
    expect(ctx.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ticket_updated', projectId: 'proj-1' }),
    )
  })
})

// ─── POST /tickets/save-as-draft ─────────────────────────────────────────────

describe('POST /tickets/save-as-draft', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'savedraft-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedConv(id: string, userText: string) {
    createConversation(db, { id, model: 'sonnet', kind: 'explore' })
    addMessage(db, { conversation_id: id, role: 'user', content: userText })
  }

  it('400 when conversationId is missing', async () => {
    const app = createApp(ctx)
    const res = await request(app).post('/api/projects/proj-1/tickets/save-as-draft').send({})
    expect(res.status).toBe(400)
  })

  it('400 when the conversation has no user-submitted turn', async () => {
    createConversation(db, { id: 'empty-c', model: 'sonnet', kind: 'explore' })
    const app = createApp(ctx)
    const res = await request(app).post('/api/projects/proj-1/tickets/save-as-draft').send({ conversationId: 'empty-c' })
    expect(res.status).toBe(400)
  })

  it('happy path persists a draft ticket with auto-title', async () => {
    seedConv('c1', 'Build a settings page with persistence')
    const app = createApp(ctx)
    const res = await request(app).post('/api/projects/proj-1/tickets/save-as-draft').send({ conversationId: 'c1' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.status).toBe('draft')
    expect(res.body.ticket.priority).toBeNull()
    expect(res.body.ticket.origin_conversation_id).toBe('c1')
    expect(typeof res.body.ticket.title).toBe('string')
    expect(res.body.ticket.title.length).toBeGreaterThan(0)
  })

  it('user-supplied title is honoured verbatim', async () => {
    seedConv('c2', 'something')
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({ conversationId: 'c2', title: 'My exact title' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.title).toBe('My exact title')
  })

  it('idempotent on conversationId — second save updates existing draft', async () => {
    seedConv('c3', 'first')
    const app = createApp(ctx)
    const r1 = await request(app).post('/api/projects/proj-1/tickets/save-as-draft').send({ conversationId: 'c3' })
    const r2 = await request(app).post('/api/projects/proj-1/tickets/save-as-draft').send({ conversationId: 'c3', title: 'Renamed' })
    expect(r1.body.ticket.id).toBe(r2.body.ticket.id)
    expect(r2.body.ticket.title).toBe('Renamed')
  })

  it('broadcasts a ticket_created the first time', async () => {
    seedConv('c4', 'x')
    const app = createApp(ctx)
    await request(app).post('/api/projects/proj-1/tickets/save-as-draft').send({ conversationId: 'c4' })
    expect(ctx.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ticket_created', projectId: 'proj-1' }),
    )
  })
})

// ─── save-as-draft with editTicketId (flip-in-place demotion) ────────────────

describe('POST /tickets/save-as-draft — editTicketId flip-in-place', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'savedraft-flip-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedConv(id: string, userText: string) {
    createConversation(db, { id, model: 'sonnet', kind: 'explore' })
    addMessage(db, { conversation_id: id, role: 'user', content: userText })
  }

  function seedTicket(opts: {
    status: 'todo' | 'backlog' | 'draft'
    priority: 'high' | 'medium' | 'low' | null
    title?: string
    originConversationId?: string | null
    createdAt?: string
  }): number {
    const filePath = resolveTicketStoragePath(tmpDir)
    let id = 0
    mutateStore(filePath, (s) => {
      id = s.next_id++
      s.tickets[String(id)] = {
        id,
        title: opts.title ?? 'Seed',
        description: 'seed body',
        status: opts.status,
        priority: opts.priority,
        labels: ['seed'],
        assignee: null,
        prerequisites: [],
        metadata: {},
        comments: [],
        origin_conversation_id: opts.originConversationId ?? null,
        is_epic: false,
        parent_epic_id: null,
        execution_order: null,
        short_summary: null,
        created_at: opts.createdAt ?? '2026-01-01T00:00:00Z',
        updated_at: opts.createdAt ?? '2026-01-01T00:00:00Z',
        created_by: 'manual',
        source: 'manual',
      }
    })
    return id
  }

  it('flips a todo ticket to draft in place (preserves id, clears priority)', async () => {
    seedConv('c-todo', 'edit this')
    const id = seedTicket({ status: 'todo', priority: 'high', title: 'Original todo' })
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({
        conversationId: 'c-todo',
        editTicketId: id,
        title: 'Updated',
        description: 'Updated body',
        labels: ['x', 'y'],
      })
    expect(res.status).toBe(200)
    expect(res.body.ticket.id).toBe(id)
    expect(res.body.ticket.status).toBe('draft')
    expect(res.body.ticket.priority).toBeNull()
    expect(res.body.ticket.origin_conversation_id).toBe('c-todo')
    expect(res.body.ticket.title).toBe('Updated')
    expect(res.body.ticket.description).toBe('Updated body')
    expect(res.body.ticket.labels).toEqual(['x', 'y'])
    expect(res.body.ticket.created_at).toBe('2026-01-01T00:00:00Z')
    expect(res.body.ticket.created_by).toBe('manual')
  })

  it('flips a backlog ticket to draft in place', async () => {
    seedConv('c-bl', 'edit')
    const id = seedTicket({ status: 'backlog', priority: 'low' })
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({ conversationId: 'c-bl', editTicketId: id })
    expect(res.status).toBe(200)
    expect(res.body.ticket.id).toBe(id)
    expect(res.body.ticket.status).toBe('draft')
    expect(res.body.ticket.priority).toBeNull()
  })

  it('idempotent: second save with same editTicketId does not duplicate', async () => {
    seedConv('c-idem', 'edit')
    const id = seedTicket({ status: 'todo', priority: 'medium' })
    const app = createApp(ctx)
    const r1 = await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({ conversationId: 'c-idem', editTicketId: id, title: 'First' })
    const r2 = await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({ conversationId: 'c-idem', editTicketId: id, title: 'Second' })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(r1.body.ticket.id).toBe(id)
    expect(r2.body.ticket.id).toBe(id)
    expect(r2.body.ticket.title).toBe('Second')
    expect(r2.body.ticket.status).toBe('draft')
    expect(r2.body.ticket.priority).toBeNull()
  })

  it('on already-draft target, updates origin_conversation_id but keeps draft', async () => {
    seedConv('c-new', 'edit')
    const id = seedTicket({ status: 'draft', priority: null, originConversationId: 'c-old' })
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({ conversationId: 'c-new', editTicketId: id })
    expect(res.status).toBe(200)
    expect(res.body.ticket.status).toBe('draft')
    expect(res.body.ticket.priority).toBeNull()
    expect(res.body.ticket.origin_conversation_id).toBe('c-new')
  })

  it('returns 404 when editTicketId does not exist', async () => {
    seedConv('c-404', 'edit')
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({ conversationId: 'c-404', editTicketId: 999999 })
    expect(res.status).toBe(404)
    expect(ctx.broadcast).not.toHaveBeenCalled()
  })

  it('returns 400 when editTicketId is the wrong type', async () => {
    seedConv('c-bad', 'edit')
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({ conversationId: 'c-bad', editTicketId: 'abc' })
    expect(res.status).toBe(400)
    expect(ctx.broadcast).not.toHaveBeenCalled()
  })

  it('emits exactly one ticket_updated and no ticket_created on flip', async () => {
    seedConv('c-broadcast', 'edit')
    const id = seedTicket({ status: 'todo', priority: 'high' })
    const app = createApp(ctx)
    await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({ conversationId: 'c-broadcast', editTicketId: id })
    const calls = (ctx.broadcast as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const updates = calls.filter((c) => (c[0] as { type: string }).type === 'ticket_updated')
    const creates = calls.filter((c) => (c[0] as { type: string }).type === 'ticket_created')
    expect(updates.length).toBe(1)
    expect(creates.length).toBe(0)
  })

  it('legacy fresh-session path (no editTicketId) is unchanged', async () => {
    seedConv('c-legacy', 'fresh idea')
    const app = createApp(ctx)
    const r1 = await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({ conversationId: 'c-legacy' })
    const r2 = await request(app)
      .post('/api/projects/proj-1/tickets/save-as-draft')
      .send({ conversationId: 'c-legacy', title: 'Renamed' })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r1.body.ticket.id).toBe(r2.body.ticket.id)
    expect(r2.body.ticket.title).toBe('Renamed')
  })
})

// ─── Cascade behaviour ───────────────────────────────────────────────────────

describe('cascade: conversation delete clears origin_conversation_id', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('clears origin_conversation_id on referencing tickets when the conversation is deleted', async () => {
    createConversation(db, { id: 'c-X', model: 'sonnet', kind: 'explore' })
    addMessage(db, { conversation_id: 'c-X', role: 'user', content: 'hi' })
    const app = createApp(ctx)
    const save = await request(app).post('/api/projects/proj-1/tickets/save-as-draft').send({ conversationId: 'c-X' })
    expect(save.status).toBe(201)
    const ticketId = save.body.ticket.id
    const del = await request(app).delete('/api/projects/proj-1/chat/conversations/c-X')
    expect(del.status).toBe(200)
    const get = await request(app).get(`/api/projects/proj-1/tickets/${ticketId}`)
    expect(get.status).toBe(200)
    expect(get.body.ticket.origin_conversation_id).toBeNull()
  })

  it('deleting a draft ticket cascades to its orphan Explore conversation', async () => {
    createConversation(db, { id: 'c-orphan', model: 'sonnet', kind: 'explore' })
    addMessage(db, { conversation_id: 'c-orphan', role: 'user', content: 'idea' })
    const app = createApp(ctx)
    const save = await request(app).post('/api/projects/proj-1/tickets/save-as-draft').send({ conversationId: 'c-orphan' })
    const ticketId = save.body.ticket.id
    await request(app).delete(`/api/projects/proj-1/tickets/${ticketId}`)
    // Conversation should be gone — re-fetching returns 404
    const conv = await request(app).get('/api/projects/proj-1/chat/conversations/c-orphan')
    expect(conv.status).toBe(404)
  })
})
