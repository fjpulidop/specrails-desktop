// ─── Loop steps in the run-state vocabulary ───────────────────────────────────
// A step's attempt (log section, runtime graph node) and an overview chip,
// mapped to the one RunState table (components/ui/run-state).

import type { RunState } from '../../../components/ui/run-state/run-state'
import type { NodeChipState, SegmentStatus } from '../components/loop-log/loop-log-model'

/** A step attempt's status; `pending` is a graph node the run has not reached. */
export type LoopStepStatus = SegmentStatus | 'pending'

export const LOOP_STEP_RUN_STATE = {
  pending: 'queued',
  running: 'working',
  ok: 'done',
  failed: 'failed',
  // Stalled and interrupted steps wait for a resume: paused, not failed.
  paused: 'paused',
  stalled: 'paused',
  interrupted: 'paused',
  // A legacy step without an outcome: nothing known, nothing claimed.
  unknown: 'queued',
} as const satisfies Record<LoopStepStatus, RunState>

/**
 * The state of a step attempt. A step that failed on the provider's limit is
 * blocked (it can continue once the limit resets), not a failure of the work.
 */
export function loopStepRunState(status: LoopStepStatus, endReason?: string | null): RunState {
  if (status === 'failed' && endReason === 'provider_limit') return 'blocked'
  return LOOP_STEP_RUN_STATE[status]
}

export const LOOP_CHIP_RUN_STATE = {
  pending: 'queued',
  running: 'working',
  ok: 'done',
  failed: 'failed',
  paused: 'paused',
  interrupted: 'paused',
} as const satisfies Record<NodeChipState, RunState>

export function loopChipRunState(state: NodeChipState): RunState {
  return LOOP_CHIP_RUN_STATE[state]
}
