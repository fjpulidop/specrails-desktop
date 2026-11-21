import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

import { createProjectRouter } from './project-router'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import { beginAppProcessQuiescence, beginProjectProcessQuiescence, openProjectProcessAdmission, resetProcessAdmissionForTests } from './process-admission'
import type { ProjectContext, ProjectRegistry } from './project-registry'

// The campaign of 2026-11-19 registered a project and launched at once: every launch answered
// 409 project_recovery_in_progress for about two seconds, while the new project was reconciled.
function setup(dir: string) {
  const ctx = {
    project: { id: 'proj-1', slug: 'proj', name: 'Test', path: dir, db_path: ':memory:', added_at: '', last_seen_at: '' },
    db: initDb(':memory:'), queueManager: {} as any, setupManager: {} as any, proposalManager: {} as any, specLauncherManager: {} as any,
    chatManager: { forgetSpecDraft: vi.fn(), forgetExploreLifecycle: vi.fn() } as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast: vi.fn(),
  } as unknown as ProjectContext
  const registry = {
    desktopDb: initDesktopDb(':memory:'), getContext: vi.fn((id: string) => (id === 'proj-1' ? ctx : undefined)),
    getContextByPath: vi.fn(() => undefined), touchProject: vi.fn(), listContexts: vi.fn(() => [ctx]),
  } as unknown as ProjectRegistry
  const app = express()
  app.use(express.json())
  app.use('/api/projects', createProjectRouter(registry))
  return { app, registry }
}

describe('a request to a project that is still being registered', () => {
  let dir: string
  beforeEach(() => { resetProcessAdmissionForTests(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-routes-')) })
  afterEach(() => { resetProcessAdmissionForTests(); fs.rmSync(dir, { recursive: true, force: true }) })

  it('waits for the project to admit work instead of answering 409', async () => {
    const { app } = setup(dir)
    beginProjectProcessQuiescence('proj-1')
    let opened = false
    setTimeout(() => { opened = true; openProjectProcessAdmission('proj-1') }, 80)
    const res = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Right after registration' })
    expect(res.status).toBe(201)
    expect(opened).toBe(true)
  })

  it('serves reads at once while the project is reconciled', async () => {
    const { app } = setup(dir)
    beginProjectProcessQuiescence('proj-1')
    const res = await request(app).get('/api/projects/proj-1/tickets')
    expect(res.status).toBe(200)
  })

  it('answers a retryable 409 when the app shuts down while the request waits', async () => {
    const { app } = setup(dir)
    beginProjectProcessQuiescence('proj-1')
    setTimeout(() => { beginAppProcessQuiescence(); openProjectProcessAdmission('proj-1') }, 30)
    const res = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'During shutdown' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'project_recovery_in_progress', retryable: true })
    expect(res.headers['retry-after']).toBe('2')
  })

  it('does not run against a project that was removed while it waited', async () => {
    const { app, registry } = setup(dir)
    beginProjectProcessQuiescence('proj-1')
    setTimeout(() => { vi.mocked(registry.getContext).mockReturnValue(undefined); openProjectProcessAdmission('proj-1') }, 30)
    const res = await request(app).post('/api/projects/proj-1/tickets').send({ title: 'Removed meanwhile' })
    expect(res.status).toBe(404)
  })
})
