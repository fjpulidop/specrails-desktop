// ─── How an open Intent reads as a run ──────────────────────────────────────────
// ONE rule for the Intent's tone in the mission's run strip AND for the mission
// list's attention dot, so both always agree. An open Intent is a running run
// (active), a paused one, or informational (needs-review: its copy of the
// project is missing; nothing to decide). The client-only hand-off states
// ("Ready to turn into a PR", launching) are calm and never need the person.
// An Intent session → Spec run that fails or waits for review is a DELIVERY: its
// envelope feeds the dot on its own (missions' deliveryNeedsPerson).

import type { MissionLiveRunTone } from '../../missions/context/MissionExtensionsContext'
import type { IntentState } from './intent-api'
import type { RunState } from '../../../components/ui/run-state/run-state'

/** The strip tone of an Intent session in this state, or null when it is not in the strip as an Intent session. */
export function flowOpenRunTone(state: IntentState): MissionLiveRunTone | null {
  if (state === 'active') return 'running'
  if (state === 'paused') return 'paused'
  if (state === 'needs-review') return 'info'
  return null
}

/** The Intent waits for the person: the strip's own rule (a decision or a failure). */
export function flowNeedsPerson(state: IntentState): boolean {
  const tone = flowOpenRunTone(state)
  return tone === 'decision' || tone === 'failed'
}

/**
 * An Intent in the run-state vocabulary. `needs-review` is blocked (its copy
 * of the project is missing); a hand-off or a delivery is the Intent's own
 * work done; a discarded or closed Intent stopped.
 */
export const INTENT_RUN_STATE = {
  active: 'working',
  paused: 'paused',
  'needs-review': 'blocked',
  handed_off: 'done',
  delivered: 'done',
  discarded: 'stopped',
  closed: 'stopped',
} as const satisfies Record<IntentState, RunState>

export function intentRunState(state: IntentState): RunState {
  return INTENT_RUN_STATE[state]
}

/** A persisted Intent state string in the vocabulary; null for one this client does not know. */
export function intentRunStateOf(state: string): RunState | null {
  return Object.prototype.hasOwnProperty.call(INTENT_RUN_STATE, state) ? INTENT_RUN_STATE[state as IntentState] : null
}
