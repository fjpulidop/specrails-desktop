// Pure predicates over a PR delivery snapshot that the rail launch and
// checkout doors share: whether a launch continues or may revise the active
// delivery, whether the delivery holds settled work, and which exact commit
// (if any) the user may check out for review. No I/O.

import { isTerminalPrDecision, type PrDeliverySnapshot } from './rail-pr-store'

export function prDeliveryContinuesTickets(delivery: PrDeliverySnapshot, ticketIds: number[]): boolean {
  if (delivery.decision !== 'pr_draft' && delivery.decision !== 'pr_ready') return false
  if (delivery.executionManifest && delivery.repositoryDeliveries?.length) {
    const active = delivery.repositoryDeliveries.filter((repository) => !['merged', 'completed', 'no_changes'].includes(repository.decision))
    if (!active.length || active.some((repository) => !repository.prUrl || !repository.branch || !repository.deliverySha)) return false
  } else if (!delivery.prUrl || !delivery.branch || !delivery.deliverySha || delivery.prState !== 'pr-created') return false
  const covered = new Set(delivery.ticketIds)
  const requested = new Set(ticketIds)
  return requested.size > 0 && requested.size === covered.size && [...requested].every((id) => covered.has(id))
}

/**
 * Whether a launch may revise an undecided delivery. Deliberately strict:
 * the named id must BE the rail's active generation, that generation must still
 * be awaiting a decision (a terminal one is history, not revisable), and the
 * rail must still carry exactly the delivery's ticket set — a subset would
 * revise work the user never asked about while leaving the rest undecided.
 */
export function prDeliveryRevisionAllowed(
  delivery: PrDeliverySnapshot,
  revisionOfDeliveryId: string,
  ticketIds: number[],
): boolean {
  if (delivery.id !== revisionOfDeliveryId) return false
  if (isTerminalPrDecision(delivery.decision)) return false
  if (!hasDeliveredWork(delivery)) return false
  const covered = new Set(delivery.ticketIds)
  const requested = new Set(ticketIds)
  return requested.size > 0 && requested.size === covered.size && [...requested].every((id) => covered.has(id))
}

export function hasDeliveredWork(delivery: PrDeliverySnapshot): boolean {
  return Boolean((delivery.branch && delivery.deliverySha && ((delivery.prUrl && delivery.prState === 'pr-created') || (delivery.implementationOutcome !== 'failed' && delivery.deliveryOutcome !== 'blocked' && delivery.deliveryOutcome !== 'not_started' && delivery.deliveryOutcome !== 'no_changes')))
    || delivery.branches?.some(unit => unit.succeeded && unit.finalSha && unit.changed !== false && unit.implementationOutcome !== 'failed' && unit.deliveryOutcome !== 'blocked' && unit.deliveryOutcome !== 'not_started' && unit.deliveryOutcome !== 'no_changes')
    || delivery.repositoryDeliveries?.some(unit => unit.branch && unit.deliverySha && unit.implementationOutcome !== 'failed' && unit.deliveryOutcome !== 'blocked' && unit.deliveryOutcome !== 'not_started' && unit.deliveryOutcome !== 'no_changes'))
}

export function prDeliveryCheckoutTarget(delivery: PrDeliverySnapshot): { branch: string; sha: string } | null {
  if (delivery.branch && delivery.deliverySha) return { branch: delivery.branch, sha: delivery.deliverySha }
  // Before Create PR, a single settled unit already has an exact local result.
  // A batch must first be assembled: checking out its first branch would hide
  // the rest of the implementation.
  const units = delivery.branches
  if (!delivery.branch && !delivery.deliverySha && units.length === 1 && units[0].succeeded && units[0].finalSha &&
    units[0].deliveryOutcome !== 'blocked' && units[0].deliveryOutcome !== 'no_changes' &&
    units[0].implementationOutcome !== 'failed' && units[0].changed !== false) {
    return { branch: units[0].branch, sha: units[0].finalSha }
  }
  return null
}

export function prDeliveryCheckoutBlock(delivery: PrDeliverySnapshot): string | null {
  if (isTerminalPrDecision(delivery.decision) || delivery.decision === 'building' ||
    delivery.decision === 'implementation_failed' || delivery.decision === 'no_changes') {
    return 'delivery is not awaiting implementation review'
  }
  if (delivery.deliveryOutcome === 'blocked') {
    return 'delivery is blocked and has no safely checkoutable result'
  }
  const target = prDeliveryCheckoutTarget(delivery)
  if (!target || !/^[0-9a-f]{40,64}$/i.test(target.sha)) {
    return 'delivery has no verified commit available for checkout'
  }
  return null
}
