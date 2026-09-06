import { newId } from './ids'
import { withRepoLock } from './repo-lock'
import { checkoutProjectReviewBranch, getProjectGitInfo, inspectProjectCheckoutCleanliness } from './project-git'
import {
  appendPrDeliverySafetyArchive, claimPrDeliveryOperation, releasePrDeliveryOperation, getActivePrDeliveryByRail, getPrDelivery, isTerminalPrDecision,
  toPrDeliverySnapshot, toRailPrStateMessage, toPrDecisionCardEnvelope, transitionDecision,
  type PrDeliverySnapshot,
} from './rail-pr-store'
import { durableBranchHeads, durableOverlayCleanupEvidence, durableSettlementIgnoredPaths, releaseRailWorktrees } from './rail-worktree-release'
import type { PrDecisionDeps, PrDecisionResult } from './rail-pr-decision'
import { listRepositoryDeliveries, refreshRepositoryDeliveryGroup } from './multi-repo-execution'
import { getAgentChatManager } from './agent-chat-registry'

export function repositoryDeliveryCheckoutTarget(delivery: PrDeliverySnapshot): { branch: string; sha: string } | null {
  if (delivery.branch && delivery.deliverySha) return { branch: delivery.branch, sha: delivery.deliverySha }
  const units = delivery.branches
  if (!delivery.branch && !delivery.deliverySha && units.length === 1 && units[0].succeeded && units[0].finalSha &&
    units[0].deliveryOutcome !== 'blocked' && units[0].deliveryOutcome !== 'no_changes' &&
    units[0].implementationOutcome !== 'failed' && units[0].changed !== false) {
    return { branch: units[0].branch, sha: units[0].finalSha }
  }
  return null
}

function checkoutBlock(delivery: PrDeliverySnapshot): string | null {
  if (isTerminalPrDecision(delivery.decision) || ['building', 'implementation_failed', 'no_changes'].includes(delivery.decision)) return 'delivery is not awaiting implementation review'
  if (delivery.deliveryOutcome === 'blocked') return 'delivery is blocked and has no safely checkoutable result'
  const target = repositoryDeliveryCheckoutTarget(delivery)
  return target && /^[0-9a-f]{40,64}$/i.test(target.sha) ? null : 'delivery has no verified commit available for checkout'
}

/** Checkout changes one physical checkout; it never accepts a shared spec. */
export async function checkoutRepositoryDelivery(
  deps: PrDecisionDeps,
  input: { prDeliveryId: string; repositoryId?: string },
): Promise<PrDecisionResult> {
  const parent = getPrDelivery(deps.db, input.prDeliveryId)
  if (!parent || parent.parent_delivery_id || !parent.execution_manifest) return { status: 404, body: { error: 'Unknown repository delivery group' } }
  const children = listRepositoryDeliveries(deps.db, parent.id)
  if (!input.repositoryId && children.length !== 1) return { status: 400, body: { error: 'repositoryId_required', detail: 'Choose the repository checkout to move.' } }
  const child = input.repositoryId ? children.find((row) => row.repository_id === input.repositoryId) : children[0]
  if (!child?.repository_path) return { status: 404, body: { error: 'Unknown repository in this delivery' } }
  return withRepoLock(child.repository_path, async () => {
    deps.assertAdmission?.()
    const active = getActivePrDeliveryByRail(deps.db, parent.rail_index)
    if (active?.id !== parent.id) return { status: 409, body: { error: 'stale_decision', currentPrDeliveryId: active?.id ?? null } }
    if (active.operation_token) return { status: 409, body: { error: 'operation_in_progress' } }
    const token = newId()
    if (!claimPrDeliveryOperation(deps.db, parent.id, active.decision, 'checkout', token)) return { status: 409, body: { error: 'operation_in_progress' } }
    const perform = async (): Promise<PrDecisionResult> => {
    const current = getPrDelivery(deps.db, child.id)!
    const snap = toPrDeliverySnapshot(current)
    const block = checkoutBlock(snap)
    if (block) return { status: 409, body: { error: 'checkout_not_deliverable', detail: block } }
    const target = repositoryDeliveryCheckoutTarget(snap)!
    const cleanliness = await inspectProjectCheckoutCleanliness(child.repository_path!)
    if (!cleanliness.ok) return { status: 409, body: { error: 'checkout_safety_unknown', detail: cleanliness.detail } }
    const git = await getProjectGitInfo(child.repository_path!)
    if (!git.git) return { status: 409, body: { error: 'checkout_unavailable', detail: 'repository is not a Git checkout' } }
    const cleanupWarnings = await releaseRailWorktrees({
      db: deps.db, git: deps.git, repoDir: child.repository_path!, worktreeIds: snap.worktreeIds,
      expectedHeadByBranch: durableBranchHeads(snap.branches), overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
      settlementIgnoredByBranch: durableSettlementIgnoredPaths(snap.branches),
      onSafetyArchive: (archive) => {
        if (!appendPrDeliverySafetyArchive(deps.db, child.id, archive)) throw new Error(`delivery ${child.id} disappeared while recording safety archive`)
      },
    })
    transitionDecision(deps.db, child.id, current.decision, current.decision, {
      cleanupWarnings,
      ...(cleanupWarnings.length ? { statusCode: 'cleanup_incomplete' as const } : snap.statusCode === 'cleanup_incomplete' ? { statusCode: null } : {}),
    })
    const stillActive = getActivePrDeliveryByRail(deps.db, parent.rail_index)
    const outcome = stillActive?.id === parent.id
      ? await checkoutProjectReviewBranch(child.repository_path!, target.branch, target.sha)
      : { ok: false as const, error: 'The delivery generation changed before checkout.' }
    if (!outcome.ok) return { status: 409, body: { error: 'checkout_failed', detail: [outcome.error, ...cleanupWarnings].join('\n') } }
    return { status: 200, body: { ok: true, repositoryId: child.repository_id, branch: target.branch,
      git: await getProjectGitInfo(child.repository_path!), cleanupWarnings } }
    }
    let result: PrDecisionResult
    try { result = await perform() } finally { releasePrDeliveryOperation(deps.db, parent.id, token) }
    const updated = refreshRepositoryDeliveryGroup(deps.db, parent.id)!
    const parentSnap = toPrDeliverySnapshot(updated)
    deps.broadcast(toRailPrStateMessage(deps.project.id, parentSnap))
    if (updated.origin_conversation_id) (deps.agentChat ?? getAgentChatManager)()?.updatePrDecisionCard(updated.origin_conversation_id, toPrDecisionCardEnvelope(deps.project.id, parentSnap))
    return { status: result.status, body: { ...result.body, snapshot: parentSnap } }
  })
}
