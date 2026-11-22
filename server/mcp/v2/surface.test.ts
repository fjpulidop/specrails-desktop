import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../auth', () => ({ loadOrGenerateToken: () => 'v2-surface-test-token-no-filesystem-access' }))
import express from 'express'
import http from 'http'
import type { AddressInfo } from 'net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { addProject, getProject, initDesktopDb, listProjects, setDesktopSetting } from '../../desktop-db'
import type { DbInstance } from '../../db'
import type { ProjectRegistry } from '../../project-registry'
import { McpServerManager } from '../mcp-server'
import { buildToolSpecs } from '../tools/catalog'
import { createHarness, call } from './__fixtures__/harness'
import { MCP_V2_KEY, isMcpV2Enabled, registerV2Surface, V2_INSTRUCTIONS, v2Catalog } from './index'

// The `mcp_v2` flag: off (default) serves exactly the v1 catalog; on serves the
// 15 v2 tools, the instructions, and every v1 tool as a hidden alias.

const V1_NAMES = buildToolSpecs().map((spec) => spec.name)
const V2_NAMES = v2Catalog().tools.map((tool) => tool.name)

describe('mcp_v2 flag', () => {
  it('is off by default; the setting or SPECRAILS_MCP_V2 turns it on, the env var wins', () => {
    const db = initDesktopDb(':memory:')
    expect(isMcpV2Enabled(db, {})).toBe(false)
    setDesktopSetting(db, MCP_V2_KEY, 'true')
    expect(isMcpV2Enabled(db, {})).toBe(true)
    expect(isMcpV2Enabled(db, { SPECRAILS_MCP_V2: 'false' })).toBe(false)
    expect(isMcpV2Enabled(initDesktopDb(':memory:'), { SPECRAILS_MCP_V2: 'true' })).toBe(true)
  })
})

describe('McpServerManager with and without v2', () => {
  let db: DbInstance
  let manager: McpServerManager
  let server: http.Server
  let url: URL
  let client: Client | null = null

  beforeEach(async () => {
    vi.stubEnv('SPECRAILS_MCP_V2', '')
    db = initDesktopDb(':memory:')
    addProject(db, { id: 'p1', slug: 'shop-api', name: 'Shop API', path: '/tmp/v2-surface-shop' })
    const registry = { desktopDb: db, listContexts: () => [], listProjects: () => listProjects(db), getProjectRow: (id: string) => getProject(db, id), getContext: () => undefined } as unknown as ProjectRegistry
    // An executed call reaches the app API on desktopPort: point it at this test's own server (it serves only /api/mcp).
    manager = new McpServerManager({ registry, broadcast: () => {}, desktopPort: 0 })
    const app = express()
    app.use('/api/mcp', express.json({ limit: '4mb' }), (req, res) => { void manager.handleHttp(req, res) })
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`)
    ;(manager as unknown as { _ctx: { desktopPort: number } })._ctx.desktopPort = (server.address() as AddressInfo).port
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await client?.close()
    client = null
    await manager.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const connect = async () => {
    client = new Client({ name: 'v2-surface', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(url))
    return client
  }

  it('flag off: the v1 catalog exactly, no instructions', async () => {
    const c = await connect()
    expect((await c.listTools()).tools.map((tool) => tool.name)).toEqual(V1_NAMES)
    expect(c.getInstructions()).toBeUndefined()
    expect(manager.status().toolCount).toBe(V1_NAMES.length)
    const status = (await c.callTool({ name: 'specrails_guide', arguments: {} })) as { structuredContent?: Record<string, unknown> }
    expect(status.structuredContent?.warnings).toBeUndefined()
  })

  it('flag on: 15 v2 tools and the instructions; v1 tools stay callable, hidden and deprecated', async () => {
    setDesktopSetting(db, MCP_V2_KEY, 'true')
    const c = await connect()
    expect((await c.listTools()).tools.map((tool) => tool.name)).toEqual(V2_NAMES)
    expect(c.getInstructions()).toBe(V2_INSTRUCTIONS)
    expect(manager.status().toolCount).toBe(15)

    const guide = await c.callTool({ name: 'specrails_guide', arguments: {} }) as { structuredContent: Record<string, unknown> }
    expect(guide.structuredContent).toMatchObject({ ok: true, warnings: ['deprecated: use specrails_system(help)'] })

    const select = await c.callTool({ name: 'specrails_select_project', arguments: { projectId: 'p1' } }) as { structuredContent: Record<string, unknown> }
    expect(select.structuredContent).toMatchObject({ ok: true, warnings: ['deprecated: use specrails_projects(select)'] })

    // A v1 action v2 does not define (`specrails_specs(board)`) runs its v1 handler through the v2 tool of the same name.
    const board = await c.callTool({ name: 'specrails_specs', arguments: { action: 'board', projectId: 'p1' } }) as { structuredContent: Record<string, any> }
    // (The harness loads no project database, so the v1 handler answers its own v1 error.)
    expect(board.structuredContent).toMatchObject({ warnings: ['deprecated: use specrails_overview(project)'] })
    expect(board.structuredContent.v).toBeUndefined()
    expect(board.structuredContent.error?.code).not.toBe('invalid_input')

  })

  it('a confirmation survives a reconnect of the same client (headless resume), never another client', async () => {
    setDesktopSetting(db, MCP_V2_KEY, 'true')
    const open = async (name: string) => {
      const c = new Client({ name, version: '1' })
      await c.connect(new StreamableHTTPClientTransport(url))
      return c
    }
    const unregister = { action: 'unregister', project: 'shop-api' }
    const turn1 = await open('claude-code')
    const preview = await turn1.callTool({ name: 'specrails_projects', arguments: unregister }) as { structuredContent: Record<string, any> }
    expect(preview.structuredContent.error.code).toBe('confirmation_required')
    const token = preview.structuredContent.error.confirmToken as string
    await turn1.close()

    // Another client cannot use it.
    const other = await open('codex-mcp-client')
    const refused = await other.callTool({ name: 'specrails_projects', arguments: { ...unregister, confirm: token } }) as { structuredContent: Record<string, any> }
    expect(refused.structuredContent.error).toMatchObject({ code: 'confirmation_required', reason: 'mismatch' })
    await other.close()

    // The same client's next connection (the person said yes) gets past the confirmation; the call itself
    // then reaches the app API (this test's own server, which answers 404).
    client = await open('claude-code')
    const confirmed = await client.callTool({ name: 'specrails_projects', arguments: { ...unregister, confirm: token } }) as { structuredContent: Record<string, any> }
    expect(confirmed.structuredContent.error?.code).not.toBe('confirmation_required')
    expect(confirmed.structuredContent.error?.reason).toBeUndefined()
  })

  it('a truncated confirm token is reported as incomplete, not as another session', async () => {
    setDesktopSetting(db, MCP_V2_KEY, 'true')
    const c = await connect()
    const unregister = { action: 'unregister', project: 'shop-api' }
    const preview = await c.callTool({ name: 'specrails_projects', arguments: unregister }) as { structuredContent: Record<string, any> }
    const cut = String(preview.structuredContent.error.confirmToken).split('.').slice(0, 4).join('.')
    const result = await c.callTool({ name: 'specrails_projects', arguments: { ...unregister, confirm: cut } }) as { structuredContent: Record<string, any> }
    expect(result.structuredContent.error).toMatchObject({ code: 'confirmation_required', reason: 'malformed' })
    expect(result.structuredContent.error.message).toMatch(/incomplete or altered/)
  })

  it('phase 2: every advertised v2 action has a handler (no stub answers not_implemented)', () => {
    const stubs = v2Catalog().tools.flatMap((tool) => Object.entries(tool.actions).filter(([, spec]) => !spec.handler).map(([action]) => `${tool.name}(${action})`))
    expect(stubs).toEqual([])
  })
})

describe('in-app sessions under v2', () => {
  it('list the first-party mission tool next to the 15 v2 tools', async () => {
    const harness = createHarness()
    const { toolCount: count, dispose } = registerV2Surface(harness.server, harness.ctx, buildToolSpecs(), { inApp: true })
    const client = await harness.connect()
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(new Set(names)).toEqual(new Set([...V2_NAMES, 'specrails_mission']))
    expect(names).toHaveLength(16)
    expect(count).toBe(16)
    dispose()
    await client.close()
  })
})
