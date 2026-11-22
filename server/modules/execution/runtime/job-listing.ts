import { supersededAttemptSql } from '../../loops/runtime/run-attempts'
import type { DbInstance } from '../../../db'
import type { JobPriority, JobRow } from '../../../types'

export type ListedJobRow = Omit<JobRow, 'started_at'> & {
  /** Execution start. Null while the admission is still queued. */
  started_at: string | null
  /** Durable queue-admission timestamp. Present only for queued rows. */
  enqueued_at?: string | null
}

export interface UnifiedJobListOptions {
  limit: number
  offset: number
  status?: string
  activeRuntimeIds?: string[]
  from?: string
  to?: string
  /** `all` also lists the attempts a later attempt continued (history); by default a chain lists only its latest attempt. */
  attempts?: 'latest' | 'all'
}

interface QueuedListRecord {
  id: string
  command: string
  queue_position: number | null
  priority: JobPriority
  depends_on_job_id: string | null
  pipeline_id: string | null
  enqueued_at: string
}

const QUEUED_SOURCE = `
  WITH queued_source AS (
    SELECT
      q.id, q.command, q.queue_position, q.priority,
      q.depends_on_job_id, q.pipeline_id, q.enqueued_at
    FROM queued_jobs q
    UNION ALL
    SELECT
      j.id, j.command, j.queue_position, j.priority,
      j.depends_on_job_id, j.pipeline_id, j.started_at AS enqueued_at
    FROM jobs j
    WHERE j.status = 'queued'
      AND NOT EXISTS (SELECT 1 FROM queued_jobs q WHERE q.id = j.id)
  )
`

function queuedConditions(opts: UnifiedJobListOptions): { sql: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.from) {
    conditions.push('datetime(enqueued_at) >= datetime(?)')
    params.push(opts.from)
  }
  if (opts.to) {
    conditions.push('datetime(enqueued_at) <= datetime(?)')
    params.push(opts.to)
  }
  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

function historyConditions(opts: UnifiedJobListOptions): { sql: string; params: unknown[] } {
  const conditions: string[] = ["jobs.status <> 'queued'"]
  const params: unknown[] = []
  // One row per attempt chain: an attempt a later one continued is history, not a separate failure.
  if (opts.attempts !== 'all') conditions.push(`NOT ${supersededAttemptSql('jobs')}`)
  if (opts.status) {
    const active = opts.activeRuntimeIds ?? []
    conditions.push(active.length ? `CASE WHEN jobs.id IN (${active.map(() => '?').join(',')}) THEN 'running' ELSE jobs.status END = ?` : 'jobs.status = ?')
    params.push(...active)
    params.push(opts.status)
  }
  if (opts.from) {
    conditions.push('jobs.started_at >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    conditions.push('jobs.started_at <= ?')
    params.push(opts.to)
  }
  return { sql: `WHERE ${conditions.join(' AND ')}`, params }
}

function toQueuedJobRow(row: QueuedListRecord): ListedJobRow {
  return {
    id: row.id,
    command: row.command,
    started_at: null,
    enqueued_at: row.enqueued_at,
    finished_at: null,
    status: 'queued',
    exit_code: null,
    queue_position: row.queue_position,
    priority: row.priority,
    tokens_in: null,
    tokens_out: null,
    tokens_cache_read: null,
    tokens_cache_create: null,
    total_cost_usd: null,
    total_cost_usd_estimated: null,
    num_turns: null,
    model: null,
    duration_ms: null,
    duration_api_ms: null,
    session_id: null,
    depends_on_job_id: row.depends_on_job_id,
    pipeline_id: row.pipeline_id,
    skip_reason: null,
    profile_name: null,
    interactive: 0,
    provider: null,
    owner: 'queue',
  }
}

/**
 * Page queued admissions and execution history as one stable sequence. Queued
 * work remains first (in durable queue order), followed by history newest-first.
 * Both total and offset apply to that combined sequence; no in-memory prepend
 * can amplify the requested limit.
 */
export function listUnifiedJobs(
  db: DbInstance,
  opts: UnifiedJobListOptions,
): { jobs: ListedJobRow[]; total: number } {
  const limit = Math.max(1, Math.min(opts.limit, 200))
  const offset = Math.max(0, opts.offset)
  const includeQueued = !opts.status || opts.status === 'queued'
  const includeHistory = opts.status !== 'queued'

  let queuedTotal = 0
  let queuedRows: ListedJobRow[] = []
  if (includeQueued) {
    const queued = queuedConditions(opts)
    queuedTotal = (db.prepare(
      `${QUEUED_SOURCE} SELECT COUNT(*) AS count FROM queued_source ${queued.sql}`,
    ).get(...queued.params) as { count: number }).count

    const queuedOffset = Math.min(offset, queuedTotal)
    const queuedLimit = Math.min(limit, Math.max(0, queuedTotal - offset))
    if (queuedLimit > 0) {
      const rows = db.prepare(`
        ${QUEUED_SOURCE}
        SELECT * FROM queued_source
        ${queued.sql}
        ORDER BY queue_position ASC, id ASC
        LIMIT ? OFFSET ?
      `).all(...queued.params, queuedLimit, queuedOffset) as QueuedListRecord[]
      queuedRows = rows.map(toQueuedJobRow)
    }
  }

  let historyTotal = 0
  let historyRows: ListedJobRow[] = []
  if (includeHistory) {
    const history = historyConditions(opts)
    historyTotal = (db.prepare(
      `SELECT COUNT(*) AS count FROM jobs ${history.sql}`,
    ).get(...history.params) as { count: number }).count

    const remaining = limit - queuedRows.length
    const historyOffset = Math.max(0, offset - queuedTotal)
    if (remaining > 0 && historyOffset < historyTotal) {
      const active = opts.activeRuntimeIds ?? []
      const activeOrder = active.length ? `CASE WHEN jobs.id IN (${active.map(() => '?').join(',')}) THEN 0 ELSE 1 END, ` : ''
      historyRows = db.prepare(`
        SELECT jobs.*, jp.profile_name AS profile_name, NULL AS enqueued_at
        FROM jobs
        LEFT JOIN job_profiles jp ON jp.job_id = jobs.id
        ${history.sql}
        ORDER BY ${activeOrder}jobs.started_at DESC, jobs.id ASC
        LIMIT ? OFFSET ?
      `).all(...history.params, ...active, remaining, historyOffset) as ListedJobRow[]
    }
  }

  return { jobs: [...queuedRows, ...historyRows], total: queuedTotal + historyTotal }
}

/** Durable queued detail lookup used before execution creates a jobs row. */
export function getQueuedJobForListing(
  db: DbInstance,
  jobId: string,
): ListedJobRow | undefined {
  const row = db.prepare(`
    ${QUEUED_SOURCE}
    SELECT * FROM queued_source WHERE id = ?
  `).get(jobId) as QueuedListRecord | undefined
  return row ? toQueuedJobRow(row) : undefined
}

// ─── Cross-project run read model (MCP `runs(list)` without a project) ──────────

/**
 * Position in the app-wide run sequence: live runs first (running, held or
 * queued; tier 0), then finished history (tier 1); each tier newest first by
 * start (a queued admission by its enqueue time), ties by project id then run
 * id. A page resumes strictly after the last position it returned.
 */
export interface RunSequenceKey { tier: 0 | 1; at: string; projectId: string; id: string }

export type SequencedRun = ListedJobRow & { projectId: string; tier: 0 | 1; sortAt: string }

export interface RunsAfterOptions {
  projectId: string
  /** Rows wanted from this project (the caller asks for its page size + 1). */
  limit: number
  after?: RunSequenceKey | null
  /** One server status: `queued`, `running`, or a finished word (`completed`, `failed`, `canceled`, …). */
  status?: string
  /** ISO lower bound on start / enqueue time. */
  from?: string
  /** Runs a runtime continuation keeps alive: listed as running whatever their row says. */
  activeRuntimeIds?: readonly string[]
}

/** The order of the sequence (negative: `a` comes first). */
export function compareRunSequence(a: RunSequenceKey, b: RunSequenceKey): number {
  if (a.tier !== b.tier) return a.tier - b.tier
  if (a.at !== b.at) return a.at < b.at ? 1 : -1
  if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * `<column> < at OR (column = at AND <tie>)` for one project's rows of the
 * cursor's tier; the tie on project id is decided here, in JS, because a
 * project's rows share it.
 */
function afterSql(column: string, idColumn: string, projectId: string, after: RunSequenceKey): { sql: string; params: unknown[] } {
  if (projectId > after.projectId) return { sql: `${column} <= ?`, params: [after.at] }
  if (projectId < after.projectId) return { sql: `${column} < ?`, params: [after.at] }
  return { sql: `(${column} < ? OR (${column} = ? AND ${idColumn} > ?))`, params: [after.at, after.at, after.id] }
}

/**
 * One project's next rows of the app-wide sequence: at most `limit` per tier,
 * each read through `idx_jobs_started_at` (no COUNT, no scan past the page).
 */
export function listRunsAfter(db: DbInstance, opts: RunsAfterOptions): SequencedRun[] {
  const limit = Math.max(1, Math.min(opts.limit, 201))
  const after = opts.after ?? null
  const active = [...new Set(opts.activeRuntimeIds ?? [])]
  const status = opts.status
  const wantLive = !status || status === 'queued' || status === 'running'
  const wantHistory = !status || (status !== 'queued' && status !== 'running')
  const out: SequencedRun[] = []
  const inActive = active.length ? `jobs.id IN (${active.map(() => '?').join(',')})` : '0'

  if (wantLive && !(after && after.tier > 0)) {
    if (status !== 'queued') {
      const where = [`(jobs.status = 'running' OR ${inActive})`, `NOT ${supersededAttemptSql('jobs')}`]
      const params: unknown[] = [...active]
      if (opts.from) { where.push('jobs.started_at >= ?'); params.push(opts.from) }
      if (after) { const cond = afterSql('jobs.started_at', 'jobs.id', opts.projectId, after); where.push(cond.sql); params.push(...cond.params) }
      const rows = db.prepare(`
        SELECT jobs.*, jp.profile_name AS profile_name, NULL AS enqueued_at
        FROM jobs LEFT JOIN job_profiles jp ON jp.job_id = jobs.id
        WHERE ${where.join(' AND ')}
        ORDER BY jobs.started_at DESC, jobs.id ASC LIMIT ?
      `).all(...params, limit) as ListedJobRow[]
      for (const row of rows) out.push({ ...row, status: 'running', finished_at: active.includes(row.id) ? null : row.finished_at, projectId: opts.projectId, tier: 0, sortAt: String(row.started_at) })
    }
    if (status !== 'running') {
      const where: string[] = []
      const params: unknown[] = []
      if (opts.from) { where.push('enqueued_at >= ?'); params.push(opts.from) }
      if (after) { const cond = afterSql('enqueued_at', 'id', opts.projectId, after); where.push(cond.sql); params.push(...cond.params) }
      const rows = db.prepare(`
        ${QUEUED_SOURCE}
        SELECT * FROM queued_source ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY enqueued_at DESC, id ASC LIMIT ?
      `).all(...params, limit) as QueuedListRecord[]
      for (const row of rows) out.push({ ...toQueuedJobRow(row), projectId: opts.projectId, tier: 0, sortAt: row.enqueued_at })
    }
  }

  if (wantHistory) {
    const where = [`jobs.status NOT IN ('queued', 'running')`, `NOT ${inActive}`, `NOT ${supersededAttemptSql('jobs')}`]
    const params: unknown[] = [...active]
    if (status) { where.push('jobs.status = ?'); params.push(status) }
    if (opts.from) { where.push('jobs.started_at >= ?'); params.push(opts.from) }
    if (after && after.tier === 1) { const cond = afterSql('jobs.started_at', 'jobs.id', opts.projectId, after); where.push(cond.sql); params.push(...cond.params) }
    const rows = db.prepare(`
      SELECT jobs.*, jp.profile_name AS profile_name, NULL AS enqueued_at
      FROM jobs LEFT JOIN job_profiles jp ON jp.job_id = jobs.id
      WHERE ${where.join(' AND ')}
      ORDER BY jobs.started_at DESC, jobs.id ASC LIMIT ?
    `).all(...params, limit) as ListedJobRow[]
    for (const row of rows) out.push({ ...row, projectId: opts.projectId, tier: 1, sortAt: String(row.started_at) })
  }

  return out.sort((a, b) => compareRunSequence(keyOfRun(a), keyOfRun(b))).slice(0, limit)
}

export const keyOfRun = (run: Pick<SequencedRun, 'tier' | 'sortAt' | 'projectId' | 'id'>): RunSequenceKey => ({ tier: run.tier, at: run.sortAt, projectId: run.projectId, id: run.id })

export interface RunsSource {
  projectId: string
  db: DbInstance
  activeRuntimeIds?: () => readonly string[]
}

/**
 * One page of the app-wide run sequence over the given (already loaded)
 * projects: `limit + 1` rows from each, merged. Each project's read is bounded,
 * so the cost grows with projects × page size, never with history length. A
 * project whose database fails to answer is reported, not fatal.
 */
export function listRunsAcross(sources: readonly RunsSource[], opts: { limit: number; after?: RunSequenceKey | null; status?: string; from?: string }): { runs: SequencedRun[]; next: RunSequenceKey | null; failed: string[] } {
  const limit = Math.max(1, Math.min(opts.limit, 200))
  const all: SequencedRun[] = []
  const failed: string[] = []
  for (const source of sources) {
    try {
      all.push(...listRunsAfter(source.db, { projectId: source.projectId, limit: limit + 1, after: opts.after, status: opts.status, from: opts.from, activeRuntimeIds: source.activeRuntimeIds?.() ?? [] }))
    } catch {
      failed.push(source.projectId)
    }
  }
  all.sort((a, b) => compareRunSequence(keyOfRun(a), keyOfRun(b)))
  const runs = all.slice(0, limit)
  const next = all.length > limit && runs.length ? keyOfRun(runs[runs.length - 1]) : null
  return { runs, next, failed }
}
