import type { PrDecision, PrDeliveryOutcome, PrImplementationOutcome, PrDeliveryStatusCode } from './state'

export const PR_DECISION_ACTIONS = ['create-pr', 'publish', 'discard', 'dismiss', 'poll-merge', 'reopen', 'merge-local', 'acknowledge-no-changes', 'recover-and-retry'] as const
export type PrDecisionAction = (typeof PR_DECISION_ACTIONS)[number]

/** Minimal facts needed to decide legality; no database row/connection leaks in. */
export interface DeliveryDecisionState {
  decision: PrDecision
  delivery_outcome: PrDeliveryOutcome
  implementation_outcome: PrImplementationOutcome
  status_code: PrDeliveryStatusCode | null
  is_continuation: number
  pr_url: string | null
  branch: string | null
}

export function isPrDecisionAction(v: unknown): v is PrDecisionAction {
  return typeof v === 'string' && (PR_DECISION_ACTIONS as readonly string[]).includes(v)
}

/**
 * The D3 state machine's action legality. `create-pr` is also the RETRY path:
 * from a retryable pr_failed, or from a pr_draft whose delivery degraded before
 * a PR existed (pushed/local-only → pr_url null). Publish/poll require a real
 * PR URL — a degraded draft only offers retry or discard.
 */
export function actionAllowed(action: PrDecisionAction, row: DeliveryDecisionState): boolean {
  switch (action) {
    case 'create-pr':
      return row.decision === 'on_review' ||
        (row.decision === 'pr_failed' && (row.delivery_outcome === 'retryable_failure' || row.delivery_outcome === 'unknown')) ||
        (row.decision === 'pr_draft' && row.pr_url === null)
    case 'publish':
      return row.decision === 'pr_draft' && row.pr_url !== null
    case 'discard':
      return row.decision === 'on_review' || row.decision === 'pr_draft' ||
        row.decision === 'pr_ready' || row.decision === 'pr_closed' || row.decision === 'no_changes' ||
        row.decision === 'implementation_failed' ||
        row.decision === 'pr_failed'
    case 'dismiss':
      return row.is_continuation === 1 && row.decision !== 'building' &&
        row.decision !== 'merged' && row.decision !== 'discarded' && row.decision !== 'superseded'
    case 'poll-merge':
      return (row.decision === 'pr_draft' || row.decision === 'pr_ready' || row.decision === 'pr_closed') && row.pr_url !== null
    case 'reopen':
      return row.decision === 'pr_closed' && row.pr_url !== null
    case 'merge-local':
      // Remote-less acceptance ONLY: once a real PR exists (pr_url), GitHub is
      // the merge authority — merging under an open PR would leave it dangling.
      return row.pr_url === null &&
        (row.decision === 'on_review' || row.decision === 'pr_failed' || row.decision === 'pr_draft')
    case 'acknowledge-no-changes':
      return row.decision === 'no_changes' && row.is_continuation !== 1
    case 'recover-and-retry':
      return row.decision === 'pr_failed' && row.delivery_outcome === 'blocked' &&
        (row.status_code === 'settlement_interrupted' || row.status_code === 'recovery_unavailable') &&
        row.is_continuation === 1 &&
        (row.implementation_outcome === 'succeeded' || row.implementation_outcome === 'partially_succeeded') &&
        row.pr_url !== null && row.branch !== null
  }
}


/** One repository delivery of a multi-repository generation (pr-ci-loop). */
export interface CiFixRepositoryState {
  decision: string
  pr_url: string | null
  branch: string | null
  delivery_sha: string | null
  operation: string | null
}

/** Facts for the PR CI loop offer and its "Fix CI" action (pr-ci-loop). */
export interface CiFixState extends DeliveryDecisionState {
  /** A decision-side Git/GitHub operation currently holds the row. */
  operation: string | null
  /** Multi-repository generations: one delivery (and PR) per repository; absent for a single repository. */
  repositories?: readonly CiFixRepositoryState[] | null
}

const SETTLED_REPOSITORY = new Set(['merged', 'completed', 'no_changes'])

/** Repository deliveries whose PR the CI loop would watch (the ones still under review). */
export function ciFixActiveRepositories<T extends CiFixRepositoryState>(repositories: readonly T[]): T[] {
  return repositories.filter(repository => !SETTLED_REPOSITORY.has(repository.decision))
}

/**
 * `factory:pr-ci` may start on attached, same-repository PRs that are still
 * awaiting the person's decision (draft or ready), with no operation in flight.
 * A multi-repository generation qualifies when every repository still under
 * review has its PR (the ordinary multi-repository continuation contract).
 * Liveness (OPEN, not a fork) is proven against GitHub by the launch itself.
 */
export function ciFixAllowed(row: CiFixState): boolean {
  if ((row.decision !== 'pr_draft' && row.decision !== 'pr_ready') || row.operation !== null) return false
  if (!row.repositories) return row.pr_url !== null && row.branch !== null
  const active = ciFixActiveRepositories(row.repositories)
  return active.length > 0 && active.every(repository => repository.pr_url !== null && repository.branch !== null && repository.delivery_sha !== null &&
    repository.operation === null && (repository.decision === 'pr_draft' || repository.decision === 'pr_ready'))
}
