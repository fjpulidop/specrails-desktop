/**
 * Human decision verbs for the review packet (nontech-review-experience Wave 2).
 *
 * The delivery lifecycle exposes 12 decisions × 9 actions × orthogonal
 * implementation/delivery/status axes — roughly fourteen distinct presentation
 * states. A non-technical user cannot be asked to choose between "Create PR",
 * "Integrate locally", "Retry push" and "Commit & retry push"; they can answer
 * "is this good?". So this module maps the FULL state space onto three verbs
 * (accept / request-changes / discard) and, crucially, marks every state where
 * that reduction would LIE as `fineControlOnly` — the packet then renders the
 * existing strip verbatim instead of inventing a friendly label for a git
 * recovery flow.
 *
 * The mapping is deliberately total and exhaustively tested: a state that no
 * branch claims falls through to `fineControlOnly`, never to a wrong verb.
 *
 * ── State → verbs (the table the design demanded before any UI) ──────────────
 *  building ................ none (still running)                fineControl: no
 *  on_review ............... accept · request-changes · discard
 *  no_changes / completed .. accept(mark done) · request-changes  (nothing built)
 *  pr_draft + prUrl ........ accept(publish) · request-changes · discard
 *  pr_draft degraded ....... fineControlOnly (retry/local ladder is git work)
 *  pr_ready ................ request-changes · discard  (+ merge check in strip)
 *  pr_closed ............... fineControlOnly (reopen is git lifecycle)
 *  pr_failed / blocked ..... fineControlOnly (recovery family)
 *  implementation_failed ... discard  (+ request-changes when work exists)
 *  merged / discarded ...... none (terminal)
 *  superseded .............. none (a newer generation owns the rail)
 */
import type { PrDeliveryPresentation } from './pr-delivery'
import type { RailPrDecision } from '../types'

export type PacketVerb = 'accept' | 'request-changes' | 'discard'

/** What Accept physically means in this state — the packet must say it plainly. */
export type AcceptMeaning =
  | 'create-pr'
  /** Opens an existing draft PR for review. */
  | 'publish'
  /** Writes into the user's own checkout. IRREVERSIBLE — always confirm-gated. */
  | 'merge-local'
  /** Nothing was built; accepting just closes the loop. */
  | 'mark-done'

export interface PacketVerbResolution {
  verbs: PacketVerb[]
  /** Absent when `accept` is not offered. */
  acceptMeaning: AcceptMeaning | null
  /**
   * True when the three-verb reduction cannot honestly represent this state.
   * The packet MUST then defer to the existing fine-grained controls rather
   * than relabel a git recovery action as "Accept".
   */
  fineControlOnly: boolean
  /** True while the delivery is still producing work (no decision possible). */
  inFlight: boolean
  /** True once the delivery is closed for good. */
  terminal: boolean
  /** Set when the accept path mutates the user's working checkout. */
  requiresIrreversibleConfirm: boolean
}

export interface PacketVerbInput {
  decision: RailPrDecision
  presentation: PrDeliveryPresentation
  prUrl: string | null
  /**
   * Whether a real PR can be produced from here (a remote plus an
   * authenticated GitHub CLI). Resolved server-side; `false` makes Accept mean
   * merge-local, which is why it is never allowed to default silently to true.
   */
  canCreatePr: boolean
}

const NONE = (over: Partial<PacketVerbResolution> = {}): PacketVerbResolution => ({
  verbs: [],
  acceptMeaning: null,
  fineControlOnly: false,
  inFlight: false,
  terminal: false,
  requiresIrreversibleConfirm: false,
  ...over,
})

export function resolvePacketVerbs(input: PacketVerbInput): PacketVerbResolution {
  const { decision, presentation, prUrl, canCreatePr } = input

  if (decision === 'building') return NONE({ inFlight: true })
  if (decision === 'merged' || decision === 'discarded') return NONE({ terminal: true })
  if (presentation.superseded) return NONE({ terminal: true })

  // The recovery family, a closed PR, and a degraded draft are all git work
  // with no honest plain-language reduction. Checked BEFORE the happy paths so
  // an interrupted settlement can never be relabelled "Accept".
  if (
    presentation.manualRecovery || presentation.recoveryUnavailable || presentation.recoveryRecheck
    || presentation.retryablePush || presentation.retryablePrCreation
    || presentation.closed
    || (presentation.deliveryBlocked && !presentation.implementationFailed)
  ) {
    return NONE({ fineControlOnly: true })
  }

  // Nothing was built: "accept" only acknowledges that, and asking for changes
  // is the genuine second option. Never offer discard — there is nothing to throw away.
  if (presentation.noChanges) {
    return NONE({ verbs: ['accept', 'request-changes'], acceptMeaning: 'mark-done' })
  }

  if (presentation.implementationFailed) {
    // Failure with usable partial work can still be revised; without it, the
    // only honest action is to clear the slot.
    const verbs: PacketVerb[] = presentation.succeededCount > 0
      ? ['request-changes', 'discard']
      : ['discard']
    return NONE({ verbs })
  }

  if (decision === 'pr_draft') {
    // Degraded draft (pushed / local-only, no PR) is the git ladder again.
    if (!prUrl) return NONE({ fineControlOnly: true })
    return NONE({
      verbs: ['accept', 'request-changes', 'discard'],
      acceptMeaning: 'publish',
    })
  }

  if (decision === 'pr_ready') {
    // GitHub owns the merge from here; accepting again would be a lie.
    return NONE({ verbs: ['request-changes', 'discard'] })
  }

  if (decision === 'on_review') {
    const acceptMeaning: AcceptMeaning = canCreatePr ? 'create-pr' : 'merge-local'
    return NONE({
      verbs: ['accept', 'request-changes', 'discard'],
      acceptMeaning,
      requiresIrreversibleConfirm: acceptMeaning === 'merge-local',
    })
  }

  // Unclaimed state: defer rather than guess.
  return NONE({ fineControlOnly: true })
}

/** The decision-endpoint action a verb maps to, or null when it needs no POST. */
export function packetVerbAction(
  verb: PacketVerb,
  resolution: PacketVerbResolution,
): 'create-pr' | 'publish' | 'merge-local' | 'acknowledge-no-changes' | 'discard' | null {
  if (verb === 'discard') return 'discard'
  if (verb === 'request-changes') return null // handled by the revision flow (Wave 3)
  switch (resolution.acceptMeaning) {
    case 'create-pr': return 'create-pr'
    case 'publish': return 'publish'
    case 'merge-local': return 'merge-local'
    case 'mark-done': return 'acknowledge-no-changes'
    default: return null
  }
}
