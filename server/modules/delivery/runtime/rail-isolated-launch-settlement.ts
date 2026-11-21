/**
 * Isolated launch stage 3 — delivery and settlement wiring. When ALL runs
 * settle (in the background; the launch already returned its run ids) PR mode
 * persists the truthful settlement and the PR decision on the delivery row
 * BEFORE releasing worktrees; the legacy path merges back on the base repo.
 * An aggregate failure parks the building row as pr_failed with every
 * worktree preserved.
 */
import { recordLegacyLaunch } from '../../loops/runtime/legacy-launch-telemetry'
import * as path from 'path'
import { removeWorktree, type GitRunner } from '../../../worktree-manager'
import { updateRailWorktreeState } from './rail-worktrees-store'
import { getJobEvents } from '../../../db'
import { flowReviewOutcome, flowReviewStatusDetail } from './flow-review-outcome'
import { coreAnnouncesReviewBrief, harvestDeliveryEvidence } from './delivery-evidence'
import { phase3HarvestOptions } from './phase3-harvest'
import { getLoopRun, readDefinitionRun, readDefinitionForkTarget } from '../../loops/runtime/loop-runs-store'
import { probeDefinitionRun, probeDefinitionRuns } from '../../loops/runtime/loop-definition-recovery'
import {
  appendPrDeliverySafetyArchive, getPrDelivery, transitionDecision, type PrDecision, type PrDeliveryStatusCode,
} from './rail-pr-store'
import { settlePrCiGeneration } from './pr-ci/pr-ci-settlement'
import { PR_CI_LOOP_ID } from './pr-ci/pr-ci-target'
import { runMergeBack } from './rail-merge-orchestrator'
import { createLoopExecutors } from '../../loops/runtime/loop-executors'
import { resolveProjectExecution } from '../../../workspace-resolution'
import type { Exec } from './pr-publisher'
import type { ActivePrContinuationTarget } from './active-pr-continuation'
import {
  durableBranchHeads, durableOverlayCleanupEvidence, durableSettlementIgnoredPaths, releaseRailWorktrees,
} from './rail-worktree-release'
import type { BranchToMerge } from './merge-manager'
import type { AllocatedRun, IsolatedLaunchInput, IsolatedLaunchIO, SettledRun } from './rail-isolated-launch-contracts'
import {
  aggregateImplementationOutcome, branchRecords, captureSettlementIgnoredPaths, errorDetail,
} from './rail-isolated-launch-support'
import {
  applyContinuationOutcome, decidePrSettlement, observeAndPushContinuation, verifyContinuationCandidate,
} from './rail-isolated-launch-pr-decision'
import type { FrozenLaunchScope } from './rail-isolated-launch-scope'
import type { LaunchDeliveryPublisher, LaunchDeliveryState } from './rail-isolated-launch-delivery-state'
import type { MarkWorktree } from './rail-isolated-launch-runs'

export interface SettlementStageInput {
  input: IsolatedLaunchInput
  io: IsolatedLaunchIO
  git: GitRunner
  exec: Exec
  remove: typeof removeWorktree
  resolveExecution: typeof resolveProjectExecution
  baseRepo: string
  prMode: boolean
  constants: FrozenLaunchScope['constants']
  launchContinuation: ActivePrContinuationTarget | null
  allocated: AllocatedRun[]
  guardedRunPromises: Promise<SettledRun>[]
  markWorktree: MarkWorktree
  deliveryState: LaunchDeliveryState
  delivery: LaunchDeliveryPublisher
}

export function scheduleIsolatedSettlement(stage: SettlementStageInput): void {
  const { input, prMode, allocated, guardedRunPromises } = stage
  const { ctx } = input
  const { prDeliveryId } = stage.deliveryState
  // 3. When ALL runs settle → integrate on the base repo (background; the HTTP
  //    response has already returned the run ids). Two mutually-exclusive paths:
  //     • DEFAULT (flag off): legacy local merge-back into the checked-out branch.
  //     • PR mode (SPECRAILS_RAIL_DELIVER_PR on, captured at entry): leave the
  //       work isolated on its branches and mark the decision row on_review —
  //       the draft PR is only created when the user clicks [Create PR] on the
  //       pr-decision endpoint (ask-first, safe-pr-review-flow).
  void Promise.all(guardedRunPromises).then(async (settledResults) => {
    if (allocated.some(unit => readDefinitionForkTarget(ctx.db, unit.runId))) return
    if (prMode) {
      await settlePrDelivery(stage, settledResults)
      return // legacy merge-back never runs in PR mode
    }
    await runLegacyMergeBack(stage, settledResults)
  }).catch(async (err) => {
    await parkInterruptedSettlement(stage, err)

  }).finally(() => { input.repositoryExecution?.onSettled(prDeliveryId) })
}

async function settlePrDelivery(stage: SettlementStageInput, settledResults: SettledRun[]): Promise<void> {
  const { input, git, exec, remove, baseRepo, launchContinuation, allocated, markWorktree } = stage
  const { ctx, loopId } = input
  const { prDeliveryId } = stage.deliveryState
  const { broadcastPrState, syncOriginCard, notifyOriginRunFailure } = stage.delivery
  // Cardinality is invariant: one structured result per allocated unit. The
  // guarded promises above synthesize a blocked record for any rejection.
  let results = settledResults
  // Build-settle: persist the per-unit branch outcomes + this launch's
  // worktree ledger ids on the row (the deferred create-pr / discard actions
  // reconstruct their inputs from these — nothing survives in memory), then
  // hand the decision to the user. 0 succeeded units → nothing deliverable;
  // keep the implementation card visible as a failed job state with run-log
  // chips instead of silently auto-discarding or leaving it at "building".
  const worktreeIds = allocated.map((a) => a.ledgerId)
  const verified = await verifyContinuationCandidate({ git, baseRepo, launchContinuation, markWorktree }, results)
  results = verified.results
  const { deliverySha } = verified

  const implementationOutcome = aggregateImplementationOutcome(results)
  const ready = results.filter((result) => result.deliveryOutcome === 'ready')
  const noChanges = results.filter((result) => result.deliveryOutcome === 'no_changes')
  const continuationHadReadyWork = ready.length > 0

  const push = await observeAndPushContinuation({ exec, baseRepo, launchContinuation, deliverySha, continuationHadReadyWork, noChanges })
  const { continuationNeedsNewPr, continuationExactPushCompleted, continuationMergedWithSha, continuationClosedWithSha } = push
  results = applyContinuationOutcome(results, noChanges, push, markWorktree)
  const { deliveryOutcome, next, stoppedByPerson, statusCode, statusDetail } = decidePrSettlement({
    ctx, loopId, results, implementationOutcome, launchContinuation, push,
  })

  // pr-ci-loop: a CI loop generation stays attached to its OPEN PR whatever
  // the CI outcome; the outcome is its status, never an implementation failure.
  let ciSettlement: Awaited<ReturnType<typeof settlePrCiGeneration>> = null
  if (loopId === PR_CI_LOOP_ID && launchContinuation?.prUrl && !continuationNeedsNewPr && !continuationMergedWithSha && !continuationClosedWithSha) {
    try {
      const probe = results[0] ? await probeDefinitionRun({ db: ctx.db, cwd: ctx.project.path, env: process.env }, results[0].run.runId) : null
      ciSettlement = await settlePrCiGeneration({
        git, exec, baseRepo, deliveryId: prDeliveryId ?? '',
        continuation: { prUrl: launchContinuation.prUrl, branch: launchContinuation.branch, baseBranch: launchContinuation.baseBranch },
        worktrees: results.map(result => result.run.handle.worktreePath),
        completion: probe?.completion ? { ok: probe.completion.ok, reasons: probe.completion.reasons } : null,
        branches: branchRecords(results),
        captureIgnoredPaths: (worktree, overlayExcludes) => captureSettlementIgnoredPaths(git, worktree, overlayExcludes),
      })
    } catch (error) {
      console.warn(`[pr-ci] settlement fell back to the ordinary continuation: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Only proven-clean, durably referenced results are automatically
  // detached. Fresh reviewable worktrees stay mounted for the later PR
  // decision; dirty/unknown/ref-mismatched work is never passed to --force.
  const failedSafeIds = results
    .filter((result) => !ciSettlement && result.implementationOutcome === 'failed' && result.safeToRelease)
    .map((result) => result.run.ledgerId)
  const completedSafeIds = results
    .filter((result) => result.safeToRelease && (
      Boolean(ciSettlement) ||
      result.deliveryOutcome === 'no_changes' ||
      (launchContinuation !== null && result.deliveryOutcome === 'ready')
    ))
    .map((result) => result.run.ledgerId)
  const settledBranchRecords = ciSettlement?.branches ?? branchRecords(results)
  const expectedHeadByBranch = durableBranchHeads(settledBranchRecords)
  const overlayEvidenceByBranch = durableOverlayCleanupEvidence(settledBranchRecords)
  const settlementIgnoredByBranch = durableSettlementIgnoredPaths(settledBranchRecords)
  const settleEvidence = await harvestSettleEvidence(stage, results)
  // Intent -> Spec: a run that stopped because the work still needs changes
  // (review rejected / checks failing after the repair rounds) is not an
  // opaque implementation failure. Say so, with the reviewer's own words.
  const flowReview = flowReviewOutcome({ loopId, implementationOutcome, evidence: settleEvidence })
  const settledStatusCode: PrDeliveryStatusCode = flowReview ? 'review_changes_requested' : statusCode
  const settledStatusDetail = flowReview ? flowReviewStatusDetail(flowReview) : statusDetail
  if (flowReview) {
    for (const unit of settledBranchRecords) if (unit.failureCode === 'settlement_interrupted') unit.failureCode = 'review_changes_requested'
  }
  const settledNext: PrDecision = ciSettlement?.next ?? next
  const settledImplementationOutcome = ciSettlement ? 'succeeded' as const : implementationOutcome
  const patch = {
    settleEvidence,
    branches: settledBranchRecords,
    worktreeIds,
    implementationOutcome: settledImplementationOutcome,
    deliveryOutcome: ciSettlement ? 'delivered' as const : deliveryOutcome,
    statusCode: ciSettlement?.statusCode ?? settledStatusCode,
    statusDetail: ciSettlement ? ciSettlement.statusDetail : settledStatusDetail,
    deliverySha: ciSettlement?.deliverySha ?? deliverySha,
    ...(launchContinuation ? {
      branch: launchContinuation.branch,
      prUrl: continuationNeedsNewPr ? null : launchContinuation.prUrl,
      prNumber: continuationNeedsNewPr ? null : launchContinuation.prNumber,
      // A stale CLOSED/MERGED PR is detached from this generation. The exact
      // object remains locally or on its recorded branch, ready for Create PR.
      prState: continuationNeedsNewPr
        ? (continuationExactPushCompleted ? 'pushed' as const : 'local-only' as const)
        : 'pr-created' as const,
      // Once detached, this generation owns the lifecycle of the new PR,
      // while per-unit branchOwnership still protects the borrowed branch.
      isContinuation: !continuationNeedsNewPr,
    } : {}),
  }
  if (prDeliveryId && transitionDecision(ctx.db, prDeliveryId, 'building', settledNext, patch)) {
    // Persist truthful settlement before cleanup. A crash can leave a
    // safely-recoverable mount, but can no longer lose no-change/partial/
    // exact-SHA evidence and regress the card back to `building`.
    const settledPrDeliveryId = prDeliveryId
    const onSafetyArchive = (archive: string): void => {
      if (!appendPrDeliverySafetyArchive(ctx.db, settledPrDeliveryId, archive)) {
        throw new Error(`delivery ${settledPrDeliveryId} disappeared while recording safety archive ${archive}`)
      }
    }
    const cleanupWarnings = [
      ...await releaseRailWorktrees({
        db: ctx.db, git, repoDir: baseRepo, worktreeIds: failedSafeIds,
        state: 'failed', remove, expectedHeadByBranch, overlayEvidenceByBranch, settlementIgnoredByBranch, onSafetyArchive,
      }),
      ...await releaseRailWorktrees({
        db: ctx.db, git, repoDir: baseRepo, worktreeIds: completedSafeIds,
        remove, expectedHeadByBranch, overlayEvidenceByBranch, settlementIgnoredByBranch, onSafetyArchive,
      }),
    ]
    if (cleanupWarnings.length > 0) {
      transitionDecision(ctx.db, prDeliveryId, settledNext, settledNext, { cleanupWarnings })
    }
    broadcastPrState()
    // Completion driver: refresh the origin conversation's card in place —
    // on_review asks the question, discarded informs the outcome.
    syncOriginCard('update')
    // mission-rail-cards: an implementation failure also wakes the origin
    // mission (failure row + ONE bounded agent turn). Delivery failures
    // (pr_failed) keep the card's retry controls and stay silent.
    if (settledImplementationOutcome === 'failed' && !stoppedByPerson) {
      const failedUnit = results.find((result) => result.implementationOutcome === 'failed') ?? results[0]
      notifyOriginRunFailure(prDeliveryId, {
        code: flowReview ? 'review_changes_requested' : 'implementation_failed',
        detail: settledStatusDetail,
        stepId: null,
      }, failedUnit?.run.runId ?? null)
    }
  }
}

/** Review-packet evidence harvest; MUST run while reviewable worktrees are mounted. */
async function harvestSettleEvidence(stage: SettlementStageInput, results: SettledRun[]) {
  const { input, io, resolveExecution } = stage
  const { ctx, loopId } = input
  // Review-packet evidence harvest (deterministic, no model calls) — MUST
  // run while the reviewable worktrees are still mounted, i.e. before the
  // releaseRailWorktrees calls below. harvestDeliveryEvidence never throws
  // by contract; the belt-and-braces catch keeps settle unconditional.
  const harvest = io.harvestEvidence ?? harvestDeliveryEvidence
  let settleEvidence
  try {
    const definitionEvidence = await probeDefinitionRuns({ db: ctx.db, cwd: ctx.project.path, env: process.env },
      results.filter(result => getLoopRun(ctx.db, result.run.runId)?.engine_version === 2).map(result => result.run.runId), true)
    const reviewBrief = await (io.reviewBriefCapability ?? coreAnnouncesReviewBrief)()
    const phase3 = await phase3HarvestOptions({ db: ctx.db, project: ctx.project, capabilities: io.phase3Capabilities })
    settleEvidence = harvest(
      { readEvents: (runId) => getJobEvents(ctx.db, runId), reviewBrief, ...phase3 },
      results.map((result) => ({
        ticketId: result.run.ticketId,
        runId: result.run.runId,
        definitionStatus: definitionEvidence.get(result.run.runId),
        reviewerStepId: readDefinitionRun(ctx.db, result.run.runId)?.request.graph.config.reviewerStepId,
        worktreePath: result.run.handle.worktreePath,
        loopId,
        // Programmatic-runtime evidence (host-run verification, reviewer
        // verdict) lives in the workspace pipeline dir, not the worktree.
        runtimeDir: path.join(resolveExecution(ctx.project).specrailsDir, 'pipeline', result.run.runId),
      })),
    )
  } catch (e) {
    console.warn(`[rail-isolated] evidence harvest failed: ${e instanceof Error ? e.message : String(e)}`)
    settleEvidence = undefined
  }
  return settleEvidence
}

/** Legacy local merge-back into the checked-out branch (PR delivery off). */
async function runLegacyMergeBack(stage: SettlementStageInput, results: SettledRun[]): Promise<void> {
  const { input, git, remove, baseRepo, constants, allocated } = stage
  const { ctx, railIndex, ticketIds, loopId, provider, model, effort, deciderEngine } = input
  const branches: BranchToMerge[] = results.flatMap((result) =>
    result.run.ticketIds.map((ticketId) => ({
      ticketId,
      branch: result.run.handle.branch,
      succeeded: result.deliveryOutcome === 'ready',
    })),
  )

  try {
    if (branches.length) recordLegacyLaunch(ctx.db, { kind: 'merge_back', projectId: ctx.project.id, runId: allocated[0]?.runId })
    const outcomes = await runMergeBack({
      git, executor: createLoopExecutors(), baseDir: baseRepo,
      provider, model, effort, ...(deciderEngine ? { deciderEngine } : {}), constants, branches,
      // CRIT-2: record every merge-back AI step (verify/resolve-merge/fix) as a
      // `surface='job'` invocation tied to the rail (surface_ref_id
      // `${jobId}:merge:${step}`), primary ticket = ticketIds[0].
      recording: {
        db: ctx.db,
        projectId: ctx.project.id,
        jobId: `rail-${railIndex}-${loopId}`,
        ticketId: ticketIds[0] ?? null,
        broadcast: (msg) => ctx.broadcast(msg),
      },
      onState: (ticketId, state) => {
        const r = results.find((x) => x.run.ticketId === ticketId)
        if (state === 'merged' || state === 'needs-review') {
          if (r) updateRailWorktreeState(ctx.db, r.run.ledgerId, state)
          ctx.broadcast({ type: 'rail.worktree_progress', projectId: ctx.project.id, railIndex, ticketId, state })
        }
      },
    })
    for (const o of outcomes) {
      const r = results.find((x) => x.run.ticketId === o.ticketId)
      if (!r) continue
      if (!r.safeToRelease) {
        updateRailWorktreeState(ctx.db, r.run.ledgerId, 'needs-review')
        continue
      }
      // Merged → drop the branch; needs-review / skipped → keep the branch for the human.
      await remove(git, {
        repoDir: baseRepo, worktreePath: r.run.handle.worktreePath, branch: o.branch,
        // Legacy merge-back is still an automatic cleanup path. A non-force
        // unmount fails closed if anything changed after merge-back, and the
        // branch is retained because this path has no durable immutable tip
        // evidence with which to authorize a destructive `branch -D`.
        deleteBranch: false,
        force: false,
      }).then(() => {
        if (r.implementationOutcome === 'failed') updateRailWorktreeState(ctx.db, r.run.ledgerId, 'failed')
      }).catch(() => {})
    }
  } catch (err) {
    console.error('[rail-isolated] merge-back failed:', err)
  }
}

/** Aggregate settlement failed: park the building row, preserving every worktree. */
async function parkInterruptedSettlement(stage: SettlementStageInput, err: unknown): Promise<void> {
  const { input, prMode, allocated, guardedRunPromises, markWorktree } = stage
  const { ctx } = input
  const { prDeliveryId } = stage.deliveryState
  const { broadcastPrState, syncOriginCard } = stage.delivery
  if (allocated.some(unit => readDefinitionForkTarget(ctx.db, unit.runId))) return
  const detail = errorDetail(err)
  console.error(`[rail-isolated] aggregate settlement failed: ${detail}`)
  if (!prMode || !prDeliveryId || getPrDelivery(ctx.db, prDeliveryId)?.decision !== 'building') return
  const retained = await Promise.all(guardedRunPromises)
  for (const result of retained) markWorktree(result.run, 'needs-review')
  if (transitionDecision(ctx.db, prDeliveryId, 'building', 'pr_failed', {
    branches: branchRecords(retained.map((result) => ({
      ...result,
      deliveryOutcome: 'blocked' as const,
      failureCode: result.failureCode ?? 'settlement_interrupted',
      failureDetail: result.failureDetail ?? detail,
      safeToRelease: false,
    }))),
    worktreeIds: allocated.map((run) => run.ledgerId),
    implementationOutcome: aggregateImplementationOutcome(retained),
    deliveryOutcome: 'blocked',
    statusCode: 'settlement_interrupted',
    statusDetail: detail,
  })) {
    broadcastPrState()
    syncOriginCard('update')
  }
}
