import { publishDraftPr } from '../../runtime/pr-publisher'
import { deliverRailAsPr } from '../../runtime/rail-pr-delivery'
import { durableBranchHeads, durableOverlayCleanupEvidence, durableSettlementIgnoredPaths, releaseRailWorktrees } from '../../runtime/rail-worktree-release'
import { batchBranchNameFor, buildPrTitle } from '../../runtime/pr-naming'
import { buildCanonicalPrBody, collectBranchChanges, type BranchChanges } from '../../runtime/pr-body'
import { sumInvocationCostForRuns } from '../../../accounting/runtime/ai-invocations'
import {
  toPrDeliverySnapshot, type PrDecision, type PrDeliveryPatch, type RailPrDeliveryRow
} from '../../runtime/rail-pr-store'
import { PrDecisionDeps, PrDecisionResult } from './contracts'
import { retryExistingPrFollowupPush } from './retry'
import { COMMIT_SHA_RE, commitObjectExists, captureBranchSha, releaseDeliveredRecoveryLineage } from './evidence'
import { casTransition, finalizeTransition, safetyArchiveRecorder } from './transitions'
import { loadPrTicketData, batchWorktreeRoot, parsePrNumber } from './metadata'
import { releasableWorktreeIds } from './ownership'


export async function runCreatePr(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (row.decision === 'pr_failed' && row.pr_url && row.branch) {
    return retryExistingPrFollowupPush(deps, row)
  }

  const snap = toPrDeliverySnapshot(row)

  // Resolve every deliverable unit to an immutable object. New rows carry the
  // verified final SHA from settlement; legacy rows may capture their recorded
  // ref once. Never substitute another historical branch merely because it
  // belongs to the same ticket.
  let effectiveBranches = snap.branches
  let branchEvidenceCaptured = false
  const singleDeliverable = snap.branches.filter((unit) => unit.succeeded).length === 1
  const frozenSingleSha = singleDeliverable && row.delivery_sha && COMMIT_SHA_RE.test(row.delivery_sha) &&
    await commitObjectExists(deps, row.delivery_sha)
    ? row.delivery_sha
    : null
  for (let index = 0; index < snap.branches.length; index++) {
    const unit = snap.branches[index]
    if (!unit.succeeded) continue
    // A detached/stale single-unit delivery already has authoritative immutable
    // evidence. Prefer it over both legacy unit gaps and a branch ref that may
    // have advanced while the card waited for the user's decision.
    let sourceSha = frozenSingleSha ?? (unit.finalSha && COMMIT_SHA_RE.test(unit.finalSha) ? unit.finalSha : null)
    if (sourceSha) {
      if (!(await commitObjectExists(deps, sourceSha))) sourceSha = null
    } else {
      sourceSha = await captureBranchSha(deps, unit.branch)
      if (sourceSha && !(await commitObjectExists(deps, sourceSha))) sourceSha = null
    }
    if (!sourceSha) {
      const detail = `the verified commit for branch '${unit.branch}' (ticket #${unit.ticketId}) is unavailable; refusing to deliver a mutable or unrelated ref`
      const conflict = casTransition(deps, row, 'pr_failed', {
        deliveryOutcome: 'blocked', statusCode: 'branch_verification_failed', statusDetail: detail,
      })
      if (conflict) return conflict
      finalizeTransition(deps, row.id)
      return { status: 200, body: { ok: true, decision: 'pr_failed', detail } }
    }
    if (unit.finalSha !== sourceSha) branchEvidenceCaptured = true
    effectiveBranches = effectiveBranches.map((branch, branchIndex) => branchIndex === index
      ? { ...branch, finalSha: sourceSha }
      : branch)
  }

  // Succeeded COVERED tickets for the PR title/body: a single unit covers every
  // launch ticket (scope='all'), per-ticket units cover exactly their own.
  const succeededUnits = effectiveBranches.filter((b) => b.succeeded)
  const succeededTicketIds =
    effectiveBranches.length === 1 && succeededUnits.length === 1
      ? snap.ticketIds
      : succeededUnits.map((b) => b.ticketId)

  const ticketData = loadPrTicketData(deps, succeededTicketIds)
  // The batch name is derived ONLY for multi-unit deliveries — the single-ticket
  // path delivers straight from its unit branch and must never even compute one.
  const batchPreferred = succeededUnits.length > 1 ? batchBranchNameFor(ticketData) : null

  const unitBranches = new Set(effectiveBranches.map((b) => b.branch))

  // Per-ticket covering branch for the body's honest Tests digest: per-ticket
  // units map 1:1; a single 'all'-scope unit covers every launch ticket.
  const branchFor = (ticketId: number): string | null => {
    const unit = succeededUnits.find((b) => b.ticketId === ticketId)
    if (unit) return unit.branch
    return succeededUnits.length === 1 ? succeededUnits[0].branch : null
  }

  // Diffstats are best-effort: a git failure degrades the body (section
  // omitted / "diff unavailable" note), never blocks the PR.
  let changes: Map<string, BranchChanges> | null = null
  try {
    changes = await collectBranchChanges(deps.git, deps.project.path, row.base_branch, succeededUnits.map((b) => b.branch))
  } catch {
    changes = null
  }

  // Cost footer is best-effort: a lookup failure omits the line, never blocks.
  let costUsd: { totalUsd: number; estimated: boolean } | null = null
  try {
    costUsd = sumInvocationCostForRuns(deps.db, snap.runIds)
  } catch {
    costUsd = null
  }

  const title = buildPrTitle(ticketData, { loopName: row.loop_name })
  const body = buildCanonicalPrBody({
    loopName: row.loop_name,
    baseBranch: row.base_branch,
    tickets: ticketData.map((t) => ({ ...t, branch: branchFor(t.ticketId) })),
    changes,
    costUsd,
  })

  let next: PrDecision
  // Underlying git/gh failure detail for a degraded or failed delivery —
  // relayed on the response and persisted as bounded secondary diagnostics.
  let detail: string | null = null
  const patch: PrDeliveryPatch = {}
  if (branchEvidenceCaptured) patch.branches = effectiveBranches
  try {
    // A degraded multi-unit attempt already owns an assembled batch branch.
    // Retry that exact head so exact head/base PR discovery remains idempotent;
    // never `branch -D` a merely name-matching ref, which could destroy a user's
    // unrelated or subsequently edited local branch.
    let degradedBatchSha: string | null = null
    if (
      batchPreferred && row.branch && row.pr_url === null &&
      (row.pr_state === 'pushed' || row.pr_state === 'local-only') &&
      row.branch !== row.base_branch && !unitBranches.has(row.branch)
    ) {
      if (row.delivery_sha && await commitObjectExists(deps, row.delivery_sha)) {
        degradedBatchSha = row.delivery_sha
      } else {
        degradedBatchSha = await captureBranchSha(deps, row.branch)
      }
    }
    const result = degradedBatchSha
      ? {
          state: 'delivered' as const,
          branch: row.branch!,
          pr: await publishDraftPr(deps.exec, {
            repoDir: deps.project.path,
            branch: row.branch!,
            baseBranch: row.base_branch,
            title,
            body,
            sourceSha: degradedBatchSha,
          }),
          ticketIds: succeededTicketIds,
        }
      : await deliverRailAsPr(deps.git, deps.exec, {
          baseRepo: deps.project.path,
          integrationBranch: row.base_branch,
          railKey: row.rail_key,
          batchBranch: batchPreferred ?? undefined,
          batchWorktreeRoot: batchWorktreeRoot(deps.project.slug),
          branches: effectiveBranches.map((unit) => ({
            ...unit,
            sourceSha: unit.finalSha ?? undefined,
          })),
          title,
          body,
        })
    if (result.state === 'delivered') {
      next = result.pr.state === 'pr-created' && result.pr.isDraft === false ? 'pr_ready' : 'pr_draft'
      patch.branch = result.branch
      patch.prState = result.pr.state
      const resultSha = degradedBatchSha
        ?? (succeededUnits.length === 1 ? succeededUnits[0].finalSha ?? null : await captureBranchSha(deps, result.branch))
      if (resultSha && await commitObjectExists(deps, resultSha)) patch.deliverySha = resultSha
      if (result.pr.state === 'pr-created' && result.pr.prUrl) {
        patch.prUrl = result.pr.prUrl
        patch.prNumber = parsePrNumber(result.pr.prUrl)
        patch.deliveryOutcome = 'delivered'
        patch.statusCode = next === 'pr_ready' ? 'pr_ready' : 'pr_draft_ready'
      } else {
        // Degraded (pushed / local-only): no PR exists — only retry or discard.
        patch.prUrl = null
        patch.prNumber = null
        detail = result.pr.reason ?? null
        patch.deliveryOutcome = 'retryable_failure'
        patch.statusCode = result.pr.state === 'local-only' ? 'push_failed' : 'delivery_failed'
      }
    } else {
      // 'assembly-failed' (or an unexpected 'no-op' — settle guarantees ≥1
      // succeeded unit, but a wedged row must not 500) → retryable failure.
      next = 'pr_failed'
      detail = result.reason
      const retryable = !result.reason.startsWith('merge-conflict:') &&
        !result.reason.startsWith('batch-branch-collision:') &&
        result.reason !== 'missing-batch-branch' && result.state === 'assembly-failed'
      patch.deliveryOutcome = retryable ? 'retryable_failure' : 'blocked'
      patch.statusCode = 'delivery_failed'
    }
  } catch (err) {
    // publishDraftPr can propagate GitGuardrailError — a guardrail violation is
    // a retryable delivery failure, never a crash.
    console.error('[rail-pr-decision] create-pr delivery failed:', err)
    next = 'pr_failed'
    detail = err instanceof Error ? err.message : String(err)
    patch.deliveryOutcome = 'blocked'
    patch.statusCode = 'delivery_failed'
  }

  if (detail) patch.statusDetail = detail
  if ((next === 'pr_draft' || next === 'pr_ready') && patch.prUrl) {
    patch.cleanupWarnings = await releaseRailWorktrees({
      db: deps.db, git: deps.git, repoDir: deps.project.path, worktreeIds: releasableWorktreeIds(deps, snap),
      expectedHeadByBranch: durableBranchHeads(effectiveBranches),
      overlayEvidenceByBranch: durableOverlayCleanupEvidence(effectiveBranches),
      settlementIgnoredByBranch: durableSettlementIgnoredPaths(effectiveBranches),
      onSafetyArchive: safetyArchiveRecorder(deps, row),
    })
    if (patch.cleanupWarnings.length > 0) patch.statusCode = 'cleanup_incomplete'
  }
  const conflict = casTransition(deps, row, next, patch)
  if (conflict) return conflict
  if ((next === 'pr_draft' || next === 'pr_ready') && patch.prUrl) {
    await releaseDeliveredRecoveryLineage(deps, row, patch.deliverySha ?? row.delivery_sha)
  }
  const after = finalizeTransition(deps, row.id)
  // Tickets stay on_review — a draft PR is still awaiting the engineer's merge.
  return {
    status: 200,
    body: {
      ok: true,
      decision: next,
      prUrl: after?.prUrl ?? null,
      prState: after?.prState ?? row.pr_state,
      ...(detail ? { detail } : {}),
    },
  }
}
