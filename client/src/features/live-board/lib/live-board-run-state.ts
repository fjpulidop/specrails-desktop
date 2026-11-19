// ─── A live board card in the run-state vocabulary ───────────────────────────
// The board draws every card with the one RunState table. The server sends the
// card's DOMAIN status; this maps it through each domain's own mapper (jobs,
// loops, deliveries, the inbox; Intent through the missions extension seam), so
// a card looks exactly like the same run anywhere else. No state table of its own.

import type { LucideIcon } from 'lucide-react'
import type { RunState } from '../../../components/ui/run-state/run-state'
import type { JobStatus, RailPrDecision } from '../../../types'
import { jobStatusLook } from '../../jobs/lib/job-run-state'
import { loopRunRunState } from '../../loops/lib/loop-run-state'
import { deliveryLook, deliveryOverrideOf, DELIVERY_DECISION_LOOK } from '../../delivery/lib/delivery-run-state'
import { inboxItemRunState } from '../../inbox/lib/inbox-run-state'
import type { LiveCard, LiveRunStatus } from './live-board-model'

export interface LiveCardLook {
  state: RunState
  /** What the subject is (an open PR, a merge), drawn in the state's tone; null keeps the state's own glyph. */
  objectIcon: LucideIcon | null
}

function isDecision(value: string): value is RailPrDecision {
  return Object.prototype.hasOwnProperty.call(DELIVERY_DECISION_LOOK, value)
}

/** How an extension run (an Intent session) reads, from the missions extension seam (`runStateOf`). */
export type ExtensionRunState = (state: string) => RunState | null

/** The look of a domain status (an unknown value from a newer server reads as queued). */
export function liveStatusLook(status: LiveRunStatus, extensionRunState?: ExtensionRunState): LiveCardLook {
  switch (status.source) {
    case 'job': return { state: jobStatusLook(status.status as JobStatus).state, objectIcon: null }
    case 'loop-run': return { state: loopRunRunState(status), objectIcon: null }
    case 'delivery': {
      // Still building, but its run is paused: nothing moves until it resumes.
      if (status.paused) return { state: 'paused', objectIcon: null }
      if (!isDecision(status.decision)) return { state: 'queued', objectIcon: null }
      const look = deliveryLook(status.decision, deliveryOverrideOf({ decision: status.decision, statusCode: status.statusCode }))
      return { state: look.state, objectIcon: look.objectIcon }
    }
    // Intent plugs into the app through the missions extension seam; nothing here depends on it.
    case 'intent': return { state: extensionRunState?.(status.state) ?? 'queued', objectIcon: null }
    case 'attention': return { state: 'queued', objectIcon: null }
  }
}

/**
 * A card's look. An inbox item speaks for its run, so its kind decides the
 * state (a question asks, a failure failed), exactly as in the inbox; the
 * delivery's object glyph (an open PR) is kept when it is in the same state.
 */
export function liveCardLook(card: Pick<LiveCard, 'status' | 'attention'>, extensionRunState?: ExtensionRunState): LiveCardLook {
  const own = liveStatusLook(card.status, extensionRunState)
  if (!card.attention) return own
  const state = inboxItemRunState(card.attention)
  return { state, objectIcon: own.state === state ? own.objectIcon : null }
}
