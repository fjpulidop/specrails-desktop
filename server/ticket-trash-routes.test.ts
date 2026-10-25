import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

import { createProjectRouter } from './project-router'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import { resolveTicketStoragePath, readStore, mutateStore } from './modules/specs/runtime/ticket-store'
import { trashPathFor } from './modules/specs/runtime/ticket-trash'
import { purgeProjectTrash } from './modules/specs/runtime/ticket-trash-service'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { DbInstance } from './db'

function makeContext(db: DbInstance, projectPath: string, extra: Partial<ProjectContext> = {}): ProjectContext {
  return {
    project: { id: 'proj-1', slug: 'proj', name: 'Test', path: projectPath, db_path: ':memory:', added_at: '', last_seen_at: '' },
    db,
    queueManager: {} as any,
    chatManager: { forgetSpecDraft: vi.fn(), forgetExploreLifecycle: vi.fn() } as any,
    setupManager: {} as any,
    proposalManager: {} as any,
    specLauncherManager: {} as any,
    ticketWatcher: { notifyDesktopWrite: vi.fn(), start: vi.fn(), close: vi.fn() } as any,
    broadcast: vi.fn(),
    ...extra,
  }
}

function createApp(ctx: ProjectContext) {
  const desktopDb = initDesktopDb(':memory:')
  const registry = {
    desktopDb,
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

describe('soft-deleted specs: HTTP surface', () => {
  let dir: string
  let ctx: ProjectContext
  let app: express.Express
  const base = '/api/projects/proj-1/tickets'

  async function makeTicket(title: string, extra: Record<string, unknown> = {}): Promise<number> {
    const res = await request(app).post(base).send({ title, ...extra })
    expect(res.status).toBe(201)
    return res.body.ticket.id
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-routes-'))
    ctx = makeContext(initDb(':memory:'), dir)
    app = createApp(ctx)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('DELETE hides the spec from the list, get and the store, and broadcasts ticket_deleted', async () => {
    const id = await makeTicket('Doomed')
    const del = await request(app).delete(`${base}/${id}`)
    expect(del.status).toBe(200)
    expect(del.body.restorable).toBe(true)
    expect((await request(app).get(base)).body.tickets.map((t: { id: number }) => t.id)).not.toContain(id)
    expect((await request(app).get(`${base}/${id}`)).status).toBe(404)
    expect((await request(app).get(`${base}?q=Doomed`)).body.tickets).toHaveLength(0)
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket_deleted', ticketId: id }))
    expect(readStore(resolveTicketStoragePath(dir)).tickets[String(id)]).toBeUndefined()
  })

  it('lists the deleted spec in the trash with its purge date, restores it, and the trash empties', async () => {
    const id = await makeTicket('Back soon', { labels: ['a'] })
    await request(app).delete(`${base}/${id}`)
    const trash = await request(app).get(`${base}/trash`)
    expect(trash.status).toBe(200)
    expect(trash.body.retentionDays).toBe(30)
    expect(trash.body.items).toHaveLength(1)
    expect(trash.body.items[0].ticket.title).toBe('Back soon')
    const gap = Date.parse(trash.body.items[0].purgeAt) - Date.parse(trash.body.items[0].deletedAt)
    expect(gap).toBe(30 * 24 * 3600 * 1000)

    const restore = await request(app).post(`${base}/${id}/restore`)
    expect(restore.status).toBe(200)
    expect(restore.body.alreadyLive).toBe(false)
    expect((await request(app).get(`${base}/${id}`)).body.ticket.labels).toEqual(['a'])
    expect((await request(app).get(`${base}/trash`)).body.items).toEqual([])
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket_created' }))
    // Restore is idempotent.
    const again = await request(app).post(`${base}/${id}/restore`)
    expect(again.status).toBe(200)
    expect(again.body.alreadyLive).toBe(true)
  })

  it('restore of an unknown spec is 404; DELETE of an unknown spec is 404; non numeric ids are 400', async () => {
    expect((await request(app).post(`${base}/999/restore`)).status).toBe(404)
    expect((await request(app).delete(`${base}/999`)).status).toBe(404)
    expect((await request(app).post(`${base}/abc/restore`)).status).toBe(400)
  })

  it('Delete permanently removes the entry for good and cannot be restored', async () => {
    const id = await makeTicket('Gone')
    await request(app).delete(`${base}/${id}`)
    expect((await request(app).delete(`${base}/trash/${id}`)).status).toBe(200)
    expect((await request(app).get(`${base}/trash`)).body.items).toEqual([])
    expect((await request(app).post(`${base}/${id}/restore`)).status).toBe(404)
    expect((await request(app).delete(`${base}/trash/${id}`)).status).toBe(404)
  })

  it('a deleted epic orphans its children and restore re-adopts them', async () => {
    const epic = await makeTicket('Epic')
    const child = await makeTicket('Child')
    mutateStore(resolveTicketStoragePath(dir), (s) => {
      s.tickets[String(epic)].is_epic = true
      s.tickets[String(child)].parent_epic_id = epic
    })
    await request(app).delete(`${base}/${epic}`)
    expect((await request(app).get(`${base}/${child}`)).body.ticket.parent_epic_id).toBeNull()
    await request(app).post(`${base}/${epic}/restore`)
    expect((await request(app).get(`${base}/${child}`)).body.ticket.parent_epic_id).toBe(epic)
  })

  it('purges specs deleted more than 30 days ago (and only those) when the trash is read', async () => {
    const old = await makeTicket('Old')
    const fresh = await makeTicket('Fresh')
    await request(app).delete(`${base}/${old}`)
    await request(app).delete(`${base}/${fresh}`)
    const trashFile = trashPathFor(resolveTicketStoragePath(dir))
    const data = JSON.parse(fs.readFileSync(trashFile, 'utf-8'))
    data.items[String(old)].deleted_at = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString()
    fs.writeFileSync(trashFile, JSON.stringify(data))
    const trash = await request(app).get(`${base}/trash`)
    expect(trash.body.items.map((i: { ticket: { id: number } }) => i.ticket.id)).toEqual([fresh])
    // Idempotent.
    const deps = {
      ticketStorePath: () => resolveTicketStoragePath(dir),
      db: ctx.db,
      deleteAttachments: vi.fn(async () => undefined),
    }
    expect(await purgeProjectTrash(deps)).toBe(0)
  })

  it('the Jira outbox is untouched by a delete followed by a restore', async () => {
    const id = await makeTicket('Linked')
    const onSpecEdited = vi.fn()
    ctx.jiraSyncManager = { onSpecEdited } as any
    await request(app).delete(`${base}/${id}`)
    await request(app).post(`${base}/${id}/restore`)
    expect(onSpecEdited).not.toHaveBeenCalled()
  })

  it('a label-only edit holds its Jira write past the undo window', async () => {
    const id = await makeTicket('Linked')
    const onSpecEdited = vi.fn()
    ctx.jiraSyncManager = { onSpecEdited } as any
    await request(app).patch(`${base}/${id}`).send({ labels: ['x'] })
    expect(onSpecEdited).toHaveBeenCalledWith(id, { labels: ['x'] }, { holdMs: 10_000 })
    await request(app).patch(`${base}/${id}`).send({ title: 'Renamed' })
    expect(onSpecEdited).toHaveBeenLastCalledWith(id, { title: 'Renamed' }, {})
  })
})
