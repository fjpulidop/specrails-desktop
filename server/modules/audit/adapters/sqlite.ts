import type { DbInstance } from '../../../db/types'
import { emptyAgentActionCounts, isAgentActionKind, type AgentActionCounts, type AgentActionRecord, type AgentActionRow } from '../domain'
import type { AgentActionStore } from '../ports'

interface StoredRow {
  id: number
  run_id: string
  job_id: string | null
  role: string
  kind: string
  target: string
  hash: string | null
  ts: string
  source: string
}

function toRecord(row: StoredRow): AgentActionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    role: row.role,
    kind: isAgentActionKind(row.kind) ? row.kind : 'read',
    target: row.target,
    hash: row.hash,
    ts: row.ts,
    source: row.source,
  }
}

const COLUMNS = 'id, run_id, job_id, role, kind, target, hash, ts, source'

/** SQLite store bound to ONE project connection. Batches are one transaction
 * (one WAL commit per flush, not one per action). */
export function createSqliteAgentActionStore(db: DbInstance): AgentActionStore {
  const insertMany = db.transaction((rows: readonly AgentActionRow[]) => {
    const insert = db.prepare<unknown[]>('INSERT INTO agent_actions (run_id, job_id, role, kind, target, hash, ts, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of rows) insert.run(row.runId, row.jobId, row.role, row.kind, row.target, row.hash, row.ts, row.source)
  })
  return {
    insertMany(rows) {
      if (rows.length > 0) insertMany(rows)
    },
    listByRun(runId, limit) {
      return (db.prepare(`
        SELECT ${COLUMNS} FROM agent_actions
         WHERE run_id = ? OR job_id = ?
         ORDER BY ts ASC, id ASC LIMIT ?
      `).all(runId, runId, limit) as StoredRow[]).map(toRecord)
    },
    listWindow({ from, to, limit }) {
      const conditions: string[] = []
      const params: unknown[] = []
      if (from) { conditions.push('ts >= ?'); params.push(from) }
      if (to) { conditions.push('ts <= ?'); params.push(to) }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      return (db.prepare(`SELECT ${COLUMNS} FROM agent_actions ${where} ORDER BY ts ASC, id ASC LIMIT ?`).all(...params, limit) as StoredRow[]).map(toRecord)
    },
    countByKind(runIds) {
      const counts: AgentActionCounts = emptyAgentActionCounts()
      const ids = [...new Set(runIds.filter(id => typeof id === 'string' && id.length > 0))]
      if (ids.length === 0) return counts
      const placeholders = ids.map(() => '?').join(', ')
      const rows = db.prepare(`
        SELECT kind, COUNT(*) AS n FROM agent_actions
         WHERE run_id IN (${placeholders}) OR job_id IN (${placeholders})
         GROUP BY kind
      `).all(...ids, ...ids) as Array<{ kind: string; n: number }>
      for (const row of rows) if (isAgentActionKind(row.kind)) counts[row.kind] = row.n
      return counts
    },
    deleteBefore(cutoffIso) {
      return Number(db.prepare('DELETE FROM agent_actions WHERE ts < ?').run(cutoffIso).changes)
    },
  }
}
