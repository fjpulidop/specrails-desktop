import type { CiFixState } from '../../../modules/delivery'
import type { peekMergePreview } from '../../../modules/delivery/runtime/merge-preview'
import { isTerminalPrDecision, type PrDeliverySnapshot } from '../../../modules/delivery/runtime/rail-pr-store'
import { prDeliveryCheckoutBlock, prDeliveryRevisionAllowed } from '../../../modules/delivery/runtime/rail-delivery-revision'
import type { AcceptTarget } from '../../../modules/execution/runtime/accept-ladder'
import { projectDelivery } from '../core/decision-sources'
import type { DecisionStateInput, OfferDraft } from '../core/decision-state'
import type { Ref } from '../core/refs'
import { statusFromDelivery } from '../core/status-map'

/**
 * Decision state of one PR delivery (WP4). Pure: the tool gathers the facts,
 * this file only combines the server's own legality rules:
 *
 * - PR decisions and the CI offer: `projectDelivery` (decision-policy.ts
 *   `actionAllowed`, `ciFixAllowed`), recommended per design §3.
 * - request changes: rail-delivery-revision.ts `prDeliveryRevisionAllowed`
 *   (the rail's active generation, its exact ticket set).
 * - checkout: `prDeliveryCheckoutBlock` (the route's own guard) on the active generation.
 * - refresh on base: the refresh route's preconditions that need no Git
 *   (`on_review`, single repository) plus a merge preview that found conflicts.
 * - local changes: the stash and restore-branch states local-changes.ts acts on.
 *
 * While a decision-side operation holds the row the server refuses every
 * action (`operation_in_progress`), so no offer is made until it lands.
 */

const DELIVERIES = 'specrails_deliveries'

/** The live board's merge preview summary (merge-preview.ts). */
export type MergePreviewSummary = NonNullable<ReturnType<typeof peekMergePreview>>
export interface DeliveryStateFacts {
  snap: PrDeliverySnapshot
  /** The rail's active (newest non-terminal) generation is this delivery. */
  active: boolean
  /** Tickets the rail carries now (revision legality). */
  railTicketIds: readonly number[]
  /** CI loop facts; null when the CI loop is unavailable on this machine. */
  ci?: CiFixState | null
  /** Last merge preview of this delivery into its base; null when unknown. */
  mergePreview?: MergePreviewSummary | null
  /** What "Accept" does in this repository (accept-ladder.ts); null when unknown. */
  accept?: AcceptTarget | null
  /** `on_review_at` / `updated_at`: since when the decision waits. */
  since?: string | null
}

const decideCall = (ref: Ref, decision: string, extra: Record<string, unknown> = {}) =>
  ({ tool: DELIVERIES, args: { action: 'decide', ref, decision, ...extra } })

/** WP4 offers on top of the PR decisions: revision, checkout, base refresh, local changes. */
export function deliveryExtraOffers(ref: Ref, facts: DeliveryStateFacts): OfferDraft[] {
  const { snap } = facts
  const offers: OfferDraft[] = []
  if (facts.active && prDeliveryRevisionAllowed(snap, snap.id, [...facts.railTicketIds])) {
    offers.push({ id: 'decide.request_changes', labelKey: 'deliveries.offer.request_changes', call: decideCall(ref, 'request_changes'), needs: ['note'] })
  }
  const checkoutOk = snap.executionManifest
    ? !isTerminalPrDecision(snap.decision) && snap.decision !== 'building'
    : prDeliveryCheckoutBlock(snap) === null
  if (facts.active && checkoutOk) offers.push({ id: 'decide.checkout', labelKey: 'deliveries.offer.checkout', call: decideCall(ref, 'checkout') })
  if (snap.decision === 'on_review' && !snap.executionManifest && facts.mergePreview?.status === 'conflicts') {
    offers.push({ id: 'decide.refresh_on_base', labelKey: 'deliveries.offer.refresh_on_base', call: decideCall(ref, 'refresh_on_base') })
  }
  const stash = snap.localStash
  if (stash) {
    if (stash.state === 'saved' || stash.state === 'needs_attention') {
      offers.push({ id: 'decide.local_restore', labelKey: 'deliveries.offer.local_restore', call: decideCall(ref, 'local_restore') })
    }
    const restore = stash.restore
    if (restore?.status === 'ready' && restore.commitSha) {
      offers.push({ id: 'decide.local_bring_back', labelKey: 'deliveries.offer.local_bring_back', call: decideCall(ref, 'local_bring_back') })
    }
    if (restore && (restore.status === 'ready' || restore.status === 'failed')) {
      offers.push({ id: 'decide.local_discard_branch', labelKey: 'deliveries.offer.local_discard_branch', call: decideCall(ref, 'local_discard_branch') })
    }
  }
  return offers
}

/** The DecisionStateInput of a delivery (localized and versioned by `ctx.v2.state`). */
export function projectDeliveryState(ref: Ref, facts: DeliveryStateFacts): DecisionStateInput {
  const { snap } = facts
  const row = {
    decision: snap.decision, delivery_outcome: snap.deliveryOutcome, implementation_outcome: snap.implementationOutcome,
    status_code: snap.statusCode, is_continuation: snap.isContinuation ? 1 : 0, pr_url: snap.prUrl, branch: snap.branch,
  }
  const projected = projectDelivery(ref, row, {
    ci: facts.ci ?? null,
    mergePreviewClean: facts.mergePreview?.status === 'clean',
    prefersLocal: facts.accept === 'merge-local',
    deliversByPr: facts.accept === 'create-pr',
  }, facts.since ?? null)
  const busy = snap.operation !== null
  const offers = busy ? [] : [...projected.offers, ...deliveryExtraOffers(ref, facts)]
  // The chain's own rule before it pauses on an integration conflict: bring the base in first.
  const recommended = busy ? undefined
    : projected.recommended ?? (offers.some((offer) => offer.id === 'decide.refresh_on_base') ? 'decide.refresh_on_base' : undefined)
  const stash = snap.localStash
  return {
    status: statusFromDelivery(snap.decision),
    ...(busy ? { phase: `operation · ${snap.operation}` } : {}),
    hold: projected.hold ?? null,
    offers,
    recommended: recommended ?? null,
    versionFacts: {
      d: snap.decision, u: snap.updatedAt, sha: snap.deliverySha, pr: snap.prUrl, op: snap.operation, active: facts.active,
      ls: stash ? [stash.state, stash.restore?.status ?? null, stash.restore?.commitSha ?? null] : null,
    },
  }
}
