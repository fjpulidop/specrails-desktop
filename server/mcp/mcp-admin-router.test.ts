import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb, type DbInstance } from '../desktop-db'
import type { ProjectRegistry } from '../project-registry'
import { McpServerManager } from './mcp-server'
import { createMcpAdminRouter } from './mcp-admin-router'

function makeRegistry(db: DbInstance): ProjectRegistry {
  return { desktopDb: db, listContexts: () => [], getContext: () => undefined, getContextByPath: () => undefined, removeProject: () => undefined } as unknown as ProjectRegistry
}

describe('createMcpAdminRouter', () => {
  let db: DbInstance
  let app: express.Express
  let manager: McpServerManager

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    manager = new McpServerManager({ registry: makeRegistry(db), broadcast: () => {}, desktopPort: 4242 })
    app = express()
    app.use(express.json())
    app.use('/api/mcp-admin', createMcpAdminRouter({ manager, desktopDb: db, desktopPort: 4242, broadcast: () => {} }))
    app.use('/api/mcp', (req, res) => { void manager.handleHttp(req, res) })
  })

  afterEach(async () => { await manager.stop(); db.close() })

  it('GET /status reports enabled-by-default with every tier on + token hint', async () => {
    const res = await request(app).get('/api/mcp-admin/status')
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(true)
    expect(res.body.tiers).toEqual({ write: true, aiSpawn: true, destructive: true })
    expect(res.body.tokenHint).toMatch(/^…/)
    expect(res.body.toolCount).toBeGreaterThan(4)
  })

  it('POST /disable and /enable toggle the flag', async () => {
    expect((await request(app).post('/api/mcp-admin/disable')).body.enabled).toBe(false)
    expect((await request(app).post('/api/mcp-admin/enable')).body.enabled).toBe(true)
  })

  it('PATCH /tiers updates tiers and validates booleans', async () => {
    const ok = await request(app).patch('/api/mcp-admin/tiers').send({ write: false, destructive: false })
    expect(ok.body.tiers).toEqual({ write: false, aiSpawn: true, destructive: false })
    const back = await request(app).patch('/api/mcp-admin/tiers').send({ write: true })
    expect(back.body.tiers).toEqual({ write: true, aiSpawn: true, destructive: false })
    const bad = await request(app).patch('/api/mcp-admin/tiers').send({ write: 'yes' })
    expect(bad.status).toBe(400)
  })

  it('GET /token returns the token; regenerate changes it', async () => {
    const t1 = (await request(app).get('/api/mcp-admin/token')).body.token
    expect(t1.length).toBeGreaterThanOrEqual(32)
    const t2 = (await request(app).post('/api/mcp-admin/regenerate-token')).body.token
    expect(t2).not.toBe(t1)
    expect((await request(app).get('/api/mcp-admin/token')).body.token).toBe(t2)
  })

  it('rejects a malformed tier patch without partially updating valid earlier fields', async () => {
    const bad = await request(app).patch('/api/mcp-admin/tiers').send({ write: false, aiSpawn: false, destructive: 'invalid' })
    expect(bad.status).toBe(400)
    expect((await request(app).get('/api/mcp-admin/status')).body.tiers).toEqual({ write: true, aiSpawn: true, destructive: true })
  })

  it('token rotation invalidates already-established transport sessions', async () => {
    const initialized = await request(app).post('/api/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old-credential', version: '1' } } })
    expect(initialized.status).toBe(200)
    expect(manager.status().activeSessions).toBe(1)
    expect((await request(app).post('/api/mcp-admin/regenerate-token')).status).toBe(200)
    expect(manager.status().activeSessions).toBe(0)
    const stale = await request(app).delete('/api/mcp').set('mcp-session-id', initialized.headers['mcp-session-id'])
    expect(stale.status).toBe(404)
  })

  it('GET /config returns connection info for the panel', async () => {
    const res = await request(app).get('/api/mcp-admin/config')
    expect(res.body.httpUrl).toBe('http://127.0.0.1:4242/api/mcp')
    expect(res.body.bridgeCommand).toBe('specrails-mcp')
  })
})
