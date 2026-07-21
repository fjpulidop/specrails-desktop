import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import {
  recordInvocation,
  updateTicketIdForConversation,
  listInvocationsForConversation,
  getTicketSpendingSummary,
  InvalidSurfaceError,
} from './ai-invocations'

function fixedInput(overrides: Partial<Parameters<typeof recordInvocation>[1]> = {}) {
  return {
    id: 'inv-1',
    project_id: 'p1',
    provider: 'claude',
    surface: 'job' as const,
    status: 'success' as const,
    started_at: '2026-05-06T10:00:00Z',
    finished_at: '2026-05-06T10:00:30Z',
    model: 'claude-sonnet-4-6',
    tokens_in: 100,
    tokens_out: 50,
    total_cost_usd: 0.1,
    num_turns: 1,
    duration_ms: 30000,
    ...overrides,
  }
}

describe('ai-invocations', () => {
  let db: DbInstance

  beforeEach(() => {
    db = initDb(':memory:')
  })

  it('round-trips an insert', () => {
    recordInvocation(db, fixedInput())
    const row = db.prepare('SELECT * FROM ai_invocations WHERE id = ?').get('inv-1') as Record<string, unknown>
    expect(row.surface).toBe('job')
    expect(row.total_cost_usd).toBe(0.1)
    expect(row.tokens_in).toBe(100)
    expect(row.status).toBe('success')
  })

  it('rejects invalid surface', () => {
    expect(() =>
      recordInvocation(db, fixedInput({ surface: 'chat' as unknown as 'job' }))
    ).toThrow(InvalidSurfaceError)
  })

  it('persists NULL metrics for failed status', () => {
    recordInvocation(db, {
      id: 'inv-2',
      project_id: 'p1',
      provider: 'claude',
      surface: 'job',
      status: 'failed',
      started_at: '2026-05-06T10:00:00Z',
    })
    const row = db.prepare('SELECT * FROM ai_invocations WHERE id = ?').get('inv-2') as Record<string, unknown>
    expect(row.status).toBe('failed')
    expect(row.total_cost_usd).toBeNull()
    expect(row.tokens_in).toBeNull()
    expect(row.num_turns).toBeNull()
  })

  it('back-fills ticket_id for a conversation', () => {
    recordInvocation(db, fixedInput({ id: 'a', surface: 'explore-spec', conversation_id: 'c1', ticket_id: null }))
    recordInvocation(db, fixedInput({ id: 'b', surface: 'explore-spec', conversation_id: 'c1', ticket_id: null }))
    recordInvocation(db, fixedInput({ id: 'c', surface: 'explore-spec', conversation_id: 'c2', ticket_id: null }))
    const changes = updateTicketIdForConversation(db, 'c1', 42)
    expect(changes).toBe(2)
    const c1Rows = listInvocationsForConversation(db, 'c1')
    expect(c1Rows.every((r) => r.ticket_id === 42)).toBe(true)
    const c2Rows = listInvocationsForConversation(db, 'c2')
    expect(c2Rows[0].ticket_id).toBeNull()
  })

  it('does not overwrite an already-set ticket_id', () => {
    recordInvocation(db, fixedInput({ id: 'a', surface: 'explore-spec', conversation_id: 'c1', ticket_id: 99 }))
    recordInvocation(db, fixedInput({ id: 'b', surface: 'explore-spec', conversation_id: 'c1', ticket_id: null }))
    updateTicketIdForConversation(db, 'c1', 42)
    const rows = listInvocationsForConversation(db, 'c1')
    const a = rows.find((r) => r.id === 'a')!
    const b = rows.find((r) => r.id === 'b')!
    expect(a.ticket_id).toBe(99)
    expect(b.ticket_id).toBe(42)
  })

  it('aggregates ticket spending across surfaces', () => {
    recordInvocation(db, fixedInput({ id: 'j1', surface: 'job', ticket_id: 7, total_cost_usd: 1.0, num_turns: 2, duration_ms: 1000 }))
    recordInvocation(db, fixedInput({ id: 'j2', surface: 'job', ticket_id: 7, total_cost_usd: 2.0, num_turns: 3, duration_ms: 2000 }))
    recordInvocation(db, fixedInput({ id: 'e1', surface: 'explore-spec', ticket_id: 7, total_cost_usd: 0.5, num_turns: 4, duration_ms: 500 }))
    const summary = getTicketSpendingSummary(db, 7)
    expect(summary.totalRuns).toBe(3)
    expect(summary.totalCostUsd).toBeCloseTo(3.5)
    expect(summary.totalTurns).toBe(9)
    expect(summary.activeDurationMs).toBe(3500)
    // Each fixedInput defaults tokens_in:100 + tokens_out:50 = 150; ×3 = 450.
    expect(summary.totalTokens).toBe(450)
    expect(summary.bySurface.job.count).toBe(2)
    expect(summary.bySurface.job.costUsd).toBeCloseTo(3.0)
    expect(summary.bySurface['explore-spec'].count).toBe(1)
    expect(summary.bySurface['quick-spec'].count).toBe(0)
  })

  it('splits estimatedCostUsd for codex/gemini estimated rows (BUG-ANALYTICS-12)', () => {
    recordInvocation(db, fixedInput({ id: 'cl', surface: 'job', ticket_id: 11, total_cost_usd: 1.0, total_cost_usd_estimated: false, provider: 'claude' }))
    recordInvocation(db, fixedInput({ id: 'cx', surface: 'job', ticket_id: 11, total_cost_usd: 0.25, total_cost_usd_estimated: true, provider: 'codex' }))
    const summary = getTicketSpendingSummary(db, 11)
    expect(summary.totalCostUsd).toBeCloseTo(1.25)
    expect(summary.estimatedCostUsd).toBeCloseTo(0.25)
  })

  it('estimatedCostUsd is 0 for a ticket implemented entirely via claude', () => {
    recordInvocation(db, fixedInput({ id: 'cl', surface: 'job', ticket_id: 12, total_cost_usd: 2.0, total_cost_usd_estimated: false }))
    const summary = getTicketSpendingSummary(db, 12)
    expect(summary.totalCostUsd).toBeCloseTo(2.0)
    expect(summary.estimatedCostUsd).toBe(0)
  })

  it('totalTokens includes cache-read and cache-create tiers', () => {
    recordInvocation(db, fixedInput({
      id: 'c1', surface: 'job', ticket_id: 9,
      tokens_in: 1000, tokens_out: 200, tokens_cache_read: 50_000, tokens_cache_create: 800,
    }))
    const summary = getTicketSpendingSummary(db, 9)
    // 1000 + 200 + 50000 + 800 = 52000 (cache dominates)
    expect(summary.totalTokens).toBe(52_000)
  })

  it('keeps all-Kimi ticket cost, usage and turns unavailable instead of zero', () => {
    recordInvocation(db, fixedInput({
      id: 'kimi',
      provider: 'kimi',
      model: 'k3',
      ticket_id: 77,
      total_cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cache_read: null,
      tokens_cache_create: null,
      num_turns: null,
    }))
    const summary = getTicketSpendingSummary(db, 77)
    expect(summary).toMatchObject({
      totalCostUsd: 0,
      totalTokens: null,
      totalTurns: null,
      pricedRuns: 0,
      unpricedRuns: 1,
      usageReportedRuns: 0,
      usageUnavailableRuns: 1,
      turnsReportedRuns: 0,
      turnsUnavailableRuns: 1,
    })
    expect(summary.bySurface.job.unpricedCount).toBe(1)
  })

  it('exposes known subtotals plus coverage for mixed Claude and Kimi tickets', () => {
    recordInvocation(db, fixedInput({
      id: 'claude',
      provider: 'claude',
      ticket_id: 78,
      total_cost_usd: 1,
      tokens_in: 100,
      tokens_out: 50,
      num_turns: 2,
    }))
    recordInvocation(db, fixedInput({
      id: 'kimi',
      provider: 'kimi',
      ticket_id: 78,
      total_cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cache_read: null,
      tokens_cache_create: null,
      num_turns: null,
    }))
    const summary = getTicketSpendingSummary(db, 78)
    expect(summary).toMatchObject({
      totalCostUsd: 1,
      totalTokens: 150,
      totalTurns: 2,
      pricedRuns: 1,
      unpricedRuns: 1,
      usageReportedRuns: 1,
      usageUnavailableRuns: 1,
      turnsReportedRuns: 1,
      turnsUnavailableRuns: 1,
    })
  })

  it('persists provider column from input', () => {
    recordInvocation(db, fixedInput({ id: 'cl', provider: 'claude' }))
    recordInvocation(db, fixedInput({ id: 'co', provider: 'codex' }))
    const rows = db.prepare(`SELECT id, provider FROM ai_invocations ORDER BY id`).all() as Array<{ id: string; provider: string }>
    expect(rows).toEqual([
      { id: 'cl', provider: 'claude' },
      { id: 'co', provider: 'codex' },
    ])
  })

  it('rejects insert when provider is empty/missing at runtime', () => {
    expect(() =>
      recordInvocation(db, fixedInput({ provider: '' }))
    ).toThrow(/provider is required/)
  })

  it('writes total_cost_usd_estimated=1 when flag set', () => {
    recordInvocation(db, fixedInput({ id: 'est', total_cost_usd_estimated: true }))
    const row = db.prepare(`SELECT total_cost_usd_estimated FROM ai_invocations WHERE id = ?`).get('est') as { total_cost_usd_estimated: number }
    expect(row.total_cost_usd_estimated).toBe(1)
  })

  it('writes total_cost_usd_estimated=0 by default', () => {
    recordInvocation(db, fixedInput({ id: 'auth' }))
    const row = db.prepare(`SELECT total_cost_usd_estimated FROM ai_invocations WHERE id = ?`).get('auth') as { total_cost_usd_estimated: number }
    expect(row.total_cost_usd_estimated).toBe(0)
  })

  it('accepts the cost-accounting-audit surfaces (previously-unrecorded spawners)', () => {
    const newSurfaces = ['chat-sidebar', 'spec-launcher', 'proposal', 'agent-studio', 'setup'] as const
    for (const surface of newSurfaces) {
      recordInvocation(db, fixedInput({ id: `s-${surface}`, surface }))
    }
    const rows = db
      .prepare(`SELECT surface FROM ai_invocations WHERE surface IN ('chat-sidebar','spec-launcher','proposal','agent-studio','setup') ORDER BY surface`)
      .all() as Array<{ surface: string }>
    expect(rows.map((r) => r.surface)).toEqual(['agent-studio', 'chat-sidebar', 'proposal', 'setup', 'spec-launcher'])
  })

  it('still rejects an unknown surface not in the allow-list', () => {
    expect(() =>
      recordInvocation(db, fixedInput({ surface: 'totally-unknown' as unknown as 'job' }))
    ).toThrow(InvalidSurfaceError)
  })

  it('aggregates ticket spending across a new surface (setup) without crashing bySurface', () => {
    recordInvocation(db, fixedInput({ id: 'st', surface: 'setup', ticket_id: 21, total_cost_usd: 0.7 }))
    const summary = getTicketSpendingSummary(db, 21)
    expect(summary.bySurface.setup.count).toBe(1)
    expect(summary.bySurface.setup.costUsd).toBeCloseTo(0.7)
    expect(summary.totalCostUsd).toBeCloseTo(0.7)
  })
})

describe('getInvocationsByProvider', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('returns one row per provider with authoritative + estimated cost split', async () => {
    const { getInvocationsByProvider } = await import('./ai-invocations')
    const now = new Date().toISOString()
    recordInvocation(db, fixedInput({ id: 'a', provider: 'claude', total_cost_usd: 1.0, total_cost_usd_estimated: false, started_at: now }))
    recordInvocation(db, fixedInput({ id: 'b', provider: 'claude', total_cost_usd: 0.5, total_cost_usd_estimated: false, started_at: now }))
    recordInvocation(db, fixedInput({ id: 'c', provider: 'codex', total_cost_usd: 0.02, total_cost_usd_estimated: true, started_at: now }))
    recordInvocation(db, fixedInput({ id: 'd', provider: 'codex', total_cost_usd: 0.03, total_cost_usd_estimated: true, started_at: now }))
    const result = getInvocationsByProvider(db, 'p1')
    const claude = result.find((r) => r.provider === 'claude')!
    expect(claude.count).toBe(2)
    expect(claude.costUsd).toBeCloseTo(1.5)
    expect(claude.estimatedCostUsd).toBe(0)
    const codex = result.find((r) => r.provider === 'codex')!
    expect(codex.count).toBe(2)
    expect(codex.costUsd).toBe(0)
    expect(codex.estimatedCostUsd).toBeCloseTo(0.05)
  })
})

describe('sumInvocationCostForRuns', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('sums loop_run_id, surface_ref_id, and :merge: sub-rows for the given runs', async () => {
    const { sumInvocationCostForRuns } = await import('./ai-invocations')
    recordInvocation(db, fixedInput({ id: 'a', surface: 'loop', loop_run_id: 'run-1', total_cost_usd: 1.25 }))
    recordInvocation(db, fixedInput({ id: 'b', surface: 'job', surface_ref_id: 'run-2', total_cost_usd: 0.5 }))
    recordInvocation(db, fixedInput({ id: 'c', surface: 'job', surface_ref_id: 'run-2:merge:verify', total_cost_usd: 0.25 }))
    // Unrelated rows must not count.
    recordInvocation(db, fixedInput({ id: 'x', surface: 'job', surface_ref_id: 'other-run', total_cost_usd: 9 }))
    recordInvocation(db, fixedInput({ id: 'y', surface: 'loop', loop_run_id: 'other-loop', total_cost_usd: 9 }))
    const result = sumInvocationCostForRuns(db, ['run-1', 'run-2'])
    expect(result).not.toBeNull()
    expect(result!.totalUsd).toBeCloseTo(2.0)
    expect(result!.estimated).toBe(false)
  })

  it('flags estimated when any matched row is rate-card priced; counts failed rows', async () => {
    const { sumInvocationCostForRuns } = await import('./ai-invocations')
    recordInvocation(db, fixedInput({ id: 'a', surface: 'job', surface_ref_id: 'run-1', total_cost_usd: 0.4 }))
    recordInvocation(db, fixedInput({ id: 'b', surface: 'job', surface_ref_id: 'run-1', status: 'failed', total_cost_usd: 0.1, total_cost_usd_estimated: true }))
    const result = sumInvocationCostForRuns(db, ['run-1'])
    expect(result!.totalUsd).toBeCloseTo(0.5)
    expect(result!.estimated).toBe(true)
  })

  it('returns null for empty ids, blank ids, and runs with no priced rows', async () => {
    const { sumInvocationCostForRuns } = await import('./ai-invocations')
    expect(sumInvocationCostForRuns(db, [])).toBeNull()
    expect(sumInvocationCostForRuns(db, ['', ''])).toBeNull()
    recordInvocation(db, fixedInput({ id: 'a', surface: 'job', surface_ref_id: 'run-1', total_cost_usd: null as unknown as number }))
    expect(sumInvocationCostForRuns(db, ['run-1'])).toBeNull()
  })

  it('escapes LIKE metacharacters in run ids so % and _ cannot over-match', async () => {
    const { sumInvocationCostForRuns } = await import('./ai-invocations')
    recordInvocation(db, fixedInput({ id: 'a', surface: 'job', surface_ref_id: 'runX:merge:step', total_cost_usd: 5 }))
    expect(sumInvocationCostForRuns(db, ['run%'])).toBeNull()
    expect(sumInvocationCostForRuns(db, ['run_'])).toBeNull()
  })

  it('dedupes repeated run ids', async () => {
    const { sumInvocationCostForRuns } = await import('./ai-invocations')
    recordInvocation(db, fixedInput({ id: 'a', surface: 'loop', loop_run_id: 'run-1', total_cost_usd: 1 }))
    const result = sumInvocationCostForRuns(db, ['run-1', 'run-1'])
    expect(result!.totalUsd).toBeCloseTo(1)
  })
})
