/**
 * Isolated launch stage 2 — run launch. Fans out one loop run per allocated
 * worktree, wires each run's deferred settlement (provenance, ledger marks,
 * the shared per-run Git settlement) and persists the run ids on the building
 * row. Returns one guarded settlement per unit: an unexpected rejection becomes
 * a blocked, never-released record so aggregate settlement keeps its cardinality.
 */
import { definitionForkChain } from './fork-change-supersession'
import type { GitRunner } from '../../../worktree-manager'
import { hasAgentRuntimeRequest } from '../../agent-runtime/runtime/agent-runtime-paths'
import { updateRailWorktreeState } from './rail-worktrees-store'
import { readHeadSha, resolveOverlaySources } from './isolated-worktree'
import { saveIsolatedSettlementResult, recordIsolatedProvenanceOnce } from './isolated-settlement-store'
import { readDefinitionForkTarget, readDefinitionRun } from '../../loops/runtime/loop-runs-store'
import { transitionDecision } from './rail-pr-store'
import { renderFollowUpBriefing } from './pr-follow-up'
import { recordLoopRunProvenance, type ProvenanceCommit } from '../../code/runtime/file-story'
import type { ActivePrContinuationTarget } from './active-pr-continuation'
import { isDefinitionGraph } from '../../loops/runtime/loop-graph'
import type { AllocatedRun, IsolatedLaunchInput, IsolatedLaunchIO, SettledRun } from './rail-isolated-launch-contracts'
import { errorDetail, runIntent, worktreeCommitMessage } from './rail-isolated-launch-support'
import { createIsolatedRunSettlement } from './rail-isolated-run-settlement'
import { reattachIsolatedSettlement } from './rail-isolated-recovery'
import type { ClaimedAddendaByRun, FrozenLaunchScope } from './rail-isolated-launch-scope'
import type { LaunchDeliveryPublisher, LaunchDeliveryState } from './rail-isolated-launch-delivery-state'

export interface RunLaunchStageInput {
  input: IsolatedLaunchInput
  io: IsolatedLaunchIO
  git: GitRunner
  baseRepo: string
  prMode: boolean
  constants: FrozenLaunchScope['constants']
  claimedAddendaByRun: ClaimedAddendaByRun
  singleRepositoryId: string | undefined
  overlaySources: ReturnType<typeof resolveOverlaySources>
  launchContinuation: ActivePrContinuationTarget | null
  allocated: AllocatedRun[]
  deliveryState: LaunchDeliveryState
  delivery: LaunchDeliveryPublisher
}

export type MarkWorktree = (a: AllocatedRun, state: 'built' | 'failed' | 'needs-review') => string | null

export interface RunLaunchStageResult {
  guardedRunPromises: Promise<SettledRun>[]
  markWorktree: MarkWorktree
}

export function startIsolatedRuns(stage: RunLaunchStageInput): RunLaunchStageResult {
  const { input, git, baseRepo, prMode, constants, claimedAddendaByRun, singleRepositoryId, launchContinuation, allocated } = stage
  const { ctx, railIndex, ticketIds, loopId, loopName, loopGraph, provider, model, effort, deciderEngine } = input
  const { prDeliveryId } = stage.deliveryState
  const { broadcastPrState, syncOriginCard } = stage.delivery
  const {
    sourceRoot: overlaySourceRoot, fallbackSourceRoots: overlayFallbackRoots,
    providerDir: overlayProviderDir, instructionsFilename: overlayInstructions,
  } = stage.overlaySources
  // 2. Fan out: one loop run per independent worktree. Same-PR tickets form one
  //    atomic batch run because git cannot mount one branch in multiple linked
  //    worktrees. In PR mode a COMPLETED run's tickets park at on_review (the
  //    user decides done vs discard via the PR flow); failures ignore the field.
  const runFinishedOpts = { ticketCompletionStatus: prMode ? 'on_review' as const : 'done' as const }
  const recordRunProvenance = createRunProvenanceRecorder(stage)
  const markWorktree = createWorktreeMarker(ctx)

  const settleAllocatedRun = createIsolatedRunSettlement({
    git, baseRepo, overlaySourceRoot, overlayFallbackRoots, overlayProviderDir, overlayInstructions,
    isAborted: input.repositoryExecution?.isAborted,
    ownsRun: runId => !readDefinitionForkTarget(ctx.db, runId),
    onFinished: (runId, outcome, stallReason) => ctx.onLoopRunFinished(runId, outcome, { ...runFinishedOpts, ...(stallReason ? { stallReason } : {}) }),
    recordRunProvenance, markWorktree,
    // The run's frozen context decides (a run admitted mid-assembly keeps its state where it was admitted).
    hasRuntimeRequest: runId => hasAgentRuntimeRequest(input.runtimeStateProject ?? ctx.project, runId, frozenContextPath(ctx.db, runId)),
    commitMessage: (run, partial) => worktreeCommitMessage(ctx, run.ticketId, run.runId, partial, { worktreePath: run.handle.worktreePath }),
    intentFor: (run) => runIntent(ctx, run),
    forkChain: runId => definitionForkChain(ctx.db, runId),
  })

  const runPromises: Promise<SettledRun>[] = []
  for (const a of allocated) {
    ctx.railLoopRuns.set(a.runId, {
      railIndex,
      ticketIds: a.ticketIds,
      requiresTerminalIntent: true,
    })
    const spec = ctx.getTicketSpec(a.ticketId)
    const claimedAddenda = claimedAddendaByRun.get(a.runId)!
    const enginePromise = ctx.loopRunManager.run({
        runtimeProviderOverride: input.runtimeProviderOverride,
        runId: a.runId, loopId, loopName, graph: loopGraph, projectId: ctx.project.id, launchConfig: input.launchConfig, ...(input.launchNotices?.length ? { launchNotices: input.launchNotices } : {}),
        cwd: a.handle.worktreePath, repoDir: a.handle.worktreePath,
        repositoryId: singleRepositoryId,
        workspacePaths: singleRepositoryId ? input.workspaceSelection?.[singleRepositoryId] : undefined,
        isolation: { branch: a.handle.branch, worktreePath: a.handle.worktreePath },
        railIndex, ticketId: a.ticketIds.length ? a.ticketId : null,
        spec: {
          ...spec,
          ticketIds: a.ticketIds,
          ...(a.ticketIds.length > 1 ? {
            tickets: a.ticketIds.map((id) => {
              const ticket = ctx.getTicketSpec(id)
              return { id, title: ticket?.title, description: ticket?.description, repositoryIds: ticket?.repositoryIds }
            }),
          } : {}),
        },
        ticketCompletionStatus: runFinishedOpts.ticketCompletionStatus,
        deferTerminalOutcome: true,
        constants, provider, model, effort, ...(deciderEngine ? { deciderEngine } : {}),
        profileName: input.profileName,
        ...(input.runCapUsd !== undefined ? { runCapUsd: input.runCapUsd } : {}),
        ...(input.followUp ? { followUp: { id: input.followUp.id, version: input.followUp.version, hash: input.followUp.hash, openspecChangeName: input.followUp.openspecChangeName ?? null, briefing: renderFollowUpBriefing(input.followUp, { prNumber: (launchContinuation as ActivePrContinuationTarget | null)?.prNumber ?? input.explicitPrTarget?.prNumber ?? null, ticketIds }) } } : {}),
        ...(claimedAddenda.briefing ? { addenda: { ids: claimedAddenda.snapshot.map((e) => e.id), briefing: claimedAddenda.briefing } } : {}),
        // Intent hand-off: Core derives the change from the Intent reservation commit.
        ...(input.requiredFlowWorktree ? { flowDerivation: { baseSha: input.requiredFlowWorktree.baseSha ?? null, summary: input.requiredFlowWorktree.summary ?? '', ...(input.requiredFlowWorktree.acceptedScope ? { acceptedScope: input.requiredFlowWorktree.acceptedScope } : {}), ...(input.requiredFlowWorktree.changeId ? { changeId: input.requiredFlowWorktree.changeId } : {}) } } : {}),
      })
    runPromises.push(settleAllocatedRun(a, enginePromise).then(async result => {
      if (prDeliveryId && isDefinitionGraph(loopGraph)) saveIsolatedSettlementResult(ctx.db, prDeliveryId, result)
      if (prDeliveryId && isDefinitionGraph(loopGraph) && allocated.some(unit => readDefinitionForkTarget(ctx.db, unit.runId))) {
        await reattachIsolatedSettlement(ctx, prDeliveryId, a.runId).catch(error => console.error('[rail-isolated] fork sibling settlement remains pending:', error))
      }
      return result
    }))
    try { ctx.jiraSyncManager.onRailLaunch(a.ticketIds, a.runId) } catch { /* non-fatal */ }
  }

  // The fan-out just materialized the runs (each run's backing jobs row is
  // created synchronously at spawn) — persist their ids on the decision row
  // (order matches ticket order) and re-broadcast so the building card/strip
  // gains its per-run "View log" chips live. CAS on 'building' (a raced
  // alloc-failure discard must win); the settle patch leaves run_ids untouched.
  if (prDeliveryId && transitionDecision(ctx.db, prDeliveryId, 'building', 'building', { runIds: allocated.map((a) => a.runId) })) {
    broadcastPrState()
    syncOriginCard('update')
  }

  const guardedRunPromises = runPromises.map((promise, index) => promise.catch(async (err): Promise<SettledRun> => {
    if (readDefinitionForkTarget(ctx.db, allocated[index].runId)) return { run: allocated[index], implementationOutcome: 'failed', deliveryOutcome: 'not_started', initialSha: allocated[index].initialSha, finalSha: null, safeToRelease: false }
    const run = allocated[index]
    const detail = errorDetail(err)
    console.error(`[rail-isolated] unexpected settlement rejection for ${run.runId}: ${detail}`)
    const durable = ctx.db.prepare('SELECT final_outcome FROM loop_runs WHERE id = ?').get(run.runId) as
      | { final_outcome: string | null }
      | undefined
    const implementationOutcome = durable?.final_outcome === 'success' ? 'succeeded' as const : 'failed' as const
    markWorktree(run, 'needs-review')
    return {
      run,
      implementationOutcome,
      deliveryOutcome: 'blocked',
      initialSha: run.initialSha,
      finalSha: await readHeadSha(git, run.handle.worktreePath),
      failureCode: 'settlement_interrupted',
      failureDetail: detail,
      safeToRelease: false,
    }
  }))
  return { guardedRunPromises, markWorktree }
}

function createRunProvenanceRecorder(stage: RunLaunchStageInput): (a: AllocatedRun) => Promise<void> {
  const { input, io } = stage
  const { ctx, loopGraph } = input
  const { prDeliveryId } = stage.deliveryState
  // Code-Explorer provenance at settle: diff the worktree against its pre-run
  // snapshot and record file_provenance/story rows (keyed by runId), exactly
  // like QueueManager's post-exit hook. Runs BEFORE commitWorktree so the
  // working tree still carries the run's uncommitted writes; recorded on the
  // failure path too (partial work is still provenance). Never throws.
  const recordProvenance = io.recordProvenance ?? recordLoopRunProvenance
  // Once per run: the .catch below also catches a commitWorktree failure thrown
  // AFTER the .then already recorded — without this guard that run would insert
  // duplicate provenance rows.
  const provenanceRecorded = new Set<string>()
  const recordRunProvenance = async (a: AllocatedRun): Promise<void> => {
    if (provenanceRecorded.has(a.runId)) return
    provenanceRecorded.add(a.runId)
    try {
      const provenanceInput = {
        db: ctx.db,
        projectId: ctx.project.id,
        runId: a.runId,
        ticketId: a.ticketId,
        repoDir: a.handle.worktreePath,
        repositoryId: input.repositoryExecution?.repositoryId,
        snapshot: a.provenanceSnapshot,
        broadcast: (msg: Parameters<typeof ctx.broadcast>[0]) => ctx.broadcast(msg),
      }
      const record = (commit?: ProvenanceCommit) => commit
        ? recordProvenance(provenanceInput, undefined, commit)
        : recordProvenance(provenanceInput)
      if (prDeliveryId && isDefinitionGraph(loopGraph)) await recordIsolatedProvenanceOnce(ctx.db, prDeliveryId, a.runId, record)
      else await record()
    } catch (err) {
      console.warn(`[rail-isolated] provenance recording failed for ${a.runId}: ${errorDetail(err)}`)
    }
  }
  return recordRunProvenance
}

function createWorktreeMarker(ctx: IsolatedLaunchInput['ctx']): MarkWorktree {
  const markWorktree = (a: AllocatedRun, state: 'built' | 'failed' | 'needs-review'): string | null => {
    try {
      return updateRailWorktreeState(ctx.db, a.ledgerId, state)
        ? null
        : `worktree ledger ${a.ledgerId} no longer exists`
    } catch (err) {
      return errorDetail(err)
    }
  }
  return markWorktree
}

/** The context path a definition run was admitted with, or null (never throws). */
function frozenContextPath(db: Parameters<typeof readDefinitionRun>[0], runId: string): string | null {
  try { return readDefinitionRun(db, runId)?.metadata.contextPath ?? null } catch { return null }
}
