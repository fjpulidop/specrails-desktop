// ─── A job's status in the run-state vocabulary ────────────────────────────────
// The one table every job surface reads (jobs list, job header, the mission's
// jobs pane, the command palette). The labels and tooltips stay the jobs'
// own: they say more than the state's name (a zombie, a skipped pipeline job).

import type { TFunction } from 'i18next'
import type { JobHold, JobHoldKind, JobStatus, JobSummary } from '../../../types'
import type { RunState } from '../../../components/ui/run-state/run-state'
import type { PhaseState } from '../hooks/usePipeline'

export interface JobStatusLook {
  state: RunState
  /** `jobs:` key of the visible name. */
  labelKey: `statusLabel.${string}` | `held.label.${string}`
  /** `jobs:` key of the explanation. */
  tooltipKey: `statusTooltip.${string}` | `held.tooltip.${string}`
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

/**
 * A stopped run that still owns its job row (the row stays `running` for its
 * tickets and worktree) in the vocabulary: paused by a restart, an interrupted
 * write or the budget; blocked on a provider's usage limit; asking the person.
 */
export const HELD_RUN_STATE = {
  restart: 'paused',
  interrupted: 'paused',
  provider_limit: 'blocked',
  budget: 'paused',
  question: 'needs-input',
  approval: 'needs-input',
  paused: 'paused',
  // Launched, waiting for capacity: it has not started yet and starts by itself.
  queued: 'queued',
} as const satisfies Record<JobHoldKind, RunState>

const isHoldKind = (value: unknown): value is JobHoldKind =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(HELD_RUN_STATE, value)

/** The hold of a job its row calls running; null when it works (or the payload is malformed). */
export function jobHoldOf(job: Pick<JobSummary, 'status' | 'hold'> | null | undefined): JobHold | null {
  const hold = job?.hold
  if (!job || job.status !== 'running' || !hold || typeof hold !== 'object' || !isHoldKind(hold.kind)) return null
  return {
    kind: hold.kind,
    step: typeof hold.step === 'string' && hold.step ? hold.step : null,
    since: typeof hold.since === 'string' && Number.isFinite(Date.parse(hold.since)) ? hold.since : null,
    ...(typeof hold.resumeAt === 'string' ? { resumeAt: hold.resumeAt } : {}),
    ...(typeof hold.waitingFor === 'string' ? { waitingFor: hold.waitingFor } : {}),
    ...(typeof hold.position === 'number' ? { position: hold.position } : {}),
    ...(hold.kind === 'paused' && hold.byYou === true ? { byYou: true } : {}),
  }
}

/** True only while the job genuinely works: running and not held. */
export function isJobLive(job: Pick<JobSummary, 'status' | 'hold'> | null | undefined): boolean {
  return job?.status === 'running' && !jobHoldOf(job)
}

/** The status a log/graph surface should treat the job as: a held run is `paused` (settled for now, not working). */
export function jobDisplayStatus(job: Pick<JobSummary, 'status' | 'hold'>): string {
  return jobHoldOf(job) ? 'paused' : job.status
}

/**
 * The look of a job: its hold when it has one, else its status. A bare status
 * string still works (an unknown value, a newer server, reads as queued).
 */
export function jobStatusLook(job: string | Pick<JobSummary, 'status' | 'hold'>): JobStatusLook {
  const status = typeof job === 'string' ? job : job.status
  const hold = typeof job === 'string' ? null : jobHoldOf(job)
  if (hold) {
    const key = hold.byYou ? 'pausedByYou' : hold.kind
    return { state: HELD_RUN_STATE[hold.kind], labelKey: `held.label.${key}`, tooltipKey: `held.tooltip.${key}` }
  }
  return isJobStatus(status) ? JOB_STATUS_LOOK[status] : JOB_STATUS_LOOK.queued
}

/** `agentRuntime:roles.developer` when known, else the step id in words (`spec-review` → `Spec review`). */
export function holdStepName(t: TFunction, step: string): string {
  const words = step.split('/').pop()!.replace(/[-_]+/g, ' ').trim()
  return t(`agentRuntime:roles.${step}`, { defaultValue: words ? words[0]!.toUpperCase() + words.slice(1) : step })
}

/** One plain sentence: why the run is not working ("The app restarted during the Developer step."). */
export function describeJobHold(t: TFunction, hold: JobHold): string {
  if (hold.kind === 'queued') return queuedReason(t, hold.waitingFor, hold.position)
  if (hold.byYou) return t('jobs:held.reason.pausedByYou')
  const withStep = hold.step && (hold.kind === 'restart' || hold.kind === 'interrupted')
  return withStep
    ? t(`jobs:held.reason.${hold.kind}`, { step: holdStepName(t, hold.step!) })
    : t(`jobs:held.reason.${hold.kind}${hold.kind === 'restart' || hold.kind === 'interrupted' ? 'NoStep' : ''}`)
}

/** Capacity wait reasons the server sends (capacity `WAITING_FOR`); anything newer reads as generic. */
const QUEUE_REASONS = new Set(['run_slots', 'project_slots', 'provider_slots', 'cpu', 'memory', 'provider_quota'])

/** "Waiting for a free run slot (2nd in line). It starts by itself." */
export function queuedReason(t: TFunction, waitingFor: string | undefined, position: number | undefined): string {
  const reason = waitingFor && QUEUE_REASONS.has(waitingFor) ? waitingFor : 'other'
  return t(`jobs:held.queue.${reason}`) + (position ? ` ${t('jobs:held.queue.position', { position })}` : '')
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
