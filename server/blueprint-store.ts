import { randomUUID } from 'crypto'
import type { DbInstance } from './db'
import type { Blueprint } from './blueprint-types'
import { coerceBlueprint } from './blueprint-draft-parser'

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
  /** Last ACCEPTED normalized snapshot (JSON) — null until the first valid block. */
  blueprint_json: string | null
  /** Exact raw payload of that snapshot (JSON) — the commit/readiness evidence. */
  raw_blueprint_json: string | null
  snapshot_updated_at: string | null
  /** Last snapshot rejection (JSON `BlueprintSnapshotIssue`) still awaiting a
   *  repair; cleared by the next accepted snapshot. */
  snapshot_issue_json: string | null
  /** Set once the orchestrated commit registered a project from this blueprint. */
  committed_project_id: string | null
  created_at: string
  updated_at: string
}

/** Why the last emitted block could not become a snapshot (persisted so a
 *  manual repair still knows what to ask for after a restart). */
export interface BlueprintSnapshotIssue {
  reason: 'invalid_json' | 'missing_version' | 'truncated'
  detail: string
  at: string
}

export type BlueprintMessageRole = 'user' | 'assistant'

export interface BlueprintMessage {
  id: string
  conversation_id: string
  role: BlueprintMessageRole
  /** Transcript text (blueprint-draft blocks stripped). May be '' for an
   *  assistant reply that was ONLY a block — the UI hides empty rows. */
  content: string
  /** The model's unstripped reply when it carried a block (forensics; lets a
   *  later parser fix re-read an old rejected snapshot). Null otherwise. */
  raw_content: string | null
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
  input: { conversationId: string; role: BlueprintMessageRole; content: string; rawContent?: string | null },
): BlueprintMessage {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO blueprint_messages (id, conversation_id, role, content, raw_content) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.conversationId, input.role, input.content, input.rawContent ?? null)
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

// ─── Durable snapshots + resume (harden-project-builder-snapshots) ───────────

export interface BlueprintSnapshotRecord {
  blueprint: Blueprint | null
  rawBlueprint: unknown | null
  snapshotUpdatedAt: string | null
  issue: BlueprintSnapshotIssue | null
}

function parseJsonColumn(value: string | null): unknown | null {
  if (!value) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

/** Persist the ACCEPTED snapshot pair and clear any pending rejection. */
export function saveBlueprintSnapshot(
  db: DbInstance,
  id: string,
  snapshot: { blueprint: Blueprint; rawBlueprint: unknown },
): void {
  db.prepare(
    `UPDATE blueprint_conversations
       SET blueprint_json = ?, raw_blueprint_json = ?, snapshot_updated_at = datetime('now'),
           snapshot_issue_json = NULL, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(JSON.stringify(snapshot.blueprint), JSON.stringify(snapshot.rawBlueprint ?? snapshot.blueprint), id)
}

/** Record why the last block was rejected (kept until a snapshot is accepted). */
export function saveBlueprintSnapshotIssue(db: DbInstance, id: string, issue: BlueprintSnapshotIssue | null): void {
  db.prepare(
    "UPDATE blueprint_conversations SET snapshot_issue_json = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(issue ? JSON.stringify(issue) : null, id)
}

/** Read the persisted snapshot (normalized through `coerceBlueprint` so a
 *  row written by an older build stays readable; corrupt JSON reads as null). */
export function getBlueprintSnapshot(db: DbInstance, id: string): BlueprintSnapshotRecord {
  const row = getBlueprintConversation(db, id)
  if (!row) return { blueprint: null, rawBlueprint: null, snapshotUpdatedAt: null, issue: null }
  const rawBlueprint = parseJsonColumn(row.raw_blueprint_json)
  const blueprint = coerceBlueprint(parseJsonColumn(row.blueprint_json) ?? rawBlueprint)
  const issueValue = parseJsonColumn(row.snapshot_issue_json) as Partial<BlueprintSnapshotIssue> | null
  const issue = issueValue && typeof issueValue.reason === 'string' && typeof issueValue.detail === 'string'
    ? { reason: issueValue.reason, detail: issueValue.detail, at: typeof issueValue.at === 'string' ? issueValue.at : '' }
    : null
  return { blueprint, rawBlueprint: blueprint ? rawBlueprint ?? blueprint : null, snapshotUpdatedAt: row.snapshot_updated_at, issue }
}

export function markBlueprintCommitted(db: DbInstance, id: string, projectId: string): void {
  db.prepare(
    "UPDATE blueprint_conversations SET committed_project_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(projectId, id)
}

/** A resumable Builder conversation as the "continue where you left off"
 *  list renders it: identity + a snapshot summary, never the full payload. */
export interface ResumableBlueprintConversation {
  id: string
  title: string | null
  provider: string
  model: string | null
  created_at: string
  updated_at: string
  messageCount: number
  productName: string | null
  platform: string | null
  specCount: number
  specsComplete: boolean
  /** How many of the five interview dimensions the snapshot already fills. */
  dimensionsFilled: number
  hasSnapshot: boolean
  pendingIssue: BlueprintSnapshotIssue['reason'] | null
}

function summarizeBlueprint(bp: Blueprint | null): Pick<ResumableBlueprintConversation, 'productName' | 'platform' | 'specCount' | 'specsComplete' | 'dimensionsFilled'> {
  if (!bp) return { productName: null, platform: null, specCount: 0, specsComplete: false, dimensionsFilled: 0 }
  const dims = [
    bp.product.name !== '' && bp.product.pitch !== '',
    bp.coreFlow !== '',
    bp.platform !== '',
    bp.stack.language !== '' || bp.stack.framework !== '',
    bp.milestones.length > 0,
  ]
  return {
    productName: bp.product.name || null,
    platform: bp.platform || null,
    specCount: bp.m1Specs.length,
    specsComplete: bp.specsComplete,
    dimensionsFilled: dims.filter(Boolean).length,
  }
}

/**
 * Unfinished Builder conversations worth resuming: not committed and with at
 * least one assistant reply (an empty bootstrap row is noise). Newest first.
 */
export function listResumableBlueprintConversations(db: DbInstance, limit = 8): ResumableBlueprintConversation[] {
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM blueprint_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM blueprint_conversations c
        WHERE c.committed_project_id IS NULL
          AND EXISTS (SELECT 1 FROM blueprint_messages m WHERE m.conversation_id = c.id AND m.role = 'assistant')
        ORDER BY c.updated_at DESC, c.rowid DESC
        LIMIT ?`,
    )
    .all(limit) as Array<BlueprintConversation & { message_count: number }>
  return rows.map((row) => {
    const snapshot = getBlueprintSnapshot(db, row.id)
    return {
      id: row.id,
      title: row.title,
      provider: row.provider,
      model: row.model,
      created_at: row.created_at,
      updated_at: row.updated_at,
      messageCount: row.message_count,
      ...summarizeBlueprint(snapshot.blueprint),
      hasSnapshot: snapshot.blueprint !== null,
      pendingIssue: snapshot.issue?.reason ?? null,
    }
  })
}
