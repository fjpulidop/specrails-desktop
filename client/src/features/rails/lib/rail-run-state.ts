// ─── A rail's status in the run-state vocabulary ──────────────────────────────

import type { RunState } from '../../../components/ui/run-state/run-state'
import type { RailStatus } from '../components/RailControls'

export const RAIL_RUN_STATE = {
  // Nothing running: waiting for its next launch.
  idle: 'queued',
  running: 'working',
  failed: 'failed',
} as const satisfies Record<RailStatus, RunState>

/** A running rail whose run is held (your pause, a limit, a question, a restart) waits: paused, not working. */
export function railRunState(status: RailStatus, held = false): RunState {
  return status === 'running' && held ? 'paused' : RAIL_RUN_STATE[status]
}
