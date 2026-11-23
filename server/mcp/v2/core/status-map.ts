import type { JobStatus } from '../../../types'
import { RUN_HOLD_KINDS, type RunHold, type RunHoldKind } from '../../../modules/loops/runtime/loop-run-hold'
import type { PrDecision } from '../../../modules/delivery'

/**
 * The one status vocabulary of v2 (`DecisionState.status`). Finer than the
 * app's nine run states (DESIGN.md "Status vocabulary") because agents act on
 * the difference between delivered and integrated, or blocked and paused;
 * `appState` maps every value back to the app's word (`core.appState.*`, the
 * client's `common:runState.*` text) so Claude and Codex speak the app's words.
 *
 * Agents must tolerate unknown values: new statuses are additive.
 */
export const CANONICAL_STATUSES = [
  'queued', 'running', 'paused', 'waiting', 'needs_you', 'blocked', 'failed', 'succeeded',
  'cancelled', 'ready_for_review', 'delivered', 'integrated', 'discarded',
] as const
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number]

/** The app's nine run states (client `run-state.ts`). */
export type AppRunState = 'queued' | 'working' | 'needs-input' | 'review' | 'paused' | 'blocked' | 'failed' | 'done' | 'stopped'

const APP_STATE: Record<CanonicalStatus, AppRunState> = {
  queued: 'queued', running: 'working', paused: 'paused', waiting: 'queued', needs_you: 'needs-input',
  blocked: 'blocked', failed: 'failed', succeeded: 'done', cancelled: 'stopped', ready_for_review: 'review',
  delivered: 'done', integrated: 'done', discarded: 'stopped',
}

export function appState(status: CanonicalStatus): AppRunState {
  return APP_STATE[status]
}

/** Nothing more happens without the person or a new launch (what `wait(for: settled)` waits for). */
export const SETTLED_STATUSES: ReadonlySet<CanonicalStatus> = new Set(['failed', 'succeeded', 'cancelled', 'ready_for_review', 'delivered', 'integrated', 'discarded'])
/** The person is the next actor. */
export const NEEDS_YOU_STATUSES: ReadonlySet<CanonicalStatus> = new Set(['needs_you', 'ready_for_review'])

export function isSettled(status: CanonicalStatus): boolean {
  return SETTLED_STATUSES.has(status)
}

/** A run hold → status: what the person must do decides the word. */
export function statusFromHold(hold: Pick<RunHold, 'kind'>): CanonicalStatus {
  switch (hold.kind) {
    case 'question':
    case 'approval': return 'needs_you'
    case 'provider_limit': return 'blocked'
    case 'queued': return 'queued'
    case 'budget':
    case 'paused':
    case 'restart':
    case 'interrupted': return 'paused'
  }
}

/** A job row (`jobs.status`) plus its derived hold (loop-run-hold.ts). */
export function statusFromJob(status: JobStatus | string, hold?: Pick<RunHold, 'kind'> | null): CanonicalStatus {
  switch (status) {
    case 'queued': return 'queued'
    case 'running': return hold ? statusFromHold(hold) : 'running'
    case 'completed': return 'succeeded'
    case 'failed':
    case 'zombie_terminated': return 'failed'
    case 'canceled':
    case 'skipped': return 'cancelled'
    default: return statusFromWord(status)
  }
}

/**
 * A run as the event journal records it: the job status plus a hold word,
 * which may be a `RunHoldKind` or the journal-only `stuck` (the stall
 * watchdog's `job.stuck`: still running, nobody can act from the run) → `blocked`.
 */
export function statusFromRunHold(status: JobStatus | string, hold: string | null | undefined): CanonicalStatus {
  if (hold === 'stuck') return 'blocked'
  return statusFromJob(status, hold && (RUN_HOLD_KINDS as readonly string[]).includes(hold) ? { kind: hold as RunHoldKind } : null)
}

/** A PR delivery decision (delivery/domain/state.ts). */
export function statusFromDelivery(decision: PrDecision | string): CanonicalStatus {
  switch (decision) {
    case 'building': return 'running'
    case 'on_review':
    case 'pr_draft':
    case 'pr_ready': return 'ready_for_review'
    case 'no_changes': return 'succeeded'
    case 'completed': return 'delivered'
    case 'merged': return 'integrated'
    case 'pr_closed': return 'cancelled'
    case 'discarded':
    case 'superseded': return 'discarded'
    case 'implementation_failed':
    case 'pr_failed': return 'failed'
    default: return statusFromWord(decision)
  }
}

/** A milestone chain (`MilestoneChainStatus`). */
export function statusFromChain(status: string): CanonicalStatus {
  switch (status) {
    case 'running': return 'running'
    case 'waiting': return 'waiting'
    case 'paused': return 'paused'
    case 'awaiting_approval': return 'needs_you'
    case 'completed': return 'succeeded'
    case 'cancelled': return 'cancelled'
    default: return statusFromWord(status)
  }
}

/** A spec (`TicketStatus`). */
export function statusFromSpec(status: string): CanonicalStatus {
  switch (status) {
    case 'draft': return 'waiting'
    case 'todo': return 'queued'
    case 'in_progress': return 'running'
    case 'on_review': return 'ready_for_review'
    case 'done': return 'succeeded'
    case 'cancelled': return 'cancelled'
    default: return statusFromWord(status)
  }
}

const WORDS: Record<string, CanonicalStatus> = {
  pending: 'queued', launching: 'queued', starting: 'queued', waiting: 'waiting', idle: 'waiting',
  running: 'running', working: 'running', streaming: 'running', in_progress: 'running', iterating: 'running', active: 'running',
  paused: 'paused', stalled: 'paused', interrupted: 'paused', budget_paused: 'paused',
  needs_input: 'needs_you', 'needs-input': 'needs_you', awaiting_input: 'needs_you', question: 'needs_you',
  review: 'ready_for_review', on_review: 'ready_for_review',
  blocked: 'blocked', stuck: 'blocked', error: 'failed', failed: 'failed', failure: 'failed',
  done: 'succeeded', completed: 'succeeded', complete: 'succeeded', succeeded: 'succeeded', success: 'succeeded', passed: 'succeeded',
  canceled: 'cancelled', cancelled: 'cancelled', aborted: 'cancelled', stopped: 'cancelled', skipped: 'cancelled', closed: 'cancelled',
  delivered: 'delivered', merged: 'integrated', integrated: 'integrated', discarded: 'discarded', superseded: 'discarded',
}

/** Best-effort mapping of any other domain word (missions, CI, Intent, inbox); unknown words read as `waiting`. */
export function statusFromWord(word: string | null | undefined): CanonicalStatus {
  if (!word) return 'waiting'
  return WORDS[word.trim().toLowerCase().replace(/\s+/g, '_')] ?? 'waiting'
}
