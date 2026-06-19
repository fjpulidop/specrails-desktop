import type { LocalTicket } from '../types'

/**
 * Local statuses where ANY ticket can be opened in Explore Spec to refine it
 * ("Continue Editing"). These are the pre-implementation columns — a non-Jira
 * `in_progress` ticket usually has a live rail that already snapshotted the
 * spec, so editing it there would be misleading.
 */
const BASE_EDITABLE_STATUSES = new Set<LocalTicket['status']>(['draft', 'todo'])

/**
 * Whether a ticket can be opened in Explore Spec to refine it.
 *
 * Base rule (all tickets): draft / todo.
 *
 * Jira-backed specs additionally refine in ANY non-cancelled status. A Jira
 * ticket's local status is a MIRROR of its Jira board column (To Do / In
 * Progress / Done), not a Specrails rail lifecycle — a PM edits the issue in
 * any column. Refining never flips status (the commit PATCH omits it) and the
 * edited fields write back to the Jira issue via `onSpecEdited`. `cancelled`
 * stays excluded: it is intent closure (won't-do / rejected), so editing it
 * would contradict the discard signal.
 */
export function canRefineTicket(
  ticket: Pick<LocalTicket, 'status' | 'source' | 'jira_key'>,
): boolean {
  if (BASE_EDITABLE_STATUSES.has(ticket.status)) return true
  if (ticket.source === 'jira' && !!ticket.jira_key && ticket.status !== 'cancelled') return true
  return false
}
