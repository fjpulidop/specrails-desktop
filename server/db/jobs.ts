import type { JobRow, EventRow, JobStatus } from '../types'
import type { DbInstance, NewJob, QueuedJobRecord, InteractiveTurnUsage, JobResult, AppEvent, ListJobsOpts } from './types'

export function createJob(db: DbInstance, job: NewJob): void {
  // Promotion is atomic: after a crash the job is either still replayable in
  // queued_jobs or is a running jobs row, never absent from both. INSERT OR
  // IGNORE preserves idempotency for legacy/restored jobs that already exist.
  const promote = db.transaction(() => {
    db.prepare(
      'INSERT OR IGNORE INTO jobs (id, command, started_at, status, provider, owner, priority, depends_on_job_id, pipeline_id, interactive, causal_ownership) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(job.id, job.command, job.started_at, 'running', job.provider ?? null, job.owner ?? 'queue', job.priority ?? 'normal', job.depends_on_job_id ?? null, job.pipeline_id ?? null, job.interactive ? 1 : 0, job.causal_ownership ? 1 : 0)
    db.prepare(
      'UPDATE jobs SET status = ?, started_at = ?, provider = ?, owner = ?, interactive = ?, causal_ownership = ? WHERE id = ?'
    ).run('running', job.started_at, job.provider ?? null, job.owner ?? 'queue', job.interactive ? 1 : 0, job.causal_ownership ? 1 : 0, job.id)
    db.prepare('DELETE FROM queued_jobs WHERE id = ?').run(job.id)
  })
  promote()
}

/** Idempotently persist a job that has been admitted but has not started. */
export function upsertQueuedJob(db: DbInstance, job: QueuedJobRecord): void {
  db.prepare(`
    INSERT INTO queued_jobs (
      id, command, queue_position, priority, depends_on_job_id, pipeline_id,
      provider, model, profile_name, profile_selection_set, interactive,
      causal_ownership
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      command = excluded.command,
      queue_position = excluded.queue_position,
      priority = excluded.priority,
      depends_on_job_id = excluded.depends_on_job_id,
      pipeline_id = excluded.pipeline_id,
      provider = excluded.provider,
      model = excluded.model,
      profile_name = excluded.profile_name,
      profile_selection_set = excluded.profile_selection_set,
      interactive = excluded.interactive,
      causal_ownership = excluded.causal_ownership
  `).run(
    job.id,
    job.command,
    job.queue_position,
    job.priority,
    job.depends_on_job_id ?? null,
    job.pipeline_id ?? null,
    job.provider ?? null,
    job.model ?? null,
    job.profile_name ?? null,
    job.profile_selection_set ? 1 : 0,
    job.interactive == null ? null : (job.interactive ? 1 : 0),
    job.causal_ownership ? 1 : 0,
  )
}

/** Remove a queued admission after cancellation/skip. Idempotent.
 *
 * Migration 43 deliberately keeps a read fallback for pre-migration builds
 * that represented queued work in `jobs`. Remove that legacy representation
 * too, but only while it is still queued: promotion changes the status to
 * running before calling this helper, and terminal history must never be
 * deleted here. */
export function deleteQueuedJob(db: DbInstance, jobId: string): void {
  db.prepare('DELETE FROM queued_jobs WHERE id = ?').run(jobId)
  db.prepare("DELETE FROM jobs WHERE id = ? AND status = 'queued'").run(jobId)
}

/**
 * Flip a job row's `interactive` flag AFTER creation. Used by the loop engine
 * when an ai-step upgrades the run's backing job to a resident interactive
 * session — the row was created at run start (before the step's provider
 * capability/kill-switch gate is consulted), so the flag lands lazily at the
 * first interactive step spawn. Idempotent.
 */
export function markJobInteractive(db: DbInstance, jobId: string): void {
  db.prepare('UPDATE jobs SET interactive = 1 WHERE id = ?').run(jobId)
}

/**
 * Add one completed interactive turn's REAL usage into the job row. Token/cost/
 * turn columns accumulate (COALESCE so the first turn starts from a clean base);
 * model + session_id are stamped from the first turn that reports them. The job
 * stays 'running' — only finalizeInteractiveJob flips the terminal status. This
 * keeps the live Job Detail totals honest (sum of completed turns, never an
 * estimate) between turns.
 */
export function accumulateInteractiveTurn(
  db: DbInstance,
  jobId: string,
  turn: InteractiveTurnUsage,
): void {
  db.prepare(`
    UPDATE jobs SET
      tokens_in           = COALESCE(tokens_in, 0) + ?,
      tokens_out          = COALESCE(tokens_out, 0) + ?,
      tokens_cache_read   = COALESCE(tokens_cache_read, 0) + ?,
      tokens_cache_create = COALESCE(tokens_cache_create, 0) + ?,
      total_cost_usd      = COALESCE(total_cost_usd, 0) + ?,
      num_turns           = COALESCE(num_turns, 0) + ?,
      total_cost_usd_estimated = CASE WHEN ? = 1 THEN 1 ELSE total_cost_usd_estimated END,
      model               = COALESCE(model, ?),
      session_id          = COALESCE(?, session_id)
    WHERE id = ?
  `).run(
    turn.tokens_in,
    turn.tokens_out,
    turn.tokens_cache_read,
    turn.tokens_cache_create,
    turn.total_cost_usd,
    turn.num_turns,
    turn.estimated ? 1 : 0,
    turn.model ?? null,
    turn.session_id ?? null,
    jobId,
  )
}

/**
 * Flip an interactive job to its terminal status (completed on finalize, failed
 * on crash) and stamp finished_at. Token/cost/turn columns are left untouched —
 * they were already accumulated turn-by-turn via accumulateInteractiveTurn.
 */
export function finalizeInteractiveJob(
  db: DbInstance,
  jobId: string,
  status: JobStatus,
): void {
  db.prepare(
    'UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?'
  ).run(status, new Date().toISOString(), jobId)
}

export function finishJob(
  db: DbInstance,
  jobId: string,
  result: JobResult
): void {
  db.prepare(`
    UPDATE jobs SET
      status              = ?,
      exit_code           = ?,
      finished_at         = ?,
      tokens_in           = ?,
      tokens_out          = ?,
      tokens_cache_read   = ?,
      tokens_cache_create = ?,
      total_cost_usd      = ?,
      total_cost_usd_estimated = ?,
      num_turns           = ?,
      model               = ?,
      duration_ms         = ?,
      duration_api_ms     = ?,
      session_id          = ?
    WHERE id = ?
  `).run(
    result.status,
    result.exit_code,
    new Date().toISOString(),
    result.tokens_in ?? null,
    result.tokens_out ?? null,
    result.tokens_cache_read ?? null,
    result.tokens_cache_create ?? null,
    result.total_cost_usd ?? null,
    result.total_cost_usd_estimated ? 1 : 0,
    result.num_turns ?? null,
    result.model ?? null,
    result.duration_ms ?? null,
    result.duration_api_ms ?? null,
    result.session_id ?? null,
    jobId,
  )
}

export function appendEvent(
  db: DbInstance,
  jobId: string,
  seq: number,
  event: AppEvent
): void {
  db.prepare(
    'INSERT INTO events (job_id, seq, event_type, source, payload) VALUES (?, ?, ?, ?, ?)'
  ).run(jobId, seq, event.event_type, event.source ?? null, event.payload)
}

export function upsertPhase(
  db: DbInstance,
  jobId: string,
  phase: string,
  state: string
): void {
  db.prepare(
    'INSERT OR REPLACE INTO job_phases (job_id, phase, state, updated_at) VALUES (?, ?, ?, ?)'
  ).run(jobId, phase, state, new Date().toISOString())
}

export function listJobs(
  db: DbInstance,
  opts: ListJobsOpts
): { jobs: JobRow[]; total: number } {
  const limit = Math.min(opts.limit ?? 50, 200)
  const offset = opts.offset ?? 0

  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.status) {
    conditions.push('status = ?')
    params.push(opts.status)
  }
  if (opts.from) {
    conditions.push('started_at >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    conditions.push('started_at <= ?')
    params.push(opts.to)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countRow = db
    .prepare(`SELECT COUNT(*) as count FROM jobs ${where}`)
    .get(...params) as { count: number }

  const jobs = db
    .prepare(
      `SELECT jobs.*, jp.profile_name AS profile_name
       FROM jobs LEFT JOIN job_profiles jp ON jp.job_id = jobs.id
       ${where}
       ORDER BY started_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as JobRow[]

  return { jobs, total: countRow.count }
}

export function getJob(
  db: DbInstance,
  jobId: string
): JobRow | undefined {
  return db
    .prepare(`
      SELECT jobs.*, jp.profile_name AS profile_name
      FROM jobs
      LEFT JOIN job_profiles jp ON jp.job_id = jobs.id
      WHERE jobs.id = ?
    `)
    .get(jobId) as JobRow | undefined
}

export function getJobEvents(
  db: DbInstance,
  jobId: string
): EventRow[] {
  return db
    .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq ASC')
    .all(jobId) as EventRow[]
}

export class JobRecoveryPendingError extends Error {
  constructor(public readonly jobId: string) {
    super('Job recovery is still pending; retry deletion after recovery completes')
    this.name = 'JobRecoveryPendingError'
  }
}

export function deleteJob(db: DbInstance, jobId: string): void {
  // M7: jobs.depends_on_job_id REFERENCES jobs(id) with no ON DELETE action and
  // foreign_keys=ON, so deleting a pipeline parent throws 'FOREIGN KEY
  // constraint failed' and the job becomes undeletable from the UI. Clear inbound
  // references first, in the same transaction as the delete, so it always
  // succeeds (children keep running; they just lose the now-irrelevant pointer).
  const tx = db.transaction((id: string) => {
    const pendingLoopStep = db.prepare(`SELECT 1 FROM loop_step_recovery WHERE run_id = ? LIMIT 1`).get(id)
    const pendingQueueRecovery = db.prepare(
      `SELECT 1 FROM orphan_job_recovery WHERE job_id = ? LIMIT 1`,
    ).get(id)
    if (pendingLoopStep || pendingQueueRecovery) {
      throw new JobRecoveryPendingError(id)
    }
    db.prepare('UPDATE jobs SET depends_on_job_id = NULL WHERE depends_on_job_id = ?').run(id)
    // B41: events/job_phases cascade on the jobs FK, but telemetry_blobs/
    // telemetry_summaries (keyed `jobId`), job_profiles and file_provenance
    // (keyed `job_id`) have no FK — without these they accumulate forever. (The
    // on-disk .ndjson.gz blob is reclaimed by the 7-day startup compactor.)
    db.prepare('DELETE FROM telemetry_blobs WHERE jobId = ?').run(id)
    db.prepare('DELETE FROM telemetry_summaries WHERE jobId = ?').run(id)
    db.prepare('DELETE FROM job_profiles WHERE job_id = ?').run(id)
    db.prepare('DELETE FROM file_provenance WHERE job_id = ?').run(id)
    db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  })
  tx(jobId)
}

export function purgeJobs(
  db: DbInstance,
  opts?: { from?: string; to?: string }
): number {
  const conditions: string[] = [
    "status IN ('completed', 'failed', 'canceled', 'zombie_terminated', 'skipped')",
    'NOT EXISTS (SELECT 1 FROM loop_step_recovery WHERE loop_step_recovery.run_id = jobs.id)',
    'NOT EXISTS (SELECT 1 FROM orphan_job_recovery WHERE orphan_job_recovery.job_id = jobs.id)',
  ]
  const params: unknown[] = []

  if (opts?.from) {
    conditions.push('started_at >= ?')
    params.push(opts.from)
  }
  if (opts?.to) {
    conditions.push('started_at <= ?')
    params.push(opts.to)
  }

  const where = conditions.join(' AND ')

  // M6: run the whole purge atomically. Previously these statements ran without a
  // transaction, so when the final `DELETE FROM jobs` aborted on the
  // depends_on_job_id FK (a purged job still referenced by a non-purged one), the
  // events/phases deletes had already committed — destroying log history while
  // deleting zero job rows, and a misleading 500. The transaction rolls back on
  // any failure, and NULL-ing inbound references first makes the delete succeed.
  const tx = db.transaction(() => {
    const sel = `SELECT id FROM jobs WHERE ${where}`
    db.prepare(`DELETE FROM events WHERE job_id IN (${sel})`).run(...params)
    db.prepare(`DELETE FROM job_phases WHERE job_id IN (${sel})`).run(...params)
    // B41: also purge the no-FK orphan tables for the same jobs.
    db.prepare(`DELETE FROM telemetry_blobs WHERE jobId IN (${sel})`).run(...params)
    db.prepare(`DELETE FROM telemetry_summaries WHERE jobId IN (${sel})`).run(...params)
    db.prepare(`DELETE FROM job_profiles WHERE job_id IN (${sel})`).run(...params)
    db.prepare(`DELETE FROM file_provenance WHERE job_id IN (${sel})`).run(...params)
    // Clear inbound FK references from NON-purged jobs to purged jobs.
    db.prepare(`UPDATE jobs SET depends_on_job_id = NULL WHERE depends_on_job_id IN (${sel})`).run(...params)
    return db.prepare(`DELETE FROM jobs WHERE ${where}`).run(...params).changes
  })
  return tx() as number
}

export function skipJob(db: DbInstance, jobId: string, reason: string): void {
  db.prepare(
    `UPDATE jobs SET status = 'skipped', skip_reason = ?, finished_at = ? WHERE id = ?`
  ).run(reason, new Date().toISOString(), jobId)
}

export function getPipelineJobs(db: DbInstance, pipelineId: string): JobRow[] {
  return db.prepare(
    'SELECT * FROM jobs WHERE pipeline_id = ? ORDER BY queue_position ASC, started_at ASC'
  ).all(pipelineId) as JobRow[]
}
