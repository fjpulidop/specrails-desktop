import { type ExecResult } from '../../runtime/pr-publisher'
import { type RailPrDeliveryRow } from '../../runtime/rail-pr-store'
import {
  matchesRecordedPrIdentity,
  observePrLifecycle as observeGithubPrLifecycle
} from '../../runtime/pr-lifecycle'
import { PrDecisionDeps, PrDecisionResult } from './contracts'
import { persistMovedPrHead, rerouteFromStalePr, settleMergedPr, mergedEvidenceDetail, settleObservedClosedPr, persistRetryablePrObservationFailure, settleObservedExistingPr } from './observations'
import { ghFailed, casTransition, finalizeTransition } from './transitions'


export async function runPublish(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (!row.delivery_sha || !row.branch) {
    return persistMovedPrHead(
      deps,
      row,
      'the draft PR has no immutable delivery SHA/head identity; refusing to mutate unverifiable review state',
    )
  }

  const beforePublish = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url!, row.delivery_sha,
  )
  if (!beforePublish.ok) {
    return { status: 502, body: { error: 'gh_failed', detail: beforePublish.detail } }
  }
  if (!matchesRecordedPrIdentity(beforePublish, row.branch, row.base_branch)) {
    return rerouteFromStalePr(
      deps,
      row,
      `the recorded PR is ${beforePublish.state.toLowerCase()} but no longer matches its original head/base identity`,
      beforePublish.includesExpectedSha === true,
    )
  }
  if (beforePublish.state === 'MERGED') {
    return beforePublish.includesExpectedSha === true
      ? settleMergedPr(deps, row)
      : rerouteFromStalePr(deps, row, mergedEvidenceDetail(beforePublish), false)
  }
  if (beforePublish.state === 'CLOSED') {
    return beforePublish.includesExpectedSha === true
      ? settleObservedClosedPr(deps, row, beforePublish)
      : rerouteFromStalePr(deps, row, 'the draft PR closed without the verified implementation commit', false)
  }
  if (beforePublish.includesExpectedSha !== true) {
    return persistRetryablePrObservationFailure(
      deps,
      row,
      'the draft PR no longer exposes the verified implementation commit; Retry push is available and will use the preserved exact SHA',
    )
  }
  if (beforePublish.isDraft === false) {
    return settleObservedExistingPr(deps, row, beforePublish, false)
  }

  let r: ExecResult
  try {
    r = await deps.exec.run('gh', ['pr', 'ready', row.pr_url!], deps.project.path)
  } catch (err) {
    r = { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
  // `gh pr ready` is externally mutating and may return an ambiguous error.
  // Re-observe exact remote truth in every case before changing the ledger.
  const afterPublish = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url!, row.delivery_sha,
  )
  if (!afterPublish.ok) {
    if (r.code !== 0) return ghFailed(r)
    return { status: 502, body: { error: 'gh_failed', detail: `PR readiness could not be verified: ${afterPublish.detail}` } }
  }
  if (!matchesRecordedPrIdentity(afterPublish, row.branch, row.base_branch)) {
    return rerouteFromStalePr(
      deps,
      row,
      `the PR identity changed while publishing it for review (${afterPublish.state.toLowerCase()})`,
      afterPublish.includesExpectedSha === true,
    )
  }
  if (afterPublish.state === 'MERGED') {
    return afterPublish.includesExpectedSha === true
      ? settleMergedPr(deps, row)
      : rerouteFromStalePr(deps, row, mergedEvidenceDetail(afterPublish), false)
  }
  if (afterPublish.state === 'CLOSED') {
    return afterPublish.includesExpectedSha === true
      ? settleObservedClosedPr(deps, row, afterPublish)
      : rerouteFromStalePr(deps, row, 'the PR closed without the verified implementation commit while being published', false)
  }
  if (afterPublish.includesExpectedSha !== true) {
    return persistRetryablePrObservationFailure(
      deps,
      row,
      'the PR no longer exposes the verified implementation commit after publishing; Retry push is available',
    )
  }
  if (afterPublish.isDraft) {
    if (r.code !== 0) return ghFailed(r)
    return { status: 502, body: { error: 'gh_failed', detail: 'PR remained a draft after publishing' } }
  }
  return settleObservedExistingPr(deps, row, afterPublish, false)
}


export async function runPollMerge(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  const observed = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url!, row.delivery_sha,
  )
  if (!observed.ok) return { status: 502, body: { error: 'gh_failed', detail: observed.detail } }
  const { state, isDraft } = observed

  if (!row.branch) {
    return persistMovedPrHead(
      deps, row, `the ${state.toLowerCase()} PR has no recorded delivery branch; refusing to infer recoverable work`,
    )
  }
  if (!row.delivery_sha) {
    // A legacy OPEN row cannot be retried without an immutable object. Once the
    // attached PR is terminal, however, keeping that stale URL would strand the
    // only recorded branch behind Discard. Detach it so Create PR can perform
    // the existing one-time legacy ref capture, without claiming any delivery.
    if (state === 'CLOSED' || state === 'MERGED') {
      return rerouteFromStalePr(
        deps,
        row,
        `the previous PR is ${state.toLowerCase()} and this legacy delivery has no persisted verified SHA`,
        false,
      )
    }
    return persistMovedPrHead(
      deps, row, 'the open PR has no persisted verified delivery SHA; refusing to infer delivery from a mutable branch',
    )
  }
  if (!matchesRecordedPrIdentity(observed, row.branch, row.base_branch)) {
    return rerouteFromStalePr(
      deps,
      row,
      `the recorded PR is ${state.toLowerCase()} but no longer matches its original head/base identity`,
      observed.includesExpectedSha === true,
    )
  }

  if (state === 'CLOSED') {
    if (observed.includesExpectedSha !== true) {
      return rerouteFromStalePr(
        deps,
        row,
        'the previous PR closed without the verified implementation commit',
        false,
      )
    }
    return settleObservedClosedPr(deps, row, observed)
  }

  if (state === 'OPEN') {
    if (observed.includesExpectedSha !== true) {
      const detail = 'the open PR no longer exposes the verified implementation commit; Retry push is available and will use the preserved exact SHA'
      const result = persistRetryablePrObservationFailure(deps, row, detail)
      return {
        ...result,
        body: {
          ...result.body,
          deliveryVerified: false,
          verifiedSha: row.delivery_sha,
          remoteHeadSha: observed.headRefOid,
        },
      }
    }
    // A successful reopen can be observed even if the explicit action lost its
    // follow-up `gh view` response. Polling heals pr_closed from remote truth.
    if (row.decision === 'pr_closed') {
      const next = isDraft ? 'pr_draft' as const : 'pr_ready' as const
      const conflict = casTransition(deps, row, next, {
        deliveryOutcome: 'delivered', statusCode: isDraft ? 'pr_draft_ready' : 'pr_ready',
      })
      if (conflict) return conflict
      finalizeTransition(deps, row.id)
      return {
        status: 200,
        body: {
          ok: true,
          decision: next,
          merged: false,
          reopened: true,
          prUrl: row.pr_url,
          deliveryVerified: true,
          verifiedSha: row.delivery_sha,
          remoteHeadSha: observed.headRefOid,
          pushed: false,
        },
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        decision: row.decision,
        merged: false,
        deliveryVerified: true,
        verifiedSha: row.delivery_sha,
        remoteHeadSha: observed.headRefOid,
        pushed: false,
      },
    }
  }

  if (state !== 'MERGED') {
    return { status: 502, body: { error: 'gh_failed', detail: `unexpected PR state: ${state}` } }
  }

  // A PR can merge just before a continuation push; GitHub may then accept a
  // later update to the head branch even though that object was never part of
  // the merge. Never move tickets to Done from state=MERGED alone.
  if (observed.includesExpectedSha !== true) {
    return rerouteFromStalePr(deps, row, mergedEvidenceDetail(observed), false)
  }

  return settleMergedPr(deps, row)
}


export async function runReopen(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (!row.delivery_sha || !row.branch) {
    return rerouteFromStalePr(
      deps,
      row,
      'the closed PR cannot be reopened safely because its immutable delivery SHA/head identity is unavailable',
      false,
    )
  }
  const beforeReopen = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url!, row.delivery_sha,
  )
  if (!beforeReopen.ok) {
    return { status: 502, body: { error: 'gh_failed', detail: beforeReopen.detail } }
  }
  if (
    !matchesRecordedPrIdentity(beforeReopen, row.branch, row.base_branch) ||
    beforeReopen.includesExpectedSha !== true
  ) {
    return rerouteFromStalePr(
      deps,
      row,
      'the closed PR no longer proves the recorded head/base and verified implementation commit',
      false,
    )
  }
  if (beforeReopen.state === 'MERGED') return settleMergedPr(deps, row)
  if (beforeReopen.state === 'OPEN') {
    const next = beforeReopen.isDraft ? 'pr_draft' as const : 'pr_ready' as const
    const conflict = casTransition(deps, row, next, {
      deliveryOutcome: 'delivered', statusCode: beforeReopen.isDraft ? 'pr_draft_ready' : 'pr_ready',
      statusDetail: null,
    })
    if (conflict) return conflict
    finalizeTransition(deps, row.id)
    return {
      status: 200,
      body: {
        ok: true, decision: next, reopened: true, prUrl: row.pr_url,
        deliveryVerified: true, verifiedSha: row.delivery_sha,
        remoteHeadSha: beforeReopen.headRefOid, pushed: false,
      },
    }
  }

  let reopened: ExecResult
  try {
    reopened = await deps.exec.run('gh', ['pr', 'reopen', row.pr_url!], deps.project.path)
  } catch (err) {
    reopened = { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
  const observed = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url!, row.delivery_sha,
  )
  if (!observed.ok) {
    if (reopened.code !== 0) return ghFailed(reopened)
    return { status: 502, body: { error: 'gh_failed', detail: observed.detail } }
  }
  const identityMatches = matchesRecordedPrIdentity(observed, row.branch, row.base_branch)
  if (observed.state === 'MERGED') {
    if (identityMatches && observed.includesExpectedSha === true) return settleMergedPr(deps, row)
    return rerouteFromStalePr(
      deps,
      row,
      identityMatches ? mergedEvidenceDetail(observed) : 'the PR identity changed while it was being reopened',
      false,
    )
  }
  if (observed.state === 'CLOSED') {
    if (!identityMatches || observed.includesExpectedSha !== true) {
      return rerouteFromStalePr(
        deps,
        row,
        'the PR remained closed without proving the recorded head/base and verified implementation commit',
        false,
      )
    }
    if (reopened.code !== 0) return ghFailed(reopened)
    return { status: 502, body: { error: 'gh_failed', detail: 'PR remained closed after reopen' } }
  }
  if (!identityMatches || observed.includesExpectedSha !== true) {
    return rerouteFromStalePr(
      deps,
      row,
      'the reopened PR no longer proves the recorded head/base and verified implementation commit',
      true,
    )
  }

  const next = observed.isDraft ? 'pr_draft' as const : 'pr_ready' as const
  const conflict = casTransition(deps, row, next, {
    deliveryOutcome: 'delivered', statusCode: observed.isDraft ? 'pr_draft_ready' : 'pr_ready',
    statusDetail: null,
  })
  if (conflict) return conflict
  finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true, decision: next, reopened: true, prUrl: row.pr_url,
      deliveryVerified: true, verifiedSha: row.delivery_sha,
      remoteHeadSha: observed.headRefOid, pushed: false,
    },
  }
}
