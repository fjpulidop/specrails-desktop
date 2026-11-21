import type { InboxItem } from '../../inbox/lib/inbox-model'
import type { InterruptedRun, ResumeOffer } from '../../../lib/continuity-api'

/**
 * Rail/loop runs the last restart interrupted, as their Inbox items: the runs
 * that were running when the app stopped (recorded at the graceful shutdown)
 * that startup recovery left paused for a restart. Their Resume is the
 * Inbox's own action.
 */
export function interruptedRunItems(items: readonly InboxItem[], runs: readonly InterruptedRun[]): InboxItem[] {
  if (runs.length === 0) return []
  const keys = new Set(runs.map((run) => `${run.projectId}\u0000${run.runId}`))
  return items.filter((item) => item.kind === 'blocked' && item.detail === 'interrupted' && item.action === 'resume-run' && keys.has(`${item.projectId}\u0000${item.subjectId}`))
}

/** Idempotent per interrupted turn: a double click or a retry never sends twice. */
export function resumeQueueId(offer: Pick<ResumeOffer, 'conversationId' | 'startedAt'>): string {
  return `resume-${offer.conversationId}-${Date.parse(offer.startedAt) || 0}`
}
