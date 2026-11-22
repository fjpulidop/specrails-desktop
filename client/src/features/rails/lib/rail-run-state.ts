// ─── A rail's status in the run-state vocabulary ──────────────────────────────

import type { RunState } from '../../../components/ui/run-state/run-state'
import type { JobHoldKind } from '../../../types'
import { HELD_RUN_STATE } from '../../jobs/lib/job-run-state'
import type { RailStatus } from '../components/RailControls'

export const RAIL_RUN_STATE = {
  // Nothing running: waiting for its next launch.
  idle: 'queued',
  running: 'working',
  failed: 'failed',
} as const satisfies Record<RailStatus, RunState>

/**
 * A running rail whose run is held waits, in the words of its hold: a provider
 * limit is blocked, a question or an approval needs input, your pause, a restart
 * or the budget is paused, a run waiting for capacity is queued. A hold of an
 * unknown kind reads paused.
 */
export function railRunState(status: RailStatus, hold: JobHoldKind | null = null): RunState {
  if (status !== 'running' || !hold) return RAIL_RUN_STATE[status]
  return HELD_RUN_STATE[hold] ?? 'paused'
}

/** Order of the rail summary's held counts: what needs the person first. */
export const HELD_SUMMARY_STATES = ['needs-input', 'blocked', 'paused', 'queued'] as const satisfies readonly RunState[]
export type HeldSummaryState = typeof HELD_SUMMARY_STATES[number]
