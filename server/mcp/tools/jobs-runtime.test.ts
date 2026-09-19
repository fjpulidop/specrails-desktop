import { describe, it, expect, beforeEach, vi } from 'vitest'
import { jobsTools } from './jobs'
import { apiCall, type McpToolContext } from './types'

vi.mock('./types', async (importOriginal) => ({ ...await importOriginal<typeof import('./types')>(), apiCall: vi.fn() }))

// ── specrails_jobs runtime_* (mission-rail-cards: the agent's eyes + hands) ──
const ctx = { registry: { getProjectRow: (id: string) => (id === 'p1' ? { id: 'p1' } : undefined), getContext: (id: string) => (id === 'p1' ? { project: { id: 'p1' } } : undefined) }, requestProjectId: 'p1' } as unknown as McpToolContext
const tool = jobsTools()[0]
const call = (args: Record<string, unknown>) => tool.handler(ctx, { projectId: 'p1', ...args }) as Promise<Record<string, unknown>>
const tier = tool.tier as (a: Record<string, unknown>) => string

beforeEach(() => { vi.mocked(apiCall).mockReset().mockResolvedValue({ ok: true }) })

describe('specrails_jobs runtime_* actions', () => {
  it('declares honest tiers', () => {
    expect(tier({ action: 'runtime_runs' })).toBe('read')
    expect(tier({ action: 'runtime_evidence' })).toBe('read')
    expect(tier({ action: 'runtime_resume' })).toBe('ai-spawn')
    expect(tier({ action: 'runtime_recover' })).toBe('ai-spawn')
    expect(tier({ action: 'runtime_approve' })).toBe('write')
    expect(tier({ action: 'runtime_settle' })).toBe('write')
    expect(tier({ action: 'runtime_dismiss' })).toBe('write')
    expect(tier({ action: 'runtime_cancel' })).toBe('destructive')
  })

  it('runtime_runs reads one run, a rail\'s latest continuation, or every run', async () => {
    await call({ action: 'runtime_runs', jobId: 'r 1' })
    expect(vi.mocked(apiCall).mock.calls[0].slice(1)).toEqual(['GET', '/projects/p1/agent-runtime/runs/r%201'])
    await call({ action: 'runtime_runs', railIndex: 2 })
    expect(vi.mocked(apiCall).mock.calls[1][2]).toBe('/projects/p1/agent-runtime/runs?railIndex=2')
    await call({ action: 'runtime_runs' })
    expect(vi.mocked(apiCall).mock.calls[2][2]).toBe('/projects/p1/agent-runtime/runs')
    await call({ action: 'runtime_evidence', jobId: 'r1' })
    expect(vi.mocked(apiCall).mock.calls[3][2]).toBe('/projects/p1/agent-runtime/runs/r1/evidence')
    await expect(call({ action: 'runtime_evidence' })).rejects.toThrow('requires a "jobId"')
  })

  it('runtime_resume forwards approve/recover/invalidate/answer and hints that 202 is not completion', async () => {
    vi.mocked(apiCall).mockResolvedValue({ accepted: true })
    const r = await call({ action: 'runtime_resume', jobId: 'r1', approve: ['a'], recover: ['b'], invalidate: ['c'], answer: 'yes', ignored: 1 })
    expect(vi.mocked(apiCall).mock.calls[0].slice(1)).toEqual(['POST', '/projects/p1/agent-runtime/runs/r1/resume', { approve: ['a'], recover: ['b'], invalidate: ['c'], answer: 'yes' }])
    expect(r).toMatchObject({ accepted: true, hint: expect.stringContaining('not completion') })
    await expect(call({ action: 'runtime_resume' })).rejects.toThrow('requires a "jobId"')
  })

  it('runtime_recover defaults to the run\'s recoverable steps and refuses when there are none', async () => {
    vi.mocked(apiCall).mockImplementation(async (_c, method, url) => method === 'GET' ? { runs: [{ recoverableSteps: ['developer', 'verify'] }] } : { accepted: true, url })
    await call({ action: 'runtime_recover', jobId: 'r1' })
    expect(vi.mocked(apiCall).mock.calls[1].slice(1)).toEqual(['POST', '/projects/p1/agent-runtime/runs/r1/resume', { recover: ['developer', 'verify'] }])
    vi.mocked(apiCall).mockReset().mockResolvedValue({ accepted: true })
    await call({ action: 'runtime_recover', jobId: 'r1', stepId: 'verify' })
    expect(vi.mocked(apiCall).mock.calls[0][3]).toEqual({ recover: ['verify'] })
    vi.mocked(apiCall).mockReset().mockResolvedValue({ runs: [{ recoverableSteps: [] }] })
    await expect(call({ action: 'runtime_recover', jobId: 'r1' })).rejects.toThrow('no recoverable steps')
  })

  it('runtime_approve needs a step and maps settle / dismiss / cancel to their routes', async () => {
    await call({ action: 'runtime_approve', jobId: 'r1', stepId: 'reviewer' })
    expect(vi.mocked(apiCall).mock.calls[0][3]).toEqual({ approve: ['reviewer'] })
    await call({ action: 'runtime_approve', jobId: 'r1', approve: ['x'] })
    expect(vi.mocked(apiCall).mock.calls[1][3]).toEqual({ approve: ['x'] })
    await expect(call({ action: 'runtime_approve', jobId: 'r1' })).rejects.toThrow('requires "stepId" or "approve"')
    await call({ action: 'runtime_settle', jobId: 'r1' })
    await call({ action: 'runtime_dismiss', jobId: 'r1' })
    await call({ action: 'runtime_cancel', jobId: 'r1' })
    expect(vi.mocked(apiCall).mock.calls.slice(2).map((c) => c[2])).toEqual([
      '/projects/p1/agent-runtime/runs/r1/settle',
      '/projects/p1/agent-runtime/runs/r1/dismiss',
      '/projects/p1/agent-runtime/runs/r1/cancel',
    ])
    for (const action of ['runtime_settle', 'runtime_dismiss', 'runtime_cancel']) await expect(call({ action })).rejects.toThrow('requires a "jobId"')
  })
})
