import { createHash } from 'crypto'
import type { DbInstance } from './db'

export const JOB_SPAWN_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000

export class JobSpawnIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used for a different spawn request')
    this.name = 'JobSpawnIdempotencyConflictError'
  }
}

interface SpawnRequestRow {
  fingerprint: string
  job_id: string
}

/** Hash a canonical, route-owned payload so the ledger never has to duplicate
 * the command text already stored in jobs. Callers must construct object keys
 * in a stable order. */
export function fingerprintJobSpawn(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/** Return the original job for an unexpired matching request. Reusing a key
 * with different semantics is a client error, never permission to enqueue. */
export function findIdempotentJob(
  db: DbInstance,
  key: string,
  fingerprint: string,
  nowMs = Date.now(),
): string | null {
  return db.transaction(() => {
    db.prepare('DELETE FROM job_spawn_requests WHERE expires_at_ms <= ?').run(nowMs)
    const row = db.prepare(
      'SELECT fingerprint, job_id FROM job_spawn_requests WHERE idempotency_key = ?'
    ).get(key) as SpawnRequestRow | undefined
    if (!row) return null
    if (row.fingerprint !== fingerprint) throw new JobSpawnIdempotencyConflictError()
    return row.job_id
  })()
}

export function rememberIdempotentJob(
  db: DbInstance,
  key: string,
  fingerprint: string,
  jobId: string,
  nowMs = Date.now(),
): void {
  db.prepare(
    `INSERT INTO job_spawn_requests
       (idempotency_key, fingerprint, job_id, created_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?)`
  ).run(key, fingerprint, jobId, nowMs, nowMs + JOB_SPAWN_IDEMPOTENCY_TTL_MS)
}
