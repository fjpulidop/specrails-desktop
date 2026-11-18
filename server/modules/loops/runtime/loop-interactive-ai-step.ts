/**
 * The interactive transport of one legacy ai-step: a resident
 * persistent-stdin InteractiveJobSession whose settle maps onto the same
 * AiStepResult the one-shot executor returns. The manager owns the session
 * registry (turn routing, cancel, shutdown); this module owns the step's
 * session lifecycle (step timeout, idle stall flag, settle → result).
 */
import { createStreamAuditTap, type AgentAuditRecorder } from '../../audit'
import { markJobInteractive, accumulateInteractiveTurn, type DbInstance } from '../../../db'
import { InteractiveJobSession } from '../../execution/runtime/interactive-job-session'
import type { WsMessage } from '../../../types'
import { updateLoopStepEventCheckpoint, updateLoopStepActivityCheckpoint } from './loop-runs-store'
import { AI_STEP_STALLED_ERROR } from './loop-step-idle'
import { AI_STEP_TIMEOUT_ERROR } from './loop-ai-step-signals'
import type { AiStepResult, InteractiveAiStepPlan } from './loop-run-contract'

export interface InteractiveAiStepDeps {
  db: DbInstance
  /** Raw project broadcast, handed to the session as-is. */
  broadcast: (msg: WsMessage) => void
  /** The manager's advisory emit (never throws). */
  emit: (msg: WsMessage) => void
  now: () => number
  agentAudit?: Pick<AgentAuditRecorder, 'record'> | null
  /** The manager's resident session registry, keyed by run (= job) id. */
  sessions: Map<string, InteractiveJobSession>
}

export interface InteractiveAiStepInput {
  runId: string
  projectId: string
  plan: InteractiveAiStepPlan
  prompt: string
  fallbackModel: string
  nextEventSeq: () => number
  recoveryStepKey: string
}

/**
 * Run ONE ai-step as a resident interactive session (settleMode 'auto'):
 * first stdin frame = the step's rendered prompt (slash or prose — both
 * expand, spike-verified), user turns mid-step queue+extend, and the moment
 * the session goes QUIESCENT (turn result, nothing pending) it settles itself
 * and the loop advances exactly as after a one-shot. The SettleInfo maps onto
 * the same AiStepResult shape the one-shot executor returns, so everything
 * downstream (history, changeId capture, fail-fast, `record()`'s single
 * ai_invocations row per step) is untouched.
 *
 * Ownership/teardown matrix (never leaks the child, never double-settles —
 * the session's _settle is idempotent and every path funnels through it):
 *  • quiescence / explicit finalizeInteractive → settle 'finalized' (step ok)
 *  • step timeout → session.abort() → fold in-flight turn → settle 'crashed'
 *  • run cancel → cancel() calls session.abort() → settle 'crashed' → the
 *    engine's next boundary check settles the run 'stopped'
 *  • manager shutdown / project removal → dispose() (kill, NO settle; the
 *    startup orphan sweeps reconcile the rows — mirrors QueueManager)
 *
 * Accounting: the session accumulates per-turn REAL usage onto the jobs row
 * live (accumulateInteractiveTurn) and folds any killed in-flight turn as a
 * rate-card ESTIMATE; the ENGINE stays the sole ai_invocations authority —
 * one `record()` row per step from the settle-derived totals (no session-side
 * invocation row, so nothing double-records).
 */
export function runInteractiveAiStep(deps: InteractiveAiStepDeps, input: InteractiveAiStepInput): Promise<AiStepResult> {
  return new Promise<AiStepResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let timedOut = false
    // Set by the session's wedge detector BEFORE it aborts: tells a stall
    // (no raw output for the idle budget) apart from any other 'crashed'.
    let stalled = false
    const session = new InteractiveJobSession({
      jobId: input.runId,
      projectId: input.projectId,
      db: deps.db,
      adapter: input.plan.adapter,
      broadcast: deps.broadcast,
      settleMode: 'auto',
      // Inactivity bound (loop-step-idle): the session's zombie timer IS the
      // step's idle watchdog — reset on any raw child output, silence for the
      // whole budget folds the in-flight turn and settles 'crashed' with the
      // `stalled` flag set so the engine retries the step once by resume.
      // Absent (0) ⇒ the step timeout below is the only watchdog.
      zombieTimeoutMs: input.plan.idleTimeoutMs ?? input.plan.inactivityTimeoutMs ?? 0,
      onZombieTimeout: () => { stalled = true },
      nextEventSeq: input.nextEventSeq,
      ...(deps.agentAudit ? { onProviderEvent: createStreamAuditTap(deps.agentAudit, { runId: input.runId, jobId: input.runId, role: 'loop' }) } : {}),
      persistTurnUsage: (usage, completedEventSeq, checkpoint) => {
        const checkpointTurn = deps.db.transaction(() => {
          accumulateInteractiveTurn(deps.db, input.runId, usage)
          updateLoopStepEventCheckpoint(
            deps.db,
            input.runId,
            input.recoveryStepKey,
            completedEventSeq,
            checkpoint?.cost,
            checkpoint?.turns,
            checkpoint?.activeDurationMs,
          )
        })
        checkpointTurn()
      },
      persistTurnActivity: (turnStartedAtMs, activityAtMs) => {
        updateLoopStepActivityCheckpoint(
          deps.db,
          input.runId,
          input.recoveryStepKey,
          turnStartedAtMs,
          activityAtMs,
        )
      },
      spawn: input.plan.spawn,
      killTree: input.plan.killTree,
      onSettle: (info) => {
        if (timer) { clearTimeout(timer); timer = null }
        deps.sessions.delete(input.runId)
        // The step's session is gone — the composer flips to its gentle
        // "waiting for the next step" state instead of erroring on 409.
        deps.emit({
          type: 'job.interactive',
          projectId: input.projectId,
          jobId: input.runId,
          acceptingTurns: false,
          settleMode: 'auto',
          timestamp: new Date(deps.now()).toISOString(),
        })
        // Zero-work strictness: a session that settled cleanly but consumed
        // NO model work across its whole life (the synthetic `Unknown
        // command:` frame) is a FAILED step — the command never ran. Judged
        // by the session itself over the accumulated totals (whole-session,
        // so a multi-turn step ending on one synthetic frame is unaffected).
        const failed = info.reason === 'crashed' || info.zeroWork || info.resultIsError
        resolve({
          // The last turn's `result` payload — the same terminal text the
          // one-shot path captures (feeds history/changeId/fail-fast).
          text: info.resultText ?? '',
          sessionId: info.sessionId ?? undefined,
          cost: info.totals.total_cost_usd,
          // Derived scalar = input+output ONLY (legacy semantics — see the
          // one-shot executor's note); cache volume rides the structured fields.
          tokens: info.totals.tokens_in + info.totals.tokens_out,
          tokensIn: info.totals.tokens_in,
          tokensOut: info.totals.tokens_out,
          tokensCacheRead: info.totals.tokens_cache_read,
          tokensCacheCreate: info.totals.tokens_cache_create,
          // Sum of active turn wall-segments (write→result), excluding idle
          // gaps between turns — matches the queue's interactive semantics.
          durationMs: info.activeDurationMs,
          numTurns: info.totals.num_turns,
          provider: input.plan.adapter.id,
          model: info.model ?? input.fallbackModel,
          estimated: info.estimated,
          failed,
          zeroWork: info.zeroWork,
          errorText: failed
            ? (info.reason === 'crashed'
                ? (stalled ? AI_STEP_STALLED_ERROR : timedOut ? AI_STEP_TIMEOUT_ERROR : info.resultIsError && info.resultText ? info.resultText : 'interactive step session crashed')
                : info.zeroWork
                  ? `zero work performed — the command never ran${info.resultText ? `: ${info.resultText}` : ''}`
                  : `provider returned an error result${info.resultText ? ` — ${info.resultText}` : ''}`)
            : undefined,
          ...(stalled && info.reason === 'crashed' ? { stalled: true } : {}),
          ...(info.resultIsError ? { resultIsError: true } : {}),
        })
      },
    })
    deps.sessions.set(input.runId, session)
    // The run's backing job row was created without the flag (before this
    // step's capability gate); stamp it now so GET /jobs/:id advertises the
    // in-job chat affordance. Idempotent across steps.
    try { markJobInteractive(deps.db, input.runId) } catch { /* best-effort */ }
    // A resident step session is live — an open Job Detail composer re-enables
    // without polling (mirror flip of the onSettle broadcast above).
    deps.emit({
      type: 'job.interactive',
      projectId: input.projectId,
      jobId: input.runId,
      acceptingTurns: true,
      settleMode: 'auto',
      timestamp: new Date(deps.now()).toISOString(),
    })
    if (input.plan.stepTimeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        session.abort(
          `AI step timed out after ${Math.round(input.plan.stepTimeoutMs / 1000)}s — tearing down the interactive session`,
        )
      }, input.plan.stepTimeoutMs)
      timer.unref?.()
    }
    session.start(input.plan.spec, input.prompt)
  })
}
