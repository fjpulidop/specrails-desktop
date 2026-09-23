export interface BudgetSnapshot { budget: number | null; totalSpend: number }
export interface BudgetEnforcementPorts {
  project(): BudgetSnapshot | null
  desktop?(): BudgetSnapshot
  exceeded(scope: 'project' | 'desktop', snapshot: BudgetSnapshot & { budget: number }): void
}

/** Project admission is evaluated first; storage failures abort later effects. */
export function enforceDailyBudgets(ports: BudgetEnforcementPorts): void {
  const enforce = (scope: 'project' | 'desktop', snapshot: BudgetSnapshot | null) => {
    if (snapshot?.budget != null && snapshot.budget > 0 && snapshot.totalSpend >= snapshot.budget) {
      ports.exceeded(scope, { ...snapshot, budget: snapshot.budget })
    }
  }
  enforce('project', ports.project())
  if (ports.desktop) enforce('desktop', ports.desktop())
}
