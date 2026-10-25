import type { DailyBudgetInfo } from './daily-budget'

/** How a resume answers a run paused at its per-run soft cap. */
export type RunCapChoice = { runCap: 'ignore' } | { runCapUsd: number }

const toCents = (usd: number): number => Math.round(usd * 100)

/** A starting point for "raise to": one more cap's worth above what the run already spent (cents precision). */
export function suggestedRaise(info: Pick<DailyBudgetInfo, 'budgetUsd' | 'spentUsd'>): number {
  return Math.ceil(toCents(info.spentUsd) + toCents(info.budgetUsd)) / 100
}

/** A raise only continues the run when it ends up above the spend. */
export function isValidRaise(amount: number, info: Pick<DailyBudgetInfo, 'spentUsd'>): boolean {
  return Number.isFinite(amount) && toCents(amount) > toCents(info.spentUsd)
}
