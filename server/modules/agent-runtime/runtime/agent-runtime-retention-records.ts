import type { DbInstance } from '../../../db'
import { validateRuntimeRetentionPolicy, type RuntimeRetentionPolicy } from './agent-runtime-retention'

export interface RuntimeExpirationRecord {
  runId: string
  expiredAt: string
  disposition: 'settled' | 'discarded'
  previousStatus: string
  quarantineToken: string
  summary: Record<string, unknown>
}
export function readRuntimeExpiration(db: DbInstance, runId: string): RuntimeExpirationRecord | null {
  const row = db.prepare('SELECT * FROM runtime_retention_records WHERE run_id=?').get(runId) as {
    run_id: string; expired_at: string; disposition: 'settled' | 'discarded'; previous_status: string; quarantine_token: string; summary_json: string
  } | undefined
  return row ? { runId: row.run_id, expiredAt: row.expired_at, disposition: row.disposition, previousStatus: row.previous_status, quarantineToken: row.quarantine_token, summary: JSON.parse(row.summary_json) } : null
}
export function recordRuntimeExpiration(db: DbInstance, value: RuntimeExpirationRecord): void {
  db.transaction(() => {
    const previous = readRuntimeExpiration(db, value.runId)
    if (previous) {
      if (previous.quarantineToken !== value.quarantineToken) throw new Error('Runtime expiration identity changed')
      return
    }
    db.prepare('INSERT INTO runtime_retention_records(run_id,expired_at,disposition,previous_status,quarantine_token,summary_json) VALUES (?,?,?,?,?,?)')
      .run(value.runId, value.expiredAt, value.disposition, value.previousStatus, value.quarantineToken, JSON.stringify(value.summary))
  }).immediate()
}
export function readRuntimeRetentionPolicy(db: DbInstance): RuntimeRetentionPolicy {
  const row = db.prepare('SELECT days FROM runtime_retention_policy WHERE id=1').get() as { days: number | null } | undefined
  return row ? validateRuntimeRetentionPolicy(row) : { days: null }
}
export function saveRuntimeRetentionPolicy(db: DbInstance, value: unknown): RuntimeRetentionPolicy {
  const policy = validateRuntimeRetentionPolicy(value)
  db.prepare('INSERT INTO runtime_retention_policy(id,days) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET days=excluded.days').run(policy.days)
  return policy
}
