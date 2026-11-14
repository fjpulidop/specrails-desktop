import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

// The attachment manager singleton resolves its home at import time.
const testHome = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/ticket-attachments-home-${process.pid}`
  process.env.SPECRAILS_REGISTRY_HOME = dir
  return dir
})

import { createProjectRouter } from './project-router'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import type { ProjectRegistry, ProjectContext } from './project-registry'

const PENDING_ID = '123e4567-e89b-42d3-a456-426614174000'
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00])

function makeContext(projectPath: string): ProjectContext {
  return {
    project: { id: 'proj-1', slug: 'proj', name: 'Test', path: projectPath, db_path: ':memory:', added_at: '', last_seen_at: '' },
    db: initDb(':memory:'),
    queueManager: {} as any,
    chatManager: { forgetSpecDraft: vi.fn(), forgetExploreLifecycle: vi.fn() } as any,
    setupManager: {} as any,
    proposalManager: {} as any,
    specLauncherManager: {} as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast: vi.fn(),
  }
}

function createApp(ctx: ProjectContext) {
  const registry = {
    desktopDb: initDesktopDb(':memory:'),
    getContext: vi.fn((id: string) => (id === ctx.project.id ? ctx : undefined)),
    getContextByPath: vi.fn(() => undefined),
    touchProject: vi.fn(),
    listContexts: vi.fn(() => [ctx]),
  } as unknown as ProjectRegistry
  const app = express()
  app.use(express.json())
  app.use('/api/projects', createProjectRouter(registry))
  return app
}

describe('ticket attachment upload: readable-text opt-in', () => {
  let dir: string
  let app: express.Express
  const base = '/api/projects/proj-1/tickets'

  function upload(ticketId: string, query: string, file: Buffer, filename: string, contentType: string) {
    return request(app).post(`${base}/${ticketId}/attachments${query}`).attach('file', file, { filename, contentType })
  }

  beforeEach(() => {
    fs.mkdirSync(testHome, { recursive: true })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-attachments-'))
    app = createApp(makeContext(dir))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  it('accepts a markdown file on a pending spec when opted in', async () => {
    const res = await upload(PENDING_ID, '?readableText=1', Buffer.from('# Notes'), 'notes.md', 'text/markdown')

    expect(res.status).toBe(201)
    expect(res.body.attachment.mimeType).toBe('text/plain')
  })

  it('refuses a zip on a pending spec when opted in, with the reasoned message', async () => {
    const res = await upload(PENDING_ID, '?readableText=1', ZIP_HEADER, 'bundle.zip', 'application/zip')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('"bundle.zip" is not a text file and cannot be attached')
  })

  it('keeps the old rejection for a pending spec without the opt-in', async () => {
    const res = await upload(PENDING_ID, '', Buffer.from('# Notes'), 'notes.md', 'text/markdown')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Unsupported file type: text/markdown')
  })

  it('keeps the old rejection for a real ticket even when opted in', async () => {
    const created = await request(app).post(base).send({ title: 'Real ticket' })
    expect(created.status).toBe(201)

    const res = await upload(String(created.body.ticket.id), '?readableText=1', Buffer.from('# Notes'), 'notes.md', 'text/markdown')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Unsupported file type: text/markdown')
  })
})
