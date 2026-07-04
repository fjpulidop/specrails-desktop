// Board status-filter dimension: the SpecsBoard header's premium status
// selector. One smart bucket ('active' — today's default view semantics:
// everything still moving, never done/cancelled), one catch-all ('all'), and
// the six exact TicketStatus values. Persisted per project (localStorage) and
// URL-synced (`?status=…`) by SpecsBoard.

import type { TicketStatus } from '../types'

/** The board's status-filter value: a smart bucket or one exact status. */
export type SpecStatusFilterValue = 'active' | 'all' | TicketStatus

/** Canonical lifecycle order used everywhere the six statuses render. */
export const TICKET_STATUS_ORDER: readonly TicketStatus[] = [
  'draft',
  'todo',
  'in_progress',
  'on_review',
  'done',
  'cancelled',
]

/**
 * Statuses inside the 'active' smart bucket. Matches the old default ToDo tab
 * family (draft + todo + in_progress + on_review) minus cancelled — done and
 * cancelled are one click away, never dumped into the default view.
 */
export const ACTIVE_STATUSES: ReadonlySet<TicketStatus> = new Set([
  'draft',
  'todo',
  'in_progress',
  'on_review',
])

export const SPEC_STATUS_FILTER_VALUES: readonly SpecStatusFilterValue[] = [
  'active',
  'all',
  ...TICKET_STATUS_ORDER,
]

export function isSpecStatusFilterValue(v: unknown): v is SpecStatusFilterValue {
  return typeof v === 'string' && (SPEC_STATUS_FILTER_VALUES as readonly string[]).includes(v)
}

/** Does a ticket status pass the given filter value? */
export function statusMatchesFilter(status: TicketStatus, filter: SpecStatusFilterValue): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return ACTIVE_STATUSES.has(status)
  return status === filter
}

// ─── Per-project persistence ─────────────────────────────────────────────────
// New key (values widened beyond todo|done). The legacy ToDo/Done tab key is
// read once as a fallback so an upgrade lands users on the equivalent view:
// legacy 'done' → 'done', anything else → 'active'. New picks never write the
// legacy key, so the exact 'todo' chip is distinguishable from the old tab.

const KEY = (projectId: string) => `specrails-desktop:spec-status-filter:${projectId}`
const LEGACY_TAB_KEY = (projectId: string) => `specrails-desktop:spec-status-tab:${projectId}`

export function loadSpecStatusFilter(projectId: string | null): SpecStatusFilterValue {
  if (!projectId) return 'active'
  try {
    const v = localStorage.getItem(KEY(projectId))
    if (isSpecStatusFilterValue(v)) return v
    const legacy = localStorage.getItem(LEGACY_TAB_KEY(projectId))
    return legacy === 'done' ? 'done' : 'active'
  } catch {
    return 'active'
  }
}

export function saveSpecStatusFilter(projectId: string | null, v: SpecStatusFilterValue): void {
  if (!projectId) return
  try {
    localStorage.setItem(KEY(projectId), v)
  } catch {
    /* private mode / quota — best-effort */
  }
}
