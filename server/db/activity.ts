import type { DbInstance } from './types'
import type { JobRow, ActivityItem } from '../types'

// ─── Activity feed ────────────────────────────────────────────────────────────

export interface ActivityQueryOpts {
  limit: number
  before?: string
}

export function getProjectActivity(db: DbInstance, opts: ActivityQueryOpts): ActivityItem[] {
  const limit = Math.min(opts.limit, 100)
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.before) {
    conditions.push('started_at < ?')
    params.push(opts.before)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const jobs = db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, limit) as JobRow[]

  return jobs.map((j) => {
    const isTerminal = j.status === 'completed' || j.status === 'failed' || j.status === 'canceled' || j.status === 'zombie_terminated'
    const type: ActivityItem['type'] =
      j.status === 'completed' ? 'job_completed'
      : j.status === 'failed' ? 'job_failed'
      : (j.status === 'canceled' || j.status === 'zombie_terminated') ? 'job_canceled'
      : 'job_started'
    const timestamp = isTerminal && j.finished_at ? j.finished_at : j.started_at
    const shortCmd = j.command.length > 60 ? j.command.slice(0, 57) + '...' : j.command
    const summary =
      type === 'job_started' ? `Job started: ${shortCmd}`
      : type === 'job_completed' ? `Job completed: ${shortCmd}`
      : type === 'job_failed' ? `Job failed: ${shortCmd}`
      : j.status === 'zombie_terminated' ? `Job auto-terminated (zombie): ${shortCmd}`
      : `Job canceled: ${shortCmd}`
    return {
      id: j.id,
      type,
      jobId: j.id,
      jobCommand: j.command,
      timestamp,
      summary,
      costUsd: isTerminal ? (j.total_cost_usd ?? null) : null,
    }
  })
}
