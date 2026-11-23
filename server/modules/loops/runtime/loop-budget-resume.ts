/**
 * Resuming a run a restart retained while it was parked at its budget: the per-run cap is
 * answered exactly as for a resident run (see `LoopRunManager.resumeBudgetPause`).
 */
import type { DbInstance } from '../../../db'
import { isRunCapReached, runCapAheadUsd, runCapRejection, type DailyBudgetRejection } from '../../execution'
import { readRunTurnCosts } from './loop-run-launch'
import { getLoopRun, readLoopRunCap, writeLoopRunCap } from './loop-runs-store'
import type { RunCapChoice } from './loop-run-contract'

/** The person's answer to a per-run cap, as the resume body carries it. */
export function runCapChoiceOf(body: unknown): RunCapChoice | undefined {
  const b = (body && typeof body === 'object' ? body : {}) as { runCap?: unknown; runCapUsd?: unknown }
  if (b.runCap === 'ignore') return { ignore: true }
  if (b.runCap === 'once') return { once: true }
  return typeof b.runCapUsd === 'number' && Number.isFinite(b.runCapUsd) && b.runCapUsd > 0 ? { raiseTo: b.runCapUsd } : undefined
}

/**
 * The per-run cap gate for resuming a retained budget-paused run, with the same answers
 * as a resident one: `{ runCap: 'ignore' }` waives the cap, `{ runCapUsd: n }` moves it.
 * Returns the 409 body while the cap still stands, else null. The daily budget is the
 * retained resume's own gate.
 */
export function retainedRunCapRejection(db: DbInstance, runId: string, body: unknown): DailyBudgetRejection | null {
  const choice = runCapChoiceOf(body)
  // "Run this step once": Core resumes into the next step; the cap is checked again while it runs.
  if (choice && 'once' in choice) return null
  if (choice) writeLoopRunCap(db, runId, 'ignore' in choice ? 0 : choice.raiseTo)
  const cap = readLoopRunCap(db, runId)
  if (!cap || cap <= 0) return null
  const spent = Number(getLoopRun(db, runId)?.total_cost_usd ?? 0)
  const turns = readRunTurnCosts(db, runId)
  return isRunCapReached(cap, spent, runCapAheadUsd(turns)) ? runCapRejection(cap, spent, turns) : null
}
