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

import { readStore, resolveTicketStoragePath } from './modules/specs/runtime/ticket-store'

const INTENT = {
  problem: 'Reviewers cannot tell why a spec exists.',
  outcome: 'Every spec states the problem it solves.',
  successSignals: ['- Reviewers find the why in under 10 s'],
  affects: ['Reviewers'],
  constraints: ['No Jira field changes'],
  openQuestions: ['Should drafts require it?'],
}
const NORMALIZED = {
  problem: 'Reviewers cannot tell why a spec exists.',
  outcome: 'Every spec states the problem it solves.',
  successSignals: ['Reviewers find the why in under 10 s'],
  affects: ['Reviewers'],
  constraints: ['No Jira field changes'],
  openQuestions: [{ question: 'Should drafts require it?' }],
}

describe('ticket intent over HTTP (intent-mode)', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
  })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  const stored = (id: number) => readStore(resolveTicketStoragePath(tmpDir)).tickets[String(id)]

  it('creates a ticket with a normalized intent and names a missing section', async () => {
    const app = createApp(ctx)
    const ok = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'T', intent: INTENT })
    expect(ok.status).toBe(201)
    expect(ok.body.ticket.intent).toEqual(NORMALIZED)
    expect(stored(ok.body.ticket.id).intent).toEqual(NORMALIZED)
    const bad = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'T', intent: { problem: 'P' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('intent.outcome is required')
    const none = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Plain' })
    expect(none.body.ticket).not.toHaveProperty('intent')
  })

  it('edits the intent with PATCH, clears it with null and never pushes it to Jira', async () => {
    const jira = { onSpecEdited: vi.fn() }
    ;(ctx as unknown as { jiraSyncManager: unknown }).jiraSyncManager = jira
    const app = createApp(ctx)
    const id = (await request(app).post('/api/projects/proj-1/tickets').send({ title: 'T' })).body.ticket.id
    const patched = await request(app).patch(`/api/projects/proj-1/tickets/${id}`).send({ intent: { ...INTENT, outcome: 'Changed' } })
    expect(patched.status).toBe(200)
    expect(stored(id).intent?.outcome).toBe('Changed')
    expect(jira.onSpecEdited).not.toHaveBeenCalled()
    await request(app).patch(`/api/projects/proj-1/tickets/${id}`).send({ intent: null })
    expect(stored(id)).not.toHaveProperty('intent')
    expect((await request(app).patch(`/api/projects/proj-1/tickets/${id}`).send({ intent: [] })).status).toBe(400)
  })

  it('from-draft stores the intent of the draft', async () => {
    const app = createApp(ctx)
    const created = await request(app).post('/api/projects/proj-1/tickets/from-draft').send({ title: 'A', description: '## Problem Statement\nP', intent: INTENT })
    expect(created.status).toBe(201)
    expect(created.body.ticket.intent).toEqual(NORMALIZED)
    expect((await request(app).post('/api/projects/proj-1/tickets/from-draft').send({ title: 'B', intent: 'x' })).status).toBe(400)
  })

  it('a stored ticket with an unusable intent reads without it', async () => {
    const app = createApp(ctx)
    const id = (await request(app).post('/api/projects/proj-1/tickets').send({ title: 'T', intent: INTENT })).body.ticket.id
    const file = resolveTicketStoragePath(tmpDir)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.tickets[String(id)].intent = { problem: '' }
    fs.writeFileSync(file, JSON.stringify(raw))
    expect(stored(id)).not.toHaveProperty('intent')
  })
})
