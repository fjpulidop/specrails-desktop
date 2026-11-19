/**
 * Automatic continuation: when a definition run fails for a known cause that
 * more work in the same run can fix (unfinished tasks, a missing tool, a
 * transient provider error, a stall), Specrails continues it once by itself,
 * exactly like the person's Continue, and says so in the run's history.
 *
 * Bounded: one automatic continuation per run chain, never for a cause a person
 * must resolve (credentials, policy, spend caps, usage limits), never for a stop
 * the person chose, never when the attempt failed exactly like the one before,
 * and never with the setting off. The rules are `autoContinueVerdict` (recovery).
 */
import type { DbInstance } from './db'
import { appendEvent } from './db'
import { getAutoContinueRuns } from './desktop-db'
import { getLoopRun, readDefinitionSuccessor } from './modules/loops/runtime/loop-runs-store'
import { chainHasAutomaticContinuation, readRunAttempts } from './modules/loops/runtime/run-attempts'
import { autoContinueVerdict, parseStoredDiagnosis, type AutoContinueReason } from './modules/recovery'
import type { ProjectContext } from './project-registry'
import type { WsMessage } from './types'

/** Errors that mean "not yet": the run's own settlement or lease is still finishing. */
const NOT_YET = /runtime_settlement_pending|runtime_run_active|Delivery is busy|lease_held/

export const AUTO_CONTINUE_REASON_TEXT: Record<AutoContinueReason, string> = {
  unfinished_tasks: 'approved tasks were left unfinished, so the next attempt finishes them with the browser and install guidance',
  missing_tool: 'a tool was missing, so the next attempt installs it and goes on',
  transient_error: 'the provider failed for a moment, so the same step runs again',
  provider_unavailable: 'the provider\'s service was unavailable, so the same step ran again once the wait was over',
  stalled: 'the attempt stalled, so the next attempt restarts the developer with fresh budgets and guidance',
}

export interface AutoContinueDeps {
  context: () => ProjectContext | null
  desktopDb: DbInstance
  continueRun: (c: ProjectContext, runId: string, remedy: 'continue', options: { automatic: true }) => Promise<{ status: number; body: object }>
  wait?: (ms: number) => Promise<void>
  /** First wait (settlement usually finishes within it) and the retry step while it does not. */
  delays?: { firstMs: number; retryMs: number; attempts: number }
}

function historyLine(db: DbInstance, runId: string, line: string): void {
  try {
    db.transaction(() => {
      const sequence = (db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM events WHERE job_id=?').get(runId) as { seq: number }).seq
      appendEvent(db, runId, sequence, { event_type: 'log', source: 'stdout', payload: JSON.stringify({ line }) })
    })()
  } catch { /* the continuation record still tells the story */ }
}

export function createAutoContinuation(deps: AutoContinueDeps): { observe(msg: WsMessage): void; settle(runId: string): Promise<'continued' | 'declined' | 'failed'> } {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.() }))
  const delays = deps.delays ?? { firstMs: 3_000, retryMs: 5_000, attempts: 24 }
  const inFlight = new Set<string>()

  async function settle(runId: string): Promise<'continued' | 'declined' | 'failed'> {
    await wait(delays.firstMs)
    // A provider outage waits once per settlement before continuing.
    let outageWaited = false
    for (let attempt = 0; attempt < delays.attempts; attempt++) {
      const c = deps.context()
      if (!c || c.loopRunManager.isDisposed()) return 'declined'
      const run = getLoopRun(c.db, runId)
      if (!run || run.engine_version !== 2 || run.status !== 'completed' || readDefinitionSuccessor(c.db, runId)) return 'declined'
      const diagnosis = parseStoredDiagnosis(run.failure_diagnosis ?? null)
      const previous = run.fork_of ? parseStoredDiagnosis(getLoopRun(c.db, run.fork_of)?.failure_diagnosis ?? null) : null
      const verdict = autoContinueVerdict({
        enabled: getAutoContinueRuns(deps.desktopDb), outcome: run.final_outcome, diagnosis, previous,
        chainAlreadyContinued: chainHasAutomaticContinuation(c.db, runId),
      })
      if (!verdict.continue) {
        if (verdict.reason !== 'disabled' && verdict.reason !== 'not_failed') console.log(`[auto-continue] ${runId}: not continued (${verdict.reason})`)
        return 'declined'
      }
      // A provider outage: say when the run goes on, wait, then decide again (the person may have acted).
      if (verdict.delayMs && !outageWaited) {
        outageWaited = true
        historyLine(c.db, runId, `The provider's service was unavailable. Specrails continues this run automatically in ${Math.round(verdict.delayMs / 60_000)} min; Continue does it now.`)
        await wait(verdict.delayMs)
        attempt--
        continue
      }
      const outcome = await deps.continueRun(c, runId, 'continue', { automatic: true })
      const body = outcome.body as { loopRunId?: string; error?: string; detail?: string }
      if (outcome.status < 300) {
        const next = body.loopRunId ?? runId
        const position = readRunAttempts(c.db, [next]).get(next)
        historyLine(c.db, runId, `Specrails continued automatically: ${AUTO_CONTINUE_REASON_TEXT[verdict.reason]}${position ? ` (attempt ${position.attempt})` : ''}.`)
        console.log(`[auto-continue] ${runId} continued as ${next} (${verdict.reason})`)
        return 'continued'
      }
      if (!NOT_YET.test(`${body.error ?? ''} ${body.detail ?? ''}`)) {
        console.warn(`[auto-continue] ${runId} could not continue: ${body.error ?? outcome.status} ${body.detail ?? ''}`)
        return 'failed'
      }
      await wait(delays.retryMs)
    }
    return 'failed'
  }

  return {
    settle,
    observe(msg: WsMessage) {
      if (msg.type !== 'loop.run_completed') return
      const status = (msg as { status?: string }).status
      const runId = (msg as { loopRunId?: string }).loopRunId
      if (!runId || (status !== 'failed' && status !== 'blocked' && status !== 'stalled') || inFlight.has(runId)) return
      inFlight.add(runId)
      void settle(runId).catch((error) => console.error('[auto-continue] failed:', runId, error)).finally(() => inFlight.delete(runId))
    },
  }
}
