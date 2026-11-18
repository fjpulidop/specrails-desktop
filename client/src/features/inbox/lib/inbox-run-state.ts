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
} as const satisfies Record<InboxKind, RunState>

export function inboxKindRunState(kind: InboxKind): RunState {
  return INBOX_KIND_RUN_STATE[kind]
}
