import type { JobAccountingInput } from './job-accounting'

export type JobUsage = JobAccountingInput['result']

export function sanitizeRecoveredResult<T extends JobUsage>(result: T): T {
  const safe = { ...result }
  const numeric: Array<keyof JobUsage> = [
    'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_create',
    'total_cost_usd', 'num_turns', 'duration_ms', 'duration_api_ms',
  ]
  for (const key of numeric) {
    const value = safe[key]
    if (value !== undefined && (
      typeof value !== 'number' || !Number.isFinite(value) || value < 0
    )) {
      delete safe[key]
    }
  }
  if (safe.model !== undefined && typeof safe.model !== 'string') delete safe.model
  if (safe.session_id !== undefined && typeof safe.session_id !== 'string') delete safe.session_id
  return safe
}
