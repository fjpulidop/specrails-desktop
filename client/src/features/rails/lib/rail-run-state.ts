// ─── A rail's status in the run-state vocabulary ──────────────────────────────

import type { RunState } from '../../../components/ui/run-state/run-state'
import type { RailStatus } from '../components/RailControls'

export const RAIL_RUN_STATE = {
  // Nothing running: waiting for its next launch.
  idle: 'queued',
  running: 'working',
  failed: 'failed',
} as const satisfies Record<RailStatus, RunState>

export function railRunState(status: RailStatus): RunState {
  return RAIL_RUN_STATE[status]
}
