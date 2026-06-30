import { describe, it, expect, beforeEach } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { connectBridge, readMcpToken, appUrl, APP_NOT_RUNNING } from './bridge'

class FakeTransport implements Transport {
  onmessage?: (m: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (e: Error) => void
  sent: JSONRPCMessage[] = []
  closed = false
  failSend: Error | null = null
  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true
    this.onclose?.()
  }
  async send(m: JSONRPCMessage): Promise<void> {
    if (this.failSend) throw this.failSend
    this.sent.push(m)
  }
}

describe('connectBridge', () => {
  let client: FakeTransport
  let app: FakeTransport

  beforeEach(() => {
    client = new FakeTransport()
    app = new FakeTransport()
    connectBridge(client, app)
  })

  it('forwards client → app', async () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'tools/list' } as JSONRPCMessage
    await client.onmessage!(msg)
    expect(app.sent).toEqual([msg])
  })

  it('forwards app → client', async () => {
    const msg = { jsonrpc: '2.0', id: 1, result: { tools: [] } } as JSONRPCMessage
    app.onmessage!(msg)
    await Promise.resolve()
    expect(client.sent).toEqual([msg])
  })

  it('replies with a clear error when the app is unreachable', async () => {
    app.failSend = new Error('fetch failed: ECONNREFUSED 127.0.0.1:4200')
    const req = { jsonrpc: '2.0', id: 7, method: 'initialize' } as JSONRPCMessage
    await client.onmessage!(req)
    expect(client.sent).toHaveLength(1)
    const reply = client.sent[0] as { id: number; error: { message: string } }
    expect(reply.id).toBe(7)
    expect(reply.error.message).toBe(APP_NOT_RUNNING)
  })

  it('does not reply to a notification (no id) when unreachable', async () => {
    app.failSend = new Error('ECONNREFUSED')
    const notif = { jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage
    await client.onmessage!(notif)
    expect(client.sent).toHaveLength(0)
  })

  it('closing the app side closes the client side', async () => {
    await app.close()
    expect(client.closed).toBe(true)
  })
})

describe('bridge config', () => {
  it('readMcpToken returns null when no token file exists', () => {
    // vitest pins SPECRAILS_REGISTRY_HOME to a throwaway dir without a token.
    expect(readMcpToken()).toBeNull()
  })

  it('appUrl targets the loopback MCP endpoint', () => {
    const u = appUrl()
    expect(u.hostname).toBe('127.0.0.1')
    expect(u.pathname).toBe('/api/mcp')
  })
})
