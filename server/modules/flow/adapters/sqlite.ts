import type { DbInstance } from '../../../db/types'
import { FlowConflictError, type FlowEffectStatus, type FlowSession, type FlowSettlementEffect, type FlowSettlementKind, type FlowState, type FlowStep } from '../domain'
import type { FlowEffectsStore, FlowRepository } from '../ports'

/** `flow_sessions` row (migration 74, project database). */
interface FlowSessionRow {
  id: string
  conversation_id: string
  ticket_id: number | null
  state: string
  branch: string | null
  worktree_path: string | null
  base_sha: string | null
  head_sha: string | null
  core_session_id: string | null
  rail_index: number | null
  delivery_id: string | null
  step: string | null
  created_at: string
  updated_at: string
}

function toSession(row: FlowSessionRow): FlowSession {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    ticketId: row.ticket_id,
    state: row.state as FlowState,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    coreSessionId: row.core_session_id,
    railIndex: row.rail_index,
    deliveryId: row.delivery_id,
    step: row.step as FlowStep | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function params(session: FlowSession): unknown[] {
  return [
    session.conversationId, session.ticketId, session.state, session.branch, session.worktreePath,
    session.baseSha, session.headSha, session.coreSessionId, session.railIndex, session.deliveryId,
    session.step, session.createdAt, session.updatedAt, session.id,
  ]
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || /UNIQUE constraint failed/i.test(String((error as Error)?.message))
}

/** Repository bound to ONE project connection (project isolation). */
export function createSqliteFlowRepository(db: DbInstance): FlowRepository {
  const select = (where: string, ...args: unknown[]): FlowSession | null => {
    const row = db.prepare(`SELECT * FROM flow_sessions WHERE ${where}`).get(...args) as FlowSessionRow | undefined
    return row ? toSession(row) : null
  }
  return {
    insert(session) {
      try {
        db.prepare(`INSERT INTO flow_sessions (conversation_id, ticket_id, state, branch, worktree_path, base_sha, head_sha,
          core_session_id, rail_index, delivery_id, step, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...params(session))
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        const open = select(`conversation_id = ? AND state IN ('active','paused')`, session.conversationId)
        throw new FlowConflictError('flow_already_open', 'This conversation already has a Flow; resume or discard it first', open?.id ?? session.id)
      }
    },
    save(session) {
      const result = db.prepare(`UPDATE flow_sessions SET conversation_id = ?, ticket_id = ?, state = ?, branch = ?, worktree_path = ?,
        base_sha = ?, head_sha = ?, core_session_id = ?, rail_index = ?, delivery_id = ?, step = ?, created_at = ?, updated_at = ?
        WHERE id = ?`).run(...params(session))
      if (result.changes === 0) throw new Error(`Flow ${session.id} does not exist`)
    },
    get: (flowId) => select('id = ?', flowId),
    findOpenByConversation: (conversationId) => select(`conversation_id = ? AND state IN ('active','paused')`, conversationId),
    latestByConversation: (conversationId) => select('conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', conversationId),
    listUnsettled() {
      const rows = db.prepare(`SELECT * FROM flow_sessions WHERE state IN ('active','paused') OR step IS NOT NULL ORDER BY created_at`).all() as FlowSessionRow[]
      return rows.map(toSession)
    },
    listHandedOff() {
      const rows = db.prepare(`SELECT * FROM flow_sessions WHERE state = 'handed_off' ORDER BY created_at`).all() as FlowSessionRow[]
      return rows.map(toSession)
    },
    findByDelivery: (deliveryId) => select('delivery_id = ? ORDER BY created_at DESC LIMIT 1', deliveryId),
  }
}

/** `flow_effects` row (migration 75, project database). */
interface FlowEffectRow {
  effect_key: string
  flow_id: string
  kind: string
  seq: number
  status: string
  attempts: number
  last_error: string | null
  note: string | null
  next_attempt_at: string | null
  created_at: string
  updated_at: string
}

function toEffect(row: FlowEffectRow): FlowSettlementEffect {
  return {
    key: row.effect_key, flowId: row.flow_id, kind: row.kind as FlowSettlementKind, seq: row.seq,
    status: row.status as FlowEffectStatus, attempts: row.attempts, lastError: row.last_error, note: row.note,
    nextAttemptAt: row.next_attempt_at, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

/** Settlement effects bound to ONE project connection. */
export function createSqliteFlowEffectsStore(db: DbInstance): FlowEffectsStore {
  return {
    enqueue(effects) {
      const insert = db.prepare(`INSERT OR IGNORE INTO flow_effects (effect_key, flow_id, kind, seq, status, attempts, last_error, note,
        next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      db.transaction(() => {
        for (const e of effects) insert.run(e.key, e.flowId, e.kind, e.seq, e.status, e.attempts, e.lastError, e.note, e.nextAttemptAt, e.createdAt, e.updatedAt)
      })()
    },
    list(flowId) {
      return (db.prepare(`SELECT * FROM flow_effects WHERE flow_id = ? ORDER BY seq`).all(flowId) as FlowEffectRow[]).map(toEffect)
    },
    save(e) {
      db.prepare(`UPDATE flow_effects SET status = ?, attempts = ?, last_error = ?, note = ?, next_attempt_at = ?, updated_at = ?
        WHERE effect_key = ?`).run(e.status, e.attempts, e.lastError, e.note, e.nextAttemptAt, e.updatedAt, e.key)
    },
    pendingFlowIds() {
      return (db.prepare(`SELECT DISTINCT flow_id FROM flow_effects WHERE status = 'pending' ORDER BY flow_id`).all() as Array<{ flow_id: string }>).map((row) => row.flow_id)
    },
  }
}
