import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'http'
import type { AddressInfo } from 'net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { addProject, getProject, listProjects, initDesktopDb, setDesktopSetting, type DbInstance } from '../desktop-db'
import type { ProjectRegistry } from '../project-registry'
import { McpServerManager } from './mcp-server'
import { AGENT_CAPABILITY_HEADER, AGENT_TIER_HEADER } from '../agent-tier'
import { _resetAgentCapabilitiesForTest, mintAgentCapability, revokeAgentCapability } from './agent-capability'
import { RecoveringHttpTransport } from '../../mcp-bridge/src/http-transport'
import { registerAgentSteering, notifyAgentSteering } from '../agent-steering'

// A minimal ProjectRegistry stub: the MCP core only needs desktopDb + the
// project lookup methods. No real projects are required for these tests.
function makeRegistry(db: DbInstance): ProjectRegistry {
  return {
    desktopDb: db,
    listContexts: () => [],
    listProjects: () => listProjects(db),
    getProjectRow: (id: string) => getProject(db, id),
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
    setDesktopSetting(db, 'mcp_enabled', 'false')
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

  it('rejects invalid capabilities even when external MCP has every tier enabled', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AGENT_CAPABILITY_HEADER]: 'invalid'.repeat(8) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })
    expect(response.status).toBe(401)
    expect(manager.status().activeSessions).toBe(0)
  })

  it('binds sessions to their owning turn and closes them when that capability is revoked', async () => {
    const capability = mintAgentCapability({ conversationId: 'owner', tierLevel: 0 })
    const other = mintAgentCapability({ conversationId: 'other', tierLevel: 3 })
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { [AGENT_CAPABILITY_HEADER]: capability } } })
    const client = new Client({ name: 'owner', version: '1' })
    await client.connect(transport)
    const sid = transport.sessionId!
    expect(manager.status().activeSessions).toBe(1)
    for (const headers of [{}, { [AGENT_CAPABILITY_HEADER]: other }]) {
      const res = await fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sid } })
      expect(res.status).toBe(403)
      expect(manager.status().activeSessions).toBe(1)
    }
    revokeAgentCapability(capability)
    expect(manager.status().activeSessions).toBe(0)
    const res = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sid } })
    expect(res.status).toBe(404)
    await client.close()
  })

  it('reports unknown sessions with protocol 404, including object prototype names', async () => {
    for (const sid of ['expired', 'constructor', '__proto__']) {
      const response = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sid } })
      expect(response.status).toBe(404)
    }
  })

  it('the stdio bridge recovers a lost SDK session and deletes the replacement when closed', async () => {
    const client = new Client({ name: 'bridge-client', version: '1' })
    const transport = new RecoveringHttpTransport(() => new StreamableHTTPClientTransport(url))
    await client.connect(transport)
    expect((await client.listTools()).tools.length).toBeGreaterThan(1)
    await manager.stop()
    expect(manager.status().activeSessions).toBe(0)
    expect((await client.listTools()).tools.length).toBeGreaterThan(1)
    expect(manager.status().activeSessions).toBe(1)
    await client.close()
    expect(manager.status().activeSessions).toBe(0)
  })

  it('does not share the selected project across independent client sessions', async () => {
    addProject(db, { id: 'project-a', slug: 'a', name: 'A', path: '/tmp/a' })
    const first = await connectClient(url)
    const second = await connectClient(url)
    const selected = await first.callTool({ name: 'specrails_select_project', arguments: { projectId: 'project-a' } })
    expect(selected.isError).toBeFalsy()
    const result = await second.callTool({ name: 'specrails_specs', arguments: { action: 'list' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('No project specified')
    await first.close()
    await second.close()
  })

  it('resources preserve registered projects even when their runtime database is unavailable', async () => {
    addProject(db, { id: 'unavailable', slug: 'unavailable', name: 'Still registered', path: '/tmp/mcp-test' })
    const client = await connectClient(url)
    const listed = await client.readResource({ uri: 'specrails://projects' })
    expect(JSON.parse((listed.contents[0] as { text: string }).text)).toEqual([expect.objectContaining({ id: 'unavailable' })])
    const project = await client.readResource({ uri: 'specrails://projects/unavailable' })
    expect(JSON.parse((project.contents[0] as { text: string }).text)).toMatchObject({ id: 'unavailable', name: 'Still registered' })
    await client.close()
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
    expect(tools.find((tool) => tool.name === 'specrails_projects')?.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true, openWorldHint: true,
    })
    expect(tools.find((tool) => tool.name === 'specrails_guide')?.annotations).toMatchObject({ readOnlyHint: true })
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

  it('delivers and acknowledges mission updates across authenticated transport sessions without leaking to external clients', async () => {
    const capability = mintAgentCapability({ conversationId: 'steered-mission', tierLevel: 0 })
    let consumed = 0
    const image = { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }
    const dispose = registerAgentSteering(db, capability, async () => {
      consumed++
      return { content: 'Follow-up from the mission user.', images: [image] }
    })
    const clients = [new Client({ name: 'mission-a', version: '1' }), new Client({ name: 'mission-b', version: '1' })]
    const external = await connectClient(url)
    try {
      await Promise.all(clients.map(client => client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { [AGENT_CAPABILITY_HEADER]: capability } },
      }))))
      notifyAgentSteering(db, capability)
      const replies = await Promise.all(clients.map(client => client.callTool({ name: 'specrails_guide', arguments: {} })))
      for (const reply of replies) {
        expect(reply.isError).toBe(true)
        expect(JSON.stringify(reply)).toContain('tool_not_executed')
        expect(JSON.stringify(reply)).toContain('Follow-up from the mission user.')
        expect(reply.content).toContainEqual(image)
        expect(JSON.stringify(reply)).not.toContain(capability)
      }
      expect(consumed).toBe(1)
      const outsider = await external.callTool({ name: 'specrails_guide', arguments: {} })
      expect(JSON.stringify(outsider)).not.toContain('Follow-up from the mission user.')
      expect((await external.callTool({ name: 'specrails_mission', arguments: { action: 'acknowledge_updates', revision: 1 } })).isError).toBe(true)
      const acknowledged = await clients[1].callTool({ name: 'specrails_mission', arguments: { action: 'acknowledge_updates', revision: 1 } })
      expect(acknowledged.isError).toBeUndefined()
      const resumed = await clients[0].callTool({ name: 'specrails_guide', arguments: {} })
      expect(resumed.isError).toBeUndefined()
      expect(JSON.stringify(resumed)).not.toContain('Follow-up from the mission user.')
    } finally {
      dispose()
      await Promise.all([...clients, external].map(client => client.close()))
    }
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

  it('disabling external MCP preserves an independently authorized mission session', async () => {
    const capability = mintAgentCapability({ conversationId: 'in-progress', tierLevel: 0 })
    const mission = new Client({ name: 'mission', version: '1' })
    await mission.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { [AGENT_CAPABILITY_HEADER]: capability } } }))
    const external = await connectClient(url)
    expect(manager.status().activeSessions).toBe(2)
    await manager.setEnabled(false)
    expect(manager.status().activeSessions).toBe(1)
    expect((await mission.listTools()).tools.length).toBeGreaterThan(1)
    await mission.close()
    await external.close()
  })
})
