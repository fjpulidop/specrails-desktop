// Architect clarifications on Jira (feedback-2026-10 task 3.2).
//
// When a run pauses with the architect's questions, or proceeds on stated
// assumptions (Core `architectClarifications: 1`, `clarifications.json`), and
// the project enabled `jiraPostClarifications`, Desktop posts them as ONE
// comment on each linked issue through the durable outbox (idempotency key
// per run, ticket and record). A human reply posted after that comment is
// imported once as a spec addendum of kind `clarification`, so the next launch
// of the spec carries the answer. Scope is deliberately narrow: only replies
// that follow a Specrails clarifications comment are imported; no other Jira
// thread is read.
//
// This file holds the pure text/selection rules and the thread table access.
import { createHash } from 'node:crypto'
import type { DbInstance } from '../db'
import type { RunClarificationsRecord } from '../modules/delivery/runtime/run-records'
import { adfToText, commentHasMarker, SPECRAILS_COMMENT_PROP_KEY } from './jira-adf'

export type ClarificationThreadKind = 'questions' | 'assumptions'
/** Replies are imported for this long after the comment was posted. */
export const CLARIFICATION_REPLY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
const REPLY_BODY_CAP = 8000

/** Stable digest of what the comment says (a later different pause posts again). */
export function clarificationsDigest(record: RunClarificationsRecord): string {
  const content = record.status === 'awaiting-answers'
    ? record.blocking.map((item) => item.question)
    : [...record.assumptions, ...record.clarifications.map((item) => `${item.question}=${item.default ?? ''}`)]
  return createHash('sha256').update(JSON.stringify([record.status, content])).digest('hex').slice(0, 16)
}

export function clarificationsCommentMarker(runId: string, ticketId: number, digest: string): string {
  return `[specrails:clarifications=${runId}:ticket=${ticketId}:${digest}]`
}

export function clarificationThreadKind(record: RunClarificationsRecord): ClarificationThreadKind {
  return record.status === 'awaiting-answers' ? 'questions' : 'assumptions'
}

/** The comment body (plain text; the ADF layer renders paragraphs). */
export function buildClarificationsComment(record: RunClarificationsRecord): string {
  const lines: string[] = []
  if (record.status === 'awaiting-answers') {
    const questions = record.blocking.length ? record.blocking : record.clarifications.filter((item) => item.impact === 'high')
    lines.push('Specrails paused this spec before planning: the architect needs an answer to continue.')
    lines.push('')
    questions.forEach((item, index) => lines.push(`${index + 1}. ${item.question}`))
    const others = record.clarifications.filter((item) => !questions.includes(item))
    if (others.length) {
      lines.push('')
      lines.push('It would otherwise assume:')
      for (const item of others) lines.push(`- ${item.question} → ${item.default ?? 'no safe default'} (${item.impact} impact)`)
    }
    lines.push('')
    lines.push('Reply to this comment to answer: Specrails records the reply on the spec for its next run. You can also answer in the app.')
  } else {
    lines.push('Specrails planned this spec on the following assumptions. Reply to this comment if any of them is wrong; the reply is recorded on the spec for its next run.')
    lines.push('')
    const assumptions = record.assumptions.length
      ? record.assumptions
      : record.clarifications.map((item) => `${item.question} → ${item.default ?? 'no safe default'}`)
    for (const line of assumptions) lines.push(`- ${line.replace(/^\s*[-*]\s+/, '')}`)
  }
  return lines.join('\n')
}

// ─── Reply selection ─────────────────────────────────────────────────────────

export interface JiraCommentLike {
  id: string
  body: unknown
  properties?: Array<{ key: string; value?: unknown }>
  author?: { displayName?: unknown; accountId?: unknown } | null
  created?: unknown
}

/** True when the comment was written by Specrails (any marker). */
function isSpecrailsComment(comment: JiraCommentLike): boolean {
  if (comment.properties?.some((property) => property.key === SPECRAILS_COMMENT_PROP_KEY)) return true
  return /\[specrails:[a-z-]+=/.test(adfToText(comment.body))
}

export interface ClarificationReply { commentId: string; author: string | null; created: string | null; text: string }

/**
 * Human replies after the thread's marker comment (Jira lists comments oldest
 * first), skipping Specrails' own comments and the already-imported ids.
 * Empty when the marker comment is not (yet) on the issue.
 */
export function selectClarificationReplies(comments: readonly JiraCommentLike[], marker: string, imported: ReadonlySet<string>): ClarificationReply[] {
  const anchor = comments.findIndex((comment) => commentHasMarker(comment, marker))
  if (anchor < 0) return []
  const out: ClarificationReply[] = []
  for (const comment of comments.slice(anchor + 1)) {
    if (!comment.id || imported.has(comment.id) || isSpecrailsComment(comment)) continue
    const text = adfToText(comment.body).trim()
    if (!text) continue
    out.push({
      commentId: comment.id,
      author: typeof comment.author?.displayName === 'string' && comment.author.displayName.trim() ? comment.author.displayName.trim().slice(0, 120) : null,
      created: typeof comment.created === 'string' ? comment.created : null,
      text: text.slice(0, REPLY_BODY_CAP),
    })
  }
  return out
}

/** The addendum a reply becomes (kind `clarification`, validated by the addenda core). */
export function clarificationAddendumInput(reply: ClarificationReply, jiraKey: string | null, kind: ClarificationThreadKind): { kind: 'clarification'; title: string; body: string } {
  const where = jiraKey ? `Jira ${jiraKey}` : 'Jira'
  const title = `${kind === 'questions' ? 'Answer' : 'Correction'} from ${where}${reply.author ? ` (${reply.author})` : ''}`.slice(0, 200)
  const body = [
    kind === 'questions'
      ? 'Answer to the architect\'s clarification questions, posted on the linked Jira issue. Treat it as authoritative for the questions it answers.'
      : 'Reply to the assumptions the architect planned on, posted on the linked Jira issue. Where it contradicts an assumption, the reply wins.',
    '',
    reply.text,
  ].join('\n')
  return { kind: 'clarification', title, body }
}

// ─── Thread table (migration 77) ─────────────────────────────────────────────

export interface ClarificationThreadRow {
  id: string
  run_id: string
  ticket_id: number
  jira_issue_id: string
  kind: ClarificationThreadKind
  marker: string
  state: 'open' | 'answered' | 'closed'
  imported_comment_ids: string
  created_at: string
  updated_at: string
}

export function insertClarificationThread(db: DbInstance, row: Omit<ClarificationThreadRow, 'state' | 'imported_comment_ids' | 'updated_at'>): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO jira_clarification_threads (id, run_id, ticket_id, jira_issue_id, kind, marker, state, imported_comment_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', '[]', ?, ?)
  `).run(row.id, row.run_id, row.ticket_id, row.jira_issue_id, row.kind, row.marker, row.created_at, row.created_at)
  return result.changes > 0
}

/** Threads still collecting replies; older ones are closed as a side effect. */
export function listOpenClarificationThreads(db: DbInstance, now = Date.now()): ClarificationThreadRow[] {
  const cutoff = new Date(now - CLARIFICATION_REPLY_WINDOW_MS).toISOString()
  db.prepare(`UPDATE jira_clarification_threads SET state = 'closed', updated_at = ? WHERE state != 'closed' AND created_at < ?`).run(new Date(now).toISOString(), cutoff)
  return db.prepare(`SELECT * FROM jira_clarification_threads WHERE state != 'closed' ORDER BY created_at LIMIT 50`).all() as ClarificationThreadRow[]
}

export function importedCommentIds(row: Pick<ClarificationThreadRow, 'imported_comment_ids'>): Set<string> {
  try {
    const parsed = JSON.parse(row.imported_comment_ids) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch { return new Set() }
}

export function recordImportedReplies(db: DbInstance, threadId: string, ids: readonly string[], now = new Date().toISOString()): void {
  const row = db.prepare(`SELECT imported_comment_ids FROM jira_clarification_threads WHERE id = ?`).get(threadId) as Pick<ClarificationThreadRow, 'imported_comment_ids'> | undefined
  if (!row) return
  const merged = [...new Set([...importedCommentIds(row), ...ids])].slice(-200)
  db.prepare(`UPDATE jira_clarification_threads SET imported_comment_ids = ?, state = 'answered', updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), now, threadId)
}
