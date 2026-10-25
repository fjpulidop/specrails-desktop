import { describe, expect, it } from 'vitest'
import { initDb } from '../../../db'
import { recordInvocation } from '../../accounting/runtime/ai-invocations'
import {
  capRejection, dailyBudgetRejection, effectiveRunCap, firstExhaustedCap, isRunCapCrossed, localDayKey, periodEnd, periodStart,
  projectMonthEnd, runCapRejection, tightestCap, type CapStatus,
} from '..'
import { createDailyBudgetGate, createDailyBudgetHeadroom, readCapStatuses } from '../runtime/daily-budget-gate'
import { readSpendOverview } from '../runtime/budget-overview'
import { readProjectCaps, writeProjectCap } from '../adapters/budget-storage'

const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h)

describe('periods (local time)', () => {
  it('starts the week on Monday 00:00, including from a Sunday', () => {
    // 2026-10-25 is a Sunday; the week began Monday 2026-10-19.
    expect(periodStart('week', local(2026, 10, 25))).toEqual(local(2026, 10, 19, 0))
    expect(periodStart('week', local(2026, 10, 19, 0))).toEqual(local(2026, 10, 19, 0))
    expect(periodEnd('week', local(2026, 10, 25, 23))).toEqual(local(2026, 10, 26, 0))
  })
  it('rolls the week and the month over at local midnight', () => {
    expect(periodStart('week', local(2026, 10, 26, 0))).toEqual(local(2026, 10, 26, 0))
    expect(periodEnd('month', local(2026, 10, 31, 23))).toEqual(local(2026, 11, 1, 0))
    expect(periodStart('month', local(2026, 11, 1, 0))).toEqual(local(2026, 11, 1, 0))
    expect(periodEnd('month', local(2026, 12, 15))).toEqual(local(2027, 1, 1, 0))
  })
  it('crosses a year boundary in a week', () => {
    expect(periodStart('week', local(2027, 1, 1))).toEqual(local(2026, 12, 28, 0))
  })
})

describe('cap selection', () => {
  const cap = (over: Partial<CapStatus>): CapStatus => ({ scope: 'project', period: 'day', budgetUsd: 10, spentUsd: 1, exhausted: false, resetsAt: 'x', ...over })
  it('picks the first exhausted cap in order (project before app-wide)', () => {
    const statuses = [cap({}), cap({ period: 'week', exhausted: true, spentUsd: 10 }), cap({ scope: 'desktop', exhausted: true, spentUsd: 10 })]
    expect(firstExhaustedCap(statuses)).toBe(statuses[1])
    expect(firstExhaustedCap([cap({})])).toBeNull()
  })
  it('the tightest cap is the exhausted one, else the least headroom (tie keeps the first)', () => {
    const a = cap({ budgetUsd: 10, spentUsd: 4 })
    const b = cap({ period: 'month', budgetUsd: 100, spentUsd: 98 })
    expect(tightestCap([a, b])).toBe(b)
    const c = cap({ scope: 'desktop', budgetUsd: 6, spentUsd: 6, exhausted: true })
    expect(tightestCap([a, b, c])).toBe(c)
    expect(tightestCap([a, cap({ period: 'week', budgetUsd: 10, spentUsd: 4 })])).toBe(a)
    expect(tightestCap([])).toBeNull()
  })
  it('keeps the historical daily rejection byte-identical and tags longer caps with their period', () => {
    const at = new Date(2026, 9, 21, 12)
    const day = cap({ budgetUsd: 10, spentUsd: 12.4, exhausted: true, resetsAt: new Date(2026, 9, 22).toISOString() })
    expect(capRejection(day)).toEqual(dailyBudgetRejection({ scope: 'project', budget: 10, totalSpend: 12.4 }, at))
    const desktopDay = cap({ scope: 'desktop', budgetUsd: 3, spentUsd: 4, exhausted: true, resetsAt: new Date(Date.UTC(2026, 9, 22)).toISOString() })
    expect(capRejection(desktopDay)).toEqual(dailyBudgetRejection({ scope: 'desktop', budget: 3, totalSpend: 4 }, at))
    const week = capRejection(cap({ period: 'week', budgetUsd: 50, spentUsd: 50, exhausted: true }))
    expect(week).toMatchObject({ error: 'daily_budget_exceeded', period: 'week', scope: 'project' })
    expect(week.detail).toContain('weekly')
    expect(capRejection(cap({ period: 'month', scope: 'desktop', exhausted: true })).action).toContain('app-wide monthly')
  })
})

describe('per-run soft cap', () => {
  it('crosses at the exact cent and ignores unset/zero caps', () => {
    expect(isRunCapCrossed(5, 4.99)).toBe(false)
    expect(isRunCapCrossed(5, 5)).toBe(true)
    expect(isRunCapCrossed(0.3, 0.1 + 0.2)).toBe(true) // float drift: 0.30000000000000004
    expect(isRunCapCrossed(null, 99)).toBe(false)
    expect(isRunCapCrossed(0, 99)).toBe(false)
  })
  it('takes the tighter of the project and app caps', () => {
    expect(effectiveRunCap(5, 3)).toBe(3)
    expect(effectiveRunCap(null, 3)).toBe(3)
    expect(effectiveRunCap(null, undefined, 0)).toBeNull()
  })
  it('describes the rejection without a reset window', () => {
    expect(runCapRejection(5, 5.2)).toMatchObject({ period: 'run', budgetUsd: 5, spentUsd: 5.2, resetsAt: null })
  })
})

describe('month-end projection (integer cents)', () => {
  const now = local(2026, 10, 25) // 6 days left after today (31-day month)
  const day = (offset: number, cents: number) => ({ day: localDayKey(new Date(2026, 9, 25 - offset)), cents })
  it('projects month-to-date plus the trailing average times the remaining days', () => {
    const daily = Array.from({ length: 14 }, (_, i) => day(i + 1, 1000)) // $10 a day for 14 completed days
    const p = projectMonthEnd(daily, now, 24_000)
    expect(p).toEqual({ trailingDays: 14, avgDailyCents: 1000, monthToDateCents: 24_000, remainingDays: 6, projectedCents: 24_000 + 6000 })
  })
  it('counts quiet days after the first recorded one as zero, not before it', () => {
    // History starts 3 days ago: $9, nothing, $6 -> average $5 over 3 observed days.
    const p = projectMonthEnd([day(3, 900), day(1, 600)], now, 1500)
    expect(p).toMatchObject({ trailingDays: 3, avgDailyCents: 500, projectedCents: 1500 + 500 * 6 })
  })
  it('rounds the average once and never uses today (a partial day)', () => {
    const p = projectMonthEnd([day(2, 100), day(1, 101), { day: localDayKey(now), cents: 99_999 }], now, 0)
    expect(p?.avgDailyCents).toBe(Math.round(201 / 2))
  })
  it('is null without any completed day of history', () => {
    expect(projectMonthEnd([], now, 500)).toBeNull()
    expect(projectMonthEnd([{ day: localDayKey(now), cents: 500 }], now, 500)).toBeNull()
  })
  it('has no remaining days on the last day of the month', () => {
    const last = local(2026, 10, 31)
    const p = projectMonthEnd([{ day: localDayKey(new Date(2026, 9, 30)), cents: 700 }], last, 9000)
    expect(p).toMatchObject({ remainingDays: 0, projectedCents: 9000 })
  })
})

describe('cap gating on a project database', () => {
  const invoke = (db: ReturnType<typeof initDb>, project: string, at: Date, cost: number) =>
    recordInvocation(db, { project_id: project, provider: 'claude', surface: 'loop', status: 'success', started_at: at.toISOString(), total_cost_usd: cost })

  it('refuses at the weekly cap but admits again once the week rolls over', () => {
    const db = initDb(':memory:')
    try {
      writeProjectCap(db, 'week', 20)
      invoke(db, 'p1', local(2026, 10, 20), 12) // Tuesday
      invoke(db, 'p1', local(2026, 10, 22), 8) // Thursday -> $20 exactly
      const gate = (at: Date) => createDailyBudgetGate({ db, projectId: 'p1', now: () => at })()
      expect(gate(local(2026, 10, 25))).toMatchObject({ period: 'week', scope: 'project', budgetUsd: 20, spentUsd: 20 })
      // Monday 26th local midnight: a new week, spend resets.
      expect(gate(local(2026, 10, 26, 0))).toBeNull()
    } finally { db.close() }
  })

  it('rolls the monthly cap over on the 1st', () => {
    const db = initDb(':memory:')
    try {
      writeProjectCap(db, 'month', 100)
      invoke(db, 'p1', local(2026, 10, 3), 60)
      invoke(db, 'p1', local(2026, 10, 30), 40)
      const gate = (at: Date) => createDailyBudgetGate({ db, projectId: 'p1', now: () => at })()
      expect(gate(local(2026, 10, 31, 23))).toMatchObject({ period: 'month', budgetUsd: 100 })
      expect(gate(local(2026, 11, 1, 0))).toBeNull()
    } finally { db.close() }
  })

  it('gates on the tightest scope: app-wide weekly beats a roomy project cap', () => {
    const db = initDb(':memory:')
    try {
      writeProjectCap(db, 'week', 100)
      invoke(db, 'p1', local(2026, 10, 21), 5)
      const at = local(2026, 10, 22)
      const options = { db, projectId: 'p1', now: () => at, desktopPeriod: (period: 'week' | 'month') => (period === 'week' ? { budget: 30, totalSpend: 31 } : { budget: null, totalSpend: 0 }) }
      expect(createDailyBudgetGate(options)()).toMatchObject({ scope: 'desktop', period: 'week', budgetUsd: 30, spentUsd: 31 })
      // Project cap exhausted too: the narrower project scope is reported first.
      writeProjectCap(db, 'week', 5)
      expect(createDailyBudgetGate(options)()).toMatchObject({ scope: 'project', period: 'week' })
      // The forecast reports whichever cap has the least money left (here the app-wide one is $1 over).
      expect(createDailyBudgetHeadroom(options)()).toMatchObject({ scope: 'desktop', period: 'week', exhausted: true })
    } finally { db.close() }
  })

  it('leaves a project without caps untouched and keeps other projects out of its spend', () => {
    const db = initDb(':memory:')
    try {
      invoke(db, 'p2', local(2026, 10, 21), 999)
      writeProjectCap(db, 'month', 10)
      expect(createDailyBudgetGate({ db, projectId: 'p1', now: () => local(2026, 10, 22) })()).toBeNull()
      expect(readCapStatuses({ db, projectId: 'p1' }, local(2026, 10, 22))).toEqual([expect.objectContaining({ period: 'month', spentUsd: 0, exhausted: false })])
      expect(readProjectCaps(db)).toEqual({ day: null, week: null, month: 10, run: null })
      writeProjectCap(db, 'month', null)
      expect(readProjectCaps(db).month).toBeNull()
    } finally { db.close() }
  })

  it('reports spend per provider with the estimated part apart, and a projection from the trailing burn', () => {
    const db = initDb(':memory:')
    try {
      const now = local(2026, 10, 25)
      for (let i = 1; i <= 3; i++) invoke(db, 'p1', local(2026, 10, 25 - i), 10)
      recordInvocation(db, { project_id: 'p1', provider: 'codex', surface: 'loop', status: 'success', started_at: local(2026, 10, 24).toISOString(), total_cost_usd: 2, total_cost_usd_estimated: true, num_turns: 7 })
      const overview = readSpendOverview([{ db, projectId: 'p1' }], now)
      expect(overview.spend.month.usd).toBe(32)
      expect(overview.spend.month.estimatedUsd).toBe(2)
      expect(overview.spend.month.byProvider.find((p) => p.provider === 'codex')).toMatchObject({ usd: 2, estimatedUsd: 2, turns: 7, invocations: 1 })
      expect(overview.projection).toMatchObject({ estimate: true, trailingDays: 3, monthToDateUsd: 32 })
      expect(overview.projection?.projectedUsd).toBeCloseTo(32 + (32 / 3) * 6, 1)
    } finally { db.close() }
  })
})
