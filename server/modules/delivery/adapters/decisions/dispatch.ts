import { actionAllowed } from '../..'
import {
  claimPrDeliveryOperation, getPrDelivery,
  releasePrDeliveryOperation, hasRepositoryDeliveries
} from '../../runtime/rail-pr-store'
import { newId } from '../../../../ids'
import { PrDecisionDeps, PrDecisionInput, PrDecisionResult } from './contracts'
import { staleDecision, illegalAction, deferredFinalizations, finalizeTransition } from './transitions'
import { runCreatePr } from './create'
import { runPublish, runPollMerge, runReopen } from './publish'
import { runDiscard, runDismiss, runAcknowledgeNoChanges } from './discard'
import { runMergeLocal } from './merge-local'
import { runRecoverAndRetry } from './recovery'


export async function executePrDecision(deps: PrDecisionDeps, input: PrDecisionInput): Promise<PrDecisionResult> {
  const row = getPrDelivery(deps.db, input.prDeliveryId)
  if (!row) return { status: 404, body: { error: 'Unknown prDeliveryId' } }
  if (row.parent_delivery_id && deps.repositoryChildOf !== row.parent_delivery_id) return { status: 409, body: { error: 'repository_delivery_requires_parent', parentDeliveryId: row.parent_delivery_id } }
  // A manifest alone does not make a repository GROUP: a launch that failed
  // before allocating a single repository delivery persists the parent with
  // its manifest and zero children (observed: `git worktree add` refused
  // because the PR branch was checked out in the main clone). Routing that
  // parent into the group path 404'd on "no repositories" — which the UI read
  // as "already resolved" — and left the rail pinned at pending_decision.
  if (!row.parent_delivery_id && row.execution_manifest && hasRepositoryDeliveries(deps.db, row.id)) {
    const { executeRepositoryGroupDecision } = await import('../../runtime/multi-repo-delivery')
    return executeRepositoryGroupDecision(deps, input)
  }

  // Compare-and-set pre-check: the caller decided against a snapshot — if the
  // row moved on (the other surface answered first), it must reconcile, not act.
  if (row.decision !== input.expectedDecision) return staleDecision(row.decision)
  if (!actionAllowed(input.action, row)) return illegalAction(row.decision)

  // Claim before any git/GitHub/cleanup/ticket effect. The visible decision is
  // unchanged while the winner works, but a second surface cannot start.
  const operationToken = newId()
  if (!claimPrDeliveryOperation(deps.db, row.id, row.decision, input.action, operationToken)) {
    const current = getPrDelivery(deps.db, row.id)
    if (!current || current.decision !== input.expectedDecision) {
      return staleDecision(current?.decision ?? row.decision)
    }
    return {
      status: 409,
      body: { error: 'operation_in_progress', current: current.decision, operation: current.operation },
    }
  }

  const claimedRow = getPrDelivery(deps.db, row.id)
  if (!claimedRow || claimedRow.operation_token !== operationToken) {
    return { status: 409, body: { error: 'operation_in_progress', current: claimedRow?.decision ?? row.decision } }
  }

  try {
    switch (input.action) {
      case 'create-pr': return await runCreatePr(deps, claimedRow)
      case 'publish': return await runPublish(deps, claimedRow)
      case 'discard': return await runDiscard(deps, claimedRow)
      case 'dismiss': return await runDismiss(deps, claimedRow)
      case 'poll-merge': return await runPollMerge(deps, claimedRow)
      case 'reopen': return await runReopen(deps, claimedRow)
      case 'merge-local': return await runMergeLocal(deps, claimedRow)
      case 'acknowledge-no-changes': return await runAcknowledgeNoChanges(deps, claimedRow)
      case 'recover-and-retry': return await runRecoverAndRetry(deps, claimedRow)
    }
    return illegalAction(row.decision)
  } finally {
    try { releasePrDeliveryOperation(deps.db, row.id, operationToken) } catch { /* durable state remains authoritative */ }
    if (deferredFinalizations.delete(row.id)) finalizeTransition(deps, row.id)
  }
}
