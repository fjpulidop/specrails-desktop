import type { LocalTicket, TicketPriority, TicketStatus } from '../../../types'

/** Where a bulk "Move to" sends the selection: a local status or a Jira workflow status. */
export type BulkStatusTarget =
  | { kind: 'local'; status: TicketStatus }
  | { kind: 'jira'; status: string }

/**
 * What the board needs from its host (the dashboard) to act on a selection.
 * Each member runs the SAME per-item handler the single-spec UI uses, so Jira
 * outbox moves, undo, rail gating, spawn admission and the budget guard apply
 * unchanged. The board never reaches the network itself.
 */
export interface SpecBulkHandlers {
  jiraConnected: boolean
  /** Workflow status names of the connected Jira board. */
  loadJiraStatuses: () => Promise<string[]>
  allLabels: readonly string[]
  onStatus: (ids: number[], target: BulkStatusTarget) => Promise<void>
  onLabel: (ids: number[], label: string, mode: 'add' | 'remove') => Promise<void>
  onPriority: (ids: number[], priority: TicketPriority) => Promise<void>
  onMoveToRail: (ids: number[], railId: string) => void
  /** Confirms (LaunchAllDialog + budget guard) and starts the selection. */
  onLaunch: (ids: number[]) => void
  onDelete: (ids: number[]) => Promise<void>
}

export const BULK_PRIORITIES: readonly TicketPriority[] = ['critical', 'high', 'medium', 'low']

/** Labels carried by at least one of the specs, sorted. */
export function labelsOf(tickets: readonly LocalTicket[]): string[] {
  const set = new Set<string>()
  for (const t of tickets) for (const l of t.labels ?? []) set.add(l)
  return [...set].sort()
}
