import type { DbInstance } from './types'
import type { ChatConversationRow, ChatMessageRow } from '../types'

// ─── Chat DB functions ────────────────────────────────────────────────────────

export function createConversation(
  db: DbInstance,
  opts: { id: string; model: string; kind?: 'sidebar' | 'explore' | 'milestone'; contextScope?: unknown; provider?: string | null }
): void {
  const scopeJson = opts.contextScope != null ? JSON.stringify(opts.contextScope) : null
  db.prepare(
    'INSERT INTO chat_conversations (id, model, kind, context_scope, provider) VALUES (?, ?, ?, ?, ?)'
  ).run(opts.id, opts.model, opts.kind ?? 'sidebar', scopeJson, opts.provider ?? null)
}

export function listConversations(db: DbInstance): ChatConversationRow[] {
  return db.prepare(
    'SELECT * FROM chat_conversations ORDER BY updated_at DESC'
  ).all() as ChatConversationRow[]
}

export function getConversation(db: DbInstance, id: string): ChatConversationRow | undefined {
  return db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) as ChatConversationRow | undefined
}

export function deleteConversation(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id)
}

export function updateConversation(
  db: DbInstance,
  id: string,
  patch: { title?: string; session_id?: string | null; model?: string }
): void {
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [new Date().toISOString()]
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
  if (patch.session_id !== undefined) { sets.push('session_id = ?'); params.push(patch.session_id) }
  if (patch.model !== undefined) { sets.push('model = ?'); params.push(patch.model) }
  params.push(id)
  db.prepare(`UPDATE chat_conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function addMessage(
  db: DbInstance,
  msg: { conversation_id: string; role: 'user' | 'assistant'; content: string }
): ChatMessageRow {
  const result = db.prepare(
    'INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)'
  ).run(msg.conversation_id, msg.role, msg.content)
  return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(result.lastInsertRowid)) as ChatMessageRow
}

export function getMessages(db: DbInstance, conversationId: string): ChatMessageRow[] {
  return db.prepare(
    'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(conversationId) as ChatMessageRow[]
}
