import type { DbInstance } from '../../../db'
import type { SessionPhase, SubagentView, ToolActivity } from '../../agent-sessions'

/**
 * Desktop's projection of a mission's Core sessions (rebuildable from Core's
 * journal). A conversation owns its own session (id = conversation id) and,
 * while in Flow, the Flow's session (`flow:<flowId>`): every projection row is
 * keyed by (conversation, Core session) so their usage never mixes.
 */
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
  /** The Core session that launched it (the conversation id for the mission's own). */
  coreSessionId: string
}

export interface SubagentEventRow {
  seq: number
  channel: 'text' | 'tool'
  delta: string | null
  tool: ToolActivity | null
  createdAt: string
}

function mapCursor(row: Record<string, unknown>): SessionCursorRow {
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

/** The cursor of one Core session of a conversation (default: the mission's own). */
export function getSessionCursor(db: DbInstance, conversationId: string, coreSessionId: string = conversationId): SessionCursorRow | null {
  const row = db.prepare('SELECT * FROM agent_session_cursors WHERE conversation_id = ? AND core_session_id = ?').get(conversationId, coreSessionId) as Record<string, unknown> | undefined
  return row ? mapCursor(row) : null
}

/** Every Core session cursor of a conversation (mission first, then Flow sessions). */
export function listSessionCursors(db: DbInstance, conversationId: string): SessionCursorRow[] {
  return (db.prepare('SELECT * FROM agent_session_cursors WHERE conversation_id = ? ORDER BY (core_session_id = conversation_id) DESC, core_session_id').all(conversationId) as Record<string, unknown>[]).map(mapCursor)
}

const PHASE_RANK: Record<SessionPhase, number> = { idle: 0, background: 1, turn: 2 }

/**
 * One conversation's resident state across its Core sessions: the busiest
 * phase, any live process and the live sub-agents of all of them (a Flow's
 * sub-agents count as the mission's while it is in Flow). Null when none ran.
 */
export function conversationSessionState(db: DbInstance, conversationId: string): Pick<SessionCursorRow, 'residentPhase' | 'processAlive' | 'liveSubagents'> | null {
  const cursors = listSessionCursors(db, conversationId)
  if (cursors.length === 0) return null
  return {
    residentPhase: cursors.reduce<SessionPhase>((phase, cursor) => PHASE_RANK[cursor.residentPhase] > PHASE_RANK[phase] ? cursor.residentPhase : phase, 'idle'),
    processAlive: cursors.some((cursor) => cursor.processAlive),
    liveSubagents: cursors.reduce((sum, cursor) => sum + cursor.liveSubagents, 0),
  }
}

/** Conversations with a Core session that still has work in flight (non-idle or live sub-agents). */
export function listActiveSessionCursors(db: DbInstance): Array<Pick<SessionCursorRow, 'conversationId' | 'residentPhase' | 'processAlive' | 'liveSubagents'>> {
  const rows = db.prepare("SELECT DISTINCT conversation_id FROM agent_session_cursors WHERE resident_phase != 'idle' OR live_subagents > 0").all() as Array<{ conversation_id: string }>
  return rows.flatMap((row) => {
    const state = conversationSessionState(db, row.conversation_id)
    return state ? [{ conversationId: row.conversation_id, ...state }] : []
  })
}

export function ensureSessionCursor(db: DbInstance, conversationId: string, coreSessionId: string, scope: string): void {
  db.prepare(`INSERT INTO agent_session_cursors (conversation_id, core_session_id, scope) VALUES (?, ?, ?)
    ON CONFLICT(conversation_id, core_session_id) DO UPDATE SET scope = excluded.scope`).run(conversationId, coreSessionId, scope)
}

export function advanceSessionCursor(db: DbInstance, conversationId: string, seq: number, coreSessionId: string = conversationId): void {
  db.prepare("UPDATE agent_session_cursors SET last_seq = ?, updated_at = datetime('now') WHERE conversation_id = ? AND core_session_id = ?").run(seq, conversationId, coreSessionId)
}

export function setResidentState(db: DbInstance, conversationId: string, phase: SessionPhase, processAlive: boolean, liveSubagents: number, coreSessionId: string = conversationId): void {
  db.prepare("UPDATE agent_session_cursors SET resident_phase = ?, process_alive = ?, live_subagents = ?, updated_at = datetime('now') WHERE conversation_id = ? AND core_session_id = ?")
    .run(phase, processAlive ? 1 : 0, liveSubagents, conversationId, coreSessionId)
}

/**
 * Drop a mission's derived session rows so the journal can be replayed into
 * them. Messages and invocations stay: replay recognizes turns it already
 * recorded (see `coreTurnInvocationId`).
 */
export function resetSessionProjection(db: DbInstance, conversationId: string, coreSessionId: string = conversationId): void {
  db.transaction(() => {
    db.prepare('DELETE FROM agent_subagent_events WHERE conversation_id = ? AND subagent_id IN (SELECT subagent_id FROM agent_subagents WHERE conversation_id = ? AND core_session_id = ?)').run(conversationId, conversationId, coreSessionId)
    db.prepare('DELETE FROM agent_subagents WHERE conversation_id = ? AND core_session_id = ?').run(conversationId, coreSessionId)
    db.prepare("UPDATE agent_session_cursors SET last_seq = 0, resident_phase = 'idle', process_alive = 0, live_subagents = 0, updated_at = datetime('now') WHERE conversation_id = ? AND core_session_id = ?").run(conversationId, coreSessionId)
  })()
}

/** Deterministic invocation id of a Core turn: recording it twice is a no-op.
 *  A turn of another session of the conversation (Flow) carries its session id. */
export function coreTurnInvocationId(conversationId: string, turnId: string, coreSessionId: string = conversationId): string {
  return coreSessionId === conversationId ? `core-turn:${conversationId}:${turnId}` : `core-turn:${conversationId}:${coreSessionId}:${turnId}`
}

export function isCoreTurnRecorded(db: DbInstance, conversationId: string, turnId: string, coreSessionId: string = conversationId): boolean {
  return !!db.prepare('SELECT 1 FROM agent_invocations WHERE id = ?').get(coreTurnInvocationId(conversationId, turnId, coreSessionId))
    || !!db.prepare('SELECT 1 FROM agent_messages WHERE conversation_id = ? AND core_turn_id = ?').get(conversationId, turnId)
}

export function upsertSubagent(db: DbInstance, conversationId: string, view: SubagentView, coreSessionId: string = conversationId): void {
  db.prepare(`INSERT INTO agent_subagents (conversation_id, subagent_id, parent_id, kind, agent_type, description, phase, reason, restarts, launched_turn_id, started_at, ended_at, usage_json, tool_uses, duration_ms, result_summary, delegated_driver, delegated_model, core_session_id, updated_at)
    VALUES (@conversationId, @subagentId, @parentId, @kind, @agentType, @description, @phase, @reason, @restarts, @launchedInTurnId, @startedAt, @endedAt, @usage, @toolUses, @durationMs, @resultSummary, @delegatedDriver, @delegatedModel, @coreSessionId, datetime('now'))
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
    delegatedDriver: view.delegated?.driver ?? null,
    delegatedModel: view.delegated?.model ?? null,
    coreSessionId,
  })
}

export function appendSubagentEvent(db: DbInstance, conversationId: string, subagentId: string, seq: number, channel: 'text' | 'tool', delta: string | null, tool: ToolActivity | null): void {
  db.prepare('INSERT OR IGNORE INTO agent_subagent_events (conversation_id, subagent_id, seq, channel, delta, tool_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(conversationId, subagentId, seq, channel, delta, tool ? JSON.stringify(tool) : null)
}

function mapSubagent(row: Record<string, unknown>): SubagentRow {
  return {
    conversationId: String(row.conversation_id),
    coreSessionId: String(row.core_session_id ?? row.conversation_id),
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
    delegated: row.delegated_driver ? { driver: String(row.delegated_driver), model: String(row.delegated_model ?? '') } : null,
  }
}

/** Sub-agents of a conversation: all its Core sessions, or only `coreSessionId`'s. */
export function listSubagents(db: DbInstance, conversationId: string, coreSessionId?: string): SubagentRow[] {
  const rows = coreSessionId === undefined
    ? db.prepare('SELECT * FROM agent_subagents WHERE conversation_id = ? ORDER BY started_at, rowid').all(conversationId)
    : db.prepare('SELECT * FROM agent_subagents WHERE conversation_id = ? AND core_session_id = ? ORDER BY started_at, rowid').all(conversationId, coreSessionId)
  return (rows as Record<string, unknown>[]).map(mapSubagent)
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

// ── Mission Core session generations ─────────────────────────────────────────
// A Core session is bound to the driver that opened it. A mission that changes
// provider (or whose session Core closed) continues in a NEW session: gen 0
// keeps the historical id (the conversation id, compatible with existing
// journals), gen n is `<conversationId>:g<n>`.

export interface MissionCoreSessionRow {
  generation: number
  /** Driver the current generation was opened with; null = unknown (pre-generation sessions). */
  provider: string | null
}

export function missionCoreSessionId(conversationId: string, generation: number): string {
  return generation > 0 ? `${conversationId}:g${generation}` : conversationId
}

/** True for any generation of the mission's own session (never a Flow's). */
export function isMissionCoreSessionId(conversationId: string, sessionId: string): boolean {
  return sessionId === conversationId || new RegExp(`^${conversationId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:g\\d+$`).test(sessionId)
}

export function getMissionCoreSession(db: DbInstance, conversationId: string): MissionCoreSessionRow {
  const row = db.prepare('SELECT generation, provider FROM agent_core_sessions WHERE conversation_id = ?').get(conversationId) as { generation: number; provider: string | null } | undefined
  return row ? { generation: row.generation, provider: row.provider } : { generation: 0, provider: null }
}

/** Record the driver of the current generation (first turn of a session). */
export function setMissionCoreSessionProvider(db: DbInstance, conversationId: string, provider: string): void {
  db.prepare(`INSERT INTO agent_core_sessions (conversation_id, generation, provider) VALUES (?, 0, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET provider = excluded.provider, updated_at = datetime('now')`).run(conversationId, provider)
}

/** Move the mission to its next session generation, opened with `provider`. Returns the new row. */
export function renewMissionCoreSession(db: DbInstance, conversationId: string, provider: string): MissionCoreSessionRow {
  db.prepare(`INSERT INTO agent_core_sessions (conversation_id, generation, provider) VALUES (?, 1, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET generation = generation + 1, provider = excluded.provider, updated_at = datetime('now')`).run(conversationId, provider)
  return getMissionCoreSession(db, conversationId)
}
