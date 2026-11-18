// Rail launch door, run stages: the isolation gate, the isolated (worktree +
// PR delivery) launch, the shared-cwd loop runs with their provenance and
// mission cards, the legacy queue job, and the launch error mapping. Each
// stage answers the request; the isolated stage alone may instead return
// the reason isolation is unavailable so the caller falls back to shared cwd.

import type { Response } from 'express'
import { setRailTickets, getRail } from './rails-store'
import { ClaudeNotFoundError, CodexNotFoundError } from '../../execution/runtime/queue-manager'
import { isLoopsEnabled, isCodeExplorerEnabled } from '../../../feature-flags'
import { snapshotWorkingTree, type WorkingTreeSnapshot } from '../../code/runtime/file-provenance'
import { recordLoopRunProvenance } from '../../code/runtime/file-story'
import { loadConstantMap } from '../../loops/runtime/loop-constants'
import type { LoopGraph } from '../../loops/runtime/loop-graph'
import { classifyLoopEffect } from '../../loops/runtime/loop-effect'
import { isolationApplies, isRailPrDeliveryEnabled } from './rail-isolation'
import { getActivePrDeliveryByRail, PrDeliveryGenerationConflict, type PrDecision } from './rail-pr-store'
import { ExplicitPrTargetError } from './active-pr-continuation'
import { launchIsolatedRail, PrContinuationIsolationError } from './rail-isolated-launch'
import { RepositoryHasNoCommitsError } from './isolated-worktree'
import { IntentWorktreeMismatchError } from './flow-worktree-handoff'
import { restoreRelaunchRail, RailRelaunchError } from './rail-relaunch'
import { repoIsolationStatus, defaultGitRunner } from '../../../worktree-manager'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { newId } from '../../../ids'
import { postRunCard, settleRunCard, notifyMissionRunFailure, failureForLoopOutcome } from '../../missions/runtime/mission-run-notify'
import { runtimeRunSummary } from '../../agent-runtime/runtime/agent-runtime-controls-router'
import { broadcastSpecAddendaChange, claimSpecAddendaForRun, ticketStorePathForProject } from '../../specs/runtime/spec-addenda'
import type { RailJobStartedMessage } from '../../../types'
import { broadcastRailUpdated, recommendedLoopForRail } from './rails-http-shared'
import { prDeliveryContinuesTickets } from './rail-delivery-revision'
import type { RailLaunchDoor, RailLaunchEngine, RailLaunchScope, RepositoryBases } from './rail-launch-admission'
import type { RailLoopRunPlan, RailPrContinuation } from './rail-launch-loop-plan'

/** The loop to run, as resolved by the graph stage. */
export interface RailLoopTarget {
  loopId: string
  loopName: string
  loopGraph: LoopGraph
}

/** Isolation stage: derives read-only vs mutating from the loop's nodes and
 *  refuses launches whose contract needs a worktree this one would not get. */
export function gateRailLaunchIsolation(
  door: RailLaunchDoor, scope: RailLaunchScope, requiresRepositoryIsolation: boolean,
  target: RailLoopTarget, plan: RailLoopRunPlan, continuation: RailPrContinuation,
): { useIsolation: boolean } | null {
  const { res, relaunchSource } = door
  const { targetPrNumber, baseBranch, flowWorktree } = door.launch
  const { rail, repositoryIds } = scope
  const { ticketScope } = plan
  const { continuablePrDelivery } = continuation
  // Parallel isolation (default-on; disable with SPECRAILS_RAIL_WORKTREES=0):
  // a per-ticket rail on a repo-mutating loop runs each ticket in its own git
  // worktree, then merges the branches back. A non-git repo or an unborn
  // HEAD uses the explicit shared-cwd fallback; an operational allocation
  // failure aborts rather than moving execution into the active checkout.
  // Read-only vs mutating is DERIVED from the loop's nodes (see loop-effect),
  // not a user flag — a content-read-only loop (no ai-step/shell) never writes,
  // so it is not isolated; anything that can write is.
  const loopReadOnly = classifyLoopEffect(target.loopGraph) === 'read-only'
  const useIsolation = isolationApplies({
    loopsEnabled: isLoopsEnabled(), scope: ticketScope, ticketCount: rail.ticketIds.length, readOnly: loopReadOnly,
  })
  if (requiresRepositoryIsolation && !useIsolation) {
    res.status(409).json({ error: 'repository_isolation_required', detail: 'Selected repositories require worktree isolation for this loop.' }); return null
  }
  // An Intent session runs in exactly its own repository: the primary (no group), or
  // the one non-primary member its worktree belongs to.
  const flowRepositoryScope = !flowWorktree ? true : flowWorktree.repositoryId
    ? repositoryIds.length === 1 && repositoryIds[0] === flowWorktree.repositoryId
    : !requiresRepositoryIsolation
  if (flowWorktree && (!useIsolation || !flowRepositoryScope)) {
    res.status(409).json({ error: 'flow_requires_isolation', detail: 'An Intent session hand-off runs only on its own worktree, in the repository it belongs to.' }); return null
  }
  if (relaunchSource?.delivery && !useIsolation) {
    res.status(409).json({ error: 'relaunch_isolation_required', detail: 'The original attempt was isolated; its retry must also use an isolated worktree.',
      action: 'Restore worktree isolation and the original workflow before retrying.' }); return null
  }
  if (typeof targetPrNumber === 'number' && !useIsolation) {
    res.status(400).json({ error: 'target_pr_requires_pr_mode', detail: 'targetPrNumber requires an isolated (worktree) launch; this launch would run in the shared checkout' }); return null
  }
  if (baseBranch && !useIsolation) {
    res.status(400).json({ error: 'base_branch_requires_isolation', detail: 'baseBranch requires an isolated (worktree) launch; this launch would run in the shared checkout' }); return null
  }
  if (continuablePrDelivery && !loopReadOnly && !useIsolation) {
    res.status(409).json({
      error: 'pr_continuation_isolation_required',
      detail: `Cannot continue PR branch ${continuablePrDelivery.branch} while worktree isolation is disabled.`,
      action: 'Enable rail worktrees and retry; PR continuations never run in the shared project checkout.',
    })
    return null
  }
  return { useIsolation }
}

/**
 * Isolated stage: probes the repository, restores a relaunch's specs (and a
 * CI loop's released specs) on the rail, then hands the launch to
 * `launchIsolatedRail` with its continuation contract. Answers the request,
 * returning null, except when isolation is unavailable for a launch that may
 * fall back to shared cwd: then it returns that status.
 */
export async function launchIsolatedLoopRuns(
  door: RailLaunchDoor, scope: RailLaunchScope, requiresRepositoryIsolation: boolean,
  repositoryBases: RepositoryBases | undefined, engine: RailLaunchEngine,
  target: RailLoopTarget, plan: RailLoopRunPlan, continuation: RailPrContinuation,
): Promise<{ isolationUnavailable: string } | null> {
  const { c, res, railIndex, relaunchSource, launch } = door
  const { mode, runtimeProviderOverride, baseBranch, targetPrNumber, followUp, flowWorktree, runCapUsd, originSurface, originConversationId } = launch
  const { rail, storedRail, prCiTickets, repositoryIds, workspaceSelection } = scope
  const { resolvedProfile } = engine
  const { loopId, loopName, loopGraph } = target
  const { launchConfig, loopProvider, loopModel, effort, ticketScope, deciderEngine } = plan
  const { continuablePrDelivery, revisionRequest, retryOfDelivery } = continuation
  // Worktree isolation needs a git repo WITH at least one commit (an
  // unborn HEAD can't be branched). Fall back (with a message) otherwise.
  const status = requiresRepositoryIsolation ? 'ok' : await repoIsolationStatus(defaultGitRunner, c.project.path)
  if (status !== 'ok') {
    if (flowWorktree) {
      res.status(409).json({ error: 'flow_requires_isolation', detail: `worktree isolation is unavailable (${status})` }); return null
    }
    if (baseBranch) {
      res.status(400).json({ error: 'base_branch_requires_isolation', detail: `baseBranch requires worktree isolation, which is unavailable (${status})` }); return null
    }
    if (typeof targetPrNumber === 'number') {
      res.status(400).json({
        error: 'target_pr_requires_pr_mode',
        detail: `targetPrNumber requires worktree isolation, which is unavailable (${status})`,
      })
      return null
    }
    if (continuablePrDelivery) {
      res.status(409).json({
        error: 'pr_continuation_isolation_required',
        detail: `Cannot continue PR branch ${continuablePrDelivery.branch} because worktree isolation is unavailable (${status}).`,
        action: 'Restore a git repository with a committed HEAD, ensure the PR branch is free for a dedicated worktree, then retry.',
      })
      return null
    }
    const isolationUnavailable = status // 'no-git' | 'no-commits'
    console.warn(`[rails-router] worktree isolation unavailable (${status}); running shared cwd`)
    return { isolationUnavailable }
  }
  if (baseBranch) {
    // Must resolve as a LOCAL branch — a chain never stacks on a guess.
    const verify = await defaultGitRunner.run(['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`], c.project.path)
    if (verify.code !== 0) {
      res.status(400).json({ error: 'invalid_base_branch', detail: `branch ${baseBranch} does not resolve locally` }); return null
    }
  }
  try {
    if (relaunchSource && restoreRelaunchRail(c, railIndex, relaunchSource)) broadcastRailUpdated(c, railIndex, 'tickets')
    // pr-ci-loop: the rail owns the continued specs again while the loop runs.
    if (prCiTickets?.length && getRail(c.db, railIndex).ticketIds.length === 0) {
      setRailTickets(c.db, railIndex, [...prCiTickets], storedRail.mode ?? 'implement', storedRail.profileName ?? null, storedRail.aiEngine ?? null)
      broadcastRailUpdated(c, railIndex, 'tickets')
    }
    const ids = await launchIsolatedRail({
      launchConfig,
      loopChoice: { recommendedLoop: recommendedLoopForRail(c, rail.ticketIds), chosenLoop: loopId },
      runtimeProviderOverride,
      ctx: c, railIndex, ticketIds: [...rail.ticketIds], repositoryIds, workspaceSelection, ...repositoryBases, loopId, loopName, loopGraph,
      provider: loopProvider, model: loopModel, effort, scope: ticketScope,
      ...(deciderEngine ? { deciderEngine } : {}),
      profileName: resolvedProfile,
      ...(runCapUsd !== undefined ? { runCapUsd } : {}),
      originSurface: originSurface ?? 'dashboard',
      originConversationId: originConversationId ?? null,
      ...(baseBranch ? { baseBranch } : {}),
      ...(continuablePrDelivery?.executionManifest && !revisionRequest && !retryOfDelivery ? { repositoryContinuation: { deliveryId: continuablePrDelivery.id, decision: continuablePrDelivery.decision as PrDecision } } : {}),
      ...(continuablePrDelivery && !continuablePrDelivery.executionManifest && prDeliveryContinuesTickets(continuablePrDelivery, rail.ticketIds) ? {
        requiredPrContinuation: {
          deliveryId: continuablePrDelivery.id,
          decision: continuablePrDelivery.decision as 'pr_draft' | 'pr_ready',
          branch: continuablePrDelivery.branch!,
          baseBranch: continuablePrDelivery.baseBranch,
          prUrl: continuablePrDelivery.prUrl!,
          prNumber: continuablePrDelivery.prNumber,
          deliverySha: continuablePrDelivery.deliverySha!,
        },
      } : {}),
      // Explicit target only drives fresh launches; when the slot has
      // a continuable delivery for the same PR, the continuation
      // contract above is the (stricter) authority.
      ...(typeof targetPrNumber === 'number' && (!continuablePrDelivery || retryOfDelivery)
        ? { explicitPrTarget: { prNumber: targetPrNumber } }
        : {}),
      // Revision of an undecided delivery: the guard above proved the
      // exemption, so pass the contract through for supersession.
      ...(revisionRequest ? { revision: revisionRequest } : {}),
      ...(retryOfDelivery ? { retryOfDelivery } : {}),
      ...(followUp ? { followUp } : {}),
      ...(flowWorktree ? { requiredFlowWorktree: flowWorktree } : {}),
    })
    res.status(202).json({ loopRunIds: ids, railIndex, mode, loopId, prDeliveryId: getActivePrDeliveryByRail(c.db, railIndex)?.id ?? null, isolated: true, ...(followUp ? { followUp: { id: followUp.id, version: followUp.version, hash: followUp.hash } } : {}) })
    return null
  } catch (err) {
    if (err instanceof RailRelaunchError) {
      res.status(409).json({ error: err.code, detail: err.message, action: err.action }); return null
    }
    if (err instanceof PrDeliveryGenerationConflict) {
      res.status(409).json({
        error: 'pr_delivery_generation_conflict',
        prDeliveryId: err.currentId,
      })
      return null
    }
    // Explicit-target validation failures are the USER's answer being
    // unusable — fail closed with the machine-readable code; never
    // fall back to a fresh shared-cwd run next to the designated PR.
    if (err instanceof RepositoryHasNoCommitsError) {
      res.status(409).json({ error: err.code, detail: err.message }); return null
    }
    if (err instanceof IntentWorktreeMismatchError) {
      res.status(409).json({ error: err.code, detail: err.message }); return null
    }
    if (err instanceof ExplicitPrTargetError) {
      res.status(err.code === 'target_pr_not_found' ? 404 : 409).json({
        error: err.code,
        detail: err.message,
      })
      return null
    }
    if ((continuablePrDelivery && !retryOfDelivery) || err instanceof PrContinuationIsolationError) {
      const detail = err instanceof Error ? err.message : String(err)
      res.status(409).json({
        error: 'pr_continuation_isolation_required',
        detail,
        action: 'Ensure the PR branch is available for a dedicated git worktree, then retry.',
      })
      return null
    }
    console.error('[rails-router] isolated launch failed:', err)
    res.status(409).json({
      error: 'isolation_failed',
      detail: err instanceof Error ? err.message : String(err),
      action: 'Resolve the worktree allocation error and retry the rail launch.',
    })
    return null
  }
}

/**
 * Shared-cwd stage: restores a relaunch's specs, snapshots the repository
 * once for Code-Explorer provenance, then starts one LoopRun over all specs
 * (`all` scope) or one per spec. Each run claims its spec addenda, posts its
 * mission run card and, at settle, records provenance BEFORE
 * `onLoopRunFinished`.
 */
export async function launchSharedLoopRuns(
  door: RailLaunchDoor, scope: RailLaunchScope, engine: RailLaunchEngine,
  target: RailLoopTarget, plan: RailLoopRunPlan, isolationUnavailable: string | undefined,
): Promise<void> {
  const { c, res, railIndex, relaunchSource, launch } = door
  const { mode, runtimeProviderOverride, originConversationId, runCapUsd } = launch
  const { rail, primaryRepository, workspaceSelection } = scope
  const { resolvedProfile } = engine
  const { loopId, loopName, loopGraph } = target
  const { launchConfig, loopProvider, loopModel, effort, ticketScope, deciderEngine } = plan
  // Spawn from the SAME cwd a rail uses (workspace when relocated, else the
  // repo) so native `{{cmd:*}}` slash commands resolve — and surface the repo
  // via SPECRAILS_REPO_DIR + `--add-dir` exactly like QueueManager.
  if (relaunchSource && restoreRelaunchRail(c, railIndex, relaunchSource)) broadcastRailUpdated(c, railIndex, 'tickets')
  const loopExec = resolveProjectExecution({ slug: c.project.slug, path: c.project.path })
  const loopRunIds: string[] = []
  const loopTicketCompletionStatus = isRailPrDeliveryEnabled() ? 'on_review' as const : 'done' as const
  const addendaStorePath = ticketStorePathForProject(c.project)
  // Code-Explorer provenance for shared-cwd loop runs (isolated runs
  // record inside rail-isolated-launch): snapshot the REPO once, before
  // any run of this launch starts (every run shares the same pre-launch
  // tree), then diff + record at each run's settle. The snapshot is an
  // async git capture awaited here — never on the event loop — and still
  // completes before the first engine step can write. Best-effort; diffs
  // the repo (never the workspace) exactly like QueueManager.
  const provenanceRepoDir = loopExec.relocated && loopExec.repoDir ? loopExec.repoDir : loopExec.cwd
  let launchProvenanceSnapshot: WorkingTreeSnapshot | null = null
  if (isCodeExplorerEnabled()) {
    try { launchProvenanceSnapshot = await snapshotWorkingTree(provenanceRepoDir) } catch (err) {
      console.warn(`[rails-router] provenance snapshot failed: ${(err as Error).message}`)
    }
  }
  const launchLoopRun = (runId: string, ticketIds: number[], spec: ReturnType<typeof c.getTicketSpec>) => {
    c.railLoopRuns.set(runId, { railIndex, ticketIds, requiresTerminalIntent: true, ...(originConversationId ? { originConversationId } : {}) })
    // Spec addenda (spec-addenda): claim the specs' open addenda for this
    // run and brief every AI step with them (same slot as a follow-up).
    const claimedAddenda = claimSpecAddendaForRun(addendaStorePath, ticketIds, runId)
    broadcastSpecAddendaChange((msg) => c.broadcast(msg as never), c.project.id, claimedAddenda)
    // mission-rail-cards: a shared-cwd run has no delivery row, so the
    // origin mission gets a run card keyed on the run id instead.
    const runCard = { projectId: c.project.id, runId, railIndex, railName: rail.name ?? null, ticketIds }
    postRunCard(originConversationId ?? null, runCard)
    const settleMissionCard = (outcome: string, stallReason?: string | null, detail?: string | null): void => {
      if (!originConversationId) return
      void (async () => {
        const summary = await runtimeRunSummary(c, runId).catch(() => null)
        const failure = failureForLoopOutcome(outcome, stallReason, detail)
        if (!failure) { settleRunCard(originConversationId, runCard, outcome, summary); return }
        await notifyMissionRunFailure({
          ...runCard, originConversationId, failure, summary, hasDelivery: false,
          tickets: ticketIds.map((id) => ({ id, title: c.getTicketSpec(id)?.title ?? null })),
        })
      })().catch((err) => console.error('[rails-router] mission card settle failed:', err))
    }
    // Loop runs settle outside QueueManager, so without this they leave
    // no file_provenance at all. Recorded BEFORE onLoopRunFinished.
    const provenanceSnapshot = launchProvenanceSnapshot
    let provenanceRecorded = false
    const recordRunProvenance = async (): Promise<void> => {
      if (provenanceRecorded) return
      provenanceRecorded = true
      await recordLoopRunProvenance({
        db: c.db,
        projectId: c.project.id,
        runId,
        ticketId: ticketIds[0] ?? null,
        repoDir: provenanceRepoDir,
        snapshot: provenanceSnapshot,
        broadcast: (msg) => c.broadcast(msg),
      })
    }
    const runPromise = c.loopRunManager
      .run({
        launchConfig,
        runtimeProviderOverride,
        runId,
        loopId,
        loopName,
        graph: loopGraph,
        projectId: c.project.id,
        repositoryId: primaryRepository.id,
        workspacePaths: workspaceSelection?.[primaryRepository.id],
        cwd: loopExec.cwd,
        repoDir: loopExec.relocated ? loopExec.repoDir : undefined,
        railIndex,
        ticketId: ticketIds[0],
        spec: {
          ...spec,
          ticketIds,
          ...(ticketIds.length > 1 ? {
            tickets: ticketIds.map((id) => {
              const ticket = c.getTicketSpec(id)
              return { id, title: ticket?.title, description: ticket?.description }
            }),
          } : {}),
        },
        ticketCompletionStatus: loopTicketCompletionStatus,
        constants: loadConstantMap(c.desktopDb),
        provider: loopProvider,
        model: loopModel,
        effort,
        ...(deciderEngine ? { deciderEngine } : {}),
        profileName: resolvedProfile,
        ...(runCapUsd !== undefined ? { runCapUsd } : {}),
        ...(claimedAddenda.briefing ? { addenda: { ids: claimedAddenda.snapshot.map((e) => e.id), briefing: claimedAddenda.briefing } } : {}),
      })
      .then(async (r) => {
        await recordRunProvenance()
        c.onLoopRunFinished(r.runId, r.outcome, r.stallReason ? { stallReason: r.stallReason } : undefined)
        settleMissionCard(r.outcome, r.stallReason ?? null)
        return r.outcome === 'success'
      })
      .catch(async (err) => {
        console.error('[rails-router] loop run failed:', err)
        await recordRunProvenance()
        c.onLoopRunFinished(runId, 'failed')
        settleMissionCard('failed', null, err instanceof Error ? err.message : String(err))
        return false
      })
    void runPromise
    loopRunIds.push(runId)
    try { c.jiraSyncManager.onRailLaunch(ticketIds, runId) } catch { /* non-fatal */ }
  }
  if (ticketScope === 'all') {
    // ONE run over ALL the rail's tickets ({{spec.ids}} = #1 #2 #3).
    const allIds = [...rail.ticketIds]
    launchLoopRun(newId(), allIds, c.getTicketSpec(allIds[0]))
  } else {
    // One run per ticket.
    for (const ticketId of rail.ticketIds) {
      launchLoopRun(newId(), [ticketId], c.getTicketSpec(ticketId))
    }
  }
  res.status(202).json({
    loopRunIds, runIds: loopRunIds, railIndex, mode,
    ...(isolationUnavailable ? { isolationUnavailable } : {}),
  })
}

/** Legacy queue stage (Loops off / no loop): one implement job carrying every
 *  spec, registered on the rail before `rail.job_started` is broadcast. */
export function enqueueRailJob(door: RailLaunchDoor, scope: RailLaunchScope, engine: RailLaunchEngine): void {
  const { c, res, railIndex } = door
  const { mode } = door.launch
  const { rail } = scope
  const { resolvedProfile, railProvider } = engine
  let jobId: string

  // Implement creates a single job with all ticket IDs (the removed Batch
  // mode is normalized to implement above).
  const issueArgs = rail.ticketIds.map((id) => `#${id}`).join(' ')
  const command = `/specrails:implement ${issueArgs} --yes`
  const job = c.queueManager.enqueue(command, 'normal', { profileName: resolvedProfile, provider: railProvider })
  jobId = job.id
  c.railJobs.set(jobId, { railIndex, mode, ticketIds: [...rail.ticketIds] })
  broadcastSpecAddendaChange((msg) => c.broadcast(msg as never), c.project.id, claimSpecAddendaForRun(ticketStorePathForProject(c.project), [...rail.ticketIds], jobId))
  // Jira write-back: push In Progress for any Jira-linked ticket (inert for
  // non-Jira projects). Best-effort — never blocks the launch.
  try { c.jiraSyncManager.onRailLaunch([...rail.ticketIds], jobId) } catch { /* non-fatal */ }

  const startMsg: RailJobStartedMessage = {
    type: 'rail.job_started',
    projectId: c.project.id,
    railIndex,
    jobId,
    mode,
  }
  c.broadcast(startMsg)

  res.status(202).json({ jobId, railIndex, mode })
}

/** Maps an error thrown by a run stage to the launch door's response. */
export function respondRailLaunchError(err: unknown, res: Response): void {
  if (err instanceof RailRelaunchError) {
    res.status(409).json({ error: err.code, detail: err.message, action: err.action }); return
  }
  if (err instanceof ClaudeNotFoundError) {
    res.status(503).json({ error: 'Claude CLI not found' }); return
  }
  if (err instanceof CodexNotFoundError) {
    res.status(503).json({ error: 'Codex CLI not found' }); return
  }
  console.error('[rails-router] launch error:', err)
  res.status(500).json({ error: 'Failed to launch rail job' })
}
