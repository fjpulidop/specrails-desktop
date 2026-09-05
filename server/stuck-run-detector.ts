/**
 * Stuck-run detection (nontech-review-experience Wave 1). A user who cannot
 * read logs has no way to tell a thinking run from a wedged one; done/failed
 * notifications already ship (useOsNotifications), so the missing signal is
 * "this stopped moving".
 *
 * The signal is entirely derived from data the loop engine ALREADY persists:
 * `loop_step_recovery.payload.lastActivityAtMs` (updated on raw provider
 * activity, cleared when a result frontier commits). No new writes, no polling
 * of live process state, nothing invented — a stall is a measured absence.
 *
 * Episode identity is `runId:stepKey:lastActivityAtMs`, so the same stall never
 * notifies twice and fresh activity re-arms detection automatically (the
 * timestamp moves ⇒ a new episode key).
 *
 * DEVIATION from the change's task text (2× step p75): no per-STEP duration
 * aggregate exists in the schema (`loop_step_end.durationMs` lives only inside
 * event payloads), and a per-RUN p75 is far too lenient as a step threshold.
 * The shipped rule is therefore a flat, env-overridable threshold with a
 * 10-minute floor — honest and cheap. Scaling by real step history is deferred
 * until step durations are aggregated.
 */
import type { DbInstance } from './db'
import type { JobStuckMessage } from './types'
import { listLoopStepRecoveries, type LoopStepRecoveryPayload } from './loop-runs-store'

/** Never notify sooner than this, however the threshold is configured. */
export const STUCK_FLOOR_MS = 10 * 60 * 1000

/** How often the sweep runs while the server is up. */
export const STUCK_SWEEP_INTERVAL_MS = 60 * 1000

/**
 * `SPECRAILS_STUCK_THRESHOLD_MS` raises (never lowers) the floor; `0`/`false`/
 * `off` disables detection entirely.
 */
export function resolveStuckThresholdMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.SPECRAILS_STUCK_THRESHOLD_MS
  if (raw === undefined || raw === '') return STUCK_FLOOR_MS
  const normalized = raw.trim().toLowerCase()
  if (normalized === '0' || normalized === 'false' || normalized === 'off') return null
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed <= 0) return STUCK_FLOOR_MS
  return Math.max(STUCK_FLOOR_MS, Math.trunc(parsed))
}

export interface StuckCandidate {
  runId: string
  stepKey: string
  projectId: string
  staleMs: number
  /** Episode key — stable while the stall persists, changes on new activity. */
  episode: string
}

export interface StuckSweepIO {
  db: DbInstance
  /** Loop runs still marked running; a settled/orphaned row never notifies. */
  isRunActive?: (runId: string) => boolean
  now?: () => number
  thresholdMs?: number | null
}

function lastActivityMs(payload: LoopStepRecoveryPayload): number | null {
  const candidates = [payload.lastActivityAtMs, payload.activeTurnStartedAtMs]
    .filter((value): value is number => Number.isFinite(value) && (value as number) > 0)
  return candidates.length > 0 ? Math.max(...candidates) : null
}

function defaultIsRunActive(db: DbInstance, runId: string): boolean {
  const row = db.prepare(`SELECT status FROM loop_runs WHERE id = ?`).get(runId) as { status?: string } | undefined
  return row?.status === 'running'
}

/**
 * One pass over the persisted step checkpoints. Pure with respect to the
 * database (reads only) so the caller owns broadcasting and episode memory.
 */
export function findStuckCandidates(io: StuckSweepIO): StuckCandidate[] {
  const threshold = io.thresholdMs === undefined ? resolveStuckThresholdMs() : io.thresholdMs
  if (threshold === null) return []
  const now = io.now?.() ?? Date.now()
  const isRunActive = io.isRunActive ?? ((runId: string) => defaultIsRunActive(io.db, runId))
  const out: StuckCandidate[] = []
  let rows
  try {
    rows = listLoopStepRecoveries(io.db)
  } catch {
    return []
  }
  for (const row of rows) {
    let payload: LoopStepRecoveryPayload
    try {
      payload = JSON.parse(row.payload) as LoopStepRecoveryPayload
    } catch {
      continue
    }
    const last = lastActivityMs(payload)
    if (last === null) continue
    const staleMs = now - last
    if (staleMs < threshold) continue
    try {
      if (!isRunActive(row.run_id)) continue
    } catch {
      continue
    }
    out.push({
      runId: row.run_id,
      stepKey: row.step_key,
      projectId: payload.projectId,
      staleMs,
      episode: `${row.run_id}:${row.step_key}:${last}`,
    })
  }
  return out
}

/**
 * Owns episode memory across sweeps and emits at most one message per stall.
 * Constructed per project context so the broadcast is already project-scoped.
 */
export class StuckRunDetector {
  private readonly notified = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly projectId: string,
    private readonly io: StuckSweepIO,
    private readonly broadcast: (message: JobStuckMessage) => void,
  ) {}

  /** One sweep; returns the messages actually emitted (for tests/diagnostics). */
  sweep(): JobStuckMessage[] {
    const candidates = findStuckCandidates(this.io)
    const live = new Set(candidates.map((candidate) => candidate.episode))
    // Forget episodes that ended so a later stall of the same step re-notifies.
    for (const episode of [...this.notified]) {
      if (!live.has(episode)) this.notified.delete(episode)
    }
    const emitted: JobStuckMessage[] = []
    for (const candidate of candidates) {
      if (this.notified.has(candidate.episode)) continue
      this.notified.add(candidate.episode)
      const message: JobStuckMessage = {
        type: 'job.stuck',
        projectId: this.projectId,
        jobId: candidate.runId,
        stepKey: candidate.stepKey,
        staleMs: candidate.staleMs,
        actions: ['stop'],
        timestamp: new Date(this.io.now?.() ?? Date.now()).toISOString(),
      }
      try {
        this.broadcast(message)
        emitted.push(message)
      } catch {
        // A failed broadcast must not wedge the sweep; the next pass retries
        // because the episode is only remembered after a successful send.
        this.notified.delete(candidate.episode)
      }
    }
    return emitted
  }

  start(intervalMs = STUCK_SWEEP_INTERVAL_MS): void {
    if (this.timer) return
    if ((this.io.thresholdMs === undefined ? resolveStuckThresholdMs() : this.io.thresholdMs) === null) return
    this.timer = setInterval(() => {
      try { this.sweep() } catch { /* never let a sweep crash the server */ }
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
