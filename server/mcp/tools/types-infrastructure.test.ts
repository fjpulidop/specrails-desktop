import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiCall, McpApiError, registerTieredTool, type McpToolContext, type ToolHandlerExtra } from './types'
import { initDesktopDb } from '../../desktop-db'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
vi.mock('../../auth', () => ({ loadOrGenerateToken: () => 'unit-test-token' }))

describe('MCP request lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('propagates request cancellation to REST and retains machine-readable error detail', async () => {
    const abort = new AbortController()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      signal = init.signal
      return new Response(JSON.stringify({ error: 'rail_busy', railIndex: 2 }), { status: 409 })
    }))
    const ctx = { desktopPort: 1, signal: abort.signal } as McpToolContext
    await expect(apiCall(ctx, 'POST', '/test', {})).rejects.toMatchObject({
      status: 409, code: 'rail_busy', data: { error: 'rail_busy', railIndex: 2 },
    } satisfies Partial<McpApiError>)
    expect(signal?.aborted).toBe(false)
    abort.abort()
    expect(signal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('never dispatches an already-cancelled tool and keeps cancellation isolated between requests', async () => {
    const db = initDesktopDb(':memory:')
    let call!: (args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<any>
    const server = { registerTool: (_name: string, _config: unknown, handler: typeof call) => { call = handler } } as unknown as McpServer
    const handler = vi.fn((ctx: McpToolContext) => ({ hasSignal: Boolean(ctx.signal) }))
    try {
      registerTieredTool(server, { desktopDb: db } as McpToolContext, {
        name: 'test', title: 'test', description: '', tier: 'read', inputSchema: {}, handler,
      })
      const abort = new AbortController()
      abort.abort()
      expect((await call({}, { signal: abort.signal })).isError).toBe(true)
      expect(handler).not.toHaveBeenCalled()
      const active = new AbortController()
      expect((await call({}, { signal: active.signal })).isError).toBeUndefined()
      await call({})
      expect(handler.mock.calls[0][0].signal).toBe(active.signal)
      expect(handler.mock.calls[1][0].signal).toBeUndefined()
    } finally { db.close() }
  })
})
