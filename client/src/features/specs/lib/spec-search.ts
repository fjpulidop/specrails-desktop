// Ephemeral board search: narrows the SpecsBoard like a filter (before the
// status counts), matching title, `#id` / bare id, Jira key and labels.
// Never persisted — cleared on project switch by SpecsBoard.

import type { LocalTicket } from '../../../types'

/** Trimmed, lower-cased query; `''` means "no search". */
export function normalizeSpecQuery(q: string): string {
  return q.trim().toLowerCase()
}

const ID_QUERY = /^#?(\d+)$/

/** True when the ticket matches an already-normalized query. */
export function specMatchesQuery(t: LocalTicket, normalizedQuery: string): boolean {
  if (normalizedQuery === '') return true
  const title = (t.title ?? '').toLowerCase()
  const idMatch = ID_QUERY.exec(normalizedQuery)
  if (idMatch) return String(t.id) === idMatch[1] || title.includes(normalizedQuery)
  if (title.includes(normalizedQuery)) return true
  if (t.jira_key && t.jira_key.toLowerCase().includes(normalizedQuery)) return true
  return (t.labels ?? []).some((l) => typeof l === 'string' && l.toLowerCase().includes(normalizedQuery))
}
