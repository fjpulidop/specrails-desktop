import type { DailyBudgetInfo } from './daily-budget'

/** How a resume answers a run paused at its per-run soft cap: waive it, run only the next step past it, or raise it. */
export type RunCapChoice = { runCap: 'ignore' } | { runCap: 'once' } | { runCapUsd: number }

const toCents = (usd: number): number => Math.round(usd * 100)

/**
 * A starting point for "raise to": one more cap's worth above what the run already spent (cents
 * precision), and at least enough for the next step when the run stopped before one it expects to
 * cost more (a raise below that would stop it again at once).
 */
export function suggestedRaise(info: Pick<DailyBudgetInfo, 'budgetUsd' | 'spentUsd' | 'nextStep'>): number {
  const spent = toCents(info.spentUsd)
  const forNextStep = info.nextStep ? spent + Math.ceil(info.nextStep.usd * 100 - 1e-9) : 0
  // A cap below a cent (or no spend yet) still suggests a valid raise: at least one cent above the spend.
  return Math.max(spent + toCents(info.budgetUsd), spent + 1, forNextStep) / 100
}

/** A raise only continues the run when it ends up above the spend. */
export function isValidRaise(amount: number, info: Pick<DailyBudgetInfo, 'spentUsd'>): boolean {
  return Number.isFinite(amount) && toCents(amount) > toCents(info.spentUsd)
}
