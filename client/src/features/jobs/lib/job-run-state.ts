// ─── A job's status in the run-state vocabulary ────────────────────────────────
// The one table every job surface reads (jobs list, job header, the mission's
// jobs pane, the command palette). The labels and tooltips stay the jobs'
// own: they say more than the state's name (a zombie, a skipped pipeline job).

import type { JobStatus } from '../../../types'
import type { RunState } from '../../../components/ui/run-state/run-state'
import type { PhaseState } from '../hooks/usePipeline'

export interface JobStatusLook {
  state: RunState
  /** `jobs:` key of the visible name. */
  labelKey: `statusLabel.${string}`
  /** `jobs:` key of the explanation. */
  tooltipKey: `statusTooltip.${string}`
}

export const JOB_STATUS_LOOK = {
  queued: { state: 'queued', labelKey: 'statusLabel.queued', tooltipKey: 'statusTooltip.queued' },
  running: { state: 'working', labelKey: 'statusLabel.running', tooltipKey: 'statusTooltip.running' },
  completed: { state: 'done', labelKey: 'statusLabel.completed', tooltipKey: 'statusTooltip.completed' },
  failed: { state: 'failed', labelKey: 'statusLabel.failed', tooltipKey: 'statusTooltip.failed' },
  zombie_terminated: { state: 'failed', labelKey: 'statusLabel.zombie', tooltipKey: 'statusTooltip.zombie' },
  canceled: { state: 'stopped', labelKey: 'statusLabel.canceled', tooltipKey: 'statusTooltip.canceled' },
  // A pipeline job that never ran because its parent failed: stopped, not a warning.
  skipped: { state: 'stopped', labelKey: 'statusLabel.skipped', tooltipKey: 'statusTooltip.skipped' },
} as const satisfies Record<JobStatus, JobStatusLook>

/** The look of a job status; an unknown value (a newer server) reads as queued. */
export function jobStatusLook(status: string): JobStatusLook {
  return isJobStatus(status) ? JOB_STATUS_LOOK[status] : JOB_STATUS_LOOK.queued
}

function isJobStatus(status: string): status is JobStatus {
  return Object.prototype.hasOwnProperty.call(JOB_STATUS_LOOK, status)
}

export function jobRunState(status: JobStatus): RunState {
  return JOB_STATUS_LOOK[status].state
}

/** A pipeline phase of a job (PipelineProgress). */
export const PHASE_RUN_STATE = {
  idle: 'queued',
  running: 'working',
  done: 'done',
  error: 'failed',
} as const satisfies Record<PhaseState, RunState>

export function phaseRunState(state: PhaseState): RunState {
  return PHASE_RUN_STATE[state]
}
