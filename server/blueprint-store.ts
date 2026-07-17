import { randomUUID } from 'crypto'
import type { DbInstance } from './db'

// ─── Project Builder day-0 conversation persistence (design D1) ──────────────
//
// CRUD over `blueprint_conversations` / `blueprint_messages` in desktop.sqlite
// (migration 22). Builder conversations run BEFORE any project exists, so they
// are app-global — a deliberate sibling of agent-store with a smaller surface
// (no tier ladder, no pinned project, no attachments).

export interface BlueprintConversation {
  id: string
  title: string | null
  provider: string
  model: string | null
  session_id: string | null
  created_at: string
  updated_at: string
}

export type BlueprintMessageRole = 'user' | 'assistant'

export interface BlueprintMessage {
  id: string
  conversation_id: string
  role: BlueprintMessageRole
  content: string
  created_at: string
}

export function createBlueprintConversation(
  db: DbInstance,
  input: { provider?: string; model?: string | null } = {},
): BlueprintConversation {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO blueprint_conversations (id, provider, model) VALUES (?, ?, ?)',
  ).run(id, input.provider ?? 'claude', input.model ?? null)
  return getBlueprintConversation(db, id)!
}

export function getBlueprintConversation(db: DbInstance, id: string): BlueprintConversation | undefined {
  return db.prepare('SELECT * FROM blueprint_conversations WHERE id = ?').get(id) as
    | BlueprintConversation
    | undefined
}

export function listBlueprintConversations(db: DbInstance, limit = 50): BlueprintConversation[] {
  return db
    .prepare('SELECT * FROM blueprint_conversations ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as BlueprintConversation[]
}

/** Patch a conversation. Only provided fields change; `updated_at` always bumps. */
export function updateBlueprintConversation(
  db: DbInstance,
  id: string,
  patch: Partial<{ title: string | null; provider: string; model: string | null; session_id: string | null }>,
): BlueprintConversation | undefined {
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`)
    vals.push(v)
  }
  sets.push("updated_at = datetime('now')")
  db.prepare(`UPDATE blueprint_conversations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  return getBlueprintConversation(db, id)
}

export function deleteBlueprintConversation(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM blueprint_conversations WHERE id = ?').run(id)
}

export function addBlueprintMessage(
  db: DbInstance,
  input: { conversationId: string; role: BlueprintMessageRole; content: string },
): BlueprintMessage {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO blueprint_messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
  ).run(id, input.conversationId, input.role, input.content)
  db.prepare("UPDATE blueprint_conversations SET updated_at = datetime('now') WHERE id = ?").run(
    input.conversationId,
  )
  return db.prepare('SELECT * FROM blueprint_messages WHERE id = ?').get(id) as BlueprintMessage
}

export function listBlueprintMessages(db: DbInstance, conversationId: string): BlueprintMessage[] {
  return db
    .prepare('SELECT * FROM blueprint_messages WHERE conversation_id = ? ORDER BY created_at, rowid')
    .all(conversationId) as BlueprintMessage[]
}
