/**
 * Pure run-phase rules of the PR decision card (mission-rail-cards): the status
 * the run header shows, the Intent → Spec outcome, a RuntimeRun rebuilt from the
 * settle-time snapshot and the PR number read from a PR URL.
 */
import { FLOW_SPEC_LOOP_ID } from '../../../delivery/components/LoopChip'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'
import type { RuntimeRun } from '../../../settings/lib/agent-runtime'

export type MissionRunStatus = 'running' | 'paused' | 'succeeded' | 'failed' | 'stalled' | 'cancelled' | 'unknown' | 'changes_requested' | 'returned'

/**
 * The status the run-phase header shows. Live runtime data wins while the run
 * is active; otherwise the settle-time `runtime` snapshot; otherwise the
 * decision. Never invents: an unknown state renders as "unknown".
 */
export function deriveMissionRunStatus(
  envelope: Pick<AgentPrDecisionEnvelope, 'decision' | 'runtime' | 'implementationOutcome'> & Partial<Pick<AgentPrDecisionEnvelope, 'statusCode'>>,
  live: { active?: boolean; status?: string } | null,
  paused: boolean,
): MissionRunStatus {
  if (envelope.decision === 'building') {
    if (paused) return 'paused'
    if (live?.status === 'stalled') return 'stalled'
    return 'running'
  }
  if (live?.active) return 'running'
  // Intent → Spec: the work still needs changes / went back to its Intent — not a crash.
  const flow = flowCardOutcome(envelope)
  if (flow === 'changes') return 'changes_requested'
  if (flow === 'returned') return 'returned'
  // A person stopped the run before it delivered: cancelled, not failed.
  if (envelope.decision === 'implementation_failed' && envelope.statusCode === 'run_stopped') return 'cancelled'
  const snap = envelope.runtime?.status
  if (snap === 'running') return 'running'
  if (snap === 'failed' || snap === 'stalled' || snap === 'cancelled' || snap === 'succeeded') return snap
  if (envelope.runtime?.failure) return envelope.runtime.failure.code === 'stalled' || envelope.runtime.failure.code === 'stuck' ? 'stalled' : 'failed'
  if (envelope.decision === 'implementation_failed' || envelope.implementationOutcome === 'failed') return 'failed'
  if (envelope.decision === 'discarded') return 'cancelled'
  if (envelope.decision === 'completed' || envelope.decision === 'merged' || envelope.decision === 'on_review' || envelope.decision === 'pr_draft' || envelope.decision === 'pr_ready' || envelope.decision === 'no_changes') return 'succeeded'
  return 'unknown'
}

/**
 * Intent → Spec outcome a card presents instead of a generic failure (null for
 * every other run): `changes` — the review still requests changes; `crashed`
 * — the run failed outright (a technical failure, not a review verdict);
 * `returned` — the work went back to its Intent.
 */
export function flowCardOutcome(envelope: Partial<Pick<AgentPrDecisionEnvelope, 'decision' | 'statusCode' | 'loopId'>>): 'changes' | 'crashed' | 'returned' | null {
  if (envelope.decision === 'implementation_failed' && envelope.statusCode === 'review_changes_requested') return 'changes'
  if (envelope.decision === 'discarded' && envelope.statusCode === 'returned_to_flow') return 'returned'
  if (envelope.decision === 'implementation_failed' && envelope.loopId === FLOW_SPEC_LOOP_ID) return 'crashed'
  return null
}

/** A RuntimeRun the action helper can act on when live polling has nothing
 *  yet: built from the settle-time snapshot (approve needs a step id, so it is
 *  offered only when the snapshot named the failing step). */
export function runtimeRunFromSnapshot(envelope: AgentPrDecisionEnvelope, runId: string): RuntimeRun | null {
  const rt = envelope.runtime
  if (!rt) return null
  return {
    runId,
    status: rt.status,
    nextStep: rt.currentStep,
    recoverableSteps: rt.recoverableSteps,
    active: rt.status === 'running',
    canResume: rt.canResume,
    canCancel: rt.status === 'running',
    ...(rt.pendingApproval && rt.failure?.stepId ? { pendingApproval: { stepId: rt.failure.stepId } } : {}),
  }
}

export function prNumberFromUrl(prUrl: string): string | null {
  const m = /\/pull\/(\d+)/.exec(prUrl)
  return m ? `#${m[1]}` : null
}
