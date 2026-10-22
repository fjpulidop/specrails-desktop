import { isDailyBudgetExceeded, type DailyBudgetBreach, type DailyBudgetScope } from '../domain/daily-budget'

export interface BudgetSnapshot { budget: number | null; totalSpend: number }
export interface BudgetEvaluationPorts {
  project(): BudgetSnapshot | null
  desktop?(): BudgetSnapshot
}
export interface BudgetEnforcementPorts extends BudgetEvaluationPorts {
  exceeded(scope: DailyBudgetScope, snapshot: BudgetSnapshot & { budget: number }): void
}

/** Project admission is evaluated first; storage failures abort later effects. */
export function enforceDailyBudgets(ports: BudgetEnforcementPorts): void {
  const enforce = (scope: DailyBudgetScope, snapshot: BudgetSnapshot | null) => {
    if (isDailyBudgetExceeded(snapshot)) ports.exceeded(scope, { ...snapshot, budget: snapshot.budget })
  }
  enforce('project', ports.project())
  if (ports.desktop) enforce('desktop', ports.desktop())
}

/**
 * Read-only admission check for cost-incurring launches: the same budgets and
 * the same predicate as {@link enforceDailyBudgets}, without pausing anything.
 * The project budget wins when both are exceeded (it is the narrower cap).
 */
export function evaluateDailyBudgets(ports: BudgetEvaluationPorts): DailyBudgetBreach | null {
  const project = ports.project()
  if (isDailyBudgetExceeded(project)) return { scope: 'project', budget: project.budget, totalSpend: project.totalSpend }
  const desktop = ports.desktop?.() ?? null
  if (isDailyBudgetExceeded(desktop)) return { scope: 'desktop', budget: desktop.budget, totalSpend: desktop.totalSpend }
  return null
}
