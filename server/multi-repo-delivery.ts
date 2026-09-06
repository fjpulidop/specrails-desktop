import { newId } from './ids'
import { withRepoLock } from './repo-lock'
import { resolveProjectExecution } from './workspace-resolution'
import { getAgentChatManager } from './agent-chat-registry'
import { actionAllowed, executePrDecision, type PrDecisionDeps, type PrDecisionInput, type PrDecisionResult } from './rail-pr-decision'
import {
  claimPrDeliveryOperation, getPrDelivery, releasePrDeliveryOperation, toPrDeliverySnapshot,
  toRailPrStateMessage, toPrDecisionCardEnvelope, transitionClaimedDecision,
  type PrDecisionOperation, type RailPrDeliveryRow,
} from './rail-pr-store'
import { applyRailPrTicketEffect } from './rail-pr-ticket-effects'
import { listRepositoryDeliveries, refreshRepositoryDeliveryGroup } from './multi-repo-execution'
import { readExecutionManifest } from './multi-repo-execution-store'

function completed(row: RailPrDeliveryRow): boolean {
  return row.decision === 'merged' || row.decision === 'completed'
}

/** A parent operation has one lease; each child keeps its own existing safe Git
 * decision and immutable SHA. A retry never reintegrates accepted repositories. */
export async function executeRepositoryGroupDecision(deps: PrDecisionDeps, input: PrDecisionInput): Promise<PrDecisionResult> {
  const parent = getPrDelivery(deps.db, input.prDeliveryId)
  if (!parent || !readExecutionManifest(parent.execution_manifest)) return { status: 404, body: { error: 'Unknown repository delivery group' } }
  if (parent.decision !== input.expectedDecision) return { status: 409, body: { error: 'stale_decision', current: parent.decision } }
  if (['building', 'merged', 'completed', 'discarded', 'superseded'].includes(parent.decision)) {
    return { status: 409, body: { error: 'stale_decision', current: parent.decision, reason: 'illegal_action' } }
  }
  const children = listRepositoryDeliveries(deps.db, parent.id)
  const selected = input.repositoryId ? children.filter((row) => row.repository_id === input.repositoryId) : children
  if (selected.length === 0) return { status: 404, body: { error: 'Unknown repository in this delivery' } }
  if ((input.action === 'discard' || input.action === 'dismiss') && children.some(completed)) {
    return { status: 409, body: { error: 'partial_delivery_already_integrated', detail: 'Complete the remaining repository deliveries; already accepted commits cannot be discarded.' } }
  }
  const steps = selected.flatMap((row) => {
    if (completed(row) || row.decision === 'discarded' || row.decision === 'superseded') return []
    const action: PrDecisionOperation = row.decision === 'no_changes' &&
      ['merge-local', 'poll-merge', 'acknowledge-no-changes'].includes(input.action)
      ? 'acknowledge-no-changes' : input.action
    return actionAllowed(action, row) ? [{ row, action }] : []
  })
  if (steps.length === 0) return { status: 409, body: { error: 'stale_decision', current: parent.decision, reason: 'illegal_action' } }
  const token = newId()
  if (!claimPrDeliveryOperation(deps.db, parent.id, parent.decision, input.action, token)) {
    return { status: 409, body: { error: 'operation_in_progress', current: getPrDelivery(deps.db, parent.id)?.decision } }
  }
  const outcomes: Array<{ repositoryId: string; status: number; body: Record<string, unknown> }> = []
  try {
    deps.assertAdmission?.()
    const ticketFile = deps.ticketFile ?? resolveProjectExecution(deps.project).ticketsPath
    for (const { row, action } of steps) {
      const current = getPrDelivery(deps.db, row.id)
      if (!current || current.parent_delivery_id !== parent.id || current.repository_path !== row.repository_path) {
        outcomes.push({ repositoryId: row.repository_id!, status: 409, body: { error: 'repository_delivery_changed' } })
        continue
      }
      const childDeps: PrDecisionDeps = {
        ...deps, project: { ...deps.project, path: row.repository_path! }, ticketFile,
        repositoryChildOf: parent.id, repositoryIntegrationBranch: readExecutionManifest(row.execution_manifest)?.repositories.find((repo) => repo.repositoryId === row.repository_id)?.integrationBranch, jiraSyncManager: undefined, broadcast: () => {}, agentChat: () => null,
      }
      try {
        const perform = () => executePrDecision(childDeps, { prDeliveryId: row.id, action, expectedDecision: current.decision })
        // merge-local already locks around its checkout resolution and merge.
        const result = action === 'merge-local' ? await perform() : await withRepoLock(row.repository_path!, perform)
        outcomes.push({ repositoryId: row.repository_id!, ...result })
      } catch (error) {
        outcomes.push({ repositoryId: row.repository_id!, status: 500, body: { error: 'repository_delivery_failed', detail: error instanceof Error ? error.message : String(error) } })
      }
      refreshRepositoryDeliveryGroup(deps.db, parent.id)
    }
    const aggregate = refreshRepositoryDeliveryGroup(deps.db, parent.id)!
    if (aggregate.decision === 'merged' || aggregate.decision === 'completed' || aggregate.decision === 'discarded') {
      const effect = applyRailPrTicketEffect(deps, aggregate.id)
      if (!effect.ok) transitionClaimedDecision(deps.db, aggregate.id, aggregate.decision, aggregate.decision, token, {
        statusCode: 'cleanup_incomplete', cleanupWarnings: [`Shared ticket update pending: ${effect.error ?? 'unknown error'}`],
      })
    }
    const failure = outcomes.find((outcome) => outcome.status >= 400)
    return {
      status: failure?.status ?? 200,
      body: { ok: !failure, ...(failure ? { error: 'repository_delivery_incomplete', detail: outcomes.filter((outcome) => outcome.status >= 400).map((outcome) => `${outcome.repositoryId}: ${outcome.body.detail ?? outcome.body.error ?? 'delivery failed'}`).join('; ') } : {}), repositories: outcomes,
        decision: aggregate.decision, prState: aggregate.pr_state, statusCode: aggregate.status_code, statusDetail: aggregate.status_detail,
        snapshot: toPrDeliverySnapshot(getPrDelivery(deps.db, parent.id)!), delivery: toPrDeliverySnapshot(getPrDelivery(deps.db, parent.id)!) },
    }
  } finally {
    releasePrDeliveryOperation(deps.db, parent.id, token)
    const current = getPrDelivery(deps.db, parent.id)
    if (current) {
      const snap = toPrDeliverySnapshot(current)
      deps.broadcast(toRailPrStateMessage(deps.project.id, snap))
      if (current.origin_conversation_id) {
        (deps.agentChat ?? getAgentChatManager)()?.updatePrDecisionCard(current.origin_conversation_id, toPrDecisionCardEnvelope(deps.project.id, snap))
      }
    }
  }
}
