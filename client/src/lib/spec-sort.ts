import type { LocalTicket, TicketPriority } from '../types'
import {
  type SpecSortMode,
  type SpecSortDir,
  DEFAULT_SPEC_SORT_MODE,
  DEFAULT_SPEC_SORT_DIR,
} from '../types/spec-sort'

const MODE_KEY = (projectId: string) => `specrails-desktop:spec-sort-mode:${projectId}`
const DIR_KEY = (projectId: string) => `specrails-desktop:spec-sort-dir:${projectId}`

function isMode(v: unknown): v is SpecSortMode {
  return v === 'default' || v === 'ticket-id' || v === 'priority' || v === 'jira-key'
}

function isDir(v: unknown): v is SpecSortDir {
  return v === 'asc' || v === 'desc'
}

export interface SpecSortState {
  mode: SpecSortMode
  dir: SpecSortDir
}

export function loadSpecSort(projectId: string | null): SpecSortState {
  if (!projectId) return { mode: DEFAULT_SPEC_SORT_MODE, dir: DEFAULT_SPEC_SORT_DIR }
  let mode: SpecSortMode = DEFAULT_SPEC_SORT_MODE
  let dir: SpecSortDir = DEFAULT_SPEC_SORT_DIR
  try {
    const m = localStorage.getItem(MODE_KEY(projectId))
    if (isMode(m)) mode = m
  } catch {}
  try {
    const d = localStorage.getItem(DIR_KEY(projectId))
    if (isDir(d)) dir = d
  } catch {}
  return { mode, dir }
}

export function saveSpecSort(
  projectId: string | null,
  mode: SpecSortMode,
  dir: SpecSortDir,
): void {
  if (!projectId) return
  try {
    localStorage.setItem(MODE_KEY(projectId), mode)
    localStorage.setItem(DIR_KEY(projectId), dir)
  } catch {}
}

const PRIORITY_BUCKET: Record<NonNullable<TicketPriority> | 'null', number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  null: 0,
}

function bucketOf(p: TicketPriority | null): number {
  if (p === null) return PRIORITY_BUCKET.null
  return PRIORITY_BUCKET[p]
}

export function sortByTicketId(a: LocalTicket, b: LocalTicket, dir: SpecSortDir): number {
  return dir === 'asc' ? a.id - b.id : b.id - a.id
}

export function sortByPriority(a: LocalTicket, b: LocalTicket, dir: SpecSortDir): number {
  const ba = bucketOf(a.priority)
  const bb = bucketOf(b.priority)
  const bucketDelta = dir === 'asc' ? ba - bb : bb - ba
  if (bucketDelta !== 0) return bucketDelta
  return a.id - b.id
}

/**
 * Extract the numeric suffix of a Jira issue key (e.g. "PROJ-123" → 123).
 * Returns null when the key is missing or has no parseable trailing number,
 * so non-Jira specs (and malformed keys) can be bucketed last.
 */
export function jiraKeyNumber(ticket: LocalTicket): number | null {
  const key = ticket.jira_key
  if (!key) return null
  const m = /(\d+)\s*$/.exec(key)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  // Reject values beyond MAX_SAFE_INTEGER: IEEE-754 precision loss there would
  // make the numeric comparison non-transitive. Such keys bucket as keyless.
  return Number.isSafeInteger(n) ? n : null
}

/**
 * Sort by the Jira ticket number. Specs without a Jira key always sort LAST
 * (in both directions) so the board never buries linked issues under
 * not-yet-synced local specs. Tie-break by id ascending for stability.
 */
export function sortByJiraKey(a: LocalTicket, b: LocalTicket, dir: SpecSortDir): number {
  const na = jiraKeyNumber(a)
  const nb = jiraKeyNumber(b)
  if (na === null && nb === null) return a.id - b.id
  if (na === null) return 1
  if (nb === null) return -1
  const delta = dir === 'asc' ? na - nb : nb - na
  if (delta !== 0) return delta
  return a.id - b.id
}

export function applySpecSort(
  tickets: LocalTicket[],
  mode: SpecSortMode,
  dir: SpecSortDir,
): LocalTicket[] {
  if (mode === 'ticket-id') return [...tickets].sort((a, b) => sortByTicketId(a, b, dir))
  if (mode === 'priority') return [...tickets].sort((a, b) => sortByPriority(a, b, dir))
  if (mode === 'jira-key') return [...tickets].sort((a, b) => sortByJiraKey(a, b, dir))
  return tickets
}
