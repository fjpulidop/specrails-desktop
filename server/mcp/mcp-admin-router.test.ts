import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb, type DbInstance } from '../desktop-db'
import type { ProjectRegistry } from '../project-registry'
import { McpServerManager } from './mcp-server'
import { createMcpAdminRouter } from './mcp-admin-router'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { BridgeEntry } from './connect/client-config'
import type { VerifyResult } from './connect/verify'

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
    expect(stale.status, JSON.stringify(stale.body)).toBe(404)
  })

  it('GET /config returns connection info for the panel', async () => {
    const res = await request(app).get('/api/mcp-admin/config')
    expect(res.body.httpUrl).toBe('http://127.0.0.1:4242/api/mcp')
    expect(res.body.bridgeCommand).toBe('specrails-mcp')
  })

  it('GET /status carries the spend threshold and the v2 flag; PATCH /preferences validates then writes both', async () => {
    const saved = process.env.SPECRAILS_MCP_V2
    delete process.env.SPECRAILS_MCP_V2
    try {
      const before = (await request(app).get('/api/mcp-admin/status')).body
      expect(before.confirmAboveUsd).toBe(0.5)
      expect(before.v2).toEqual({ enabled: false, forcedByEnv: false })
      const ok = await request(app).patch('/api/mcp-admin/preferences').send({ confirmAboveUsd: 2.555, v2: true })
      expect(ok.status).toBe(200)
      expect(ok.body).toMatchObject({ confirmAboveUsd: 2.56, v2: { enabled: true, forcedByEnv: false } })
      expect(manager.status().toolCount).toBe(15)
      for (const bad of [{ confirmAboveUsd: -1 }, { confirmAboveUsd: '1' }, { confirmAboveUsd: 5000 }, { v2: 'yes' }, { confirmAboveUsd: 1, v2: 'no' }]) {
        expect((await request(app).patch('/api/mcp-admin/preferences').send(bad)).status).toBe(400)
      }
      expect((await request(app).get('/api/mcp-admin/status')).body).toMatchObject({ confirmAboveUsd: 2.56, v2: { enabled: true } })
      process.env.SPECRAILS_MCP_V2 = 'false'
      expect((await request(app).get('/api/mcp-admin/status')).body.v2).toEqual({ enabled: false, forcedByEnv: true })
    } finally {
      if (saved === undefined) delete process.env.SPECRAILS_MCP_V2
      else process.env.SPECRAILS_MCP_V2 = saved
    }
  })
})

describe('MCP admin connect routes (temp home)', () => {
  const ENTRY: BridgeEntry = { command: '/opt/specrails/node', args: ['/opt/specrails/binaries/specrails-mcp.js'], env: { SPECRAILS_MCP_PORT: '4242' } }
  let db: DbInstance
  let manager: McpServerManager
  let home: string
  let verified: BridgeEntry[]
  let entry: BridgeEntry | null

  function appWith(): express.Express {
    const app = express()
    app.use(express.json())
    app.use('/api/mcp-admin', createMcpAdminRouter({
      manager, desktopDb: db, desktopPort: 4242, broadcast: () => {},
      connect: {
        env: () => ({ home, env: { PATH: path.join(home, 'bin') }, platform: 'linux' }),
        entry: () => entry,
        verify: async (e): Promise<VerifyResult> => { verified.push(e); return { ok: true, toolCount: 15, approxTokens: 6000, ms: 5 } },
      },
    }))
    return app
  }

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    manager = new McpServerManager({ registry: makeRegistry(db), broadcast: () => {}, desktopPort: 4242 })
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-admin-connect-')))
    verified = []
    entry = ENTRY
  })
  afterEach(async () => { await manager.stop(); db.close(); fs.rmSync(home, { recursive: true, force: true }) })

  it('GET /connect lists both clients with state and the exact command', async () => {
    fs.mkdirSync(path.join(home, '.codex'))
    const res = await request(appWith()).get('/api/mcp-admin/connect')
    expect(res.body.available).toBe(true)
    expect(res.body.entry).toEqual(ENTRY)
    const [claude, codex] = res.body.clients
    expect(claude).toMatchObject({ client: 'claude', installed: false, state: 'not_connected' })
    expect(codex).toMatchObject({ client: 'codex', installed: true, configPath: path.join(home, '.codex', 'config.toml') })
    expect(codex.command).toBe('codex mcp add specrails --env SPECRAILS_MCP_PORT=4242 -- /opt/specrails/node /opt/specrails/binaries/specrails-mcp.js')
    expect(JSON.stringify(res.body)).not.toMatch(/token/i)
  })

  it('POST /connect writes, verifies, is idempotent and removes', async () => {
    const app = appWith()
    const first = await request(app).post('/api/mcp-admin/connect').send({ client: 'codex' })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ outcome: 'create', written: true, verify: { ok: true, toolCount: 15 }, mcpEnabled: true })
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toContain('tool_timeout_sec = 90')
    expect(verified).toEqual([ENTRY])
    expect((await request(app).post('/api/mcp-admin/connect').send({ client: 'codex' })).body.outcome).toBe('unchanged')
    const dry = await request(app).post('/api/mcp-admin/connect').send({ client: 'claude', dryRun: true })
    expect(dry.body).toMatchObject({ outcome: 'create', written: false })
    expect(dry.body.verify).toBeUndefined()
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false)
    const removed = await request(app).post('/api/mcp-admin/connect').send({ client: 'codex', remove: true })
    expect(removed.body).toMatchObject({ outcome: 'remove', written: true })
    expect(verified).toHaveLength(2)
  })

  it('answers conflicts with 409 and bad input with 400', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { specrails: { command: 'npx', args: ['other'] } } }))
    const app = appWith()
    const conflict = await request(app).post('/api/mcp-admin/connect').send({ client: 'claude' })
    expect(conflict.status).toBe(409)
    expect(conflict.body).toMatchObject({ code: 'conflict', reason: 'foreign_entry' })
    expect((await request(app).post('/api/mcp-admin/connect').send({ client: 'claude', force: true })).body.outcome).toBe('update')
    expect((await request(app).post('/api/mcp-admin/connect').send({ client: 'cursor' })).status).toBe(400)
    expect((await request(app).post('/api/mcp-admin/connect').send({ client: 'codex', dryRun: 'yes' })).status).toBe(400)
    expect((await request(app).post('/api/mcp-admin/connect').send({ client: 'codex', scope: 'project', projectDir: 'rel' })).status).toBe(400)
    entry = null
    expect((await request(app).post('/api/mcp-admin/connect').send({ client: 'codex' })).status).toBe(503)
  })

  it('skips the verify step while MCP is off', async () => {
    await manager.setEnabled(false)
    const res = await request(appWith()).post('/api/mcp-admin/connect').send({ client: 'codex' })
    expect(res.body).toMatchObject({ written: true, mcpEnabled: false })
    expect(res.body.verify).toBeUndefined()
  })
})
