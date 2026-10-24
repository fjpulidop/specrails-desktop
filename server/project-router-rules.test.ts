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

vi.mock('./modules/agent-runtime/runtime/core-capabilities', () => ({
  corePhase3Capabilities: vi.fn(async () => ({ architectClarifications: true, specTrace: true, baselineOnTouch: false, rulesInventory: true })),
}))

describe('project rules routes composition (task 4.4)', () => {
  let tmpDir: string
  let ctx: ProjectContext
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-routes-'))
    ctx = makeContext(initDb(':memory:'), tmpDir)
    fs.mkdirSync(path.join(tmpDir, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.specrails', 'rules.json'), JSON.stringify({ gates: [], rules: [{ text: 'Frontend API calls use getApiBase()', source: 'AGENTS.md:92', status: 'automatable', proposedCheck: 'ESLint rule' }] }))
  })
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('serves the phase-3 capabilities and creates a rules-sourced spec with non-goals', async () => {
    const app = createApp(ctx)
    expect((await request(app).get('/api/projects/proj-1/core/phase3-capabilities')).body).toEqual({ architectClarifications: true, specTrace: true, baselineOnTouch: false, rulesInventory: true })
    const res = await request(app).post('/api/projects/proj-1/rules/specs').send({ index: 0 })
    expect(res.status).toBe(201)
    const ticket = readStore(resolveTicketStoragePath(tmpDir)).tickets[String(res.body.ticket.id)]
    expect(ticket).toMatchObject({ source: 'rules', created_by: 'rules-inventory', status: 'todo', labels: ['rules', 'automation'] })
    expect(ticket.nonGoals?.length).toBeGreaterThan(0)
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket_created' }))
    expect(ctx.ticketWatcher.notifyDesktopWrite).toHaveBeenCalled()
  })
})
