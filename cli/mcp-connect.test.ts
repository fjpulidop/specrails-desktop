import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { handleMcp, parseMcpArgs, describeConnect } from './mcp-connect'
import { parseArgs } from './args'
import { initDesktopDb, type DbInstance } from '../server/desktop-db'
import { McpServerManager } from '../server/mcp/mcp-server'
import { createMcpAdminRouter } from '../server/mcp/mcp-admin-router'
import type { ProjectRegistry } from '../server/project-registry'

const ENTRY = { command: '/opt/sr/node', args: ['/opt/sr/binaries/specrails-mcp.js'], env: { SPECRAILS_MCP_PORT: '4200' } }

describe('parseMcpArgs', () => {
  it('routes `mcp` from the top-level parser', () => {
    expect(parseArgs(['mcp', 'connect', '--client', 'codex', '--port', '4300'])).toEqual({ mode: 'mcp', subArgs: ['connect', '--client', 'codex'], port: 4300 })
  })

  it('parses clients, scope and flags', () => {
    expect(parseMcpArgs(['connect', '--client', 'claude,codex', '--scope=project', '--dry-run', '--no-verify', '--json'])).toEqual({
      sub: 'connect', clients: ['claude', 'codex'], scope: 'project', dryRun: true, force: false, verify: false, json: true,
    })
    expect(parseMcpArgs(['connect', '--client', 'all', '--remove']).sub).toBe('disconnect')
    expect(parseMcpArgs([]).sub).toBe('help')
    expect(parseMcpArgs(['status']).clients).toBeNull()
  })

  it('rejects bad input with a usage message', () => {
    expect(() => parseMcpArgs(['connect'])).toThrow(/Choose a client/)
    expect(() => parseMcpArgs(['connect', '--client', 'cursor'])).toThrow(/Unknown client/)
    expect(() => parseMcpArgs(['connect', '--client'])).toThrow(/needs a value/)
    expect(() => parseMcpArgs(['connect', '--client', 'codex', '--scope', 'global'])).toThrow(/scope/)
    expect(() => parseMcpArgs(['link'])).toThrow(/Unknown mcp command/)
    expect(() => parseMcpArgs(['connect', '--client', 'codex', '--yes'])).toThrow(/Unknown option/)
  })
})

describe('describeConnect', () => {
  it('says what changed, the verification and the next step', () => {
    const lines = describeConnect({
      client: 'codex', scope: 'user', file: '/h/.codex/config.toml', outcome: 'create', written: true, backup: '/h/.codex/config.toml.bak', dryRun: false, command: '',
      verify: { ok: true, toolCount: 15, approxTokens: 5981, overview: '2 things need you.' },
    }, false).join('\n')
    expect(lines).toContain('connected — added "specrails" to /h/.codex/config.toml')
    expect(lines).toContain('backup: /h/.codex/config.toml.bak')
    expect(lines).toContain('verified: 15 tools · ≈6.0k tokens · 2 things need you.')
    expect(lines).toContain('Start a new Codex session')
    expect(describeConnect({ client: 'claude', scope: 'user', file: 'f', outcome: 'create', written: false, backup: null, dryRun: true, command: '' }, false).join('\n')).toContain('dry run')
  })
})

describe('handleMcp against a running app (temp home)', () => {
  let db: DbInstance
  let manager: McpServerManager
  let server: Server
  let port: number
  let home: string
  let out: string[]
  let err: string[]

  beforeEach(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-cli-connect-')))
    fs.mkdirSync(path.join(home, '.codex'))
    db = initDesktopDb(':memory:')
    const registry = { desktopDb: db, listContexts: () => [], getContext: () => undefined } as unknown as ProjectRegistry
    manager = new McpServerManager({ registry, broadcast: () => {}, desktopPort: 4200 })
    const app = express()
    app.use(express.json())
    app.get('/api/health', (_req, res) => { res.json({ ok: true }) })
    app.use('/api/mcp-admin', createMcpAdminRouter({
      manager, desktopDb: db, desktopPort: 4200, broadcast: () => {},
      connect: {
        env: () => ({ home, env: { PATH: '' }, platform: 'linux' }),
        entry: () => ENTRY,
        verify: async () => ({ ok: true, toolCount: 15, approxTokens: 5981, ms: 3 }),
      },
    }))
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    port = (server.address() as AddressInfo).port
    out = []
    err = []
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    await manager.stop()
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  const run = (...argv: string[]) => handleMcp(argv, port, { out: (l) => out.push(l), err: (l) => err.push(l), cwd: home })

  it('connects Codex with the timeout, verifies and is idempotent', async () => {
    expect(await run('connect', '--client', 'codex')).toBe(0)
    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain('[mcp_servers.specrails]')
    expect(toml).toContain('tool_timeout_sec = 90')
    expect(toml).not.toMatch(/token/i)
    expect(out.join('\n')).toContain('verified: 15 tools')
    out = []
    expect(await run('connect', '--client', 'codex')).toBe(0)
    expect(out.join('\n')).toContain('already connected')
  })

  it('--client all connects only detected clients; status and disconnect follow', async () => {
    expect(await run('connect', '--client', 'all')).toBe(0)
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false)
    out = []
    expect(await run('status')).toBe(0)
    expect(out.join('\n')).toMatch(/Codex.*connected/)
    expect(out.join('\n')).toMatch(/Claude Code.*not installed/)
    expect(await run('disconnect', '--client', 'codex')).toBe(0)
    expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).not.toContain('specrails')
  })

  it('dry-run writes nothing; project scope uses the cwd; --json prints the result', async () => {
    expect(await run('connect', '--client', 'claude', '--dry-run', '--json')).toBe(0)
    expect(JSON.parse(out.join('\n'))).toMatchObject({ outcome: 'create', written: false, dryRun: true })
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false)
    expect(await run('connect', '--client', 'claude', '--scope', 'project')).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(home, '.mcp.json'), 'utf8')).mcpServers.specrails.args).toEqual(ENTRY.args)
  })

  it('reports conflicts, usage errors and a stopped app with exit codes', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{ broken')
    expect(await run('connect', '--client', 'claude')).toBe(1)
    expect(err.join('\n')).toMatch(/not valid/)
    expect(await run('connect')).toBe(2)
    await new Promise((resolve) => server.close(resolve))
    server = await new Promise<Server>((resolve) => { const s = express().listen(0, '127.0.0.1', () => resolve(s)) })
    err = []
    expect(await handleMcp(['status'], 1, { out: () => {}, err: (l) => err.push(l) })).toBe(1)
    expect(err.join('\n')).toMatch(/not running/)
  })
})
