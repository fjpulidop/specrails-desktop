import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiCall, McpApiError, type McpToolContext } from './types'
import { collectStatus, mapLimit, statusTools, STATUS_CONCURRENCY } from './status'
import { isToolResponse } from './envelope'

vi.mock('./types', async (importOriginal) => ({ ...await importOriginal<typeof import('./types')>(), apiCall: vi.fn() }))
vi.mock('../../modules/recovery/adapters/sqlite', () => ({
  readJobDiagnosis: vi.fn((_db: unknown, jobId: string) => jobId === 'job-failed' ? { kind: 'tests', detail: 'Unit tests failed in api.', remedies: [] } : null),
  readFailureAnalysis: vi.fn((_db: unknown, jobId: string) => jobId === 'job-failed' ? { analysis: {} } : null),
}))

vi.mock('../../modules/delivery/runtime/rail-pr-store', () => ({
  getPrDelivery: vi.fn((_db: unknown, id: string) => id === 'd-failed' ? { run_ids: JSON.stringify(['run-a', 'run-b']) } : undefined),
}))

const NOW = new Date('2026-11-18T12:00:00.000Z')
/** The local day of NOW (the machine's clock), as the status tool asks for it. */
const LOCAL_DAY = { from: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()).toISOString(), to: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1).toISOString() }
const TODAY_SPEND_PATH = `/analytics?period=custom&from=${encodeURIComponent(LOCAL_DAY.from)}&to=${encodeURIComponent(LOCAL_DAY.to)}`
const projects = [{ id: 'p1', name: 'Shop' }, { id: 'p2', name: 'Blog' }]
const ctx = {
  registry: {
    listContexts: () => projects.map((project) => ({ project, db: {} })),
    getContext: (id: string) => { const project = projects.find((p) => p.id === id); return project ? { project, db: {} } : undefined },
    getProjectRow: (id: string) => projects.find((p) => p.id === id),
  },
} as unknown as McpToolContext

type Routes = Record<string, unknown | ((path: string) => unknown)>
function route(routes: Routes) {
  vi.mocked(apiCall).mockImplementation(async (_ctx, _method, path) => {
    const handler = routes[path]
    if (handler === undefined) throw new McpApiError(`no route ${path}`, 404, { error: 'Not found' }, { method: 'GET', path })
    const value = typeof handler === 'function' ? (handler as (p: string) => unknown)(path) : handler
    if (value instanceof Error) throw value
    return value
  })
}

const baseRoutes = (): Routes => ({
  '/inbox': {
    items: [
      { id: 'p1:question:run-q', projectId: 'p1', projectName: 'Shop', kind: 'question', title: 'Which DB?', detail: null, at: '2026-11-18T11:00:00Z', version: 'v1', action: 'open-run', subjectId: 'run-q', diagnosis: null },
      { id: 'p2:failed:job-failed', projectId: 'p2', projectName: 'Blog', kind: 'failed', title: 'Spec #3', detail: 'tests', at: '2026-11-18T10:00:00Z', version: 'v2', action: 'open-run', subjectId: 'job-failed', railIndex: 1, diagnosis: null },
    ],
    projects: [],
  },
  '/recent-jobs?limit=30': { jobs: [
    { id: 'job-run', projectId: 'p1', projectName: 'Shop', command: '/sr:implement 5', status: 'running', started_at: '2026-11-18T11:30:00Z' },
    { id: 'job-rail', projectId: 'p1', projectName: 'Shop', command: '/sr:implement 6', status: 'running', started_at: '2026-11-18T11:31:00Z' },
    { id: 'job-old', projectId: 'p2', projectName: 'Blog', command: '/x', status: 'failed', started_at: '2026-11-10T11:00:00Z', finished_at: '2026-11-10T11:05:00Z' },
    { id: 'job-fresh', projectId: 'p2', projectName: 'Blog', command: '/sr:review', status: 'failed', started_at: '2026-11-18T09:00:00Z', finished_at: '2026-11-18T09:10:00Z' },
  ] },
  '/agent/active-turns': { turns: [{ conversationId: 'm1', startedAt: '2026-11-18T11:59:00Z' }], sessions: [{ conversationId: 'm2' }] },
  '/agent/conversations': { conversations: [
    { id: 'm1', title: 'Refactor checkout', pinned_project_id: 'p1', provider: 'claude', model: 'opus', contextUsage: { percent: 42 } },
    { id: 'm2', title: null, pinned_project_id: null, provider: 'codex', model: null },
  ] },
  [TODAY_SPEND_PATH]: {
    kpi: { totalCostUsd: 3.456, estimatedCostUsd: 0.5, includesEstimated: true },
    byCategory: [{ category: 'implementation', costUsd: 2.9 }, { category: 'missions', costUsd: 0.556 }, { category: 'code', costUsd: 0 }],
  },
  '/resources': { totals: { cpuPercent: 12.5, memoryBytes: 1_000_000, processCount: 7 } },
  '/projects/p1/rails': { rails: [{ railIndex: 0, name: 'Main' }], activeJobs: { 0: { jobId: 'job-rail', mode: 'implement' } }, activeLoopRuns: {} },
  '/projects/p2/rails': { rails: [], activeJobs: {}, activeLoopRuns: { 2: { loopRunId: 'loop-1', loopName: 'Implement', provider: 'codex', model: 'gpt', startedAt: '2026-11-18T11:00:00Z' } } },
})

beforeEach(() => { vi.mocked(apiCall).mockReset() })

describe('specrails_status', () => {
  it('builds one app-wide glance from every source', async () => {
    route(baseRoutes())
    const status = await collectStatus(ctx, { now: NOW })
    expect(status.partial).toBe(false)
    expect(status.mood).toBe('needs_you')
    expect(status.active.missions).toEqual([
      expect.objectContaining({ conversationId: 'm1', title: 'Refactor checkout', projectName: 'Shop', provider: 'claude', model: 'opus', running: true, contextUsagePercent: 42 }),
      expect.objectContaining({ conversationId: 'm2', title: 'Untitled mission', running: false, backgroundWork: true }),
    ])
    expect(status.active.rails).toEqual([
      expect.objectContaining({ projectId: 'p1', railIndex: 0, name: 'Main', jobId: 'job-rail' }),
      expect.objectContaining({ projectId: 'p2', railIndex: 2, jobId: 'loop-1', loop: 'Implement' }),
    ])
    // A job already shown on a rail is not listed twice.
    expect(status.active.jobs.map((job) => job.jobId)).toEqual(['job-run'])
    expect(status.needsYou.map((item) => item.kind)).toEqual(['question', 'failed'])
    expect(status.failures).toEqual([
      expect.objectContaining({ jobId: 'job-failed', reason: 'Unit tests failed in api.', diagnosisKind: 'tests', hasAnalysis: true }),
      expect.objectContaining({ jobId: 'job-fresh', hasAnalysis: false }),
    ])
    expect(status.spendToday).toEqual({ usd: 3.456, estimated: true, estimatedUsd: 0.5, byCategory: { implementation: 2.9, missions: 0.556 } })
    expect(status.resources).toEqual({ cpuPercent: 12.5, memoryBytes: 1_000_000, processCount: 7 })
    expect(status.headline).toBe('4 running, 2 waiting for you, 2 recent failures; $3.46 spent today (partly estimated).')
    expect(status.next[0]).toEqual({ tool: 'specrails_inbox', args: { action: 'question', projectId: 'p1', runId: 'run-q' }, why: expect.any(String) })
    expect(status.next[1]).toMatchObject({ tool: 'specrails_jobs', args: { action: 'diagnose_failure', projectId: 'p2', jobId: 'job-failed' } })
    expect(status.capturedAt).toBe(NOW.toISOString())
    expect(status.etag).toMatch(/^[0-9a-f]{20}$/)
    // Short per-source timeouts.
    for (const call of vi.mocked(apiCall).mock.calls) expect(call[4]).toEqual({ timeoutMs: 2500 })
  })

  it('returns partial results when sources fail or time out, and treats a disabled agent surface as no missions', async () => {
    const timeout = new Error('The operation was aborted due to timeout'); timeout.name = 'TimeoutError'
    route({
      ...baseRoutes(),
      '/resources': new McpApiError('x', 500, { error: 'resources unavailable' }, { method: 'GET', path: '/resources' }),
      '/projects/p2/rails': timeout,
      '/agent/active-turns': undefined,
      '/inbox': { items: [] },
    })
    const status = await collectStatus(ctx, { now: NOW })
    expect(status.partial).toBe(true)
    expect(status.sources).toMatchObject({ resources: 'HTTP 500', 'rails:p2': 'timeout', missions: 'disabled', inbox: 'ok' })
    expect(status.resources).toBeNull()
    expect(status.active.missions).toEqual([])
    expect(status.active.rails).toHaveLength(1)
    expect(status.mood).toBe('failing')
  })

  it('keeps the etag stable across resource gauges and capture time, and changes it with state', async () => {
    route(baseRoutes())
    const first = await collectStatus(ctx, { now: NOW })
    route({ ...baseRoutes(), '/resources': { totals: { cpuPercent: 99, memoryBytes: 5, processCount: 1 } } })
    const second = await collectStatus(ctx, { now: new Date(NOW.getTime() + 60_000) })
    expect(second.etag).toBe(first.etag)
    route({ ...baseRoutes(), '/inbox': { items: [] } })
    expect((await collectStatus(ctx, { now: NOW })).etag).not.toBe(first.etag)
  })

  it('answers ifNoneMatch with unchanged, and otherwise a full envelope summary', async () => {
    route(baseRoutes())
    const tool = statusTools()[0]
    expect(tool.tier).toBe('read')
    const full = await tool.handler(ctx, {})
    expect(isToolResponse(full)).toBe(true)
    const fullResponse = full as unknown as { data: { etag: string }; summary: string; status: string; next: unknown[] }
    expect(fullResponse.status).toBe('needs_you')
    expect(fullResponse.summary).toContain('waiting for you')
    expect(fullResponse.next.length).toBeGreaterThan(0)
    const unchanged = await tool.handler(ctx, { ifNoneMatch: fullResponse.data.etag }) as unknown as { data: Record<string, unknown>; status: string; summary: string }
    expect(unchanged.status).toBe('unchanged')
    expect(unchanged.data).toMatchObject({ unchanged: true, etag: fullResponse.data.etag })
    expect(unchanged.summary).toBe('Nothing changed since the last check.')
    const changed = await tool.handler(ctx, { ifNoneMatch: 'stale' }) as unknown as { data: Record<string, unknown> }
    expect(changed.data.unchanged).toBeUndefined()
  })

  it.each([
    ['idle', { '/inbox': { items: [] }, '/recent-jobs?limit=30': { jobs: [] }, '/agent/active-turns': { turns: [], sessions: [] }, '/projects/p1/rails': { rails: [] }, '/projects/p2/rails': { rails: [] } }],
    ['working', { '/inbox': { items: [] }, '/recent-jobs?limit=30': { jobs: [] } }],
  ])('mood %s', async (mood, overrides) => {
    route({ ...baseRoutes(), ...overrides })
    const status = await collectStatus(ctx, { now: NOW })
    expect(status.mood).toBe(mood)
    if (mood === 'idle') {
      expect(status.headline).toBe('All quiet: nothing running and nothing waiting for you; $3.46 spent today (partly estimated).')
      expect(status.next).toEqual([{ tool: 'specrails_projects', args: { action: 'list' }, why: expect.any(String) }])
    }
  })

  it('diagnoses a failed delivery through its last run, or points at its review packet', async () => {
    const delivery = (id: string) => ({ id: `p1:failed:${id}`, projectId: 'p1', projectName: 'Shop', kind: 'failed', title: 'Spec #8', detail: 'implementation_failed', at: '2026-11-18T11:00:00Z', version: 'v', action: 'open-review', subjectId: id, diagnosis: null })
    route({ ...baseRoutes(), '/inbox': { items: [delivery('d-failed')] }, '/recent-jobs?limit=30': { jobs: [] } })
    const status = await collectStatus(ctx, { now: NOW })
    expect(status.failures).toEqual([expect.objectContaining({ jobId: 'run-b', prDeliveryId: 'd-failed', hasAnalysis: false })])
    expect(status.next[0]).toMatchObject({ tool: 'specrails_jobs', args: { action: 'diagnose_failure', jobId: 'run-b' } })
    route({ ...baseRoutes(), '/inbox': { items: [delivery('d-unknown')] }, '/recent-jobs?limit=30': { jobs: [] } })
    const unknown = await collectStatus(ctx, { now: NOW })
    expect(unknown.failures[0]).toMatchObject({ jobId: null, prDeliveryId: 'd-unknown', hasAnalysis: null })
    expect(unknown.next[0]).toMatchObject({ tool: 'specrails_rails', args: { action: 'review_packet', prDeliveryId: 'd-unknown' } })
  })

  it('caps concurrency while keeping result order', async () => {
    let inFlight = 0
    let peak = 0
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], STATUS_CONCURRENCY, async (item) => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      inFlight--
      return item * 2
    })
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18])
    expect(peak).toBeLessThanOrEqual(STATUS_CONCURRENCY)
    expect(await mapLimit([], 3, async () => 1)).toEqual([])
  })
})
