// Rail run routes: launch and relaunch (the single admission door for every
// mode, loop, isolation and PR-delivery choice), starting the PR CI loop on a
// rail delivery (which re-enters the launch door with the delivery's frozen
// engine choices) and stopping a rail's jobs and loop runs. launchRail and
// startPrCi share per-router state (prCiLaunches) and so live together.
// launchRail only sequences the door's stages: request and relaunch
// (rail-launch-request), admission, scope and engine (rail-launch-admission),
// loop graph, plan and PR continuation (rail-launch-loop-plan) and the
// isolated, shared-cwd or queue launch (rail-launch-run).

import type { Router, Request, Response } from 'express'
import { isLoopsEnabled, isPrCiLoopEnabled } from '../../../feature-flags'
import { ciFixActiveRepositories, ciFixAllowed } from '../domain/decision-policy'
import { PR_CI_LOOP_ID, supportsPrCi } from '../../loops/runtime/loop-pr-ci-recipe'
import { observePrLifecycle } from './pr-lifecycle'
import { refreshPrCiOffer } from './pr-ci/pr-ci-projection'
import { findActivePrCiAdmissionForPr } from './pr-ci/pr-ci-admission'
import { clearPrCiWorktrees, resettleFailedPrCiRows } from './pr-ci/pr-ci-settlement'
import { defaultExec as prCiExec } from './pr-publisher'
import { getLoopRun } from '../../loops/runtime/loop-runs-store'
import { loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import { getActivePrDeliveryByRail, getPrDelivery, type RailPrDeliveryRow } from './rail-pr-store'
import { defaultGitRunner } from '../../../worktree-manager'
import { listRepositoryDeliveries, refreshRepositoryDeliveryGroup } from './multi-repo-execution'
import type { RailJobStoppedMessage, LoopRunStoppedMessage } from '../../../types'
import { cancelRuntimeContinuation } from '../../agent-runtime/runtime/agent-runtime-controls-router'
import { projectContextOf, requireRailIndexParam, emitPrDeliveryUpdate, engineSupportRejection } from './rails-http-shared'
import { resolveRelaunchSource, parseRailLaunchRequest } from './rail-launch-request'
import { admitRailLaunch, resolveRailLaunchScope, relaunchRepositoryBases, resolveBaseDeliveries, checkRailLaunchCapacity, launchLoopSource, selectBuiltinLaunchLoop, selectLibraryLaunchLoop, resolveRailLaunchEngine, type RailLaunchDoor, type LaunchLoopSelection } from './rail-launch-admission'
import { resolveRailLoopGraph, planRailLoopRun, resolvePrContinuation } from './rail-launch-loop-plan'
import { gateRailLaunchIsolation, launchIsolatedLoopRuns, launchSharedLoopRuns, enqueueRailJob, respondRailLaunchError, type RailLoopTarget } from './rail-launch-run'

export function registerRailLaunchRoutes(router: Router): void {
  const ctx = projectContextOf

  // Both doors share admission checks; Relaunch resolves its original source
  // before interpreting launch options, never the mutable slot's new specs.
  /**
   * Run again a CI loop generation. One that ended as an implementation failure
   * is first re-attached to its OPEN PR (see `resettleFailedPrCiRows`); the
   * loop then starts through the same admission as "Fix CI".
   */
  const relaunchPrCi = async (req: Request, res: Response, source: RailPrDeliveryRow): Promise<void> => {
    const c = ctx(req)
    if (getActivePrDeliveryByRail(c.db, source.rail_index)?.id !== source.id) {
      res.status(409).json({ error: 'pr_delivery_not_active', detail: 'Refresh the mission: a newer delivery owns this rail.' }); return
    }
    if (source.decision === 'implementation_failed' || source.decision === 'pr_failed') {
      const rows = source.execution_manifest ? listRepositoryDeliveries(c.db, source.id).filter(child => child.pr_url) : [source]
      const ok = rows.length > 0 && await resettleFailedPrCiRows({ db: c.db, git: defaultGitRunner, exec: prCiExec, rows, fallbackRepo: c.project.path })
      if (source.execution_manifest) refreshRepositoryDeliveryGroup(c.db, source.id)
      emitPrDeliveryUpdate(c, source.id)
      if (!ok) {
        res.status(409).json({ error: 'pr_ci_relaunch_unavailable',
          detail: 'The pull request is no longer open on the branch this run used, so the CI loop cannot watch it again.',
          action: 'Open the pull request to check its state.' }); return
      }
    }
    req.body = { prDeliveryId: source.id, originConversationId: req.body?.originConversationId, originSurface: req.body?.originSurface }
    await startPrCi(req, res)
  }
  /** Launches admitted by the pr-ci route; the generic door refuses `factory:pr-ci`. */
  const prCiLaunches = new WeakMap<Request, { ticketIds: number[] }>()
  /**
   * The single admission door for every launch (and Relaunch). Stages run in
   * the original order and each answers a refused request itself: relaunch
   * source → request shape → admission → spec/repository scope → bases →
   * capacity → loop recipe → engine → (loop) graph, plan, PR continuation,
   * isolation, isolated or shared-cwd runs | (legacy) queue job. Only the
   * awaits below are taken; a launch that needs none checks in-flight tickets
   * and registers its job or runs in the same tick.
   */
  const launchRail = async (req: Request, res: Response): Promise<void> => {
    const railIndex = requireRailIndexParam(req, res)
    if (railIndex === null) return

    const c = ctx(req)
    const relaunch = resolveRelaunchSource(c, req, res, railIndex, prCiLaunches.has(req))
    if (!relaunch) return
    if (relaunch.kind === 'pr-ci') { await relaunchPrCi(req, res, relaunch.source); return }
    const { relaunchSource } = relaunch

    const launch = parseRailLaunchRequest(c, req, res, relaunchSource, prCiLaunches.has(req))
    if (!launch) return
    const door: RailLaunchDoor = { c, req, res, railIndex, relaunchSource, launch }
    if (!admitRailLaunch(door)) return
    const scope = resolveRailLaunchScope(door, prCiLaunches.get(req)?.ticketIds)
    if (!scope) return
    let repositoryBases = relaunchRepositoryBases(door, scope)
    if (launch.baseDeliveryIds !== undefined) {
      const resolved = await resolveBaseDeliveries(door, scope)
      if (!resolved) return
      repositoryBases = resolved
    }
    const capacity = checkRailLaunchCapacity(door, scope)
    if (!capacity) return
    const { requiresRepositoryIsolation } = capacity

    const loopSource = launchLoopSource(launch.loopId)
    const selection: LaunchLoopSelection = loopSource === 'builtin' ? await selectBuiltinLaunchLoop(c, launch.loopId as string)
      : loopSource === 'library' ? selectLibraryLaunchLoop(c, launch.loopId as string) : {}
    const engine = resolveRailLaunchEngine(door, scope, selection)
    if (!engine) return

    try {
      // Loop mode: run a published loop (the Loops feature) against each spec,
      // one app-driven LoopRun per ticket (mirrors freestyle's per-ticket model).
      // Drives raw prompts via the LoopRunManager — NO queue job, NO slash command.
      // rails-as-loops: a chosen loop (factory OR custom) runs through the
      // LoopRunManager when Loops are enabled, using the current factory graph.
      // Implement/batch delegate their complete cycle to Core. (Loops off / no loopId → the legacy
      // bare-mode QueueManager path below; `mode` is the derived factory mode.)
      if (isLoopsEnabled() && typeof launch.loopId === 'string' && launch.loopId) {
        const loopId = launch.loopId
        const graph = resolveRailLoopGraph(door, loopId, selection)
        if (!graph) return
        if (graph.checkEngineSupport) {
          const rejection = await engineSupportRejection(c.loopRunManager, graph.loopGraph, loopId)
          if (rejection) { res.status(409).json(rejection); return }
        }
        const target: RailLoopTarget = { loopId, loopName: graph.loopName, loopGraph: graph.loopGraph }
        const plan = planRailLoopRun(door, scope, engine, target.loopGraph)
        if (!plan) return
        const continuation = resolvePrContinuation(door, scope)
        if (!continuation) return
        const isolation = gateRailLaunchIsolation(door, scope, requiresRepositoryIsolation, target, plan, continuation)
        if (!isolation) return
        let isolationUnavailable: string | undefined
        if (isolation.useIsolation) {
          const fallback = await launchIsolatedLoopRuns(door, scope, requiresRepositoryIsolation, repositoryBases, engine, target, plan, continuation)
          if (!fallback) return
          isolationUnavailable = fallback.isolationUnavailable
        }
        await launchSharedLoopRuns(door, scope, engine, target, plan, isolationUnavailable)
        return
      }

      // A custom-loop launch (mode='loop') with no loopId is invalid — there is
      // no factory loop to fall back to (only implement/batch do).
      if (launch.mode === 'loop') {
        res.status(400).json({ error: 'loopId is required for loop mode' }); return
      }

      enqueueRailJob(door, scope, engine)
    } catch (err) {
      respondRailLaunchError(err, res)
    }
  }
  router.post(['/:railIndex/launch', '/:railIndex/relaunch'], launchRail)

  // PR CI loop (pr-ci-loop): "Watch and fix the PR's CI" on an attached PR. The
  // launch reuses the ordinary continuation admission (a new generation on the
  // PR branch supersedes the current one, rolled back atomically on allocation
  // failure) with the delivery's frozen engine, model and profile.
  const startPrCi = async (req: Request, res: Response): Promise<void> => {
    if (!isPrCiLoopEnabled()) { res.status(403).json({ error: 'pr_ci_disabled', detail: 'The PR CI loop is turned off (SPECRAILS_PR_CI_LOOP=false)' }); return }
    const railIndex = requireRailIndexParam(req, res)
    if (railIndex === null) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const { prDeliveryId, originConversationId, originSurface } = body
    if (typeof prDeliveryId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(prDeliveryId)) { res.status(400).json({ error: 'invalid_pr_delivery_id' }); return }
    if (!isLoopsEnabled() || !isRailPrDeliveryEnabled()) { res.status(409).json({ error: 'pr_ci_requires_pr_mode', detail: 'The PR CI loop needs Loops and PR delivery' }); return }
    let capabilities: Record<string, number> | undefined
    try { capabilities = (await loadCoreAgentRuntime()).api?.capabilities } catch { /* unsupported below */ }
    if (!supportsPrCi(capabilities)) { res.status(409).json({ error: 'engine_unsupported', detail: 'Update Core to run the PR CI loop (host tasks).' }); return }
    const c = ctx(req)
    const row = getPrDelivery(c.db, prDeliveryId)
    if (!row || row.rail_index !== railIndex) { res.status(404).json({ error: 'pr_delivery_not_found' }); return }
    if (getActivePrDeliveryByRail(c.db, railIndex)?.id !== row.id) { res.status(409).json({ error: 'pr_delivery_not_active', detail: 'Refresh the mission: a newer delivery owns this rail.' }); return }
    // A multi-repository generation has one PR per repository delivery (child rows).
    const repositoryRows = row.execution_manifest ? listRepositoryDeliveries(c.db, row.id) : null
    if (!ciFixAllowed({ ...row, repositories: repositoryRows })) {
      const busy = row.operation || repositoryRows?.some(child => child.operation)
      res.status(409).json({ error: busy ? 'pr_operation_in_progress' : 'pr_ci_not_allowed', decision: row.decision,
        detail: busy ? 'Another action on this pull request is still running.' : 'Only open pull requests awaiting your decision can be watched; every repository under review needs its pull request.' }); return
    }
    // Every watched PR must be OPEN and from this repository before anything is allocated.
    const watched = repositoryRows
      ? ciFixActiveRepositories(repositoryRows).map(child => ({ prUrl: child.pr_url!, cwd: child.repository_path ?? c.project.path }))
      : [{ prUrl: row.pr_url!, cwd: c.project.path }]
    for (const pr of watched) {
      const lifecycle = await observePrLifecycle(prCiExec, pr.cwd, pr.prUrl)
      if (!lifecycle.ok) { res.status(409).json({ error: 'pr_unverifiable', prUrl: pr.prUrl, detail: lifecycle.detail }); return }
      if (lifecycle.isCrossRepository !== false) { res.status(409).json({ error: 'pr_fork_unsupported', prUrl: pr.prUrl, detail: 'Pull requests from forks are not supported.' }); return }
      if (lifecycle.state !== 'OPEN') { res.status(409).json({ error: 'pr_not_open', prUrl: pr.prUrl, state: lifecycle.state, detail: `The pull request ${pr.prUrl} is ${lifecycle.state.toLowerCase()}.` }); return }
      // One writer per PR: a mission-origin run on it blocks this start (and vice versa).
      const missionRun = findActivePrCiAdmissionForPr(c.db, c.project.id, pr.prUrl)
      if (missionRun) { res.status(409).json({ error: 'pr_ci_run_active', prUrl: pr.prUrl, runId: missionRun.run_id, detail: 'A CI repair started from a mission is already running on this pull request.' }); return }
    }
    // A stopped loop may have left uncommitted edits in the PR worktree: set them
    // aside on a delivery ref so the new loop starts clean at the PR head.
    if (!await clearPrCiWorktrees(c.db, defaultGitRunner, repositoryRows ? ciFixActiveRepositories(repositoryRows) : [row])) {
      res.status(409).json({ error: 'pr_worktree_dirty', detail: 'The PR worktree has uncommitted changes that could not be set aside safely.', action: 'Open the worktree and commit or discard the changes.' }); return
    }
    let frozen: Record<string, unknown> = {}
    try { frozen = row.launch_config_json ? JSON.parse(row.launch_config_json) as Record<string, unknown> : {} } catch { /* defaults below */ }
    // Only the admitted engine choices of the original launch: never its loop, PR target or follow-up.
    const pick = (key: string) => frozen[key] === undefined ? {} : { [key]: frozen[key] }
    req.body = {
      ...pick('aiEngine'), ...pick('model'), ...pick('reasoning_effort'), ...pick('profileName'), ...pick('runtimeProviderOverride'), ...pick('repositoryIds'), ...pick('workspaceSelection'),
      mode: 'loop', loopId: PR_CI_LOOP_ID,
      originConversationId: typeof originConversationId === 'string' ? originConversationId : row.origin_conversation_id ?? undefined,
      originSurface: originSurface === 'dashboard' || originSurface === 'agent-chat' ? originSurface : row.origin_surface,
    }
    let ticketIds: number[] = []
    try { ticketIds = (JSON.parse(row.ticket_ids) as unknown[]).filter((id): id is number => Number.isSafeInteger(id) && (id as number) > 0) } catch { /* validated by the launch */ }
    prCiLaunches.set(req, { ticketIds })
    await launchRail(req, res)
    // The new generation is `building`: the offer row of the replaced one shows "started".
    if (res.statusCode === 202) {
      const next = getActivePrDeliveryByRail(c.db, railIndex)
      if (next && next.id !== row.id) refreshPrCiOffer(c, next.id)
    }
  }
  router.post('/:railIndex/pr-ci', startPrCi)

  // POST /rails/:railIndex/stop — kill the running job for a rail
  router.post('/:railIndex/stop', (req: Request, res: Response) => {
    const railIndex = requireRailIndexParam(req, res)
    if (railIndex === null) return

    const c = ctx(req)

    // M19: a rail may register several queue jobs (one per ticket in older runs). The old code
    // stopped only the FIRST matching job, so the remaining N-1 jobs kept running
    // and billing while the UI showed the rail stopped. Collect ALL jobs for this
    // rail index and cancel each (running → kill, queued → cancel).
    const targetJobIds = Array.from(c.railJobs.entries())
      .filter(([, meta]) => meta.railIndex === railIndex)
      .map(([jobId]) => jobId)
    const targetLoopRunIds = Array.from(c.railLoopRuns.entries())
      .filter(([, meta]) => meta.railIndex === railIndex)
      .map(([runId]) => runId)

    if (targetJobIds.length === 0 && targetLoopRunIds.length === 0) {
      res.status(404).json({ error: 'No active rail job found for this rail' }); return
    }

    let canceledCount = 0
    for (const jobId of targetJobIds) {
      try {
        c.queueManager.cancel(jobId)
        canceledCount++
      } catch (err) {
        // Already terminal / unknown — clean up the stale entry regardless so the
        // rail card can't get wedged 'running' (this was the unrecoverable case).
        console.warn(`[rails-router] stop: cancel(${jobId}) failed: ${(err as Error).message}`)
      }
      c.railJobs.delete(jobId)
    }

    // Broadcast one stop per job so every rail card reconciles.
    for (const jobId of targetJobIds) {
      const stopMsg: RailJobStoppedMessage = {
        type: 'rail.job_stopped',
        projectId: c.project.id,
        railIndex,
        jobId,
      }
      c.broadcast(stopMsg)
    }

    // Loop runs (Loops mode): request cancellation. The engine settles 'stopped'
    // at the next node boundary and onLoopRunFinished releases the rail's tickets
    // (so we deliberately do NOT delete railLoopRuns here).
    for (const runId of targetLoopRunIds) {
      try {
        if (!cancelRuntimeContinuation(c, runId)) c.loopRunManager.cancel(runId)
        canceledCount++
      } catch (err) {
        console.warn(`[rails-router] stop: loop cancel(${runId}) failed: ${(err as Error).message}`)
      }
      // A run the engine no longer owns (reconciled as an orphan by a context
      // reload while still alive) never settles through onLoopRunFinished, so
      // its rail entry would pin the tickets "in flight" forever. When the
      // durable row is already terminal, release the entry here.
      const row = getLoopRun(c.db, runId)
      if (!row || row.status === 'completed') c.railLoopRuns.delete(runId)
      const stopMsg: LoopRunStoppedMessage = {
        type: 'loop.run_stopped',
        projectId: c.project.id,
        loopRunId: runId,
        railIndex,
      }
      c.broadcast(stopMsg)
    }

    res.json({ ok: true, jobIds: targetJobIds, loopRunIds: targetLoopRunIds, canceled: canceledCount })
  })
}
