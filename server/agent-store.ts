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

// ─── Mission search (search-missions-in-palette) ──────────────────────────────

/** A highlighted excerpt: plain text plus `[start, end)` ranges to mark. */
export interface MissionSearchSnippet {
  text: string
  ranges: Array<[number, number]>
}

export interface MissionSearchHit {
  conversation: AgentConversation
  /** Title matches rank above content matches; a mission can satisfy both, in
   *  which case `match` stays `'title'` and the content snippet still rides along. */
  match: 'title' | 'content'
  /** Best-ranked matching message for content hits; null for title-only hits. */
  messageId: string | null
  snippet: MissionSearchSnippet | null
}

export const MISSION_SEARCH_DEFAULT_LIMIT = 20
export const MISSION_SEARCH_MAX_LIMIT = 50
/** The trigram tokenizer matches nothing below three characters; shorter
 *  queries take the bounded substring scan instead. */
const TRIGRAM_MIN_CHARS = 3
/** Rows the substring fallback inspects at most (newest first). */
const FALLBACK_SCAN_ROWS = 400
/** Characters kept on each side of the first match in a snippet window. */
const FALLBACK_CONTEXT = 60
const MARK_START = '\u0001'
const MARK_END = '\u0002'

/** Lowercase + strip combining diacritics, mirroring the index tokenizer so a
 *  title compare and a content compare agree on what "matches". */
export function foldSearchText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** Quote a raw user query as one FTS5 phrase so operators/punctuation in it
 *  never become syntax; a trigram phrase is a plain substring match. */
function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`
}

/**
 * Cut a marked full-content string (`highlight()` output, or the substring
 * fallback's own marking) down to a window of ~${FALLBACK_CONTEXT} characters on
 * each side of the FIRST match, with ellipses where text was dropped and
 * whitespace collapsed. Markers outside the window are simply cut away;
 * `parseMarkedSnippet` tolerates a dangling one.
 */
function windowMarked(marked: string): string {
  const at = marked.indexOf(MARK_START)
  if (at < 0) return marked.slice(0, FALLBACK_CONTEXT * 2).replace(/\s+/g, ' ')
  const close = marked.indexOf(MARK_END, at)
  const matchEnd = close < 0 ? marked.length : close + 1
  const start = Math.max(0, at - FALLBACK_CONTEXT)
  const end = Math.min(marked.length, matchEnd + FALLBACK_CONTEXT)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < marked.length ? '…' : ''
  return prefix + marked.slice(start, end).replace(/\s+/g, ' ') + suffix
}

/** Turn a marked window into plain text + `[start, end)` highlight ranges. */
function parseMarkedSnippet(marked: string): MissionSearchSnippet {
  let text = ''
  const ranges: Array<[number, number]> = []
  let open = -1
  for (const ch of marked) {
    if (ch === MARK_START) {
      open = text.length
    } else if (ch === MARK_END) {
      if (open >= 0 && text.length > open) ranges.push([open, text.length])
      open = -1
    } else {
      text += ch
    }
  }
  return { text, ranges }
}

interface ContentHitRow {
  conversation_id: string
  message_id: string
  /** Full message content with the FIRST-match window still to be cut. */
  marked: string
}

function contentHitsFts(db: DbInstance, query: string, limit: number): ContentHitRow[] {
  return db
    .prepare(
      `WITH hits AS (
         SELECT conversation_id, message_id,
                bm25(agent_messages_fts) AS rank,
                highlight(agent_messages_fts, 3, ?, ?) AS marked
         FROM agent_messages_fts
         WHERE agent_messages_fts MATCH ? AND role IN ('user', 'assistant')
       ),
       ranked AS (
         SELECT conversation_id, message_id, rank, marked,
                row_number() OVER (PARTITION BY conversation_id ORDER BY rank, message_id) AS rn
         FROM hits
       )
       SELECT conversation_id, message_id, marked
       FROM ranked WHERE rn = 1
       ORDER BY rank, conversation_id
       LIMIT ?`,
    )
    .all(MARK_START, MARK_END, ftsPhrase(query), limit) as ContentHitRow[]
}

function contentHitsSubstring(db: DbInstance, query: string, limit: number): ContentHitRow[] {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`)
  const rows = db
    .prepare(
      `SELECT conversation_id, id AS message_id, content
       FROM agent_messages
       WHERE role IN ('user', 'assistant') AND content LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(`%${escaped}%`, FALLBACK_SCAN_ROWS) as Array<{ conversation_id: string; message_id: string; content: string }>
  const seen = new Set<string>()
  const hits: ContentHitRow[] = []
  const needle = query.toLowerCase()
  for (const row of rows) {
    if (seen.has(row.conversation_id)) continue
    seen.add(row.conversation_id)
    const at = row.content.toLowerCase().indexOf(needle)
    const marked = at < 0
      ? row.content
      : row.content.slice(0, at) + MARK_START + row.content.slice(at, at + needle.length) + MARK_END + row.content.slice(at + needle.length)
    hits.push({ conversation_id: row.conversation_id, message_id: row.message_id, marked })
    if (hits.length >= limit) break
  }
  return hits
}

/**
 * Search missions by title and by the text of their user/assistant messages.
 * Returns at most `limit` conversations, one row each: title matches first
 * (newest first), then content matches by relevance. `system` rows (the
 * app-authored PR-decision envelopes) never match. An empty query yields [].
 */
export function searchAgentConversations(db: DbInstance, rawQuery: string, limit = MISSION_SEARCH_DEFAULT_LIMIT): MissionSearchHit[] {
  const query = rawQuery.trim()
  if (!query) return []
  const cap = Math.max(1, Math.min(MISSION_SEARCH_MAX_LIMIT, Math.floor(limit)))

  const conversations = (
    db.prepare('SELECT * FROM agent_conversations ORDER BY updated_at DESC').all() as AgentConversationRaw[]
  ).map((r) => mapConversation(r)!)
  const byId = new Map(conversations.map((c) => [c.id, c]))

  const folded = foldSearchText(query)
  const titleHits = conversations.filter((c) => c.title && foldSearchText(c.title).includes(folded))

  const contentRows = [...query].length >= TRIGRAM_MIN_CHARS
    ? contentHitsFts(db, query, cap + titleHits.length)
    : contentHitsSubstring(db, query, cap + titleHits.length)
  const contentById = new Map(contentRows.map((r) => [r.conversation_id, r]))

  const results: MissionSearchHit[] = []
  for (const conversation of titleHits) {
    const content = contentById.get(conversation.id)
    results.push({
      conversation,
      match: 'title',
      messageId: content?.message_id ?? null,
      snippet: content ? parseMarkedSnippet(windowMarked(content.marked)) : null,
    })
    if (results.length >= cap) return results
  }
  const titleIds = new Set(titleHits.map((c) => c.id))
  for (const row of contentRows) {
    if (titleIds.has(row.conversation_id)) continue
    const conversation = byId.get(row.conversation_id)
    if (!conversation) continue
    results.push({ conversation, match: 'content', messageId: row.message_id, snippet: parseMarkedSnippet(windowMarked(row.marked)) })
    if (results.length >= cap) break
  }
  return results
}
