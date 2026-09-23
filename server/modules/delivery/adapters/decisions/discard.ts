import * as fs from 'fs'
import { durableBranchHeads, durableOverlayCleanupEvidence, durableSettlementIgnoredPaths, releaseRailWorktrees } from '../../runtime/rail-worktree-release'
import {
  toPrDeliverySnapshot, type PrDeliveryPatch, type RailPrDeliveryRow
} from '../../runtime/rail-pr-store'
import { getRailWorktree } from '../../runtime/rail-worktrees-store'
import {
  commitCarriesRunMarker, inspectRecoveryCommitProtection, releaseRecoveryCommit
} from '../../runtime/rail-pr-recovery-git'
import { PrDecisionDeps, PrDecisionResult } from './contracts'
import { safetyArchiveRecorder, casTransition, casTransitionWithTicketEffect, applyTerminalTicketEffect, finalizeTransition } from './transitions'
import { deleteOwnedBranchesIfUnchanged, ownedDeliveryBranches } from './ownership'
import { COMMIT_SHA_RE } from './evidence'
import { pauseChainsOnDiscard } from './chains'


export async function runDiscard(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  opts: { removeNeedsReview?: boolean } = { removeNeedsReview: true },
): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const implementationFailed = row.decision === 'implementation_failed'
  // PR lifecycle ownership and head-ref ownership are separate. Startup repairs
  // historical continuation rows before admission opens; only that durable bit
  // borrows the PR/ticket lifecycle. Per-unit ownership below independently
  // prevents deletion of borrowed/pre-existing head refs for fresh replacements.
  const preserveExternalReview = row.is_continuation === 1
  // A preparation failure never ran: no worktree, no branch, no commit, no PR.
  // Discarding it only closes the attempt and frees the rail — the spec keeps
  // the status it had (typically on_review from a still-open earlier PR), the
  // backlog/Jira are not told about a delivery that never existed, and no
  // resource cleanup can be owed. Distinct from implementation_failed, which
  // did run and did move the ticket.
  const preparationFailure = row.decision === 'pr_failed' &&
    row.implementation_outcome === 'failed' &&
    !row.pr_url && !row.delivery_sha && !preserveExternalReview &&
    snap.branches.length === 0 && snap.worktreeIds.length === 0
  const cleanupWarnings: string[] = []

  // A continuation borrows an existing PR/head. Discarding its local iteration
  // may remove Specrails' worktree, but never closes or deletes borrowed review
  // state. A fresh PR is closed without GitHub's unleased --delete-branch: its
  // remote head may have advanced since the card was rendered.
  if (row.pr_url && !implementationFailed && !preserveExternalReview) {
    try {
      const r = await deps.exec.run('gh', ['pr', 'close', row.pr_url], deps.project.path)
      if (r.code !== 0) {
        const detail = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`
        cleanupWarnings.push(`PR close ${row.pr_url}: ${detail}`)
        console.warn(`[rail-pr-decision] gh pr close failed (continuing discard): ${detail}`)
      }
    } catch (err) {
      cleanupWarnings.push(`PR close ${row.pr_url}: ${err instanceof Error ? err.message : String(err)}`)
      console.warn('[rail-pr-decision] gh pr close threw (continuing discard):', err)
    }
  }

  // 2. Release only worktrees whose live tracked/untracked/ignored state and
  //    exact HEAD/ref still match durable settlement evidence. Explicit
  //    discard is not permission to contradict the confirmation copy by
  //    force-removing subsequently changed local work. Authenticated overlays
  //    take the same lossless quarantine path as automatic settlement.
  const deleteOwnedBranches = !implementationFailed && !preserveExternalReview
  const skippedNeedsReview = opts.removeNeedsReview === true
    ? []
    : snap.worktreeIds
        .map((wtId) => getRailWorktree(deps.db, wtId))
        .filter((wt) => wt?.merge_state === 'needs-review')
  for (const worktree of skippedNeedsReview) {
    cleanupWarnings.push(
      `worktree ${worktree!.worktree_path}: preserved for inspection because it already requires review`,
    )
  }
  const skippedIds = new Set(skippedNeedsReview.map((wt) => wt!.id))
  const worktreeIds = snap.worktreeIds.filter((wtId) => !skippedIds.has(wtId))
  cleanupWarnings.push(...await releaseRailWorktrees({
    db: deps.db,
    git: deps.git,
    repoDir: deps.project.path,
    worktreeIds,
    state: 'failed',
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    settlementIgnoredByBranch: durableSettlementIgnoredPaths(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  }))

  const retainedWorktreeBranches = new Set(
    snap.worktreeIds
      .map((wtId) => getRailWorktree(deps.db, wtId))
      .filter((wt) => Boolean(wt && (wt.merge_state === 'needs-review' || fs.existsSync(wt.worktree_path))))
      .map((wt) => wt!.branch),
  )

  // 3. Delete only branches this delivery durably records as created, and only
  //    while their live tips still equal the immutable delivered commits.
  //    Later user/collaborator commits are retained with a cleanup warning.
  if (deleteOwnedBranches) {
    await deleteOwnedBranchesIfUnchanged(deps, row, snap, cleanupWarnings, retainedWorktreeBranches)
  }

  // Explicit Discard local result is also the only authority (besides proven
  // delivery) to release a pinned orphan. A crash can occur after the atomic
  // ref creation but before delivery_sha is written, so recover that ownership
  // only from this delivery's exact durable final SHA or run-marker evidence.
  if (opts.removeNeedsReview === true) {
    let recoverySha = row.delivery_sha && COMMIT_SHA_RE.test(row.delivery_sha)
      ? row.delivery_sha.toLowerCase()
      : null
    if (
      !recoverySha && row.is_continuation === 1 &&
      (row.status_code === 'settlement_interrupted' || row.status_code === 'recovery_unavailable')
    ) {
      const protection = await inspectRecoveryCommitProtection(deps.git, deps.project.path, row.id)
      if (protection.kind === 'present') {
        const durableFinalShas = [...new Set(
          snap.branches
            .map((unit) => unit.finalSha)
            .filter((sha): sha is string => typeof sha === 'string' && COMMIT_SHA_RE.test(sha))
            .map((sha) => sha.toLowerCase()),
        )]
        const runIds = [...new Set(snap.runIds.filter(Boolean))]
        const exactDurableFinal = durableFinalShas.length === 1 && durableFinalShas[0] === protection.sha
        const exactRunMarker = runIds.length === 1 && await commitCarriesRunMarker(
          deps.git,
          deps.project.path,
          protection.sha,
          runIds[0],
        )
        if (exactDurableFinal || exactRunMarker) {
          recoverySha = protection.sha
        } else {
          cleanupWarnings.push(
            `recovery ref ${protection.ref}: preserved because its commit could not be proven to belong to this delivery`,
          )
        }
      } else if (protection.kind === 'unreadable') {
        cleanupWarnings.push(
          `recovery ref ${protection.ref}: preserved because its exact commit could not be read safely`,
        )
      }
    }
    if (recoverySha && !await releaseRecoveryCommit(
      deps.git,
      deps.project.path,
      row.id,
      recoverySha,
    )) {
      cleanupWarnings.push(
        'the delivery recovery ref changed or could not be removed; it was preserved for inspection',
      )
    }
  }

  const terminalPatch: PrDeliveryPatch = {
    deliveryOutcome: 'not_started',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'discarded',
    cleanupWarnings,
  }
  const conflict = preserveExternalReview || preparationFailure
    ? casTransition(deps, row, 'discarded', terminalPatch)
    : casTransitionWithTicketEffect(deps, row, 'discarded', terminalPatch, {
        deliveryId: row.id,
        ticketIds: snap.ticketIds,
        targetStatus: 'todo',
        // The dashboard labels discard-from-no_changes as Refine. Jira must
        // mirror that truthful backlog return and never apply discardStatus.
        jiraAction: row.decision === 'no_changes' ? 'refine' : 'discard',
        prUrl: null,
      })
  if (conflict) return conflict
  pauseChainsOnDiscard(deps, row)
  if (!preserveExternalReview && !preparationFailure) applyTerminalTicketEffect(deps, row, 'discarded', cleanupWarnings)
  finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'discarded',
      ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      ...(preparationFailure ? { preparationFailure: true } : {}),
      ...(preserveExternalReview ? { preservedBorrowedReview: true, preservedExternalReview: true } : {}),
    },
  }
}


export async function runDismiss(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  // Legality restricts dismiss to a clean/retryable continuation. Reuse the
  // ownership-safe discard path; its external PR, head and tickets are borrowed.
  return runDiscard(deps, row, { removeNeedsReview: false })
}


export async function runAcknowledgeNoChanges(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings = await releaseRailWorktrees({
    db: deps.db,
    git: deps.git,
    repoDir: deps.project.path,
    worktreeIds: snap.worktreeIds,
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    settlementIgnoredByBranch: durableSettlementIgnoredPaths(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  })

  // A fresh no-change branch is disposable only while Git still proves that it
  // has no commits ahead of the integration base. If the user added work after
  // settlement, preserve it and disclose the incomplete cleanup.
  for (const branch of ownedDeliveryBranches(row, snap, cleanupWarnings)) {
    if (!branch || branch === row.base_branch) continue
    try {
      const ahead = await deps.git.run(['rev-list', '--count', `${row.base_branch}..${branch}`], deps.project.path)
      if (ahead.code !== 0 || Number.parseInt(ahead.stdout.trim(), 10) !== 0) {
        cleanupWarnings.push(`branch ${branch}: retained because no-change cleanup could not prove it has zero commits ahead of ${row.base_branch}`)
        continue
      }
      const deleted = await deps.git.run(['branch', '-d', branch], deps.project.path)
      if (deleted.code !== 0) {
        cleanupWarnings.push(`branch ${branch}: ${(deleted.stderr.trim() || deleted.stdout.trim()).split('\n')[0] || `exit ${deleted.code}`}`)
      }
    } catch (err) {
      cleanupWarnings.push(`branch ${branch}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const conflict = casTransitionWithTicketEffect(deps, row, 'completed', {
    deliveryOutcome: 'no_changes',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'no_changes',
    cleanupWarnings,
  }, {
    deliveryId: row.id,
    ticketIds: snap.ticketIds,
    targetStatus: 'done',
    jiraAction: 'completed',
    prUrl: null,
  })
  if (conflict) return conflict
  applyTerminalTicketEffect(deps, row, 'completed', cleanupWarnings)
  finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'completed',
      noChanges: true,
      ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
    },
  }
}
