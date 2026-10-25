import { toast } from 'sonner'
import type { LocalTicket, TicketStatus } from '../../../types'
import { jiraApi } from '../../integrations/lib/jira-api'

import { notifyError } from '../../../lib/notify-error'
/**
 * Manual status targets of a spec. `draft` (Explore-owned) and `on_review`
 * (pipeline-owned, PR-decision semantics) are never offered as TARGETS.
 * Shared by the spec detail selector and the ⌘K "Move to" page so both offer
 * exactly the same moves.
 */
export const MANUAL_STATUS_TARGETS: TicketStatus[] = ['todo', 'in_progress', 'done', 'cancelled']

/** tickets:ticketStatus.* uses camelCase keys — map the snake_case status ids. */
export const STATUS_LABEL_KEY: Record<TicketStatus, string> = {
  draft: 'ticketStatus.draft',
  todo: 'ticketStatus.todo',
  in_progress: 'ticketStatus.inProgress',
  on_review: 'ticketStatus.onReview',
  done: 'ticketStatus.done',
  cancelled: 'ticketStatus.cancelled',
}

/** A Jira-backed spec moves through the board's real workflow (via the outbox), never the local statuses. */
export function isJiraBackedTicket(ticket: Pick<LocalTicket, 'source' | 'jira_key'>, jiraConnected: boolean): boolean {
  return jiraConnected && ticket.source === 'jira' && !!ticket.jira_key
}

/** Queue a Jira-backed spec's move to a workflow status; toasts the outcome. */
export async function moveJiraSpecToStatus(
  ticketId: number,
  status: string,
  tj: (key: string, options?: Record<string, unknown>) => string,
  /** `quiet`: the caller (a bulk move) reports one summary instead of a toast per spec. */
  opts?: { quiet?: boolean },
): Promise<boolean> {
  try {
    await jiraApi.moveSpecToStatus(ticketId, status)
    if (!opts?.quiet) toast.success(tj('moveToStatus.queued', { status }))
    return true
  } catch {
    if (!opts?.quiet) notifyError(tj('moveToStatus.failed'))
    return false
  }
}
