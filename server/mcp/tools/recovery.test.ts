import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recoveryTools } from './recovery'
import { apiCall, type McpToolContext } from './types'
vi.mock('./types', async importOriginal => ({ ...await importOriginal<typeof import('./types')>(), apiCall: vi.fn() }))
const tool = recoveryTools()[0]
const ctx = { registry: { getProjectRow: (id: string) => id === 'p1' ? { id } : undefined, getContext: (id: string) => id === 'p1' ? { project: { id } } : undefined }, requestProjectId: 'p1' } as unknown as McpToolContext
beforeEach(() => vi.mocked(apiCall).mockReset().mockResolvedValue({ status: 'applied' }))
describe('scoped recovery MCP', () => {
  it('separates file writes and executable checks from read-only inspection', () => {
    const tier = tool.tier as (args: Record<string, unknown>) => string
    for (const action of ['inspect', 'history', 'list_files', 'read_file', 'diff']) expect(tier({ action })).toBe('read')
    expect(tier({ action: 'patch' })).toBe('write')
    expect(tier({ action: 'check' })).toBe('destructive')
  })
  it('forwards an exact idempotent patch to the selected run and project', async () => {
    const patch = { action: 'patch', repositoryId: 'repo', path: 'src/file.ts', oldText: 'one', newText: 'two', expectedHash: 'a'.repeat(64), operationId: 'ef12d691-10cb-4a6b-86e8-ab390498d312', reason: 'Fix the identified value' }
    await tool.handler(ctx, { projectId: 'p1', jobId: 'run 1', ...patch })
    expect(vi.mocked(apiCall).mock.calls[0].slice(1)).toEqual(['POST', '/projects/p1/agent-runtime/runs/run%201/recovery', patch])
    await expect(tool.handler(ctx, { ...patch, projectId: 'foreign', jobId: 'r' })).rejects.toThrow()
  })
  it('rejects arbitrary commands, unguarded edits and inconsistent read requests before transport', async () => {
    for (const input of [{ action: 'check', command: 'rm file' }, { action: 'patch', path: 'file' }, { action: 'read_file', repositoryId: 'repo', path: 'file', oldText: 'hidden mutation' }]) {
      await expect(tool.handler(ctx, { projectId: 'p1', jobId: 'r', ...input })).rejects.toThrow()
    }
    expect(apiCall).not.toHaveBeenCalled()
  })
})
