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
  db.prepare('DELETE FROM queue_state WHERE key = ?').run(PREFIX + runId)
}

export function readRetainedBudgetPause(db: DbInstance, runId: string): boolean {
  return !!db.prepare('SELECT 1 AS hit FROM queue_state WHERE key = ?').get(PREFIX + runId)
}
