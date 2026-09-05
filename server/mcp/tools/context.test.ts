import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { contextTools } from './context'
import { apiCall, type McpToolContext } from './types'

vi.mock('./types', async importOriginal => ({ ...await importOriginal<typeof import('./types')>(), apiCall: vi.fn() }))
const project = { id: 'p1', name: 'Demo', path: '/tmp/demo', provider: 'codex', providers: ['codex'], slug: 'demo' }
const ctx = { registry: { getProjectRow: (id: string) => id === 'p1' ? project : undefined, getContext: (id: string) => id === 'p1' ? { project } : undefined }, requestProjectId: 'p1' } as unknown as McpToolContext
const tool = contextTools()[0]
const call = (args: Record<string, unknown> = {}) => tool.handler(ctx, args) as Promise<any>

beforeEach(() => { vi.mocked(apiCall).mockReset() })

describe('live project context', () => {
  it('reads actual source shapes, keeps rail identity and delivery outcomes, and bounds backlog text', async () => {
    vi.mocked(apiCall).mockImplementation(async (_ctx, _method, url) => {
      if (url.endsWith('/tickets')) return { tickets: [
        { id: 1, title: 'x'.repeat(900), status: 'todo', description: 'full secret-free specification' },
        { id: 2, status: 'done' }, { id: 3, status: 'todo' },
      ], revision: 7 }
      if (url.endsWith('/rails')) return { rails: [{ railIndex: 2, ticketIds: [1], mode: 'loop', aiEngine: 'codex', profileName: 'premium' }], activeLoopRuns: { 2: { loopRunId: 'run-1' } }, prDeliveries: { 2: { id: 'delivery-1', deliveryOutcome: 'local_ready', units: Array(200).fill({}) } } }
      if (url.includes('/jobs?')) return { total: 20, jobs: [{ id: 'j1', status: 'failed', exit_code: 1 }] }
      if (url.endsWith('/git')) return { git: true, branch: 'main', dirty: true, worktrees: [{ path: '/tmp/wt' }] }
      return { blueprint: { product: { name: 'Demo' }, milestones: [{ title: 'M1' }], m1Specs: Array(200).fill({}) } }
    })
    const result = await call({ limit: 1 })
    expect(result.projectId).toBe('p1')
    expect(result.sections.overview.data.providers).toEqual(['codex'])
    expect(result.sections.backlog.data).toMatchObject({ total: 3, revision: 7, statusCounts: { todo: 2, done: 1 }, truncated: true })
    expect(result.sections.backlog.data.recent).toHaveLength(1)
    expect(result.sections.backlog.data.recent[0].title).toContain('[truncated]')
    expect(result.sections.backlog.data.recent[0]).not.toHaveProperty('description')
    expect(result.sections.runs.rails.data.rails[0]).toMatchObject({ railIndex: 2, aiEngine: 'codex', profileName: 'premium' })
    expect(result.sections.runs.rails.data.prDeliveries[2]).toEqual({ id: 'delivery-1', deliveryOutcome: 'local_ready' })
    expect(result.sections.runs.jobs.data).toMatchObject({ total: 20, truncated: true })
    expect(result.sections.git.data).toMatchObject({ dirty: true, worktreeCount: 1, truncated: false })
    expect(result.sections.blueprint.data).not.toHaveProperty('m1Specs')
    expect(result.consistency).toContain('not an atomic snapshot')
    expect(apiCall).toHaveBeenCalledTimes(5)
    expect(vi.mocked(apiCall).mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  })

  it('isolates partial failures and never reports an unavailable backlog as empty', async () => {
    vi.mocked(apiCall).mockRejectedValue(new Error('database unavailable'))
    const result = await call({ sections: ['overview', 'backlog'] })
    expect(result.sections.overview.status).toBe('ok')
    expect(result.sections.backlog).toMatchObject({ status: 'unavailable', error: 'database unavailable', source: '/api/projects/p1/tickets' })
    expect(result.sections.backlog).not.toHaveProperty('data')
    expect(result.sections).not.toHaveProperty('git')
  })

  it.each(['backlog', 'runs', 'git', 'blueprint'])('marks malformed %s responses unavailable', async section => {
    vi.mocked(apiCall).mockResolvedValue({})
    const result = await call({ sections: [section] })
    if (section === 'runs') {
      expect(result.sections.runs.jobs.status).toBe('unavailable')
      expect(result.sections.runs.rails.status).toBe('unavailable')
    } else expect(result.sections[section].status).toBe('unavailable')
  })

  it('propagates cancellation instead of turning an aborted call into partial success', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.mocked(apiCall).mockRejectedValue(new Error('cancelled'))
    await expect(tool.handler({ ...ctx, signal: controller.signal }, { sections: ['git'] })).rejects.toThrow('cancelled')
  })

  it('deduplicates requested sections and validates bounds', async () => {
    vi.mocked(apiCall).mockResolvedValue({ git: false })
    const result = await call({ sections: ['git', 'git'] })
    expect(Object.keys(result.sections)).toEqual(['git'])
    expect(apiCall).toHaveBeenCalledTimes(1)
    const schema = z.object(tool.inputSchema)
    expect(schema.safeParse({ sections: [] }).success).toBe(false)
    expect(schema.safeParse({ limit: 31 }).success).toBe(false)
    expect(schema.safeParse({ sections: ['unknown'] }).success).toBe(false)
  })

  it('retains registered identity when the project database is unavailable', async () => {
    const unavailable = { ...ctx, registry: { ...ctx.registry, getContext: () => undefined } } as McpToolContext
    vi.mocked(apiCall).mockRejectedValue(new Error('database unavailable'))
    const result = await tool.handler(unavailable, { sections: ['overview', 'runs'] }) as any
    expect(result.sections.overview.data).toMatchObject({ id: 'p1', available: false })
    expect(result.sections.runs.jobs.status).toBe('unavailable')
    await expect(tool.handler(ctx, { projectId: 'missing' })).rejects.toThrow('Unknown projectId')
    await expect(tool.handler({ ...ctx, requestProjectId: null }, {})).rejects.toThrow('No project selected')
  })
})
