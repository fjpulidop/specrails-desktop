import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

import { createProjectRouter, lightlyStructurePrompt } from './project-router'
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

describe('POST /tickets/from-prompt (Raw mode)', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fromprompt-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function countInvocations(): number {
    const row = db.prepare('SELECT COUNT(*) AS n FROM ai_invocations').get() as { n: number }
    return row.n
  }

  it('creates a todo ticket verbatim from the prompt and returns 201', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'Add a CSV export button to the reports page', priority: 'high', labels: ['reports'] })
    expect(res.status).toBe(201)
    expect(res.body.ticket.status).toBe('todo')
    expect(res.body.ticket.description).toBe('Add a CSV export button to the reports page')
    expect(res.body.ticket.priority).toBe('high')
    expect(res.body.ticket.labels).toEqual(['reports'])
    expect(res.body.ticket.source).toBe('free-prompt')
    expect(res.body.ticket.created_by).toBe('hub') // legacy on-disk wire value
    expect(res.body.ticket.origin_conversation_id).toBeNull()
    expect(typeof res.body.revision).toBe('number')
  })

  it('rejects an empty description with 400', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: '' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('description')
  })

  it('rejects a whitespace-only description with 400', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: '   \n  ' })
    expect(res.status).toBe(400)
  })

  it('defaults the priority to medium when omitted', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'No priority given' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.priority).toBe('medium')
  })

  it('normalises an invalid priority to medium', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'x', priority: 'urgent' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.priority).toBe('medium')
  })

  it('derives the title from the description when no title is supplied', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'Improve onboarding flow' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.title).toBe('Improve onboarding flow')
  })

  it('derives the title from the first sentence of a longer description', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'Add dark mode. Also persist the preference across reloads.' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.title).toBe('Add dark mode')
  })

  it('honours an explicit title verbatim', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'body that would derive another title', title: 'Exact Title' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.title).toBe('Exact Title')
  })

  it('defaults labels to an empty array and drops non-string labels', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'x', labels: ['ui', 42, null, 'theme'] })
    expect(res.status).toBe(201)
    expect(res.body.ticket.labels).toEqual(['ui', 'theme'])
  })

  it('stores the description verbatim when structured is false/omitted', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'just the raw text' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.description).toBe('just the raw text')
  })

  it('lightly structures the description under an Overview heading when structured=true', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'do the thing', structured: true })
    expect(res.status).toBe(201)
    expect(res.body.ticket.description).toContain('## Overview')
    expect(res.body.ticket.description).toContain('do the thing')
  })

  it('derives a short_summary for the postit view', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'Users need a quick way to export analytics to CSV from the dashboard.' })
    expect(res.status).toBe(201)
    expect(typeof res.body.ticket.short_summary).toBe('string')
    expect(res.body.ticket.short_summary.length).toBeGreaterThan(0)
  })

  it('writes NO ai_invocations row (nothing was billed)', async () => {
    const app = createApp(ctx)
    await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'should not bill anything' })
    expect(countInvocations()).toBe(0)
  })

  it('[spec:spec-creation-provider-affinity/non-mission-creation-unchanged] has no mission context: pins no provider and runs no AI step', async () => {
    const pinProvider = vi.fn()
    ;(ctx as unknown as { specTriage: unknown }).specTriage = { pinProvider }
    const res = await request(createApp(ctx))
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'raw prompt', agentProvider: 'codex' })
    expect(res.status).toBe(201)
    expect(pinProvider).not.toHaveBeenCalled()
    expect(countInvocations()).toBe(0)
  })

  it('never broadcasts spending.invalidated (no invocation, no contract-refine)', async () => {
    const app = createApp(ctx)
    await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'no contract refine here' })
    const calls = (ctx.broadcast as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.some((c) => (c[0] as { type?: string }).type === 'spending.invalidated')).toBe(false)
    expect(calls.some((c) => String((c[0] as { type?: string }).type ?? '').includes('contract_refine'))).toBe(false)
  })

  it('broadcasts a ticket_created WS message (never ticket_updated)', async () => {
    const app = createApp(ctx)
    await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'broadcast me' })
    const calls = (ctx.broadcast as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.some((c) => (c[0] as { type: string; projectId: string }).type === 'ticket_created' && (c[0] as { projectId: string }).projectId === 'proj-1')).toBe(true)
    expect(calls.some((c) => (c[0] as { type: string }).type === 'ticket_updated')).toBe(false)
  })

  it('assigns monotonic ids across calls', async () => {
    const app = createApp(ctx)
    const r1 = await request(app).post('/api/projects/proj-1/tickets/from-prompt').send({ description: 'first' })
    const r2 = await request(app).post('/api/projects/proj-1/tickets/from-prompt').send({ description: 'second' })
    expect(r2.body.ticket.id).toBe(r1.body.ticket.id + 1)
  })

  it('accepts a pendingSpecId without crashing when there are no attachments', async () => {
    const app = createApp(ctx)
    const res = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'pending ok', pendingSpecId: 'pending-xyz' })
    expect(res.status).toBe(201)
    expect(res.body.ticket.source).toBe('free-prompt')
  })

  it('persists the ticket so a subsequent GET returns it', async () => {
    const app = createApp(ctx)
    const create = await request(app)
      .post('/api/projects/proj-1/tickets/from-prompt')
      .send({ description: 'persisted body', title: 'Persisted' })
    const id = create.body.ticket.id
    const get = await request(app).get(`/api/projects/proj-1/tickets/${id}`)
    expect(get.status).toBe(200)
    expect(get.body.ticket.source).toBe('free-prompt')
    expect(get.body.ticket.title).toBe('Persisted')
  })
})

describe('lightlyStructurePrompt', () => {
  it('prefixes an Overview heading when the body has no leading heading', () => {
    expect(lightlyStructurePrompt('plain idea')).toBe('## Overview\n\nplain idea')
  })

  it('leaves a body that already starts with a markdown heading untouched', () => {
    expect(lightlyStructurePrompt('## Goal\nship it')).toBe('## Goal\nship it')
    expect(lightlyStructurePrompt('# Title\nbody')).toBe('# Title\nbody')
  })

  it('trims surrounding whitespace and returns empty for blank input', () => {
    expect(lightlyStructurePrompt('   ')).toBe('')
    expect(lightlyStructurePrompt('  hello  ')).toBe('## Overview\n\nhello')
  })
})
