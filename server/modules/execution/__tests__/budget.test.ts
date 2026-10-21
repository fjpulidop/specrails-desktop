import { describe, expect, it, vi } from 'vitest'
import { dailyBudgetRejection, dailyBudgetResetsAt, enforceDailyBudgets, evaluateDailyBudgets, localDayStartIso } from '..'
import { initDb } from '../../../db'
import { recordInvocation } from '../../accounting/runtime/ai-invocations'
import { createDailyBudgetGate } from '../runtime/daily-budget-gate'

it('enforces project then desktop budgets including exact limits', () => {
  const scopes: string[] = []
  enforceDailyBudgets({
    project: () => ({ budget: 1, totalSpend: 1 }),
    desktop: () => ({ budget: 2, totalSpend: 3 }),
    exceeded: scope => { scopes.push(scope) },
  })
  expect(scopes).toEqual(['project', 'desktop'])
})
it('never admits desktop effects after a failed project pause', () => {
  let readDesktop = false
  expect(() => enforceDailyBudgets({
    project: () => ({ budget: 1, totalSpend: 2 }),
    desktop: () => { readDesktop = true; return { budget: 1, totalSpend: 2 } },
    exceeded: () => { throw new Error('storage failed') },
  })).toThrow('storage failed')
  expect(readDesktop).toBe(false)
})
it('ignores unset and disabled budgets', () => {
  let exceeded = false
  for (const budget of [null, 0, -1, NaN]) enforceDailyBudgets({
    project: () => ({ budget, totalSpend: 99 }), exceeded: () => { exceeded = true },
  })
  expect(exceeded).toBe(false)
})

// rail-loop-budget-guard: the read-only admission check shares the predicate.

describe('evaluateDailyBudgets', () => {
  it('reports the project breach first, then the app-wide one, with exact limits', () => {
    expect(evaluateDailyBudgets({ project: () => ({ budget: 1, totalSpend: 1 }), desktop: () => ({ budget: 2, totalSpend: 3 }) }))
      .toEqual({ scope: 'project', budget: 1, totalSpend: 1 })
    expect(evaluateDailyBudgets({ project: () => ({ budget: 5, totalSpend: 1 }), desktop: () => ({ budget: 2, totalSpend: 2 }) }))
      .toEqual({ scope: 'desktop', budget: 2, totalSpend: 2 })
  })
  it('admits unset, disabled and unspent budgets without reading more than needed', () => {
    for (const budget of [null, 0, -1, NaN]) {
      expect(evaluateDailyBudgets({ project: () => ({ budget, totalSpend: 99 }) })).toBeNull()
    }
    expect(evaluateDailyBudgets({ project: () => null, desktop: () => ({ budget: 10, totalSpend: 9.99 }) })).toBeNull()
  })
})

describe('daily budget rejection body', () => {
  it('carries scope, amounts and the scope-specific reset boundary', () => {
    const now = new Date(2026, 9, 21, 15, 30)
    const body = dailyBudgetRejection({ scope: 'project', budget: 10, totalSpend: 12.345 }, now)
    expect(body).toMatchObject({ error: 'daily_budget_exceeded', scope: 'project', budgetUsd: 10, spentUsd: 12.345,
      resetsAt: new Date(2026, 9, 22).toISOString() })
    expect(body.detail).toContain('$12.35')
    expect(body.action).toContain('project daily budget')
    expect(dailyBudgetResetsAt('desktop', new Date('2026-10-21T23:59:00Z'))).toBe('2026-10-22T00:00:00.000Z')
    expect(dailyBudgetRejection({ scope: 'desktop', budget: 5, totalSpend: 5 }, now).action).toContain('app-wide')
    expect(localDayStartIso(now)).toBe(new Date(2026, 9, 21).toISOString())
  })
})

describe('createDailyBudgetGate', () => {
  it('reads the queue budget state of its own project only, plus the app-wide snapshot', () => {
    const db = initDb(':memory:')
    try {
      const gate = createDailyBudgetGate({ db, projectId: 'p1', desktop: () => ({ budget: null, totalSpend: 0 }) })
      expect(gate()).toBeNull()
      db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.daily_budget_usd', '1')`).run()
      expect(gate()).toBeNull()
      const startedAt = new Date().toISOString()
      recordInvocation(db, { project_id: 'p2', provider: 'claude', surface: 'loop', status: 'success', started_at: startedAt, total_cost_usd: 5 })
      expect(gate()).toBeNull()
      recordInvocation(db, { project_id: 'p1', provider: 'claude', surface: 'loop', status: 'success', started_at: startedAt, total_cost_usd: 1.5 })
      expect(gate()).toMatchObject({ error: 'daily_budget_exceeded', scope: 'project', budgetUsd: 1, spentUsd: 1.5 })
      db.prepare(`DELETE FROM queue_state WHERE key = 'config.daily_budget_usd'`).run()
      const desktopGate = createDailyBudgetGate({ db, projectId: 'p1', desktop: () => ({ budget: 3, totalSpend: 4 }) })
      expect(desktopGate()).toMatchObject({ scope: 'desktop', budgetUsd: 3, spentUsd: 4 })
    } finally { db.close() }
  })
  it('fails open when budget storage cannot be read', () => {
    const db = initDb(':memory:')
    db.close()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(createDailyBudgetGate({ db, projectId: 'p1' })()).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
