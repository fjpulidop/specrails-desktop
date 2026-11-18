/**
 * Per-run Git settlement of an isolated rail run: provenance, the terminal
 * callback, overlay/warm-link re-authentication, intent.md, the hygiene-guarded
 * commit and branch verification. One owner shared by fresh launches and
 * durable reattachment after a restart.
 */
import type { SpecIntent } from '../../specs/domain/intent'
import { materializeIntent } from './intent-materialization'
import { retireSupersededForkChanges } from './fork-change-supersession'
import {
  commitWorktreeAndVerify, activeOpenSpecChangesAt, type GitRunner, type CommitWorktreeResult,
} from '../../../worktree-manager'
import { readHeadSha } from './isolated-worktree'
import { revalidateOverlayCleanupEvidence } from '../../../worktree-overlay'
import { authenticateWarmNodeModulesLinks } from '../../../worktree-node-modules'
import type { AllocatedRun, SettledRun } from './rail-isolated-launch-contracts'
import { RUN_STOPPED_DETAIL } from './rail-isolated-launch-contracts'
import {
  branchHasDelta, captureSettlementIgnoredPaths, commitFailureSummary, errorDetail, verifyContinuationWorktree,
} from './rail-isolated-launch-support'

export interface IsolatedRunSettlementPorts {
  git: GitRunner
  baseRepo: string
  overlaySourceRoot: string
  overlayFallbackRoots?: string[]
  overlayProviderDir: string
  overlayInstructions: string
  isAborted?(): boolean
  ownsRun?(runId: string): boolean
  onFinished(runId: string, outcome: string, stallReason?: string): void
  /** Awaited before the terminal callback and the worktree commit. */
  recordRunProvenance(run: AllocatedRun): void | Promise<void>
  markWorktree(run: AllocatedRun, state: 'built' | 'failed' | 'needs-review'): string | null
  hasRuntimeRequest(runId: string): boolean
  commitMessage(run: AllocatedRun, partial: boolean): string
  /** The intent to write as the change's intent.md (intent-mode); null skips it. */
  intentFor?(run: AllocatedRun): { intent: SpecIntent; title: string | null } | null
  /** Fork runs (nearest first) whose superseded source changes this run may retire before commit. */
  forkChain?(runId: string): string[]
}

/** Shared by fresh execution and durable reattachment; one owner of Git settlement. */
export function createIsolatedRunSettlement(ports: IsolatedRunSettlementPorts) {
  const { git, baseRepo, overlaySourceRoot, overlayFallbackRoots, overlayProviderDir, overlayInstructions,
    isAborted, onFinished, recordRunProvenance, markWorktree, hasRuntimeRequest, commitMessage, intentFor } = ports
  return async (
    a: AllocatedRun,
    enginePromise: Promise<{ runId: string; outcome: string; stallReason?: string }>,
  ): Promise<SettledRun> => {
    let actualOutcome = 'failed'
    let engineFailure: string | undefined
    let stallReason: string | undefined
    try {
      const result = await enginePromise
      actualOutcome = result.outcome
      stallReason = result.stallReason
    } catch (err) {
      engineFailure = errorDetail(err)
      console.error(`[rail-isolated] loop run ${a.runId} rejected: ${engineFailure}`)
    }
    if (ports.ownsRun && !ports.ownsRun(a.runId)) throw new Error('Fork owns the original settlement')

    if (isAborted?.()) {
      // The coordinator never started. Do not commit incidental edits or
      // release a mount borrowed from a previous delivery while rolling back.
      const finalSha = await readHeadSha(git, a.handle.worktreePath)
      if (a.worktreeOwnership !== 'created') markWorktree(a, 'needs-review')
      return {
        run: a, implementationOutcome: 'failed', deliveryOutcome: 'not_started',
        initialSha: a.initialSha, finalSha, changed: Boolean(finalSha && a.initialSha !== finalSha),
        safeToRelease: a.worktreeOwnership === 'created' && finalSha !== null && finalSha === a.initialSha,
      }
    }
    const implementationOutcome = actualOutcome === 'success' ? 'succeeded' as const : 'failed' as const
    await recordRunProvenance(a)

    let callbackFailure: string | undefined
    try {
      onFinished(a.runId, actualOutcome, stallReason)
    } catch (err) {
      callbackFailure = errorDetail(err)
      console.error(`[rail-isolated] terminal callback failed for ${a.runId}: ${callbackFailure}`)
    }

    // A paused/interrupted programmatic workflow owns unfinished changes and
    // verification evidence in this exact mount. Keep them available for
    // explicit Core recovery, including a currently clean worktree.
    if (implementationOutcome === 'failed' && hasRuntimeRequest(a.runId)) {
      markWorktree(a, 'needs-review')
      // A person's Stop keeps the same worktree, but nothing failed: say so.
      const stopped = actualOutcome === 'stopped'
      return {
        run: a, implementationOutcome, deliveryOutcome: 'blocked',
        initialSha: a.initialSha, finalSha: await readHeadSha(git, a.handle.worktreePath),
        failureCode: stopped ? 'run_stopped' : 'settlement_interrupted',
        failureDetail: stopped
          ? RUN_STOPPED_DETAIL
          : 'Programmatic workflow stopped before delivery; partial changes stay in its original worktree. The run log names the failing step. A resumable step offers Resume on the job page; a raised loop limit (such as a step\'s Maximum turns) needs a new launch.',
        safeToRelease: false,
      }
    }

    // The engine may have edited a copied overlay file. Re-authenticate only
    // automatic-cleanup authority. Allocation-time paths remain conservative
    // NEVER-COMMIT exclusions, while a modified copy is preserved in the
    // worktree instead of being silently staged or deleted.
    if (a.overlayCleanupEvidence.length > 0) {
      a.overlayCleanupEvidence = revalidateOverlayCleanupEvidence({
        worktreePath: a.handle.worktreePath,
        sourceRoot: overlaySourceRoot,
        fallbackSourceRoots: overlayFallbackRoots,
        providerDir: overlayProviderDir,
        instructionsFilename: overlayInstructions,
      }, a.overlayCleanupEvidence)
    }
    // Warm-dependency links are re-proven against the base repo (their source),
    // not the framework overlay source. A link the engine replaced with a real
    // install loses its authorization here and correctly preserves the worktree.
    if (a.warmLinkEvidence.length > 0) {
      a.warmLinkEvidence = authenticateWarmNodeModulesLinks(baseRepo, a.handle.worktreePath)
        .filter((live) => a.warmLinkEvidence.some(
          (prior) => prior.path === live.path && prior.kind === live.kind && prior.digest === live.digest,
        ))
    }

    // intent-mode: the spec's intent lands as intent.md in the run's own
    // OpenSpec change, in the same commit. Best effort; never blocks delivery.
    const intentSource = implementationOutcome === 'failed' ? null : intentFor?.(a) ?? null
    if (intentSource) {
      const written = await materializeIntent({ git, worktreePath: a.handle.worktreePath, baseRef: a.hygieneBaseSha ?? a.initialSha ?? a.baseRef, intent: intentSource.intent, title: intentSource.title })
      if (written.status === 'warning') console.warn(`[rail-isolated] run ${a.runId}: ${written.warning}`)
    }

    let commit: CommitWorktreeResult
    try {
      // A fork shares its source's worktree; Core leaves the source's active
      // change in place after copying it. Retire it so delivery is not blocked.
      const forkRunIds = ports.forkChain?.(a.runId) ?? []
      if (forkRunIds.length) {
        const retired = await retireSupersededForkChanges({ git, worktreePath: a.handle.worktreePath, baseRef: a.hygieneBaseSha ?? a.initialSha ?? a.baseRef, forkRunIds })
        if (retired.length) console.log(`[rail-isolated] run ${a.runId}: retired superseded fork source changes ${retired.join(', ')}`)
      }
      // A continuation may merge its PR's base mid-run (pr-ci-loop resolves
      // conflicts by merging the base into the PR branch): active OpenSpec
      // changes that already exist on that base are not this checkout's work.
      const baseChanges = a.continuationTarget
        ? await activeOpenSpecChangesAt(git, a.handle.worktreePath, `refs/remotes/origin/${a.continuationTarget.baseBranch}`)
        : []
      commit = await commitWorktreeAndVerify(
        git,
        a.handle.worktreePath,
        commitMessage(a, implementationOutcome === 'failed'),
        a.overlayExcludes,
        a.hygieneBaseSha ?? a.initialSha ?? a.baseRef,
        baseChanges.length ? { allowedActiveChanges: baseChanges } : {},
      )
    } catch (err) {
      commit = { staged: false, committed: false, clean: false, dirty: [], error: errorDetail(err) }
    }

    if (!commit.clean) {
      const detail = commitFailureSummary(commit)
      console.error(`[rail-isolated] run ${a.runId} left an unsafe worktree: ${detail}`)
      markWorktree(a, 'needs-review')
      return {
        run: a,
        implementationOutcome,
        deliveryOutcome: 'blocked',
        initialSha: a.initialSha,
        finalSha: await readHeadSha(git, a.handle.worktreePath),
        failureCode: 'commit_failed',
        failureDetail: detail,
        safeToRelease: false,
      }
    }

    // The worktree is proven clean THIS instant — freeze the ignored-path set
    // as the settlement snapshot. Everything ignored right now is run residue
    // by construction (the worktree is app-created and deliverables are
    // committed); anything ignored that appears LATER preserves the worktree.
    a.settlementIgnoredPaths = a.automaticRelease === false ? null : await captureSettlementIgnoredPaths(
      git, a.handle.worktreePath, a.overlayExcludes,
    )

    let finalSha: string | null = null
    let verificationFailure: string | undefined
    if (a.continuationTarget) {
      try {
        finalSha = await verifyContinuationWorktree(git, baseRepo, a.handle, a.continuationTarget)
      } catch (err) {
        verificationFailure = errorDetail(err)
      }
    } else {
      finalSha = await readHeadSha(git, a.handle.worktreePath)
    }
    const changed = commit.committed || Boolean(a.initialSha && finalSha && a.initialSha !== finalSha)

    // A successful commit without a provable object is not retryable or safe to
    // detach. A continuation additionally requires HEAD == refs/heads/<branch>.
    if (verificationFailure || !finalSha || (
      !commit.committed && a.branchOwnership === 'created' && !a.initialSha
    )) {
      const detail = verificationFailure
        ?? (!finalSha
          ? 'the final HEAD object could not be verified'
          : 'the initial HEAD object was not captured, so a no-change result cannot be proven')
      console.error(`[rail-isolated] run ${a.runId} finished on an unverified ref: ${detail}`)
      markWorktree(a, 'needs-review')
      return {
        run: a,
        implementationOutcome,
        deliveryOutcome: 'blocked',
        initialSha: a.initialSha,
        finalSha,
        changed,
        failureCode: 'branch_verification_failed',
        failureDetail: detail,
        safeToRelease: false,
      }
    }

    // Failed clean units remain `building` until aggregate cleanup removes the
    // mount and atomically terminalizes the ledger as failed. Marking them
    // terminal first would make idempotent cleanup skip a still-mounted path.
    const ledgerFailure = implementationOutcome === 'succeeded'
      ? (markWorktree(a, 'built') ?? undefined)
      : undefined
    const settlementFailure = callbackFailure ?? ledgerFailure
    if (settlementFailure) {
      markWorktree(a, 'needs-review')
      return {
        run: a,
        implementationOutcome,
        deliveryOutcome: 'blocked',
        initialSha: a.initialSha,
        finalSha,
        changed,
        failureCode: 'settlement_interrupted',
        failureDetail: settlementFailure,
        safeToRelease: false,
      }
    }

    if (implementationOutcome === 'failed') {
      return {
        run: a,
        implementationOutcome,
        deliveryOutcome: 'not_started',
        initialSha: a.initialSha,
        finalSha,
        changed,
        ...(engineFailure ? { failureDetail: engineFailure } : {}),
        safeToRelease: a.automaticRelease !== false,
      }
    }

    // A resumed non-PR branch may already contain reviewable commits from an
    // earlier attempt, even when this iteration itself did not add one.
    let resumedBranchDelta: boolean | null = null
    // An adopted Intent branch already carries the Intent's commits ahead of base.
    if (!changed && a.continuationTarget === null && (a.branchOwnership === 'preexisting' || a.branchOwnership === 'adopted')) {
      resumedBranchDelta = await branchHasDelta(git, a.handle.worktreePath, a.baseRef)
      if (resumedBranchDelta === null) {
        const detail = `cannot prove whether resumed branch ${a.handle.branch} has commits ahead of ${a.baseRef}`
        markWorktree(a, 'needs-review')
        return {
          run: a,
          implementationOutcome,
          deliveryOutcome: 'blocked',
          initialSha: a.initialSha,
          finalSha,
          changed,
          failureCode: 'branch_verification_failed',
          failureDetail: detail,
          safeToRelease: false,
        }
      }
    }
    const noChanges = !changed && Boolean(
      a.initialSha && finalSha && a.initialSha === finalSha && (
        a.continuationTarget !== null ||
        a.branchOwnership === 'created' ||
        resumedBranchDelta === false
      ),
    )
    return {
      run: a,
      implementationOutcome,
      deliveryOutcome: noChanges ? 'no_changes' : 'ready',
      initialSha: a.initialSha,
      finalSha,
      changed,
      safeToRelease: a.automaticRelease !== false,
    }
  }
}
