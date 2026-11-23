/**
 * Isolated launch stage 1 — worktree preparation, serialized per base repo.
 * Fetches, resolves the integration base and any PR continuation, opens the
 * delivery generation, names each unit's branch and materializes ALL worktrees
 * up front (all-or-nothing), then freezes the settlement snapshots and the
 * spec-addenda claims before any run may start. A failure tears down only what
 * this launch created and closes its generation.
 */
import * as path from 'path'
import { newId } from '../../../ids'
import {
  removeWorktree, listLocalBranches, worktreeBranch, type GitRunner, type WorktreeHandle,
} from '../../../worktree-manager'
import { createRailWorktree, deleteRailWorktree, updateRailWorktreeState } from './rail-worktrees-store'
import { IntentWorktreeMismatchError, type RequiredFlowWorktree } from './flow-worktree-handoff'
import { ticketBranchName, resolveCollisionFreeName } from './pr-naming'
import {
  assertRepositoryHasCommits, materializeIsolatedWorktree, startPreparationBesideFetch, usesWorktreePreparation, readHeadSha, resolveOverlaySources, ticketNamingInput,
} from './isolated-worktree'
import { getProjectSettings } from '../../../db'
import { saveIsolatedSettlementSnapshot } from './isolated-settlement-store'
import {
  resolveIntegrationBranch, fetchOrigin, resolveWorktreeBaseRef, type ResolvedIntegrationBranch,
} from '../../../integration-branch'
import { withRepoLock } from '../../../repo-lock'
import { preparedCheckoutClaimer } from './worktree-preparation-pool'
import { getProjectRepositories } from '../../../project-repositories'
import { createPrDeliveryGeneration, getPrDelivery, transitionDecision, toPrDeliverySnapshot } from './rail-pr-store'
import {
  broadcastSpecAddendaChange, claimSpecAddendaForRun, settleSpecAddendaAt, snapshotSpecAddenda,
} from '../../specs/runtime/spec-addenda'
import type { Exec } from './pr-publisher'
import {
  resolveActivePrContinuationTargets, resolveExplicitPrTarget, type ActivePrContinuationTarget,
} from './active-pr-continuation'
import { matchesRecordedPrIdentity, observePrLifecycle } from './pr-lifecycle'
import { isDefinitionGraph } from '../../loops/runtime/loop-graph'
import type { AllocatedRun, IsolatedLaunchInput, IsolatedLaunchIO } from './rail-isolated-launch-contracts'
import { PrContinuationIsolationError } from './rail-isolated-launch-contracts'
import {
  buildSpecSnapshot, errorDetail, verifyContinuationWorktree, verifyFlowWorktree, worktreeCommitMessage,
} from './rail-isolated-launch-support'
import type { ClaimedAddendaByRun, FrozenLaunchScope, IsolationUnit } from './rail-isolated-launch-scope'
import type { LaunchDeliveryPublisher, LaunchDeliveryState } from './rail-isolated-launch-delivery-state'

export interface AllocationStageInput {
  input: IsolatedLaunchInput
  io: IsolatedLaunchIO
  git: GitRunner
  exec: Exec
  remove: typeof removeWorktree
  baseRepo: string
  slug: string
  worktreesRoot: string
  prMode: boolean
  units: IsolationUnit[]
  addendaStorePath: string
  addendaPlan: FrozenLaunchScope['addendaPlan']
  claimedAddendaByRun: ClaimedAddendaByRun
  overlaySources: ReturnType<typeof resolveOverlaySources>
  notifyOverlayDegraded: (ticketId: number, warnings: string[]) => void
  expectedRepositoryBaseSha: string | undefined
  deliveryState: LaunchDeliveryState
  delivery: LaunchDeliveryPublisher
}

export interface AllocationStageResult {
  launchContinuation: ActivePrContinuationTarget | null
  allocated: AllocatedRun[]
}

type UnitBranchPlan = { branch: string; ownership: AllocatedRun['branchOwnership'] }

/** Everything resolved under the repository lock that unit allocation needs. */
interface AllocationPlan {
  worktreeBaseRef: Awaited<ReturnType<typeof resolveWorktreeBaseRef>>
  continuationTargets: Map<number, ActivePrContinuationTarget>
  launchContinuation: ActivePrContinuationTarget | null
  units: IsolationUnit[]
  flowWorktree: RequiredFlowWorktree | null
  hygieneBaseSha: string | null
  revisionBranches: Map<number, { branch: string; sha: string }>
  unitBranchName: (ticketId: number) => UnitBranchPlan
}

export async function allocateIsolatedRuns(stage: AllocationStageInput): Promise<AllocationStageResult> {
  const { baseRepo } = stage
  const { closeFailedGeneration } = stage.delivery
  // 0+1. Resolve the integration branch, persist the decision row, compute
  //    branch names, and allocate ALL worktrees up front (all-or-nothing) so a
  //    mid-way failure can't leave the rail half-isolated. The WHOLE section is
  //    SERIALIZED per base repo (withRepoLock — the same key the merge-back
  //    uses): parallel launches on different rails are safe and normal, but
  //    concurrent `git worktree add` / branch creation on the same repo can
  //    race on ref locks, and two launches snapshotting `listLocalBranches`
  //    concurrently could allocate the same collision-suffixed branch name.
  //    Only allocation is locked — the fan-out (the actual AI runs) below
  //    stays fully parallel.
  let launchContinuation: ActivePrContinuationTarget | null = null
  const allocated: AllocatedRun[] = []
  try {
    await withRepoLock(baseRepo, async () => {
      const { fetchResult, integration, worktreeBaseRef } = await resolveLaunchBase(stage)
      const continuation = await resolveContinuationTargets(stage, integration, fetchResult)
      launchContinuation = continuation.launchContinuation
      await assertRequiredPrContinuation(stage, launchContinuation)
      const { units, flowWorktree } = planIsolationUnits(stage, launchContinuation)
      if (stage.prMode) openPrDeliveryGeneration(stage, integration, launchContinuation)
      const branches = await planUnitBranches(stage, integration, launchContinuation, continuation.continuationTargets, flowWorktree, worktreeBaseRef)
      await materializeAllocationUnits(stage, {
        worktreeBaseRef, continuationTargets: continuation.continuationTargets, launchContinuation, units, flowWorktree, ...branches,
      }, allocated)
    }) // withRepoLock — allocation done; the fan-out runs in parallel.
  } catch (err) {
    closeFailedGeneration(err)
    // Auto-detected GitHub continuations do not have a router-side delivery
    // contract yet. Preserve the fail-closed signal for errors that happen
    // after detection but before the allocation catch (for example DB setup).
    // TypeScript does not observe assignments performed inside withRepoLock's
    // async callback, so retain the explicit runtime type at this boundary.
    const detectedContinuation = launchContinuation as ActivePrContinuationTarget | null
    if (detectedContinuation && !(err instanceof PrContinuationIsolationError)) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new PrContinuationIsolationError(
        `cannot prepare a verified worktree for PR branch ${detectedContinuation.branch}: ${detail}`,
      )
    }
    throw err
  }
  return { launchContinuation: launchContinuation as ActivePrContinuationTarget | null, allocated }
}

async function resolveLaunchBase(stage: AllocationStageInput): Promise<{
  fetchResult: Awaited<ReturnType<typeof fetchOrigin>>
  integration: ResolvedIntegrationBranch
  worktreeBaseRef: Awaited<ReturnType<typeof resolveWorktreeBaseRef>>
}> {
  const { input, git, baseRepo } = stage
  const { ctx, railIndex } = input
  // Bring the repo's remote-tracking refs up to date BEFORE resolving the
  // integration branch or allocating any worktree — otherwise `git worktree
  // add -b <branch> <path> <bare-name>` resolves against whatever (possibly
  // stale) commit the user's LOCAL branch happens to be at. `fetchOrigin` only
  // ever touches `refs/remotes/origin/*`; it never mutates the checked-out
  // branch/working tree. De-duped per repo for a short TTL so a "Launch all"
  // batch (N independent launch requests for the same repo, serialized by
  // this same withRepoLock) performs one real fetch, not one per rail. A
  // failed fetch (no network / no remote / auth error) never blocks the
  // launch — resolveWorktreeBaseRef below degrades to the local ref.
  const fetching = fetchOrigin(git, baseRepo)
  const executionRepository = getProjectRepositories(ctx.project).find((repo) => input.repositoryExecution
    ? repo.id === input.repositoryExecution.repositoryId : repo.isPrimary)
  const projectSetting = executionRepository?.integrationBranch ?? (input.repositoryExecution && !input.repositoryExecution.primary ? undefined : getProjectSettings(ctx.db).integrationBranch)
  // A fresh launch with nothing prepared (Launch all prepares ahead) populates
  // one checkout from the pre-fetch base while the fetch is on the network;
  // allocation adopts it and only writes the delta to the fetched base.
  if (usesWorktreePreparation(stage.io) && !input.revision && !input.requiredFlowWorktree) {
    await startPreparationBesideFetch(git, baseRepo, stage.worktreesRoot, input.baseBranch ?? undefined, projectSetting)
  }
  const fetchResult = await fetching

  // Resolve the project's designated integration branch ONCE, and branch every
  // ticket's worktree off it (not the ambient HEAD). Empty setting → auto-resolve
  // (repo default → HEAD fallback). See server/integration-branch.ts.
  const integration = await resolveIntegrationBranch(git, {
    repoDir: baseRepo,
    explicit: input.baseBranch ?? undefined,
    projectSetting,
  })

  // Prefer the freshly-fetched remote-tracking ref (origin/<branch>) over the
  // bare local name for repo-default/project-setting sources — see
  // resolveWorktreeBaseRef for the exact fallback policy. `explicit` is left
  // completely untouched (rare, launch-time-chosen override).
  const worktreeBaseRef = await resolveWorktreeBaseRef(git, {
    repoDir: baseRepo, integration, fetchOk: fetchResult.ok,
  })
  // Unborn HEAD: refuse before the decision row, branches or worktrees exist.
  await assertRepositoryHasCommits(git, baseRepo, worktreeBaseRef.baseRef)
  if (worktreeBaseRef.warning) {
    console.warn(`[rail-isolated] ${worktreeBaseRef.warning} (repo ${baseRepo})`)
    try {
      ctx.broadcast({ type: 'rail.fetch_degraded', projectId: ctx.project.id, railIndex, warning: worktreeBaseRef.warning })
    } catch { /* non-fatal, mirrors notifyOverlayDegraded's broadcast guard below */ }
  }
  return { fetchResult, integration, worktreeBaseRef }
}

async function resolveContinuationTargets(
  stage: AllocationStageInput,
  integration: ResolvedIntegrationBranch,
  fetchResult: Awaited<ReturnType<typeof fetchOrigin>>,
): Promise<{ continuationTargets: Map<number, ActivePrContinuationTarget>; launchContinuation: ActivePrContinuationTarget | null }> {
  const { input, git, exec, baseRepo, prMode } = stage
  const { ctx, ticketIds } = input
  let launchContinuation: ActivePrContinuationTarget | null = null
  // Active-PR continuation: if a ticket is already parked on_review with a
  // matching OPEN GitHub PR (or a Jira-linked in_progress ticket explicitly
  // matches an open PR, covering unmapped Jira "Review" statuses), run the next
  // pass directly on that PR's head branch. Fresh tickets stay on the normal
  // integration-base path. Keep this deliberately single-target for now: one
  // rail delivery row can represent one PR URL, so multi-PR batches continue to
  // use the existing new-work flow instead of silently mixing PRs.
  const continuationTargets = prMode
    ? input.explicitPrTarget
      // Explicit designation is the user's answer, not a discovery guess: it
      // replaces automatic resolution entirely and applies the ONE verified
      // target to every launch ticket. Validation failure throws
      // ExplicitPrTargetError here — before createPrDeliveryGeneration — so a
      // rejected launch leaves zero rows, branches, or worktrees behind.
      ? await (async () => {
          const target = await resolveExplicitPrTarget({
            git,
            exec,
            repoDir: baseRepo,
            prNumber: input.explicitPrTarget!.prNumber,
            integrationBranch: integration.branch,
            fetchOk: fetchResult.ok,
          })
          return new Map<number, ActivePrContinuationTarget>(
            ticketIds.map((ticketId) => [ticketId, { ...target, ticketId }]),
          )
        })()
      : await resolveActivePrContinuationTargets({
          db: ctx.db,
          git,
          exec,
          repoDir: baseRepo,
          // Continuation authority is scoped to the launch's exact durable ticket
          // set. In scope=all there is only one isolation unit, but its primary
          // ticket must never stand in for the full batch during PR discovery.
          ticketIds: [...ticketIds],
          integrationBranch: integration.branch,
          fetchOk: fetchResult.ok,
          getTicketSpec: (ticketId) => {
            try { return ctx.getTicketSpec(ticketId) as ReturnType<typeof ticketNamingInput> & { status?: string; description?: string } }
            catch { return undefined }
          },
        })
    : new Map<number, ActivePrContinuationTarget>()
  const uniqueContinuationKeys = new Set(
    ticketIds
      .map((ticketId) => continuationTargets.get(ticketId))
      .filter((t): t is ActivePrContinuationTarget => !!t)
      .map((t) => `${t.prUrl ?? ''}\n${t.branch}`),
  )
  if (uniqueContinuationKeys.size === 1 && ticketIds.every((ticketId) => continuationTargets.has(ticketId))) {
    launchContinuation = continuationTargets.get(ticketIds[0]) ?? null
  }
  return { continuationTargets, launchContinuation }
}

async function assertRequiredPrContinuation(stage: AllocationStageInput, launchContinuation: ActivePrContinuationTarget | null): Promise<void> {
  const { input, exec, baseRepo } = stage
  if (input.requiredPrContinuation && (
    !launchContinuation ||
    launchContinuation.branch !== input.requiredPrContinuation.branch ||
    launchContinuation.baseBranch !== input.requiredPrContinuation.baseBranch ||
    launchContinuation.prUrl !== input.requiredPrContinuation.prUrl ||
    launchContinuation.prNumber !== input.requiredPrContinuation.prNumber ||
    launchContinuation.deliverySha !== input.requiredPrContinuation.deliverySha
  )) {
    const observed = await observePrLifecycle(
      exec, baseRepo, input.requiredPrContinuation.prUrl,
      input.requiredPrContinuation.deliverySha,
    )
    const reason = observed.ok
      ? matchesRecordedPrIdentity(
          observed,
          input.requiredPrContinuation.branch,
          input.requiredPrContinuation.baseBranch,
        ) && observed.state === 'OPEN' && observed.includesExpectedSha !== true
        ? 'the open PR head no longer exposes the previously verified delivery commit; use Retry push'
        : observed.state === 'CLOSED' || observed.state === 'MERGED'
          ? `the attached PR is ${observed.state.toLowerCase()}; use Verify PR to reconcile it before relaunching`
          : `the PR no longer matches its recorded head/base (${observed.state})`
      : `GitHub lifecycle could not be confirmed (${observed.detail})`
    throw new PrContinuationIsolationError(
      `cannot safely continue PR branch ${input.requiredPrContinuation.branch}: ${reason}`,
    )
  }
}

function planIsolationUnits(
  stage: AllocationStageInput,
  launchContinuation: ActivePrContinuationTarget | null,
): { units: IsolationUnit[]; flowWorktree: RequiredFlowWorktree | null } {
  const { input } = stage
  let units = stage.units
  // A git branch can only be checked out by one worktree. When several rail
  // tickets all continue the same PR, make them one atomic batch run in one
  // checkout instead of attempting N worktrees for the same branch (the second
  // `git worktree add` necessarily fails). `ticketIds` preserves the full rail
  // scope for {{spec.ids}} / ticket commands and completion bookkeeping.
  if (launchContinuation && units.length > 1) {
    units = [{
      ticketId: units[0].ticketId,
      ticketIds: units.flatMap((unit) => unit.ticketIds),
    }]
  }
  // An Intent session hand-off adopts ONE existing worktree for the Intent's single spec.
  // It never combines with continuation, revision or retry contracts. Checked
  // before the delivery row exists, so a rejection leaves nothing behind.
  const flowWorktree = input.requiredFlowWorktree ?? null
  // An Intent session in a non-primary repository runs as the ONE child of a
  // single-repository group: only that repository's leg may adopt it.
  const flowRepositoryLeg = !input.repositoryExecution
    ? !flowWorktree?.repositoryId
    : Boolean(flowWorktree?.repositoryId) && input.repositoryExecution.repositoryId === flowWorktree?.repositoryId
  if (flowWorktree && (
    units.length !== 1 || launchContinuation || input.requiredPrContinuation || input.revision ||
    input.retryOfDelivery || !flowRepositoryLeg || input.explicitPrTarget
  )) {
    throw new IntentWorktreeMismatchError('An Intent session hand-off launches exactly its own spec on a fresh delivery')
  }
  return { units, flowWorktree }
}

function openPrDeliveryGeneration(
  stage: AllocationStageInput,
  integration: ResolvedIntegrationBranch,
  launchContinuation: ActivePrContinuationTarget | null,
): void {
  const { input, baseRepo, addendaPlan, deliveryState } = stage
  const { ctx, railIndex, ticketIds, loopId, loopName } = input
  const { emitPrDeliveryState, broadcastPrState, syncOriginCard } = stage.delivery
  const generation = createPrDeliveryGeneration(ctx.db, {
    launchConfig: input.launchConfig,
    loopChoice: input.loopChoice ?? null,
    parentDeliveryId: input.repositoryExecution?.parentDeliveryId,
    repositoryId: input.repositoryExecution?.repositoryId,
    repositoryPath: input.repositoryExecution ? baseRepo : undefined,
    railIndex,
    loopId,
    railKey: `${railIndex}-${loopId}`,
    ticketIds: [...ticketIds],
    baseBranch: launchContinuation?.baseBranch ?? integration.branch,
    loopName,
    originSurface: input.originSurface ?? 'dashboard',
    originConversationId: input.originConversationId ?? null,
    isContinuation: Boolean(launchContinuation),
    supersedesDeliveryId: launchContinuation?.source === 'rail-pr-delivery'
      ? launchContinuation.deliveryId
      : null,
    specSnapshot: buildSpecSnapshot(ctx, ticketIds),
    ...(input.revision ? { revisionNote: input.revision.note, revisionOf: input.revision.ofDeliveryId } : {}),
    ...(input.followUp ? { followUp: input.followUp } : {}),
    ...(addendaPlan.length > 0 ? { specAddenda: snapshotSpecAddenda(addendaPlan) } : {}),
  }, input.requiredPrContinuation
    ? { id: input.requiredPrContinuation.deliveryId, decision: input.requiredPrContinuation.decision }
    // A revision replaces the generation it revises, atomically, so the rail
    // never shows two active deliveries and a failed revision restores the
    // predecessor through the shipped rollback path.
    : input.revision
      ? { id: input.revision.ofDeliveryId, decision: input.revision.decision }
      : input.retryOfDelivery
        ? { id: input.retryOfDelivery.deliveryId, decision: input.retryOfDelivery.decision }
        : null)
  const prDeliveryId = deliveryState.prDeliveryId = generation.delivery.id
  const supersededDelivery = deliveryState.supersededDelivery = generation.superseded
  input.onPrDeliveryCreated?.(prDeliveryId)
  if (launchContinuation) {
    transitionDecision(ctx.db, prDeliveryId, 'building', 'building', {
      branch: launchContinuation.branch,
      prUrl: launchContinuation.prUrl,
      prNumber: launchContinuation.prNumber,
      prState: 'pr-created',
      // Persist the frozen OPEN head at generation creation, not only after
      // settlement. If allocation/process recovery fails, this terminal
      // continuation can still prove and resume the same borrowed PR instead
      // of shadowing its predecessor with an evidence-less row.
      deliverySha: launchContinuation.deliverySha,
      isContinuation: true,
      supersedesDeliveryId: supersededDelivery?.id ?? launchContinuation.deliveryId,
    })
  }
  if (supersededDelivery) {
    try { emitPrDeliveryState(supersededDelivery.id, 'update') } catch { /* durable supersession is authoritative */ }
  }
  try { broadcastPrState() } catch { /* hydration can recover */ }
  try { syncOriginCard('post') } catch { /* hydration can recover */ }
}

async function planUnitBranches(
  stage: AllocationStageInput,
  integration: ResolvedIntegrationBranch,
  launchContinuation: ActivePrContinuationTarget | null,
  continuationTargets: Map<number, ActivePrContinuationTarget>,
  flowWorktree: RequiredFlowWorktree | null,
  worktreeBaseRef: Awaited<ReturnType<typeof resolveWorktreeBaseRef>>,
): Promise<Pick<AllocationPlan, 'hygieneBaseSha' | 'revisionBranches' | 'unitBranchName'>> {
  const { input, git, baseRepo, slug } = stage
  const { ctx } = input
  // Conventional branch naming (pr-naming): `<type>/<ref>-<kebab-title>`, the
  // Jira key prevailing over the local id when linked. Collisions with foreign
  // branches suffix `-2`… (bounded). Ordinary launches start a new sibling;
  // only exact recorded revision/PR branches can be reused.
  // The integration branch is never used; exhaustion falls back to the legacy
  // `sr/<slug>/ticket-<id>` name. Snapshot under the lock so concurrent
  // launches see each other's just-created branches.
  const takenBranches = await listLocalBranches(git, baseRepo)
  const preexistingBranches = new Set(takenBranches)
  const hygieneBase = await git.run(['rev-parse', '--verify', `${worktreeBaseRef.baseRef}^{commit}`], baseRepo)
  if (hygieneBase.code !== 0) throw new Error('Could not freeze the OpenSpec delivery baseline')
  const hygieneBaseSha = /^[a-f0-9]{40,64}$/i.test(hygieneBase.stdout.trim()) ? hygieneBase.stdout.trim() : null
  const revisionBranches = input.repositoryExecution?.revisionBranches ?? new Map<number, { branch: string; sha: string }>()
  if (input.revision && !input.repositoryExecution && !launchContinuation) {
    const previous = getPrDelivery(ctx.db, input.revision.ofDeliveryId)
    for (const unit of previous ? toPrDeliverySnapshot(previous).branches : []) {
      if (unit.succeeded && unit.finalSha && unit.implementationOutcome !== 'failed' && unit.deliveryOutcome !== 'blocked') {
        revisionBranches.set(unit.ticketId, { branch: unit.branch, sha: unit.finalSha })
      }
    }
  }
  const unitBranchName = (ticketId: number): { branch: string; ownership: AllocatedRun['branchOwnership'] } => {
    if (flowWorktree) {
      takenBranches.add(flowWorktree.branch)
      return { branch: flowWorktree.branch, ownership: 'adopted' }
    }
    const revisionBranch = revisionBranches.get(ticketId)
    if (revisionBranch) return { branch: revisionBranch.branch, ownership: 'preexisting' }
    const continuation = launchContinuation && continuationTargets.get(ticketId)
    if (continuation) {
      takenBranches.add(continuation.branch)
      return { branch: continuation.branch, ownership: 'borrowed-pr' }
    }
    const preferred = ticketBranchName(ticketNamingInput(ctx, ticketId))
    const branch = resolveCollisionFreeName(preferred, {
      // A run can reuse a branch only through the exact revision/PR
      // evidence above. An accepted predecessor may now lag the integration
      // branch, so ordinary grouped allocations must start a fresh branch.
      taken: (name) => takenBranches.has(name),
      reserved: [integration.branch],
    }) ?? worktreeBranch(slug, ticketId)
    takenBranches.add(branch)
    return { branch, ownership: preexistingBranches.has(branch) ? 'preexisting' : 'created' }
  }
  return { hygieneBaseSha, revisionBranches, unitBranchName }
}

async function materializeAllocationUnits(stage: AllocationStageInput, plan: AllocationPlan, allocated: AllocatedRun[]): Promise<void> {
  const { input, git, remove, baseRepo, addendaStorePath, addendaPlan, claimedAddendaByRun } = stage
  const { ctx, loopGraph } = input
  const { prDeliveryId } = stage.deliveryState
  const { closeFailedGeneration } = stage.delivery
  const { units, flowWorktree, launchContinuation } = plan
  const {
    sourceRoot: overlaySourceRoot, fallbackSourceRoots: overlayFallbackRoots,
    providerDir: overlayProviderDir, instructionsFilename: overlayInstructions,
  } = stage.overlaySources
  try {
    for (const unit of units) {
      allocated.push(await allocateUnit(stage, plan, unit))
    }
    // Durable admission is part of allocation: if any snapshot cannot commit,
    // roll back the entire batch before releasing the repository lock or
    // starting Core. The same ownership-aware cleanup handles that failure.
    if (prDeliveryId && isDefinitionGraph(loopGraph)) ctx.db.transaction(() => {
      for (const run of allocated) saveIsolatedSettlementSnapshot(ctx.db, {
        version: 1, projectId: ctx.project.id, deliveryId: prDeliveryId!, baseRepo,
        overlaySourceRoot, overlayFallbackRoots, overlayProviderDir, overlayInstructions,
        commitMessage: worktreeCommitMessage(ctx, run.ticketId, run.runId),
        partialCommitMessage: worktreeCommitMessage(ctx, run.ticketId, run.runId, true), run,
      })
    })()
    // Freeze every addendum claim before any sibling can start Core. A missing
    // store or failed claim must never silently turn a delta into an unbriefed run.
    for (const run of allocated) {
      const plan = addendaPlan.filter(entry => run.ticketIds.includes(entry.ticketId)).map(entry =>
        input.retryOfDelivery ? { ...entry, status: null } : launchContinuation || input.revision || input.repositoryContinuation ? { ...entry, status: 'on_review' } : entry)
      const claimed = claimSpecAddendaForRun(addendaStorePath, run.ticketIds, run.runId, { plan })
      claimedAddendaByRun.set(run.runId, claimed)
      const expected = snapshotSpecAddenda(plan)
      if (expected.some(entry => !claimed.snapshot.some(actual => actual.ticketId === entry.ticketId && actual.id === entry.id && actual.hash === entry.hash)) || (expected.length && !claimed.briefing)) {
        throw new Error('Could not claim the complete frozen spec addenda; no implementation was started. Restore ticket storage and retry.')
      }
      broadcastSpecAddendaChange(msg => ctx.broadcast(msg as never), ctx.project.id, claimed)
    }
  } catch (err) {
    for (const a of allocated) {
      if (claimedAddendaByRun.has(a.runId)) broadcastSpecAddendaChange(msg => ctx.broadcast(msg as never), ctx.project.id, settleSpecAddendaAt(addendaStorePath, a.ticketIds, a.runId, 'failed'))
      if (a.worktreeOwnership === 'adopted' && flowWorktree) {
        // Never remove an adopted Intent worktree on rollback: give it back.
        try {
          ctx.db.transaction(() => {
            deleteRailWorktree(ctx.db, a.ledgerId)
            flowWorktree.release(errorDetail(err))
          })()
        } catch (releaseError) {
          console.error(`[rail-isolated] could not return Intent worktree ${a.handle.worktreePath}: ${errorDetail(releaseError)}`)
          updateRailWorktreeState(ctx.db, a.ledgerId, 'needs-review')
        }
        continue
      }
      if (a.worktreeOwnership === 'created') {
        await remove(git, {
          repoDir: baseRepo,
          worktreePath: a.handle.worktreePath,
          branch: a.handle.branch,
          deleteBranch: a.branchOwnership === 'created',
        }).catch(() => {})
      }
      updateRailWorktreeState(ctx.db, a.ledgerId, 'failed')
    }
    // Close the failed generation. A continuation atomically restores the exact
    // predecessor it superseded; a stale concurrent generation wins instead of
    // letting this catch overwrite it.
    closeFailedGeneration(err)
    if (launchContinuation) {
      if (err instanceof PrContinuationIsolationError) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new PrContinuationIsolationError(
        `cannot allocate a verified worktree for PR branch ${launchContinuation.branch}: ${detail}; free the branch checkout and retry`,
      )
    }
    throw err
  }
}

/** One unit's worktree + ledger row (and, for an Intent hand-off, the adoption). */
async function allocateUnit(stage: AllocationStageInput, plan: AllocationPlan, unit: IsolationUnit): Promise<AllocatedRun> {
  const { input, io, git, remove, baseRepo, slug, worktreesRoot, overlaySources, notifyOverlayDegraded, expectedRepositoryBaseSha } = stage
  const { ctx, railIndex } = input
  const { prDeliveryId } = stage.deliveryState
  const { worktreeBaseRef, continuationTargets, launchContinuation, flowWorktree, hygieneBaseSha, revisionBranches, unitBranchName } = plan
  const runId = input.repositoryExecution?.runIds.get(unit.ticketId) ?? newId()
  const continuationTarget = launchContinuation ? continuationTargets.get(unit.ticketId) ?? null : null
  const branchPlan = unitBranchName(unit.ticketId)
  let handle: WorktreeHandle | null = null
  let branchOwnership = branchPlan.ownership
  let worktreeOwnership: AllocatedRun['worktreeOwnership'] = 'created'
  let initialSha: string | null = null
  try {
    const revisionBranch = revisionBranches.get(unit.ticketId)
    if (input.revision && !input.repositoryExecution && !launchContinuation && !revisionBranch) throw new Error('Revision requires a recorded delivered branch for every ticket')
    if (revisionBranch) {
      const observed = await git.run(['rev-parse', '--verify', `refs/heads/${revisionBranch.branch}`], baseRepo)
      if (observed.code !== 0 || observed.stdout.trim() !== revisionBranch.sha) {
        throw new Error(`Revision branch ${revisionBranch.branch} no longer matches its recorded delivery commit`)
      }
    }
    const prepared = await materializeIsolatedWorktree({
      repoDir: baseRepo,
      worktreesRoot: path.join(worktreesRoot, runId),
      slug,
      ticketId: unit.ticketId,
      baseRef: flowWorktree?.baseSha ?? revisionBranch?.sha ?? continuationTarget?.baseRef ?? worktreeBaseRef.baseRef,
      branch: branchPlan.branch,
      branchOwnership: branchPlan.ownership,
      pinBranchOwnership: Boolean(continuationTarget || flowWorktree),
      refreshFromBaseRef: Boolean(continuationTarget?.baseRef),
      fresh: !revisionBranch && !continuationTarget && !flowWorktree,
      reuseBranchWorktree: Boolean(revisionBranch || continuationTarget || flowWorktree),
      ...(usesWorktreePreparation(io) && !revisionBranch && !continuationTarget && !flowWorktree
        ? { claimPrepared: preparedCheckoutClaimer(git, baseRepo, worktreesRoot) }
        : {}),
      verifyHead: async (mounted) => {
        if (flowWorktree) return verifyFlowWorktree(git, mounted, flowWorktree)
        if (continuationTarget) {
          return verifyContinuationWorktree(
            git,
            baseRepo,
            mounted,
            continuationTarget,
            continuationTarget.deliverySha,
          )
        }
        const headSha = await readHeadSha(git, mounted.worktreePath)
        if (expectedRepositoryBaseSha && headSha !== expectedRepositoryBaseSha) throw new Error('The repository base changed before its worktree could be frozen')
        if (revisionBranch && (mounted.branch !== revisionBranch.branch || headSha !== revisionBranch.sha)) {
          throw new Error(`Revision checkout does not expose the exact recorded branch ${revisionBranch.branch}`)
        }
        return headSha
      },
      overlay: overlaySources,
      copyEnvFiles: getProjectSettings(ctx.db).worktreeEnvFiles,
      onDegraded: (warnings) => notifyOverlayDegraded(unit.ticketId, warnings),
    }, io)
    handle = prepared.handle
    branchOwnership = prepared.branchOwnership
    // The verified Intent mount pre-existed by construction; the rail adopts it.
    worktreeOwnership = flowWorktree && prepared.worktreeOwnership === 'preexisting' ? 'adopted' : prepared.worktreeOwnership
    initialSha = prepared.initialSha
    const { overlayExcludes, overlayCleanupEvidence, warmLinkEvidence, provenanceSnapshot } = prepared
    const ledgerId = newId()
    const ledgerRow = {
      id: ledgerId, railIndex, ticketId: unit.ticketId, runId,
      repositoryId: input.repositoryExecution?.repositoryId,
      repositoryPath: input.repositoryExecution ? baseRepo : undefined,
      branch: handle.branch, worktreePath: handle.worktreePath,
    }
    if (flowWorktree) {
      // Ownership transfer: the rail ledger row and the Intent's handed_off
      // state commit together or not at all.
      const adoptedHead = initialSha
      if (!adoptedHead) throw new IntentWorktreeMismatchError('The Intent worktree HEAD could not be verified')
      ctx.db.transaction(() => {
        createRailWorktree(ctx.db, ledgerRow)
        // A repository leg reports the GROUP delivery: the Intent settles on
        // the parent's `rail.pr_state`, which is the only one broadcast.
        flowWorktree.adopt({ railIndex, runId, ledgerId, deliveryId: input.repositoryExecution?.parentDeliveryId ?? prDeliveryId, headSha: adoptedHead })
      })()
    } else {
      createRailWorktree(ctx.db, ledgerRow)
    }
    return {
      ticketId: unit.ticketId,
      ticketIds: unit.ticketIds,
      runId,
      ledgerId,
      handle,
      overlayExcludes,
      overlayCleanupEvidence,
      warmLinkEvidence,
      provenanceSnapshot,
      continuationTarget,
      baseRef: flowWorktree?.baseSha ?? continuationTarget?.baseRef ?? worktreeBaseRef.baseRef,
      hygieneBaseSha: flowWorktree?.baseSha ?? hygieneBaseSha,
      initialSha,
      branchOwnership,
      worktreeOwnership,
    }
  } catch (err) {
    // A handle that never reached `allocated` is still our responsibility,
    // but only unmount/delete resources this call actually created.
    if (handle && worktreeOwnership === 'created') {
      await remove(git, {
        repoDir: baseRepo,
        worktreePath: handle.worktreePath,
        branch: handle.branch,
        deleteBranch: branchOwnership === 'created',
      }).catch(() => {})
    }
    throw err
  }
}
