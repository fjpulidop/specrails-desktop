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

describe('ticket non-goals over HTTP (feedback-2026-10 task 3.2)', () => {
  let tmpDir: string
  let db: DbInstance
  let ctx: ProjectContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nongoals-'))
    db = initDb(':memory:')
    ctx = makeContext(db, tmpDir)
  })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  const stored = (id: number) => readStore(resolveTicketStoragePath(tmpDir)).tickets[String(id)]

  it('creates a ticket with non-goals and rejects a malformed list', async () => {
    const app = createApp(ctx)
    const ok = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'T', nonGoals: ['- Mobile', 'Mobile', ''] })
    expect(ok.status).toBe(201)
    expect(ok.body.ticket.nonGoals).toEqual(['Mobile'])
    const bad = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'T', nonGoals: 'Mobile' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('nonGoals must be an array of strings')
    const none = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Plain' })
    expect(none.body.ticket).not.toHaveProperty('nonGoals')
  })

  it('edits non-goals with PATCH, clears them with an empty list, and leaves Jira alone', async () => {
    const jira = { onSpecEdited: vi.fn() }
    ;(ctx as unknown as { jiraSyncManager: unknown }).jiraSyncManager = jira
    const app = createApp(ctx)
    const created = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'T' })
    const id = created.body.ticket.id
    const patched = await request(app).patch(`/api/projects/proj-1/tickets/${id}`).send({ nonGoals: ['Exports', ' Exports '] })
    expect(patched.status).toBe(200)
    expect(stored(id).nonGoals).toEqual(['Exports'])
    expect(jira.onSpecEdited).not.toHaveBeenCalled()
    await request(app).patch(`/api/projects/proj-1/tickets/${id}`).send({ nonGoals: [] })
    expect(stored(id)).not.toHaveProperty('nonGoals')
    const bad = await request(app).patch(`/api/projects/proj-1/tickets/${id}`).send({ nonGoals: [1] })
    expect(bad.status).toBe(400)
  })

  it('from-draft takes explicit non-goals, or moves the Out of Scope section of the description', async () => {
    const app = createApp(ctx)
    const explicit = await request(app).post('/api/projects/proj-1/tickets/from-draft').send({
      title: 'A', description: '## Problem Statement\nP\n\n## Out of Scope\n- Ignored\n\n## Proposed Solution\nS', nonGoals: ['Explicit'],
    })
    expect(explicit.status).toBe(201)
    expect(explicit.body.ticket.nonGoals).toEqual(['Explicit'])
    expect(explicit.body.ticket.description).not.toContain('## Out of Scope')
    const fromSection = await request(app).post('/api/projects/proj-1/tickets/from-draft').send({
      title: 'B', description: '## Problem Statement\nP\n\n## Out of Scope\n- Offline mode\n- Exports\n\n## Proposed Solution\nS',
    })
    expect(fromSection.body.ticket.nonGoals).toEqual(['Offline mode', 'Exports'])
    expect(fromSection.body.ticket.description).toContain('## Proposed Solution')
    expect(fromSection.body.ticket.description).not.toContain('Offline mode')
    const legacy = await request(app).post('/api/projects/proj-1/tickets/from-draft').send({ title: 'C', description: '## Problem Statement\nP' })
    expect(legacy.body.ticket).not.toHaveProperty('nonGoals')
    const bad = await request(app).post('/api/projects/proj-1/tickets/from-draft').send({ title: 'D', nonGoals: {} })
    expect(bad.status).toBe(400)
  })
})
