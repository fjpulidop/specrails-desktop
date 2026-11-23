/**
 * Runs held on the DAILY budget resume by themselves when the day resets
 * (app setting "Resume runs held by the daily budget when the day resets", on by
 * default). The reset is the budget's own clock: the breach's `resetsAt` (local
 * midnight for a project budget, UTC midnight for the app-wide one, see
 * `dailyBudgetResetsAt`).
 *
 * A resident run schedules its own resume when it parks (`awaitBudget`). A run a
 * restart retained while held is scheduled at startup from its durable hold
 * (`budget_hold:<runId>`) by `planRetainedDailyReset` + the composition
 * (`project-context-recovery.ts`), so a run held over midnight while the app was
 * closed resumes at startup when the new day has budget.
 *
 * Never: a run the person paused, a run its own per-run cap (or a weekly/monthly
 * cap) still holds, or with the setting off. Both paths re-check every cap when
 * they fire and resume through the normal door, so capacity admission applies.
 */
import { appendEvent, type DbInstance } from '../../../db'
import type { WsMessage } from '../../../types'
import { initialEventSeq } from './loop-run-launch'
import type { BudgetHoldDetail } from './loop-budget-pauses'

/** Run event recorded when the day's reset lifted the hold (`{ scope, resetsAt }`). */
export const BUDGET_RESET_RESUME_EVENT = 'run-budget-reset-resume'

export const RETAINED_RESET_RESUME_LINE = '\n▶ The day reset — the daily budget allows the next step again, so the run resumed by itself. It continues once there is capacity.'

/** The cap a resume would answer to right now, as the gates report it. */
export interface CapRejection { period?: 'week' | 'month' | 'run'; resetsAt: string | null; detail: string; scope: 'project' | 'desktop' }

export type RetainedResetPlan =
  | { action: 'resume' }
  /** Nothing to do (setting off, the person paused it, not held on the daily budget any more). */
  | { action: 'skip'; reason: 'disabled' | 'user_paused' | 'not_held' }
  /** Still held: on the daily budget again (fire at its next reset), or on another cap (stays held). */
  | { action: 'hold'; rejection: CapRejection; nextResetAt: string | null }

/**
 * What a fired daily reset does with a run a restart retained on the daily budget.
 * Pure: the caller reads the run, its records, the setting and both gates.
 */
export function planRetainedDailyReset(input: {
  enabled: boolean
  runPaused: boolean
  retainedBudgetHold: boolean
  userPaused: boolean
  hold: BudgetHoldDetail | null
  runCapRejection: CapRejection | null
  budgetRejection: CapRejection | null
}): RetainedResetPlan {
  if (!input.runPaused || !input.retainedBudgetHold || !input.hold || input.hold.period) return { action: 'skip', reason: 'not_held' }
  if (input.userPaused) return { action: 'skip', reason: 'user_paused' }
  if (!input.enabled) return { action: 'skip', reason: 'disabled' }
  const rejection = input.runCapRejection ?? input.budgetRejection
  if (!rejection) return { action: 'resume' }
  return { action: 'hold', rejection, nextResetAt: !rejection.period && rejection.resetsAt ? rejection.resetsAt : null }
}

/**
 * One history line (and optionally the run event) on a retained run, numbered after
 * its last persisted event, before the resumed execution numbers its own.
 */
export function writeRetainedResetHistory(db: DbInstance, emit: (msg: WsMessage) => void, runId: string, line: string, event?: { scope: string; resetsAt: string | null }, now = new Date()): void {
  try {
    const seq = initialEventSeq(db, runId, true)
    const at = now.toISOString()
    const payload = event ? JSON.stringify(event) : null
    db.transaction(() => {
      appendEvent(db, runId, seq, { event_type: 'log', source: 'stdout', payload: JSON.stringify({ line }) })
      if (payload) appendEvent(db, runId, seq + 1, { event_type: BUDGET_RESET_RESUME_EVENT, source: 'stdout', payload })
    })()
    emit({ type: 'log', source: 'stdout', line, timestamp: at, processId: runId } as WsMessage)
    if (payload) emit({ type: 'event', jobId: runId, event_type: BUDGET_RESET_RESUME_EVENT, source: 'stdout', payload, seq: seq + 1, timestamp: at } as WsMessage)
  } catch { /* the line is informative; the resume proceeds */ }
}
