/**
 * Loop step accounting: the ai_invocations rows of a settled AI/decider step
 * (per ticket, per Core phase share) with the backing job's aggregate usage,
 * and startup/teardown recovery of steps staged in `loop_step_recovery` that
 * never landed their invocation. Each insert shares the checkpoint-removal
 * transaction owned by `completeLoopStepRecovery`, so replays never duplicate.
 */
import { accumulateInteractiveTurn, type DbInstance, type InteractiveTurnUsage } from '../../../db'
import { completeLoopStepRecovery, listLoopStepRecoveries, readLoopJobUsage, type LoopStepRecoveryPayload } from './loop-runs-store'
import { recordInvocation } from '../../accounting/runtime/ai-invocations'
import { getAdapter } from '../../../providers'
import { attributeProgrammaticUsage, parseProgrammaticUsage, type ProgrammaticShare } from '../../agent-runtime/runtime/agent-runtime-accounting'
import { distributeIntByWeight } from '../../../util/distribute-int'
import { parseStreamEvents } from '../../../providers/runtime'
import { finaliseInvocationResult } from '../../accounting/runtime/result-event'
import type { LoopRecordedResult } from './loop-run-contract'

/** Core's deterministic completion check (loop-executors): no provider call, no cost. */
export const DETERMINISTIC_VERIFICATION_MODEL = 'deterministic-verification'
function isDeterministicVerification(result: LoopRecordedResult): boolean {
  return result.provider === 'agent-runtime' && result.model === DETERMINISTIC_VERIFICATION_MODEL
}

/** Row id prefix of a Core v1 invocation share attributed to its real engine. */
export const CORE_V1_ROW_PREFIX = 'core-v1:'

/**
 * The per-phase shares of a Core v1 invocation ('agent-runtime' / 'per-role'),
 * read from the step's own Core events (after the staged event cursor). Undefined
 * when the stream names no engine or the shares do not reconcile: the single
 * aggregate row is kept.
 */
function programmaticShares(db: DbInstance, payload: LoopStepRecoveryPayload, result: LoopRecordedResult): ProgrammaticShare[] | undefined {
  if (result.provider !== 'agent-runtime' || result.model !== 'per-role') return undefined
  const rows = db.prepare(`
    SELECT payload FROM events
     WHERE job_id = ? AND seq > ? AND source = 'stdout' AND event_type IN ('workflow-event', 'runtime-efficiency-event')
     ORDER BY seq
  `).all(payload.runId, payload.completedEventSeq ?? -1) as Array<{ payload: string }>
  const tokensOut = result.tokensOut ?? (result.tokensIn === undefined && result.tokensOut === undefined ? result.tokens : undefined)
  return attributeProgrammaticUsage(rows.map((row) => row.payload), { cost: result.cost, tokensIn: result.tokensIn, tokensOut })
}

export function programmaticUsageAvailability(db: DbInstance, runId: string): { present: boolean; costUnknown: boolean; tokensInUnknown: boolean; tokensOutUnknown: boolean } {
  const row = db.prepare(`SELECT COUNT(*) AS count,
    MAX(total_cost_usd IS NULL) AS cost_unknown,
    MAX(tokens_in IS NULL) AS input_unknown, MAX(tokens_out IS NULL) AS output_unknown
    FROM ai_invocations WHERE surface = 'loop' AND loop_run_id = ? AND (provider = 'agent-runtime' OR id LIKE '${CORE_V1_ROW_PREFIX}%')`).get(runId) as { count: number; cost_unknown: number | null; input_unknown: number | null; output_unknown: number | null }
  return { present: row.count > 0, costUnknown: Boolean(row.cost_unknown), tokensInUnknown: Boolean(row.input_unknown), tokensOutUnknown: Boolean(row.output_unknown) }
}

export function insertLoopInvocation(
  db: DbInstance,
  payload: LoopStepRecoveryPayload,
  result: LoopRecordedResult,
  finishedAt: string,
): void {
  const ticketIds = Array.isArray(payload.ticketIds)
    ? [...new Set(payload.ticketIds)]
    : (payload.ticketId == null ? [] : [payload.ticketId])
  const targets: Array<number | null> = ticketIds.length > 0 ? ticketIds : [null]
  const splitInt = (value: number | undefined): Array<number | undefined> => {
    if (value === undefined) return targets.map(() => undefined)
    const base = Math.floor(value / targets.length)
    const remainder = value - base * targets.length
    return targets.map((_target, index) => base + (index < remainder ? 1 : 0))
  }
  const tokensIn = splitInt(result.tokensIn)
  const tokensOut = splitInt(
    result.tokensOut ?? (
      result.tokensIn === undefined && result.tokensOut === undefined
        ? result.tokens
        : undefined
    ),
  )
  const cacheRead = splitInt(result.tokensCacheRead)
  const cacheCreate = splitInt(result.tokensCacheCreate)
  const turns = splitInt(result.numTurns)
  // Core's deterministic completion check calls no provider: it is not an AI
  // invocation, so it writes no ledger row (a $0 row inflated call counts, the
  // priced share and the 'agent-runtime' provider/model breakdowns).
  const providerCall = !isDeterministicVerification(result)
  const shares = providerCall ? programmaticShares(db, payload, result) : undefined
  if (shares) {
    // One row per phase × engine × ticket. Totals are the invocation's exactly:
    // Core's per-phase figures reconcile with them (else no split), duration is
    // apportioned by the measured call time (else tokens, else evenly).
    const weights = shares.every((share) => share.durationMs !== undefined)
      ? shares.map((share) => share.durationMs!)
      : shares.map((share) => (share.tokensIn ?? 0) + (share.tokensOut ?? 0))
    const durations = distributeIntByWeight(result.durationMs === undefined ? undefined : Math.round(result.durationMs), weights)
    shares.forEach((share, shareIndex) => {
      const shareIn = splitInt(share.tokensIn), shareOut = splitInt(share.tokensOut), shareDuration = splitInt(durations[shareIndex])
      targets.forEach((ticketId, index) => {
        const suffix = ticketId == null || targets.length === 1 ? '' : `:t${ticketId}`
        recordInvocation(db, {
          id: `${CORE_V1_ROW_PREFIX}${payload.invocationId}:${shareIndex}${suffix}`,
          project_id: payload.projectId,
          provider: share.provider,
          surface: 'loop',
          surface_ref_id: `${payload.surfaceRefId}${share.stepId ? `:${share.stepId}` : ''}${suffix}`,
          ticket_id: ticketId,
          status: result.failed ? 'failed' : 'success',
          started_at: payload.startedAt,
          finished_at: finishedAt,
          total_cost_usd: share.cost === undefined ? undefined : share.cost / targets.length,
          // Core reports no cost ⇒ unknown, as the aggregate row did; never priced here.
          total_cost_usd_estimated: share.cost === undefined,
          tokens_in: shareIn[index],
          tokens_out: shareOut[index],
          session_id: result.sessionId,
          duration_ms: shareDuration[index],
          model: share.model ?? undefined,
          loop_run_id: payload.runId,
        })
      })
    })
  }
  if (providerCall && !shares) targets.forEach((ticketId, index) => {
    const suffix = ticketId == null || targets.length === 1 ? '' : `:t${ticketId}`
    recordInvocation(db, {
      id: `${payload.invocationId}${suffix}`,
      project_id: payload.projectId,
      provider: result.provider ?? payload.provider,
      surface: 'loop',
      surface_ref_id: `${payload.surfaceRefId}${suffix}`,
      ticket_id: ticketId,
      status: result.failed ? 'failed' : 'success',
      started_at: payload.startedAt,
      finished_at: finishedAt,
      total_cost_usd: result.cost === undefined ? undefined : result.cost / targets.length,
      total_cost_usd_estimated: result.estimated ?? false,
      tokens_in: tokensIn[index],
      tokens_out: tokensOut[index],
      tokens_cache_read: cacheRead[index],
      tokens_cache_create: cacheCreate[index],
      num_turns: turns[index],
      session_id: result.sessionId,
      duration_ms: result.durationMs === undefined ? undefined : result.durationMs / targets.length,
      duration_api_ms: result.durationApiMs === undefined ? undefined : result.durationApiMs / targets.length,
      model: result.model ?? payload.model ?? undefined,
      loop_run_id: payload.runId,
    })
  })
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
  `).get(payload.runId) as {
    cost: number; tokens_in: number; tokens_out: number
    cache_read: number; cache_create: number; duration: number; turns: number
  }
  const runtimeUsage = programmaticUsageAvailability(db, payload.runId)
  const usageTelemetryAvailable = runtimeUsage.present || getAdapter(payload.provider).capabilities.reportsUsage !== false
  db.prepare(`
    UPDATE jobs
       SET total_cost_usd = ?, tokens_in = ?, tokens_out = ?,
           tokens_cache_read = ?, tokens_cache_create = ?,
           duration_ms = ?, num_turns = ?
     WHERE id = ? AND owner = 'loop'
  `).run(
    usageTelemetryAvailable && !runtimeUsage.costUnknown ? aggregate.cost : null,
    usageTelemetryAvailable && !runtimeUsage.tokensInUnknown ? aggregate.tokens_in : null,
    usageTelemetryAvailable && !runtimeUsage.tokensOutUnknown ? aggregate.tokens_out : null,
    usageTelemetryAvailable && !runtimeUsage.present ? aggregate.cache_read : null,
    usageTelemetryAvailable && !runtimeUsage.present ? aggregate.cache_create : null,
    aggregate.duration,
    usageTelemetryAvailable && !runtimeUsage.present ? aggregate.turns : null,
    payload.runId,
  )
}

/** Recover every AI/decider step that was staged before provider spawn but did
 * not atomically land its invocation. Completed interactive turns are the jobs
 * delta from the durable baseline; raw events after completedEventSeq are the
 * unfinished/failed-to-checkpoint turn. The insert and checkpoint removal share
 * one transaction, so a crash between them replays without duplication. */
function boundedInflightDurationMs(
  payload: LoopStepRecoveryPayload,
  finishedAt: string,
): number {
  const startedAt = payload.activeTurnStartedAtMs
  const lastActivityAt = payload.lastActivityAtMs
  if (!Number.isFinite(startedAt) || !Number.isFinite(lastActivityAt)) return 0
  const finishedAtMs = Date.parse(finishedAt)
  const boundedEnd = Number.isFinite(finishedAtMs)
    ? Math.min(lastActivityAt!, finishedAtMs)
    : lastActivityAt!
  return Math.max(0, boundedEnd - startedAt!)
}

export function recoverOrphanLoopStepAccounting(
  db: DbInstance,
  finishedAt = new Date().toISOString(),
  onlyRunId?: string,
): number {
  let recovered = 0
  for (const row of listLoopStepRecoveries(db).filter((candidate) => !onlyRunId || candidate.run_id === onlyRunId)) {
    let payload: LoopStepRecoveryPayload
    try {
      payload = JSON.parse(row.payload) as LoopStepRecoveryPayload
      if (!payload || payload.runId !== row.run_id || payload.stepKey !== row.step_key) continue
    } catch {
      continue
    }
    if (payload.settledResult) {
      const settled = payload.settledResult as LoopRecordedResult
      const didRecover = completeLoopStepRecovery(db, payload.runId, payload.stepKey, (stable) => {
        insertLoopInvocation(db, stable, settled, finishedAt)
        const aggregate = readLoopJobUsage(db, payload.runId)
        const recoveredLoopDuration = (payload.loopDurationBaseline ?? 0) + (settled.durationMs ?? 0)
        db.prepare(`
          UPDATE loop_runs
             SET total_cost_usd = ?, total_tokens = ?, total_duration_ms = ?,
                 iteration_count = MAX(iteration_count, COALESCE(?, iteration_count))
           WHERE id = ?
        `).run(
          aggregate.totalCostUsd,
          aggregate.tokensIn + aggregate.tokensOut,
          recoveredLoopDuration,
          stable.iterationCount ?? null,
          payload.runId,
        )
        // ai_invocations contains AI-active duration only. The backing job is
        // the whole loop and must retain shell duration already represented by
        // loopDurationBaseline across this recovery transaction.
        db.prepare(`UPDATE jobs SET duration_ms = ? WHERE id = ? AND owner = 'loop'`)
          .run(recoveredLoopDuration, payload.runId)
      })
      if (didRecover) recovered += 1
      continue
    }
    const current = readLoopJobUsage(db, payload.runId)
    const completed = {
      tokensIn: Math.max(0, current.tokensIn - (payload.baseline?.tokensIn ?? 0)),
      tokensOut: Math.max(0, current.tokensOut - (payload.baseline?.tokensOut ?? 0)),
      tokensCacheRead: Math.max(0, current.tokensCacheRead - (payload.baseline?.tokensCacheRead ?? 0)),
      tokensCacheCreate: Math.max(0, current.tokensCacheCreate - (payload.baseline?.tokensCacheCreate ?? 0)),
      totalCostUsd: Math.max(0, current.totalCostUsd - (payload.baseline?.totalCostUsd ?? 0)),
      numTurns: Math.max(0, current.numTurns - (payload.baseline?.numTurns ?? 0)),
    }
    const rawRows = db.prepare(`
      SELECT seq, event_type, payload FROM events
       WHERE job_id = ? AND seq > ? AND source = 'stdout'
       ORDER BY seq
    `).all(payload.runId, payload.completedEventSeq ?? -1) as Array<{
      seq: number; event_type: string; payload: string
    }>
    const programmatic = parseProgrammaticUsage(rawRows.map(row => row.payload)) ?? (payload.provider === 'agent-runtime'
      ? { provider: 'agent-runtime' as const, model: 'per-role' as const, estimated: true, failed: true }
      : undefined)
    if (programmatic) {
      const durationMs = boundedInflightDurationMs(payload, finishedAt)
      const didRecover = completeLoopStepRecovery(db, payload.runId, payload.stepKey, stable => {
        insertLoopInvocation(db, stable, { ...programmatic, durationMs }, finishedAt)
        const aggregate = readLoopJobUsage(db, payload.runId)
        const duration = (payload.loopDurationBaseline ?? 0) + durationMs
        db.prepare(`UPDATE loop_runs SET total_cost_usd = ?, total_tokens = ?, total_duration_ms = ?, iteration_count = MAX(iteration_count, COALESCE(?, iteration_count)) WHERE id = ?`)
          .run(aggregate.totalCostUsd, aggregate.tokensIn + aggregate.tokensOut, duration, stable.iterationCount ?? null, payload.runId)
        db.prepare(`UPDATE jobs SET duration_ms = ? WHERE id = ? AND owner = 'loop'`).run(duration, payload.runId)
      })
      if (didRecover) recovered += 1
      continue
    }
    const adapter = getAdapter(payload.provider as Parameters<typeof getAdapter>[0])
    const usageTelemetryAvailable = adapter.capabilities.reportsUsage !== false
    const events = rawRows
      .flatMap((raw) => [...parseStreamEvents(adapter, raw.payload)])
    const { result: partial, estimated } = finaliseInvocationResult(adapter, events, {
      fallbackModel: payload.model ?? undefined,
    })
    const hasResult = rawRows.some((raw) => raw.event_type === 'result')
    const partialCost = hasResult && partial.total_cost_usd != null
      ? Math.max(0, partial.total_cost_usd - (payload.providerCostBaseline ?? 0))
      : (partial.total_cost_usd ?? 0)
    const partialTurns = hasResult && partial.num_turns != null
      ? Math.max(0, partial.num_turns - (payload.providerTurnsBaseline ?? 0))
      : (partial.num_turns ?? (events.length > 0 ? 1 : 0))
    const partialUsage: InteractiveTurnUsage = {
      tokens_in: partial.tokens_in ?? 0,
      tokens_out: partial.tokens_out ?? 0,
      tokens_cache_read: partial.tokens_cache_read ?? 0,
      tokens_cache_create: partial.tokens_cache_create ?? 0,
      total_cost_usd: partialCost,
      num_turns: partialTurns,
      model: partial.model,
      session_id: partial.session_id,
      estimated: partialCost > 0 && estimated,
    }
    const partialDurationMs = hasResult
      ? (partial.duration_ms ?? 0)
      : ((partial.duration_ms ?? 0) > 0
          ? partial.duration_ms!
          : boundedInflightDurationMs(payload, finishedAt))
    // completedDurationMs contains only fully-checkpointed turns. The current
    // raw turn contributes either provider duration OR the bounded wall fallback,
    // never both.
    const recoveredDurationMs = (payload.completedDurationMs ?? 0) + partialDurationMs
    const didRecover = completeLoopStepRecovery(db, payload.runId, payload.stepKey, (stable) => {
      if (
        usageTelemetryAvailable &&
        (
          partialUsage.tokens_in || partialUsage.tokens_out ||
          partialUsage.tokens_cache_read || partialUsage.tokens_cache_create ||
          partialUsage.total_cost_usd || partialUsage.num_turns
        )
      ) {
        accumulateInteractiveTurn(db, payload.runId, partialUsage)
      }
      insertLoopInvocation(db, stable, {
        cost: usageTelemetryAvailable
          ? completed.totalCostUsd + partialUsage.total_cost_usd
          : undefined,
        tokens: usageTelemetryAvailable
          ? completed.tokensIn + completed.tokensOut + partialUsage.tokens_in + partialUsage.tokens_out
          : undefined,
        tokensIn: usageTelemetryAvailable
          ? completed.tokensIn + partialUsage.tokens_in
          : undefined,
        tokensOut: usageTelemetryAvailable
          ? completed.tokensOut + partialUsage.tokens_out
          : undefined,
        tokensCacheRead: usageTelemetryAvailable
          ? completed.tokensCacheRead + partialUsage.tokens_cache_read
          : undefined,
        tokensCacheCreate: usageTelemetryAvailable
          ? completed.tokensCacheCreate + partialUsage.tokens_cache_create
          : undefined,
        numTurns: usageTelemetryAvailable
          ? completed.numTurns + partialUsage.num_turns
          : undefined,
        durationMs: recoveredDurationMs,
        model: partial.model ?? payload.model ?? undefined,
        sessionId: partial.session_id,
        provider: payload.provider,
        estimated: partialUsage.estimated,
        failed: true,
      }, finishedAt)
      const aggregate = readLoopJobUsage(db, payload.runId)
      const recoveredLoopDuration = (payload.loopDurationBaseline ?? 0) + recoveredDurationMs
      db.prepare(`
        UPDATE loop_runs
           SET total_cost_usd = ?, total_tokens = ?, total_duration_ms = ?,
               iteration_count = MAX(iteration_count, COALESCE(?, iteration_count))
         WHERE id = ?
      `).run(
        aggregate.totalCostUsd,
        aggregate.tokensIn + aggregate.tokensOut,
        recoveredLoopDuration,
        stable.iterationCount ?? null,
        payload.runId,
      )
      db.prepare(`UPDATE jobs SET duration_ms = ? WHERE id = ? AND owner = 'loop'`)
        .run(recoveredLoopDuration, payload.runId)
    })
    if (didRecover) recovered += 1
  }
  return recovered
}
