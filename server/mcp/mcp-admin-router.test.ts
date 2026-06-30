import { describe, it, expect, beforeEach } from 'vitest'
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

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    const manager = new McpServerManager({ registry: makeRegistry(db), broadcast: () => {}, desktopPort: 4242 })
    app = express()
    app.use(express.json())
    app.use('/api/mcp-admin', createMcpAdminRouter({ manager, desktopDb: db, desktopPort: 4242, broadcast: () => {} }))
  })

  it('GET /status reports disabled with tiers + token hint', async () => {
    const res = await request(app).get('/api/mcp-admin/status')
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(false)
    expect(res.body.tiers).toEqual({ write: false, aiSpawn: false, destructive: false })
    expect(res.body.tokenHint).toMatch(/^…/)
    expect(res.body.toolCount).toBeGreaterThan(4)
  })

  it('POST /enable and /disable toggle the flag', async () => {
    expect((await request(app).post('/api/mcp-admin/enable')).body.enabled).toBe(true)
    expect((await request(app).post('/api/mcp-admin/disable')).body.enabled).toBe(false)
  })

  it('PATCH /tiers updates tiers and validates booleans', async () => {
    const ok = await request(app).patch('/api/mcp-admin/tiers').send({ write: true, destructive: true })
    expect(ok.body.tiers).toEqual({ write: true, aiSpawn: false, destructive: true })
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

  it('GET /config returns connection info for the panel', async () => {
    const res = await request(app).get('/api/mcp-admin/config')
    expect(res.body.httpUrl).toBe('http://127.0.0.1:4242/api/mcp')
    expect(res.body.bridgeCommand).toBe('specrails-mcp')
  })
})
