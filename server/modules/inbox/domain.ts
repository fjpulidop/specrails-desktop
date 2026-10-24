/**
 * "Needs you" inbox: pure vocabulary. The inbox is a read-model projected from
 * state other capabilities already own (deliveries, loop runs, the Jira
 * outbox); it has no store of its own. Dismissal (Snooze / Done) is a
 * per-viewer concern of the client and never reaches the server.
 */

export const INBOX_KINDS = ['review', 'question', 'failed', 'blocked', 'budget', 'jira'] as const
export type InboxKind = (typeof INBOX_KINDS)[number]

/** What the primary inline action does (the client maps each to the existing handler/route). */
export const INBOX_ACTIONS = ['open-review', 'open-run', 'resume-run', 'retry-jira'] as const
export type InboxAction = (typeof INBOX_ACTIONS)[number]

export interface InboxItem {
  /** Stable identity of the thing that needs the person: `<projectId>:<kind>:<sourceId>`. */
  id: string
  projectId: string
  projectName: string
  kind: InboxKind
  title: string
  /** One short plain-language line (outcome, failure code, dead reason), never a log tail. */
  detail: string | null
  /** When the item started waiting (ISO). */
  at: string
  /**
   * Changes whenever the underlying state changes in a way that deserves a
   * fresh look. "Done" hides an item only while its version is unchanged.
   */
  version: string
  action: InboxAction
  /** Source row the action addresses (delivery id, loop-run id, outbox id). */
  subjectId: string
  /** Mission that launched the work, when known (deep link target). */
  conversationId: string | null
}

export interface ProjectInbox {
  projectId: string
  projectName: string
  count: number
}

export interface InboxSnapshot {
  items: InboxItem[]
  projects: ProjectInbox[]
  generatedAt: string
}

export const MAX_ITEMS_PER_PROJECT = 50

export function inboxItemId(projectId: string, kind: InboxKind, sourceId: string): string {
  return `${projectId}:${kind}:${sourceId}`
}

/** Newest first; ties broken by id so the order is deterministic. */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  const delta = Date.parse(b.at) - Date.parse(a.at)
  if (Number.isFinite(delta) && delta !== 0) return delta
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Bound a free-text fragment to a single short line. */
export function oneLine(value: string | null | undefined, max = 140): string | null {
  if (!value) return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** SQLite `datetime('now')` is UTC without a zone: make it ISO so clients parse it right. */
export function toIso(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
  return Number.isNaN(Date.parse(normalized)) ? fallback : new Date(normalized).toISOString()
}
