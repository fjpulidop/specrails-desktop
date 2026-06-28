/**
 * Loop runs store — per-project record (jobs.sqlite `loop_runs`) of each
 * executed loop. The manager creates a row at launch, updates counters as it
 * iterates, and finalises it at the end. Powers loop analytics + the
 * "Running" derived state (a loop is Running iff a row here has status='running').
 */
import type { DbInstance } from './db'

export type LoopRunStatus = 'running' | 'completed'
export type LoopRunOutcome = 'success' | 'max-iterations' | 'max-cost' | 'stopped' | 'failed'

export interface LoopRunRow {
  id: string
  project_id: string
  loop_id: string
  loop_name: string | null
  rail_index: number | null
  ticket_id: number | null
  provider: string | null
  model: string | null
  reasoning_effort: string | null
  status: LoopRunStatus
  final_outcome: LoopRunOutcome | null
  iteration_limit: number
  iteration_count: number
  total_cost_usd: number
  total_tokens: number
  total_duration_ms: number
  started_at: string
  finished_at: string | null
  created_at: string
}

export interface CreateLoopRunInput {
  id: string
  projectId: string
  loopId: string
  loopName?: string | null
  railIndex?: number | null
  ticketId?: number | null
  provider?: string | null
  model?: string | null
  reasoningEffort?: string | null
  iterationLimit: number
  startedAt: string
}

export interface LoopRunCounters {
  iterationCount: number
  totalCostUsd: number
  totalTokens: number
  totalDurationMs: number
}

export function createLoopRun(db: DbInstance, input: CreateLoopRunInput): LoopRunRow {
  db.prepare(`
    INSERT INTO loop_runs (
      id, project_id, loop_id, loop_name, rail_index, ticket_id, provider, model,
      reasoning_effort, status, iteration_limit, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.loopId,
    input.loopName ?? null,
    input.railIndex ?? null,
    input.ticketId ?? null,
    input.provider ?? null,
    input.model ?? null,
    input.reasoningEffort ?? null,
    input.iterationLimit,
    input.startedAt,
  )
  return getLoopRun(db, input.id)!
}

// Column allow-list — counters are interpolated into the SET clause, so gate
// the keys to prevent any future caller injecting SQL via an object key.
const COUNTER_COLUMNS: Record<keyof LoopRunCounters, string> = {
  iterationCount: 'iteration_count',
  totalCostUsd: 'total_cost_usd',
  totalTokens: 'total_tokens',
  totalDurationMs: 'total_duration_ms',
}

export function updateLoopRunCounters(db: DbInstance, id: string, counters: Partial<LoopRunCounters>): void {
  const keys = (Object.keys(counters) as (keyof LoopRunCounters)[]).filter((k) => counters[k] !== undefined)
  if (keys.length === 0) return
  const setClause = keys.map((k) => `${COUNTER_COLUMNS[k]} = ?`).join(', ')
  const values = keys.map((k) => counters[k] as number)
  db.prepare(`UPDATE loop_runs SET ${setClause} WHERE id = ?`).run(...values, id)
}

export function finishLoopRun(
  db: DbInstance,
  id: string,
  opts: { outcome: LoopRunOutcome; finishedAt: string; counters?: Partial<LoopRunCounters> }
): LoopRunRow | undefined {
  if (opts.counters) updateLoopRunCounters(db, id, opts.counters)
  db.prepare(
    `UPDATE loop_runs SET status = 'completed', final_outcome = ?, finished_at = ? WHERE id = ?`
  ).run(opts.outcome, opts.finishedAt, id)
  return getLoopRun(db, id)
}

export function getLoopRun(db: DbInstance, id: string): LoopRunRow | undefined {
  return db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(id) as LoopRunRow | undefined
}

/** Step + log-line counts for a run, derived from its persisted events. Used to
 *  SEED the dashboard's live rail metrics after a page refresh — the WS stream
 *  alone can't replay the run_started/log/loop_step events that already fired.
 *  steps = number of `loop_step` events; lines = number of `log` events. */
export function getRunEventCounts(db: DbInstance, runId: string): { steps: number; lines: number } {
  const rows = db
    .prepare("SELECT event_type, COUNT(*) AS n FROM events WHERE job_id = ? AND event_type IN ('loop_step','log') GROUP BY event_type")
    .all(runId) as { event_type: string; n: number }[]
  let steps = 0
  let lines = 0
  for (const r of rows) {
    if (r.event_type === 'loop_step') steps = r.n
    else if (r.event_type === 'log') lines = r.n
  }
  return { steps, lines }
}

export function listLoopRuns(db: DbInstance, projectId: string, limit = 100): LoopRunRow[] {
  return db
    .prepare('SELECT * FROM loop_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(projectId, limit) as LoopRunRow[]
}

/** How many runs of a given loop definition are currently executing in this
 *  project's DB. Used (across all project DBs) for the global "is this loop
 *  Running?" guard that blocks edit/delete of a loop while it executes. */
export function countRunningForLoop(db: DbInstance, loopId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE loop_id = ? AND status = 'running'`)
    .get(loopId) as { n: number }
  return row.n
}

/** Reconcile orphan runs at startup: any row still `status='running'` belongs to
 *  a process that is now dead (server restart, or a run killed before it could
 *  settle), so mark it terminal (`completed` + outcome `failed`). Without this an
 *  orphan keeps `countRunningForLoop > 0` forever, which wedges the loop as
 *  un-editable / un-publishable ("Failed to save loop" via the isRunning 409).
 *  Returns the number of rows reconciled. */
export function reconcileOrphanLoopRuns(db: DbInstance, finishedAt: string): number {
  const res = db
    .prepare(
      `UPDATE loop_runs SET status = 'completed', final_outcome = COALESCE(final_outcome, 'failed'), finished_at = COALESCE(finished_at, ?) WHERE status = 'running'`
    )
    .run(finishedAt)
  return res.changes ?? 0
}
