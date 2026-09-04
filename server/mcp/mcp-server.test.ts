import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'http'
import type { AddressInfo } from 'net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { initDesktopDb, setDesktopSetting, type DbInstance } from '../desktop-db'
import type { ProjectRegistry } from '../project-registry'
import { McpServerManager } from './mcp-server'
import { AGENT_CAPABILITY_HEADER, AGENT_TIER_HEADER } from '../agent-tier'
import { _resetAgentCapabilitiesForTest, mintAgentCapability } from './agent-capability'

// A minimal ProjectRegistry stub: the MCP core only needs desktopDb + the
// project lookup methods. No real projects are required for these tests.
function makeRegistry(db: DbInstance): ProjectRegistry {
  return {
    desktopDb: db,
    listContexts: () => [],
    getContext: () => undefined,
    getContextByPath: () => undefined,
    removeProject: () => undefined,
  } as unknown as ProjectRegistry
}

async function startMcp(manager: McpServerManager): Promise<{ server: http.Server; url: URL }> {
  const app = express()
  app.use('/api/mcp', express.json({ limit: '4mb' }), (req, res) => {
    void manager.handleHttp(req, res)
  })
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: new URL(`http://127.0.0.1:${port}/api/mcp`) }
}

async function connectClient(url: URL): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url))
  return client
}

describe('McpServerManager (embedded MCP server)', () => {
  let db: DbInstance
  let manager: McpServerManager
  let server: http.Server
  let url: URL

  beforeEach(async () => {
    _resetAgentCapabilitiesForTest()
    db = initDesktopDb(':memory:')
    manager = new McpServerManager({ registry: makeRegistry(db), broadcast: () => {}, desktopPort: 4200 })
    const started = await startMcp(manager)
    server = started.server
    url = started.url
  })

  afterEach(async () => {
    await manager.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('is enabled by default; once switched off it refuses initialize with a 404', async () => {
    expect(manager.isEnabledSetting()).toBe(true)
    setDesktopSetting(db, 'mcp_enabled', 'false')
    expect(manager.isEnabledSetting()).toBe(false)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    })
    expect(res.status).toBe(404)
  })

  it('does not treat a spoofed agent-tier header as first-party', async () => {
    setDesktopSetting(db, 'mcp_enabled', 'false')
    expect(manager.isEnabledSetting()).toBe(false)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [AGENT_TIER_HEADER]: 'autonomous',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    })
    expect(res.status).toBe(404)
  })

  it('serves a server-minted first-party capability when the toggle is disabled', async () => {
    const capability = mintAgentCapability({ conversationId: 'conv-server', projectId: null, tierLevel: 0 })
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [AGENT_CAPABILITY_HEADER]: capability,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    })
    expect(res.status).not.toBe(404)
    expect(res.headers.get('mcp-session-id')).toBeTruthy()
  })

  it('initializes and lists the tool catalog when enabled', async () => {
    setDesktopSetting(db, 'mcp_enabled', 'true')
    const client = await connectClient(url)
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('specrails_guide')
    expect(names).toContain('specrails_projects')
    expect(names).toContain('specrails_watch')
    expect(names).toContain('specrails_search')
    expect(names).toContain('specrails_select_project')
    await client.close()
  })

  it('returns the platform guide (read tier, always available)', async () => {
    setDesktopSetting(db, 'mcp_enabled', 'true')
    const client = await connectClient(url)
    const result = await client.callTool({ name: 'specrails_guide', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('Specrails')
    expect(result.isError).toBeFalsy()
    await client.close()
  })

  it('exposes resources including the guide', async () => {
    setDesktopSetting(db, 'mcp_enabled', 'true')
    const client = await connectClient(url)
    const { resources } = await client.listResources()
    expect(resources.some((r) => r.uri === 'specrails://guide')).toBe(true)
    const read = await client.readResource({ uri: 'specrails://guide' })
    expect((read.contents[0] as { text: string }).text).toContain('Specrails')
    await client.close()
  })

  it('refuses a destructive action when the tier is disabled, naming the tier', async () => {
    setDesktopSetting(db, 'mcp_enabled', 'true')
    setDesktopSetting(db, 'mcp_tier_destructive', 'false') // user opted the destructive tier out
    const client = await connectClient(url)
    const result = await client.callTool({ name: 'specrails_projects', arguments: { action: 'unregister', projectId: 'x' } })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('Destructive')
    await client.close()
  })

  it('allows read actions regardless of other tiers', async () => {
    setDesktopSetting(db, 'mcp_enabled', 'true')
    const client = await connectClient(url)
    const result = await client.callTool({ name: 'specrails_projects', arguments: { action: 'list' } })
    expect(result.isError).toBeFalsy()
    expect((result.content as Array<{ type: string; text: string }>)[0].text).toBe('[]')
    await client.close()
  })

  it('reports status (enabled by default) with a non-zero tool count', () => {
    const status = manager.status()
    expect(status.enabled).toBe(true)
    expect(status.toolCount).toBeGreaterThan(4)
  })

  it('setEnabled(false) tears down and persists the flag', async () => {
    setDesktopSetting(db, 'mcp_enabled', 'true')
    expect(manager.isEnabledSetting()).toBe(true)
    await manager.setEnabled(false)
    expect(manager.isEnabledSetting()).toBe(false)
  })
})
