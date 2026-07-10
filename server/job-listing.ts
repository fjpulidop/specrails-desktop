import type { DbInstance } from './db'
import type { JobPriority, JobRow } from './types'

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
  from?: string
  to?: string
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
  if (opts.status) {
    conditions.push('jobs.status = ?')
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
      historyRows = db.prepare(`
        SELECT jobs.*, jp.profile_name AS profile_name, NULL AS enqueued_at
        FROM jobs
        LEFT JOIN job_profiles jp ON jp.job_id = jobs.id
        ${history.sql}
        ORDER BY jobs.started_at DESC, jobs.id ASC
        LIMIT ? OFFSET ?
      `).all(...history.params, remaining, historyOffset) as ListedJobRow[]
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
