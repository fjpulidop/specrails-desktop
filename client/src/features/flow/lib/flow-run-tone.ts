// ─── How an open Flow reads as a run ──────────────────────────────────────────
// ONE rule for the Flow's tone in the mission's run strip AND for the mission
// list's attention dot, so both always agree. An open Flow is a running run
// (active), a paused one, or informational (needs-review: its copy of the
// project is missing; nothing to decide). The client-only hand-off states
// ("Ready to turn into a PR", launching) are calm and never need the person.
// A Flow → Spec run that fails or waits for review is a DELIVERY: its
// envelope feeds the dot on its own (missions' deliveryNeedsPerson).

import type { MissionLiveRunTone } from '../../missions/context/MissionExtensionsContext'
import type { FlowState } from './flow-api'

/** The strip tone of a Flow in this state, or null when it is not in the strip as a Flow. */
export function flowOpenRunTone(state: FlowState): MissionLiveRunTone | null {
  if (state === 'active') return 'running'
  if (state === 'paused') return 'paused'
  if (state === 'needs-review') return 'info'
  return null
}

/** The Flow waits for the person: the strip's own rule (a decision or a failure). */
export function flowNeedsPerson(state: FlowState): boolean {
  const tone = flowOpenRunTone(state)
  return tone === 'decision' || tone === 'failed'
}
