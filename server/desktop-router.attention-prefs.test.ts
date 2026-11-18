import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createDesktopRouter } from './desktop-router'
import { getDesktopSetting, initDesktopDb } from './desktop-db'
import type { DbInstance } from './db'
import type { ProjectRegistry } from './project-registry'

describe('GET/PATCH /api/attention-prefs', () => {
  let desktopDb: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let app: express.Express

  beforeEach(() => {
    desktopDb = initDesktopDb(':memory:')
    const registry = { desktopDb, listContexts: vi.fn(() => []), getContext: vi.fn(), getProjectRow: vi.fn() } as unknown as ProjectRegistry
    broadcast = vi.fn()
    app = express(); app.use(express.json()); app.use('/api', createDesktopRouter(registry, broadcast))
  })

  it('answers the defaults when nothing was saved', async () => {
    const res = await request(app).get('/api/attention-prefs')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      enabled: true,
      categories: { question: true, review: true, failed: true, budget: true, done: true },
      sound: false,
      dockBadge: true,
      mutedProjects: [],
    })
  })

  it('PATCH merges, persists in desktop_settings and broadcasts the whole record', async () => {
    const res = await request(app).patch('/api/attention-prefs').send({ sound: true, categories: { done: false }, mutedProjects: ['p1'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ enabled: true, sound: true, mutedProjects: ['p1'], categories: { done: false, review: true } })
    expect(JSON.parse(getDesktopSetting(desktopDb, 'attention_notifications')!)).toEqual(res.body)
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'desktop.attention_prefs', prefs: res.body }))

    const again = await request(app).patch('/api/attention-prefs').send({ categories: { review: false } })
    expect(again.body.categories).toMatchObject({ done: false, review: false })
    expect(again.body.sound).toBe(true)
    expect((await request(app).get('/api/attention-prefs')).body).toEqual(again.body)
  })

  it('rejects an invalid body with 400 and applies nothing', async () => {
    const res = await request(app).patch('/api/attention-prefs').send({ sound: true, categories: { done: 'no' } })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: 'validation_failed', field: 'categories.done' })
    expect(getDesktopSetting(desktopDb, 'attention_notifications')).toBeUndefined()
    expect(broadcast).not.toHaveBeenCalled()
  })
})
