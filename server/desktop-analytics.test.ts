import { describe, it, expect, vi } from 'vitest'
import { getDesktopAnalytics, getDesktopTodayStats, getDesktopRecentJobs } from './desktop-analytics'
import { initDb } from './db'
import { recordInvocation, type Surface } from './ai-invocations'
import { initDesktopDb, recordAgentInvocation } from './desktop-db'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { DbInstance } from './db'

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface JobSeed { costUsd: number | null; status: string; startedAt?: string; estimated?: boolean }
interface InvSeed { costUsd: number | null; surface: Surface; startedAt?: string; estimated?: boolean; status?: 'success' | 'failed' | 'aborted' }

// A job entry seeds BOTH a jobs row (for the job-COUNT metrics) and a matching
// ai_invocations `surface='job'` row (for COST — MED-8 sources cost from
// ai_invocations, not the jobs table). `extraInvocations` seeds non-job
// billable surfaces so tests can prove they now feed the app-level KPI.
function makeProjectDb(jobs: JobSeed[], extraInvocations: InvSeed[] = []): DbInstance {
  const db = initDb(':memory:')
  const today = new Date().toISOString().slice(0, 10)
  let i = 0
  for (const job of jobs) {
    const startedAt = job.startedAt ?? `${today}T10:00:00.000Z`
    db.prepare(`
      INSERT INTO jobs (id, command, status, started_at, finished_at, total_cost_usd, total_cost_usd_estimated, duration_ms)
      VALUES (?, 'implement', ?, ?, ?, ?, ?, 1000)
    `).run(
      crypto.randomUUID(),
      job.status,
      startedAt,
      `${today}T10:01:00.000Z`,
      job.costUsd,
      job.estimated ? 1 : 0
    )
    recordInvocation(db, {
      id: `job-inv-${i++}`,
      project_id: 'p',
      provider: 'claude',
      surface: 'job',
      status: job.status === 'completed' ? 'success' : 'failed',
      started_at: startedAt,
      total_cost_usd: job.costUsd,
      total_cost_usd_estimated: job.estimated ? 1 : 0,
    } as Parameters<typeof recordInvocation>[1])
  }
  for (const inv of extraInvocations) {
    recordInvocation(db, {
      id: `extra-inv-${i++}`,
      project_id: 'p',
      provider: 'claude',
      surface: inv.surface,
      status: inv.status ?? 'success',
      started_at: inv.startedAt ?? `${today}T10:00:00.000Z`,
      total_cost_usd: inv.costUsd,
      total_cost_usd_estimated: inv.estimated ? 1 : 0,
    } as Parameters<typeof recordInvocation>[1])
  }
  return db
}

function makeRegistry(
  contexts: Array<{ id: string; name: string; db: DbInstance }>,
  desktopDb: DbInstance | Record<string, never> = {}
): ProjectRegistry {
  const ctxMap = new Map(
    contexts.map((c) => [
      c.id,
      {
        project: { id: c.id, name: c.name, slug: c.name, path: '/tmp', db_path: ':memory:', added_at: '', last_seen_at: '' },
        db: c.db,
        queueManager: {} as any,
        chatManager: {} as any,
        setupManager: {} as any,
        proposalManager: {} as any,
        broadcast: vi.fn(),
      } satisfies ProjectContext,
    ])
  )

  return {
    desktopDb: desktopDb as any,
    getContext: (id) => ctxMap.get(id),
    getContextByPath: () => undefined,
    addProject: vi.fn() as any,
    removeProject: vi.fn(),
    touchProject: vi.fn(),
    listContexts: () => Array.from(ctxMap.values()),
  } as unknown as ProjectRegistry
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getDesktopAnalytics', () => {
  it('returns zero KPIs when no projects are registered', () => {
    const registry = makeRegistry([])
    const result = getDesktopAnalytics(registry, { period: '7d' })

    expect(result.kpi.totalJobs).toBe(0)
    expect(result.kpi.totalCostUsd).toBe(0)
    expect(result.kpi.successRate).toBe(0)
    expect(result.projectBreakdown).toEqual([])
    expect(result.costTimeline).toEqual([])
  })

  it('aggregates KPIs across multiple projects', () => {
    const db1 = makeProjectDb([
      { costUsd: 0.01, status: 'completed' },
      { costUsd: 0.02, status: 'completed' },
    ])
    const db2 = makeProjectDb([
      { costUsd: 0.03, status: 'failed' },
    ])
    const registry = makeRegistry([
      { id: 'p1', name: 'Project One', db: db1 },
      { id: 'p2', name: 'Project Two', db: db2 },
    ])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    expect(result.kpi.totalJobs).toBe(3)
    // All three ai_invocations rows are authoritative (estimated=0) → all count.
    expect(result.kpi.totalCostUsd).toBeCloseTo(0.06, 5)
    expect(result.kpi.successRate).toBeCloseTo(2 / 3, 5)
  })

  it('returns one entry per project in projectBreakdown', () => {
    const db1 = makeProjectDb([{ costUsd: 0.05, status: 'completed' }])
    const db2 = makeProjectDb([{ costUsd: 0.02, status: 'failed' }])
    const registry = makeRegistry([
      { id: 'p1', name: 'Alpha', db: db1 },
      { id: 'p2', name: 'Beta', db: db2 },
    ])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    expect(result.projectBreakdown).toHaveLength(2)
    // Sorted by cost descending
    expect(result.projectBreakdown[0].projectName).toBe('Alpha')
    expect(result.projectBreakdown[1].projectName).toBe('Beta')
  })

  it('merges cost timeline across projects by date', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db1 = makeProjectDb([{ costUsd: 0.01, status: 'completed', startedAt: `${today}T09:00:00.000Z` }])
    const db2 = makeProjectDb([{ costUsd: 0.02, status: 'completed', startedAt: `${today}T11:00:00.000Z` }])
    const registry = makeRegistry([
      { id: 'p1', name: 'Alpha', db: db1 },
      { id: 'p2', name: 'Beta', db: db2 },
    ])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    // Both jobs on same date — timeline should have one entry for today with sum
    const todayEntry = result.costTimeline.find((e) => e.date === today)
    expect(todayEntry).toBeDefined()
    expect(todayEntry!.costUsd).toBeCloseTo(0.03, 5)
  })

  it('includes period label in response', () => {
    const registry = makeRegistry([])
    const result = getDesktopAnalytics(registry, { period: '30d' })
    expect(result.period.label).toBe('Last 30 days')
  })

  it('B42: period=custom with malformed dates does not throw (RangeError guard)', () => {
    const registry = makeRegistry([{ id: 'p1', name: 'A', db: makeProjectDb([{ costUsd: 0.01, status: 'completed' }]) }])
    // Garbage from/to — previously flowed into new Date(...).toISOString() → 500.
    expect(() => getDesktopAnalytics(registry, { period: 'custom', from: 'not-a-date', to: 'xx' })).not.toThrow()
    // A valid single bound is honored without throwing either.
    expect(() => getDesktopAnalytics(registry, { period: 'custom', from: '2026-01-01', to: 'garbage' })).not.toThrow()
  })

  it('jobsToday and costToday reflect only today\'s data', () => {
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

    const db = makeProjectDb([
      { costUsd: 0.10, status: 'completed', startedAt: `${today}T10:00:00.000Z` },
      { costUsd: 0.20, status: 'completed', startedAt: `${yesterday}T10:00:00.000Z` },
    ])
    const registry = makeRegistry([{ id: 'p1', name: 'Project', db }])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    expect(result.kpi.jobsToday).toBe(1)
    expect(result.kpi.costToday).toBeCloseTo(0.10, 5)
  })

  it('reports unavailable coverage instead of treating Kimi NULL cost as zero', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb([
      { costUsd: null, status: 'completed', startedAt: `${today}T10:00:00.000Z` },
    ])
    const registry = makeRegistry([{ id: 'p1', name: 'Kimi', db }])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    expect(result.kpi).toMatchObject({
      totalCostUsd: 0,
      pricedRuns: 0,
      unpricedRuns: 1,
      pricedTodayRuns: 0,
      unpricedTodayRuns: 1,
    })
    expect(result.projectBreakdown[0]).toMatchObject({
      projectName: 'Kimi',
      totalCostUsd: 0,
      pricedRuns: 0,
      unpricedRuns: 1,
    })
    expect(result.costTimeline.find((row) => row.date === today)?.unpricedCount).toBe(1)
  })
})

// ─── MED-8: all-surface + agent-chat cost sourcing ────────────────────────────
// The app-level KPIs must aggregate ai_invocations across ALL billable surfaces
// (explore/quick-spec/ai-edit/file-summary/…) and ALL statuses, plus the
// app-level agent_invocations spend — not just the jobs table.

describe('getDesktopAnalytics — MED-8 all-surface sourcing', () => {
  it('counts non-job surfaces (explore/quick-spec/ai-edit/file-summary) in the KPI', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb(
      [{ costUsd: 0.10, status: 'completed', startedAt: `${today}T10:00:00.000Z` }],
      [
        { costUsd: 0.03, surface: 'explore-spec', startedAt: `${today}T10:05:00.000Z` },
        { costUsd: 0.02, surface: 'quick-spec', startedAt: `${today}T10:06:00.000Z` },
        { costUsd: 0.04, surface: 'ai-edit', startedAt: `${today}T10:07:00.000Z` },
        { costUsd: 0.01, surface: 'file-summary', startedAt: `${today}T10:08:00.000Z` },
      ]
    )
    const registry = makeRegistry([{ id: 'p1', name: 'Proj', db }])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    // 0.10 job + 0.03 + 0.02 + 0.04 + 0.01 = 0.20 — none invisible.
    expect(result.kpi.totalCostUsd).toBeCloseTo(0.20, 5)
    expect(result.kpi.costToday).toBeCloseTo(0.20, 5)
    const todayEntry = result.costTimeline.find((e) => e.date === today)
    expect(todayEntry!.costUsd).toBeCloseTo(0.20, 5)
    // Job COUNT metrics remain jobs-table scoped (non-job surfaces don't inflate them).
    expect(result.kpi.totalJobs).toBe(1)
  })

  it('counts every status (a failed/aborted invocation still contributes cost)', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb(
      [
        { costUsd: 0.10, status: 'completed', startedAt: `${today}T10:00:00.000Z` },
        { costUsd: 0.07, status: 'failed', startedAt: `${today}T10:10:00.000Z` }, // authoritative failed → counted
        { costUsd: 0.50, status: 'failed', estimated: true, startedAt: `${today}T10:30:00.000Z` }, // estimated failed → NOW counted (MED-8)
      ],
      [
        { costUsd: 0.02, surface: 'explore-spec', status: 'aborted', estimated: true, startedAt: `${today}T10:40:00.000Z` },
      ]
    )
    const registry = makeRegistry([{ id: 'p1', name: 'Proj', db }])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    expect(result.kpi.totalCostUsd).toBeCloseTo(0.10 + 0.07 + 0.50 + 0.02, 5) // 0.69
    expect(result.kpi.estimatedCostUsd).toBeCloseTo(0.50 + 0.02, 5)           // 0.52
    expect(result.kpi.costToday).toBeCloseTo(0.69, 5)
    expect(result.kpi.estimatedCostToday).toBeCloseTo(0.52, 5)
  })

  it('folds app-level agent-chat spend into the grand totals', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb([{ costUsd: 0.10, status: 'completed', startedAt: `${today}T10:00:00.000Z` }])
    const desktopDb = initDesktopDb(':memory:')
    recordAgentInvocation(desktopDb, {
      id: 'agent-1', conversation_id: 'c1', provider: 'claude', model: 'sonnet',
      status: 'success', started_at: `${today}T12:00:00.000Z`, total_cost_usd: 0.05,
    } as Parameters<typeof recordAgentInvocation>[1])
    const registry = makeRegistry([{ id: 'p1', name: 'Proj', db }], desktopDb)

    const result = getDesktopAnalytics(registry, { period: '7d' })

    // 0.10 job + 0.05 agent-chat.
    expect(result.kpi.totalCostUsd).toBeCloseTo(0.15, 5)
    expect(result.kpi.costToday).toBeCloseTo(0.15, 5)
  })

  it('tolerates a registry whose desktopDb lacks the agent_invocations table', () => {
    const db = makeProjectDb([{ costUsd: 0.10, status: 'completed' }])
    // desktopDb defaults to a bare {} (no .prepare) — must not throw.
    const registry = makeRegistry([{ id: 'p1', name: 'Proj', db }])
    expect(() => getDesktopAnalytics(registry, { period: '7d' })).not.toThrow()
    const result = getDesktopAnalytics(registry, { period: '7d' })
    expect(result.kpi.totalCostUsd).toBeCloseTo(0.10, 5)
  })
})

// ─── Estimated-cost split (codex/gemini) ──────────────────────────────────────

describe('getDesktopAnalytics — estimated cost split', () => {
  it('splits estimated (codex/gemini) cost out of the grand total KPI', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb([
      { costUsd: 0.10, status: 'completed', startedAt: `${today}T10:00:00.000Z` }, // claude (authoritative)
      { costUsd: 0.04, status: 'completed', estimated: true, startedAt: `${today}T11:00:00.000Z` }, // codex (estimated)
    ])
    const registry = makeRegistry([{ id: 'p1', name: 'Mixed', db }])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    expect(result.kpi.totalCostUsd).toBeCloseTo(0.14, 5)
    expect(result.kpi.estimatedCostUsd).toBeCloseTo(0.04, 5)
    expect(result.kpi.includesEstimated).toBe(true)
    expect(result.kpi.estimatedCostToday).toBeCloseTo(0.04, 5)
  })

  it('claude-only project reports zero estimated and includesEstimated=false', () => {
    const db = makeProjectDb([
      { costUsd: 0.10, status: 'completed' },
      { costUsd: 0.20, status: 'completed' },
    ])
    const registry = makeRegistry([{ id: 'p1', name: 'Claude', db }])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    expect(result.kpi.totalCostUsd).toBeCloseTo(0.30, 5)
    expect(result.kpi.estimatedCostUsd).toBe(0)
    expect(result.kpi.includesEstimated).toBe(false)
    expect(result.kpi.estimatedCostToday).toBe(0)
  })

  it('per-project breakdown row carries an estimatedCostUsd split', () => {
    const db = makeProjectDb([
      { costUsd: 0.05, status: 'completed' }, // authoritative
      { costUsd: 0.03, status: 'completed', estimated: true }, // estimated
    ])
    const registry = makeRegistry([{ id: 'p1', name: 'Mixed', db }])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    expect(result.projectBreakdown[0].totalCostUsd).toBeCloseTo(0.08, 5)
    expect(result.projectBreakdown[0].estimatedCostUsd).toBeCloseTo(0.03, 5)
  })

  it('cost timeline carries a per-day estimatedCostUsd split', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb([
      { costUsd: 0.06, status: 'completed', startedAt: `${today}T09:00:00.000Z` },
      { costUsd: 0.02, status: 'completed', estimated: true, startedAt: `${today}T12:00:00.000Z` },
    ])
    const registry = makeRegistry([{ id: 'p1', name: 'Mixed', db }])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    const todayEntry = result.costTimeline.find((e) => e.date === today)
    expect(todayEntry).toBeDefined()
    expect(todayEntry!.costUsd).toBeCloseTo(0.08, 5)
    expect(todayEntry!.estimatedCostUsd).toBeCloseTo(0.02, 5)
  })
})

describe('getDesktopTodayStats', () => {
  it('returns zeros when no projects', () => {
    const registry = makeRegistry([])
    const stats = getDesktopTodayStats(registry)
    expect(stats.costToday).toBe(0)
    expect(stats.jobsToday).toBe(0)
  })

  it('aggregates today stats from all projects', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db1 = makeProjectDb([{ costUsd: 0.05, status: 'completed', startedAt: `${today}T10:00:00.000Z` }])
    const db2 = makeProjectDb([{ costUsd: 0.07, status: 'completed', startedAt: `${today}T11:00:00.000Z` }])
    const registry = makeRegistry([
      { id: 'p1', name: 'A', db: db1 },
      { id: 'p2', name: 'B', db: db2 },
    ])

    const stats = getDesktopTodayStats(registry)
    expect(stats.jobsToday).toBe(2)
    expect(stats.costToday).toBeCloseTo(0.12, 5)
  })

  it('exposes Kimi today-cost coverage instead of an authoritative zero', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb([
      { costUsd: null, status: 'completed', startedAt: `${today}T10:00:00.000Z` },
    ])
    const stats = getDesktopTodayStats(makeRegistry([{ id: 'p1', name: 'Kimi', db }]))
    expect(stats).toMatchObject({
      costToday: 0,
      pricedRuns: 0,
      unpricedRuns: 1,
    })
  })

  it('MED-8: counts all surfaces + all statuses in costToday', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb(
      [
        { costUsd: 0.08, status: 'completed', startedAt: `${today}T10:00:00.000Z` }, // claude
        { costUsd: 0.99, status: 'failed', estimated: true, startedAt: `${today}T11:00:00.000Z` }, // NOW counted
      ],
      [{ costUsd: 0.05, surface: 'explore-spec', estimated: true, startedAt: `${today}T10:30:00.000Z` }]
    )
    const registry = makeRegistry([{ id: 'p1', name: 'Mixed', db }])

    const stats = getDesktopTodayStats(registry)

    expect(stats.costToday).toBeCloseTo(0.08 + 0.99 + 0.05, 5) // 1.12
    expect(stats.estimatedCostToday).toBeCloseTo(0.99 + 0.05, 5) // 1.04
    expect(stats.includesEstimated).toBe(true)
    expect(stats.jobsToday).toBe(2) // job-count metric stays jobs-table scoped
  })

  it('folds app-level agent-chat spend into costToday', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb([{ costUsd: 0.08, status: 'completed', startedAt: `${today}T10:00:00.000Z` }])
    const desktopDb = initDesktopDb(':memory:')
    recordAgentInvocation(desktopDb, {
      id: 'agent-1', conversation_id: 'c1', provider: 'claude', model: 'sonnet',
      status: 'success', started_at: `${today}T12:00:00.000Z`, total_cost_usd: 0.06,
    } as Parameters<typeof recordAgentInvocation>[1])
    const registry = makeRegistry([{ id: 'p1', name: 'Proj', db }], desktopDb)

    const stats = getDesktopTodayStats(registry)
    expect(stats.costToday).toBeCloseTo(0.14, 5)
  })

  it('claude-only project reports zero estimated today', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb([{ costUsd: 0.05, status: 'completed', startedAt: `${today}T10:00:00.000Z` }])
    const registry = makeRegistry([{ id: 'p1', name: 'Claude', db }])

    const stats = getDesktopTodayStats(registry)

    expect(stats.estimatedCostToday).toBe(0)
    expect(stats.includesEstimated).toBe(false)
  })
})

// ─── getDesktopRecentJobs ─────────────────────────────────────────────────────────

describe('getDesktopRecentJobs', () => {
  it('returns empty list when no projects', () => {
    const registry = makeRegistry([])
    expect(getDesktopRecentJobs(registry)).toEqual([])
  })

  it('returns jobs sorted by started_at descending', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb([
      { costUsd: 0.01, status: 'completed', startedAt: `${today}T08:00:00.000Z` },
      { costUsd: 0.02, status: 'completed', startedAt: `${today}T10:00:00.000Z` },
    ])
    const registry = makeRegistry([{ id: 'p1', name: 'Proj', db }])
    const jobs = getDesktopRecentJobs(registry)
    expect(jobs[0].started_at > jobs[1].started_at).toBe(true)
  })

  it('merges jobs across projects and respects limit', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db1 = makeProjectDb([
      { costUsd: 0.01, status: 'completed', startedAt: `${today}T09:00:00.000Z` },
      { costUsd: 0.01, status: 'completed', startedAt: `${today}T11:00:00.000Z` },
    ])
    const db2 = makeProjectDb([
      { costUsd: 0.01, status: 'running', startedAt: `${today}T10:00:00.000Z` },
    ])
    const registry = makeRegistry([
      { id: 'p1', name: 'Alpha', db: db1 },
      { id: 'p2', name: 'Beta', db: db2 },
    ])
    const jobs = getDesktopRecentJobs(registry, 2)
    expect(jobs).toHaveLength(2)
    expect(jobs[0].started_at >= jobs[1].started_at).toBe(true)
  })

  it('includes projectId and projectName on each job', () => {
    const db = makeProjectDb([{ costUsd: 0.01, status: 'completed' }])
    const registry = makeRegistry([{ id: 'proj-1', name: 'MyProject', db }])
    const jobs = getDesktopRecentJobs(registry)
    expect(jobs[0].projectId).toBe('proj-1')
    expect(jobs[0].projectName).toBe('MyProject')
  })
})

// ─── getDesktopAnalytics — buildWhere edge cases ──────────────────────────────────

describe('getDesktopAnalytics — custom period edge cases', () => {
  it('handles custom period with only from date', () => {
    const db = makeProjectDb([{ costUsd: 0.05, status: 'completed' }])
    const registry = makeRegistry([{ id: 'p1', name: 'Proj', db }])
    const today = new Date().toISOString().slice(0, 10)
    const result = getDesktopAnalytics(registry, { period: 'custom', from: today })
    expect(result.kpi.totalJobs).toBeGreaterThanOrEqual(0)
  })

  it('handles custom period with only to date', () => {
    const db = makeProjectDb([{ costUsd: 0.05, status: 'completed' }])
    const registry = makeRegistry([{ id: 'p1', name: 'Proj', db }])
    const today = new Date().toISOString().slice(0, 10)
    const result = getDesktopAnalytics(registry, { period: 'custom', to: today })
    expect(result.kpi.totalJobs).toBeGreaterThanOrEqual(0)
  })
})
