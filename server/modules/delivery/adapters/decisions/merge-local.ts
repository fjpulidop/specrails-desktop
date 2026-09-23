import * as path from 'path'
import { durableBranchHeads, durableOverlayCleanupEvidence, durableSettlementIgnoredPaths, releaseRailWorktrees } from '../../runtime/rail-worktree-release'
import { getPrDelivery, toPrDeliverySnapshot, type RailPrDeliveryRow } from '../../runtime/rail-pr-store'
import { newId } from '../../../../ids'
import { withRepoLock } from '../../../../repo-lock'
import { isValidBranchName } from '../../../../integration-branch'
import { PrDecisionDeps, PrDecisionResult } from './contracts'
import { mergeLocalTargetBranch, batchWorktreeRoot } from './metadata'
import { safetyArchiveRecorder, casTransition, finalizeTransition, casTransitionWithTicketEffect, applyTerminalTicketEffect } from './transitions'
import { COMMIT_SHA_RE, commitObjectExists } from './evidence'
import { releasableWorktreeIds, deleteOwnedBranchesIfUnchanged } from './ownership'
import { sweepMergedChainAncestors } from './chains'


export async function runMergeLocal(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  return withRepoLock(deps.project.path, () => runMergeLocalLocked(deps, row))
}


export async function runMergeLocalLocked(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  // A stacked milestone delivery targets the chain integration branch, not
  // the previous feature branch recorded as its PR base. Freeze that target
  // for the whole locked operation and every pre/post-advance check.
  const integrationTarget = mergeLocalTargetBranch(deps, row)
  deps.assertAdmission?.()
  if (!isValidBranchName(integrationTarget) || integrationTarget === 'HEAD' || integrationTarget.startsWith('refs/')) {
    return {
      status: 409,
      body: { error: 'merge_local_blocked', reason: 'unresolved_head', base: integrationTarget,
        detail: 'Configure a local integration branch before accepting this delivery.' },
    }
  }
  const head = await deps.git.run(['symbolic-ref', '--quiet', 'HEAD'], deps.project.path)
  if (head.code !== 0 && head.code !== 1) {
    return { status: 409, body: { error: 'merge_local_blocked', reason: 'unresolved_head', base: integrationTarget } }
  }
  if (head.stdout.trim() === `refs/heads/${integrationTarget}`) return runMergeLocalIntoCheckout(deps, row, deps.project.path, integrationTarget)

  // Claim the designated base in an ordinary linked checkout. Git refuses if
  // another worktree already holds it; never update-ref a checked-out branch
  // behind its owner's back or switch/stash the user's current work.
  const safeId = row.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'delivery'
  const target = path.join(deps.assemblyRoot ?? batchWorktreeRoot(deps.project.slug), `local-base-${safeId}-${newId()}`)
  const added = await deps.git.run(['worktree', 'add', target, integrationTarget], deps.project.path)
  if (added.code !== 0) {
    return {
      status: 409,
      body: {
        error: 'merge_local_blocked', reason: 'integration_branch_busy', base: integrationTarget,
        detail: added.stderr.trim() || added.stdout.trim() || 'The integration branch could not be opened safely.',
      },
    }
  }
  let result: PrDecisionResult | undefined
  try {
    result = await runMergeLocalIntoCheckout(deps, row, target, integrationTarget)
    return result
  } finally {
    // Even failed assembly must release the temporary base checkout. Non-force
    // removal preserves files if an external process wrote there during merge.
    let warning: string | null = null
    try {
      const removed = await deps.git.run(['worktree', 'remove', target], deps.project.path)
      if (removed.code !== 0) warning = `integration worktree ${target}: ${removed.stderr.trim() || removed.stdout.trim() || `exit ${removed.code}`}`
    } catch (err) {
      warning = `integration worktree ${target}: ${err instanceof Error ? err.message : String(err)}`
    }
    if (warning) {
      safetyArchiveRecorder(deps, row)(target)
      const current = getPrDelivery(deps.db, row.id)
      if (current?.operation_token === row.operation_token) {
        const warnings = [...toPrDeliverySnapshot(current).cleanupWarnings, warning]
        casTransition(deps, current, current.decision, { cleanupWarnings: warnings, statusCode: 'cleanup_incomplete' })
        finalizeTransition(deps, row.id)
        if (result) result.body.cleanupWarnings = warnings
      }
    }
  }
}


export async function runMergeLocalIntoCheckout(deps: PrDecisionDeps, row: RailPrDeliveryRow, targetRepo: string, integrationTarget: string): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings: string[] = []

  // Snapshot branch/HEAD before assembly. Local edits are allowed: the final
  // non-forced fast-forward leaves unrelated work intact and Git atomically
  // refuses any overwrite, including ignored files.
  const head = await deps.git.run(['symbolic-ref', '--quiet', 'HEAD'], targetRepo)
  const currentBranch = head.code === 0 ? head.stdout.trim().replace(/^refs\/heads\//, '') : ''
  if (currentBranch !== integrationTarget) {
    return {
      status: 409,
      body: { error: 'merge_local_blocked', reason: 'wrong_branch', current: currentBranch || null, base: integrationTarget },
    }
  }
  const status = await deps.git.run(['status', '--porcelain'], targetRepo)
  if (status.code !== 0) {
    return { status: 409, body: { error: 'merge_local_blocked', reason: 'status_unavailable', base: integrationTarget } }
  }
  const startingHead = await deps.git.run(['rev-parse', '--verify', 'HEAD'], targetRepo)
  const startingSha = startingHead.code === 0 ? startingHead.stdout.trim() : ''
  if (!/^[0-9a-f]{40,64}$/i.test(startingSha)) {
    return { status: 409, body: { error: 'merge_local_blocked', reason: 'unresolved_head', base: integrationTarget } }
  }

  // What to merge: immutable object ids only. The assembled head carries every
  // unit already; without one, merge each settled unit's exact final SHA.
  let toMerge: string[]
  let deliveryHeadSha: string | null = null
  if (row.delivery_sha) {
    if (!COMMIT_SHA_RE.test(row.delivery_sha) || !(await commitObjectExists(deps, row.delivery_sha))) {
      return { status: 502, body: { error: 'merge_failed', detail: 'The verified delivery commit is unavailable; no branch fallback was merged.' } }
    }
    deliveryHeadSha = row.delivery_sha
  }
  if (deliveryHeadSha) {
    toMerge = [deliveryHeadSha]
  } else {
    toMerge = []
    for (const unit of snap.branches.filter((b) => b.succeeded)) {
      let sourceSha = unit.finalSha && COMMIT_SHA_RE.test(unit.finalSha) ? unit.finalSha : null
      if (sourceSha) {
        if (!(await commitObjectExists(deps, sourceSha))) sourceSha = null
      }
      if (!sourceSha) {
        return {
          status: 502,
          body: { error: 'merge_failed', detail: `verified commit for '${unit.branch}' (ticket #${unit.ticketId}) is unavailable` },
        }
      }
      toMerge.push(sourceSha)
    }
  }
  if (toMerge.length === 0) {
    return { status: 502, body: { error: 'merge_failed', detail: 'no succeeded branch to merge' } }
  }

  // Assemble every merge away from the user's checkout. A conflict can only
  // dirty this disposable detached worktree, never the integration branch.
  const safeId = row.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'delivery'
  const assemblyPath = path.join(deps.assemblyRoot ?? batchWorktreeRoot(deps.project.slug), `local-merge-${safeId}-${newId()}`)
  const added = await deps.git.run(['worktree', 'add', '--detach', assemblyPath, startingSha], deps.project.path)
  if (added.code !== 0) {
    const detail = (added.stderr.trim() || added.stdout.trim()).split('\n')[0] || `exit ${added.code}`
    return { status: 502, body: { error: 'merge_failed', detail: `creating isolated assembly: ${detail}` } }
  }

  let assemblyRemovalAttempted = false
  const removeAssembly = async (): Promise<void> => {
    if (assemblyRemovalAttempted) return
    assemblyRemovalAttempted = true
    try {
      const removed = await deps.git.run(['worktree', 'remove', assemblyPath], deps.project.path)
      if (removed.code !== 0) {
        cleanupWarnings.push(`assembly worktree ${assemblyPath}: ${(removed.stderr.trim() || removed.stdout.trim()).split('\n')[0] || `exit ${removed.code}`}`)
        safetyArchiveRecorder(deps, row)(assemblyPath)
      }
    } catch (err) {
      cleanupWarnings.push(`assembly worktree ${assemblyPath}: ${err instanceof Error ? err.message : String(err)}`)
      safetyArchiveRecorder(deps, row)(assemblyPath)
    }
  }
  const persistAssemblyFailure = (detail: string): PrDecisionResult | null => {
    const conflict = casTransition(deps, row, row.decision, {
      deliveryOutcome: 'blocked', statusCode: 'delivery_failed', statusDetail: detail, cleanupWarnings,
    })
    if (conflict) return conflict
    finalizeTransition(deps, row.id)
    return null
  }

  try {
    for (const branch of toMerge) {
      const r = await deps.git.run(['merge', '--no-ff', '--no-edit', branch], assemblyPath)
      if (r.code !== 0) {
        try {
          const aborted = await deps.git.run(['merge', '--abort'], assemblyPath)
          if (aborted.code !== 0) cleanupWarnings.push(`assembly abort ${branch}: exit ${aborted.code}`)
        } catch (err) {
          cleanupWarnings.push(`assembly abort ${branch}: ${err instanceof Error ? err.message : String(err)}`)
        }
        await removeAssembly()
        const detail = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`
        const conflict = persistAssemblyFailure(`merging '${branch}': ${detail}`)
        if (conflict) return conflict
        return { status: 502, body: { error: 'merge_failed', detail: `merging '${branch}': ${detail}` } }
      }
    }

    const assembled = await deps.git.run(['rev-parse', '--verify', 'HEAD'], assemblyPath)
    const assembledSha = assembled.code === 0 ? assembled.stdout.trim() : ''
    if (!/^[0-9a-f]{40,64}$/i.test(assembledSha)) {
      await removeAssembly()
      const detail = 'isolated assembly produced no verifiable HEAD'
      const conflict = persistAssemblyFailure(detail)
      if (conflict) return conflict
      return { status: 502, body: { error: 'merge_failed', detail } }
    }

    const [finalBranch, finalStatus, finalHead] = await Promise.all([
      deps.git.run(['symbolic-ref', '--quiet', 'HEAD'], targetRepo),
      deps.git.run(['status', '--porcelain'], targetRepo),
      deps.git.run(['rev-parse', '--verify', 'HEAD'], targetRepo),
    ])
    const changedReason = finalBranch.code !== 0 || finalBranch.stdout.trim() !== `refs/heads/${integrationTarget}`
      ? 'wrong_branch'
      : finalStatus.code !== 0
        ? 'status_unavailable'
        : finalHead.code !== 0 || finalHead.stdout.trim() !== startingSha
          ? 'head_changed'
          : null
    if (changedReason) {
      await removeAssembly()
      if (cleanupWarnings.length > 0) {
        const conflict = casTransition(deps, row, row.decision, { cleanupWarnings })
        if (conflict) return conflict
        finalizeTransition(deps, row.id)
      }
      return { status: 409, body: { error: 'merge_local_blocked', reason: changedReason, base: integrationTarget } }
    }

    const advanced = await deps.git.run(['merge', '--ff-only', '--no-overwrite-ignore', assembledSha], targetRepo)
    if (advanced.code !== 0) {
      await removeAssembly()
      if (/would be overwritten|local changes|untracked working tree/i.test(`${advanced.stderr}\n${advanced.stdout}`)) {
        return {
          status: 409,
          body: {
            error: 'merge_local_blocked', reason: 'dirty', base: integrationTarget,
            detail: (advanced.stderr.trim() || advanced.stdout.trim()).slice(0, 1200),
          },
        }
      }
      const detail = (advanced.stderr.trim() || advanced.stdout.trim()).split('\n')[0] || `exit ${advanced.code}`
      const conflict = persistAssemblyFailure(`advancing '${integrationTarget}': ${detail}`)
      if (conflict) return conflict
      return { status: 502, body: { error: 'merge_failed', detail: `advancing '${integrationTarget}': ${detail}` } }
    }
    const [acceptedBranch, acceptedHead, acceptedBase] = await Promise.all([
      deps.git.run(['symbolic-ref', '--quiet', 'HEAD'], targetRepo),
      deps.git.run(['rev-parse', '--verify', 'HEAD'], targetRepo),
      deps.git.run(['rev-parse', '--verify', `refs/heads/${integrationTarget}`], deps.project.path),
    ])
    if (acceptedBranch.code !== 0 || acceptedBranch.stdout.trim() !== `refs/heads/${integrationTarget}` ||
      acceptedHead.code !== 0 || acceptedHead.stdout.trim().toLowerCase() !== assembledSha.toLowerCase() ||
      acceptedBase.code !== 0 || acceptedBase.stdout.trim().toLowerCase() !== assembledSha.toLowerCase()) {
      // An external checkout/ref edit can race the final preflight. A successful
      // Git exit is insufficient evidence that the authorized base was updated.
      // Preserve the assembled object and all source worktrees/branches for a
      // retry; never roll back the external edit or mark tickets done.
      assemblyRemovalAttempted = true
      safetyArchiveRecorder(deps, row)(assemblyPath)
      const detail = `The integration checkout changed during the final advance. The assembled result is preserved at ${assemblyPath}.`
      cleanupWarnings.push(detail)
      const conflict = casTransition(deps, row, row.decision, { cleanupWarnings, statusCode: 'delivery_failed', statusDetail: detail })
      if (conflict) return conflict
      finalizeTransition(deps, row.id)
      return { status: 409, body: { error: 'merge_local_blocked', reason: 'head_changed', base: integrationTarget, detail } }
    }
    await removeAssembly()

    // Post-advance sweep: the work now lives on
    // the integration branch, so the launch's worktrees + branches are spent.
    cleanupWarnings.push(...await releaseRailWorktrees({
      db: deps.db,
      git: deps.git,
      repoDir: deps.project.path,
      worktreeIds: releasableWorktreeIds(deps, snap),
      state: 'merged',
      expectedHeadByBranch: durableBranchHeads(snap.branches),
      overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
      settlementIgnoredByBranch: durableSettlementIgnoredPaths(snap.branches),
      onSafetyArchive: safetyArchiveRecorder(deps, row),
    }))
    await deleteOwnedBranchesIfUnchanged(deps, row, snap, cleanupWarnings)

    const conflict = casTransitionWithTicketEffect(deps, row, 'merged', {
      deliveryOutcome: 'delivered',
      statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'merged',
      cleanupWarnings,
    }, {
      deliveryId: row.id,
      ticketIds: snap.ticketIds,
      targetStatus: 'done',
      jiraAction: 'merged',
      prUrl: null,
    })
    if (conflict) return conflict
    applyTerminalTicketEffect(deps, row, 'merged', cleanupWarnings)
    finalizeTransition(deps, row.id)
    await sweepMergedChainAncestors(deps, row)
    return { status: 200, body: { ok: true, decision: 'merged', merged: true, local: true } }
  } finally {
    // Runner exceptions (spawn failures/timeouts) must release the temporary
    // assembly as well. A failed non-force removal leaves a recorded archive.
    await removeAssembly()
  }
}
