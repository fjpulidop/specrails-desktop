/**
 * `decision` is the user/action lifecycle only. Execution truth and delivery
 * readiness are deliberately orthogonal columns below: a successful agent run
 * can have a blocked commit/ref stage, and an open PR can be unchanged.
 */
export type PrDecision =
  | 'building'
  | 'on_review'
  | 'no_changes'
  | 'pr_draft'
  | 'pr_ready'
  | 'pr_closed'
  | 'completed'
  | 'merged'
  | 'discarded'
  | 'superseded'
  | 'implementation_failed'
  | 'pr_failed'

/** How far a Create-PR attempt got (the pr-publisher degradation ladder), independent of `decision`. */
export type PrDeliveryState = 'none' | 'local-only' | 'pushed' | 'pr-created'

/** Which surface launched the rail; `agent-chat` rows carry an origin_conversation_id. */
export type PrOriginSurface = 'dashboard' | 'agent-chat'

/** The engine's immutable aggregate result — never derived from Git delivery. */
export type PrImplementationOutcome =
  | 'running'
  | 'succeeded'
  | 'partially_succeeded'
  | 'failed'
  | 'unknown'

/** How far the verified result can safely progress through delivery. */
export type PrDeliveryOutcome =
  | 'pending'
  | 'ready'
  | 'delivered'
  | 'partial'
  | 'no_changes'
  | 'retryable_failure'
  | 'blocked'
  | 'not_started'
  | 'unknown'

/** Stable machine reason; clients localize these rather than raw git stderr. */
export type PrDeliveryStatusCode =
  | 'implementation_running'
  | 'implementation_failed'
  | 'ready_for_review'
  | 'partial_success'
  | 'partial_delivery'
  | 'existing_pr_updated'
  | 'no_changes'
  | 'commit_failed'
  | 'branch_verification_failed'
  | 'push_failed'
  | 'settlement_interrupted'
  | 'recovery_unavailable'
  | 'operation_interrupted'
  | 'delivery_failed'
  | 'pr_draft_ready'
  | 'pr_ready'
  | 'pr_closed'
  | 'merged'
  | 'discarded'
  | 'superseded'
  | 'cleanup_incomplete'

export type PrDecisionOperation = 'checkout' | 'create-pr' | 'publish' | 'discard' | 'dismiss' | 'poll-merge' | 'reopen' | 'merge-local' | 'acknowledge-no-changes' | 'recover-and-retry'

