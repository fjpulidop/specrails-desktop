import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiCall, type McpToolContext, type McpToolSpec } from './types'
import { buildToolSpecs } from './catalog'
import { isToolResponse, type ToolResponse } from './envelope'
import { validateActionArgs } from './actions'
import { collectSpend, spendSummary } from './spend'
import { boardSummary, collectBoard } from './board'

vi.mock('./types', async (importOriginal) => ({ ...await importOriginal<typeof import('./types')>(), apiCall: vi.fn() }))

// The tools split out of specrails_jobs / specrails_specs and the new read tools
// (board, spend, resources), called through their handlers.

const project = { id: 'p1', name: 'Project One' }
const ctx = {
  registry: {
    getProjectRow: (id: string) => (id === 'p1' ? project : undefined),
    getContext: (id: string) => (id === 'p1' ? { project } : undefined),
    listContexts: () => [{ project }],
  },
  requestProjectId: 'p1',
} as unknown as McpToolContext

const specs = buildToolSpecs()
const tool = (name: string) => specs.find((spec) => spec.name === name) as McpToolSpec
const tierOf = (name: string, args: Record<string, unknown>) => { const t = tool(name).tier; return typeof t === 'function' ? t(args) : t }
const call = (name: string, args: Record<string, unknown>) => tool(name).handler(ctx, { projectId: 'p1', ...args })
const route = (index = 0) => vi.mocked(apiCall).mock.calls[index].slice(1)

beforeEach(() => { vi.mocked(apiCall).mockReset().mockResolvedValue({ ok: true }) })

describe('specrails_runs', () => {
  it('declares honest tiers per action and resume mode', () => {
    expect(['state', 'diagnose', 'evidence'].map((action) => tierOf('specrails_runs', { action }))).toEqual(['read', 'read', 'read'])
    expect(tierOf('specrails_runs', { action: 'resume' })).toBe('ai-spawn')
    expect(tierOf('specrails_runs', { action: 'resume', mode: 'recover' })).toBe('ai-spawn')
    expect(tierOf('specrails_runs', { action: 'resume', mode: 'approve' })).toBe('write')
    expect(['steer', 'settle', 'dismiss'].map((action) => tierOf('specrails_runs', { action }))).toEqual(['write', 'write', 'write'])
    expect(tierOf('specrails_runs', { action: 'cancel' })).toBe('destructive')
  })

  it('maps every action to its runtime route', async () => {
    await call('specrails_runs', { action: 'state' })
    await call('specrails_runs', { action: 'state', railIndex: 1 })
    await call('specrails_runs', { action: 'state', jobId: 'r 1' })
    await call('specrails_runs', { action: 'diagnose', jobId: 'r1' })
    await call('specrails_runs', { action: 'evidence', jobId: 'r1', section: 'stdout', limit: 5 })
    await call('specrails_runs', { action: 'settle', jobId: 'r1' })
    await call('specrails_runs', { action: 'dismiss', jobId: 'r1' })
    await call('specrails_runs', { action: 'cancel', jobId: 'r1' })
    expect(vi.mocked(apiCall).mock.calls.map((c) => `${c[1]} ${c[2]}`)).toEqual([
      'GET /projects/p1/agent-runtime/runs',
      'GET /projects/p1/agent-runtime/runs?railIndex=1',
      'GET /projects/p1/agent-runtime/runs/r%201',
      'GET /projects/p1/agent-runtime/runs/r1/diagnosis',
      'GET /projects/p1/agent-runtime/runs/r1/evidence?section=stdout&limit=5',
      'POST /projects/p1/agent-runtime/runs/r1/settle',
      'POST /projects/p1/agent-runtime/runs/r1/dismiss',
      'POST /projects/p1/agent-runtime/runs/r1/cancel',
    ])
  })

  it('resume folds recover and approve into a mode', async () => {
    vi.mocked(apiCall).mockImplementation(async (_c, method) => method === 'GET' ? { runs: [{ recoverableSteps: ['developer'] }] } : { accepted: true })
    await call('specrails_runs', { action: 'resume', jobId: 'r1', mode: 'recover' })
    expect(route(1)).toEqual(['POST', '/projects/p1/agent-runtime/runs/r1/resume', { recover: ['developer'] }])
    vi.mocked(apiCall).mockReset().mockResolvedValue({ accepted: true })
    await call('specrails_runs', { action: 'resume', jobId: 'r1', mode: 'approve', stepId: 'reviewer' })
    expect(route(0)[2]).toEqual({ approve: ['reviewer'] })
    await call('specrails_runs', { action: 'resume', jobId: 'r1', answer: 'yes', invalidate: ['x'] })
    expect(route(1)[2]).toEqual({ invalidate: ['x'], answer: 'yes' })
    await expect(call('specrails_runs', { action: 'resume', jobId: 'r1', mode: 'approve' })).rejects.toThrow('requires "stepId" or "approve"')
    await call('specrails_runs', { action: 'steer', jobId: 'r1', steeringText: 'Keep tests', requestId: 'op-1' })
    expect(route(2)).toEqual(['POST', '/projects/p1/agent-runtime/runs/r1/steer', { text: 'Keep tests', requestId: 'op-1' }])
  })
})

describe('specrails_background', () => {
  it('is destructive to start/kill and read to list/logs, and refuses external starts', async () => {
    expect(['start', 'list', 'logs', 'kill'].map((action) => tierOf('specrails_background', { action }))).toEqual(['destructive', 'read', 'read', 'destructive'])
    await expect(call('specrails_background', { action: 'start', command: 'npm run dev', confirmed: true })).rejects.toThrow('authenticated in-app agent turn')
    await expect(call('specrails_background', { action: 'list' })).rejects.toThrow('requires a "chatId"')
  })
})

describe('specrails_jobs after the split', () => {
  it('advertises the queue actions only and points at the new tools', () => {
    expect(tool('specrails_jobs').description).toContain('specrails_runs')
    expect(tool('specrails_jobs').description).toContain('specrails_background')
    expect(tool('specrails_jobs').description.length).toBeLessThan(1500)
  })

  it('validates per action with the fields that action takes', () => {
    expect(() => validateActionArgs('specrails_jobs', tool('specrails_jobs').actionFields, { action: 'get' }))
      .toThrow('specrails_jobs(get) missing "jobId". It takes: jobId (required), eventLimit, eventOffset.')
    expect(() => validateActionArgs('specrails_specs_write', tool('specrails_specs_write').actionFields, { action: 'create' }))
      .toThrow(/needs one of "title", "description"/)
    expect(() => validateActionArgs('specrails_jobs', tool('specrails_jobs').actionFields, { action: 'list', limit: 5 })).not.toThrow()
  })
})

describe('specrails_specs (read) and specrails_specs_write', () => {
  it('splits reads from changes with honest tiers', () => {
    for (const action of ['list', 'get', 'board', 'search', 'list_addenda']) expect(tierOf('specrails_specs', { action })).toBe('read')
    expect(tierOf('specrails_specs_write', { action: 'update' })).toBe('write')
    expect(tierOf('specrails_specs_write', { action: 'create' })).toBe('ai-spawn')
    expect(tierOf('specrails_specs_write', { action: 'delete' })).toBe('destructive')
    expect(tierOf('specrails_specs', { action: 'delete' })).toBe('destructive') // the hidden alias keeps its tier
  })

  it('list pages on the server with a cursor and returns compact rows', async () => {
    vi.mocked(apiCall).mockResolvedValue({ tickets: [{ id: 1, title: 'A', status: 'todo', description: 'long' }], total: 9, matched: 4, statusCounts: { todo: 4 }, offset: 0, limit: 1, nextOffset: 1, nextCursor: 'cur-2', revision: 3 })
    const page = await call('specrails_specs', { action: 'list', status: 'todo', limit: 1 }) as Record<string, unknown>
    expect(route(0)).toEqual(['GET', '/projects/p1/tickets?status=todo&limit=1'])
    expect(page).toMatchObject({ matched: 4, nextCursor: 'cur-2', statusCounts: { todo: 4 }, tickets: [{ id: 1, title: 'A' }] })
    expect((page.tickets as Array<Record<string, unknown>>)[0]).not.toHaveProperty('description')
    await call('specrails_specs', { action: 'list', cursor: 'cur-2' })
    expect(route(1)[1]).toBe('/projects/p1/tickets?limit=50&cursor=cur-2')
  })

  it('search needs q and board groups the backlog by status', async () => {
    await expect(call('specrails_specs', { action: 'search' })).rejects.toThrow('search requires a "q"')
    vi.mocked(apiCall).mockResolvedValue({ groups: [{ status: 'in_progress', count: 1, tickets: [{ id: 4, title: 'Four', status: 'in_progress' }] }, { status: 'todo', count: 3, tickets: [] }], total: 4, matched: 4 })
    const board = await call('specrails_specs', { action: 'board', perColumn: 2 }) as ToolResponse
    expect(isToolResponse(board)).toBe(true)
    expect(route(0)[1]).toBe('/projects/p1/tickets?groupBy=status&perGroup=2')
    expect(board.summary).toBe('Backlog of 4 specs: todo 3, in progress 1.')
    expect((board.data as { columns: Array<{ status: string }> }).columns.map((column) => column.status).slice(0, 4)).toEqual(['draft', 'todo', 'in_progress', 'on_review'])
  })
})

describe('specrails_board', () => {
  it('combines columns, rails with what runs on them, and the queue', async () => {
    vi.mocked(apiCall).mockImplementation(async (_c, _m, url) => {
      if (String(url).includes('groupBy=status')) return { groups: [{ status: 'todo', count: 2, tickets: [{ id: 7, title: 'Seven', status: 'todo' }] }], total: 2, matched: 2 }
      if (String(url).endsWith('/rails')) return {
        rails: [{ railIndex: 0, name: 'API', availability: 'busy', ticketIds: [7] }, { railIndex: 1, availability: 'free', ticketIds: [] }, { railIndex: 2, availability: 'pending_decision', ticketIds: [3] }, { railIndex: 3, availability: 'pending_decision', ticketIds: [5] }],
        activeLoopRuns: { 0: { loopRunId: 'run-1', loopName: 'Implement', provider: 'codex' } },
        prDeliveries: { 2: { id: 'd-1', decision: 'on_review', ticketIds: [3] }, 3: { id: 'd-2', decision: 'implementation_failed', ticketIds: [5] } },
      }
      return { jobs: [{ id: 'q1', status: 'queued' }, { id: 'j2', status: 'running', command: '/spawn' }], paused: false, activeJobId: 'j2' }
    })
    const board = await collectBoard(ctx, 'p1')
    expect(board.rails.map((rail) => rail.label)).toEqual(['API', 'Rail 2', 'Rail 3', 'Rail 4'])
    expect(board.running).toEqual([
      expect.objectContaining({ rail: 'API', kind: 'loop', jobId: 'run-1', provider: 'codex' }),
      expect.objectContaining({ kind: 'job', jobId: 'j2' }),
    ])
    expect(board.queue).toEqual({ queued: 1, paused: false, activeJobId: 'j2' })
    expect(boardSummary(board)).toBe('Project One: 2 specs (todo 2); 4 rails, 2 running, 1 free, 1 awaiting review, 1 failed delivery awaiting a decision; 1 queued.')
    const response = await call('specrails_board', {}) as ToolResponse
    expect(response.next?.[0]).toMatchObject({ tool: 'specrails_rails', args: { action: 'review_packet', prDeliveryId: 'd-1' } })
  })

  it('points at a failed delivery when nothing awaits review', async () => {
    const { boardNext } = await import('./board')
    const next = boardNext({ projectId: 'p1', projectName: 'P', columns: [], total: 0, running: [], queue: null, partial: false, sources: {},
      rails: [{ railIndex: 4, label: 'Rail 5', availability: 'pending_decision', ticketIds: [1], running: null, delivery: { id: 'd-9', decision: 'implementation_failed' } }] })
    expect(next[0]).toMatchObject({ tool: 'specrails_rails', args: { action: 'review_packet', prDeliveryId: 'd-9', projectId: 'p1' } })
  })

  it('stays useful when a source fails', async () => {
    vi.mocked(apiCall).mockImplementation(async (_c, _m, url) => { if (String(url).endsWith('/rails')) throw new Error('rails down'); return { groups: [], total: 0, jobs: [] } })
    const board = await collectBoard(ctx, 'p1')
    expect(board).toMatchObject({ partial: true, sources: { rails: 'rails down', backlog: 'ok', queue: 'ok' } })
    expect(boardSummary(board)).toContain('rails unavailable')
  })
})

describe('specrails_spend', () => {
  const caps = { caps: [{ scope: 'desktop', period: 'day', budgetUsd: 10, spentUsd: 10.5, exhausted: true, resetsAt: '2026-11-19T00:00:00Z' }, { scope: 'desktop', period: 'month', budgetUsd: 200, spentUsd: 50, exhausted: false }], projection: { estimate: true, projectedUsd: 120 } }

  it('reads today app-wide: categories incl. missions, caps and the costliest projects', async () => {
    vi.mocked(apiCall).mockImplementation(async (_c, _m, url) => String(url).startsWith('/analytics')
      ? { kpi: { totalCostUsd: 12.34567, estimatedCostUsd: 2, totalJobs: 7 }, byCategory: [{ category: 'missions', costUsd: 8 }, { category: 'implementation', costUsd: 4.3 }, { category: 'code', costUsd: 0 }], projectBreakdown: [{ projectId: 'p2', projectName: 'Two', totalCostUsd: 3 }, { projectId: 'app:home-blueprint', projectName: 'Home & Blueprint', totalCostUsd: 20 }, { projectId: 'p1', projectName: 'One', totalCostUsd: 9, totalJobs: 5 }] }
      : caps)
    const spend = await collectSpend(ctx, {}, new Date(2026, 10, 18, 15))
    expect(String(vi.mocked(apiCall).mock.calls[0][2])).toMatch(/^\/analytics\?period=custom&from=.*&to=/)
    expect(spend).toMatchObject({ scope: 'app', totalUsd: 12.3457, estimatedUsd: 2, runs: 7, byCategory: { missions: 8, implementation: 4.3 } })
    expect(spend.top.map((item) => item.title)).toEqual(['Home & Blueprint', 'One', 'Two'])
    const response = await tool('specrails_spend').handler(ctx, {}) as ToolResponse
    expect(response.next?.[0]).toMatchObject({ tool: 'specrails_spend', args: { projectId: 'p1' } })
    expect(spend.exhausted).toHaveLength(1)
    expect(spend.caps[1].utilizationPct).toBe(25)
    expect(spendSummary(spend)).toBe('Spent $12 ($2.00 estimated) today across 7 jobs. Most went to missions ($8.00). The desktop day cap of $10 is exhausted: launches are refused until it resets or is raised.')
  })

  it('reads one project over a period with its top specs and missions', async () => {
    vi.mocked(apiCall).mockImplementation(async (_c, _m, url) => String(url).includes('/spending')
      ? { summary: { totalCostUsd: 5, totalEstimatedCostUsd: 0, totalRuns: 3 }, byCategory: [{ category: 'specs', costUsd: 1 }], topTickets: [{ ticketId: 4, ticketTitle: 'Login', totalCostUsd: 2, totalRuns: 2 }], agentMissions: { topConversations: [{ conversationId: 'c1', title: 'Plan', costUsd: 3, turns: 4 }] } }
      : { caps: [] })
    const spend = await collectSpend(ctx, { projectId: 'p1', period: '7d' })
    expect(String(vi.mocked(apiCall).mock.calls[0][2])).toMatch(/^\/projects\/p1\/spending\?period=7d&tzOffsetMinutes=/)
    expect(spend.top).toEqual([
      { kind: 'mission', id: 'c1', title: 'Plan', usd: 3, runs: 4 },
      { kind: 'spec', id: 4, title: 'Login', usd: 2, runs: 2 },
    ])
    expect(spendSummary(spend)).toBe('Spent $5.00 in this project in the last 7 days across 3 runs. Most went to specs ($1.00).')
    await expect(collectSpend(ctx, { period: 'custom' })).rejects.toThrow('requires from and/or to')
  })
})

describe('specrails_resources', () => {
  it('summarizes the app-wide view by category', async () => {
    vi.mocked(apiCall).mockResolvedValue({ supported: true, totals: { cpuPercent: 42.4, memoryBytes: 3 * 1024 ** 3, processCount: 12 }, categories: [
      { id: 'missions', cpuPercent: 30, memoryBytes: 2 * 1024 ** 3, processCount: 5, items: [{ label: 'Mission A', chatId: 'c1', projectId: 'p1', cpuPercent: 30, memoryBytes: 1, processCount: 5 }] },
      { id: 'git', cpuPercent: 0, memoryBytes: 0, processCount: 0, items: [] },
    ] })
    const result = await call('specrails_resources', {}) as ToolResponse
    expect(route(0)).toEqual(['GET', '/resources'])
    expect(result.summary).toBe('Everything Specrails launched uses 42% CPU and 3.0 GB across 12 processes. Most memory: missions (2.0 GB).')
    expect((result.data as { categories: unknown[] }).categories).toHaveLength(1)
    expect(result.next?.[0]).toMatchObject({ tool: 'specrails_resources', args: { conversationId: 'c1', projectId: 'p1' } })
  })

  it('reads one mission, resolving its project from the pin', async () => {
    vi.mocked(apiCall).mockImplementation(async (_c, _m, url) => String(url).startsWith('/agent/')
      ? { conversation: { pinned_project_id: 'p1' } }
      : { supported: true, totals: { cpuPercent: 5, memoryBytes: 200 * 1024 ** 2, processCount: 2 }, entries: [{ pid: 1 }], history: [], worktree: { path: '/w', disk: { status: 'done', bytes: 1024 ** 3 } } })
    const result = await tool('specrails_resources').handler({ ...ctx, requestProjectId: undefined }, { conversationId: 'c 1' }) as ToolResponse
    expect(route(1)).toEqual(['GET', '/projects/p1/missions/c%201/resources'])
    expect(result.summary).toBe('This mission uses 5% CPU and 200 MB across 2 processes. Its worktree is 1.0 GB on disk.')
  })
})
