import { randomUUID } from 'crypto'
import type { DbInstance } from './db'
import { normalizeLevel, type AgentTierLevel } from './agent-tier'

// ─── App-global agent chat persistence (design D2) ────────────────────────────
//
// CRUD over the `agent_conversations` / `agent_messages` tables in desktop.sqlite
// (migration 17). The agent chat is NOT owned by any project, so it never touches
// a per-project jobs.sqlite. `pinned_project_id` is the selector target
// (null = Home); `tier_level` is the Shift+Tab ladder level.

export interface AgentConversation {
  id: string
  title: string | null
  provider: string
  model: string | null
  session_id: string | null
  pinned_project_id: string | null
  tier_level: AgentTierLevel
  created_at: string
  updated_at: string
}

export interface AgentMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

interface AgentConversationRaw {
  id: string
  title: string | null
  provider: string
  model: string | null
  session_id: string | null
  pinned_project_id: string | null
  tier_level: number
  created_at: string
  updated_at: string
}

function mapConversation(row: AgentConversationRaw | undefined): AgentConversation | undefined {
  if (!row) return undefined
  return { ...row, tier_level: normalizeLevel(row.tier_level) }
}

export function createAgentConversation(
  db: DbInstance,
  input: { provider?: string; model?: string | null; pinnedProjectId?: string | null; tierLevel?: AgentTierLevel } = {},
): AgentConversation {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO agent_conversations (id, provider, model, pinned_project_id, tier_level)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.provider ?? 'claude',
    input.model ?? null,
    input.pinnedProjectId ?? null,
    input.tierLevel ?? 0,
  )
  return getAgentConversation(db, id)!
}

export function getAgentConversation(db: DbInstance, id: string): AgentConversation | undefined {
  return mapConversation(
    db.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(id) as AgentConversationRaw | undefined,
  )
}

export function listAgentConversations(db: DbInstance, limit = 100): AgentConversation[] {
  return (
    db
      .prepare('SELECT * FROM agent_conversations ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as AgentConversationRaw[]
  ).map((r) => mapConversation(r)!)
}

/** Patch a conversation. Only the provided fields change; `updated_at` always bumps. */
export function updateAgentConversation(
  db: DbInstance,
  id: string,
  patch: Partial<{
    title: string | null
    provider: string
    model: string | null
    session_id: string | null
    pinned_project_id: string | null
    tier_level: AgentTierLevel
  }>,
): AgentConversation | undefined {
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`)
    vals.push(v)
  }
  sets.push("updated_at = datetime('now')")
  if (sets.length > 0) {
    db.prepare(`UPDATE agent_conversations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  }
  return getAgentConversation(db, id)
}

export function deleteAgentConversation(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM agent_conversations WHERE id = ?').run(id)
}

export function addAgentMessage(
  db: DbInstance,
  input: { conversationId: string; role: 'user' | 'assistant'; content: string },
): AgentMessage {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO agent_messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
  ).run(id, input.conversationId, input.role, input.content)
  // Touch the parent so the list stays ordered by latest activity.
  db.prepare("UPDATE agent_conversations SET updated_at = datetime('now') WHERE id = ?").run(input.conversationId)
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessage
}

export function listAgentMessages(db: DbInstance, conversationId: string): AgentMessage[] {
  return db
    .prepare('SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(conversationId) as AgentMessage[]
}
