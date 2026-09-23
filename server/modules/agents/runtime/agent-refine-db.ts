import type { DbInstance } from '../../../db'

export type RefinePhase =
  | 'idle'
  | 'reading'
  | 'drafting'
  | 'validating'
  | 'testing'
  | 'done'

export type RefineStatus =
  | 'idle'
  | 'streaming'
  | 'ready'
  | 'applied'
  | 'cancelled'
  | 'error'

export interface RefineHistoryTurn {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** Optional kind tag for system turns (e.g. 'test_result'). */
  kind?: string
  timestamp: number
}

export interface RefineSessionRow {
  id: string
  agent_id: string
  session_id: string | null
  base_version: number
  base_body_hash: string
  draft_body: string | null
  history: RefineHistoryTurn[]
  phase: RefinePhase
  status: RefineStatus
  auto_test: 0 | 1
  last_test_at: number | null
  last_test_hash: string | null
  created_at: number
  updated_at: number
}

interface RawRow {
  id: string
  agent_id: string
  session_id: string | null
  base_version: number
  base_body_hash: string
  draft_body: string | null
  history_json: string
  phase: string
  status: string
  auto_test: number
  last_test_at: number | null
  last_test_hash: string | null
  created_at: number
  updated_at: number
}

function rowToSession(row: RawRow): RefineSessionRow {
  let history: RefineHistoryTurn[] = []
  try {
    const parsed = JSON.parse(row.history_json)
    if (Array.isArray(parsed)) history = parsed as RefineHistoryTurn[]
  } catch {
    // corrupted — start fresh
  }
  return {
    id: row.id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    base_version: row.base_version,
    base_body_hash: row.base_body_hash,
    draft_body: row.draft_body,
    history,
    phase: row.phase as RefinePhase,
    status: row.status as RefineStatus,
    auto_test: row.auto_test === 0 ? 0 : 1,
    last_test_at: row.last_test_at,
    last_test_hash: row.last_test_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export interface CreateRefineSessionInput {
  id: string
  agentId: string
  baseVersion: number
  baseBodyHash: string
  autoTest: boolean
}

export function createRefineSession(db: DbInstance, input: CreateRefineSessionInput): RefineSessionRow {
  const now = Date.now()
  db.prepare(
    `INSERT INTO agent_refine_sessions
      (id, agent_id, session_id, base_version, base_body_hash, draft_body,
       history_json, phase, status, auto_test, last_test_at, last_test_hash,
       created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, NULL, '[]', 'idle', 'idle', ?, NULL, NULL, ?, ?)`,
  ).run(input.id, input.agentId, input.baseVersion, input.baseBodyHash, input.autoTest ? 1 : 0, now, now)
  return getRefineSession(db, input.id)!
}

export function getRefineSession(db: DbInstance, id: string): RefineSessionRow | undefined {
  const row = db
    .prepare(`SELECT * FROM agent_refine_sessions WHERE id = ?`)
    .get(id) as RawRow | undefined
  if (!row) return undefined
  return rowToSession(row)
}

export function listRefineSessionsForAgent(db: DbInstance, agentId: string): RefineSessionRow[] {
  const rows = db
    .prepare(`SELECT * FROM agent_refine_sessions WHERE agent_id = ? ORDER BY updated_at DESC`)
    .all(agentId) as RawRow[]
  return rows.map(rowToSession)
}

export interface UpdateRefineSessionPatch {
  session_id?: string | null
  draft_body?: string | null
  history?: RefineHistoryTurn[]
  phase?: RefinePhase
  status?: RefineStatus
  auto_test?: 0 | 1
  last_test_at?: number | null
  last_test_hash?: string | null
}

export function updateRefineSession(db: DbInstance, id: string, patch: UpdateRefineSessionPatch): void {
  const fields: string[] = []
  const values: unknown[] = []
  if (Object.prototype.hasOwnProperty.call(patch, 'session_id')) {
    fields.push('session_id = ?')
    values.push(patch.session_id)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'draft_body')) {
    fields.push('draft_body = ?')
    values.push(patch.draft_body)
  }
  if (patch.history !== undefined) {
    fields.push('history_json = ?')
    values.push(JSON.stringify(patch.history))
  }
  if (patch.phase !== undefined) {
    fields.push('phase = ?')
    values.push(patch.phase)
  }
  if (patch.status !== undefined) {
    fields.push('status = ?')
    values.push(patch.status)
  }
  if (patch.auto_test !== undefined) {
    fields.push('auto_test = ?')
    values.push(patch.auto_test)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'last_test_at')) {
    fields.push('last_test_at = ?')
    values.push(patch.last_test_at)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'last_test_hash')) {
    fields.push('last_test_hash = ?')
    values.push(patch.last_test_hash)
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)
  db.prepare(`UPDATE agent_refine_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteRefineSession(db: DbInstance, id: string): void {
  db.prepare(`DELETE FROM agent_refine_sessions WHERE id = ?`).run(id)
}

/**
 * Startup retention prune (per design D11):
 * - Delete cancelled/error sessions older than 24h
 * - Mark stuck streaming sessions (>24h since update) as error, then delete
 * - Retain ready/applied sessions indefinitely
 *
 * Returns the number of rows removed.
 */
export function pruneStaleRefineSessions(db: DbInstance, now: number = Date.now()): number {
  const cutoff = now - 24 * 60 * 60 * 1000

  // Mark stuck streaming sessions as error first so any UI rehydrates with a
  // sane state. Preserve `updated_at` so the DELETE below still matches them.
  db.prepare(
    `UPDATE agent_refine_sessions
     SET status = 'error'
     WHERE status = 'streaming' AND updated_at < ?`,
  ).run(cutoff)

  const res = db
    .prepare(
      `DELETE FROM agent_refine_sessions
       WHERE status IN ('cancelled', 'error', 'idle') AND updated_at < ?`,
    )
    .run(cutoff)

  return Number(res.changes ?? 0)
}
