/**
 * Legacy `failureRecovery`: one in-run retry of a failed phase (or an
 * artifact-only repair before revalidation) that preserves completed phases
 * and the current change. `recoverPhase` arms the retry; `afterPhase` routes
 * back to the failed phase once its repair target has run.
 */
import { truncate } from './loop-run-vars'
import type { LoopNode } from './loop-graph'
import type { LoopRunContext } from './loop-run-context'

/** Arm a single recovery of `node`; returns the node to run next, or
 *  undefined when the node has no (remaining) recovery policy. */
export function recoverPhase(ctx: LoopRunContext, node: LoopNode, detail: string, previousFailure: boolean): string | undefined {
  const { state } = ctx
  const policy = node.data?.failureRecovery
  if (!policy || state.phaseRecovery || ctx.host.isCancelled(ctx.runId) ||
    (state.recoveryCounts.get(node.id) ?? 0) >= policy.maxRetries) return undefined
  state.recoveryCounts.set(node.id, (state.recoveryCounts.get(node.id) ?? 0) + 1)
  state.phaseRecovery = { failedId: node.id, target: policy.target, detail: truncate(detail, 4000), artifactOnly: policy.artifactOnly === true }
  state.passFailed = previousFailure
  ctx.events.emitRunEvent('loop_phase_recovery', { nodeId: node.id, target: policy.target, attempt: state.recoveryCounts.get(node.id) })
  ctx.events.logLine(`↪ Recovering phase ${node.id} once; preserving completed phases and the current change.`)
  return policy.target
}

/** The node after `nodeId`: its successor, or the failed phase its repair was for. */
export function afterPhase(ctx: LoopRunContext, nodeId: string, successor: string | undefined): string | undefined {
  const { state } = ctx
  if (state.phaseRecovery?.target !== nodeId) return successor
  const failedId = state.phaseRecovery.failedId
  state.phaseRecovery = undefined
  return failedId === nodeId ? successor : failedId
}
