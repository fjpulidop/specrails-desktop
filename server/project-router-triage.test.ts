import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createProjectRouter } from './project-router'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import type { ProjectContext, ProjectRegistry } from './project-registry'
import type { TriageOutcome } from './modules/specs/runtime/triage'

function app(triageNow?: (id: number, opts: { force?: boolean }) => Promise<TriageOutcome>) {
  const ctx = {
    project: { id: 'proj-1', slug: 'proj', name: 'P', path: '/tmp', db_path: ':memory:', provider: 'claude', providers: ['claude'], added_at: '', last_seen_at: '' },
    db: initDb(':memory:'),
    broadcast: vi.fn(),
    ticketWatcher: { notifyDesktopWrite: vi.fn() },
    ...(triageNow ? { specTriage: { triageNow } } : {}),
  } as unknown as ProjectContext
  const registry = {
    desktopDb: initDesktopDb(':memory:'),
    getContext: vi.fn((id: string) => (id === 'proj-1' ? ctx : undefined)),
    getContextByPath: vi.fn(() => undefined),
    getProjectRow: vi.fn(() => undefined),
    listFailedProjects: vi.fn(() => []),
    listContexts: vi.fn(() => [ctx]),
    touchProject: vi.fn(),
  } as unknown as ProjectRegistry
  const instance = express()
  instance.use(express.json())
  instance.use('/api/projects', createProjectRouter(registry))
  return instance
}

const READY = {
  status: 'ready', size: 'S', filesLikely: [], publicInterfaces: false, dataModel: false, securitySurface: false,
  recommendedLoop: 'factory:implement', recommendedMode: 'implement', rationale: 'r', confidence: 'high',
  inputsHash: 'sha256:h', model: 'haiku', costUsd: 0.01, computedAt: 't',
} as const

describe('POST /:projectId/tickets/:id/triage', () => {
  it('forces a recalculation and returns the stored record', async () => {
    const triageNow = vi.fn(async () => ({ kind: 'stored', triage: READY }) as TriageOutcome)
    const res = await request(app(triageNow)).post('/api/projects/proj-1/tickets/12/triage')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ triage: READY })
    expect(triageNow).toHaveBeenCalledWith(12, { force: true })
  })

  it('maps unknown, inapplicable and invalid ids', async () => {
    expect((await request(app(async () => ({ kind: 'not_found' }))).post('/api/projects/proj-1/tickets/9/triage')).status).toBe(404)
    const conflict = await request(app(async () => ({ kind: 'not_applicable', reason: 'epic' }))).post('/api/projects/proj-1/tickets/9/triage')
    expect(conflict.status).toBe(409)
    expect(conflict.body).toEqual({ error: 'triage_not_applicable', reason: 'epic' })
    expect((await request(app(async () => ({ kind: 'not_found' }))).post('/api/projects/proj-1/tickets/abc/triage')).status).toBe(400)
  })

  it('answers 503 without a triage service and 500 on an unexpected failure', async () => {
    expect((await request(app()).post('/api/projects/proj-1/tickets/1/triage')).status).toBe(503)
    expect((await request(app(async () => { throw new Error('boom') })).post('/api/projects/proj-1/tickets/1/triage')).status).toBe(500)
  })
})
