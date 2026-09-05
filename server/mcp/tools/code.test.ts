import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
vi.mock('./types', async (load) => ({
  ...await load<typeof import('./types')>(),
  apiCall: vi.fn(async () => ({ content: 'source' })),
  projectPath: vi.fn(() => '/projects/p1'),
}))
import { apiCall, type McpToolContext } from './types'
import { codeTools } from './code'

describe('specrails_code bounded reads and source search', () => {
  const tool = codeTools()[0]
  const ctx = {} as McpToolContext
  beforeEach(() => { vi.mocked(apiCall).mockReset(); vi.mocked(apiCall).mockResolvedValue({ content: 'source' }) })

  it('exports valid SDK discovery schemas for search and guarded page continuation', () => {
    const schema = z.object(tool.inputSchema)
    const json = toJsonSchemaCompat(schema) as { properties: Record<string, { enum?: string[]; type?: string; pattern?: string; minimum?: number }> }
    expect(json.properties.action.enum).toContain('search')
    expect(json.properties.startLine.type).toBe('integer')
    expect(json.properties.expectedHash.pattern).toContain('64')
    expect(schema.safeParse({ action: 'read_file', path: 'x', startLine: 1, startColumn: 20001, expectedHash: 'a'.repeat(64) }).success).toBe(true)
    expect(schema.safeParse({ action: 'read_file', path: 'x', startLine: 0 }).success).toBe(false)
    expect(schema.safeParse({ action: 'read_file', path: 'x', expectedHash: 'invalid' }).success).toBe(false)
    expect(typeof tool.tier === 'function' && tool.tier({ action: 'search' })).toBe('read')
  })

  it('always requests a bounded line range by default instead of the full editor preview', async () => {
    await tool.handler(ctx, { action: 'read_file', path: 'src/a #1.ts' })
    expect(apiCall).toHaveBeenCalledWith(ctx, 'GET', '/projects/p1/code/file?path=src%2Fa+%231.ts&startLine=1&endLine=200')
  })

  it('forwards line/column continuation and hash guards and rejects inverted ranges before API calls', async () => {
    await tool.handler(ctx, { action: 'read_file', path: 'min.js', startLine: 2, startColumn: 20001, expectedHash: 'a'.repeat(64) })
    const url = new URL(vi.mocked(apiCall).mock.calls[0][2], 'http://local')
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: 'min.js', startLine: '2', endLine: '201', startColumn: '20001', expectedHash: 'a'.repeat(64) })
    await expect(tool.handler(ctx, { action: 'read_file', path: 'x', startLine: 3, endLine: 2 })).rejects.toThrow('endLine')
    expect(apiCall).toHaveBeenCalledTimes(1)
  })

  it('sends exact literal source search with scope and case, rejecting oversized match budgets', async () => {
    await tool.handler(ctx, { action: 'search', query: ' a.*b ', path: 'src/lib', caseSensitive: true, limit: 42 })
    const url = new URL(vi.mocked(apiCall).mock.calls[0][2], 'http://local')
    expect(url.pathname).toBe('/projects/p1/code/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: ' a.*b ', path: 'src/lib', caseSensitive: 'true', limit: '42' })
    await expect(tool.handler(ctx, { action: 'search', query: 'x', limit: 101 })).rejects.toThrow('at most 100')
    expect(apiCall).toHaveBeenCalledTimes(1)
  })

  it('does not translate an incomplete empty find into proof that a file is absent', async () => {
    vi.mocked(apiCall).mockResolvedValue({ matches: [], truncated: true })
    const result = await tool.handler(ctx, { action: 'find', query: 'file.ts' }) as { hint: string }
    expect(result.hint).toContain('does not prove absence')
  })

  it('preserves the not-found hint with paginated file reads', async () => {
    vi.mocked(apiCall).mockRejectedValue(new Error('API GET /projects/p1/code/file → 404: {"error":"file not found"}'))
    await expect(tool.handler(ctx, { action: 'read_file', path: 'detail/File.ts' })).rejects.toThrow('specrails_code(action: "find", query: "File.ts")')
  })
})
