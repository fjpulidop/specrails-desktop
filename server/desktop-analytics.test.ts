import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getDesktopAnalytics, getDesktopTodayStats, getDesktopRecentJobs } from './desktop-analytics'
import { initDb } from './db'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import type { DbInstance } from './db'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProjectDb(
  jobs: Array<{ costUsd: number; status: string; startedAt?: string; estimated?: boolean }>
): DbInstance {
  const db = initDb(':memory:')
  const today = new Date().toISOString().slice(0, 10)
  for (const job of jobs) {
    db.prepare(`
      INSERT INTO jobs (id, command, status, started_at, finished_at, total_cost_usd, total_cost_usd_estimated, duration_ms)
      VALUES (?, 'implement', ?, ?, ?, ?, ?, 1000)
    `).run(
      crypto.randomUUID(),
      job.status,
      job.startedAt ?? `${today}T10:00:00.000Z`,
      `${today}T10:01:00.000Z`,
      job.costUsd,
      job.estimated ? 1 : 0
    )
  }
  return db
}

function makeRegistry(contexts: Array<{ id: string; name: string; db: DbInstance }>): ProjectRegistry {
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
    desktopDb: {} as any,
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
    // BUG-28 (review-corrected): the $0.03 failed job is AUTHORITATIVE (claude,
    // estimated=0) so its real billed cost is still counted — only the ESTIMATED
    // cost of a failed codex/gemini job would be dropped. All three count.
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
})

// ─── Estimated-cost split (codex/gemini) ──────────────────────────────────────
// BUG-ANALYTICS-24/25/26/28: jobs.total_cost_usd_estimated=1 marks rate-card
// estimates (codex/gemini). The HOME rollup must surface that split and must
// NOT count failed/aborted jobs in the cost SUM.

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

  it('BUG-28 (review-corrected): keeps authoritative cost on failed jobs, drops only the estimated cost of failed/canceled jobs', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb([
      { costUsd: 0.10, status: 'completed', startedAt: `${today}T10:00:00.000Z` },                    // claude completed (auth) → kept
      { costUsd: 0.07, status: 'failed', startedAt: `${today}T10:10:00.000Z` },                       // claude FAILED (auth, real billed) → kept
      { costUsd: 0.50, status: 'failed', estimated: true, startedAt: `${today}T10:30:00.000Z` },      // codex failed (estimate, phantom) → dropped
      { costUsd: 0.40, status: 'canceled', estimated: true, startedAt: `${today}T10:45:00.000Z` },    // codex canceled (estimate) → dropped
      { costUsd: 0.04, status: 'completed', estimated: true, startedAt: `${today}T11:00:00.000Z` },   // codex completed (estimate) → kept
    ])
    const registry = makeRegistry([{ id: 'p1', name: 'Proj', db }])

    const result = getDesktopAnalytics(registry, { period: '7d' })

    // Authoritative (claude, estimated=0) cost counts on EVERY status incl.
    // failed; only the ESTIMATED cost of a failed/canceled codex job is dropped.
    expect(result.kpi.totalCostUsd).toBeCloseTo(0.10 + 0.07 + 0.04, 5) // 0.21
    expect(result.kpi.estimatedCostUsd).toBeCloseTo(0.04, 5)           // only the completed-codex estimate
    expect(result.kpi.costToday).toBeCloseTo(0.21, 5)
    expect(result.kpi.estimatedCostToday).toBeCloseTo(0.04, 5)
    // But every run is still counted.
    expect(result.kpi.totalJobs).toBe(5)
    expect(result.kpi.jobsToday).toBe(5)
    const todayEntry = result.costTimeline.find((e) => e.date === today)
    expect(todayEntry!.costUsd).toBeCloseTo(0.21, 5)
    expect(todayEntry!.estimatedCostUsd).toBeCloseTo(0.04, 5)
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

  it('BUG-27: splits estimated cost out and excludes failed/aborted from costToday', () => {
    const today = new Date().toISOString().slice(0, 10)
    const db = makeProjectDb([
      { costUsd: 0.08, status: 'completed', startedAt: `${today}T10:00:00.000Z` }, // claude
      { costUsd: 0.05, status: 'completed', estimated: true, startedAt: `${today}T10:30:00.000Z` }, // codex
      { costUsd: 0.99, status: 'failed', estimated: true, startedAt: `${today}T11:00:00.000Z` }, // excluded
    ])
    const registry = makeRegistry([{ id: 'p1', name: 'Mixed', db }])

    const stats = getDesktopTodayStats(registry)

    expect(stats.costToday).toBeCloseTo(0.13, 5)
    expect(stats.estimatedCostToday).toBeCloseTo(0.05, 5)
    expect(stats.includesEstimated).toBe(true)
    expect(stats.jobsToday).toBe(3)
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

