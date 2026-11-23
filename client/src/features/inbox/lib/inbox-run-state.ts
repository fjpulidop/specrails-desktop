// ─── An inbox item's kind in the run-state vocabulary ─────────────────────────

import type { RunState } from '../../../components/ui/run-state/run-state'
import type { InboxKind } from './inbox-model'

export const INBOX_KIND_RUN_STATE = {
  question: 'needs-input',
  review: 'review',
  failed: 'failed',
  blocked: 'blocked',
  // A reached spend cap paused the work until the cap moves (the row keeps its "cap reached" words).
  budget: 'paused',
  // A Jira write that could not go out: waits on the integration.
  jira: 'blocked',
  // A milestone chain stopped between or on a rail: paused until the person resumes it.
  chain: 'paused',
  // A mission card (launch proposal, Intent or CI-fix offer) waits on the person's decision.
  mission: 'needs-input',
} as const satisfies Record<InboxKind, RunState>

export function inboxKindRunState(kind: InboxKind): RunState {
  return INBOX_KIND_RUN_STATE[kind]
}

/** A run held by a restart, an interruption or a plain pause (`held:<kind>`) is paused, not blocked. */
export function inboxItemRunState(item: { kind: InboxKind; detail: string | null; chain?: { status: string } | null }): RunState {
  // A chain at a checkpoint waits for the person's go-ahead (a review of what the last rail delivered).
  if (item.kind === 'chain' && item.chain?.status === 'awaiting_approval') return 'review'
  // A provider's usage limit (`usage_limit:<provider>:…`) is outside the person's hands: blocked, as in the run window.
  if (item.kind === 'budget' && item.detail?.startsWith('usage_limit:')) return 'blocked'
  return item.kind === 'blocked' && item.detail?.startsWith('held:') ? 'paused' : INBOX_KIND_RUN_STATE[item.kind]
}
