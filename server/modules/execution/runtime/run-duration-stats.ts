/**
 * Honest duration ranges (nontech-review-experience Wave 1). Waiting UX may
 * only ever show a MEASURED band — never a projection, an average dressed as an
 * estimate, or a default. Two shapes are queryable from already-indexed
 * columns: per-loop (`loop_runs.total_duration_ms`, idx_loop_runs_loop) and
 * per-job-command (`jobs.duration_ms`).
 *
 * Below MIN_DURATION_SAMPLES the query returns NOTHING. That is the whole point:
 * the honest-metrics contract (see JobStatusPanel's cost '—') says an unknown
 * must render as absent, not as a guess the user would read as a promise.
 */
import type { DbInstance } from '../../../db'

/** Fewer settled runs than this and no band is returned. */
export const MIN_DURATION_SAMPLES = 5

export interface DurationRange {
  /** 25th percentile, milliseconds. */
  p25Ms: number
  /** 75th percentile, milliseconds. */
  p75Ms: number
  /** Median, milliseconds — rendered only where a single figure is honest. */
  medianMs: number
  /** How many settled runs the band was measured from. */
  sampleCount: number
}

/**
 * Nearest-rank percentile over an ASCENDING sample. Deliberately not
 * interpolated: an interpolated value is a number no run actually took, and
 * every figure this module emits must be traceable to a real measurement.
 */
export function percentileMs(sortedAsc: readonly number[], fraction: number): number {
  if (sortedAsc.length === 0) return 0
  const rank = Math.ceil(fraction * sortedAsc.length)
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))
  return sortedAsc[index]
}

export function rangeFromSamples(samplesMs: readonly number[]): DurationRange | null {
  const usable = samplesMs.filter((ms) => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b)
  if (usable.length < MIN_DURATION_SAMPLES) return null
  return {
    p25Ms: percentileMs(usable, 0.25),
    medianMs: percentileMs(usable, 0.5),
    p75Ms: percentileMs(usable, 0.75),
    sampleCount: usable.length,
  }
}

/** Cap the history window so a long-lived project's ancient runs (different
 * codebase, different model) cannot skew the band a user is shown today. */
const HISTORY_LIMIT = 50

/**
 * One settled run, as the launch forecast and "runs like this have taken"
 * band read it. `costUsd` is set ONLY for a figure the provider reported
 * (positive, not a local price-table estimate); anything else is null so an
 * estimate can never be averaged into a billed range.
 */
export interface RunSample {
  ms: number
  costUsd: number | null
}

/** Settled runs of one loop, newest first, optionally of one provider. */
export function loopRunSamples(db: DbInstance, projectId: string, loopId: string, provider?: string | null): RunSample[] {
  const rows = db.prepare(`
    SELECT lr.total_duration_ms AS ms,
           lr.total_cost_usd AS cost,
           EXISTS (SELECT 1 FROM ai_invocations ai
                    WHERE ai.loop_run_id = lr.id AND ai.total_cost_usd_estimated = 1) AS estimated
      FROM loop_runs lr
     WHERE lr.project_id = ? AND lr.loop_id = ? AND lr.finished_at IS NOT NULL AND lr.total_duration_ms > 0
       AND (? IS NULL OR lr.provider = ?)
     ORDER BY lr.started_at DESC
     LIMIT ?
  `).all(projectId, loopId, provider ?? null, provider ?? null, HISTORY_LIMIT) as { ms: number; cost: number | null; estimated: number }[]
  return rows.map((row) => ({ ms: row.ms, costUsd: billedCost(row.cost, row.estimated === 1) }))
}

/** Measured band for a loop id, or null below the sample floor. */
export function getLoopDurationRange(db: DbInstance, projectId: string, loopId: string): DurationRange | null {
  return rangeFromSamples(loopRunSamples(db, projectId, loopId).map((sample) => sample.ms))
}

/**
 * Commands carry per-run arguments (`loop:<uuid>`, `/specrails:implement #12`),
 * so history is grouped by a stable SHAPE rather than the literal string:
 * the command's leading token with ticket refs and ids stripped.
 */
export function jobCommandShape(command: string): string {
  const head = command.trim().split(/\s+/)[0] ?? ''
  if (head.startsWith('loop:')) return 'loop:'
  return head
}

/** Completed jobs of one command shape, newest first, optionally of one provider. */
export function jobCommandSamples(db: DbInstance, commandShape: string, provider?: string | null): RunSample[] {
  const rows = db.prepare(`
    SELECT duration_ms AS ms, command, total_cost_usd AS cost, total_cost_usd_estimated AS estimated, provider
      FROM jobs
     WHERE status = 'completed' AND duration_ms > 0
     ORDER BY started_at DESC
     LIMIT 500
  `).all() as { ms: number; command: string; cost: number | null; estimated: number | null; provider: string | null }[]
  return rows
    .filter((row) => jobCommandShape(row.command ?? '') === commandShape && (!provider || row.provider === provider))
    .slice(0, HISTORY_LIMIT)
    .map((row) => ({ ms: row.ms, costUsd: billedCost(row.cost, row.estimated === 1) }))
}

/** Measured band for a job command shape, or null below the sample floor. */
export function getJobCommandDurationRange(db: DbInstance, commandShape: string): DurationRange | null {
  return rangeFromSamples(jobCommandSamples(db, commandShape).map((sample) => sample.ms))
}

function billedCost(cost: number | null, estimated: boolean): number | null {
  return !estimated && typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : null
}
