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
import { gitTools } from './git'

describe('specrails_code bounded reads and source search', () => {
  const tool = codeTools()[0]
  const project = { id: 'p1', name: 'Project', path: '/tmp/mcp-code-unit-project' }
  const ctx = { requestProjectId: 'p1', registry: { getContext: () => ({ project }), getProjectRow: () => project } } as unknown as McpToolContext
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

  const multiple = () => {
    const row = { ...project, repositories: ['frontend', 'backend'].map((id, index) => ({ id, projectId: 'p1', name: id, path: `/tmp/${id}`, kind: 'git', isPrimary: index === 0, addedAt: '', integrationBranch: null })) }
    return { ...ctx, registry: { getContext: () => ({ project: row }), getProjectRow: () => row } } as unknown as McpToolContext
  }

  it('requires a repository for specific code and Git reads and rejects a foreign ID before an API request', async () => {
    for (const action of ['tree', 'read_file', 'summary', 'regenerate_summary', 'provenance', 'diff']) {
      await expect(tool.handler(multiple(), { action, path: 'index.ts', jobId: 'run' })).rejects.toThrow('repository_required')
    }
    await expect(gitTools()[0].handler(multiple(), { action: 'info' })).rejects.toThrow('repository_required')
    await expect(tool.handler(multiple(), { action: 'read_file', path: 'index.ts', repositoryId: 'another-project-repo' })).rejects.toThrow('does not belong')
    expect(apiCall).not.toHaveBeenCalled()
  })

  it('uses project-wide discovery then preserves repository identity for a selected read', async () => {
    const context = multiple()
    vi.mocked(apiCall).mockResolvedValue({ matches: [{ path: 'src/index.ts', repositoryId: 'backend' }] })
    await tool.handler(context, { action: 'find', query: 'index.ts', limit: 5 })
    expect(apiCall).toHaveBeenLastCalledWith(context, 'GET', '/projects/p1/code/discover?kind=find&q=index.ts&limit=5')
    await tool.handler(context, { action: 'read_file', path: 'src/index.ts', repositoryId: 'backend' })
    expect(vi.mocked(apiCall).mock.calls.at(-1)?.[2]).toBe('/projects/p1/repositories/backend/code/file?path=src%2Findex.ts&startLine=1&endLine=200')
    await gitTools()[0].handler(context, { action: 'info', repositoryId: 'backend' })
    expect(apiCall).toHaveBeenLastCalledWith(context, 'GET', '/projects/p1/repositories/backend/git')
  })
})
