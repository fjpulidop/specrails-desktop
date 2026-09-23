import { pushBranch } from '../../runtime/pr-publisher'
import { type RailPrDeliveryRow } from '../../runtime/rail-pr-store'
import {
  isExactOpenPr,
  matchesRecordedPrIdentity,
  observePrLifecycle as observeGithubPrLifecycle,
  verifyPushRemoteForPr
} from '../../runtime/pr-lifecycle'
import { PrDecisionDeps, PrDecisionResult } from './contracts'
import { casTransition, finalizeTransition } from './transitions'
import { persistRetryablePrObservationFailure, settleMergedPr, rerouteFromStalePr, mergedEvidenceDetail, settleObservedClosedPr, settleObservedExistingPr, persistRecoveryBlocked, persistMovedPrHead } from './observations'
import { commitObjectExists, isFastForwardCandidate } from './evidence'


export async function retryExistingPrFollowupPush(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (!row.branch || !row.pr_url) return { status: 502, body: { error: 'push_failed', detail: 'missing PR branch/url' } }
  if (!row.delivery_sha) {
    const detail = 'missing verified delivery SHA; refusing to resolve a mutable branch for retry'
    const conflict = casTransition(deps, row, 'pr_failed', {
      deliveryOutcome: 'blocked',
      statusCode: 'branch_verification_failed',
      statusDetail: detail,
    })
    if (conflict) return conflict
    finalizeTransition(deps, row.id)
    return { status: 409, body: { error: 'missing_verified_sha', decision: 'pr_failed', prUrl: row.pr_url, detail } }
  }

  const beforePush = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url, row.delivery_sha,
  )
  if (!beforePush.ok) {
    return persistRetryablePrObservationFailure(
      deps, row, `could not confirm the existing PR is open before retry: ${beforePush.detail}`,
    )
  }
  if (!isExactOpenPr(beforePush, row.branch, row.base_branch)) {
    const identityMatches = matchesRecordedPrIdentity(beforePush, row.branch, row.base_branch)
    if (beforePush.state === 'MERGED' && identityMatches && beforePush.includesExpectedSha === true) {
      return settleMergedPr(deps, row)
    }
    if (beforePush.state === 'MERGED') {
      return rerouteFromStalePr(
        deps,
        row,
        identityMatches ? mergedEvidenceDetail(beforePush) : 'the previous PR merged after its recorded head/base identity changed',
        false,
      )
    }
    if (beforePush.state === 'CLOSED') {
      if (identityMatches && beforePush.includesExpectedSha === true) {
        return settleObservedClosedPr(deps, row, beforePush)
      }
      return rerouteFromStalePr(deps, row, 'the previous PR closed before this implementation was delivered', false)
    }
    return rerouteFromStalePr(
      deps,
      row,
      'the existing open PR no longer matches its recorded head/base identity',
      false,
    )
  }

  if (beforePush.includesExpectedSha === true) {
    return settleObservedExistingPr(deps, row, beforePush, false)
  }

  if (!beforePush.headRefOid) {
    return persistRetryablePrObservationFailure(
      deps, row, 'the open PR did not expose a verifiable head commit; Retry push will revalidate before mutation',
    )
  }
  if (!(await commitObjectExists(deps, beforePush.headRefOid))) {
    try {
      await deps.git.run(['fetch', 'origin', `refs/heads/${row.branch}`], deps.project.path)
    } catch { /* the immutable object check below remains authoritative */ }
  }
  if (!(await commitObjectExists(deps, beforePush.headRefOid))) {
    return persistRetryablePrObservationFailure(
      deps, row, 'the live PR head object is unavailable locally; Retry push will revalidate before mutation',
    )
  }
  if (!(await isFastForwardCandidate(deps, beforePush.headRefOid, row.delivery_sha))) {
    const detail = 'the exact delivery commit is not a fast-forward of the live PR head; it was not pushed'
    return row.is_continuation === 1
      ? persistRecoveryBlocked(deps, row, `${detail} and remains protected`, row.delivery_sha)
      : persistMovedPrHead(deps, row, detail)
  }

  const remote = await verifyPushRemoteForPr(deps.exec, deps.project.path, row.pr_url)
  if (!remote.ok) {
    return persistRetryablePrObservationFailure(
      deps, row, `refusing to push until the PR repository and origin are proven identical: ${remote.detail}`,
    )
  }

  const pushed = await pushBranch(deps.exec, {
    repoDir: deps.project.path,
    branch: row.branch,
    baseBranch: row.base_branch,
    remote: remote.pushTarget,
    sourceSha: row.delivery_sha,
  })
  if (pushed.state === 'local-only') {
    const conflict = casTransition(deps, row, 'pr_failed', {
      prState: 'local-only',
      deliveryOutcome: 'retryable_failure',
      statusCode: 'push_failed',
      statusDetail: pushed.reason,
    })
    if (conflict) return conflict
    finalizeTransition(deps, row.id)
    return { status: 200, body: { ok: true, decision: 'pr_failed', prUrl: row.pr_url, detail: pushed.reason } }
  }

  const afterPush = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url, row.delivery_sha,
  )
  if (!afterPush.ok) {
    return persistRetryablePrObservationFailure(
      deps, row, `exact commit was pushed, but the PR lifecycle could not be confirmed: ${afterPush.detail}`,
    )
  }
  if (isExactOpenPr(afterPush, row.branch, row.base_branch)) {
    if (afterPush.includesExpectedSha !== true) {
      return persistRetryablePrObservationFailure(
        deps, row, 'the exact push completed, but the PR does not yet expose the verified commit as its head; Retry push remains safe and uses the preserved SHA',
      )
    }
    return settleObservedExistingPr(deps, row, afterPush, true)
  }
  const identityMatches = matchesRecordedPrIdentity(afterPush, row.branch, row.base_branch)
  if (afterPush.state === 'MERGED' && identityMatches && afterPush.includesExpectedSha === true) {
    return settleMergedPr(deps, row)
  }
  if (afterPush.state === 'MERGED') {
    return rerouteFromStalePr(
      deps,
      row,
      identityMatches ? mergedEvidenceDetail(afterPush) : 'the previous PR merged after its recorded head/base identity changed',
      true,
    )
  }
  if (afterPush.state === 'CLOSED') {
    if (identityMatches && afterPush.includesExpectedSha === true) {
      return settleObservedClosedPr(deps, row, afterPush)
    }
    return rerouteFromStalePr(deps, row, 'the previous PR closed before this implementation was delivered', true)
  }
  return rerouteFromStalePr(
    deps,
    row,
    'the existing open PR no longer matches its recorded head/base identity after the exact push',
    true,
  )
}
