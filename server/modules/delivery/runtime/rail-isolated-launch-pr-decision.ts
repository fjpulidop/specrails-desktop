/**
 * Isolated settlement PR decision: re-verify an existing-PR continuation's
 * settled SHA, observe the PR lifecycle before and after the exact push, and
 * derive the delivery outcome, next decision and status code from the settled
 * units and those observations.
 */
import type { GitRunner } from '../../../worktree-manager'
import { getLoopRun } from '../../loops/runtime/loop-runs-store'
import type { PrDecision, PrDeliveryOutcome, PrDeliveryStatusCode, PrImplementationOutcome } from './rail-pr-store'
import { pushBranch, type Exec } from './pr-publisher'
import type { ActivePrContinuationTarget } from './active-pr-continuation'
import { isExactOpenPr, matchesRecordedPrIdentity, observePrLifecycle, verifyPushRemoteForPr } from './pr-lifecycle'
import type { ProjectContext } from '../../../project-registry'
import type { SettledRun } from './rail-isolated-launch-contracts'
import { PrContinuationIsolationError, RUN_STOPPED_DETAIL, isStoppedByPerson } from './rail-isolated-launch-contracts'
import { errorDetail, verifyContinuationWorktree } from './rail-isolated-launch-support'
import type { MarkWorktree } from './rail-isolated-launch-runs'

/** Revalidate the continuation candidate's settled SHA before any push. */
export async function verifyContinuationCandidate(
  p: { git: GitRunner; baseRepo: string; launchContinuation: ActivePrContinuationTarget | null; markWorktree: MarkWorktree },
  settledResults: SettledRun[],
): Promise<{ results: SettledRun[]; deliverySha: string | null }> {
  const { git, baseRepo, launchContinuation, markWorktree } = p
  let results = settledResults
  let deliverySha: string | null = null

  const unchangedContinuation = launchContinuation
    ? results.find((result) => result.run.continuationTarget && result.deliveryOutcome === 'no_changes')
    : undefined
  if (unchangedContinuation?.finalSha) deliverySha = unchangedContinuation.finalSha

  // Revalidate immediately before an existing-PR push. Settlement's SHA is
  // immutable delivery evidence; a moved ref blocks instead of substituting
  // a newer object behind the user's back.
  if (launchContinuation) {
    const candidateIndex = results.findIndex((result) =>
      result.deliveryOutcome === 'ready' && result.run.continuationTarget !== null,
    )
    if (candidateIndex >= 0) {
      const candidate = results[candidateIndex]
      try {
        const verified = await verifyContinuationWorktree(
          git,
          baseRepo,
          candidate.run.handle,
          candidate.run.continuationTarget!,
          candidate.finalSha,
        )
        if (!candidate.finalSha || verified !== candidate.finalSha) {
          throw new PrContinuationIsolationError('PR branch moved after settlement; refusing to push an unverified object')
        }
        deliverySha = candidate.finalSha
      } catch (err) {
        const detail = errorDetail(err)
        markWorktree(candidate.run, 'needs-review')
        results = results.map((result, resultIndex) => resultIndex === candidateIndex
          ? {
              ...result,
              deliveryOutcome: 'blocked' as const,
              failureCode: 'branch_verification_failed' as const,
              failureDetail: detail,
              safeToRelease: false,
            }
          : result)
      }
    }
  }
  return { results, deliverySha }
}

export type ContinuationPushOutcome = Awaited<ReturnType<typeof observeAndPushContinuation>>

/** Lifecycle observation + exact push for an existing-PR continuation. */
export async function observeAndPushContinuation(p: {
  exec: Exec
  baseRepo: string
  launchContinuation: ActivePrContinuationTarget | null
  deliverySha: string | null
  continuationHadReadyWork: boolean
  noChanges: readonly SettledRun[]
}) {
  const { exec, baseRepo, launchContinuation, deliverySha, continuationHadReadyWork, noChanges } = p
  let continuationPushFailed = false
  let continuationPushFailureReason: string | null = null
  let continuationNeedsNewPr = false
  let continuationExactPushCompleted = false
  let continuationRemoteIsDraft = launchContinuation?.isDraft ?? null
  let continuationMergedWithSha = false
  let continuationClosedWithSha = false
  let continuationLifecycleBlocked = false

  if (launchContinuation && deliverySha && (continuationHadReadyWork || noChanges.length > 0)) {
    const beforePush = await observePrLifecycle(
      exec, baseRepo, launchContinuation.prUrl!, deliverySha,
    )
    if (!beforePush.ok) {
      continuationPushFailed = true
      continuationPushFailureReason = `could not confirm the existing PR is open before push: ${beforePush.detail}`
    } else if (!isExactOpenPr(beforePush, launchContinuation.branch, launchContinuation.baseBranch)) {
      const identityMatches = matchesRecordedPrIdentity(
        beforePush,
        launchContinuation.branch,
        launchContinuation.baseBranch,
      )
      if (beforePush.state === 'MERGED' && identityMatches && beforePush.includesExpectedSha === true) {
        // Another actor delivered the exact object before our push. Keep the
        // old PR attached so poll-merge can apply the terminal ticket effect.
        continuationRemoteIsDraft = false
        continuationMergedWithSha = true
      } else if (
        beforePush.state === 'CLOSED' && identityMatches &&
        beforePush.includesExpectedSha === true && !continuationHadReadyWork
      ) {
        // An unchanged iteration may safely offer Reopen when the closed PR
        // already contains its exact head. Changed work is never assumed to
        // belong to a closed PR before we push it.
        continuationClosedWithSha = true
      } else {
        continuationNeedsNewPr = true
        continuationPushFailureReason = beforePush.includesExpectedSha === null
          ? `the previous PR is ${beforePush.state.toLowerCase()} and GitHub could not prove it included this implementation; create a new draft PR from the preserved commit`
          : `the previous PR is ${beforePush.state.toLowerCase()} without this implementation; create a new draft PR from the preserved commit`
      }
    } else if (!continuationHadReadyWork) {
      // No-change still needs lifecycle truth: the PR may have merged while
      // the run was active, and an advanced remote head must not be silently
      // dismissed as though it were the verified unchanged object.
      if (beforePush.headRefOid?.toLowerCase() !== deliverySha.toLowerCase()) {
        continuationLifecycleBlocked = true
        continuationPushFailureReason = 'the open PR head no longer exposes the exact verified commit from this unchanged iteration'
      } else {
        continuationRemoteIsDraft = beforePush.isDraft
      }
    } else {
      continuationRemoteIsDraft = beforePush.isDraft
      const pushRemote = await verifyPushRemoteForPr(
        exec, baseRepo, launchContinuation.prUrl!,
      )
      if (!pushRemote.ok) {
        continuationPushFailed = true
        continuationPushFailureReason = `refusing to push the preserved implementation: ${pushRemote.detail}`
      } else {
        try {
          const pushed = await pushBranch(exec, {
            repoDir: baseRepo,
            branch: launchContinuation.branch,
            baseBranch: launchContinuation.baseBranch,
            remote: pushRemote.pushTarget,
            sourceSha: deliverySha,
          })
          if (pushed.state === 'local-only') {
            continuationPushFailed = true
            continuationPushFailureReason = pushed.reason
          } else {
            continuationExactPushCompleted = true
            const afterPush = await observePrLifecycle(
              exec, baseRepo, launchContinuation.prUrl!, deliverySha,
            )
            if (!afterPush.ok) {
              continuationPushFailed = true
              continuationPushFailureReason = `exact commit was pushed, but the PR lifecycle could not be confirmed: ${afterPush.detail}`
            } else if (isExactOpenPr(afterPush, launchContinuation.branch, launchContinuation.baseBranch)) {
              if (afterPush.headRefOid?.toLowerCase() === deliverySha.toLowerCase()) {
                continuationRemoteIsDraft = afterPush.isDraft
              } else {
                // GitHub observation can lag a successful push, or another
                // writer may have moved the remote head. The retry remains
                // safe because it always uses the immutable SHA and a normal
                // non-forced refspec; preserve evidence and keep Retry push.
                continuationPushFailed = true
                continuationPushFailureReason = 'the exact push completed, but the PR does not yet expose the verified commit as its head; Retry push remains safe and uses the preserved SHA'
              }
            } else if (
              afterPush.state === 'MERGED' &&
              matchesRecordedPrIdentity(
                afterPush,
                launchContinuation.branch,
                launchContinuation.baseBranch,
              ) &&
              afterPush.includesExpectedSha === true
            ) {
              // The PR won the race but demonstrably included this exact SHA.
              continuationRemoteIsDraft = false
              continuationMergedWithSha = true
            } else if (
              afterPush.state === 'CLOSED' &&
              matchesRecordedPrIdentity(
                afterPush,
                launchContinuation.branch,
                launchContinuation.baseBranch,
              ) &&
              afterPush.includesExpectedSha === true
            ) {
              continuationClosedWithSha = true
            } else if (afterPush.state === 'MERGED' || afterPush.state === 'CLOSED') {
              continuationNeedsNewPr = true
              continuationPushFailureReason = afterPush.includesExpectedSha === null
                ? `the previous PR became ${afterPush.state.toLowerCase()} and GitHub could not prove it included this implementation; create a new draft PR from the preserved commit`
                : `the previous PR became ${afterPush.state.toLowerCase()} without this implementation; create a new draft PR from the preserved commit`
            } else {
              continuationNeedsNewPr = true
              continuationPushFailureReason = 'the existing PR no longer matches its recorded head/base after the exact push; create a new draft PR from the preserved commit'
            }
          }
        } catch (err) {
          continuationPushFailed = true
          continuationPushFailureReason = errorDetail(err)
        }
      }
    }
    if (continuationPushFailed) {
      console.warn(`[rail-isolated] existing PR follow-up push failed for ${launchContinuation.branch}: ${continuationPushFailureReason}`)
    }
  }
  return {
    continuationPushFailed, continuationPushFailureReason, continuationNeedsNewPr, continuationExactPushCompleted,
    continuationRemoteIsDraft, continuationMergedWithSha, continuationClosedWithSha, continuationLifecycleBlocked,
  }
}

/** Rewrite unit outcomes the lifecycle observation invalidated or revived. */
export function applyContinuationOutcome(
  settledResults: SettledRun[],
  noChanges: readonly SettledRun[],
  push: ContinuationPushOutcome,
  markWorktree: MarkWorktree,
): SettledRun[] {
  const { continuationNeedsNewPr, continuationLifecycleBlocked, continuationPushFailureReason } = push
  let results = settledResults
  if (continuationNeedsNewPr && noChanges.length > 0) {
    // The iteration itself made no new commit, but the old PR did not deliver
    // its verified head. That head is therefore real work for a fresh PR.
    const noChangeRuns = new Set(noChanges.map((result) => result.run.runId))
    results = results.map((result) => noChangeRuns.has(result.run.runId)
      ? { ...result, deliveryOutcome: 'ready' as const }
      : result)
  }
  if (continuationLifecycleBlocked) {
    const affectedRuns = new Set(
      results
        .filter((result) => result.run.continuationTarget !== null &&
          (result.deliveryOutcome === 'ready' || result.deliveryOutcome === 'no_changes'))
        .map((result) => result.run.runId),
    )
    for (const result of results) {
      if (affectedRuns.has(result.run.runId)) markWorktree(result.run, 'needs-review')
    }
    results = results.map((result) => affectedRuns.has(result.run.runId)
      ? {
          ...result,
          deliveryOutcome: 'blocked' as const,
          failureCode: 'branch_verification_failed' as const,
          failureDetail: continuationPushFailureReason ?? 'PR lifecycle verification failed',
          safeToRelease: false,
        }
      : result)
  }
  return results
}

/** Delivery outcome, next decision and status for the settled generation. */
export function decidePrSettlement(p: {
  ctx: ProjectContext
  loopId: string
  results: SettledRun[]
  implementationOutcome: PrImplementationOutcome
  launchContinuation: ActivePrContinuationTarget | null
  push: ContinuationPushOutcome
}) {
  const { ctx, loopId, results, implementationOutcome, launchContinuation } = p
  const {
    continuationPushFailed, continuationPushFailureReason, continuationNeedsNewPr, continuationRemoteIsDraft,
    continuationMergedWithSha, continuationClosedWithSha, continuationLifecycleBlocked,
  } = p.push
  const ready = results.filter((result) => result.deliveryOutcome === 'ready')
  const blocked = results.filter((result) => result.deliveryOutcome === 'blocked')
  const noChanges = results.filter((result) => result.deliveryOutcome === 'no_changes')

  let deliveryOutcome: PrDeliveryOutcome
  if (implementationOutcome === 'failed') {
    deliveryOutcome = blocked.length > 0 ? 'blocked' : 'not_started'
  } else if (continuationLifecycleBlocked) {
    deliveryOutcome = 'blocked'
  } else if (continuationMergedWithSha || continuationClosedWithSha) {
    deliveryOutcome = 'delivered'
  } else if (launchContinuation && ready.length > 0) {
    deliveryOutcome = continuationNeedsNewPr
      ? (implementationOutcome === 'partially_succeeded' ? 'partial' : 'ready')
      : continuationPushFailed ? 'retryable_failure' : 'delivered'
  } else if (ready.length > 0) {
    deliveryOutcome = implementationOutcome === 'partially_succeeded' || blocked.length > 0 ? 'partial' : 'ready'
  } else if (noChanges.length === results.length && implementationOutcome === 'succeeded') {
    deliveryOutcome = 'no_changes'
  } else if (implementationOutcome === 'partially_succeeded') {
    deliveryOutcome = 'partial'
  } else {
    deliveryOutcome = 'blocked'
  }

  const next: PrDecision = implementationOutcome === 'failed'
    ? 'implementation_failed'
    : continuationLifecycleBlocked
      ? 'pr_failed'
      : continuationMergedWithSha
        ? 'pr_ready'
        : continuationClosedWithSha
          ? 'pr_closed'
    : ready.length > 0
      ? (launchContinuation
          ? (continuationNeedsNewPr
              ? 'on_review'
              : continuationPushFailed
              ? 'pr_failed'
              : (continuationRemoteIsDraft === false ? 'pr_ready' : 'pr_draft'))
          : 'on_review')
      : deliveryOutcome === 'no_changes'
        ? 'no_changes'
        : 'pr_failed'

  const firstFailure = results.find((result) => result.failureCode)
  // A person stopped every run: that is a stop, not an implementation failure.
  const stoppedByPerson = isStoppedByPerson({
    loopId, implementationOutcome, prUrl: launchContinuation?.prUrl ?? null,
    runOutcomes: results.map((result) => getLoopRun(ctx.db, result.run.runId)?.final_outcome),
  })
  const statusCode: PrDeliveryStatusCode = implementationOutcome === 'failed'
    ? (stoppedByPerson ? 'run_stopped' : 'implementation_failed')
    : continuationLifecycleBlocked
      ? 'branch_verification_failed'
      : continuationMergedWithSha
        ? 'pr_ready'
        : continuationClosedWithSha
          ? 'pr_closed'
          : continuationNeedsNewPr
      ? 'ready_for_review'
      : continuationPushFailed
      ? 'push_failed'
      : deliveryOutcome === 'no_changes'
        ? 'no_changes'
        : implementationOutcome === 'partially_succeeded'
          ? 'partial_success'
          : firstFailure?.failureCode
            ?? (launchContinuation && ready.length > 0 ? 'existing_pr_updated' : 'ready_for_review')
  // A person's Stop is the reason, whatever the partial commit then reported
  // (an unarchived OpenSpec change, a dirty path): the unit records keep that
  // settlement detail in their own `failureDetail`.
  const statusDetail = stoppedByPerson
    ? RUN_STOPPED_DETAIL
    : continuationPushFailureReason ?? firstFailure?.failureDetail ?? null
  return { deliveryOutcome, next, stoppedByPerson, statusCode, statusDetail }
}
