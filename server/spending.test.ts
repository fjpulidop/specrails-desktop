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
    expect(r.bySurface).toHaveLength(7) // job, quick-spec, explore-spec, ai-edit, smash, file-summary, loop
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
      { model: 'opus', count: 1, costUsd: 5 },
      { model: 'sonnet', count: 2, costUsd: 3 },
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
