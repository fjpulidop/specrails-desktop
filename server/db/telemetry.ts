import type { DbInstance } from './types'

// ─── Telemetry DB functions ───────────────────────────────────────────────────

export interface TelemetryBlobRow {
  jobId: string
  path: string | null
  byteSize: number
  startedAt: number | null
  endedAt: number | null
  state: 'active' | 'compacted' | 'expired'
}

export interface TelemetrySummaryRow {
  jobId: string
  phase: string
  durationMs: number | null
  tokensInput: number | null
  tokensOutput: number | null
  tokensCache: number | null
  toolCalls: string | null
  apiErrors: number | null
  costUsd: number | null
}

export function getTelemetryBlob(db: DbInstance, jobId: string): TelemetryBlobRow | undefined {
  return db.prepare('SELECT * FROM telemetry_blobs WHERE jobId = ?').get(jobId) as TelemetryBlobRow | undefined
}

export function upsertTelemetryBlob(db: DbInstance, row: TelemetryBlobRow): void {
  db.prepare(`
    INSERT INTO telemetry_blobs (jobId, path, byteSize, startedAt, endedAt, state)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(jobId) DO UPDATE SET
      path = excluded.path,
      byteSize = excluded.byteSize,
      startedAt = COALESCE(telemetry_blobs.startedAt, excluded.startedAt),
      endedAt = excluded.endedAt,
      state = excluded.state
  `).run(row.jobId, row.path ?? null, row.byteSize, row.startedAt ?? null, row.endedAt ?? null, row.state)
}

export function listActiveTelemetryBlobs(db: DbInstance): TelemetryBlobRow[] {
  return db.prepare(
    `SELECT * FROM telemetry_blobs WHERE state = 'active'`
  ).all() as TelemetryBlobRow[]
}

export function setTelemetryBlobCompacted(db: DbInstance, jobId: string): void {
  db.prepare(
    `UPDATE telemetry_blobs SET state = 'compacted', path = NULL WHERE jobId = ?`
  ).run(jobId)
}

export function insertTelemetrySummary(db: DbInstance, row: TelemetrySummaryRow): void {
  db.prepare(`
    INSERT OR REPLACE INTO telemetry_summaries
      (jobId, phase, durationMs, tokensInput, tokensOutput, tokensCache, toolCalls, apiErrors, costUsd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.jobId, row.phase,
    row.durationMs ?? null, row.tokensInput ?? null, row.tokensOutput ?? null,
    row.tokensCache ?? null, row.toolCalls ?? null, row.apiErrors ?? null, row.costUsd ?? null
  )
}

export function getTelemetrySummaries(db: DbInstance, jobId: string): TelemetrySummaryRow[] {
  return db.prepare('SELECT * FROM telemetry_summaries WHERE jobId = ?').all(jobId) as TelemetrySummaryRow[]
}

export function deleteTelemetryForJob(db: DbInstance, jobId: string): void {
  db.prepare('DELETE FROM telemetry_blobs WHERE jobId = ?').run(jobId)
  db.prepare('DELETE FROM telemetry_summaries WHERE jobId = ?').run(jobId)
}

/** Returns a Set of jobIds that have active or compacted telemetry blobs. */
export function getJobsWithTelemetry(db: DbInstance): Set<string> {
  const rows = db.prepare(
    `SELECT jobId FROM telemetry_blobs WHERE state IN ('active','compacted')`
  ).all() as Array<{ jobId: string }>
  return new Set(rows.map((r) => r.jobId))
}

/** True iff the job has an active or compacted telemetry blob row. */
export function hasJobTelemetry(db: DbInstance, jobId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM telemetry_blobs WHERE jobId = ? AND state IN ('active','compacted') LIMIT 1`
  ).get(jobId)
  return row !== undefined
}
