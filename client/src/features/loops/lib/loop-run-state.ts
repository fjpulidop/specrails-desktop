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

/** A loop run as a whole: its row status, outcome and why it paused. */
export interface LoopRunStatusFacts {
  status: 'running' | 'paused' | 'completed'
  outcome: string | null
  restartReason: string | null
}

/**
 * A whole loop run (live board). Paused on a question it asks the person
 * (needs-input); paused at a budget or by a restart it waits for a resume
 * (paused). A stalled run is paused like a stalled step; a blocked run waits
 * on something outside; a run that hit its iteration or cost ceiling, or was
 * stopped, ended without delivering (stopped).
 */
export function loopRunRunState(run: LoopRunStatusFacts): RunState {
  if (run.status === 'running') return 'working'
  if (run.status === 'paused') return run.restartReason === 'budget_paused' || run.restartReason === 'restart' ? 'paused' : 'needs-input'
  switch (run.outcome) {
    case 'success': return 'done'
    case 'failed': return 'failed'
    case 'blocked': return 'blocked'
    case 'stalled': return 'paused'
    default: return 'stopped'
  }
}
