import type { DbInstance } from '../../../db'
import type { SessionPhase, SubagentView, ToolActivity } from '../../agent-sessions'

/** Desktop's projection of a mission's Core session (rebuildable from Core's journal). */
export interface SessionCursorRow {
  conversationId: string
  coreSessionId: string
  scope: string
  lastSeq: number
  residentPhase: SessionPhase
  processAlive: boolean
  liveSubagents: number
}

export interface SubagentRow extends SubagentView {
  conversationId: string
}

export interface SubagentEventRow {
  seq: number
  channel: 'text' | 'tool'
  delta: string | null
  tool: ToolActivity | null
  createdAt: string
}

export function getSessionCursor(db: DbInstance, conversationId: string): SessionCursorRow | null {
  const row = db.prepare('SELECT * FROM agent_session_cursors WHERE conversation_id = ?').get(conversationId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    conversationId: String(row.conversation_id),
    coreSessionId: String(row.core_session_id),
    scope: String(row.scope),
    lastSeq: Number(row.last_seq),
    residentPhase: row.resident_phase as SessionPhase,
    processAlive: Number(row.process_alive) === 1,
    liveSubagents: Number(row.live_subagents),
  }
}

export function ensureSessionCursor(db: DbInstance, conversationId: string, coreSessionId: string, scope: string): void {
  db.prepare(`INSERT INTO agent_session_cursors (conversation_id, core_session_id, scope) VALUES (?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET core_session_id = excluded.core_session_id, scope = excluded.scope`).run(conversationId, coreSessionId, scope)
}

export function advanceSessionCursor(db: DbInstance, conversationId: string, seq: number): void {
  db.prepare("UPDATE agent_session_cursors SET last_seq = ?, updated_at = datetime('now') WHERE conversation_id = ?").run(seq, conversationId)
}

export function setResidentState(db: DbInstance, conversationId: string, phase: SessionPhase, processAlive: boolean, liveSubagents: number): void {
  db.prepare("UPDATE agent_session_cursors SET resident_phase = ?, process_alive = ?, live_subagents = ?, updated_at = datetime('now') WHERE conversation_id = ?")
    .run(phase, processAlive ? 1 : 0, liveSubagents, conversationId)
}

export function upsertSubagent(db: DbInstance, conversationId: string, view: SubagentView): void {
  db.prepare(`INSERT INTO agent_subagents (conversation_id, subagent_id, parent_id, kind, agent_type, description, phase, reason, restarts, launched_turn_id, started_at, ended_at, usage_json, tool_uses, duration_ms, result_summary, updated_at)
    VALUES (@conversationId, @subagentId, @parentId, @kind, @agentType, @description, @phase, @reason, @restarts, @launchedInTurnId, @startedAt, @endedAt, @usage, @toolUses, @durationMs, @resultSummary, datetime('now'))
    ON CONFLICT(conversation_id, subagent_id) DO UPDATE SET
      phase = excluded.phase, reason = excluded.reason, restarts = excluded.restarts, ended_at = excluded.ended_at,
      usage_json = excluded.usage_json, tool_uses = excluded.tool_uses, duration_ms = excluded.duration_ms,
      result_summary = excluded.result_summary, updated_at = excluded.updated_at`).run({
    conversationId,
    subagentId: view.subagentId,
    parentId: view.parentId,
    kind: view.kind,
    agentType: view.agentType,
    description: view.description,
    phase: view.phase,
    reason: view.reason,
    restarts: view.restarts,
    launchedInTurnId: view.launchedInTurnId,
    startedAt: view.startedAt,
    endedAt: view.endedAt,
    usage: view.usage ? JSON.stringify(view.usage) : null,
    toolUses: view.toolUses,
    durationMs: view.durationMs,
    resultSummary: view.resultSummary,
  })
}

export function appendSubagentEvent(db: DbInstance, conversationId: string, subagentId: string, seq: number, channel: 'text' | 'tool', delta: string | null, tool: ToolActivity | null): void {
  db.prepare('INSERT OR IGNORE INTO agent_subagent_events (conversation_id, subagent_id, seq, channel, delta, tool_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(conversationId, subagentId, seq, channel, delta, tool ? JSON.stringify(tool) : null)
}

function mapSubagent(row: Record<string, unknown>): SubagentRow {
  return {
    conversationId: String(row.conversation_id),
    subagentId: String(row.subagent_id),
    parentId: (row.parent_id as string | null) ?? null,
    kind: row.kind as SubagentView['kind'],
    agentType: (row.agent_type as string | null) ?? null,
    description: String(row.description),
    phase: row.phase as SubagentView['phase'],
    reason: (row.reason as string | null) ?? null,
    restarts: Number(row.restarts),
    startedAt: String(row.started_at),
    endedAt: (row.ended_at as string | null) ?? null,
    usage: row.usage_json ? JSON.parse(String(row.usage_json)) : null,
    toolUses: row.tool_uses === null ? null : Number(row.tool_uses),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    resultSummary: (row.result_summary as string | null) ?? null,
    launchedInTurnId: (row.launched_turn_id as string | null) ?? null,
  }
}

export function listSubagents(db: DbInstance, conversationId: string): SubagentRow[] {
  return (db.prepare('SELECT * FROM agent_subagents WHERE conversation_id = ? ORDER BY started_at, rowid').all(conversationId) as Record<string, unknown>[]).map(mapSubagent)
}

export function pageSubagentEvents(db: DbInstance, conversationId: string, subagentId: string, afterSeq: number, limit: number): { events: SubagentEventRow[]; hasMore: boolean } {
  const rows = db.prepare('SELECT seq, channel, delta, tool_json, created_at FROM agent_subagent_events WHERE conversation_id = ? AND subagent_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(conversationId, subagentId, afterSeq, limit + 1) as Array<Record<string, unknown>>
  return {
    events: rows.slice(0, limit).map((row) => ({
      seq: Number(row.seq),
      channel: row.channel as 'text' | 'tool',
      delta: (row.delta as string | null) ?? null,
      tool: row.tool_json ? JSON.parse(String(row.tool_json)) as ToolActivity : null,
      createdAt: String(row.created_at),
    })),
    hasMore: rows.length > limit,
  }
}
