import type { DbInstance } from '../../../db'
import type { AllocatedRun, SettledRun } from './rail-isolated-launch'

export interface IsolatedSettlementSnapshot {
  version: 1
  projectId: string
  deliveryId: string
  baseRepo: string
  overlaySourceRoot: string
  overlayFallbackRoots?: string[]
  overlayProviderDir: string
  overlayInstructions: string
  commitMessage: string
  partialCommitMessage: string
  run: AllocatedRun
}
export interface IsolatedSettlementRecord {
  snapshot: IsolatedSettlementSnapshot
  result: SettledRun | null
}

/** Admission is immutable. Restart must not adopt today's settings or ownership. */
export function saveIsolatedSettlementSnapshot(db: DbInstance, snapshot: IsolatedSettlementSnapshot): void {
  const json = JSON.stringify(snapshot)
  db.transaction(() => {
    const prior = db.prepare('SELECT snapshot_json FROM definition_delivery_settlements WHERE delivery_id=? AND run_id=?')
      .get(snapshot.deliveryId, snapshot.run.runId) as { snapshot_json: string } | undefined
    if (prior) {
      if (prior.snapshot_json !== json) throw new Error('Frozen isolated settlement cannot change')
      return
    }
    db.prepare('INSERT INTO definition_delivery_settlements(delivery_id,run_id,project_id,snapshot_json) VALUES (?,?,?,?)')
      .run(snapshot.deliveryId, snapshot.run.runId, snapshot.projectId, json)
  })()
}

export function readIsolatedSettlementRecords(db: DbInstance, projectId: string, deliveryId: string): IsolatedSettlementRecord[] {
  const rows = db.prepare('SELECT run_id,snapshot_json,result_json FROM definition_delivery_settlements WHERE project_id=? AND delivery_id=? AND superseded_by IS NULL ORDER BY created_at,run_id')
    .all(projectId, deliveryId) as Array<{ run_id: string; snapshot_json: string; result_json: string | null }>
  return rows.map(row => {
    const snapshot = JSON.parse(row.snapshot_json) as IsolatedSettlementSnapshot
    if (snapshot.version !== 1 || snapshot.projectId !== projectId || snapshot.deliveryId !== deliveryId || snapshot.run?.runId !== row.run_id) throw new Error('Isolated settlement identity is inconsistent')
    const result = row.result_json ? JSON.parse(row.result_json) as SettledRun : null
    if (result && result.run?.runId !== row.run_id) throw new Error('Isolated settlement result belongs to another run')
    return { snapshot, result }
  })
}

export function saveIsolatedSettlementResult(db: DbInstance, deliveryId: string, result: SettledRun): void {
  const update = db.prepare("UPDATE definition_delivery_settlements SET result_json=?,updated_at=datetime('now') WHERE delivery_id=? AND run_id=?")
    .run(JSON.stringify(result), deliveryId, result.run.runId)
  if (update.changes !== 1) throw new Error('Frozen isolated settlement is missing')
}

/** The provenance row batch and receipt share the project transaction. */
export function recordIsolatedProvenanceOnce(db: DbInstance, deliveryId: string, runId: string, record: () => void): void {
  db.transaction(() => {
    const row = db.prepare('SELECT provenance_recorded FROM definition_delivery_settlements WHERE delivery_id=? AND run_id=?')
      .get(deliveryId, runId) as { provenance_recorded: number } | undefined
    if (!row) throw new Error('Frozen isolated settlement is missing')
    if (row.provenance_recorded) return
    record()
    db.prepare('UPDATE definition_delivery_settlements SET provenance_recorded=1 WHERE delivery_id=? AND run_id=?').run(deliveryId, runId)
  })()
}
