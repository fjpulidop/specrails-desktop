/**
 * Daily budget vocabulary shared by every cost-incurring admission door: the
 * QueueManager auto-pause, rail launches and loop runs between AI steps.
 * Pure: callers supply the clock.
 */
export type DailyBudgetScope = 'project' | 'desktop'

/** A configured daily budget that the day's spend has reached or passed. */
export interface DailyBudgetBreach {
  scope: DailyBudgetScope
  budget: number
  totalSpend: number
}

/** The stable 409 body every launch/resume door returns while over budget. */
export interface DailyBudgetRejection {
  error: 'daily_budget_exceeded'
  scope: DailyBudgetScope
  budgetUsd: number
  spentUsd: number
  /** When the spend window rolls over (ISO). Raising the budget also clears it. */
  resetsAt: string
  detail: string
  action: string
}

/** Local calendar-day start as a UTC ISO instant (comparable to `started_at`). */
export function localDayStartIso(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

/**
 * The project budget sums the user's LOCAL day; the app-wide budget sums the
 * UTC day (`date('now')`). Each scope reports the boundary it actually uses.
 */
export function dailyBudgetResetsAt(scope: DailyBudgetScope, now: Date): string {
  return scope === 'project'
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
}

export function isDailyBudgetExceeded(snapshot: { budget: number | null; totalSpend: number } | null): snapshot is { budget: number; totalSpend: number } {
  return snapshot?.budget != null && snapshot.budget > 0 && snapshot.totalSpend >= snapshot.budget
}

export function dailyBudgetRejection(breach: DailyBudgetBreach, now: Date): DailyBudgetRejection {
  const label = breach.scope === 'project' ? 'project' : 'app-wide'
  return {
    error: 'daily_budget_exceeded',
    scope: breach.scope,
    budgetUsd: breach.budget,
    spentUsd: breach.totalSpend,
    resetsAt: dailyBudgetResetsAt(breach.scope, now),
    detail: `Today's spend $${breach.totalSpend.toFixed(2)} has reached the ${label} daily budget of $${breach.budget.toFixed(2)}.`,
    action: breach.scope === 'project'
      ? 'Raise or clear the project daily budget (Project settings ▸ Budget), or wait for the daily reset.'
      : 'Raise or clear the app-wide daily budget (Settings ▸ Budget), or wait for the daily reset.',
  }
}
