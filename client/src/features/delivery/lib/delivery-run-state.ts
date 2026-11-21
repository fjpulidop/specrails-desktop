// ─── A PR delivery in the run-state vocabulary ────────────────────────────────
// One table for every surface that shows a delivery decision (the mission's PR
// decision card, its compact pill, the rail's decision strip): which RunState a
// decision is in and, where it says WHAT the object is, its object glyph.
// The object glyph keeps its meaning across surfaces — GitBranch: a branch
// being built or waiting for review, GitPullRequest: an open PR, GitMerge:
// merged ONLY — and always takes the colour of its RunState.

import { GitBranch, GitMerge, GitPullRequest, MessageSquareWarning, Undo2, type LucideIcon } from 'lucide-react'
import type { RailPrDecision } from '../../../types'
import type { RunState } from '../../../components/ui/run-state/run-state'
import type { PrCiLiveState } from './pr-ci'

export interface DeliveryLook {
  state: RunState
  /** The object the decision is about, when the state's own glyph would not say it. */
  objectIcon: LucideIcon | null
}

export const DELIVERY_DECISION_LOOK = {
  building: { state: 'working', objectIcon: GitBranch },
  on_review: { state: 'review', objectIcon: GitBranch },
  pr_draft: { state: 'review', objectIcon: GitPullRequest },
  // Ready to decide on the open PR: review, never the merge glyph.
  pr_ready: { state: 'review', objectIcon: GitPullRequest },
  no_changes: { state: 'done', objectIcon: null },
  completed: { state: 'done', objectIcon: null },
  merged: { state: 'done', objectIcon: GitMerge },
  // Closed without merging, replaced by a newer delivery, or discarded.
  pr_closed: { state: 'stopped', objectIcon: null },
  superseded: { state: 'stopped', objectIcon: null },
  discarded: { state: 'stopped', objectIcon: null },
  implementation_failed: { state: 'failed', objectIcon: null },
  pr_failed: { state: 'failed', objectIcon: null },
} as const satisfies Record<RailPrDecision, DeliveryLook>

/**
 * Outcomes that say more than the decision column:
 * `changes` — the review still requests changes (an Intent → Spec run);
 * `returned` — the work went back to its Intent;
 * `stopped` — a person stopped the run before it delivered;
 * `crashed` — an Intent → Spec run failed outright; its work is intact and
 *   goes back to the Intent with the error, so it is blocked, not lost.
 */
export type DeliveryOverride = 'changes' | 'returned' | 'stopped' | 'crashed'

export const DELIVERY_OVERRIDE_LOOK = {
  changes: { state: 'blocked', objectIcon: MessageSquareWarning },
  returned: { state: 'stopped', objectIcon: Undo2 },
  stopped: { state: 'stopped', objectIcon: null },
  crashed: { state: 'blocked', objectIcon: null },
} as const satisfies Record<DeliveryOverride, DeliveryLook>

export function deliveryLook(decision: RailPrDecision, override: DeliveryOverride | null = null): DeliveryLook {
  return override ? DELIVERY_OVERRIDE_LOOK[override] : DELIVERY_DECISION_LOOK[decision]
}

/** The override a delivery's own codes imply (the flow outcome is computed by its card). */
export function deliveryOverrideOf(input: {
  decision: RailPrDecision
  statusCode?: string | null
  flowOutcome?: 'changes' | 'crashed' | 'returned' | null
}): DeliveryOverride | null {
  if (input.flowOutcome) return input.flowOutcome
  if (input.decision === 'implementation_failed' && input.statusCode === 'review_changes_requested') return 'changes'
  if (input.decision === 'implementation_failed' && input.statusCode === 'run_stopped') return 'stopped'
  return null
}

/** The CI outcome of a delivery's open PR. */
export type PrCiOutcome = Extract<PrCiLiveState, 'green' | 'red' | 'pending' | 'conflict'>

export const CI_RUN_STATE = {
  green: 'done',
  // Checks still running: work in progress, a lamp — never a spinner.
  pending: 'working',
  // Not green / a merge conflict: the PR cannot land until something changes.
  red: 'blocked',
  conflict: 'blocked',
} as const satisfies Record<PrCiOutcome, RunState>

export function ciRunState(outcome: PrCiOutcome): RunState {
  return CI_RUN_STATE[outcome]
}
