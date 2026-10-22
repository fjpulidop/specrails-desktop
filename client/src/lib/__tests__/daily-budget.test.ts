import { describe, it, expect } from 'vitest'
import i18n from '../i18n'
import { dailyBudgetActionMessage, dailyBudgetExceededMessage, dailyBudgetPausedMessage, readDailyBudgetInfo, readDailyBudgetRejection } from '../daily-budget'

const t = i18n.t.bind(i18n)

describe('daily budget copy (rail-loop-budget-guard)', () => {
  it('parses only well-formed budget payloads', () => {
    expect(readDailyBudgetInfo({ scope: 'project', budgetUsd: 10, spentUsd: 12 })).toEqual({ scope: 'project', budgetUsd: 10, spentUsd: 12, resetsAt: null })
    expect(readDailyBudgetInfo(null)).toBeNull()
    expect(readDailyBudgetInfo({ scope: 'other', budgetUsd: 1, spentUsd: 1 })).toBeNull()
    expect(readDailyBudgetInfo({ scope: 'desktop', budgetUsd: Number.NaN, spentUsd: 1 })).toBeNull()
    expect(readDailyBudgetRejection({ error: 'tickets_in_flight', scope: 'project', budgetUsd: 1, spentUsd: 1 })).toBeNull()
    expect(readDailyBudgetRejection({ error: 'daily_budget_exceeded', scope: 'desktop', budgetUsd: 5, spentUsd: 6, resetsAt: '2026-10-22T00:00:00.000Z' }))
      .toMatchObject({ scope: 'desktop', resetsAt: '2026-10-22T00:00:00.000Z' })
  })

  it('renders scope-specific headline, pause line and remedy, with the reset time when known', () => {
    const project = { scope: 'project' as const, budgetUsd: 10, spentUsd: 12.4, resetsAt: null }
    expect(dailyBudgetExceededMessage(t, project)).toBe('Project daily budget reached ($12.40 of $10.00). Nothing was launched.')
    expect(dailyBudgetPausedMessage(t, project)).toBe('Paused on the project daily budget ($12.40 of $10.00). Raise it, then resume.')
    expect(dailyBudgetActionMessage(t, project)).toBe('Raise or clear the budget in Project settings ▸ Budget, or wait for the daily reset.')
    const desktop = { scope: 'desktop' as const, budgetUsd: 5, spentUsd: 5, resetsAt: '2026-10-22T00:00:00.000Z' }
    expect(dailyBudgetExceededMessage(t, desktop)).toContain('App-wide daily budget reached ($5.00 of $5.00)')
    expect(dailyBudgetPausedMessage(t, desktop)).toContain('app-wide')
    expect(dailyBudgetActionMessage(t, desktop)).toMatch(/^Raise or clear the budget in Settings ▸ Budget, or wait for the reset \(.+\)\.$/)
    expect(dailyBudgetActionMessage(t, { ...desktop, resetsAt: 'not a date' })).toBe('Raise or clear the budget in Settings ▸ Budget, or wait for the daily reset.')
  })
})
