import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from './db'
import { createPluginsRouter } from './plugins-router'
import { PluginManager } from './plugin-manager'
import { setPluginManagerForTesting } from './plugins/manager'
import type { ProjectContext } from './project-registry'
import type { Plugin } from './types'

let projectPath: string
let db: DbInstance
let app: express.Express
let broadcasts: Array<{ type: string }>

function makePlugin(): Plugin {
  return {
    manifest: {
      name: 'serena',
      version: '1.0.0',
      description: 'semantic',
      whatItDoes: ['x'],
      requirements: [{ name: 'uv', minVersion: '0.1.0' }],
      owns: { mcpServers: ['serena'] },
      providerSupport: {
        claude: { mcpEntry: { command: 'uvx', args: [] } },
        kimi: { mcpEntry: { command: 'uvx', args: [] } },
      },
    },
    install: async (ctx) => {
      await PluginManager.mergeMcpServers(
        ctx.projectPath,
        { serena: { command: 'uvx' } },
        ctx.providerId,
      )
    },
    uninstall: async (ctx) => {
      await PluginManager.removeMcpServers(ctx.projectPath, ['serena'], ctx.providerId)
    },
    verify: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
  }
}

function mountApp(plugins: Plugin[] = [makePlugin()]): void {
  setPluginManagerForTesting(new PluginManager(plugins))
  broadcasts = []
  app = express()
  app.use(express.json())
  const ctx: ProjectContext = {
    project: {
      id: 'proj-test',
      slug: 'proj-test',
      name: 'Test',
      path: projectPath,
      provider: 'claude',
      providers: ['claude', 'kimi'],
      last_active: null,
      setup_session: null,
      agent_job_id: null,
    } as never,
    db,
    queueManager: {} as never,
    chatManager: {} as never,
    setupManager: {} as never,
    proposalManager: {} as never,
    agentRefineManager: {} as never,
    specLauncherManager: {} as never,
    ticketWatcher: {} as never,
    broadcast: ((m: { type: string }) => { broadcasts.push(m) }) as never,
    railJobs: new Map(),
  }
  app.use('/api/projects/:projectId/plugins', (req, _res, next) => {
    ;(req as never as { projectCtx: ProjectContext }).projectCtx = ctx
    next()
  }, createPluginsRouter())
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-router-'))
  db = initDb(':memory:')
  mountApp()
})

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
  setPluginManagerForTesting(null)
})

describe('GET /plugins', () => {
  it('returns catalog with not-installed status', async () => {
    const res = await request(app).get('/api/projects/proj-test/plugins')
    expect(res.status).toBe(200)
    expect(res.body.plugins).toHaveLength(1)
    expect(res.body.plugins[0].status).toBe('not-installed')
  })

  it('projects catalog state independently for a configured secondary provider', async () => {
    await request(app)
      .post('/api/projects/proj-test/plugins/serena/install')
      .send({ provider: 'kimi' })

    const kimi = await request(app)
      .get('/api/projects/proj-test/plugins?provider=kimi')
    const claude = await request(app)
      .get('/api/projects/proj-test/plugins?provider=claude')

    expect(kimi.status).toBe(200)
    expect(kimi.body.plugins[0]).toMatchObject({
      providerId: 'kimi',
      status: 'installed',
    })
    expect(claude.body.plugins[0]).toMatchObject({
      providerId: 'claude',
      status: 'not-installed',
    })
  })

  it('rejects a provider not configured for the project', async () => {
    const res = await request(app).get('/api/projects/proj-test/plugins?provider=codex')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not configured/)
  })
})

describe('GET /plugins/:name/preview-install', () => {
  it('returns diff without mutating project', async () => {
    const res = await request(app).get('/api/projects/proj-test/plugins/serena/preview-install')
    expect(res.status).toBe(200)
    expect(res.body.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.mcp.json', op: 'create' }),
    ]))
    expect(fs.existsSync(path.join(projectPath, '.mcp.json'))).toBe(false)
  })

  it('returns 404 for unknown plugin', async () => {
    const res = await request(app).get('/api/projects/proj-test/plugins/nope/preview-install')
    expect(res.status).toBe(404)
  })

  it('previews Kimi files in its native project config', async () => {
    const res = await request(app)
      .get('/api/projects/proj-test/plugins/serena/preview-install?provider=kimi')
    expect(res.status).toBe(200)
    expect(res.body.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.kimi-code/mcp.json', op: 'create' }),
    ]))
  })
})

describe('POST /plugins/:name/install', () => {
  it('installs and emits plugin.installed', async () => {
    const res = await request(app).post('/api/projects/proj-test/plugins/serena/install')
    expect(res.status).toBe(200)
    expect(broadcasts.some((b) => b.type === 'plugin.installed')).toBe(true)
  })

  it('returns 404 for unknown plugin', async () => {
    const res = await request(app).post('/api/projects/proj-test/plugins/nope/install')
    expect(res.status).toBe(404)
  })

  it('returns 409 on second install', async () => {
    await request(app).post('/api/projects/proj-test/plugins/serena/install')
    const res = await request(app).post('/api/projects/proj-test/plugins/serena/install')
    expect(res.status).toBe(409)
  })

  it('installs Kimi without writing Claude .mcp.json', async () => {
    const res = await request(app)
      .post('/api/projects/proj-test/plugins/serena/install')
      .send({ provider: 'kimi' })

    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(projectPath, '.mcp.json'))).toBe(false)
    const config = JSON.parse(
      fs.readFileSync(path.join(projectPath, '.kimi-code', 'mcp.json'), 'utf8'),
    )
    expect(config.mcpServers.serena.command).toBe('uvx')
    expect(
      broadcasts.some((event) =>
        event.type === 'plugin.installed' &&
        (event as { providerId?: string }).providerId === 'kimi'),
    ).toBe(true)
  })
})

describe('DELETE /plugins/:name', () => {
  it('uninstalls', async () => {
    await request(app).post('/api/projects/proj-test/plugins/serena/install')
    const res = await request(app).delete('/api/projects/proj-test/plugins/serena')
    expect(res.status).toBe(200)
    expect(broadcasts.some((b) => b.type === 'plugin.uninstalled')).toBe(true)
  })

  it('returns 404 when not installed', async () => {
    const res = await request(app).delete('/api/projects/proj-test/plugins/serena')
    expect(res.status).toBe(404)
  })
})

describe('GET /plugins/:name/health', () => {
  it('reports ok for healthy plugin', async () => {
    await request(app).post('/api/projects/proj-test/plugins/serena/install')
    const res = await request(app).get('/api/projects/proj-test/plugins/serena/health')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('returns 404 for unknown plugin', async () => {
    const res = await request(app).get('/api/projects/proj-test/plugins/nope/health')
    expect(res.status).toBe(404)
  })
})

describe('POST /plugins/_prerequisites/:prereq/install', () => {
  beforeEach(() => { process.env.SPECRAILS_PREREQ_NOOP = '1' })
  afterEach(() => { delete process.env.SPECRAILS_PREREQ_NOOP })

  it('rejects unknown prerequisite with 404', async () => {
    const res = await request(app).post('/api/projects/proj-test/plugins/_prerequisites/wat/install')
    expect(res.status).toBe(404)
  })

  it('acks 202 and emits prereq_installed via broadcast', async () => {
    const res = await request(app).post('/api/projects/proj-test/plugins/_prerequisites/uv/install')
    expect(res.status).toBe(202)
    expect(res.body.ok).toBe(true)
    // Wait microtasks so the async install completes and emits.
    await new Promise((r) => setTimeout(r, 20))
    expect(broadcasts.some((b) => b.type === 'plugin.prereq_installed')).toBe(true)
  })
})

describe('feature gate', () => {
  it('returns 404 when SPECRAILS_PLUGINS_SECTION=false', async () => {
    process.env.SPECRAILS_PLUGINS_SECTION = 'false'
    try {
      const res = await request(app).get('/api/projects/proj-test/plugins')
      expect(res.status).toBe(404)
    } finally {
      delete process.env.SPECRAILS_PLUGINS_SECTION
    }
  })
})
