/**
 * In-run accounting for one loop run: stage an AI/decider step's crash-recovery
 * checkpoint (`loop_step_recovery`) before its provider spawns, then record the
 * settled result — the run's live totals, honest cost-uncertainty warnings and
 * the step's ai_invocations row, written in the checkpoint's own transaction.
 */
import { newId } from '../../../ids'
import { recordInvocation } from '../../accounting/runtime/ai-invocations'
import {
  completeLoopStepRecovery,
  readLoopJobUsage,
  setLoopStepSettledResult,
  stageLoopStepRecovery,
  updateLoopRunCounters,
  type LoopStepRecoveryPayload,
} from './loop-runs-store'
import { insertLoopInvocation } from './loop-step-accounting'
import { runCounters, type LoopRunContext } from './loop-run-context'
import type { LoopRecordedResult } from './loop-run-contract'

export function recordStepResult(
  ctx: LoopRunContext,
  refSuffix: string,
  r: LoopRecordedResult,
  // The REAL turn-start instant, captured before the step/decider await. The
  // row is bucketed/ordered by started_at, so it must be the start, not finish.
  startedAt: string,
  stepKey?: string,
): void {
  const { host, req, runId, state } = ctx
  const { db } = host
  const { logLine } = ctx.events
  const { maxCostUsd } = ctx.limits
  if (r.provider === 'agent-runtime') state.usageTelemetryAvailable = true
  if (state.usageTelemetryAvailable) state.totalCost += r.cost ?? 0
  // Missing pricing does not identify the failure cause or prove zero spend:
  // providers can omit billing after a successful call or reject a request
  // before model work starts. Retain known costs and flag the incomplete sum.
  const costBearingButUnpriced =
    state.usageTelemetryAvailable
    && r.cost == null
    && (r.failed === true || (r.tokens ?? 0) > 0)
  if (costBearingButUnpriced) {
    state.costUncertain = true
    state.costUnknownWarned = true // this line already carries the cap caveat below
    logLine(
      `⚠️ Step cost unknown — this step did not report a priced cost. The reported loop total includes known costs only.${maxCostUsd !== undefined ? ' The cost cap may under-count.' : ''}`,
      'stderr',
    )
  }
  // Honest cost-cap caveat: a cost-bearing step that reports no figure means
  // the cap can't be enforced precisely from here on. Warn once (live).
  if (
    state.usageTelemetryAvailable
    && maxCostUsd !== undefined
    && r.cost == null
    && !state.costUnknownWarned
  ) {
    state.costUnknownWarned = true
    logLine('⚠️ A step reported no priced cost (non-Claude estimate / unknown model / failed step) — the cost cap may under-count.', 'stderr')
  }
  if (state.usageTelemetryAvailable) {
    state.totalTokens += r.tokens ?? ((r.tokensIn ?? 0) + (r.tokensOut ?? 0))
  }
  state.totalDuration += r.durationMs ?? 0
  const finishedAt = new Date(host.now()).toISOString()
  if (stepKey) {
    setLoopStepSettledResult(db, runId, stepKey, r)
    const completed = completeLoopStepRecovery(db, runId, stepKey, (payload) => {
      insertLoopInvocation(db, payload, r, finishedAt)
      updateLoopRunCounters(db, runId, runCounters(state))
    })
    if (!completed) throw new Error(`Missing loop step checkpoint ${runId}/${stepKey}`)
  } else {
    // Compatibility for synthetic/test call paths that predate staged steps.
    recordInvocation(db, {
      id: newId(), project_id: req.projectId,
      provider: r.provider ?? req.provider, surface: 'loop',
      surface_ref_id: refSuffix, ticket_id: req.ticketId ?? null,
      status: r.failed ? 'failed' : 'success', started_at: startedAt,
      finished_at: finishedAt, total_cost_usd: r.cost,
      total_cost_usd_estimated: r.estimated ?? false,
      tokens_in: r.tokensIn,
      tokens_out: r.tokensOut ?? (
        r.tokensIn === undefined && r.tokensOut === undefined ? r.tokens : undefined
      ),
      tokens_cache_read: r.tokensCacheRead,
      tokens_cache_create: r.tokensCacheCreate,
      num_turns: r.numTurns, session_id: r.sessionId,
      duration_ms: r.durationMs, duration_api_ms: r.durationApiMs,
      model: r.model ?? req.model, loop_run_id: runId,
    })
  }
  // BUG-07: the loop path is the only recordInvocation callsite that never
  // invalidated open spending dashboards — they'd freeze for the whole (often
  // multi-hour) run. Broadcast after each row, wrapped so a broadcast failure
  // can't break traversal (mirrors the file-summary callsite).
  try {
    host.emit({ type: 'spending.invalidated', projectId: req.projectId })
  } catch { /* best-effort — never break traversal on a broadcast failure */ }
}

/** Stage the step's durable recovery checkpoint before its provider spawns;
 *  returns the step key `recordStepResult` later completes. */
export function stageAiAccounting(
  ctx: LoopRunContext,
  kind: 'ai' | 'decider',
  nodeId: string,
  surfaceRefId: string,
  startedAt: string,
): string {
  const { host, req, runId, state } = ctx
  const stepKey = `${kind}:${state.stepNum}:${nodeId}`
  const startedAtMs = Date.parse(startedAt)
  const payload: LoopStepRecoveryPayload = {
    version: 1,
    runId,
    stepKey,
    invocationId: newId(),
    projectId: req.projectId,
    provider: req.provider,
    model: req.model ?? null,
    surfaceRefId,
    ticketIds: ctx.exactTicketIds,
    startedAt,
    baseline: readLoopJobUsage(host.db, runId),
    completedEventSeq: state.seq - 1,
    providerCostBaseline: 0,
    providerTurnsBaseline: 0,
    loopDurationBaseline: (host.db.prepare(`SELECT total_duration_ms FROM loop_runs WHERE id = ?`)
      .get(runId) as { total_duration_ms: number } | undefined)?.total_duration_ms ?? state.totalDuration,
    completedDurationMs: 0,
    iterationCount: state.iteration,
    ...(Number.isFinite(startedAtMs)
      ? { activeTurnStartedAtMs: startedAtMs, lastActivityAtMs: startedAtMs }
      : {}),
  }
  stageLoopStepRecovery(host.db, payload)
  host.setActiveStepRecovery(runId, stepKey)
  return stepKey
}
