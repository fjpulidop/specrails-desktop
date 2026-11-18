// Rail run routes: launch and relaunch (the single admission door for every
// mode, loop, isolation and PR-delivery choice), starting the PR CI loop on a
// rail delivery (which re-enters the launch door with the delivery's frozen
// engine choices) and stopping a rail's jobs and loop runs. launchRail and
// startPrCi share per-router state (prCiLaunches) and so live together.

import { FollowUpValidationError, freezeFollowUp, parseFollowUpInput, type PrFollowUp } from './pr-follow-up'
import { validateRuntimeProviderOverride } from '../../agent-runtime/runtime/agent-runtime-settings'
import type { Router, Request, Response } from 'express'
import { getRail, setRailTickets, MAX_TICKETS_PER_RAIL_LAUNCH } from './rails-store'
import { ClaudeNotFoundError, CodexNotFoundError } from '../../execution/runtime/queue-manager'
import { validateRequestedProvider } from '../../../provider-selection'
import { isLoopsEnabled, isCodeExplorerEnabled, areDeliveryRevisionsEnabled, isPrCiLoopEnabled } from '../../../feature-flags'
import { ciFixActiveRepositories, ciFixAllowed } from '../domain/decision-policy'
import { PR_CI_LOOP_ID, supportsPrCi } from '../../loops/runtime/loop-pr-ci-recipe'
import { observePrLifecycle } from './pr-lifecycle'
import { refreshPrCiOffer } from './pr-ci/pr-ci-projection'
import { findActivePrCiAdmissionForPr } from './pr-ci/pr-ci-admission'
import { clearPrCiWorktrees, resettleFailedPrCiRows } from './pr-ci/pr-ci-settlement'
import type { RailPrDeliveryRow } from './rail-pr-store'
import { defaultExec as prCiExec } from './pr-publisher'
import { snapshotWorkingTree, type WorkingTreeSnapshot } from '../../code/runtime/file-provenance'
import { recordLoopRunProvenance } from '../../code/runtime/file-story'
import { getLoop } from '../../loops/runtime/loops-store'
import { getLoopRun } from '../../loops/runtime/loop-runs-store'
import { hasAdapter, isLocalAdapterId } from '../../../providers/registry'
import { getAdapter, reasoningEffortsForModel, supportsToolPolicy } from '../../../providers'
import { ROLES_ENGINE, loadLoopRoleEngines, resolveLoopRoleEngine } from '../../loops/runtime/loop-role-engines'
import { isReasoningEffortValidForModel } from '../../../providers/runtime'
import { resolveAgentDefaults } from '../../agents/runtime/agent-defaults'
import { resolveProfile } from '../../agents/runtime/profile-manager'
import { isValidModelForProvider, getModelsForProvider, type SpecProvider } from '../../specs/runtime/spec-models'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'
import { isFactoryLoopId, isRetiredFactoryLoopId, factoryLoopMode, canonicalFactoryLoopId, factoryLoopForMode, FLOW_SPEC_LOOP_ID, RETIRED_FACTORY_REPLACEMENT_ID } from '../../loops/runtime/loop-factory'
import { resolveBuiltinLoop } from '../../loops/runtime/builtin-loops'
import { loadConstantMap } from '../../loops/runtime/loop-constants'
import { dominantTicketScope, referencesUnsupportedProviderCommand } from '../../loops/runtime/loop-command-catalog'
import { loopNeedsTicket, validateLoopGraph, type LoopGraph } from '../../loops/runtime/loop-graph'
import { isolationApplies, isRailPrDeliveryEnabled } from './rail-isolation'
import { getActivePrDeliveryByRail, getPrDelivery, toPrDeliverySnapshot, transitionDecision, PrDeliveryGenerationConflict, type PrDecision, type PrDeliverySnapshot, isPreparationFailureRow } from './rail-pr-store'
import { classifyLoopEffect } from '../../loops/runtime/loop-effect'
import { ExplicitPrTargetError } from './active-pr-continuation'
import { launchIsolatedRail, PrContinuationIsolationError } from './rail-isolated-launch'
import { RepositoryHasNoCommitsError } from './isolated-worktree'
import { IntentHandOffNotReadyError, IntentWorktreeMismatchError, type RequiredFlowWorktree } from './flow-worktree-handoff'
import { resolveRailRelaunch, restoreRelaunchRail, RailRelaunchError, type RailRelaunch } from './rail-relaunch'
import { repoIsolationStatus, defaultGitRunner } from '../../../worktree-manager'
import { isValidBranchName } from '../../../integration-branch'
import { getProjectRepositories, validateTicketRepositoryIds, validateWorkspaceSelection, RepositoryValidationError } from '../../../project-repositories'
import { resolveRepositoryDeliveryBases } from './multi-repo-bases'
import { listRepositoryDeliveries, refreshRepositoryDeliveryGroup } from './multi-repo-execution'
import { newId } from '../../../ids'
import { postRunCard, settleRunCard, notifyMissionRunFailure, failureForLoopOutcome } from '../../missions/runtime/mission-run-notify'
import { runtimeRunSummary } from '../../agent-runtime/runtime/agent-runtime-controls-router'
import { broadcastSpecAddendaChange, claimSpecAddendaForRun, planSpecAddendaAt, ticketStorePathForProject } from '../../specs/runtime/spec-addenda'
import type { ReasoningEffort } from '../../../providers/types'
import type { RailJobStartedMessage, RailJobStoppedMessage, LoopRunStoppedMessage } from '../../../types'
import { assertProcessAdmission, ProcessAdmissionClosedError } from '../../../process-admission'
import { cancelRuntimeContinuation } from '../../agent-runtime/runtime/agent-runtime-controls-router'
import { projectContextOf, broadcastRailUpdated, requireRailIndexParam, VALID_MODES, normalizeRailMode, emitPrDeliveryUpdate, recommendedLoopForRail, engineSupportRejection } from './rails-http-shared'
import { prDeliveryContinuesTickets, prDeliveryRevisionAllowed, hasDeliveredWork } from './rail-delivery-revision'

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
  const launchRail = async (req: Request, res: Response): Promise<void> => {
    const railIndex = requireRailIndexParam(req, res)
    if (railIndex === null) return

    const c = ctx(req)
    let relaunchSource: RailRelaunch | undefined
    if (/\/relaunch\/?$/i.test(req.path) && !prCiLaunches.has(req)) {
      // pr-ci-loop: running a CI loop generation again means watching its PR
      // again, through the Fix CI admission (never a generic relaunch).
      const ciSource = typeof req.body?.sourceId === 'string' ? getPrDelivery(c.db, req.body.sourceId) : undefined
      if (ciSource && ciSource.loop_id === PR_CI_LOOP_ID && ciSource.rail_index === railIndex) {
        await relaunchPrCi(req, res, ciSource); return
      }
      try {
        if (!isLoopsEnabled()) {
          res.status(409).json({ error: 'relaunch_workflow_unavailable', detail: 'The original loop workflow cannot run while Loops are disabled.',
            action: 'Enable Loops before retrying this attempt.' }); return
        }
        relaunchSource = resolveRailRelaunch(c, railIndex, req.body?.sourceId)
        if (relaunchSource.delivery && !isRailPrDeliveryEnabled()) {
          res.status(409).json({ error: 'relaunch_delivery_unavailable', detail: 'The original attempt belongs to isolated PR delivery, which is disabled.',
            action: 'Enable PR delivery before retrying this attempt.' }); return
        }
        if (relaunchSource.delivery && hasDeliveredWork(relaunchSource.delivery)) {
          res.status(409).json({ error: 'relaunch_requires_recovery',
            detail: 'This attempt has delivered work that must be recovered before it can be retried.',
            action: 'Use Recover & retry or the delivery actions on this card.' }); return
        }
        req.body = { ...relaunchSource.config,
          originConversationId: req.body?.originConversationId ?? relaunchSource.delivery?.originConversationId,
          originSurface: req.body?.originSurface ?? relaunchSource.delivery?.originSurface ?? 'dashboard',
        }
      } catch (error) {
        res.status(409).json({ error: error instanceof RailRelaunchError ? error.code : 'relaunch_config_unavailable',
          detail: error instanceof Error ? error.message : String(error),
          action: error instanceof RailRelaunchError ? error.action : 'Configure a fresh launch on a free rail.' }); return
      }
    }

    let runtimeProviderOverride
    try { runtimeProviderOverride = validateRuntimeProviderOverride(req.body?.runtimeProviderOverride) }
    catch { res.status(400).json({ error: 'invalid_runtime_provider_override' }); return }
    // Non-string values fail the VALID_MODES check below.
    let mode = normalizeRailMode(req.body?.mode ?? 'implement') as string
    const { repositoryIds: rawRepositoryIds, workspaceSelection: rawWorkspaceSelection, baseDeliveryIds, profileName, aiEngine, model, loopId: rawLoopId, reasoning_effort, originConversationId, originSurface, targetPrNumber, revisionOfDeliveryId, revisionNote, baseBranch: rawBaseBranch, followUp: rawFollowUp } = req.body ?? {}
    // Per-launch soft cap (USD): > 0 caps this run, 0 waives the default. The
    // sample-project first run sends it so a newcomer's first run is cost-bounded.
    const rawRunCap: unknown = req.body?.runCapUsd
    const runCapUsd = typeof rawRunCap === 'number' && Number.isFinite(rawRunCap) && rawRunCap >= 0 ? rawRunCap : undefined
    // PR review follow-up (pr-follow-up-fixes): a typed, bounded, FROZEN scope
    // for "resolve these review comments". It rides the delivery row and every
    // ai-step prompt — never the spec, whose description Jira-linked projects
    // sync. It needs something to follow up ON: an explicit target PR or the
    // delivery being revised.
    let followUp: PrFollowUp | undefined
    if (rawFollowUp !== undefined && rawFollowUp !== null) {
      try {
        followUp = freezeFollowUp(parseFollowUpInput(rawFollowUp))
      } catch (err) {
        if (err instanceof FollowUpValidationError) {
          res.status(400).json({ error: 'invalid_follow_up', code: err.code, detail: err.message }); return
        }
        throw err
      }
      if (typeof targetPrNumber !== 'number' && !revisionOfDeliveryId) {
        res.status(400).json({ error: 'follow_up_requires_target', detail: 'followUp needs the pull request to follow up on: pass targetPrNumber (an open PR) or revisionOfDeliveryId (an undecided delivery)' }); return
      }
    }
    // Revision launch (nontech-review-experience Wave 3): the user asked for a
    // change to a delivery that is already awaiting their decision. Shape is
    // validated here; the narrow guard exemption is enforced below.
    if (revisionOfDeliveryId !== undefined && revisionOfDeliveryId !== null) {
      if (typeof revisionOfDeliveryId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(revisionOfDeliveryId)) {
        res.status(400).json({ error: 'invalid_revision_target', detail: 'revisionOfDeliveryId must be a delivery id' }); return
      }
      if (typeof revisionNote !== 'string' || revisionNote.trim().length === 0) {
        res.status(400).json({ error: 'revision_note_required', detail: 'revisionNote must describe the change to make' }); return
      }
    }
    // Explicit target PR (deliver-rail-into-existing-pr): the user names an
    // existing open PR as the delivery destination. Shape-validated here;
    // resolved and verified inside the isolated launch, fail-closed.
    if (targetPrNumber !== undefined && targetPrNumber !== null) {
      if (typeof targetPrNumber !== 'number' || !Number.isSafeInteger(targetPrNumber) || targetPrNumber <= 0 || targetPrNumber > 1_000_000_000) {
        res.status(400).json({ error: 'invalid_target_pr', detail: 'targetPrNumber must be a positive integer' }); return
      }
    }
    // Explicit base branch (premium-milestone-progress): a milestone chain
    // stacks chunk k+1 on chunk k's delivered branch. Shape-validated here;
    // resolved locally and isolation-gated below. Never silently ignored.
    let baseBranch: string | null = null
    if (rawBaseBranch !== undefined && rawBaseBranch !== null) {
      if (typeof rawBaseBranch !== 'string' || !isValidBranchName(rawBaseBranch)) {
        res.status(400).json({ error: 'invalid_base_branch', detail: 'baseBranch must be a valid local branch name' }); return
      }
      baseBranch = rawBaseBranch
    }
    if (baseBranch && !isLoopsEnabled()) {
      res.status(400).json({ error: 'base_branch_requires_isolation', detail: 'baseBranch requires an isolated (worktree) loop launch; loops are disabled' }); return
    }
    const explicitLoop = (typeof rawLoopId === 'string' && rawLoopId.length > 0) || req.body?.mode != null
    let loopId: unknown = rawLoopId
    // Intent hand-off (Intent mode): the launch adopts the Intent's own worktree.
    // Only the Intent module starts it, after freezing HEAD; it never combines
    // with relaunch, revision, PR targets, follow-ups or stacked bases.
    const rawFlowId: unknown = req.body?.flowId
    let flowWorktree: (RequiredFlowWorktree & { ticketId: number }) | null = null
    if (rawFlowId !== undefined && rawFlowId !== null) {
      if (typeof rawFlowId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(rawFlowId)) {
        res.status(400).json({ error: 'invalid_flow_id' }); return
      }
      if (relaunchSource || revisionOfDeliveryId || targetPrNumber !== undefined && targetPrNumber !== null || followUp || baseBranch || baseDeliveryIds !== undefined) {
        res.status(400).json({ error: 'flow_handoff_incompatible', detail: 'An Intent session hand-off launches the Intent spec on its own worktree only' }); return
      }
      if (!isLoopsEnabled()) {
        res.status(409).json({ error: 'flow_requires_isolation', detail: 'An Intent session hand-off needs Loops and worktree isolation' }); return
      }
      if (!c.flowHandOff) { res.status(409).json({ error: 'feature_unavailable', detail: 'Intent is not available in this project' }); return }
      try {
        flowWorktree = c.flowHandOff.resolve(rawFlowId)
      } catch (err) {
        if (err instanceof IntentHandOffNotReadyError) { res.status(409).json({ error: err.code, detail: err.message }); return }
        throw err
      }
    } else if (rawLoopId === FLOW_SPEC_LOOP_ID) {
      res.status(400).json({ error: 'flow_id_required', detail: 'The Intent -> Spec loop is launched from an Intent session hand-off' }); return
    }
    // The PR CI loop runs only on an attached PR, through `POST /:railIndex/pr-ci`.
    if (rawLoopId === PR_CI_LOOP_ID && !prCiLaunches.has(req)) {
      res.status(400).json({ error: 'pr_ci_requires_delivery', detail: 'The PR CI loop is started from a delivery with POST /rails/:railIndex/pr-ci' }); return
    }
    // Origin link (safe-pr-review-flow): an agent-chat/MCP launch tags itself so
    // the PR decision can later be posted back into the launching conversation.
    // Both fields are optional; malformed values are rejected outright.
    if (originConversationId !== undefined && originConversationId !== null) {
      if (typeof originConversationId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(originConversationId)) {
        res.status(400).json({ error: 'originConversationId must be 1-64 chars of [A-Za-z0-9-]' }); return
      }
    }
    if (originSurface !== undefined && originSurface !== 'dashboard' && originSurface !== 'agent-chat') {
      res.status(400).json({ error: "originSurface must be 'dashboard' or 'agent-chat'" }); return
    }
    // Freestyle and Quick SDD stopped being built-ins: they are gallery loops with
    // ordinary ids. A request that still names the retired mode/ids (a stale
    // Companion or MCP caller, a relaunch of an old run) is refused explicitly
    // rather than silently turned into a different (heavier) workflow.
    if (mode === 'freestyle' || isRetiredFactoryLoopId(rawLoopId)) {
      res.status(400).json({
        error: 'builtin_loop_retired',
        ...(typeof rawLoopId === 'string' && isRetiredFactoryLoopId(rawLoopId) ? { loopId: rawLoopId } : { mode }),
        replacement: RETIRED_FACTORY_REPLACEMENT_ID,
        detail: 'Freestyle and SDD Quick (OpenSpec) are no longer built-in loops. Launch Implement, or add the loop from the loop gallery and launch the copy with mode "loop" and its loopId.',
      }); return
    }
    // rails-as-loops: a FACTORY loop id (`factory:implement` etc.) maps to its
    // legacy mode for validation/back-compat; the loop branch below still runs
    // it through the LoopRunManager. A CUSTOM loop id keeps mode='loop'.
    if (typeof loopId === 'string' && isFactoryLoopId(loopId)) {
      const fmode = factoryLoopMode(loopId)
      if (!fmode) { res.status(404).json({ error: 'Factory loop not found' }); return }
      loopId = canonicalFactoryLoopId(loopId)! // canonicalize saved legacy aliases
      mode = fmode
    }
    if (relaunchSource) relaunchSource.config = { ...relaunchSource.config, mode }
    if (!VALID_MODES.has(mode as string)) {
      res.status(400).json({ error: 'mode must be "implement" or "loop"' }); return
    }
    // A bare legacy mode (MCP tools, mobile, direct REST — no loopId) must run
    // through the SAME factory loop the dashboard sends, so worktree isolation
    // and the ask-first PR flow apply identically regardless of the launch door.
    // Without this, an agent-launched implement lands in the bare QueueManager
    // branch: shared cwd, SPECRAILS_GIT_AUTO=false, no delivery row — stranded
    // uncommitted work. Loops off ⇒ legacy QueueManager path, unchanged.
    if (isLoopsEnabled() && (typeof loopId !== 'string' || !loopId) && mode !== 'loop') {
      loopId = factoryLoopForMode(mode as string)?.id
    }
    // Implement is the continuation default; an explicit workflow takes precedence.
    if (revisionOfDeliveryId && isLoopsEnabled() && !explicitLoop) {
      loopId = RETIRED_FACTORY_REPLACEMENT_ID
      mode = 'implement'
    }
    if (mode === 'loop' && !isLoopsEnabled()) {
      res.status(403).json({ error: 'Loops are disabled on this server' }); return
    }
    // An explicit target PR is only meaningful on the isolated PR-delivery
    // path. Reject early when that path is structurally unavailable rather
    // than silently launching fresh work next to the designated PR.
    if (typeof targetPrNumber === 'number' && (!isLoopsEnabled() || !isRailPrDeliveryEnabled())) {
      res.status(400).json({ error: 'target_pr_requires_pr_mode', detail: 'targetPrNumber requires loops and PR delivery to be enabled' }); return
    }
    if (followUp && (!isLoopsEnabled() || !isRailPrDeliveryEnabled())) {
      res.status(400).json({ error: 'follow_up_requires_pr_mode', detail: 'a PR review follow-up runs on the isolated PR-delivery path; loops and PR delivery must be enabled' }); return
    }
    // Interactive in-job chat is ON by default for providers that expose the
    // spawn-time gate in QueueManager (kill-switch + persistent-stdin
    // capability) decides, so the launch no longer passes an explicit flag. A
    // legacy `interactive` body param is accepted and ignored (wire compat).

    try {
      assertProcessAdmission(c.project.id)
    } catch (err) {
      if (err instanceof ProcessAdmissionClosedError) {
        res.status(409).json({ error: 'project_recovery_in_progress' }); return
      }
      throw err
    }
    // Daily budget (rail-loop-budget-guard): the same project/app-wide budget
    // state the queue auto-pause enforces. Every launch door (dashboard Play,
    // Launch all, mission cards, MCP launch/launch_all, mobile, milestone
    // chains, relaunch) reaches this route, so one check spawns nothing.
    const budgetRejection = c.dailyBudgetRejection?.() ?? null
    if (budgetRejection) { res.status(409).json(budgetRejection); return }
    // Review WIP limit (review-wip-limit): same doors, same "spawn nothing"
    // contract. Continuations of an existing delivery add no review work and
    // pass; a new delivery holds a slot until this request has answered (its
    // delivery row then exists), so parallel launches cannot overshoot.
    const reviewWip = c.reviewWipGate?.admit(railIndex, {
      revisionOfDeliveryId: typeof revisionOfDeliveryId === 'string' ? revisionOfDeliveryId : null,
      relaunchOfDelivery: Boolean(relaunchSource?.delivery),
      targetsExistingPr: typeof targetPrNumber === 'number' || Boolean(followUp),
      railHasActiveDelivery: Boolean(getActivePrDeliveryByRail(c.db, railIndex)),
    })
    if (reviewWip && !reviewWip.ok) { res.status(409).json(reviewWip.rejection); return }
    if (reviewWip) {
      res.once('finish', reviewWip.release)
      res.once('close', reviewWip.release)
    }
    const storedRail = getRail(c.db, railIndex)
    // A delivery that reached its PR may have released its rail: the CI loop
    // continues that delivery, so it runs on the delivery's frozen spec set.
    const prCiTickets = !relaunchSource && storedRail.ticketIds.length === 0 ? prCiLaunches.get(req)?.ticketIds : undefined
    const rail = relaunchSource ? { ...storedRail, ticketIds: [...relaunchSource.ticketIds],
      profileName: typeof profileName === 'string' ? profileName : null,
      aiEngine: typeof aiEngine === 'string' ? aiEngine : null } : prCiTickets?.length ? { ...storedRail, ticketIds: [...prCiTickets] } : storedRail

    if (relaunchSource && rail.ticketIds.some(id => !c.getTicketSpec?.(id))) {
      res.status(409).json({ error: 'relaunch_specs_unavailable', detail: 'One or more original specs are no longer available.',
        action: 'Refresh the mission and configure a launch with the current specs.' }); return
    }

    if (rail.ticketIds.length === 0) {
      res.status(400).json({ error: 'Rail has no tickets assigned' }); return
    }
    if (flowWorktree && (rail.ticketIds.length !== 1 || rail.ticketIds[0] !== flowWorktree.ticketId)) {
      res.status(409).json({ error: 'flow_rail_mismatch', detail: 'The rail must carry exactly the Intent spec' }); return
    }

    // A durable delta runs on Implement when the caller has not chosen a workflow.
    // Revision is a delivery-continuation mechanism, not the implementation loop.
    const launchAddenda = planSpecAddendaAt(ticketStorePathForProject(c.project), rail.ticketIds)
    if (launchAddenda.length && isLoopsEnabled() && !explicitLoop) {
      loopId = RETIRED_FACTORY_REPLACEMENT_ID
      mode = 'implement'
    }

    let repositoryIds: string[]
    let workspaceSelection: Record<string, string[]> | undefined
    const primaryRepository = getProjectRepositories(c.project).find((repository) => repository.isPrimary)!
    try {
      const requiredRepositoryIds = [...new Set(rail.ticketIds.flatMap((id) =>
        validateTicketRepositoryIds(c.project, c.getTicketSpec?.(id)?.repositoryIds) ?? [primaryRepository.id],
      ))]
      repositoryIds = validateTicketRepositoryIds(c.project, rawRepositoryIds) ?? requiredRepositoryIds
      workspaceSelection = validateWorkspaceSelection(c.project, rawWorkspaceSelection, repositoryIds)
      const missing = requiredRepositoryIds.filter((id) => !repositoryIds.includes(id))
      if (missing.length) {
        res.status(400).json({ error: 'repository_scope_incomplete', missingRepositoryIds: missing,
          detail: 'The launch must include every repository required by its specs. Edit the spec scope first if its implementation targets have changed.' }); return
      }
    } catch (error) {
      res.status(error instanceof RepositoryValidationError ? error.status : 400).json({ error: error instanceof Error ? error.message : 'Invalid repository selection' }); return
    }
    let repositoryBases: Awaited<ReturnType<typeof resolveRepositoryDeliveryBases>> | undefined
    if (relaunchSource?.delivery?.executionManifest && baseDeliveryIds === undefined) {
      repositoryBases = { repositoryBaseBranches: Object.fromEntries(relaunchSource.delivery.executionManifest.repositories.map(repo => [repo.repositoryId, repo.baseBranch])), repositoryBaseShas: {} }
      baseBranch = repositoryBases.repositoryBaseBranches[primaryRepository.id] ?? baseBranch
    }
    if (baseDeliveryIds !== undefined) {
      try {
        repositoryBases = await resolveRepositoryDeliveryBases(c.db, c.project, repositoryIds, baseDeliveryIds, defaultGitRunner)
        baseBranch = repositoryBases.repositoryBaseBranches[primaryRepository.id] ?? baseBranch
      } catch (error) { res.status(409).json({ error: 'invalid_repository_base', detail: error instanceof Error ? error.message : String(error) }); return }
    }
    const requiresRepositoryIsolation = repositoryIds.length !== 1 || repositoryIds[0] !== primaryRepository.id
    if (requiresRepositoryIsolation && !isLoopsEnabled()) { res.status(409).json({ error: 'repository_isolation_required' }); return }

    // Per-rail spec cap: a single launch may carry at most
    // MAX_TICKETS_PER_RAIL_LAUNCH specs — bigger batches must be chunked
    // across rails (the milestone launcher does this automatically).
    if (rail.ticketIds.length > MAX_TICKETS_PER_RAIL_LAUNCH) {
      res.status(400).json({
        error: 'rail_ticket_cap_exceeded',
        max: MAX_TICKETS_PER_RAIL_LAUNCH,
        ticketCount: rail.ticketIds.length,
      }); return
    }

    // Concurrent-launch safety (parallel rails): a ticket already worked by an
    // ACTIVE run — this rail relaunched mid-run, or the same ticket sitting on
    // two rails — must not spawn a second concurrent writer. The per-ticket
    // worktree path is keyed by ticketId, so a duplicate launch would silently
    // reuse (and corrupt) the in-flight run's checkout. 409 so Launch-all and
    // agent-driven fan-outs surface a clean per-rail skip instead of a clash.
    const inFlightTickets = new Set<number>()
    for (const meta of c.railJobs.values()) for (const id of meta.ticketIds) inFlightTickets.add(id)
    for (const meta of c.railLoopRuns.values()) for (const id of meta.ticketIds) inFlightTickets.add(id)
    const inFlightOverlap = rail.ticketIds.filter((id) => inFlightTickets.has(id))
    if (inFlightOverlap.length > 0) {
      res.status(409).json({ error: 'tickets_in_flight', ticketIds: inFlightOverlap }); return
    }

    // Resolve once: a concurrent publication cannot mix one recipe's agents
    // with another recipe's graph. Loop-owned roles bypass project launch presets.
    let builtinSelection: ReturnType<typeof resolveBuiltinLoop>
    let librarySelection: ReturnType<typeof getLoop>
    if (isLoopsEnabled() && typeof loopId === 'string' && loopId) {
      if (isFactoryLoopId(loopId)) {
        let capabilities: Record<string, number> | undefined
        try { capabilities = (await loadCoreAgentRuntime()).api?.capabilities } catch { /* Retained legacy recipes remain available. */ }
        builtinSelection = resolveBuiltinLoop(c.desktopDb, loopId, capabilities)
      } else librarySelection = getLoop(c.desktopDb, loopId)
    }
    const loopAgents = builtinSelection?.graph.config.agents ?? (librarySelection?.status === 'published' ? librarySelection.graph.config.agents : undefined)
    const ownsLoopEngine = !!loopAgents && loopAgents.agents.developer.provider !== 'inherit'
    // Milestone chains require the execution choice shown at launch. A recipe
    // owning a conflicting engine must reject it rather than silently replacing it.
    if (req.body?.requireEngineSelection === true && loopAgents) {
      const developer = loopAgents.agents.developer
      const provider = ownsLoopEngine ? developer.provider : aiEngine
      const selectedModel = ownsLoopEngine ? developer.model ?? getAdapter(developer.provider).defaultModel() : developer.model ?? model
      const selectedEffort = ownsLoopEngine ? developer.effort : developer.effort ?? reasoning_effort
      if (provider !== aiEngine || selectedModel !== model || (selectedEffort ?? null) !== (reasoning_effort ?? null)) {
        res.status(409).json({ error: 'loop_engine_conflict', detail: 'The loop fixes a different provider, model or effort. Update its agent configuration before launching this milestone.' })
        return
      }
    }
    if (ownsLoopEngine) runtimeProviderOverride = undefined

    // AI engine precedence: explicit body param > stored rail engine > primary.
    // `undefined`/empty in both means "run on the project's primary provider".
    const requestedEngineRaw =
      ownsLoopEngine ? loopAgents!.agents.developer.provider : aiEngine === undefined ? (runtimeProviderOverride?.provider ?? rail.aiEngine ?? undefined) : aiEngine
    // `roles` (hybrid-role-engines): the pipeline roles keep the project's
    // per-role runtime settings (no flattening override) and the loop's own
    // steps come from the stored loop-role engines — verifier for every
    // non-core ai-step, decider for the Loop Decider. The rail's "engine" for
    // the non-core path is therefore the verifier's provider.
    const rolesMode = requestedEngineRaw === ROLES_ENGINE
    const loopRoleEngines = rolesMode ? loadLoopRoleEngines(c.project) : {}
    const requestedEngine = rolesMode
      ? (loopRoleEngines.verifier?.provider && validateRequestedProvider(c.project, loopRoleEngines.verifier.provider).ok ? loopRoleEngines.verifier.provider : undefined)
      : requestedEngineRaw
    const engineCheck = ownsLoopEngine
      ? hasAdapter(loopAgents!.agents.developer.provider) ? { ok: true as const, provider: loopAgents!.agents.developer.provider } : { ok: false as const, error: 'Loop agent provider is not configured' }
      : validateRequestedProvider(c.project, requestedEngine)
    if (!engineCheck.ok) {
      res.status(400).json({ error: engineCheck.error }); return
    }
    // Only pass a provider override when one was actually requested (keeps
    // single-provider rails on the legacy code path).
    const railProvider = requestedEngine ? engineCheck.provider : undefined
    // Mission/MCP and Launch-all submit aiEngine or use the saved rail engine.
    // Resolve this at the shared boundary, not only in the Dashboard payload.
    // Local (OpenAI-compatible) engines: the override carries provider + model
    // only — OpenAI endpoints have no effort knob, so effort is DROPPED (never
    // forwarded to Core's executor), and cost caps are refused (a local run has
    // no billable cost to cap against).
    const localEngine = isLocalAdapterId(engineCheck.provider)
    if (rolesMode && runtimeProviderOverride) {
      res.status(400).json({ error: 'runtime_provider_mismatch', detail: 'A roles launch carries no provider override' }); return
    }
    if (!ownsLoopEngine && !runtimeProviderOverride && requestedEngine && !rolesMode) {
      try {
        runtimeProviderOverride = validateRuntimeProviderOverride({ provider: engineCheck.provider, ...(model ? { model } : {}), ...(reasoning_effort && !localEngine ? { effort: reasoning_effort } : {}) })
      } catch { res.status(400).json({ error: 'invalid_runtime_provider_override' }); return }
    }
    if (runtimeProviderOverride && runtimeProviderOverride.provider !== engineCheck.provider) {
      res.status(400).json({ error: 'runtime_provider_mismatch' }); return
    }
    if (localEngine && runtimeProviderOverride?.effort !== undefined) {
      runtimeProviderOverride = { provider: runtimeProviderOverride.provider, ...(runtimeProviderOverride.model !== undefined ? { model: runtimeProviderOverride.model } : {}) }
    }
    if (!ownsLoopEngine && localEngine && req.body?.maxCostUsd !== undefined && req.body?.maxCostUsd !== null) {
      res.status(400).json({ error: 'local_engine_no_cost_cap' }); return
    }


    // Profile selection precedence: explicit body param > stored rail profile > default resolution.
    // `null` in the body explicitly forces legacy mode. Providers without
    // profile support run in legacy mode.
    let resolvedProfile: string | null | undefined
    if (loopAgents) {
      resolvedProfile = null
    } else if (getAdapter(engineCheck.provider).capabilities.profiles !== true) {
      resolvedProfile = null
    } else if (profileName === null) {
      resolvedProfile = null
    } else if (typeof profileName === 'string' && profileName.trim()) {
      resolvedProfile = profileName.trim()
    } else if (rail.profileName) {
      resolvedProfile = rail.profileName
    } else {
      resolvedProfile = undefined // fall through to QueueManager default resolution
    }

    try {
      // Loop mode: run a published loop (the Loops feature) against each spec,
      // one app-driven LoopRun per ticket (mirrors freestyle's per-ticket model).
      // Drives raw prompts via the LoopRunManager — NO queue job, NO slash command.
      // rails-as-loops: a chosen loop (factory OR custom) runs through the
      // LoopRunManager when Loops are enabled, using the current factory graph.
      // Implement/batch delegate their complete cycle to Core. (Loops off / no loopId → the legacy
      // bare-mode QueueManager path below; `mode` is the derived factory mode.)
      if (isLoopsEnabled() && typeof loopId === 'string' && loopId) {
        let loopGraph: LoopGraph
        let loopName: string
        if (isFactoryLoopId(loopId)) {
          // Editable built-ins: an edited row runs its Published graph (or the
          // last Published snapshot while an edit is Draft); otherwise the
          // current code default for this Core.
          const f = builtinSelection
          // Intent -> Spec exists only on a Core that advertises `deriveChange`.
          if (!f && loopId === FLOW_SPEC_LOOP_ID) {
            res.status(409).json({ error: 'engine_unsupported', detail: 'Update Core to run the Intent → Spec loop (derive-change).' }); return
          }
          if (!f) { res.status(404).json({ error: 'Factory loop not found' }); return }
          if (f.source !== 'default') {
            const validation = validateLoopGraph(f.graph)
            if (!validation.valid) {
              res.status(422).json({ error: 'Loop graph is invalid', errors: validation.errors }); return
            }
            const rejection = await engineSupportRejection(c.loopRunManager, f.graph, loopId)
            if (rejection) { res.status(409).json(rejection); return }
          }
          loopGraph = f.graph
          loopName = f.name
        } else {
          const loop = librarySelection
          if (!loop) { res.status(404).json({ error: 'Loop not found' }); return }
          if (loop.status !== 'published') {
            res.status(400).json({ error: 'Loop must be published before it can run on a rail' }); return
          }
          const validation = validateLoopGraph(loop.graph)
          if (!validation.valid) {
            res.status(422).json({ error: 'Loop graph is invalid', errors: validation.errors }); return
          }
          // A standalone loop (no {{spec.*}} and no ticket command) ignores the
          // rail's spec — it would just re-run once per ticket. Those belong to
          // the Loops page "Run" action; reject them here as a defence-in-depth
          // behind the rail picker, which already hides them.
          if (!loopNeedsTicket(loop.graph)) {
            res.status(400).json({ error: 'This loop runs standalone — launch it from the Loops page, not a rail.' }); return
          }
          const rejection = await engineSupportRejection(c.loopRunManager, loop.graph, loopId)
          if (rejection) { res.status(409).json(rejection); return }
          loopGraph = loop.graph
          loopName = loop.name
        }
        const loopProvider = railProvider ?? c.project.provider ?? 'claude'
        const loopAdapter = getAdapter(loopProvider)
        if (
          loopGraph.nodes.some((node) => node.type === 'decider')
          && !supportsToolPolicy(loopAdapter, 'read-only')
        ) {
          res.status(409).json({
            code: 'provider_tool_policy_unsupported',
            provider: loopProvider,
            requiredPolicy: 'read-only',
            error:
              `Provider '${loopProvider}' cannot run Loop Deciders because its headless CLI ` +
              'does not enforce a read-only tool policy.',
          })
          return
        }
        if (!ownsLoopEngine && typeof model === 'string' && model && !isValidModelForProvider(model, loopProvider as SpecProvider)) {
          res.status(400).json({ error: `model is not valid for provider "${loopProvider}"`, allowed: getModelsForProvider(loopProvider as SpecProvider) }); return
        }
        // Global Specrails Agents defaults (Settings ▸ Specrails Agents): fill
        // model/effort ONLY when the launch body carries no explicit choice —
        // dashboard factory launches send neither. Read at launch time, so a
        // settings change applies to the next launch without restart.
        const globalAgentDefaults = resolveAgentDefaults(c.desktopDb, loopProvider)
        let profileModel: string | undefined
        if (resolvedProfile) {
          try {
            const execution = resolveProjectExecution({ slug: c.project.slug, path: c.project.path })
            profileModel = resolveProfile(execution.cwd, resolvedProfile, loopProvider)?.profile.orchestrator.model
          } catch (error) {
            res.status(400).json({ error: 'invalid_profile', detail: error instanceof Error ? error.message : String(error) })
            return
          }
        }
        const verifierEngine = rolesMode ? resolveLoopRoleEngine(c.project, 'verifier', { provider: loopProvider, model: loopAdapter.defaultModel() }, loopRoleEngines) : undefined
        const loopModel = ownsLoopEngine ? loopAgents!.agents.developer.model ?? loopAdapter.defaultModel() :
          loopAgents?.agents.developer.model ?? runtimeProviderOverride?.model ?? (
          typeof model === 'string' && model
            ? model
            : (verifierEngine?.model ?? profileModel ?? globalAgentDefaults?.pipelineModel ?? loopAdapter.defaultModel()))
        let effort: ReasoningEffort | undefined
        // Local (OpenAI-compatible) engines have no per-invocation effort knob
        // unless the connection opts in; a requested effort is DROPPED, not a
        // 400 — the engine selectors send the last-used effort blindly.
        const effortRequested = req.body?.requireEngineSelection === true && reasoning_effort === null ? null : localEngine && !loopAdapter.capabilities.supportsReasoningEffort ? undefined : ownsLoopEngine ? loopAgents!.agents.developer.effort : (loopAgents?.agents.developer.effort ?? runtimeProviderOverride?.effort ?? reasoning_effort ?? verifierEngine?.effort)
        if (effortRequested !== undefined && effortRequested !== null) {
          const allowed = reasoningEffortsForModel(loopAdapter, loopModel)
          if (
            typeof effortRequested !== 'string' ||
            !(allowed as readonly string[]).includes(effortRequested)
          ) {
            res.status(400).json({
              error: `reasoning_effort is not valid for provider "${loopProvider}" and model "${loopModel}"`,
              allowed,
            }); return
          }
          effort = effortRequested as ReasoningEffort
        } else if (
          effortRequested !== null && !ownsLoopEngine && globalAgentDefaults?.pipelineEffort
          && isReasoningEffortValidForModel(loopAdapter, loopModel, globalAgentDefaults.pipelineEffort)
        ) {
          effort = globalAgentDefaults.pipelineEffort as ReasoningEffort
        }
        // Loop Decider engine under roles mode (else the rail's engine, as before).
        // Its provider must enforce a read-only tool policy like the rail's.
        const deciderEngine = rolesMode && loopGraph.nodes.some((node) => node.type === 'decider')
          ? resolveLoopRoleEngine(c.project, 'decider', { provider: loopProvider, model: loopModel, ...(effort ? { effort } : {}) }, loopRoleEngines)
          : undefined
        if (deciderEngine && !supportsToolPolicy(getAdapter(deciderEngine.provider), 'read-only')) {
          res.status(409).json({ code: 'provider_tool_policy_unsupported', provider: deciderEngine.provider, requiredPolicy: 'read-only', error: `Provider '${deciderEngine.provider}' cannot run Loop Deciders because its headless CLI does not enforce a read-only tool policy.` })
          return
        }
        // The loop's command(s) declare ticket scope + required capabilities.
        const promptsText = loopGraph.nodes
          .filter((n) => n.type === 'ai-step')
          .map((n) => String(n.data?.prompt ?? ''))
          .join('\n')
        if (referencesUnsupportedProviderCommand(promptsText, loopProvider)) {
          res.status(400).json({ error: `This loop uses a command unsupported by provider '${loopProvider}'` }); return
        }
        const scope = loopGraph.config.ticketScope ?? (loopGraph.config.journal === 'implementation' ? 'all' : dominantTicketScope(promptsText))
        // Freeze only admitted launch choices. Execution paths, run ids,
        // addendum claims and revision generation ids must never be replayed.
        const launchConfig: Record<string, unknown> = {
          mode, loopId, repositoryIds, workspaceSelection,
          aiEngine: rolesMode ? ROLES_ENGINE : loopProvider, model: loopModel,
          reasoning_effort: effort, profileName: resolvedProfile,
          ...(runtimeProviderOverride ? { runtimeProviderOverride } : {}),
          ...(baseBranch ? { baseBranch } : {}),
          ...(baseDeliveryIds ? { baseDeliveryIds } : {}),
          ...(typeof targetPrNumber === 'number' ? { targetPrNumber } : {}),
          ...(followUp ? { followUp } : {}),
        }

        // Parallel isolation (default-on; disable with SPECRAILS_RAIL_WORKTREES=0):
        // a per-ticket rail on a repo-mutating loop runs each ticket in its own git
        // worktree, then merges the branches back. A non-git repo or an unborn
        // HEAD uses the explicit shared-cwd fallback; an operational allocation
        // failure aborts rather than moving execution into the active checkout.
        let isolationUnavailable: string | undefined
        let continuablePrDelivery: PrDeliverySnapshot | null = null
        let revisionRequest: { ofDeliveryId: string; decision: PrDecision; note: string } | null = null
        let retryOfDelivery: { deliveryId: string; decision: PrDecision } | null = null
        // Read-only vs mutating is DERIVED from the loop's nodes (see loop-effect),
        // not a user flag — a content-read-only loop (no ai-step/shell) never writes,
        // so it is not isolated; anything that can write is.
        const loopReadOnly = classifyLoopEffect(loopGraph) === 'read-only'
        // Relaunch collision (ask-first PR delivery): this guard must run even
        // when the worktree kill-switch is off. Otherwise a published PR follow-
        // up silently drops to shared cwd and can commit on the ambient branch.
        if (isRailPrDeliveryEnabled()) {
          let pending = getActivePrDeliveryByRail(c.db, railIndex)
          // A delivery that failed BEFORE any repository work was allocated
          // (worktree add refused, branch busy…) never ran: it owns nothing to
          // decide on. A relaunch closes it in place instead of dead-ending on
          // `pr_decision_pending` — the user already saw the failure on the card,
          // and pressing Launch again IS the decision. A revision naming it is
          // meaningless (there is no work to revise) and gets a precise 409.
          if (pending && !relaunchSource && isPreparationFailureRow(pending)) {
            if (revisionOfDeliveryId === pending.id) {
              res.status(409).json({
                error: 'invalid_revision_target',
                prDeliveryId: pending.id,
                detail: 'that delivery failed before any work was prepared, so there is nothing to revise; relaunch the rail without revisionOfDeliveryId',
              }); return
            }
            if (transitionDecision(c.db, pending.id, 'pr_failed', 'discarded', { deliveryOutcome: 'not_started', statusCode: 'discarded' })) {
              emitPrDeliveryUpdate(c, pending.id)
              pending = undefined
            }
          }
          const pendingSnapshot = pending ? toPrDeliverySnapshot(pending) : null
          if (revisionOfDeliveryId && !pendingSnapshot) {
            res.status(409).json({ error: 'invalid_revision_target', detail: 'The delivery is no longer active; refresh before continuing.' }); return
          }
          // Continue only the exact active generation and its full spec set.
          // Explicit change requests name it; open addenda on the same rail
          // identify it implicitly. Both use the existing supersession contract.
          const revisionsEnabled = areDeliveryRevisionsEnabled()
          const failedAddendumRetry = Boolean(launchAddenda.length && pendingSnapshot && !revisionOfDeliveryId
            && ['implementation_failed', 'pr_failed'].includes(pendingSnapshot.decision)
            && !pendingSnapshot.prUrl && !hasDeliveredWork(pendingSnapshot)
            && new Set(pendingSnapshot.ticketIds).size === new Set(rail.ticketIds).size
            && rail.ticketIds.every(id => pendingSnapshot.ticketIds.includes(id)))
          const identifiedFailureRetry = Boolean(relaunchSource?.delivery && pendingSnapshot
            && relaunchSource.sourceId === pendingSnapshot.id
            && ['implementation_failed', 'pr_failed'].includes(pendingSnapshot.decision)
            && !hasDeliveredWork(pendingSnapshot))
          const addendumContinuation = Boolean(
            launchAddenda.length && pendingSnapshot && pendingSnapshot.decision !== 'building'
            && !revisionOfDeliveryId
            && prDeliveryRevisionAllowed(pendingSnapshot, pendingSnapshot.id, rail.ticketIds),
          )
          const revisionOfPending = Boolean(
            revisionsEnabled && pendingSnapshot && (addendumContinuation || (revisionOfDeliveryId
            && prDeliveryRevisionAllowed(pendingSnapshot, revisionOfDeliveryId as string, rail.ticketIds))),
          )
          if (revisionsEnabled && pendingSnapshot && revisionOfDeliveryId && !revisionOfPending) {
            res.status(409).json({
              error: 'invalid_revision_target',
              prDeliveryId: pendingSnapshot.id,
              detail: 'a revision must target the rail\'s active delivery and cover all of its specs',
            }); return
          }
          if (pendingSnapshot && !revisionOfPending && !failedAddendumRetry && !identifiedFailureRetry && !prDeliveryContinuesTickets(pendingSnapshot, rail.ticketIds)) {
            res.status(409).json({ error: 'pr_decision_pending', prDeliveryId: pendingSnapshot.id }); return
          }
          if (revisionOfPending && pendingSnapshot) {
            revisionRequest = {
              ofDeliveryId: pendingSnapshot.id,
              decision: pendingSnapshot.decision as PrDecision,
              note: addendumContinuation
                ? `Implement the attached spec addenda only: ${launchAddenda.flatMap((entry) => entry.addenda.map((a) => `#${entry.ticketId} [${a.id}] ${a.title}`)).join('; ')}. Their complete frozen bodies are in SPEC ADDENDA; preserve existing behavior outside that scope.`
                : revisionNote as string,
            }
          }
          if ((failedAddendumRetry || identifiedFailureRetry) && pendingSnapshot) retryOfDelivery = { deliveryId: pendingSnapshot.id, decision: pendingSnapshot.decision as PrDecision }
          // Explicit target vs an undecided continuable delivery: the slot's
          // active generation owns its PR. A DIFFERENT explicit target would
          // append to the undecided branches → 409; the SAME PR is redundant
          // (the continuation contract below already drives it) and is dropped.
          if (pendingSnapshot && !retryOfDelivery && typeof targetPrNumber === 'number' && pendingSnapshot.prNumber !== targetPrNumber
            && !pendingSnapshot.repositoryDeliveries?.some((delivery) => delivery.prNumber === targetPrNumber)) {
            res.status(409).json({ error: 'pr_decision_pending', prDeliveryId: pendingSnapshot.id }); return
          }
          if (pendingSnapshot?.executionManifest) {
            const previousIds = pendingSnapshot.executionManifest.selectedRepositoryIds
            if (previousIds.length !== repositoryIds.length || previousIds.some((id) => !repositoryIds.includes(id))) {
              res.status(409).json({ error: 'delivery_repository_scope_changed', detail: 'A follow-up must retain the delivered repository scope.' }); return
            }
          }
          continuablePrDelivery = pendingSnapshot
        }
        const useIsolation = isolationApplies({
          loopsEnabled: isLoopsEnabled(), scope, ticketCount: rail.ticketIds.length, readOnly: loopReadOnly,
        })
        if (requiresRepositoryIsolation && !useIsolation) {
          res.status(409).json({ error: 'repository_isolation_required', detail: 'Selected repositories require worktree isolation for this loop.' }); return
        }
        // An Intent session runs in exactly its own repository: the primary (no group), or
        // the one non-primary member its worktree belongs to.
        const flowRepositoryScope = !flowWorktree ? true : flowWorktree.repositoryId
          ? repositoryIds.length === 1 && repositoryIds[0] === flowWorktree.repositoryId
          : !requiresRepositoryIsolation
        if (flowWorktree && (!useIsolation || !flowRepositoryScope)) {
          res.status(409).json({ error: 'flow_requires_isolation', detail: 'An Intent session hand-off runs only on its own worktree, in the repository it belongs to.' }); return
        }
        if (relaunchSource?.delivery && !useIsolation) {
          res.status(409).json({ error: 'relaunch_isolation_required', detail: 'The original attempt was isolated; its retry must also use an isolated worktree.',
            action: 'Restore worktree isolation and the original workflow before retrying.' }); return
        }
        if (typeof targetPrNumber === 'number' && !useIsolation) {
          res.status(400).json({ error: 'target_pr_requires_pr_mode', detail: 'targetPrNumber requires an isolated (worktree) launch; this launch would run in the shared checkout' }); return
        }
        if (baseBranch && !useIsolation) {
          res.status(400).json({ error: 'base_branch_requires_isolation', detail: 'baseBranch requires an isolated (worktree) launch; this launch would run in the shared checkout' }); return
        }
        if (continuablePrDelivery && !loopReadOnly && !useIsolation) {
          res.status(409).json({
            error: 'pr_continuation_isolation_required',
            detail: `Cannot continue PR branch ${continuablePrDelivery.branch} while worktree isolation is disabled.`,
            action: 'Enable rail worktrees and retry; PR continuations never run in the shared project checkout.',
          })
          return
        }
        if (useIsolation) {
          // Worktree isolation needs a git repo WITH at least one commit (an
          // unborn HEAD can't be branched). Fall back (with a message) otherwise.
          const status = requiresRepositoryIsolation ? 'ok' : await repoIsolationStatus(defaultGitRunner, c.project.path)
          if (status !== 'ok') {
            if (flowWorktree) {
              res.status(409).json({ error: 'flow_requires_isolation', detail: `worktree isolation is unavailable (${status})` }); return
            }
            if (baseBranch) {
              res.status(400).json({ error: 'base_branch_requires_isolation', detail: `baseBranch requires worktree isolation, which is unavailable (${status})` }); return
            }
            if (typeof targetPrNumber === 'number') {
              res.status(400).json({
                error: 'target_pr_requires_pr_mode',
                detail: `targetPrNumber requires worktree isolation, which is unavailable (${status})`,
              })
              return
            }
            if (continuablePrDelivery) {
              res.status(409).json({
                error: 'pr_continuation_isolation_required',
                detail: `Cannot continue PR branch ${continuablePrDelivery.branch} because worktree isolation is unavailable (${status}).`,
                action: 'Restore a git repository with a committed HEAD, ensure the PR branch is free for a dedicated worktree, then retry.',
              })
              return
            }
            isolationUnavailable = status // 'no-git' | 'no-commits'
            console.warn(`[rails-router] worktree isolation unavailable (${status}); running shared cwd`)
          } else {
            if (baseBranch) {
              // Must resolve as a LOCAL branch — a chain never stacks on a guess.
              const verify = await defaultGitRunner.run(['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`], c.project.path)
              if (verify.code !== 0) {
                res.status(400).json({ error: 'invalid_base_branch', detail: `branch ${baseBranch} does not resolve locally` }); return
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
                provider: loopProvider, model: loopModel, effort, scope,
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
              return
            } catch (err) {
              if (err instanceof RailRelaunchError) {
                res.status(409).json({ error: err.code, detail: err.message, action: err.action }); return
              }
              if (err instanceof PrDeliveryGenerationConflict) {
                res.status(409).json({
                  error: 'pr_delivery_generation_conflict',
                  prDeliveryId: err.currentId,
                })
                return
              }
              // Explicit-target validation failures are the USER's answer being
              // unusable — fail closed with the machine-readable code; never
              // fall back to a fresh shared-cwd run next to the designated PR.
              if (err instanceof RepositoryHasNoCommitsError) {
                res.status(409).json({ error: err.code, detail: err.message }); return
              }
              if (err instanceof IntentWorktreeMismatchError) {
                res.status(409).json({ error: err.code, detail: err.message }); return
              }
              if (err instanceof ExplicitPrTargetError) {
                res.status(err.code === 'target_pr_not_found' ? 404 : 409).json({
                  error: err.code,
                  detail: err.message,
                })
                return
              }
              if ((continuablePrDelivery && !retryOfDelivery) || err instanceof PrContinuationIsolationError) {
                const detail = err instanceof Error ? err.message : String(err)
                res.status(409).json({
                  error: 'pr_continuation_isolation_required',
                  detail,
                  action: 'Ensure the PR branch is available for a dedicated git worktree, then retry.',
                })
                return
              }
              console.error('[rails-router] isolated launch failed:', err)
              res.status(409).json({
                error: 'isolation_failed',
                detail: err instanceof Error ? err.message : String(err),
                action: 'Resolve the worktree allocation error and retry the rail launch.',
              })
              return
            }
          }
        }

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
        if (scope === 'all') {
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
        return
      }

      // A custom-loop launch (mode='loop') with no loopId is invalid — there is
      // no factory loop to fall back to (only implement/batch do).
      if (mode === 'loop') {
        res.status(400).json({ error: 'loopId is required for loop mode' }); return
      }

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
    } catch (err) {
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
