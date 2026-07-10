import type { JobSummary } from '../types'

/** Queue admission orders queued work; execution start orders every other job.
 * Never substitute enqueued_at for a non-queued row or present it as runtime. */
export function jobActivityTimestamp(
  job: Pick<JobSummary, 'status' | 'started_at' | 'enqueued_at'>,
): string | null {
  return job.status === 'queued' ? (job.enqueued_at ?? null) : job.started_at
}

/** SQLite datetime('now') uses `YYYY-MM-DD HH:mm:ss` UTC. Make that timezone
 * explicit before handing it to Date so browsers do not reinterpret it locally. */
export function parseJobTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}
