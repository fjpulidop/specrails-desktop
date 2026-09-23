import * as fs from 'fs'
import { commitWorktreeAndVerify } from '../../../../worktree-manager'
import {
  getPrDelivery, transitionClaimedDecision,
  toPrDeliverySnapshot, type DeliverBranchRecord, type RailPrDeliveryRow
} from '../../runtime/rail-pr-store'
import { getRailWorktree, updateRailWorktreeState } from '../../runtime/rail-worktrees-store'
import {
  isExactOpenPr, observePrLifecycle as observeGithubPrLifecycle
} from '../../runtime/pr-lifecycle'
import {
  advanceRecoveryCommitProtection, discoverRunMarkedCommit, protectRecoveryCommit
} from '../../runtime/rail-pr-recovery-git'
import { PrDecisionDeps, PrDecisionResult } from './contracts'
import { illegalAction, staleDecision, casTransition, finalizeTransition } from './transitions'
import { persistRecoveryBlocked, persistProtectedRecoveryRetry } from './observations'
import { COMMIT_SHA_RE, commitObjectExists, authenticateRecoveryWorktree, exactRefSha, isFastForwardCandidate, releaseDeliveredRecoveryLineage } from './evidence'
import { retryExistingPrFollowupPush } from './retry'


/**
 * Explicit recovery for a legacy successful continuation whose automatic
 * causal scan could not freeze a commit. Unlike Checkout, this operates only
 * on the delivery-owned isolated worktree/branch and never changes the user's
 * main checkout. The user's confirmation authorizes adopting already-committed
 * progress on that exact branch, but only as a non-force fast-forward of the
 * live PR head.
 */
export async function runRecoverAndRetry(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (!row.pr_url || !row.branch || !row.operation_token) return illegalAction(row.decision)
  const snap = toPrDeliverySnapshot(row)
  const runIds = [...new Set(snap.runIds.filter((runId) => typeof runId === 'string' && runId.length > 0))]
  if (runIds.length !== 1) {
    return persistRecoveryBlocked(
      deps, row,
      `Commit & retry push requires exactly one recorded implementation run; found ${runIds.length}. No local evidence was changed.`,
    )
  }
  const runId = runIds[0]
  const matchingUnitIndexes = snap.branches
    .map((branch, index) => branch.branch === row.branch && branch.runId === runId ? index : -1)
    .filter((index) => index >= 0)
  if (matchingUnitIndexes.length === 0) {
    return persistRecoveryBlocked(
      deps, row,
      'Commit & retry push could not prove an exact recorded unit for this run and PR branch. No local evidence was changed.',
    )
  }
  const matchingUnits = matchingUnitIndexes.map((index) => snap.branches[index])
  const recordedFinalValues = matchingUnits.map((unit) => unit.finalSha)
  const hasAnyRecordedFinal = recordedFinalValues.some((sha) => sha != null)
  const recordedFinalShas = [...new Set(
    recordedFinalValues
      .filter((sha): sha is string => typeof sha === 'string' && COMMIT_SHA_RE.test(sha))
      .map((sha) => sha.toLowerCase()),
  )]
  const recordedFinalEvidenceUnsafe = hasAnyRecordedFinal && (
    recordedFinalValues.some((sha) => typeof sha !== 'string' || !COMMIT_SHA_RE.test(sha)) ||
    recordedFinalShas.length !== 1
  )
  // Durable final evidence is one sufficient ownership proof, not a veto over
  // the independent exact run-marker proof. Incomplete/disagreeing migrated
  // unit fields are ignored here; a unique causal commit may still recover the
  // result without adopting any of those disputed SHAs.
  const recordedFinalSha = recordedFinalEvidenceUnsafe ? null : recordedFinalShas[0] ?? null

  let discovery: Awaited<ReturnType<typeof discoverRunMarkedCommit>> | null = null
  const discoverCandidate = async () => {
    if (!discovery) {
      discovery = await discoverRunMarkedCommit(deps.git, deps.project.path, runId)
    }
    return discovery
  }

  const ownedWorktrees = snap.worktreeIds
    .map((worktreeId) => getRailWorktree(deps.db, worktreeId))
    .filter((worktree): worktree is NonNullable<ReturnType<typeof getRailWorktree>> => Boolean(
      worktree && worktree.branch === row.branch && worktree.run_id === runId,
    ))
  const presentWorktrees = ownedWorktrees.filter((worktree) => {
    try {
      fs.lstatSync(worktree.worktree_path)
      return true
    } catch {
      return false
    }
  })
  const worktree = presentWorktrees[0] ?? null
  let preprotectedCandidateSha: string | null = null
  let preprotectedCandidateSource: 'recorded-final' | 'run-marker' | null = null
  // Discover and pin an exact object before any network dependency, even when
  // a ledger path still exists. A recreated/unsafe/dirty path must not hide an
  // older run-owned orphan or leave it exposed to Git GC.
  {
    if (recordedFinalSha && await commitObjectExists(deps, recordedFinalSha)) {
      preprotectedCandidateSha = recordedFinalSha
      preprotectedCandidateSource = 'recorded-final'
    } else {
      const found = await discoverCandidate()
      if (found.kind === 'ambiguous') {
        return persistRecoveryBlocked(
          deps, row,
          `Git found ${found.count} different run-marked commits. No ambiguous object, branch, or worktree was changed.`,
        )
      }
      if (found.kind === 'scan_failed') {
        return persistRecoveryBlocked(
          deps, row,
          `${found.detail}. No branch, worktree, or object was changed.`,
        )
      }
      if (found.kind === 'unique') {
        preprotectedCandidateSha = found.sha
        preprotectedCandidateSource = 'run-marker'
      }
    }
    if (preprotectedCandidateSha) {
      const protection = await protectRecoveryCommit(
        deps.git,
        deps.project.path,
        row.id,
        preprotectedCandidateSha,
      )
      if (!protection.ok) {
        return persistRecoveryBlocked(
          deps,
          row,
          `${protection.detail}. The candidate object and every user-visible branch were left unchanged.`,
        )
      }
    }
  }

  if (presentWorktrees.length > 1) {
    return persistRecoveryBlocked(
      deps, row,
      'Multiple live worktrees claim this run and branch, so Specrails refused to choose one. Every local result remains intact.',
      preprotectedCandidateSha,
    )
  }

  const observed = await observeGithubPrLifecycle(
    deps.exec,
    deps.project.path,
    row.pr_url,
    preprotectedCandidateSha,
  )
  if (!observed.ok) {
    if (preprotectedCandidateSha) {
      if (worktree) {
        return persistRecoveryBlocked(
          deps,
          row,
          `Protected an exact run-owned commit, but a live worktree also exists and the PR could not be observed: ${observed.detail}. Both local results were preserved and neither was selected or pushed.`,
          preprotectedCandidateSha,
        )
      }
      const durablyProvenNoChange = row.implementation_outcome === 'succeeded' &&
        matchingUnitIndexes.length === snap.branches.length &&
        matchingUnits.every((unit) => (
          unit.changed === false &&
          unit.initialSha?.toLowerCase() === preprotectedCandidateSha!.toLowerCase() &&
          unit.finalSha?.toLowerCase() === preprotectedCandidateSha!.toLowerCase()
        ))
      const detail = `Recovered and protected the exact run-owned commit, but the recorded PR could not be observed: ${observed.detail}; retry will revalidate before any push.`
      if (durablyProvenNoChange) {
        return persistRecoveryBlocked(deps, row, detail, preprotectedCandidateSha)
      }
      return persistProtectedRecoveryRetry(
        deps,
        row,
        snap,
        matchingUnitIndexes,
        runId,
        preprotectedCandidateSha,
        detail,
      )
    }
    return persistRecoveryBlocked(
      deps, row,
      `The existing PR could not be verified before local recovery: ${observed.detail}. No local evidence was changed.`,
    )
  }
  if (!isExactOpenPr(observed, row.branch, row.base_branch) || !observed.headRefOid) {
    if (preprotectedCandidateSha) {
      if (worktree) {
        return persistRecoveryBlocked(
          deps,
          row,
          'A protected run-owned commit and a live worktree both exist while the recorded PR lifecycle changed. Specrails preserved both and refused to choose or push either automatically.',
          preprotectedCandidateSha,
        )
      }
      const frozen = persistProtectedRecoveryRetry(
        deps,
        row,
        snap,
        matchingUnitIndexes,
        runId,
        preprotectedCandidateSha,
        'Protected the exact run-owned commit; revalidating the changed PR lifecycle before any push.',
      )
      if (frozen.status !== 200 || frozen.body.decision !== 'pr_failed') return frozen
      const recoveredRow = getPrDelivery(deps.db, row.id)
      if (!recoveredRow || recoveredRow.operation_token !== row.operation_token) {
        return staleDecision(recoveredRow?.decision ?? row.decision)
      }
      return retryExistingPrFollowupPush(deps, recoveredRow)
    }
    return persistRecoveryBlocked(
      deps, row,
      'The recorded PR is no longer an exact open head/base recovery target. No local evidence was changed.',
    )
  }
  const baselineSha = observed.headRefOid

  // Ensure the live remote baseline object is available for the ancestry proof
  // without advancing any local branch or touching the main checkout.
  if (!(await commitObjectExists(deps, baselineSha))) {
    try {
      await deps.git.run(['fetch', 'origin', `refs/heads/${row.branch}`], deps.project.path)
    } catch { /* the exact object check below remains authoritative */ }
  }
  if (!(await commitObjectExists(deps, baselineSha))) {
    return persistRecoveryBlocked(
      deps, row,
      'The live PR head object is unavailable locally, so fast-forward recovery cannot be proven. No local evidence was changed.',
      preprotectedCandidateSha,
    )
  }

  let candidateSha: string | null = preprotectedCandidateSha
  let candidateOwned = preprotectedCandidateSha !== null
  let candidateSource: 'worktree' | 'recorded-final' | 'run-marker' | 'baseline' =
    preprotectedCandidateSource ?? 'baseline'
  let committed = false
  if (worktree) {
    const authenticated = await authenticateRecoveryWorktree(deps, worktree.worktree_path, row.branch)
    if (!authenticated.ok) {
      return persistRecoveryBlocked(
        deps, row,
        `The preserved path at ${worktree.worktree_path} could not be authenticated safely: ${authenticated.detail}. Nothing was staged, pushed, or removed.`,
        preprotectedCandidateSha,
      )
    }
    const authenticatedPath = authenticated.realPath
    const [actualBranch, worktreeHead, branchHead] = await Promise.all([
      deps.git.run(['rev-parse', '--abbrev-ref', 'HEAD'], authenticatedPath).catch(() => ({ code: 1, stdout: '', stderr: '' })),
      exactRefSha(deps, authenticatedPath, 'HEAD'),
      exactRefSha(deps, deps.project.path, `refs/heads/${row.branch}`),
    ])
    if (
      actualBranch.code !== 0 || actualBranch.stdout.trim() !== row.branch ||
      !worktreeHead || !branchHead || worktreeHead !== branchHead ||
      authenticated.head.toLowerCase() !== worktreeHead.toLowerCase()
    ) {
      return persistRecoveryBlocked(
        deps, row,
        `The preserved worktree at ${worktree.worktree_path} is not on the exact recorded branch/HEAD. It was left untouched.`,
        preprotectedCandidateSha,
      )
    }
    if (
      preprotectedCandidateSha &&
      worktreeHead.toLowerCase() !== preprotectedCandidateSha.toLowerCase()
    ) {
      return persistRecoveryBlocked(
        deps,
        row,
        `A protected run-owned commit and a different live worktree result both exist. Specrails preserved both and refused to choose or bundle them automatically. Inspect ${worktree.worktree_path} before retrying or discarding either result.`,
        preprotectedCandidateSha,
      )
    }
    if (!(await isFastForwardCandidate(deps, baselineSha, worktreeHead))) {
      return persistRecoveryBlocked(
        deps, row,
        `The preserved branch diverges from the live PR head. The worktree at ${worktree.worktree_path} was left untouched.`,
        preprotectedCandidateSha,
      )
    }

    let skipWorktreeCommit = false
    if (worktreeHead === baselineSha) {
      candidateOwned = true
      candidateSource = 'baseline'
    } else if (recordedFinalSha && worktreeHead.toLowerCase() === recordedFinalSha) {
      candidateOwned = true
      candidateSource = 'recorded-final'
    } else {
      const found = await discoverCandidate()
      if (found.kind === 'unique' && found.sha === worktreeHead.toLowerCase()) {
        candidateOwned = true
        candidateSource = 'run-marker'
      } else if (found.kind === 'unique') {
        // A later/unrelated checked-out tip must not be bundled into the
        // recovered result. Preserve it untouched and use only the exact
        // run-owned object discovered independently.
        candidateSha = found.sha
        candidateOwned = true
        candidateSource = 'run-marker'
        skipWorktreeCommit = true
      } else {
        const reason = found.kind === 'ambiguous'
          ? `Git found ${found.count} run-marked commits, so no unique worktree baseline could be chosen.`
          : found.kind === 'scan_failed'
            ? `${found.detail}.`
            : 'The preserved worktree branch advanced beyond every delivery-owned commit.'
        return persistRecoveryBlocked(
          deps,
          row,
          `${reason} The worktree at ${worktree.worktree_path} was left untouched.`,
        )
      }
    }

    if (!skipWorktreeCommit) {
      deps.assertAdmission?.()
      const reauthenticated = await authenticateRecoveryWorktree(
      deps,
      worktree.worktree_path,
      row.branch,
      worktreeHead,
      )
      if (!reauthenticated.ok || reauthenticated.realPath !== authenticatedPath) {
        const detail = reauthenticated.ok
          ? 'the canonical worktree path changed before staging'
          : reauthenticated.detail
        return persistRecoveryBlocked(
          deps, row,
          `The preserved path at ${worktree.worktree_path} failed final authentication: ${detail}. Nothing was staged, pushed, or removed.`,
        )
      }
      deps.assertAdmission?.()
      const overlayExcludes = [...new Set(matchingUnits.flatMap((unit) => unit.overlayExcludes ?? []))]
      const commit = await commitWorktreeAndVerify(
        deps.git,
        reauthenticated.realPath,
        `specrails: recovered follow-up (run ${runId})`,
        overlayExcludes,
      )
      if (!commit.clean) {
        return persistRecoveryBlocked(
          deps, row,
          `The preserved worktree could not be committed safely: ${commit.error ?? (commit.dirty.join(', ') || 'deliverable changes remain')}. It was left intact at ${worktree.worktree_path}.`,
        )
      }
      committed = commit.committed
      const [afterBranch, afterHead, afterBranchHead] = await Promise.all([
        deps.git.run(['rev-parse', '--abbrev-ref', 'HEAD'], reauthenticated.realPath).catch(() => ({ code: 1, stdout: '', stderr: '' })),
        exactRefSha(deps, reauthenticated.realPath, 'HEAD'),
        exactRefSha(deps, deps.project.path, `refs/heads/${row.branch}`),
      ])
      if (
        afterBranch.code !== 0 || afterBranch.stdout.trim() !== row.branch ||
        !afterHead || afterHead !== afterBranchHead
      ) {
        return persistRecoveryBlocked(
          deps, row,
          `The recovery commit exists, but final branch verification failed. It remains preserved at ${worktree.worktree_path}.`,
        )
      }
      candidateSha = afterHead
      if (committed) {
        candidateOwned = true
        candidateSource = 'worktree'
      }
      if (candidateSource === 'baseline' && recordedFinalSha && afterHead.toLowerCase() === recordedFinalSha) {
        candidateSource = 'recorded-final'
      }
      candidateOwned = candidateOwned || committed || candidateSource !== 'baseline' || afterHead === baselineSha
    }
  } else {
    candidateSha ??= await exactRefSha(deps, deps.project.path, `refs/heads/${row.branch}`)
  }

  // A consistent durable final SHA outranks a mutable branch name. This also
  // lets another checkout recover an object whose branch was later reset.
  if (
    !committed && recordedFinalSha &&
    await commitObjectExists(deps, recordedFinalSha) &&
    (!candidateOwned || candidateSha === baselineSha)
  ) {
    candidateSha = recordedFinalSha
    candidateOwned = true
    candidateSource = 'recorded-final'
  }

  // Before claiming absence, inspect the same complete causal surface as
  // startup. A unique run-marked object may survive after both the worktree and
  // visible branch were removed.
  const baselineHasDurableFinalProof = candidateSha === baselineSha && recordedFinalSha === baselineSha
  if (!candidateSha || (candidateSha === baselineSha && !baselineHasDurableFinalProof) || !candidateOwned) {
    const found = await discoverCandidate()
    if (found.kind === 'ambiguous') {
      return persistRecoveryBlocked(
        deps, row,
        `Git found ${found.count} different run-marked commits. No ambiguous object, branch, or worktree was changed.`,
      )
    }
    if (found.kind === 'scan_failed') {
      return persistRecoveryBlocked(
        deps, row,
        `${found.detail}. No branch, worktree, or object was changed.`,
      )
    }
    if (found.kind === 'unique') {
      candidateSha = found.sha
      candidateOwned = true
      candidateSource = 'run-marker'
    } else if (candidateSha && candidateSha !== baselineSha && !candidateOwned) {
      return persistRecoveryBlocked(
        deps, row,
        'The recorded local branch advanced beyond the run-owned result. The later branch tip was preserved and was not committed or pushed.',
      )
    }
  }

  if (!candidateSha || !(await commitObjectExists(deps, candidateSha))) {
    return persistRecoveryBlocked(
      deps, row,
      'No delivery-owned commit is available in this clone’s refs, reflogs, worktrees, or unreachable objects. The result may still exist on the computer where the run executed; nothing here was changed or removed.',
    )
  }

  if (candidateSha === baselineSha) {
    const provesNoChanges = row.implementation_outcome === 'succeeded' &&
      matchingUnitIndexes.length === snap.branches.length &&
      matchingUnits.every((unit) => (
        unit.changed === false &&
        unit.initialSha?.toLowerCase() === baselineSha.toLowerCase() &&
        unit.finalSha?.toLowerCase() === baselineSha.toLowerCase()
      ))
    if (provesNoChanges) {
      const noChangeIndexes = new Set(matchingUnitIndexes)
      const noChangeBranches = snap.branches.map((unit, index) => noChangeIndexes.has(index)
        ? {
            ...unit,
            succeeded: true,
            implementationOutcome: 'succeeded' as const,
            deliveryOutcome: 'no_changes' as const,
            initialSha: baselineSha,
            finalSha: baselineSha,
            changed: false,
            failureCode: null,
          }
        : unit)
      const conflict = casTransition(deps, row, 'no_changes', {
        branches: noChangeBranches,
        deliverySha: baselineSha,
        deliveryOutcome: 'no_changes',
        statusCode: 'no_changes',
        statusDetail: null,
        isContinuation: true,
      })
      if (conflict) return conflict
      await releaseDeliveredRecoveryLineage(deps, row, baselineSha)
      finalizeTransition(deps, row.id)
      return {
        status: 200,
        body: {
          ok: true,
          decision: 'no_changes',
          prUrl: row.pr_url,
          noChanges: true,
          deliveryVerified: true,
          verifiedSha: baselineSha,
          pushed: false,
        },
      }
    }

    const alreadyDelivered = recordedFinalSha === baselineSha || candidateSource === 'run-marker'
    if (!alreadyDelivered) {
      return persistRecoveryBlocked(
        deps, row,
        'This clone contains only the current PR head and no additional run-owned result. The original execution computer may still retain its worktree or orphan commit; nothing here was changed or removed.',
      )
    }
  } else {
    const protection = preprotectedCandidateSha &&
      preprotectedCandidateSha.toLowerCase() !== candidateSha.toLowerCase()
      ? await advanceRecoveryCommitProtection(
          deps.git,
          deps.project.path,
          row.id,
          preprotectedCandidateSha,
          candidateSha,
        )
      : await protectRecoveryCommit(
          deps.git,
          deps.project.path,
          row.id,
          candidateSha,
        )
    if (!protection.ok) {
      return persistRecoveryBlocked(
        deps,
        row,
        `${protection.detail}. The candidate object and every user-visible branch were left unchanged.`,
        preprotectedCandidateSha,
      )
    }
  }

  if (!(await isFastForwardCandidate(deps, baselineSha, candidateSha))) {
    return persistRecoveryBlocked(
      deps, row,
      'The exact run-owned recovery commit is not a fast-forward of the live PR head. It remains protected locally and nothing was pushed or removed.',
      candidateSha,
    )
  }

  const recoveredIndexes = new Set(matchingUnitIndexes)
  const recoveredBranches = snap.branches.map((unit, index): DeliverBranchRecord => recoveredIndexes.has(index)
    ? {
        ...unit,
        runId,
        branch: row.branch!,
        succeeded: true,
        implementationOutcome: 'succeeded',
        deliveryOutcome: 'ready',
        // Equality with the live PR head can mean the exact run commit was
        // already delivered; it is not no-change evidence. Preserve a durable
        // initial SHA when available and infer the observed baseline only for
        // a still-missing descendant. The proven no-change branch returned
        // above before reaching this mapping.
        initialSha: unit.initialSha ?? (candidateSha !== baselineSha ? baselineSha : null),
        finalSha: candidateSha!,
        changed: true,
        failureCode: null,
        branchOwnership: 'borrowed-pr',
        ...(worktree ? { worktreePath: worktree.worktree_path } : {}),
      }
    : unit)

  // Freeze before the network mutation. A crash after this write leaves a
  // normal immutable Retry push card; a crash before it leaves the run-marked
  // commit discoverable by startup recovery.
  if (!transitionClaimedDecision(
    deps.db,
    row.id,
    row.decision,
    'pr_failed',
    row.operation_token,
    {
      branches: recoveredBranches,
      deliverySha: candidateSha,
      deliveryOutcome: 'retryable_failure',
      statusCode: 'settlement_interrupted',
      statusDetail: candidateSource === 'worktree'
        ? `Committed the preserved worktree as ${candidateSha.slice(0, 8)}; validating the exact PR before push.`
        : candidateSource === 'run-marker'
          ? `Protected the unique run-owned commit ${candidateSha.slice(0, 8)}; validating the exact PR before push.`
          : `Recovered the durable final commit ${candidateSha.slice(0, 8)}; validating the exact PR before push.`,
      isContinuation: true,
    },
  )) {
    const current = getPrDelivery(deps.db, row.id)
    return staleDecision(current?.decision ?? row.decision)
  }
  if (worktree) updateRailWorktreeState(deps.db, worktree.id, 'built')
  const recoveredRow = getPrDelivery(deps.db, row.id)
  if (!recoveredRow || recoveredRow.operation_token !== row.operation_token) {
    return staleDecision(recoveredRow?.decision ?? row.decision)
  }
  deps.assertAdmission?.()
  return retryExistingPrFollowupPush(deps, recoveredRow)
}
