// Plan of a bulk "Launch all" from the specs board (CD4).
//
// A spec on the board is not on a rail yet, so launching a selection means
// giving each spec its own free rail (empty, idle, no pending PR decision) and
// starting those rails in parallel: the same fan-out, isolation and admission
// as the rails header's Launch all. Pure: the caller supplies the gates.

export interface PlannableRail {
  id: string
  status: string
  ticketIds: readonly number[]
}

export type BulkLaunchSkip = 'blocked' | 'noRail' | 'reviewLimit'

export interface BulkLaunchPlan {
  /** One spec per free rail, in selection order. */
  assignments: { railId: string; ticketId: number }[]
  skipped: { ticketId: number; reason: BulkLaunchSkip }[]
}

export interface BulkLaunchGates {
  /** Why the spec cannot launch now (on_review without an open PR...), or null. */
  blockerOf: (ticketId: number) => string | null
  /** The rail holds an unresolved PR decision; it must be decided first. */
  hasPendingDecision: (railId: string) => boolean
  /** Whether launching this rail adds a NEW delivery awaiting review (takes a WIP slot). */
  takesReviewSlot: (railId: string) => boolean
  /** Slots left under the review WIP limit (Infinity when there is no limit). */
  reviewCapacity: number
}

export function planBulkLaunch(ticketIds: readonly number[], rails: readonly PlannableRail[], gates: BulkLaunchGates): BulkLaunchPlan {
  const free = rails.filter((r) => r.status !== 'running' && r.ticketIds.length === 0 && !gates.hasPendingDecision(r.id))
  const plan: BulkLaunchPlan = { assignments: [], skipped: [] }
  let capacity = gates.reviewCapacity
  let next = 0
  for (const ticketId of ticketIds) {
    if (gates.blockerOf(ticketId) !== null) {
      plan.skipped.push({ ticketId, reason: 'blocked' })
      continue
    }
    const rail = free[next]
    if (!rail) {
      plan.skipped.push({ ticketId, reason: 'noRail' })
      continue
    }
    if (gates.takesReviewSlot(rail.id)) {
      if (capacity <= 0) {
        plan.skipped.push({ ticketId, reason: 'reviewLimit' })
        continue
      }
      capacity -= 1
    }
    next += 1
    plan.assignments.push({ railId: rail.id, ticketId })
  }
  return plan
}
