import type { TFunction } from 'i18next'
import { format } from 'date-fns'
import { getDateFnsLocale } from './i18n'

/**
 * Daily budget refusals (rail-loop-budget-guard). The server returns the same
 * 409 body from every launch/resume door and the same `budget` detail on a
 * `budget_paused` loop run; this module turns either into localized copy so
 * no surface shows the server's English `detail`.
 */
export interface DailyBudgetInfo {
  scope: 'project' | 'desktop'
  budgetUsd: number
  spentUsd: number
  resetsAt: string | null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Parse a `{ scope, budgetUsd, spentUsd, resetsAt }` payload; null when malformed. */
export function readDailyBudgetInfo(raw: unknown): DailyBudgetInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const scope = body.scope === 'project' || body.scope === 'desktop' ? body.scope : null
  const budgetUsd = finite(body.budgetUsd)
  const spentUsd = finite(body.spentUsd)
  if (!scope || budgetUsd === null || spentUsd === null) return null
  return { scope, budgetUsd, spentUsd, resetsAt: typeof body.resetsAt === 'string' ? body.resetsAt : null }
}

/** The 409 `daily_budget_exceeded` body of a launch/resume, else null. */
export function readDailyBudgetRejection(body: unknown): DailyBudgetInfo | null {
  if (!body || typeof body !== 'object' || (body as { error?: unknown }).error !== 'daily_budget_exceeded') return null
  return readDailyBudgetInfo(body)
}

function resetTime(info: DailyBudgetInfo): string | null {
  if (!info.resetsAt) return null
  const at = new Date(info.resetsAt)
  return Number.isNaN(at.getTime()) ? null : format(at, 'Pp', { locale: getDateFnsLocale() })
}

function values(info: DailyBudgetInfo) {
  return { spent: info.spentUsd.toFixed(2), budget: info.budgetUsd.toFixed(2) }
}

/** "Daily budget reached ($12.40 of $10.00)" — headline for a refused launch. */
export function dailyBudgetExceededMessage(t: TFunction, info: DailyBudgetInfo): string {
  return t(info.scope === 'project' ? 'common:budget.exceededProject' : 'common:budget.exceededDesktop', values(info))
}

/** What the person can do: raise the budget, or wait for the reset. */
export function dailyBudgetActionMessage(t: TFunction, info: DailyBudgetInfo): string {
  const time = resetTime(info)
  const where = t(info.scope === 'project' ? 'common:budget.whereProject' : 'common:budget.whereDesktop')
  return time ? t('common:budget.actionWithReset', { where, time }) : t('common:budget.action', { where })
}

/** Status line for a run paused between steps on the daily budget. */
export function dailyBudgetPausedMessage(t: TFunction, info: DailyBudgetInfo): string {
  return t(info.scope === 'project' ? 'common:budget.pausedProject' : 'common:budget.pausedDesktop', values(info))
}
