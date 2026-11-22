import type { DailyBudgetInfo } from './daily-budget'

/** How a resume answers a run paused at its per-run soft cap: waive it, run only the next step past it, or raise it. */
export type RunCapChoice = { runCap: 'ignore' } | { runCap: 'once' } | { runCapUsd: number }

const toCents = (usd: number): number => Math.round(usd * 100)

/** A starting point for "raise to": one more cap's worth above what the run already spent (cents precision). */
export function suggestedRaise(info: Pick<DailyBudgetInfo, 'budgetUsd' | 'spentUsd'>): number {
  // A cap below a cent (or no spend yet) still suggests a valid raise: at least one cent above the spend.
  return Math.max(toCents(info.spentUsd) + toCents(info.budgetUsd), toCents(info.spentUsd) + 1) / 100
}

/** A raise only continues the run when it ends up above the spend. */
export function isValidRaise(amount: number, info: Pick<DailyBudgetInfo, 'spentUsd'>): boolean {
  return Number.isFinite(amount) && toCents(amount) > toCents(info.spentUsd)
}
