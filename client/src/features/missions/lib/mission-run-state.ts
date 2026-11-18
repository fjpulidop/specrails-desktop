// ─── Mission runs in the run-state vocabulary ─────────────────────────────────
// The strip tone, the PR card's run-phase status and a spec's live activity,
// each mapped to the one RunState table (components/ui/run-state).

import type { RunState } from '../../../components/ui/run-state/run-state'
import { deliveryLook, deliveryOverrideOf } from '../../delivery/lib/delivery-run-state'
import type { AgentPrDecisionEnvelope, AgentSubagentPhase } from './agent-api'
import type { MissionRunCardSummary, MissionRunTone } from '../components/mission-run-strip'
import type { MissionRunStatus } from '../components/pr-decision-card/run-status'
import type { SpecActivityPhase } from './spec-activity'

/**
 * A strip tone's state when nothing more precise is known. A `decision` waits
 * for the person (review); a calm `info` run is settled without a decision
 * owed (stopped, muted) — entries that know better pass their own state.
 */
export const MISSION_TONE_RUN_STATE = {
  launching: 'queued',
  running: 'working',
  decision: 'review',
  failed: 'failed',
  paused: 'paused',
  info: 'stopped',
} as const satisfies Record<MissionRunTone, RunState>

export function missionToneRunState(tone: MissionRunTone): RunState {
  return MISSION_TONE_RUN_STATE[tone]
}

/**
 * The precise state of a delivery in the run strip: its tone (which also
 * ranks urgency) refined by what the envelope and its card say. A pending
 * approval asks the person (needs-input); review changes requested and an
 * Intent → Spec crash are blocked; a stalled run is paused; a calm `info`
 * delivery is its decision's own state (no changes: done; closed or stopped:
 * stopped).
 */
export function deliveryStripRunState(
  envelope: Pick<AgentPrDecisionEnvelope, 'decision' | 'runtime' | 'statusCode'>,
  tone: MissionRunTone,
  card: Pick<MissionRunCardSummary, 'pendingApproval' | 'stalled'> | null,
): RunState {
  const override = deliveryOverrideOf({ decision: envelope.decision, statusCode: envelope.statusCode ?? null })
  if (tone === 'decision') {
    if (card?.pendingApproval || envelope.runtime?.pendingApproval) return 'needs-input'
    return override ? deliveryLook(envelope.decision, override).state : 'review'
  }
  if (tone === 'failed' && (card?.stalled || envelope.runtime?.status === 'stalled')) return 'paused'
  if (tone === 'info') return deliveryLook(envelope.decision, override).state
  return MISSION_TONE_RUN_STATE[tone]
}

/** The PR decision card's run-phase status. */
export const MISSION_RUN_STATUS_STATE = {
  running: 'working',
  paused: 'paused',
  stalled: 'paused',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  // Never invented: an unknown phase shows as not started, with its own words.
  unknown: 'queued',
  changes_requested: 'blocked',
  returned: 'stopped',
} as const satisfies Record<MissionRunStatus, RunState>

export function missionRunStatusState(status: MissionRunStatus): RunState {
  return MISSION_RUN_STATUS_STATE[status]
}

/** A spec's live activity (the mission's specs pane). */
export const SPEC_ACTIVITY_RUN_STATE = {
  running: 'working',
  waiting: 'review',
  failed: 'failed',
  paused: 'paused',
} as const satisfies Record<SpecActivityPhase, RunState>

export function specActivityRunState(phase: SpecActivityPhase): RunState {
  return SPEC_ACTIVITY_RUN_STATE[phase]
}

/**
 * A subagent's phase. An interrupted subagent (the app went away mid-turn) is
 * not resumed: it ended without finishing, like a stopped or killed one.
 */
export const SUBAGENT_PHASE_RUN_STATE = {
  running: 'working',
  idle: 'done',
  failed: 'failed',
  stopped: 'stopped',
  killed: 'stopped',
  interrupted: 'stopped',
} as const satisfies Record<AgentSubagentPhase, RunState>

export function subagentRunState(phase: AgentSubagentPhase): RunState {
  return SUBAGENT_PHASE_RUN_STATE[phase]
}
