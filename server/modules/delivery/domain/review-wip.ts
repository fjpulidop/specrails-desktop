import type { PrDecision } from './state'

/**
 * Review WIP limit (review-wip-limit): how many deliveries may wait for the
 * user's review at once. Pure: callers supply the snapshot and the limit.
 *
 * A delivery counts while it is, or is about to become, review work for a
 * human:
 *
 * - `building`  — admitted and running; it lands on review when it settles.
 *                 Counting it is what makes the cap hold under parallel
 *                 launches (otherwise Launch all could overshoot it).
 * - `on_review` — settled, awaiting the Create PR / Discard decision.
 * - `pr_draft` / `pr_ready` — a PR the app created (or continued) that is not
 *                 merged or closed yet; it still needs the user's review.
 *
 * Not counted: `no_changes` (nothing to review — acknowledge only),
 * `implementation_failed` / `pr_failed` (no reviewable result; they need a
 * retry or discard, and a retry of the same delivery is exempt anyway),
 * `pr_closed` (closed on GitHub), and every terminal decision.
 *
 * Only top-level rows count: the per-repository children of a grouped
 * delivery are one review item with their parent.
 */
export const REVIEW_WIP_DECISIONS: ReadonlySet<PrDecision> = new Set<PrDecision>(['building', 'on_review', 'pr_draft', 'pr_ready'])

/** The narrow delivery facts the count needs; no SQLite row leaks in. */
export interface ReviewWipDelivery {
  id: string
  railIndex: number
  ticketIds: number[]
  decision: PrDecision
  /** Group parent id for a per-repository child row; null for top-level rows. */
  parentDeliveryId: string | null
  /** When the delivery was admitted (ISO). */
  createdAt: string
}

export interface PendingReviewItem {
  deliveryId: string
  railIndex: number
  ticketIds: number[]
  decision: PrDecision
  /** When the delivery entered the review pipeline (its admission time). */
  since: string
}

/** The pending review items, oldest first. */
export function listPendingReview(deliveries: readonly ReviewWipDelivery[]): PendingReviewItem[] {
  return deliveries
    .filter((row) => row.parentDeliveryId === null && REVIEW_WIP_DECISIONS.has(row.decision))
    .map((row) => ({ deliveryId: row.id, railIndex: row.railIndex, ticketIds: [...row.ticketIds], decision: row.decision, since: row.createdAt }))
    .sort((a, b) => a.since.localeCompare(b.since) || a.railIndex - b.railIndex)
}

/** How many deliveries currently count against the review WIP limit. */
export function countPendingReview(deliveries: readonly ReviewWipDelivery[]): number {
  return listPendingReview(deliveries).length
}

/** A limit is a positive integer; null (or anything else) means no limit. */
export function normalizeReviewWipLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null
}

/**
 * Whether a rail launch would add a NEW delivery to review. Continuations of
 * an existing delivery do not: they revise, retry or continue work that was
 * already admitted under the limit (and supersede or reuse its review slot).
 *
 * - `revisionOfDeliveryId`: a change request on an undecided delivery.
 * - `relaunchOfDelivery`: Relaunch of a recorded delivery attempt.
 * - `targetsExistingPr`: delivery into an existing open PR (explicit target or
 *   a PR review follow-up) — the review item is that PR.
 * - `railHasActiveDelivery`: the rail still owns a non-terminal delivery. The
 *   launch route only lets such a launch through as that delivery's
 *   continuation (PR continuation, addenda, failed-attempt retry) and refuses
 *   anything else with `pr_decision_pending`, so it never adds an item.
 */
export interface ReviewWipLaunch {
  revisionOfDeliveryId?: string | null
  relaunchOfDelivery?: boolean
  targetsExistingPr?: boolean
  railHasActiveDelivery?: boolean
}

export function launchAddsReviewWip(launch: ReviewWipLaunch): boolean {
  return !(launch.revisionOfDeliveryId || launch.relaunchOfDelivery || launch.targetsExistingPr || launch.railHasActiveDelivery)
}

/** The stable 409 body every launch door returns while the limit is reached. */
export interface ReviewWipRejection {
  error: 'review_wip_limit_reached'
  limit: number
  pending: Array<{ deliveryId: string; railIndex: number; ticketIds: number[]; since: string }>
  detail: string
  action: string
}

/**
 * The admission decision. `reserved` counts launches already admitted by this
 * project but whose delivery row is not written yet (parallel launches).
 */
export function evaluateReviewWip(input: {
  limit: number | null
  pending: readonly PendingReviewItem[]
  reserved?: number
  addsWip: boolean
}): ReviewWipRejection | null {
  if (!input.addsWip || input.limit === null) return null
  const occupied = input.pending.length + (input.reserved ?? 0)
  if (occupied < input.limit) return null
  return reviewWipRejection(input.limit, input.pending)
}

export function reviewWipRejection(limit: number, pending: readonly PendingReviewItem[]): ReviewWipRejection {
  return {
    error: 'review_wip_limit_reached',
    limit,
    pending: pending.map(({ deliveryId, railIndex, ticketIds, since }) => ({ deliveryId, railIndex, ticketIds: [...ticketIds], since })),
    detail: `${pending.length} ${pending.length === 1 ? 'delivery is' : 'deliveries are'} waiting for review; this project allows ${limit} at a time. Nothing was launched.`,
    action: 'Decide a pending delivery (Create PR, merge or discard), or raise the limit in Project settings ▸ Review limit.',
  }
}
