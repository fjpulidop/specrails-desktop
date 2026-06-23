// Status / transition resolution — the hard part of the integration.
//
// Jira issues have no settable `status`; you must apply workflow-gated
// transitions, and the customer's workflow is arbitrary. The 4 logical Specrails
// states map onto N customer statuses across only 3 stable categories
// (new / indeterminate / done). Strategy:
//   1. Explicit per-project status map (user picks the target status) wins.
//   2. Category fallback anchored on `statusCategory.key` (never the localizable
//      status NAME), with a cancel/ship lexicon to disambiguate the `done`
//      category (e.g. `Won't Do` vs `Released`).
//   3. BFS transition walk for forward-only workflows where there is no direct
//      edge to the target category.
//
// This module is PURE: the walker takes async callbacks (getTransitions /
// applyTransition) so it is fully testable without HTTP.

import type { JiraStatusCategory, JiraTransition, SpecLogicalState } from './types'

// 'discard' covers "Discard"/"Discarded" — a rejection status, never a success
// target. Without it the success resolver treated "Discarded" as a valid ship
// target and a completed job could be sent there (the reported Done→Discarded bug).
const CANCEL_LEXICON = ['won\'t do', 'wont do', 'cancelled', 'canceled', 'rejected', 'abandoned', 'invalid', 'duplicate', 'declined', 'discard']
const SHIP_LEXICON = ['done', 'closed', 'released', 'resolved', 'complete', 'completed', 'shipped', 'merged']

export function targetCategoryFor(state: SpecLogicalState): JiraStatusCategory {
  switch (state) {
    case 'todo':
      return 'new'
    case 'in_progress':
      return 'indeterminate'
    case 'done':
    case 'cancelled':
      return 'done'
  }
}

export function categoryRank(cat: JiraStatusCategory): number {
  return cat === 'new' ? 0 : cat === 'indeterminate' ? 1 : 2
}

function nameMatches(name: string | undefined, lexicon: string[]): boolean {
  if (!name) return false
  const n = name.toLowerCase()
  return lexicon.some((w) => n.includes(w))
}

/** A status whose NAME reads as a cancellation/rejection (e.g. "Discarded",
 *  "Won't Do"). A successful (done) outcome must never auto-land on one of these. */
function isCancelName(name: string | undefined): boolean {
  return nameMatches(name, CANCEL_LEXICON)
}

function transitionCategory(t: JiraTransition): JiraStatusCategory | null {
  const k = t.to.statusCategory?.key
  if (k === 'new' || k === 'indeterminate' || k === 'done') return k
  return null
}

/**
 * Pick the best transition that lands directly in the target category.
 * - Explicit map (status id or name) wins.
 * - Else category match, disambiguated by lexicon for the `done` category.
 * Returns null when no transition lands directly in the target category.
 */
export function pickDirectTransition(
  transitions: JiraTransition[],
  state: SpecLogicalState,
  explicitTarget?: string
): JiraTransition | null {
  if (explicitTarget) {
    const e = explicitTarget.toLowerCase()
    const t = transitions.find(
      (tr) => tr.to.id === explicitTarget || tr.to.name.toLowerCase() === e || tr.id === explicitTarget
    )
    if (t) return t
    // The user explicitly configured a target status (e.g. statusMap.done =
    // "On Review") but there is no direct edge to it from here. NEVER substitute
    // a different status from the target category — silently sending a completed
    // job to some other done status (e.g. "Discarded") is exactly the bug this
    // guards against. Signal "no direct" so the walker steps forward and looks
    // for the configured target on the next hop, or dead-letters cleanly.
    return null
  }
  const target = targetCategoryFor(state)
  const candidates = transitions.filter((t) => transitionCategory(t) === target)
  if (candidates.length === 0) return null
  if (target !== 'done') return candidates[0]

  // Disambiguate the `done` category: cancelled prefers the cancel lexicon and
  // avoids ship words; done/success prefers ship words and avoids cancel words.
  if (state === 'cancelled') {
    // No explicit cancel status → do NOT fall back to a generic Done (that would
    // mark a cancelled spec as shipped). Signal "no suitable transition".
    return candidates.find((t) => isCancelName(t.to.name)) ?? null
  }
  // success
  const ship = candidates.find((t) => nameMatches(t.to.name, SHIP_LEXICON) && !isCancelName(t.to.name))
  if (ship) return ship
  // Never auto-ship a successful job onto a cancel/reject status (e.g.
  // "Discarded"). If every available done transition is a reject status, signal
  // "no suitable transition" so the walk dead-letters rather than marking
  // success as rejected.
  return candidates.find((t) => !isCancelName(t.to.name)) ?? null
}

/**
 * Pick a transition that moves the issue closer to the target category (used by
 * the BFS walk when no direct transition exists). Returns the edge whose target
 * category is strictly closer (in rank distance) to the goal, never overshooting
 * past it, preferring the smallest forward step.
 */
export function pickProgressTransition(
  transitions: JiraTransition[],
  currentCategory: JiraStatusCategory,
  targetCategory: JiraStatusCategory,
  visitedStatusIds: Set<string>,
  opts?: { avoidCancelNames?: boolean }
): JiraTransition | null {
  const goal = categoryRank(targetCategory)
  const cur = categoryRank(currentCategory)
  const dir = Math.sign(goal - cur) // +1 forward, -1 backward
  if (dir === 0) return null
  let best: JiraTransition | null = null
  let bestRank = cur
  for (const t of transitions) {
    if (visitedStatusIds.has(t.to.id)) continue
    // During a non-cancel walk never STEP onto a reject status (e.g. a
    // done-category "Discarded"): it would terminate the issue in the wrong
    // place. Better to dead-letter than overshoot onto a cancellation.
    if (opts?.avoidCancelNames && isCancelName(t.to.name)) continue
    const cat = transitionCategory(t)
    if (!cat) continue
    const rank = categoryRank(cat)
    // Must move in the goal direction and not overshoot.
    const movesTowardGoal = dir > 0 ? rank > cur && rank <= goal : rank < cur && rank >= goal
    if (!movesTowardGoal) continue
    // Prefer the edge that gets us furthest toward the goal without overshooting.
    if (best === null || (dir > 0 ? rank > bestRank : rank < bestRank)) {
      best = t
      bestRank = rank
    }
  }
  return best
}

export interface TransitionFieldPlan {
  /** Fields object to POST with the transition (resolution etc.), or undefined. */
  fields?: Record<string, unknown>
  /** When set, the transition cannot be satisfied programmatically. */
  blockedReason?: string
}

/**
 * Build the `fields` payload for a transition that has a screen. Sets
 * `resolution` (Done for success / a cancel value for cancelled) only when it is
 * on the transition screen. If a required field with no default cannot be
 * synthesised, returns `blockedReason` so the caller dead-letters instead of
 * guessing values.
 */
export function buildTransitionFields(transition: JiraTransition, state: SpecLogicalState): TransitionFieldPlan {
  const screenFields = transition.fields ?? {}
  const out: Record<string, unknown> = {}

  for (const [key, field] of Object.entries(screenFields)) {
    if (key === 'resolution') {
      const allowed = field.allowedValues ?? []
      const wantCancel = state === 'cancelled'
      const pick = wantCancel
        ? allowed.find((v) => nameMatches(v.name ?? v.value, CANCEL_LEXICON)) ?? allowed[0]
        : allowed.find((v) => nameMatches(v.name ?? v.value, SHIP_LEXICON)) ?? allowed[0]
      if (pick) out.resolution = pick.id ? { id: pick.id } : { name: pick.name ?? pick.value }
      continue
    }
    // Any OTHER required field without a default that we cannot synthesise blocks us.
    if (field.required && !field.hasDefaultValue) {
      return { blockedReason: `transition requires field "${field.name ?? key}" with no default` }
    }
  }
  return Object.keys(out).length > 0 ? { fields: out } : {}
}

export type WalkOutcome =
  | { status: 'noop' }
  | { status: 'applied'; finalCategory: JiraStatusCategory; transitions: string[] }
  | { status: 'no_path'; reason: string }
  | { status: 'blocked'; reason: string }
  | { status: 'error'; reason: string }

/**
 * Walk the transition graph from the current category to the target category for
 * `state`, applying edges per hop (you can only see the current status's
 * outgoing edges). Idempotency-first: if already in the target category, no-op.
 */
export async function walkToCategory(args: {
  state: SpecLogicalState
  currentCategory: JiraStatusCategory
  explicitTarget?: string
  maxHops?: number
  getTransitions: () => Promise<JiraTransition[]>
  applyTransition: (transition: JiraTransition, plan: TransitionFieldPlan) => Promise<void>
}): Promise<WalkOutcome> {
  const target = targetCategoryFor(args.state)
  if (args.currentCategory === target) return { status: 'noop' }

  const maxHops = args.maxHops ?? 5
  const visited = new Set<string>()
  const applied: string[] = []
  let currentCategory = args.currentCategory

  for (let hop = 0; hop < maxHops; hop++) {
    let transitions: JiraTransition[]
    try {
      transitions = await args.getTransitions()
    } catch (err) {
      return { status: 'error', reason: err instanceof Error ? err.message : String(err) }
    }

    // Try a direct transition into the target category first.
    const direct = pickDirectTransition(transitions, args.state, args.explicitTarget)
    if (direct) {
      const plan = buildTransitionFields(direct, args.state)
      if (plan.blockedReason) return { status: 'blocked', reason: plan.blockedReason }
      try {
        await args.applyTransition(direct, plan)
      } catch (err) {
        return { status: 'error', reason: err instanceof Error ? err.message : String(err) }
      }
      applied.push(direct.id)
      return { status: 'applied', finalCategory: target, transitions: applied }
    }

    // No direct edge → step toward the target category. For any non-cancel walk
    // the step must avoid reject statuses so the issue never overshoots onto a
    // "Discarded"-style terminal status while reaching for the real target.
    const step = pickProgressTransition(transitions, currentCategory, target, visited, {
      avoidCancelNames: args.state !== 'cancelled',
    })
    if (!step) {
      return {
        status: 'no_path',
        reason: `no workflow transition from category "${currentCategory}" toward "${target}"`,
      }
    }
    const plan = buildTransitionFields(step, args.state)
    if (plan.blockedReason) return { status: 'blocked', reason: plan.blockedReason }
    try {
      await args.applyTransition(step, plan)
    } catch (err) {
      return { status: 'error', reason: err instanceof Error ? err.message : String(err) }
    }
    applied.push(step.id)
    visited.add(step.to.id)
    const stepCat = transitionCategory(step)
    if (stepCat) currentCategory = stepCat
    if (currentCategory === target) {
      return { status: 'applied', finalCategory: target, transitions: applied }
    }
  }
  return { status: 'no_path', reason: `target category "${target}" not reached within ${maxHops} hops` }
}
