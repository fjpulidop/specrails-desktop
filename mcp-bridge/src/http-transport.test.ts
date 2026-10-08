import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { authenticatedFetch, RecoveringHttpTransport } from './http-transport'

class FakeHttpTransport implements Transport {
  onmessage?: Transport['onmessage']
  onclose?: () => void
  onerror?: (error: Error) => void
  sent: JSONRPCMessage[] = []
  closed = false
  fail?: Error
  terminateSession = vi.fn(async () => {})
  async start(): Promise<void> {}
  async close(): Promise<void> { this.closed = true; this.onclose?.() }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.fail) throw this.fail
    this.sent.push(message)
    if ('id' in message && 'method' in message) {
      this.onmessage?.({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { ok: true } })
    }
  }
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } } as JSONRPCMessage

describe('RecoveringHttpTransport', () => {
  it('reinitializes a rejected stale session once for concurrent requests without leaking handshake replies', async () => {
    const old = new FakeHttpTransport()
    const fresh = new FakeHttpTransport()
    const create = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(fresh)
    const transport = new RecoveringHttpTransport(create)
    const receive = vi.fn()
    transport.onmessage = receive
    await transport.start()
    await transport.send(initialize)
    old.fail = Object.assign(new Error('expired'), { code: 404 })
    await Promise.all([
      transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      transport.send({ jsonrpc: '2.0', id: 3, method: 'resources/list' }),
    ])
    expect(create).toHaveBeenCalledTimes(2)
    expect(fresh.sent.map((message) => (message as { method: string }).method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/list', 'resources/list',
    ])
    expect(receive.mock.calls.map(([message]) => message.id)).toEqual([1, 2, 3])
    expect(old.closed).toBe(true)
    await transport.close()
    expect(fresh.terminateSession).toHaveBeenCalledOnce()
  })

  it('recovers from a session bound to a previous turn (403) and logs it', async () => {
    const old = new FakeHttpTransport()
    const fresh = new FakeHttpTransport()
    const log = vi.fn()
    const transport = new RecoveringHttpTransport(vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(fresh), log)
    await transport.start()
    await transport.send(initialize)
    old.fail = Object.assign(new Error('MCP session belongs to a different agent turn or client. Reinitialize.'), { code: 403 })
    await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(fresh.sent.map((message) => (message as { method: string }).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(log.mock.calls.map(([event]) => event)).toEqual(['recover', 'recovered'])
    // Other 403s (e.g. a tier refusal) are not session problems.
    fresh.fail = Object.assign(new Error('Forbidden'), { code: 403 })
    await expect(transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).rejects.toThrow('Forbidden')
    await transport.close()
  })

  it('keeps the bridge open when a recovery fails and retries on the next request', async () => {
    const old = new FakeHttpTransport()
    const broken = new FakeHttpTransport()
    const fresh = new FakeHttpTransport()
    broken.fail = new Error('app restarting')
    const transport = new RecoveringHttpTransport(vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(broken).mockReturnValueOnce(fresh))
    const closed = vi.fn()
    transport.onclose = closed
    await transport.start()
    await transport.send(initialize)
    old.fail = Object.assign(new Error('expired'), { code: 404 })
    await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).rejects.toThrow('app restarting')
    expect(closed).not.toHaveBeenCalled()
    await transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(fresh.sent.map((message) => (message as { method: string }).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    await transport.close()
  })

  it('starts a fresh session on the next request after the stream is lost', async () => {
    const old = new FakeHttpTransport()
    const fresh = new FakeHttpTransport()
    const transport = new RecoveringHttpTransport(vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(fresh))
    const errors = vi.fn()
    transport.onerror = errors
    await transport.start()
    await transport.send(initialize)
    old.onerror?.(new Error('Maximum reconnection attempts (2) exceeded.'))
    expect(errors).toHaveBeenCalledOnce()
    await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(old.sent).toHaveLength(1)
    expect(fresh.sent.map((message) => (message as { method: string }).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    await transport.close()
  })

  it('never replays a mutation after an ambiguous network failure', async () => {
    const app = new FakeHttpTransport()
    const create = vi.fn(() => app)
    const transport = new RecoveringHttpTransport(create)
    await transport.start()
    await transport.send(initialize)
    app.fail = new Error('fetch failed: ECONNRESET')
    await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mutate' } })).rejects.toThrow('ECONNRESET')
    expect(create).toHaveBeenCalledOnce()
    await transport.close()
  })

  it('never retries initialization or repeatedly recreates a disabled MCP endpoint', async () => {
    const app = new FakeHttpTransport()
    app.fail = Object.assign(new Error('MCP disabled'), { code: 404 })
    const create = vi.fn(() => app)
    const transport = new RecoveringHttpTransport(create)
    await expect(transport.send(initialize)).rejects.toThrow('MCP disabled')
    expect(create).toHaveBeenCalledOnce()
    await transport.close()
  })
})

describe('bridge credentials on reconnect', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('loads newly created and rotated token files without restarting the bridge', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-token-'))
    vi.stubEnv('SPECRAILS_REGISTRY_HOME', home)
    fs.mkdirSync(path.join(home, '.specrails'))
    const tokenFile = path.join(home, '.specrails/mcp.token')
    const seen: Array<string | null> = []
    const send = authenticatedFetch({ 'x-specrails-agent-capability': 'capability' }, vi.fn(async (_input, init) => {
      seen.push(new Headers(init?.headers).get('Authorization'))
      expect(new Headers(init?.headers).get('x-specrails-agent-capability')).toBe('capability')
      if (seen.length === 1) {
        fs.writeFileSync(tokenFile, 'fresh-token')
        return new Response('unauthorized', { status: 401 })
      }
      return new Response('ok')
    }))
    try {
      expect((await send('http://127.0.0.1/api/mcp')).status).toBe(200)
      fs.writeFileSync(tokenFile, 'rotated-token')
      await send('http://127.0.0.1/api/mcp')
      expect(seen).toEqual([null, 'Bearer fresh-token', 'Bearer rotated-token'])
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('presents the current agent capability on every request when headers are dynamic', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-capability-'))
    const capabilityFile = path.join(home, 'capability')
    fs.writeFileSync(capabilityFile, 'a'.repeat(40))
    const seen: Array<string | null> = []
    const { agentForwardHeaders } = await import('./bridge')
    const send = authenticatedFetch(() => agentForwardHeaders({ SPECRAILS_AGENT_CAPABILITY_FILE: capabilityFile }), vi.fn(async (_input, init) => {
      seen.push(new Headers(init?.headers).get('x-specrails-agent-capability'))
      return new Response('ok')
    }))
    try {
      await send('http://127.0.0.1/api/mcp')
      // Desktop rotates the per-turn capability while the resident session keeps this bridge alive.
      fs.writeFileSync(capabilityFile, 'b'.repeat(40))
      await send('http://127.0.0.1/api/mcp')
      expect(seen).toEqual(['a'.repeat(40), 'b'.repeat(40)])
      // A removed capability (session ended) refuses the request instead of connecting unrestricted.
      fs.rmSync(capabilityFile)
      await expect(send('http://127.0.0.1/api/mcp')).rejects.toThrow('refusing to connect')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('does not replay an unchanged unauthorized credential', async () => {
    const implementation = vi.fn(async () => new Response('revoked capability', { status: 401 }))
    const send = authenticatedFetch({ 'x-specrails-agent-capability': 'revoked' }, implementation)
    expect((await send('http://127.0.0.1/api/mcp')).status).toBe(401)
    expect(implementation).toHaveBeenCalledOnce()
  })
})
