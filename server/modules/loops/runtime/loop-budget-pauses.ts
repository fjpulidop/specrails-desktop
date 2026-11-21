/**
 * Durable record of a `budget_paused` run (the daily budget or its per-run soft cap) that a
 * Desktop restart retained. A restart marks every retained run `restart`, which made a run
 * parked at its cap look like any restart-paused run: one generic Resume (the inbox, the
 * restart dialog, a harness) continued it past its cap. One `queue_state` row per run
 * (`budget_pause:<runId>`), written by the restart and removed when the person resumes it
 * through the budget gate.
 */
import type { DbInstance } from '../../../db'

const PREFIX = 'budget_pause:'

export function saveRetainedBudgetPause(db: DbInstance, runId: string): void {
  db.prepare('INSERT OR REPLACE INTO queue_state (key, value) VALUES (?, ?)').run(PREFIX + runId, JSON.stringify({ at: new Date().toISOString() }))
}

export function clearRetainedBudgetPause(db: DbInstance, runId: string): void {
  db.prepare('DELETE FROM queue_state WHERE key IN (?, ?)').run(PREFIX + runId, HOLD_PREFIX + runId)
}

export function readRetainedBudgetPause(db: DbInstance, runId: string): boolean {
  return !!db.prepare('SELECT 1 AS hit FROM queue_state WHERE key = ?').get(PREFIX + runId)
}

/**
 * Which cap a budget-paused run is held on (`budget_hold:<runId>`), written when it
 * parks and kept over a restart: a run held on the DAILY budget (no `period`) may
 * resume by itself when the day resets (`loop-budget-reset-resume.ts`), one held on
 * a weekly/monthly cap or on its own per-run cap never does. Removed when the run
 * moves on (resume, stop) and with the retained record.
 */
const HOLD_PREFIX = 'budget_hold:'

export interface BudgetHoldDetail {
  scope: 'project' | 'desktop'
  /** Absent = the daily budget. */
  period?: 'week' | 'month' | 'run'
  /** When the cap's window rolls over (ISO); null for the per-run cap. */
  resetsAt: string | null
}

export function saveBudgetHold(db: DbInstance, runId: string, detail: BudgetHoldDetail): void {
  const value: BudgetHoldDetail = { scope: detail.scope, ...(detail.period ? { period: detail.period } : {}), resetsAt: detail.resetsAt }
  db.prepare('INSERT OR REPLACE INTO queue_state (key, value) VALUES (?, ?)').run(HOLD_PREFIX + runId, JSON.stringify(value))
}

export function clearBudgetHold(db: DbInstance, runId: string): void {
  db.prepare('DELETE FROM queue_state WHERE key = ?').run(HOLD_PREFIX + runId)
}

export function readBudgetHold(db: DbInstance, runId: string): BudgetHoldDetail | null {
  const row = db.prepare('SELECT value FROM queue_state WHERE key = ?').get(HOLD_PREFIX + runId) as { value: string } | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as Partial<BudgetHoldDetail>
    if (parsed.scope !== 'project' && parsed.scope !== 'desktop') return null
    const period = parsed.period === 'week' || parsed.period === 'month' || parsed.period === 'run' ? parsed.period : undefined
    return { scope: parsed.scope, ...(period ? { period } : {}), resetsAt: typeof parsed.resetsAt === 'string' ? parsed.resetsAt : null }
  } catch { return null }
}

/** Every run that is held on the daily budget, with its reset (the restart's durable list). */
export function listDailyBudgetHolds(db: DbInstance): Array<{ runId: string; detail: BudgetHoldDetail & { resetsAt: string } }> {
  const rows = db.prepare("SELECT key, value FROM queue_state WHERE key LIKE 'budget_hold:%'").all() as Array<{ key: string; value: string }>
  const out: Array<{ runId: string; detail: BudgetHoldDetail & { resetsAt: string } }> = []
  for (const row of rows) {
    const runId = row.key.slice(HOLD_PREFIX.length)
    const detail = readBudgetHold(db, runId)
    if (detail && !detail.period && detail.resetsAt) out.push({ runId, detail: { ...detail, resetsAt: detail.resetsAt } })
  }
  return out
}

/** A run held on the daily budget: the only hold the day's reset may lift by itself. */
export function isDailyBudgetHold(breach: { period?: string; resetsAt: string | null } | null | undefined): boolean {
  return !!breach && !breach.period && !!breach.resetsAt
}
