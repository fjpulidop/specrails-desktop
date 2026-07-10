import { createHash } from 'crypto'
import type { DbInstance } from './db'

export const JOB_SPAWN_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000

export class JobSpawnIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used for a different spawn request')
    this.name = 'JobSpawnIdempotencyConflictError'
  }
}

/** Internal control-flow signal: another request already committed the exact
 * same logical spawn. Throwing from QueueManager's outer admission transaction
 * rolls the speculative queued_jobs row and in-memory job back before the route
 * returns the original id. */
export class JobSpawnIdempotencyReplayError extends Error {
  constructor(readonly jobId: string) {
    super('Idempotent spawn already admitted')
    this.name = 'JobSpawnIdempotencyReplayError'
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

/** Claim a key from INSIDE QueueManager's durable-admission transaction.
 * Existing matching keys throw Replay so the speculative queue admission rolls
 * back; mismatched keys throw Conflict; a new key is inserted atomically beside
 * queued_jobs before QueueManager is allowed to drain. */
export function claimIdempotentJob(
  db: DbInstance,
  key: string,
  fingerprint: string,
  jobId: string,
  nowMs = Date.now(),
): void {
  db.prepare('DELETE FROM job_spawn_requests WHERE expires_at_ms <= ?').run(nowMs)
  const row = db.prepare(
    'SELECT fingerprint, job_id FROM job_spawn_requests WHERE idempotency_key = ?',
  ).get(key) as SpawnRequestRow | undefined
  if (row) {
    if (row.fingerprint !== fingerprint) throw new JobSpawnIdempotencyConflictError()
    throw new JobSpawnIdempotencyReplayError(row.job_id)
  }
  rememberIdempotentJob(db, key, fingerprint, jobId, nowMs)
}
