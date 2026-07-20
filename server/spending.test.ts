import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import { recordInvocation } from './ai-invocations'
import { getSpending, getInvocations, parseSpendingFilters } from './spending'

function seed(db: DbInstance, rows: Array<Partial<Parameters<typeof recordInvocation>[1]>>) {
  let i = 0
  for (const r of rows) {
    recordInvocation(db, {
      id: `id-${i++}`,
      project_id: 'p1',
      provider: 'claude',
      surface: 'job',
      status: 'success',
      started_at: new Date().toISOString(),
      ...r,
    } as Parameters<typeof recordInvocation>[1])
  }
}

describe('getSpending', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('returns zero state when no rows', () => {
    const r = getSpending(db, 'p1', { period: '30d' })
    expect(r.summary.totalCostUsd).toBe(0)
    expect(r.summary.totalRuns).toBe(0)
    expect(r.summary.deltaPct).toBeNull()
    // The 7 original analytics surfaces + the 5 cost-accounting-audit additions
    // (chat-sidebar, spec-launcher, proposal, agent-studio, setup).
    expect(r.bySurface).toHaveLength(12)
    expect(r.bySurface.every((s) => s.count === 0)).toBe(true)
    expect(r.topTickets).toEqual([])
  })

  it('sums totals across surfaces and only counts success rows in averages', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'job', status: 'success', total_cost_usd: 1.0, num_turns: 2, model: 'sonnet', started_at: now, duration_ms: 1000 },
      { id: 'b', surface: 'quick-spec', status: 'success', total_cost_usd: 3.0, num_turns: 1, model: 'sonnet', started_at: now, duration_ms: 500 },
      { id: 'c', surface: 'job', status: 'failed', started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.summary.totalRuns).toBe(3)
    expect(r.summary.totalCostUsd).toBeCloseTo(4.0)
    expect(r.summary.failureRate).toBeCloseTo(1 / 3)
    expect(r.summary.avgCostPerRun).toBeCloseTo(2.0)
  })

  it('summary.totalTokens sums all four token tiers across rows', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'job', tokens_in: 1000, tokens_out: 200, tokens_cache_read: 40_000, tokens_cache_create: 500, started_at: now },
      { id: 'b', surface: 'explore-spec', tokens_in: 300, tokens_out: 100, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    // (1000+200+40000+500) + (300+100) = 41700 + 400 = 42100
    expect(r.summary.totalTokens).toBe(42_100)
  })

  it('filters by surface', () => {
    seed(db, [
      { id: 'a', surface: 'job', total_cost_usd: 5, started_at: new Date().toISOString() },
      { id: 'b', surface: 'quick-spec', total_cost_usd: 1, started_at: new Date().toISOString() },
    ])
    const r = getSpending(db, 'p1', { period: 'all', surface: ['quick-spec'] })
    expect(r.summary.totalCostUsd).toBe(1)
  })

  it('aggregates topTickets cross-surface and surfaces unattributed', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'job', ticket_id: 7, total_cost_usd: 5, started_at: now },
      { id: 'b', surface: 'job', ticket_id: 7, total_cost_usd: 5, started_at: now },
      { id: 'c', surface: 'explore-spec', ticket_id: 7, total_cost_usd: 2, started_at: now },
      { id: 'd', surface: 'explore-spec', ticket_id: null, total_cost_usd: 1, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    const top7 = r.topTickets.find((t) => t.ticketId === 7)!
    expect(top7.totalCostUsd).toBeCloseTo(12)
    expect(top7.bySurface.job.costUsd).toBeCloseTo(10)
    expect(top7.bySurface['explore-spec'].costUsd).toBeCloseTo(2)
    const unatt = r.topTickets.find((t) => t.ticketId === null)
    expect(unatt?.isUnattributed).toBe(true)
    expect(unatt?.totalCostUsd).toBeCloseTo(1)
  })

  it('byMode counts only ticket-creating runs as ticketsCreated', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'quick-spec', status: 'success', ticket_id: 1, total_cost_usd: 0.1, duration_ms: 500, started_at: now },
      { id: 'b', surface: 'quick-spec', status: 'success', ticket_id: null, total_cost_usd: 0.1, started_at: now },
      { id: 'c', surface: 'explore-spec', status: 'success', ticket_id: 2, total_cost_usd: 0.7, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    const quick = r.byMode.find((m) => m.mode === 'quick')!
    expect(quick.totalRuns).toBe(2)
    expect(quick.ticketsCreated).toBe(1)
    expect(r.byMode.find((m) => m.mode === 'explore')!.ticketsCreated).toBe(1)
  })

  it('byProvider splits authoritative vs estimated cost', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', provider: 'claude', surface: 'job', status: 'success', total_cost_usd: 1.0, total_cost_usd_estimated: false, started_at: now },
      { id: 'b', provider: 'claude', surface: 'job', status: 'success', total_cost_usd: 0.5, total_cost_usd_estimated: false, started_at: now },
      { id: 'c', provider: 'codex',  surface: 'job', status: 'success', total_cost_usd: 0.02, total_cost_usd_estimated: true,  started_at: now },
      { id: 'd', provider: 'codex',  surface: 'job', status: 'success', total_cost_usd: 0.03, total_cost_usd_estimated: true,  started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    const claude = r.byProvider.find((p) => p.provider === 'claude')!
    expect(claude.count).toBe(2)
    expect(claude.costUsd).toBeCloseTo(1.5)
    expect(claude.estimatedCostUsd).toBe(0)
    const codex = r.byProvider.find((p) => p.provider === 'codex')!
    expect(codex.count).toBe(2)
    expect(codex.costUsd).toBe(0)
    expect(codex.estimatedCostUsd).toBeCloseTo(0.05)
    // totalEstimatedCostUsd surfaced on summary for the Hero footnote
    expect(r.summary.totalEstimatedCostUsd).toBeCloseTo(0.05)
  })

  it('keeps Kimi cost and token telemetry unavailable instead of inventing zeroes', () => {
    const now = new Date().toISOString()
    seed(db, [
      {
        id: 'k1',
        provider: 'kimi',
        model: 'k3',
        surface: 'quick-spec',
        ticket_id: 41,
        total_cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        started_at: now,
      },
      {
        id: 'k2',
        provider: 'kimi',
        model: 'k3',
        surface: 'job',
        total_cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        started_at: now,
      },
    ])

    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.summary).toMatchObject({
      totalCostUsd: 0,
      totalTokens: null,
      totalRuns: 2,
      pricedRuns: 0,
      unpricedRuns: 2,
      usageReportedRuns: 0,
      usageUnavailableRuns: 2,
      avgCostPerRun: null,
      deltaPct: null,
    })
    expect(r.byProvider).toContainEqual(expect.objectContaining({
      provider: 'kimi',
      count: 2,
      pricedCount: 0,
      unpricedCount: 2,
      usageReportedCount: 0,
      usageUnavailableCount: 2,
    }))
    expect(r.byModel).toContainEqual(expect.objectContaining({
      provider: 'kimi',
      model: 'k3',
      count: 2,
      unpricedCount: 2,
    }))
    expect(r.byMode.find((m) => m.mode === 'quick')).toMatchObject({
      avgCostPerSpec: null,
      unpricedCount: 1,
    })
    expect(r.bySurface.find((s) => s.surface === 'job')?.unpricedCount).toBe(1)
    expect(r.dailyTimeline.reduce((n, d) => n + (d.unpricedCount ?? 0), 0)).toBe(2)
    expect(r.topTickets.find((ticket) => ticket.ticketId === 41)).toMatchObject({
      totalCostUsd: 0,
      unpricedCount: 1,
    })
  })

  it('labels mixed-provider analytics as known subtotals when Kimi telemetry is absent', () => {
    const now = new Date().toISOString()
    seed(db, [
      {
        id: 'c1',
        provider: 'claude',
        model: 'sonnet',
        total_cost_usd: 1.25,
        tokens_in: 100,
        tokens_out: 25,
        started_at: now,
      },
      {
        id: 'k1',
        provider: 'kimi',
        model: 'k3',
        total_cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        started_at: now,
      },
    ])

    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.summary).toMatchObject({
      totalCostUsd: 1.25,
      totalTokens: 125,
      pricedRuns: 1,
      unpricedRuns: 1,
      usageReportedRuns: 1,
      usageUnavailableRuns: 1,
      avgCostPerRun: null,
      deltaPct: null,
    })
    expect(r.byProvider.find((p) => p.provider === 'kimi')).toMatchObject({
      pricedCount: 0,
      unpricedCount: 1,
    })
  })

  it('summary.totalEstimatedCostUsd is 0 when no estimated rows', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', provider: 'claude', surface: 'job', total_cost_usd: 1.0, total_cost_usd_estimated: false, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.summary.totalEstimatedCostUsd).toBe(0)
  })

  it('aggregates smash surface rows alongside other surfaces', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 's1', surface: 'smash', ticket_id: 42, status: 'success', total_cost_usd: 0.15, num_turns: 1, duration_ms: 4000, started_at: now },
      { id: 's2', surface: 'smash', ticket_id: 42, status: 'success', total_cost_usd: 0.12, num_turns: 1, duration_ms: 3000, started_at: now },
      { id: 's3', surface: 'smash', ticket_id: 50, status: 'failed', total_cost_usd: null, started_at: now },
      { id: 'j1', surface: 'job', ticket_id: 42, status: 'success', total_cost_usd: 1.0, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    const smashEntry = r.bySurface.find((s) => s.surface === 'smash')
    expect(smashEntry).toBeDefined()
    expect(smashEntry!.count).toBe(3)
    expect(smashEntry!.costUsd).toBeCloseTo(0.27)
    // Ticket 42 should show the SMASH costs in bySurface breakdown
    const t42 = r.topTickets.find((t) => t.ticketId === 42)!
    expect(t42.bySurface.smash.count).toBe(2)
    expect(t42.bySurface.smash.costUsd).toBeCloseTo(0.27)
    expect(t42.bySurface.job.costUsd).toBeCloseTo(1.0)
  })

  it('filters by smash surface alone', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 's1', surface: 'smash', total_cost_usd: 0.5, started_at: now },
      { id: 'j1', surface: 'job', total_cost_usd: 10, started_at: now },
      { id: 'q1', surface: 'quick-spec', total_cost_usd: 1, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all', surface: ['smash'] })
    expect(r.summary.totalCostUsd).toBeCloseTo(0.5)
    expect(r.summary.totalRuns).toBe(1)
  })

  it('computes deltaPct vs previous period', () => {
    const today = new Date()
    const tenDaysAgo = new Date(today.getTime() - 10 * 86_400_000).toISOString()
    const fortyDaysAgo = new Date(today.getTime() - 40 * 86_400_000).toISOString()
    seed(db, [
      { id: 'curr', surface: 'job', total_cost_usd: 12, started_at: tenDaysAgo },
      { id: 'prev', surface: 'job', total_cost_usd: 10, started_at: fortyDaysAgo },
    ])
    const r = getSpending(db, 'p1', { period: '30d' })
    expect(r.summary.totalCostUsd).toBe(12)
    expect(r.summary.prevTotalCostUsd).toBe(10)
    expect(r.summary.deltaPct).toBeCloseTo(20)
  })
})

describe('getInvocations', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('paginates results', () => {
    for (let i = 0; i < 5; i++) {
      recordInvocation(db, {
        id: `r${i}`, project_id: 'p1', provider: 'claude', surface: 'job', status: 'success',
        started_at: new Date(Date.now() - i * 1000).toISOString(),
      })
    }
    const r = getInvocations(db, 'p1', { period: 'all', limit: 2, offset: 1 })
    expect(r.rows).toHaveLength(2)
    expect(r.totalAvailable).toBe(5)
  })

  it('uses conv title when present, else first-message summary', () => {
    db.prepare(`INSERT INTO chat_conversations (id, model, kind, title) VALUES (?, ?, ?, ?)`)
      .run('conv-1', 'sonnet', 'explore', 'Real Title')
    db.prepare(`INSERT INTO chat_conversations (id, model, kind, title) VALUES (?, ?, ?, ?)`)
      .run('conv-2', 'sonnet', 'explore', null)
    db.prepare(`INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)`)
      .run('conv-2', 'user', '/specrails:explore-spec\n\nAdd a dark mode toggle to settings')
    recordInvocation(db, {
      id: 'i1', project_id: 'p1', provider: 'claude', surface: 'explore-spec', status: 'success',
      conversation_id: 'conv-1', started_at: new Date().toISOString(),
    })
    recordInvocation(db, {
      id: 'i2', project_id: 'p1', provider: 'claude', surface: 'explore-spec', status: 'success',
      conversation_id: 'conv-2', started_at: new Date(Date.now() - 1000).toISOString(),
    })
    const r = getInvocations(db, 'p1', { period: 'all' })
    const byId = new Map(r.rows.map((row) => [row.id, row]))
    expect(byId.get('i1')?.ticket_title).toBe('Real Title')
    expect(byId.get('i2')?.ticket_title).toBe('Add a dark mode…')
  })

  it('applies cap and sets truncated flag', () => {
    for (let i = 0; i < 10; i++) {
      recordInvocation(db, {
        id: `r${i}`, project_id: 'p1', provider: 'claude', surface: 'job', status: 'success',
        started_at: new Date(Date.now() - i * 1000).toISOString(),
      })
    }
    const r = getInvocations(db, 'p1', { period: 'all', cap: 5 })
    expect(r.rows).toHaveLength(5)
    expect(r.truncated).toBe(true)
    expect(r.totalAvailable).toBe(10)
  })
})

describe('parseSpendingFilters', () => {
  it('parses surface CSV and rejects unknown surfaces', () => {
    const f = parseSpendingFilters({ surface: 'job,quick-spec,bogus' })
    expect(f.surface).toEqual(['job', 'quick-spec'])
  })

  it('parses minCostUsd as float', () => {
    const f = parseSpendingFilters({ minCostUsd: '0.5' })
    expect(f.minCostUsd).toBe(0.5)
  })

  it('parses ticketId', () => {
    const f = parseSpendingFilters({ ticketId: '42' })
    expect(f.ticketId).toBe(42)
  })

  it('rejects invalid status', () => {
    const f = parseSpendingFilters({ status: 'notreal' })
    expect(f.status).toBeUndefined()
  })

  it('accepts valid status values', () => {
    expect(parseSpendingFilters({ status: 'success' }).status).toBe('success')
    expect(parseSpendingFilters({ status: 'failed' }).status).toBe('failed')
    expect(parseSpendingFilters({ status: 'aborted' }).status).toBe('aborted')
  })

  it('parses period, from, to', () => {
    const f = parseSpendingFilters({ period: 'custom', from: '2026-01-01', to: '2026-02-01' })
    expect(f.period).toBe('custom')
    expect(f.from).toBe('2026-01-01')
    expect(f.to).toBe('2026-02-01')
  })

  it('parses model CSV', () => {
    const f = parseSpendingFilters({ model: 'opus,sonnet' })
    expect(f.model).toEqual(['opus', 'sonnet'])
  })

  it('returns empty filters for empty query', () => {
    expect(parseSpendingFilters({})).toEqual({})
  })

  it('ignores non-string query values defensively', () => {
    const f = parseSpendingFilters({ surface: undefined, model: 123 as unknown as string })
    expect(f.surface).toBeUndefined()
    expect(f.model).toBeUndefined()
  })

  it('drops minCostUsd when not parseable', () => {
    const f = parseSpendingFilters({ minCostUsd: 'abc' })
    expect(f.minCostUsd).toBeUndefined()
  })

  it('drops ticketId when not parseable', () => {
    const f = parseSpendingFilters({ ticketId: 'abc' })
    expect(f.ticketId).toBeUndefined()
  })
})

describe('getSpending edge cases', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('handles `all` period without prev-period delta', () => {
    seed(db, [
      { id: 'a', surface: 'job', total_cost_usd: 5, started_at: new Date().toISOString() },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.summary.totalCostUsd).toBe(5)
    expect(r.summary.deltaPct).toBeNull()
  })

  it('handles custom period with explicit from/to', () => {
    const now = new Date()
    const recent = new Date(now.getTime() - 1000).toISOString()
    seed(db, [{ id: 'a', surface: 'job', total_cost_usd: 2, started_at: recent }])
    const r = getSpending(db, 'p1', {
      period: 'custom',
      from: new Date(now.getTime() - 10_000).toISOString(),
      to: new Date(now.getTime() + 10_000).toISOString(),
    })
    expect(r.summary.totalCostUsd).toBe(2)
  })

  it('filters by model and minCostUsd', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'job', model: 'opus', total_cost_usd: 5, started_at: now },
      { id: 'b', surface: 'job', model: 'sonnet', total_cost_usd: 0.1, started_at: now },
      { id: 'c', surface: 'job', model: 'opus', total_cost_usd: 2, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all', model: ['opus'], minCostUsd: 3 })
    expect(r.summary.totalCostUsd).toBe(5)
    expect(r.summary.totalRuns).toBe(1)
  })

  // ─── HIGH-7: custom period must include the ENTIRE final day ─────────────────
  it('HIGH-7: a bare YYYY-MM-DD custom `to` includes rows started that day', () => {
    const today = new Date().toISOString().slice(0, 10)
    // A full-ISO instant at 09:15 today — previously dropped by `started_at <= '<today>'`.
    seed(db, [{ id: 'heavy', surface: 'job', total_cost_usd: 12, started_at: `${today}T09:15:00.000Z` }])
    const r = getSpending(db, 'p1', { period: 'custom', from: '2000-01-01', to: today })
    expect(r.summary.totalCostUsd).toBe(12)
    expect(r.summary.totalRuns).toBe(1)
    // rangeTo is extended to the end of the day, not the bare date.
    expect(r.rangeTo.startsWith(today)).toBe(true)
    expect(r.rangeTo > today).toBe(true)
  })

  it('HIGH-7: a full-ISO custom `to` is kept verbatim (precise instant)', () => {
    const base = new Date()
    const instant = new Date(base.getTime() - 1000).toISOString()
    seed(db, [{ id: 'a', surface: 'job', total_cost_usd: 3, started_at: instant }])
    const to = new Date(base.getTime() + 2000).toISOString()
    const r = getSpending(db, 'p1', { period: 'custom', from: new Date(base.getTime() - 10_000).toISOString(), to })
    expect(r.rangeTo).toBe(to) // not extended
    expect(r.summary.totalCostUsd).toBe(3)
  })

  it('HIGH-7: bare-date `to` respects tzOffsetMinutes (local end-of-day)', () => {
    // A user at UTC+2 on 2026-07-02 local includes rows up to 2026-07-02T21:59:59.999Z.
    seed(db, [{ id: 'inrange', surface: 'job', total_cost_usd: 4, started_at: '2026-07-02T21:00:00.000Z' }])
    seed(db, [{ id: 'nextday', surface: 'job', total_cost_usd: 9, started_at: '2026-07-02T22:30:00.000Z' }])
    const r = getSpending(db, 'p1', { period: 'custom', from: '2026-07-01', to: '2026-07-02', tzOffsetMinutes: 120 })
    expect(r.summary.totalCostUsd).toBe(4) // 22:30Z is the next local day, excluded
  })

  // ─── LOW-4: minCostUsd=0 is a true no-op (keeps NULL-cost rows) ──────────────
  it('LOW-4: minCostUsd=0 keeps NULL-cost (aborted/killed) rows', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'priced', surface: 'job', status: 'success', total_cost_usd: 1, started_at: now },
      { id: 'killed', surface: 'job', status: 'aborted', total_cost_usd: null, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all', minCostUsd: 0 })
    expect(r.summary.totalRuns).toBe(2) // NULL-cost row retained
    const raw = getInvocations(db, 'p1', { period: 'all', minCostUsd: 0 })
    expect(raw.rows.length).toBe(2)
  })

  it('LOW-4: minCostUsd>0 still drops NULL-cost rows and sub-threshold rows', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'big', surface: 'job', status: 'success', total_cost_usd: 5, started_at: now },
      { id: 'small', surface: 'job', status: 'success', total_cost_usd: 0.1, started_at: now },
      { id: 'killed', surface: 'job', status: 'aborted', total_cost_usd: null, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all', minCostUsd: 0.5 })
    expect(r.summary.totalRuns).toBe(1)
    expect(r.summary.totalCostUsd).toBe(5)
  })

  it('applies ticketId filter end-to-end', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'job', ticket_id: 7, total_cost_usd: 1, started_at: now },
      { id: 'b', surface: 'job', ticket_id: 8, total_cost_usd: 2, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all', ticketId: 7 })
    expect(r.summary.totalCostUsd).toBe(1)
  })

  // M18: byMode counts DISTINCT tickets, not rows.
  it('byMode ticketsCreated counts distinct tickets, not turn rows', () => {
    const now = new Date().toISOString()
    // One Explore spec, 3 turn-rows all back-filled with the same ticket_id.
    seed(db, [
      { id: 'e1', surface: 'explore-spec', status: 'success', ticket_id: 42, total_cost_usd: 1, conversation_id: 'c1', started_at: now },
      { id: 'e2', surface: 'explore-spec', status: 'success', ticket_id: 42, total_cost_usd: 2, conversation_id: 'c1', started_at: now },
      { id: 'e3', surface: 'explore-spec', status: 'success', ticket_id: 42, total_cost_usd: 3, conversation_id: 'c1', started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    const explore = r.byMode.find((m) => m.mode === 'explore')!
    expect(explore.totalRuns).toBe(3)        // 3 turn rows
    expect(explore.ticketsCreated).toBe(1)   // but only ONE ticket
    // avgCostPerSpec = total success ticket cost (6) / distinct successful tickets (1)
    expect(explore.avgCostPerSpec).toBeCloseTo(6)
  })
})

describe('H24 derived aggregates', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('byModel aggregates counts and cost across surfaces, ordered by cost desc', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'job', model: 'sonnet', total_cost_usd: 1, started_at: now },
      { id: 'b', surface: 'quick-spec', model: 'sonnet', total_cost_usd: 2, started_at: now },
      { id: 'c', surface: 'job', model: 'opus', total_cost_usd: 5, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.byModel).toEqual([
      { provider: 'claude', model: 'opus', count: 1, costUsd: 5, estimatedCostUsd: 0 },
      { provider: 'claude', model: 'sonnet', count: 2, costUsd: 3, estimatedCostUsd: 0 },
    ])
  })

  it('byMode dominantModel picks the most frequent model per surface', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'quick-spec', model: 'haiku', total_cost_usd: 0.1, started_at: now },
      { id: 'b', surface: 'quick-spec', model: 'haiku', total_cost_usd: 0.1, started_at: now },
      { id: 'c', surface: 'quick-spec', model: 'opus', total_cost_usd: 9, started_at: now },
      { id: 'd', surface: 'explore-spec', model: 'sonnet', total_cost_usd: 0.5, started_at: now },
      { id: 'e', surface: 'job', model: 'opus', total_cost_usd: 1, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.byMode.find((m) => m.mode === 'quick')!.dominantModel).toBe('haiku')
    expect(r.byMode.find((m) => m.mode === 'explore')!.dominantModel).toBe('sonnet')
  })

  it('byMode sparkline matches the dailyTimeline per-surface costs', () => {
    const today = new Date()
    const yesterday = new Date(today.getTime() - 86_400_000).toISOString()
    seed(db, [
      { id: 'a', surface: 'quick-spec', total_cost_usd: 0.4, started_at: yesterday },
      { id: 'b', surface: 'quick-spec', total_cost_usd: 0.6, started_at: today.toISOString() },
      { id: 'c', surface: 'explore-spec', total_cost_usd: 2, started_at: today.toISOString() },
    ])
    const r = getSpending(db, 'p1', { period: '7d' })
    const quick = r.byMode.find((m) => m.mode === 'quick')!
    expect(quick.sparkline).toHaveLength(r.dailyTimeline.length)
    expect(quick.sparkline).toEqual(r.dailyTimeline.map((d) => d.quickCostUsd))
    const explore = r.byMode.find((m) => m.mode === 'explore')!
    expect(explore.sparkline).toEqual(r.dailyTimeline.map((d) => d.exploreCostUsd))
  })

  it('bySurface counts rows with null cost and zero-fills absent surfaces', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'job', total_cost_usd: null, started_at: now },
      { id: 'b', surface: 'job', total_cost_usd: 3, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    const job = r.bySurface.find((s) => s.surface === 'job')!
    expect(job.count).toBe(2)
    expect(job.costUsd).toBeCloseTo(3)
    expect(r.bySurface.find((s) => s.surface === 'smash')).toEqual({ surface: 'smash', count: 0, costUsd: 0 })
  })
})

describe('daily timeline (B58/B63)', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('B58: timeline stacks file-summary cost into fileSummaryCostUsd', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'fs', surface: 'file-summary', status: 'success', total_cost_usd: 0.5, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: '30d' })
    const total = r.dailyTimeline.reduce((s, d) => s + d.fileSummaryCostUsd, 0)
    expect(total).toBeCloseTo(0.5)
  })

  it('B63: period "all" does not zero-fill from 1970 (bounded timeline)', () => {
    const now = new Date().toISOString()
    seed(db, [{ id: 'a', surface: 'job', status: 'success', total_cost_usd: 1, started_at: now }])
    const r = getSpending(db, 'p1', { period: 'all' })
    // Clamped to the first day with data → a handful of entries, not ~20k.
    expect(r.dailyTimeline.length).toBeLessThan(5)
  })

  it('B63: period "all" with no data yields an empty-ish timeline, not 20k days', () => {
    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.dailyTimeline.length).toBeLessThanOrEqual(1)
  })
})

describe('parseSpendingFilters surface validation (M17)', () => {
  it('accepts smash and file-summary surfaces', () => {
    expect(parseSpendingFilters({ surface: 'smash' }).surface).toEqual(['smash'])
    expect(parseSpendingFilters({ surface: 'file-summary' }).surface).toEqual(['file-summary'])
  })
  it('keeps mixed valid surfaces intact (does not silently drop smash)', () => {
    expect(parseSpendingFilters({ surface: 'job,smash' }).surface).toEqual(['job', 'smash'])
  })
  it('drops unknown surfaces', () => {
    expect(parseSpendingFilters({ surface: 'job,bogus' }).surface).toEqual(['job'])
  })
})

// BUG-ANALYTICS-08/29/30/31: byModel carries provider + an estimated/authoritative
// split, and is keyed on (provider, model) so codex/gemini estimated spend never
// merges into a claude bar of the same id.
describe('byModel provider + estimated split', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('carries provider and estimatedCostUsd per model entry', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', provider: 'claude', surface: 'job', model: 'sonnet', total_cost_usd: 2, total_cost_usd_estimated: false, started_at: now },
      { id: 'b', provider: 'codex', surface: 'job', model: 'gpt-5.5', total_cost_usd: 0.05, total_cost_usd_estimated: true, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    const sonnet = r.byModel.find((m) => m.model === 'sonnet')!
    expect(sonnet.provider).toBe('claude')
    expect(sonnet.costUsd).toBeCloseTo(2)
    expect(sonnet.estimatedCostUsd).toBe(0)
    const gpt = r.byModel.find((m) => m.model === 'gpt-5.5')!
    expect(gpt.provider).toBe('codex')
    expect(gpt.costUsd).toBeCloseTo(0.05)
    expect(gpt.estimatedCostUsd).toBeCloseTo(0.05)
  })

  it('does NOT merge a cross-provider model-id collision into one bar (BUG-30)', () => {
    const now = new Date().toISOString()
    // Same free-form model id 'shared-x' on two providers — must stay two entries.
    seed(db, [
      { id: 'a', provider: 'claude', surface: 'job', model: 'shared-x', total_cost_usd: 1, total_cost_usd_estimated: false, started_at: now },
      { id: 'b', provider: 'codex', surface: 'job', model: 'shared-x', total_cost_usd: 0.2, total_cost_usd_estimated: true, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    const entries = r.byModel.filter((m) => m.model === 'shared-x')
    expect(entries).toHaveLength(2)
    const byProv = new Map(entries.map((e) => [e.provider, e]))
    expect(byProv.get('claude')!.costUsd).toBeCloseTo(1)
    expect(byProv.get('claude')!.estimatedCostUsd).toBe(0)
    expect(byProv.get('codex')!.costUsd).toBeCloseTo(0.2)
    expect(byProv.get('codex')!.estimatedCostUsd).toBeCloseTo(0.2)
  })

  it('coalesces legacy NULL provider rows to claude in byModel', () => {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO ai_invocations (id, project_id, provider, surface, status, started_at, model, total_cost_usd)
                VALUES (?, ?, NULL, 'job', 'success', ?, 'sonnet', 1.0)`).run('legacy', 'p1', now)
    const r = getSpending(db, 'p1', { period: 'all' })
    const sonnet = r.byModel.find((m) => m.model === 'sonnet')!
    expect(sonnet.provider).toBe('claude')
  })
})

// BUG-ANALYTICS-30/31: provider-aligned model filter via modelKeys.
describe('provider-aligned model filter (modelKeys)', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('scopes the model predicate to its provider when modelKeys is set', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', provider: 'claude', surface: 'job', model: 'shared-x', total_cost_usd: 1, started_at: now },
      { id: 'b', provider: 'codex', surface: 'job', model: 'shared-x', total_cost_usd: 5, total_cost_usd_estimated: true, started_at: now },
    ])
    // Filtering to (codex, shared-x) must NOT pull the claude row.
    const r = getSpending(db, 'p1', { period: 'all', modelKeys: [{ provider: 'codex', model: 'shared-x' }] })
    expect(r.summary.totalCostUsd).toBeCloseTo(5)
    expect(r.summary.totalRuns).toBe(1)
  })

  it('legacy bare model filter still matches across providers (unchanged)', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', provider: 'claude', surface: 'job', model: 'shared-x', total_cost_usd: 1, started_at: now },
      { id: 'b', provider: 'codex', surface: 'job', model: 'shared-x', total_cost_usd: 5, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all', model: ['shared-x'] })
    expect(r.summary.totalRuns).toBe(2)
  })

  it('parseSpendingFilters builds modelKeys from index-aligned modelProvider CSV', () => {
    const f = parseSpendingFilters({ model: 'gpt-5.5,sonnet', modelProvider: 'codex,claude' })
    expect(f.modelKeys).toEqual([
      { provider: 'codex', model: 'gpt-5.5' },
      { provider: 'claude', model: 'sonnet' },
    ])
  })

  it('parseSpendingFilters ignores modelProvider when lengths mismatch', () => {
    const f = parseSpendingFilters({ model: 'gpt-5.5,sonnet', modelProvider: 'codex' })
    expect(f.modelKeys).toBeUndefined()
    expect(f.model).toEqual(['gpt-5.5', 'sonnet'])
  })
})

// BUG-ANALYTICS-33: byMode carries an estimated split so QuickVsExploreCard can
// mark codex/gemini per-spec figures as estimates.
describe('byMode estimated split', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('splits estimatedCostUsd per mode', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'q1', provider: 'claude', surface: 'quick-spec', status: 'success', ticket_id: 1, total_cost_usd: 0.2, total_cost_usd_estimated: false, started_at: now },
      { id: 'e1', provider: 'codex', surface: 'explore-spec', status: 'success', ticket_id: 2, total_cost_usd: 0.5, total_cost_usd_estimated: true, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    const quick = r.byMode.find((m) => m.mode === 'quick')!
    expect(quick.totalCostUsd).toBeCloseTo(0.2)
    expect(quick.estimatedCostUsd).toBe(0)
    const explore = r.byMode.find((m) => m.mode === 'explore')!
    expect(explore.totalCostUsd).toBeCloseTo(0.5)
    expect(explore.estimatedCostUsd).toBeCloseTo(0.5)
  })

  it('estimatedCostUsd is 0 for a pure-claude mode', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'q1', surface: 'quick-spec', status: 'success', ticket_id: 1, total_cost_usd: 0.3, started_at: now },
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.byMode.find((m) => m.mode === 'quick')!.estimatedCostUsd).toBe(0)
  })
})

// BUG-ANALYTICS-18/36: topTickets title/isDeleted enrichment via injected resolver.
describe('topTickets title enrichment', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('populates ticketTitle and isDeleted via the injected resolver', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'job', ticket_id: 7, total_cost_usd: 5, started_at: now },
      { id: 'b', surface: 'job', ticket_id: 99, total_cost_usd: 3, started_at: now },
      { id: 'c', surface: 'job', ticket_id: null, total_cost_usd: 1, started_at: now },
    ])
    const resolver = (id: number) =>
      id === 7 ? { title: 'Live spec', deleted: false } : { title: null, deleted: true }
    const r = getSpending(db, 'p1', { period: 'all' }, resolver)
    const t7 = r.topTickets.find((t) => t.ticketId === 7)!
    expect(t7.ticketTitle).toBe('Live spec')
    expect(t7.isDeleted).toBe(false)
    const t99 = r.topTickets.find((t) => t.ticketId === 99)!
    expect(t99.ticketTitle).toBeNull()
    expect(t99.isDeleted).toBe(true)
    // Unattributed bucket keeps null title and is not marked deleted.
    const unatt = r.topTickets.find((t) => t.ticketId === null)!
    expect(unatt.ticketTitle).toBeNull()
    expect(unatt.isDeleted).toBeUndefined()
  })

  it('keeps legacy ticketTitle:null / no isDeleted when no resolver passed', () => {
    const now = new Date().toISOString()
    seed(db, [{ id: 'a', surface: 'job', ticket_id: 7, total_cost_usd: 5, started_at: now }])
    const r = getSpending(db, 'p1', { period: 'all' })
    const t7 = r.topTickets.find((t) => t.ticketId === 7)!
    expect(t7.ticketTitle).toBeNull()
    expect(t7.isDeleted).toBeUndefined()
  })
})

// BUG-ANALYTICS-34: scatter truncation signal + outlier guarantee.
describe('scatter truncation + outlier (BUG-34)', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('reports scatterTotal and not-truncated under the cap', () => {
    const now = new Date().toISOString()
    seed(db, [
      { id: 'a', surface: 'job', total_cost_usd: 1, started_at: now },
      { id: 'b', surface: 'job', total_cost_usd: 2, started_at: now },
      { id: 'n', surface: 'job', total_cost_usd: null, started_at: now }, // unpriced excluded
    ])
    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.scatterTotal).toBe(2)
    expect(r.scatterTruncated).toBe(false)
    expect(r.scatter).toHaveLength(2)
  })

  it('truncates beyond 500 priced rows and always includes the costliest outlier', () => {
    const base = Date.now()
    const rows: Array<Partial<Parameters<typeof recordInvocation>[1]>> = []
    // The single most expensive row is the OLDEST, so recency-cap would drop it.
    rows.push({ id: 'outlier', surface: 'job', total_cost_usd: 9999, started_at: new Date(base - 600 * 1000).toISOString() })
    for (let i = 0; i < 520; i++) {
      rows.push({ id: `r${i}`, surface: 'job', total_cost_usd: 0.01, started_at: new Date(base - i * 1000).toISOString() })
    }
    seed(db, rows)
    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.scatterTotal).toBe(521)
    expect(r.scatterTruncated).toBe(true)
    // 500 recency-capped + 1 unioned outlier.
    expect(r.scatter.length).toBe(501)
    expect(r.scatter.some((p) => p.id === 'outlier' && p.costUsd === 9999)).toBe(true)
  })
})

// BUG-ANALYTICS-21: tz-offset day bucketing.
describe('dailyTimeline tz offset (BUG-21)', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('buckets a late-UTC instant into the next local day for a +offset user', () => {
    // 2026-06-27T23:30:00Z → with +600 min (UTC+10) becomes 2026-06-28 local.
    seed(db, [
      { id: 'a', surface: 'job', total_cost_usd: 1, started_at: '2026-06-27T23:30:00Z' },
    ])
    const utc = getSpending(db, 'p1', { period: 'all' })
    expect(utc.dailyTimeline.some((d) => d.date === '2026-06-27' && d.jobsCostUsd === 1)).toBe(true)
    const local = getSpending(db, 'p1', { period: 'all', tzOffsetMinutes: 600 })
    expect(local.dailyTimeline.some((d) => d.date === '2026-06-28' && d.jobsCostUsd === 1)).toBe(true)
    expect(local.dailyTimeline.some((d) => d.date === '2026-06-27' && d.jobsCostUsd === 1)).toBe(false)
  })

  it('default (no offset) is byte-identical UTC bucketing', () => {
    seed(db, [{ id: 'a', surface: 'job', total_cost_usd: 1, started_at: '2026-06-27T23:30:00Z' }])
    const r = getSpending(db, 'p1', { period: 'all' })
    expect(r.dailyTimeline.find((d) => d.date === '2026-06-27')!.jobsCostUsd).toBe(1)
  })

  it('parseSpendingFilters parses and clamps tzOffsetMinutes', () => {
    expect(parseSpendingFilters({ tzOffsetMinutes: '600' }).tzOffsetMinutes).toBe(600)
    expect(parseSpendingFilters({ tzOffsetMinutes: '-300' }).tzOffsetMinutes).toBe(-300)
    expect(parseSpendingFilters({ tzOffsetMinutes: '99999' }).tzOffsetMinutes).toBeUndefined()
    expect(parseSpendingFilters({ tzOffsetMinutes: 'abc' }).tzOffsetMinutes).toBeUndefined()
  })
})

// BUG-ANALYTICS-35: cost-sorted raw table order.
describe('getInvocations cost sort (BUG-35)', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('orders by cost desc when sortBy=cost so the costliest is on page 1', () => {
    const base = Date.now()
    // The most expensive row is the OLDEST — recency order would hide it on page 1.
    recordInvocation(db, { id: 'cheap-recent', project_id: 'p1', provider: 'claude', surface: 'job', status: 'success', total_cost_usd: 0.01, started_at: new Date(base).toISOString() })
    recordInvocation(db, { id: 'pricey-old', project_id: 'p1', provider: 'claude', surface: 'job', status: 'success', total_cost_usd: 50, started_at: new Date(base - 100000).toISOString() })
    const recency = getInvocations(db, 'p1', { period: 'all', limit: 1 })
    expect(recency.rows[0].id).toBe('cheap-recent')
    const byCost = getInvocations(db, 'p1', { period: 'all', limit: 1, sortBy: 'cost' })
    expect(byCost.rows[0].id).toBe('pricey-old')
    expect(byCost.totalAvailable).toBe(2)
  })

  it('parseSpendingFilters parses sortBy', () => {
    expect(parseSpendingFilters({ sortBy: 'cost' }).sortBy).toBe('cost')
    expect(parseSpendingFilters({ sortBy: 'recency' }).sortBy).toBe('recency')
    expect(parseSpendingFilters({ sortBy: 'bogus' }).sortBy).toBeUndefined()
  })
})
