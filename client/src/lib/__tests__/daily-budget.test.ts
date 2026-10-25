import { describe, it, expect } from 'vitest'
import i18n from '../i18n'
import { dailyBudgetActionMessage, dailyBudgetExceededMessage, dailyBudgetPausedMessage, readDailyBudgetInfo, readDailyBudgetRejection } from '../daily-budget'

const t = i18n.t.bind(i18n)

describe('daily budget copy (rail-loop-budget-guard)', () => {
  it('parses only well-formed budget payloads', () => {
    expect(readDailyBudgetInfo({ scope: 'project', budgetUsd: 10, spentUsd: 12 })).toEqual({ scope: 'project', period: 'day', budgetUsd: 10, spentUsd: 12, resetsAt: null })
    expect(readDailyBudgetInfo(null)).toBeNull()
    expect(readDailyBudgetInfo({ scope: 'other', budgetUsd: 1, spentUsd: 1 })).toBeNull()
    expect(readDailyBudgetInfo({ scope: 'desktop', budgetUsd: Number.NaN, spentUsd: 1 })).toBeNull()
    expect(readDailyBudgetRejection({ error: 'tickets_in_flight', scope: 'project', budgetUsd: 1, spentUsd: 1 })).toBeNull()
    expect(readDailyBudgetRejection({ error: 'daily_budget_exceeded', scope: 'desktop', budgetUsd: 5, spentUsd: 6, resetsAt: '2026-10-22T00:00:00.000Z' }))
      .toMatchObject({ scope: 'desktop', resetsAt: '2026-10-22T00:00:00.000Z' })
  })

  it('renders scope-specific headline, pause line and remedy, with the reset time when known', () => {
    const project = { scope: 'project' as const, period: 'day' as const, budgetUsd: 10, spentUsd: 12.4, resetsAt: null }
    expect(dailyBudgetExceededMessage(t, project)).toBe('Project daily budget reached ($12.40 of $10.00). Nothing was launched.')
    expect(dailyBudgetPausedMessage(t, project)).toBe('Paused on the project daily budget ($12.40 of $10.00). Raise it, then resume.')
    expect(dailyBudgetActionMessage(t, project)).toBe('Raise or clear the budget in Analytics ▸ Budget, or wait for the daily reset.')
    const desktop = { scope: 'desktop' as const, period: 'day' as const, budgetUsd: 5, spentUsd: 5, resetsAt: '2026-10-22T00:00:00.000Z' }
    expect(dailyBudgetExceededMessage(t, desktop)).toContain('App-wide daily budget reached ($5.00 of $5.00)')
    expect(dailyBudgetPausedMessage(t, desktop)).toContain('app-wide')
    expect(dailyBudgetActionMessage(t, desktop)).toMatch(/^Raise or clear the budget in Analytics ▸ Budget, or wait for the reset \(.+\)\.$/)
    expect(dailyBudgetActionMessage(t, { ...desktop, resetsAt: 'not a date' })).toBe('Raise or clear the budget in Analytics ▸ Budget, or wait for the daily reset.')
  })

  it('reads the period of a longer cap and words it for that period (CD5)', () => {
    expect(readDailyBudgetInfo({ scope: 'project', period: 'week', budgetUsd: 50, spentUsd: 51 })).toMatchObject({ period: 'week' })
    expect(readDailyBudgetInfo({ scope: 'project', period: 'run', budgetUsd: 5, spentUsd: 5, resetsAt: null })).toMatchObject({ period: 'run', resetsAt: null })
    // An unknown period falls back to the daily budget, like a body from before caps.
    expect(readDailyBudgetInfo({ scope: 'project', period: 'fortnight', budgetUsd: 1, spentUsd: 1 })).toMatchObject({ period: 'day' })
    const week = { scope: 'project' as const, period: 'week' as const, budgetUsd: 50, spentUsd: 52.5, resetsAt: '2026-10-26T00:00:00.000Z' }
    expect(dailyBudgetExceededMessage(t, week)).toBe('Project weekly budget reached ($52.50 of $50.00). Nothing was launched.')
    expect(dailyBudgetPausedMessage(t, { ...week, scope: 'desktop', period: 'month' })).toBe('Paused on the app-wide monthly budget ($52.50 of $50.00). Raise it, then resume.')
    expect(dailyBudgetActionMessage(t, week)).toMatch(/^Raise or clear the budget in Analytics ▸ Budget, or wait for the reset \(.+\)\.$/)
    const run = { scope: 'project' as const, period: 'run' as const, budgetUsd: 5, spentUsd: 5.2, resetsAt: null }
    expect(dailyBudgetPausedMessage(t, run)).toBe('Paused at the per-run cap ($5.20 of $5.00). Continue without it or raise it.')
    expect(dailyBudgetExceededMessage(t, run)).toContain('Per-run cap reached')
    expect(dailyBudgetActionMessage(t, run)).toBe('Continue without the cap, or raise it, then resume.')
  })
})
