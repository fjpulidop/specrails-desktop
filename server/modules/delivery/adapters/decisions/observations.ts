import { durableBranchHeads, durableOverlayCleanupEvidence, durableSettlementIgnoredPaths, releaseRailWorktrees } from '../../runtime/rail-worktree-release'
import {
  toPrDeliverySnapshot, type DeliverBranchRecord, type PrDecision, type PrDeliverySnapshot, type RailPrDeliveryRow
} from '../../runtime/rail-pr-store'
import {
  type PrLifecycleObservation
} from '../../runtime/pr-lifecycle'
import { PrDecisionDeps, PrDecisionResult } from './contracts'
import { releasableWorktreeIds, deleteOwnedBranchesIfUnchanged } from './ownership'
import { safetyArchiveRecorder, casTransition, finalizeTransition, casTransitionWithTicketEffect, applyTerminalTicketEffect } from './transitions'
import { releaseDeliveredRecoveryLineage } from './evidence'
import { sweepMergedChainAncestors } from './chains'


export function mergedEvidenceDetail(observation: PrLifecycleObservation): string {
  return observation.includesExpectedSha === null
    ? 'GitHub did not return enough commit evidence to prove the previous PR included the verified implementation commit'
    : 'the previous PR merged without the verified implementation commit'
}


export async function rerouteFromStalePr(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  detail: string,
  exactWasPushed: boolean,
): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings = await releaseRailWorktrees({
    db: deps.db, git: deps.git, repoDir: deps.project.path,
    worktreeIds: releasableWorktreeIds(deps, snap),
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    settlementIgnoredByBranch: durableSettlementIgnoredPaths(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  })
  const partial = row.implementation_outcome === 'partially_succeeded'
  const preserved = row.delivery_sha ? 'the preserved exact commit' : 'the preserved recorded branch'
  const conflict = casTransition(deps, row, 'on_review', {
    prUrl: null,
    prNumber: null,
    prState: exactWasPushed ? 'pushed' : 'local-only',
    deliveryOutcome: partial ? 'partial' : 'ready',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : partial ? 'partial_success' : 'ready_for_review',
    statusDetail: `${detail}; create a new draft PR from ${preserved}`,
    cleanupWarnings,
    // The replacement PR belongs to this generation. Per-unit branch ownership
    // remains unchanged so a borrowed/pre-existing ref is still never deleted.
    isContinuation: false,
  })
  if (conflict) return conflict
  const after = finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'on_review',
      prUrl: null,
      prState: after?.prState ?? (exactWasPushed ? 'pushed' : 'local-only'),
      rerouted: true,
      detail,
    },
  }
}


export async function settleObservedExistingPr(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  observation: PrLifecycleObservation,
  pushed: boolean,
): Promise<PrDecisionResult> {
  const next: Extract<PrDecision, 'pr_draft' | 'pr_ready'> =
    observation.state === 'MERGED' || observation.isDraft === false ? 'pr_ready' : 'pr_draft'
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings = await releaseRailWorktrees({
    db: deps.db, git: deps.git, repoDir: deps.project.path,
    worktreeIds: releasableWorktreeIds(deps, snap),
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    settlementIgnoredByBranch: durableSettlementIgnoredPaths(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  })
  const conflict = casTransition(deps, row, next, {
    prState: 'pr-created',
    deliveryOutcome: 'delivered',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : next === 'pr_ready' ? 'pr_ready' : 'existing_pr_updated',
    statusDetail: null,
    cleanupWarnings,
  })
  if (conflict) return conflict
  await releaseDeliveredRecoveryLineage(deps, row, row.delivery_sha)
  const after = finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: next,
      prUrl: after?.prUrl ?? row.pr_url,
      prState: 'pr-created',
      deliveryVerified: true,
      verifiedSha: row.delivery_sha,
      remoteHeadSha: observation.headRefOid,
      pushed,
    },
  }
}


export async function settleObservedClosedPr(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  observation: PrLifecycleObservation,
): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings = await releaseRailWorktrees({
    db: deps.db, git: deps.git, repoDir: deps.project.path,
    worktreeIds: releasableWorktreeIds(deps, snap),
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    settlementIgnoredByBranch: durableSettlementIgnoredPaths(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  })
  const conflict = casTransition(deps, row, 'pr_closed', {
    prState: 'pr-created',
    deliveryOutcome: 'delivered',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'pr_closed',
    statusDetail: null,
    cleanupWarnings,
  })
  if (conflict) return conflict
  await releaseDeliveredRecoveryLineage(deps, row, row.delivery_sha)
  const after = finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'pr_closed',
      closed: true,
      merged: false,
      prUrl: after?.prUrl ?? row.pr_url,
      prState: 'pr-created',
      deliveryVerified: true,
      verifiedSha: row.delivery_sha,
      remoteHeadSha: observation.headRefOid,
      pushed: false,
    },
  }
}


export function persistRetryablePrObservationFailure(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  detail: string,
): PrDecisionResult {
  const conflict = casTransition(deps, row, 'pr_failed', {
    deliveryOutcome: 'retryable_failure',
    statusCode: 'push_failed',
    statusDetail: detail,
  })
  if (conflict) return conflict
  finalizeTransition(deps, row.id)
  return { status: 200, body: { ok: true, decision: 'pr_failed', prUrl: row.pr_url, detail } }
}


export function persistMovedPrHead(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  detail: string,
): PrDecisionResult {
  const conflict = casTransition(deps, row, 'pr_failed', {
    deliveryOutcome: 'blocked',
    statusCode: 'branch_verification_failed',
    statusDetail: detail,
  })
  if (conflict) return conflict
  finalizeTransition(deps, row.id)
  return { status: 200, body: { ok: true, decision: 'pr_failed', prUrl: row.pr_url, detail } }
}


export function persistRecoveryBlocked(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  detail: string,
  deliverySha?: string | null,
): PrDecisionResult {
  const conflict = casTransition(deps, row, 'pr_failed', {
    deliveryOutcome: 'blocked',
    statusCode: 'recovery_unavailable',
    statusDetail: detail,
    ...(deliverySha !== undefined ? { deliverySha } : {}),
    isContinuation: true,
  })
  if (conflict) return conflict
  finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'pr_failed',
      prUrl: row.pr_url,
      recoveryUnavailable: true,
      detail,
    },
  }
}


export function persistProtectedRecoveryRetry(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  snap: PrDeliverySnapshot,
  matchingUnitIndexes: number[],
  runId: string,
  candidateSha: string,
  detail: string,
): PrDecisionResult {
  const recoveredIndexes = new Set(matchingUnitIndexes)
  const recoveredBranches = snap.branches.map((unit, index): DeliverBranchRecord => recoveredIndexes.has(index)
    ? {
        ...unit,
        runId,
        branch: row.branch!,
        succeeded: true,
        implementationOutcome: 'succeeded',
        deliveryOutcome: 'ready',
        finalSha: candidateSha,
        changed: unit.changed ?? (
          unit.initialSha ? unit.initialSha.toLowerCase() !== candidateSha.toLowerCase() : true
        ),
        failureCode: null,
        branchOwnership: 'borrowed-pr',
      }
    : unit)
  const conflict = casTransition(deps, row, 'pr_failed', {
    branches: recoveredBranches,
    deliverySha: candidateSha,
    deliveryOutcome: 'retryable_failure',
    statusCode: 'settlement_interrupted',
    statusDetail: detail,
    isContinuation: true,
  })
  if (conflict) return conflict
  finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'pr_failed',
      prUrl: row.pr_url,
      recovered: true,
      detail,
    },
  }
}


export async function settleMergedPr(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings = await releaseRailWorktrees({
    db: deps.db, git: deps.git, repoDir: deps.project.path,
    worktreeIds: releasableWorktreeIds(deps, snap), state: 'merged',
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    settlementIgnoredByBranch: durableSettlementIgnoredPaths(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  })
  await deleteOwnedBranchesIfUnchanged(deps, row, snap, cleanupWarnings)

  const conflict = casTransitionWithTicketEffect(deps, row, 'merged', {
    deliveryOutcome: 'delivered',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'merged',
    statusDetail: null,
    cleanupWarnings,
  }, {
    deliveryId: row.id,
    ticketIds: snap.ticketIds,
    targetStatus: 'done',
    jiraAction: 'merged',
    prUrl: row.pr_url,
  })
  if (conflict) return conflict
  await releaseDeliveredRecoveryLineage(deps, row, row.delivery_sha)
  applyTerminalTicketEffect(deps, row, 'merged', cleanupWarnings)
  finalizeTransition(deps, row.id)
  await sweepMergedChainAncestors(deps, row)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'merged',
      merged: true,
      prUrl: row.pr_url,
      ...(row.delivery_sha ? {
        deliveryVerified: true,
        verifiedSha: row.delivery_sha,
        pushed: false,
      } : {}),
    },
  }
}
