/**
 * Budget and review-WIP admission for one project's rail/loop launches.
 *
 * Owns binding the cap readers to THIS project's connection plus the
 * app-wide snapshots the registry computes, so the queue auto-pause and the
 * launch gates read the same budget state.
 */
import type { DbInstance } from './db'
import { getProjectSettings } from './db'
import { effectiveRunCap, type CapPeriod, type CapStatus, type DailyBudgetRejection } from './modules/execution'
import { readProjectCaps, type CapConfig } from './modules/execution/adapters/budget-storage'
import { createDailyBudgetGate, createDailyBudgetHeadroom, readCapStatuses, type DailyBudgetHeadroom } from './modules/execution/runtime/daily-budget-gate'
import { createReviewWipGate, type ReviewWipGate } from './modules/delivery/runtime/review-wip-gate'

type BudgetSnapshot = { budget: number | null; totalSpend: number }

export interface ProjectBudgetGates {
  dailyBudgetRejection: () => DailyBudgetRejection | null
  dailyBudgetHeadroom: () => DailyBudgetHeadroom | null
  budgetCaps: (at?: Date) => CapStatus[]
  runCapDefault: () => number | null
  reviewWipGate: ReviewWipGate
}

export function createProjectBudgetGates(deps: {
  db: DbInstance
  projectId: string
  desktopDb: DbInstance
  desktopDailyBudget: () => BudgetSnapshot
  desktopPeriodBudget: (period: Exclude<CapPeriod, 'day'>, at: Date) => BudgetSnapshot
  desktopCapConfig: () => CapConfig
}): ProjectBudgetGates {
  const { db } = deps
  // Same budget state the queue auto-pause enforces; bound to THIS project's
  // connection (project budget) plus the app-wide snapshot.
  const capOptions = { db, projectId: deps.projectId, appLedgerDb: deps.desktopDb, desktop: () => deps.desktopDailyBudget(), desktopPeriod: (period: Exclude<CapPeriod, 'day'>, at: Date) => deps.desktopPeriodBudget(period, at) }
  const dailyBudgetRejection = createDailyBudgetGate(capOptions)
  const dailyBudgetHeadroom = createDailyBudgetHeadroom(capOptions)
  // Every configured cap with its spend (Budget panel, inbox, mid-run pause).
  const budgetCaps = (at: Date = new Date()): CapStatus[] => readCapStatuses(capOptions, at)
  // The per-run soft cap that applies to a new run: the tighter of the
  // project's and the app-wide default (null = none).
  const runCapDefault = (): number | null => effectiveRunCap(readProjectCaps(db).run, deps.desktopCapConfig().run)
  const reviewWipGate = createReviewWipGate({ db, readLimit: () => getProjectSettings(db).reviewWipLimit })
  return { dailyBudgetRejection, dailyBudgetHeadroom, budgetCaps, runCapDefault, reviewWipGate }
}
