// Status / transition resolution — the hard part of the integration.
//
// Jira issues have no settable `status`; you must apply workflow-gated
// transitions, and the customer's workflow is arbitrary. The 5 logical Specrails
// states map onto N customer statuses across only 3 stable categories
// (new / indeterminate / done). Strategy:
//   1. Explicit per-project status map (user picks the target status) wins.
//   2. Category fallback anchored on `statusCategory.key` (never the localizable
//      status NAME), with a cancel/ship lexicon to disambiguate the `done`
//      category (e.g. `Won't Do` vs `Released`).
//   3. Bounded category-monotonic transition walk where there is no direct edge
//      to the target category. Unknown lateral paths are never explored by writes.
//
// This module is PURE: the walker takes async callbacks (getTransitions /
// applyTransition) so it is fully testable without HTTP.

import type { JiraStatusCategory, JiraTransition, SpecLogicalState } from './types'

// 'discard'/'discarded' cover "Discard"/"Discarded" — a rejection status, never a
// success target. Without them the success resolver treated "Discarded" as a valid
// ship target and a completed job could be sent there (the reported Done→Discarded
// bug). Matching is WHOLE-WORD (see nameMatches) so a token never flags a larger
// word (e.g. 'invalid' must not match "Invalidate", 'complete' not "incomplete").
const CANCEL_LEXICON = ['won\'t do', 'wont do', 'cancelled', 'canceled', 'rejected', 'abandoned', 'invalid', 'duplicate', 'declined', 'discard', 'discarded']
const SHIP_LEXICON = ['done', 'closed', 'released', 'resolved', 'complete', 'completed', 'shipped', 'merged']

export function targetCategoryFor(state: SpecLogicalState): JiraStatusCategory {
  switch (state) {
    case 'todo':
      return 'new'
    case 'in_progress':
    case 'on_review':
      return 'indeterminate'
    case 'done':
    case 'cancelled':
      return 'done'
  }
}

export function categoryRank(cat: JiraStatusCategory): number {
  return cat === 'new' ? 0 : cat === 'indeterminate' ? 1 : 2
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nameMatches(name: string | undefined, lexicon: string[]): boolean {
  if (!name) return false
  const n = name.toLowerCase()
  // Whole-word match (\b…\b) so a lexicon token never matches INSIDE a larger word
  // ('invalid' must not flag "Invalidate", 'complete' not "incomplete"). Multi-word
  // phrases ("won't do") still match as a whole.
  return lexicon.some((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`, 'i').test(n))
}

/** A status whose NAME reads as a cancellation/rejection (e.g. "Discarded",
 *  "Won't Do"). A successful (done) outcome must never auto-land on one of these. */
function isCancelName(name: string | undefined): boolean {
  return nameMatches(name, CANCEL_LEXICON)
}

function matchesStatusTarget(id: string | undefined, name: string | undefined, target: string): boolean {
  return id === target || (name !== undefined && name.toLowerCase() === target.toLowerCase())
}

/** Does this transition's destination match the user's explicitly configured
 *  target (by status id or status name)? Case-insensitive on name.
 *  The explicit config ALWAYS wins over the cancel/ship lexicon heuristics. */
function matchesExplicit(t: JiraTransition, explicitTarget: string): boolean {
  return matchesStatusTarget(t.to.id, t.to.name, explicitTarget)
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
    // Values identify destination statuses, never transition IDs: the two ID
    // namespaces can collide, including with an unrelated terminal transition.
    const t = transitions.find((tr) => matchesExplicit(tr, explicitTarget))
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
 * the bounded walk when no direct transition exists). Returns the edge whose target
 * category is strictly closer (in rank distance) to the goal, never overshooting
 * past it, preferring the furthest progress in either direction.
 */
export function pickProgressTransition(
  transitions: JiraTransition[],
  currentCategory: JiraStatusCategory,
  targetCategory: JiraStatusCategory,
  visitedStatusIds: Set<string>,
  opts?: { avoidCancelNames?: boolean; explicitTarget?: string }
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
    // When the user configured an explicit target, never STEP onto a terminal
    // done-category status that isn't that target — landing on a different done
    // status (a generic "Done"/"Released", or for a discard the wrong terminal)
    // would strand the issue on the wrong status. The configured target itself is
    // reached via pickDirectTransition; here we only walk THROUGH non-terminal
    // statuses toward it, dead-lettering if it's unreachable.
    if (opts?.explicitTarget && transitionCategory(t) === 'done' && !matchesExplicit(t, opts.explicitTarget)) continue
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
  | { status: 'applied'; finalCategory: JiraStatusCategory | null; transitions: string[] }
  | { status: 'no_path'; reason: string }
  | { status: 'blocked'; reason: string }
  | { status: 'error'; reason: string }

function diagnosticValue(value: string, limit = 64): string {
  const compact = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (compact.length <= limit && JSON.stringify(compact).length <= limit) return JSON.stringify(compact)
  let preview = compact.slice(0, limit)
  while (JSON.stringify(`${preview}…`).length > limit) preview = preview.slice(0, -1)
  return JSON.stringify(`${preview}…`)
}

function statusDiagnostic(name: string | undefined, id: string | undefined): string {
  return `${name ? diagnosticValue(name, 48) : '(unknown)'}${id ? ` (id ${diagnosticValue(id, 24)})` : ''}`
}

function noPathReason(
  summary: string,
  currentName: string | undefined,
  currentId: string | undefined,
  explicitTarget: string | undefined,
  transitions: JiraTransition[] | undefined,
): string {
  // Dead-letter storage retains at most 500 characters. Budget the entire
  // message here so available destinations are never silently cut off there.
  const prefix = `${summary.slice(0, 160)}; current status ${statusDiagnostic(currentName, currentId)}`
    + (explicitTarget ? `; configured target ${diagnosticValue(explicitTarget)}` : '')
    + '; available destinations: '
  if (transitions === undefined) return `${prefix}not fetched for current status`
  const available: string[] = []
  for (const transition of transitions.slice(0, 8)) {
    const candidate = [...available, statusDiagnostic(transition.to.name, transition.to.id)]
    const omitted = transitions.length - candidate.length
    const suffix = omitted > 0 ? `; +${omitted} more` : ''
    if (`${prefix}${candidate.join(', ')}${suffix}`.length > 500) break
    available.push(candidate[candidate.length - 1])
  }
  const omitted = transitions.length - available.length
  return `${prefix}${available.join(', ') || (omitted ? '(omitted)' : 'none')}${omitted > 0 ? `; +${omitted} more` : ''}`
}

/**
 * Walk the transition graph from the current category to the target category for
 * `state`, applying edges per hop (you can only see the current status's
 * outgoing edges). An explicit destination's identity wins over the default
 * category, including idempotency. Without a destination, the category suffices.
 */
export async function walkToCategory(args: {
  state: SpecLogicalState
  currentCategory: JiraStatusCategory
  explicitTarget?: string
  /** The live status ID, not a transition ID, for configured-ID idempotency. */
  currentStatusId?: string
  /**
   * The issue's CURRENT status name (from the caller's idempotency re-GET).
   * With an `explicitTarget` configured, a same-category walk must still run
   * when the current status differs from the target — e.g. statusMap.on_review
   * = "In Review" while the issue sits at "In Progress" (both `indeterminate`);
   * the old category-only noop would strand the issue forever. When the name
   * already matches the explicit target (case-insensitive) the noop stands,
   * even if that status is outside the logical state's default category.
   */
  currentStatusName?: string
  maxHops?: number
  getTransitions: () => Promise<JiraTransition[]>
  applyTransition: (transition: JiraTransition, plan: TransitionFieldPlan) => Promise<void>
}): Promise<WalkOutcome> {
  const target = targetCategoryFor(args.state)
  const alreadyAtTarget = args.explicitTarget
    ? matchesStatusTarget(args.currentStatusId, args.currentStatusName, args.explicitTarget)
    : args.currentCategory === target
  if (alreadyAtTarget) return { status: 'noop' }

  const maxHops = args.maxHops ?? 5
  const visited = new Set<string>(args.currentStatusId ? [args.currentStatusId] : [])
  const applied: string[] = []
  let currentCategory = args.currentCategory
  let currentStatusName = args.currentStatusName
  let currentStatusId = args.currentStatusId

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
      return { status: 'applied', finalCategory: transitionCategory(direct), transitions: applied }
    }

    // No direct edge → step toward the target category. For any non-cancel walk
    // the step must avoid reject statuses so the issue never overshoots onto a
    // "Discarded"-style terminal status while reaching for the real target.
    const step = pickProgressTransition(transitions, currentCategory, target, visited, {
      avoidCancelNames: args.state !== 'cancelled',
      explicitTarget: args.explicitTarget,
    })
    if (!step) {
      return {
        status: 'no_path',
        reason: noPathReason(`no workflow transition from category "${currentCategory}" toward "${target}"`,
          currentStatusName, currentStatusId, args.explicitTarget, transitions),
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
    currentStatusName = step.to.name
    currentStatusId = step.to.id
    const stepCat = transitionCategory(step)
    if (stepCat) currentCategory = stepCat
    if (!args.explicitTarget && currentCategory === target) {
      return { status: 'applied', finalCategory: target, transitions: applied }
    }
  }
  return {
    status: 'no_path',
    reason: noPathReason(args.explicitTarget
      ? `configured status not reached within ${maxHops} hops`
      : `target category "${target}" not reached within ${maxHops} hops`,
      currentStatusName, currentStatusId, args.explicitTarget, undefined),
  }
}
