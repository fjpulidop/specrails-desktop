/**
 * Spend caps beyond the daily budget (CD5): weekly and monthly caps per project
 * and app-wide, and the per-run soft cap. Pure: callers supply the clock and
 * the spend. Money math is integer cents so a boundary never flips on float
 * drift, and a projection is always an estimate, never a billed figure.
 *
 * Periods are LOCAL: the day starts at local midnight, the week on Monday
 * 00:00 local, the month on the 1st 00:00 local (DST-safe: built from calendar
 * fields, not from fixed 24 h offsets).
 */
import type { DailyBudgetRejection, DailyBudgetScope } from './daily-budget'

export type CapPeriod = 'day' | 'week' | 'month'
export const CAP_PERIODS: readonly CapPeriod[] = ['day', 'week', 'month']

/** A cap's period, or `run` for the per-run soft cap. */
export type BudgetPeriod = CapPeriod | 'run'

/** One configured cap and where its spend stands. */
export interface CapStatus {
  scope: DailyBudgetScope
  period: CapPeriod
  budgetUsd: number
  spentUsd: number
  /** Spend has reached the cap (a launch is refused, running loops pause). */
  exhausted: boolean
  /** When the spend window rolls over (ISO). */
  resetsAt: string
}

export const toCents = (usd: number): number => Math.round(usd * 100)
export const fromCents = (cents: number): number => cents / 100

/** First instant of the period containing `now`, in local time. */
export function periodStart(period: CapPeriod, now: Date): Date {
  if (period === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (period === 'week') {
    // Monday = 0 … Sunday = 6
    const sinceMonday = (now.getDay() + 6) % 7
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday)
  }
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

/** First instant of the NEXT period (the reset), in local time. */
export function periodEnd(period: CapPeriod, now: Date): Date {
  const start = periodStart(period, now)
  if (period === 'day') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
  if (period === 'week') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
  return new Date(start.getFullYear(), start.getMonth() + 1, 1)
}

export const periodStartIso = (period: CapPeriod, now: Date): string => periodStart(period, now).toISOString()
export const periodResetsAtIso = (period: CapPeriod, now: Date): string => periodEnd(period, now).toISOString()

export function isCapExceeded(budgetUsd: number | null | undefined, spentUsd: number): boolean {
  return budgetUsd != null && budgetUsd > 0 && toCents(spentUsd) >= toCents(budgetUsd)
}

/** Remaining headroom in cents (negative once over). */
export const capHeadroomCents = (status: Pick<CapStatus, 'budgetUsd' | 'spentUsd'>): number =>
  toCents(status.budgetUsd) - toCents(status.spentUsd)

/**
 * The tightest cap: the exhausted one that comes first in the given (scope,
 * period) order, else the one with the least money left. Callers pass the
 * statuses project-first so the narrower scope wins ties, like the daily gate.
 */
export function tightestCap(statuses: readonly CapStatus[]): CapStatus | null {
  let best: CapStatus | null = null
  for (const status of statuses) {
    if (!best) { best = status; continue }
    if (status.exhausted && !best.exhausted) { best = status; continue }
    if (status.exhausted === best.exhausted && capHeadroomCents(status) < capHeadroomCents(best)) best = status
  }
  return best
}

/** The first exhausted cap in order (project day/week/month, then app-wide). */
export function firstExhaustedCap(statuses: readonly CapStatus[]): CapStatus | null {
  return statuses.find((status) => status.exhausted) ?? null
}

const PERIOD_ADJECTIVE: Record<BudgetPeriod, string> = { day: 'daily', week: 'weekly', month: 'monthly', run: 'per-run' }
const PERIOD_RESET_WORD: Record<CapPeriod, string> = { day: 'daily', week: 'weekly', month: 'monthly' }
const PERIOD_SPEND: Record<CapPeriod, string> = { day: "Today's", week: "This week's", month: "This month's" }

/**
 * The stable 409 body for a cap of any period. A daily cap yields EXACTLY the
 * historical body (no `period` field); week/month add `period` so clients that
 * predate caps still read a valid daily-budget rejection.
 */
export function capRejection(status: CapStatus): DailyBudgetRejection {
  const label = status.scope === 'project' ? 'project' : 'app-wide'
  const where = status.scope === 'project' ? 'Project settings ▸ Budget' : 'Settings ▸ Budget'
  const adjective = PERIOD_ADJECTIVE[status.period]
  return {
    error: 'daily_budget_exceeded',
    scope: status.scope,
    ...(status.period === 'day' ? {} : { period: status.period }),
    budgetUsd: status.budgetUsd,
    spentUsd: status.spentUsd,
    resetsAt: status.resetsAt,
    detail: `${PERIOD_SPEND[status.period]} spend $${status.spentUsd.toFixed(2)} has reached the ${label} ${adjective} budget of $${status.budgetUsd.toFixed(2)}.`,
    action: `Raise or clear the ${label} ${adjective} budget (${where}), or wait for the ${PERIOD_RESET_WORD[status.period]} reset.`,
  }
}

/** The per-run soft cap crossed by one run's provider-reported cost. */
export function runCapRejection(capUsd: number, runCostUsd: number): DailyBudgetRejection {
  return {
    error: 'daily_budget_exceeded',
    scope: 'project',
    period: 'run',
    budgetUsd: capUsd,
    spentUsd: runCostUsd,
    resetsAt: null,
    detail: `This run's cost $${runCostUsd.toFixed(2)} has reached the per-run cap of $${capUsd.toFixed(2)}.`,
    action: 'Continue without the cap, or raise the per-run cap, and the run resumes from the next step.',
  }
}

/** Does a run's cost-so-far cross its soft cap? (`null`/0 cap = no cap.) */
export const isRunCapCrossed = (capUsd: number | null | undefined, runCostUsd: number): boolean =>
  capUsd != null && capUsd > 0 && toCents(runCostUsd) >= toCents(capUsd)

/** The tighter (smaller) of the per-run caps that apply; 0/null mean "none". */
export function effectiveRunCap(...caps: Array<number | null | undefined>): number | null {
  const set = caps.filter((cap): cap is number => cap != null && cap > 0)
  return set.length ? Math.min(...set) : null
}

// ─── Projection ──────────────────────────────────────────────────────────────

export interface DailySpendPoint {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  /** Provider-reported cost recorded that day (cents). */
  cents: number
}

export interface MonthProjection {
  /** Window the burn was averaged over. */
  trailingDays: number
  /** Average daily burn over the window, in whole cents (rounded). */
  avgDailyCents: number
  /** Spend recorded so far this month (cents). */
  monthToDateCents: number
  /** Full days left after today (the month end projection adds them). */
  remainingDays: number
  /** month-to-date + average × remaining days (cents). An ESTIMATE. */
  projectedCents: number
}

export const TRAILING_DAYS = 14

/** `YYYY-MM-DD` in LOCAL time. */
export function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Month-end projection from the trailing burn: the average of the last
 * `trailingDays` COMPLETED days (today is partial and excluded) times the days
 * left after today, added to the month-to-date spend. Integer cents end to end
 * (the average rounds once). Null when there is no completed day of history —
 * nothing honest to extrapolate from.
 */
export function projectMonthEnd(
  daily: readonly DailySpendPoint[],
  now: Date,
  monthToDateCents: number,
  trailingDays: number = TRAILING_DAYS,
): MonthProjection | null {
  const todayKey = localDayKey(now)
  const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - trailingDays)
  const earliestKey = localDayKey(earliest)
  const byDay = new Map<string, number>()
  for (const point of daily) byDay.set(point.day, (byDay.get(point.day) ?? 0) + point.cents)
  let total = 0
  let observedDays = 0
  // Days with no row were days with no spend, but only after the first recorded
  // day: before it we simply have no history, so it is not averaged in as $0.
  const firstRecorded = [...byDay.keys()].filter((key) => key >= earliestKey && key < todayKey).sort()[0]
  if (!firstRecorded) return null
  for (let i = trailingDays; i >= 1; i--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = localDayKey(day)
    if (key < firstRecorded) continue
    observedDays++
    total += byDay.get(key) ?? 0
  }
  if (observedDays === 0) return null
  const avgDailyCents = Math.round(total / observedDays)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const remainingDays = Math.max(0, daysInMonth - now.getDate())
  return {
    trailingDays: observedDays,
    avgDailyCents,
    monthToDateCents,
    remainingDays,
    projectedCents: monthToDateCents + avgDailyCents * remainingDays,
  }
}
