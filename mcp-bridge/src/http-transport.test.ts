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

  it('does not replay an unchanged unauthorized credential', async () => {
    const implementation = vi.fn(async () => new Response('revoked capability', { status: 401 }))
    const send = authenticatedFetch({ 'x-specrails-agent-capability': 'revoked' }, implementation)
    expect((await send('http://127.0.0.1/api/mcp')).status).toBe(401)
    expect(implementation).toHaveBeenCalledOnce()
  })
})
