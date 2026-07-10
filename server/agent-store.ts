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
  /** Reasoning effort for spawns (null = default "medium"). Validated against
   *  the provider's `capabilities.reasoningEfforts` at the router. */
  reasoning_effort: string | null
  created_at: string
  updated_at: string
}

/** `system` rows are app-authored inline cards (e.g. the PR-decision card),
 *  never AI turns — the DB column is unconstrained TEXT, so this is TS-only. */
export type AgentMessageRole = 'user' | 'assistant' | 'system'

export interface AgentMessage {
  id: string
  conversation_id: string
  role: AgentMessageRole
  content: string
  /** Attachment ids carried by this (user) turn; [] for text-only turns. */
  attachment_ids: string[]
  /** Structured refs selected in the composer; [] when the turn has none. */
  context_refs: AgentMessageContextRef[]
  created_at: string
}

export interface AgentMessageContextRef {
  kind: string
  id: string
  label: string
  token: string
  scope?: {
    projectId?: string | null
    projectName?: string | null
  }
  status?: string | null
  metadata?: Record<string, unknown>
}

interface AgentMessageRaw {
  id: string
  conversation_id: string
  role: AgentMessageRole
  content: string
  attachment_ids: string | null
  context_refs: string | null
  created_at: string
}

function parseJsonArray<T>(raw: string | null | undefined, predicate: (value: unknown) => value is T): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter(predicate) : []
  } catch {
    return []
  }
}

function isContextRef(value: unknown): value is AgentMessageContextRef {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.kind === 'string' &&
    typeof row.id === 'string' &&
    typeof row.label === 'string' &&
    typeof row.token === 'string'
  )
}

function mapMessage(row: AgentMessageRaw): AgentMessage {
  const ids = parseJsonArray(row.attachment_ids, (x): x is string => typeof x === 'string')
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    content: row.content,
    attachment_ids: ids,
    context_refs: parseJsonArray(row.context_refs, isContextRef),
    created_at: row.created_at,
  }
}

interface AgentConversationRaw {
  id: string
  title: string | null
  provider: string
  model: string | null
  session_id: string | null
  pinned_project_id: string | null
  tier_level: number
  reasoning_effort: string | null
  created_at: string
  updated_at: string
}

function mapConversation(row: AgentConversationRaw | undefined): AgentConversation | undefined {
  if (!row) return undefined
  return { ...row, tier_level: normalizeLevel(row.tier_level) }
}

export function createAgentConversation(
  db: DbInstance,
  input: { provider?: string; model?: string | null; pinnedProjectId?: string | null; tierLevel?: AgentTierLevel; reasoningEffort?: string | null } = {},
): AgentConversation {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO agent_conversations (id, provider, model, pinned_project_id, tier_level, reasoning_effort)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.provider ?? 'claude',
    input.model ?? null,
    input.pinnedProjectId ?? null,
    input.tierLevel ?? 0,
    input.reasoningEffort ?? null,
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
    reasoning_effort: string | null
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
  input: {
    conversationId: string
    role: AgentMessageRole
    content: string
    attachmentIds?: string[]
    contextRefs?: AgentMessageContextRef[]
  },
): AgentMessage {
  const id = randomUUID()
  const attachmentIds = input.attachmentIds && input.attachmentIds.length ? JSON.stringify(input.attachmentIds) : null
  const contextRefs = input.contextRefs && input.contextRefs.length ? JSON.stringify(input.contextRefs) : null
  db.prepare(
    'INSERT INTO agent_messages (id, conversation_id, role, content, attachment_ids, context_refs) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, input.conversationId, input.role, input.content, attachmentIds, contextRefs)
  // Touch the parent so the list stays ordered by latest activity.
  db.prepare("UPDATE agent_conversations SET updated_at = datetime('now') WHERE id = ?").run(input.conversationId)
  return mapMessage(db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessageRaw)
}

export function listAgentMessages(db: DbInstance, conversationId: string): AgentMessage[] {
  return (
    db
      .prepare('SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(conversationId) as AgentMessageRaw[]
  ).map(mapMessage)
}

/**
 * Every `system`-role message in a conversation whose content satisfies
 * `predicate` (oldest first). The store stays payload-agnostic — callers own
 * the content parsing (e.g. matching a PR-decision card by prDeliveryId).
 */
export function findAgentSystemMessages(
  db: DbInstance,
  conversationId: string,
  predicate: (content: string) => boolean = () => true,
): AgentMessage[] {
  const rows = db
    .prepare(
      "SELECT * FROM agent_messages WHERE conversation_id = ? AND role = 'system' ORDER BY created_at ASC, rowid ASC",
    )
    .all(conversationId) as AgentMessageRaw[]
  return rows.filter((row) => predicate(row.content)).map(mapMessage)
}

export function findAgentSystemMessage(
  db: DbInstance,
  conversationId: string,
  predicate: (content: string) => boolean = () => true,
): AgentMessage | undefined {
  return findAgentSystemMessages(db, conversationId, predicate)[0]
}

/** Delete exact message ids without bumping conversation activity. Callers use
 * this only to consolidate duplicate derived system cards, never user turns. */
export function deleteAgentMessagesByIds(db: DbInstance, messageIds: readonly string[]): number {
  if (messageIds.length === 0) return 0
  const remove = db.prepare('DELETE FROM agent_messages WHERE id = ?')
  let deleted = 0
  for (const id of messageIds) deleted += remove.run(id).changes
  return deleted
}

/**
 * Replace a message's content in place (inline-card state updates). Does NOT
 * bump the conversation's `updated_at` — a card mutation is not new activity
 * and must not reorder the sidebar list. Returns the updated message, or
 * undefined when the row no longer exists.
 */
export function updateAgentMessageContent(db: DbInstance, messageId: string, content: string): AgentMessage | undefined {
  db.prepare('UPDATE agent_messages SET content = ? WHERE id = ?').run(content, messageId)
  const row = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(messageId) as AgentMessageRaw | undefined
  return row ? mapMessage(row) : undefined
}
