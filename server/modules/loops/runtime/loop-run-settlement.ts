/**
 * Terminal settlement of one loop run: closes a dangling step, reconciles any
 * staged step accounting before aggregate totals are written, folds Core's
 * completion snapshot into the outcome, emits `loop_completion`, and settles
 * the loop run and its backing job in one store call (`finishLoopRunAndJob`)
 * before broadcasting `job.finalized` / `loop.run_completed`.
 */
import type { CoreCompletionSnapshot } from '../../../core-completion'
import type { JobStatus } from '../../../types'
import { deriveFailureDiagnosis, isDiagnosableOutcome, serializeDiagnosis } from '../../recovery'
import { readDefinitionUsage } from './loop-definition-events'
import { finishLoopRunAndJob, getLoopRun, type LoopRunOutcome } from './loop-runs-store'
import { programmaticUsageAvailability, recoverOrphanLoopStepAccounting } from './loop-step-accounting'
import type { LoopRunContext } from './loop-run-context'
import type { LoopRunResult } from './loop-run-contract'

type RuntimeUsageAvailability = { present: boolean; costUnknown: boolean; tokensInUnknown: boolean; tokensOutUnknown: boolean }

/** Land any staged step accounting and refresh the run's totals from the
 *  durable ledger; returns which usage the runtime itself reported. */
function reconcileStagedAccounting(ctx: LoopRunContext): RuntimeUsageAvailability {
  const { host, runId, state, definitionEngine } = ctx
  const { db } = host
  let runtimeUsage: RuntimeUsageAvailability = { present: false, costUnknown: false, tokensInUnknown: false, tokensOutUnknown: false }
  // A traversal exception can bypass record(). Reconcile the staged step
  // BEFORE writing aggregate job totals, while its jobs baseline is still
  // valid. If reconciliation itself fails, finishLoopRunAndJob detects the
  // surviving checkpoint and preserves those baseline columns for startup.
  try {
    const recoveredSteps = recoverOrphanLoopStepAccounting(
      db,
      new Date(host.now()).toISOString(),
      runId,
    )
    host.clearActiveStepRecovery(runId)
    runtimeUsage = definitionEngine ? readDefinitionUsage(db, runId) : programmaticUsageAvailability(db, runId)
    state.usageTelemetryAvailable ||= runtimeUsage.present
    const aggregate = db.prepare(`
      SELECT COALESCE(SUM(total_cost_usd), 0) AS cost,
             COALESCE(SUM(tokens_in), 0) AS tokens_in,
             COALESCE(SUM(tokens_out), 0) AS tokens_out,
             COALESCE(SUM(tokens_cache_read), 0) AS cache_read,
             COALESCE(SUM(tokens_cache_create), 0) AS cache_create,
             COALESCE(SUM(duration_ms), 0) AS duration,
             COALESCE(SUM(num_turns), 0) AS turns
        FROM ai_invocations
       WHERE surface = 'loop' AND loop_run_id = ?
    `).get(runId) as {
      cost: number; tokens_in: number; tokens_out: number
      cache_read: number; cache_create: number; duration: number; turns: number
    }
    if (state.usageTelemetryAvailable) {
      state.totalCost = aggregate.cost
      state.totalTokens = aggregate.tokens_in + aggregate.tokens_out
    }
    if (recoveredSteps > 0) {
      // Recovery already committed the authoritative D+X totals. Refresh the
      // traversal locals before finishLoopRunAndJob; otherwise a catch path
      // that never called record() writes its stale D baseline back over the
      // recovered row (duration was the visible casualty, but keep all
      // counters/iteration coherent).
      const durable = getLoopRun(db, runId)
      if (durable) {
        state.totalCost = durable.total_cost_usd
        state.totalTokens = durable.total_tokens
        state.totalDuration = durable.total_duration_ms
        state.iteration = Math.max(state.iteration, durable.iteration_count)
      }
    }
    if (state.usageTelemetryAvailable) {
      state.finalJobUsage = {
        tokensIn: runtimeUsage.tokensInUnknown ? null : aggregate.tokens_in,
        tokensOut: runtimeUsage.tokensOutUnknown ? null : aggregate.tokens_out,
        tokensCacheRead: runtimeUsage.present ? null : aggregate.cache_read,
        tokensCacheCreate: runtimeUsage.present ? null : aggregate.cache_create,
        numTurns: runtimeUsage.present ? null : aggregate.turns,
      }
    }
  } catch (err) {
    console.error(`[loop] staged accounting reconciliation failed for ${runId}:`, err)
  }

  return runtimeUsage
}

/** Execution and acceptance are separate facts: the runtime's own terminal
 *  snapshot (legacy) or Core's recorded usage (definitions). */
async function readTerminalSnapshot(ctx: LoopRunContext): Promise<CoreCompletionSnapshot | null> {
  const { host, runId, state, definitionEngine } = ctx
  const { db } = host
  // Persist the runtime's own terminal snapshot alongside counters so
  // history does not depend on prose.
  let coreCompletion: CoreCompletionSnapshot | null = null
  try { if (!definitionEngine) coreCompletion = await host.executors.readCoreCompletion?.(runId) ?? null } catch { /* old/unavailable runtime */ }
  if (definitionEngine) {
    const usage = readDefinitionUsage(db, runId)
    state.usageTelemetryAvailable = usage.present
    state.finalJobUsage = { tokensIn: usage.present && !usage.tokensInUnknown ? usage.tokensIn : null, tokensOut: usage.present && !usage.tokensOutUnknown ? usage.tokensOut : null, tokensCacheRead: usage.present && !usage.cacheReadUnknown ? usage.cacheRead : null, tokensCacheCreate: usage.present && !usage.cacheCreateUnknown ? usage.cacheCreate : null, numTurns: usage.present && !usage.turnsUnknown ? usage.turns : null }
  }
  return coreCompletion
}

/** A successful execution is accepted only when Core's own completion
 *  (definitions) or the runtime snapshot (legacy) confirms it. */
function acceptedOutcome(ctx: LoopRunContext, coreCompletion: CoreCompletionSnapshot | null): LoopRunOutcome {
  let outcome = ctx.state.outcome
  if (ctx.definitionEngine && outcome === 'success' && !ctx.state.definitionCompletion?.ok) outcome = 'blocked'
  if (outcome === 'success' && coreCompletion && (coreCompletion.completion.implementation !== 'complete' || !['verified', 'with-exceptions'].includes(coreCompletion.completion.validation))) outcome = 'blocked'
  return outcome
}

function failureDiagnosisOf(ctx: LoopRunContext, outcome: LoopRunOutcome, coreCompletion: CoreCompletionSnapshot | null): string | null {
  const { state } = ctx
  const definitionCompletion = state.definitionCompletion
  return isDiagnosableOutcome(outcome)
    ? serializeDiagnosis(deriveFailureDiagnosis({ outcome, stallReason: state.stallReason ?? null, providerLimit: state.providerLimitHit ?? null, errorText: state.failureText ?? null, stepId: state.failedStepId ?? null, core: state.coreFailure, hostBlocker: definitionCompletion?.blocker ?? null, portConflict: state.portConflict ?? null,
      blockedReason: definitionCompletion && !definitionCompletion.ok ? definitionCompletion.reasons.join('; ') : coreCompletion && outcome === 'blocked' ? `validation ${coreCompletion.completion.validation}, implementation ${coreCompletion.completion.implementation}` : null }))
    : null
}

export async function settleLoopRun(ctx: LoopRunContext): Promise<LoopRunResult> {
  const { host, req, runId, state, definitionEngine, exactTicketIds } = ctx
  const { db } = host
  const { emitStepEnd, emitRunEvent, logLine } = ctx.events
  // Backstop: a traversal exception (or any future path that breaks out
  // mid-step) must not leave the last step dangling — close it as failed.
  // The ONLY way a persisted stream ends with an open step is a mid-flight
  // dispose (shutdown/project removal), where this code never runs.
  emitStepEnd({ status: 'failed' })

  const runtimeUsage = reconcileStagedAccounting(ctx)
  const coreCompletion = await readTerminalSnapshot(ctx)
  const executionOutcome = state.outcome
  const outcome = acceptedOutcome(ctx, coreCompletion)
  state.outcome = outcome
  const definitionCompletion = state.definitionCompletion
  const { totalCost, totalTokens, totalDuration, iteration, finalJobUsage, costUncertain, stallReason, providerLimitHit } = state
  const costAvailable = state.usageTelemetryAvailable && !runtimeUsage.costUnknown
  console.log(
    `[loop] settle run=${runId} outcome=${outcome} iterations=${iteration} ` +
      (costAvailable ? `cost=$${totalCost.toFixed(4)}` : 'cost=unavailable'),
  )
  emitRunEvent('loop_completion', {
    version: 1, execution: executionOutcome, steps: state.stepNum, deciderEvaluations: iteration,
    turns: finalJobUsage.numTurns, costUsd: state.usageTelemetryAvailable ? totalCost : null,
    costUncertain, core: coreCompletion, ...(definitionEngine ? { engineVersion: 2, completion: definitionCompletion } : {}),
  })

  // Settle the backing job so the Jobs list + JobDetail reflect the final
  // status, and emit job.finalized so an open JobDetail re-fetches + stops the
  // live stream (mirrors QueueManager).
  // `stopped`/`stalled` are controlled halts (not done, not a hard crash) →
  // surface as `canceled`, so tickets revert to todo rather than being marked
  // done/on_review AND the run is never counted as success.
  const jobStatus: JobStatus =
    outcome === 'success' ? 'completed'
      : outcome === 'stopped' || outcome === 'stalled' ? 'canceled'
        : 'failed'
  // `≥` when any cost-bearing step ended unpriced (timeout/crash) — the figure
  // is a lower bound, not exact. Providers without usage telemetry get an
  // explicit unavailable marker, never a fabricated "$0.0000".
  logLine(
    `\n■ Loop execution finished: ${outcome} — ` +
      (costAvailable
        ? `${costUncertain ? '≥ ' : ''}$${totalCost.toFixed(4)}`
        : 'usage/cost unavailable'),
  )
  if (coreCompletion) logLine(`Core result: implementation=${coreCompletion.completion.implementation}; validation=${coreCompletion.completion.validation}; archive=${coreCompletion.completion.archive}; delivery=${coreCompletion.completion.delivery}`)
  const finishedAt = new Date(host.now()).toISOString()
  host.untrackRunCap(runId)
  finishLoopRunAndJob(db, runId, {
    outcome,
    finishedAt,
    counters: {
      iterationCount: iteration,
      // loop_runs retains its legacy non-null internal counters; public/job
      // telemetry below carries the honest nullable availability contract.
      totalCostUsd: totalCost,
      totalTokens,
      totalDurationMs: totalDuration,
    },
    job: {
      exitCode: outcome === 'success' ? 0 : 1,
      status: jobStatus,
      totalCostUsd: costAvailable ? totalCost : null,
      tokensIn: finalJobUsage.tokensIn,
      tokensOut: finalJobUsage.tokensOut,
      tokensCacheRead: finalJobUsage.tokensCacheRead,
      tokensCacheCreate: finalJobUsage.tokensCacheCreate,
      durationMs: totalDuration,
      numTurns: finalJobUsage.numTurns,
    },
    callbackOutcome: req.deferTerminalOutcome ? 'failed' : outcome,
    outcomeFinalized: !req.deferTerminalOutcome,
    failureDiagnosis: failureDiagnosisOf(ctx, outcome, coreCompletion),
  })
  host.emit({
    type: 'job.finalized',
    projectId: req.projectId,
    jobId: runId,
    status: jobStatus,
    totals: {
      tokens_in: finalJobUsage.tokensIn,
      tokens_out: finalJobUsage.tokensOut,
      tokens_cache_read: finalJobUsage.tokensCacheRead,
      tokens_cache_create: finalJobUsage.tokensCacheCreate,
      total_cost_usd: costAvailable ? totalCost : null,
      num_turns: finalJobUsage.numTurns,
    },
    timestamp: new Date(host.now()).toISOString(),
  })
  host.emit({
    type: 'loop.run_completed',
    projectId: req.projectId,
    loopRunId: runId,
    railIndex: req.railIndex ?? null,
    status: outcome,
    ticketIds: exactTicketIds,
  })

  return {
    runId,
    outcome,
    iterations: iteration,
    totalCostUsd: costAvailable ? totalCost : null,
    ...(outcome === 'stalled' && stallReason ? { stallReason } : {}),
    ...(providerLimitHit ? { providerLimit: providerLimitHit } : {}),
  }
}
