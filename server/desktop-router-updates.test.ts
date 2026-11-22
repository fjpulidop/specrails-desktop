import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb } from './desktop-db'
import type { DbInstance } from './db'
import { DESKTOP_UPDATE_COMMAND, RENDERER_TTL_MS, createDesktopUpdates, registerDesktopUpdateRoutes } from './desktop-router-updates'

// The update servers are never contacted: the manifest fetch is injected.

let db: DbInstance
let broadcast: ReturnType<typeof vi.fn>
let clock = 1_000_000
const manifest = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

function app(fetchImpl: typeof fetch) {
  const router = express.Router()
  const updates = registerDesktopUpdateRoutes(router, { desktopDb: db, broadcast, fetchImpl, currentVersion: () => '3.5.0', now: () => clock })
  const server = express()
  server.use(express.json())
  server.use('/api', router)
  return { server, updates }
}

beforeEach(() => {
  db = initDesktopDb(':memory:')
  broadcast = vi.fn()
  clock = 1_000_000
})

describe('desktop update shim', () => {
  it('checks the channel manifest and reports a newer version', async () => {
    const fetchImpl = manifest({ version: 'v3.6.0', pub_date: '2026-11-01', notes: 'Faster' })
    const { server } = app(fetchImpl as unknown as typeof fetch)
    const res = await request(server).post('/api/desktop-updates/check')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ currentVersion: '3.5.0', channel: 'latest', available: true, latest: { version: '3.6.0', notes: 'Faster' }, checkError: null })
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('/releases/latest/download/latest.json')
  })

  it('keeps the error when the manifest cannot be read', async () => {
    const { server } = app(manifest({}, 404) as unknown as typeof fetch)
    const res = await request(server).post('/api/desktop-updates/check')
    expect(res.body.available).toBe(false)
    expect(res.body.checkError).toContain('404')
  })

  it('relays an install only to a present window, for the known version', async () => {
    const { server } = app(manifest({ version: '3.6.0' }) as unknown as typeof fetch)
    expect((await request(server).post('/api/desktop-updates/apply').send({})).body.error).toBe('no_update')
    await request(server).post('/api/desktop-updates/check')
    expect((await request(server).post('/api/desktop-updates/apply').send({})).body.error).toBe('no_window')
    await request(server).post('/api/desktop-updates/report').send({ phase: 'idle' })
    expect((await request(server).post('/api/desktop-updates/apply').send({ version: '3.5.9' })).body.error).toBe('version_changed')
    const ok = await request(server).post('/api/desktop-updates/apply').send({ version: '3.6.0', restart: 'now' })
    expect(ok.status).toBe(202)
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: DESKTOP_UPDATE_COMMAND, op: 'apply', version: '3.6.0', restart: 'now', requestId: ok.body.requestId }))
  })

  it('forgets a window that stopped reporting and refuses a second install', async () => {
    const { server } = app(manifest({ version: '3.6.0' }) as unknown as typeof fetch)
    await request(server).post('/api/desktop-updates/check')
    await request(server).post('/api/desktop-updates/report').send({ phase: 'downloading', progress: 140 })
    const status = await request(server).get('/api/desktop-updates/status')
    expect(status.body.window).toMatchObject({ connected: true, phase: 'downloading', progress: 100 })
    expect((await request(server).post('/api/desktop-updates/apply').send({})).body.error).toBe('in_progress')
    clock += RENDERER_TTL_MS + 1
    expect((await request(server).get('/api/desktop-updates/status')).body.window.connected).toBe(false)
  })

  it('ignores unknown phases', () => {
    const updates = createDesktopUpdates({ desktopDb: db, broadcast, currentVersion: () => '1.0.0', now: () => clock })
    expect(updates.report({ phase: 'hacked', error: 'x'.repeat(900) }).window).toMatchObject({ phase: 'idle' })
    expect(updates.status().window.error).toHaveLength(500)
  })
})
