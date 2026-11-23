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
  /**
   * Which cap was reached. Absent = the daily budget (the historical body, byte
   * identical); `week`/`month` are the longer caps and `run` the per-run soft cap.
   */
  period?: 'week' | 'month' | 'run'
  budgetUsd: number
  spentUsd: number
  /** When the spend window rolls over (ISO). Raising the budget also clears it. Null for a per-run cap (no window). */
  resetsAt: string | null
  detail: string
  action: string
  /** Per-run cap only: how far the run's cost went past the cap (when it did). */
  overshootUsd?: number
  /** Per-run cap only: the next turn's expected cost, when the cap was enforced before that turn. */
  nextTurnUsd?: number
  /** Per-run cap only: the step the run is paused before and what it is expected to cost (and why). */
  nextStep?: NextStepEstimate
  /** Per-run cap only: what is left of the cap when it was enforced before the next step. */
  remainingUsd?: number
}

/**
 * What the next AI step is expected to cost: its own earlier turns in this run, else the
 * median of its turns in the project's recent runs on the same provider and model, else a
 * rate-card estimate of a typical turn of its kind. Always an ESTIMATE.
 */
export interface NextStepEstimate {
  /** The workflow node (`developer`). */
  nodePath: string
  /** What the person reads (`Developer`). */
  label: string
  usd: number
  basis: 'run' | 'history' | 'default'
  /** How many turns the estimate stands on (0 for a default). */
  samples: number
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
