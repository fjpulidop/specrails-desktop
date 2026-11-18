// Rail launch door, admission stages: process/budget/review-WIP admission,
// the frozen spec and repository scope, stacked delivery bases, the per-rail
// capacity guards, the loop recipe selection and the effective AI engine.
// Every stage is synchronous except the two explicit awaits (base deliveries,
// built-in loop capabilities), so a launch that awaits nothing still checks
// in-flight tickets and registers its job in one tick. A refused request is
// answered here and the stage returns null.

import type { Request, Response } from 'express'
import type { ProjectContext } from '../../../project-registry'
import type { RailRelaunch } from './rail-relaunch'
import type { RailLaunchRequest } from './rail-launch-request'
import { validateRuntimeProviderOverride } from '../../agent-runtime/runtime/agent-runtime-settings'
import { getRail, MAX_TICKETS_PER_RAIL_LAUNCH, type RailState } from './rails-store'
import { validateRequestedProvider } from '../../../provider-selection'
import { isLoopsEnabled } from '../../../feature-flags'
import { getLoop } from '../../loops/runtime/loops-store'
import { hasAdapter, isLocalAdapterId } from '../../../providers/registry'
import { getAdapter } from '../../../providers'
import { ROLES_ENGINE, loadLoopRoleEngines, type LoopRoleEngines } from '../../loops/runtime/loop-role-engines'
import { loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'
import { isFactoryLoopId, RETIRED_FACTORY_REPLACEMENT_ID } from '../../loops/runtime/loop-factory'
import { resolveBuiltinLoop } from '../../loops/runtime/builtin-loops'
import type { LoopGraph } from '../../loops/runtime/loop-graph'
import { getActivePrDeliveryByRail } from './rail-pr-store'
import { defaultGitRunner } from '../../../worktree-manager'
import { getProjectRepositories, validateTicketRepositoryIds, validateWorkspaceSelection, RepositoryValidationError, type ProjectRepository } from '../../../project-repositories'
import { resolveRepositoryDeliveryBases } from './multi-repo-bases'
import { planSpecAddendaAt, ticketStorePathForProject } from '../../specs/runtime/spec-addenda'
import { assertProcessAdmission, ProcessAdmissionClosedError } from '../../../process-admission'

/** The request-scoped inputs every stage after request validation shares. */
export interface RailLaunchDoor {
  c: ProjectContext
  req: Request
  res: Response
  railIndex: number
  relaunchSource: RailRelaunch | undefined
  launch: RailLaunchRequest
}

/** The frozen spec set and repository scope of one launch. */
export interface RailLaunchScope {
  storedRail: RailState
  /** Specs a PR CI launch continues on a rail its delivery released. */
  prCiTickets: number[] | undefined
  /** The rail as launched: the slot, the relaunch source's specs or the CI loop's. */
  rail: RailState
  launchAddenda: ReturnType<typeof planSpecAddendaAt>
  repositoryIds: string[]
  workspaceSelection: Record<string, string[]> | undefined
  primaryRepository: ProjectRepository
}

export type RepositoryBases = Awaited<ReturnType<typeof resolveRepositoryDeliveryBases>>

/** Recipe chosen for a loop launch; resolved once per request. */
export interface LaunchLoopSelection {
  builtinSelection?: ReturnType<typeof resolveBuiltinLoop>
  librarySelection?: ReturnType<typeof getLoop>
}

/** The effective engine and profile of one launch. */
export interface RailLaunchEngine {
  loopAgents: LoopGraph['config']['agents']
  ownsLoopEngine: boolean
  rolesMode: boolean
  loopRoleEngines: LoopRoleEngines
  railProvider: string | undefined
  localEngine: boolean
  resolvedProfile: string | null | undefined
}

/** Admission stage: startup recovery, daily budget and the review WIP slot.
 *  The WIP slot is released when this response finishes or closes. */
export function admitRailLaunch(door: RailLaunchDoor): boolean {
  const { c, res, railIndex, relaunchSource } = door
  const { revisionOfDeliveryId, targetPrNumber, followUp } = door.launch
  try {
    assertProcessAdmission(c.project.id)
  } catch (err) {
    if (err instanceof ProcessAdmissionClosedError) {
      res.status(409).json({ error: 'project_recovery_in_progress' }); return false
    }
    throw err
  }
  // Daily budget (rail-loop-budget-guard): the same project/app-wide budget
  // state the queue auto-pause enforces. Every launch door (dashboard Play,
  // Launch all, mission cards, MCP launch/launch_all, mobile, milestone
  // chains, relaunch) reaches this route, so one check spawns nothing.
  const budgetRejection = c.dailyBudgetRejection?.() ?? null
  if (budgetRejection) { res.status(409).json(budgetRejection); return false }
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
  if (reviewWip && !reviewWip.ok) { res.status(409).json(reviewWip.rejection); return false }
  if (reviewWip) {
    res.once('finish', reviewWip.release)
    res.once('close', reviewWip.release)
  }
  return true
}

/** Scope stage: the launched spec set, its open addenda (which select
 *  Implement when no workflow was chosen) and the repository selection. */
export function resolveRailLaunchScope(door: RailLaunchDoor, prCiLaunchTickets: number[] | undefined): RailLaunchScope | null {
  const { c, res, railIndex, relaunchSource, launch } = door
  const { profileName, aiEngine, explicitLoop, rawRepositoryIds, rawWorkspaceSelection } = launch
  const storedRail = getRail(c.db, railIndex)
  // A delivery that reached its PR may have released its rail: the CI loop
  // continues that delivery, so it runs on the delivery's frozen spec set.
  const prCiTickets = !relaunchSource && storedRail.ticketIds.length === 0 ? prCiLaunchTickets : undefined
  const rail = relaunchSource ? { ...storedRail, ticketIds: [...relaunchSource.ticketIds],
    profileName: typeof profileName === 'string' ? profileName : null,
    aiEngine: typeof aiEngine === 'string' ? aiEngine : null } : prCiTickets?.length ? { ...storedRail, ticketIds: [...prCiTickets] } : storedRail

  if (relaunchSource && rail.ticketIds.some(id => !c.getTicketSpec?.(id))) {
    res.status(409).json({ error: 'relaunch_specs_unavailable', detail: 'One or more original specs are no longer available.',
      action: 'Refresh the mission and configure a launch with the current specs.' }); return null
  }

  if (rail.ticketIds.length === 0) {
    res.status(400).json({ error: 'Rail has no tickets assigned' }); return null
  }
  if (launch.flowWorktree && (rail.ticketIds.length !== 1 || rail.ticketIds[0] !== launch.flowWorktree.ticketId)) {
    res.status(409).json({ error: 'flow_rail_mismatch', detail: 'The rail must carry exactly the Intent spec' }); return null
  }

  // A durable delta runs on Implement when the caller has not chosen a workflow.
  // Revision is a delivery-continuation mechanism, not the implementation loop.
  const launchAddenda = planSpecAddendaAt(ticketStorePathForProject(c.project), rail.ticketIds)
  if (launchAddenda.length && isLoopsEnabled() && !explicitLoop) {
    launch.loopId = RETIRED_FACTORY_REPLACEMENT_ID
    launch.mode = 'implement'
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
        detail: 'The launch must include every repository required by its specs. Edit the spec scope first if its implementation targets have changed.' }); return null
    }
  } catch (error) {
    res.status(error instanceof RepositoryValidationError ? error.status : 400).json({ error: error instanceof Error ? error.message : 'Invalid repository selection' }); return null
  }
  return { storedRail, prCiTickets, rail, launchAddenda, repositoryIds, workspaceSelection, primaryRepository }
}

/** A multi-repository retry keeps the original generation's bases (unless the
 *  caller names base deliveries); the primary's base becomes `baseBranch`. */
export function relaunchRepositoryBases(door: RailLaunchDoor, scope: RailLaunchScope): RepositoryBases | undefined {
  const { relaunchSource, launch } = door
  let repositoryBases: RepositoryBases | undefined
  if (relaunchSource?.delivery?.executionManifest && launch.baseDeliveryIds === undefined) {
    repositoryBases = { repositoryBaseBranches: Object.fromEntries(relaunchSource.delivery.executionManifest.repositories.map(repo => [repo.repositoryId, repo.baseBranch])), repositoryBaseShas: {} }
    launch.baseBranch = repositoryBases.repositoryBaseBranches[scope.primaryRepository.id] ?? launch.baseBranch
  }
  return repositoryBases
}

/** Stacks each repository on the named base deliveries. Call only when the
 *  request carries `baseDeliveryIds`. */
export async function resolveBaseDeliveries(door: RailLaunchDoor, scope: RailLaunchScope): Promise<RepositoryBases | null> {
  const { c, res, launch } = door
  try {
    const repositoryBases = await resolveRepositoryDeliveryBases(c.db, c.project, scope.repositoryIds, launch.baseDeliveryIds, defaultGitRunner)
    launch.baseBranch = repositoryBases.repositoryBaseBranches[scope.primaryRepository.id] ?? launch.baseBranch
    return repositoryBases
  } catch (error) { res.status(409).json({ error: 'invalid_repository_base', detail: error instanceof Error ? error.message : String(error) }); return null }
}

/** Capacity stage: repository isolation availability, the per-rail spec cap
 *  and the one-writer-per-ticket guard across active jobs and loop runs. */
export function checkRailLaunchCapacity(door: RailLaunchDoor, scope: RailLaunchScope): { requiresRepositoryIsolation: boolean } | null {
  const { c, res } = door
  const { repositoryIds, primaryRepository, rail } = scope
  const requiresRepositoryIsolation = repositoryIds.length !== 1 || repositoryIds[0] !== primaryRepository.id
  if (requiresRepositoryIsolation && !isLoopsEnabled()) { res.status(409).json({ error: 'repository_isolation_required' }); return null }

  // Per-rail spec cap: a single launch may carry at most
  // MAX_TICKETS_PER_RAIL_LAUNCH specs — bigger batches must be chunked
  // across rails (the milestone launcher does this automatically).
  if (rail.ticketIds.length > MAX_TICKETS_PER_RAIL_LAUNCH) {
    res.status(400).json({
      error: 'rail_ticket_cap_exceeded',
      max: MAX_TICKETS_PER_RAIL_LAUNCH,
      ticketCount: rail.ticketIds.length,
    }); return null
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
    res.status(409).json({ error: 'tickets_in_flight', ticketIds: inFlightOverlap }); return null
  }
  return { requiresRepositoryIsolation }
}

/** Which recipe source a launch's loop id names: a built-in (needs Core's
 *  capabilities, awaited), a library loop, or none (legacy queue path). */
export function launchLoopSource(loopId: unknown): 'builtin' | 'library' | null {
  if (isLoopsEnabled() && typeof loopId === 'string' && loopId) {
    return isFactoryLoopId(loopId) ? 'builtin' : 'library'
  }
  return null
}

// Resolve once: a concurrent publication cannot mix one recipe's agents
// with another recipe's graph. Loop-owned roles bypass project launch presets.
export async function selectBuiltinLaunchLoop(c: ProjectContext, loopId: string): Promise<LaunchLoopSelection> {
  let capabilities: Record<string, number> | undefined
  try { capabilities = (await loadCoreAgentRuntime()).api?.capabilities } catch { /* Retained legacy recipes remain available. */ }
  return { builtinSelection: resolveBuiltinLoop(c.desktopDb, loopId, capabilities) }
}

export function selectLibraryLaunchLoop(c: ProjectContext, loopId: string): LaunchLoopSelection {
  return { librarySelection: getLoop(c.desktopDb, loopId) }
}

/** Engine stage: loop-owned engines, roles mode, provider validation, the
 *  runtime provider override and the profile precedence. May replace the
 *  request's `runtimeProviderOverride`. */
export function resolveRailLaunchEngine(door: RailLaunchDoor, scope: RailLaunchScope, selection: LaunchLoopSelection): RailLaunchEngine | null {
  const { c, req, res, launch } = door
  const { aiEngine, model, reasoning_effort, profileName } = launch
  const { rail } = scope
  const { builtinSelection, librarySelection } = selection
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
      return null
    }
  }
  if (ownsLoopEngine) launch.runtimeProviderOverride = undefined

  // AI engine precedence: explicit body param > stored rail engine > primary.
  // `undefined`/empty in both means "run on the project's primary provider".
  const requestedEngineRaw =
    ownsLoopEngine ? loopAgents!.agents.developer.provider : aiEngine === undefined ? (launch.runtimeProviderOverride?.provider ?? rail.aiEngine ?? undefined) : aiEngine
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
    res.status(400).json({ error: engineCheck.error }); return null
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
  if (rolesMode && launch.runtimeProviderOverride) {
    res.status(400).json({ error: 'runtime_provider_mismatch', detail: 'A roles launch carries no provider override' }); return null
  }
  if (!ownsLoopEngine && !launch.runtimeProviderOverride && requestedEngine && !rolesMode) {
    try {
      launch.runtimeProviderOverride = validateRuntimeProviderOverride({ provider: engineCheck.provider, ...(model ? { model } : {}), ...(reasoning_effort && !localEngine ? { effort: reasoning_effort } : {}) })
    } catch { res.status(400).json({ error: 'invalid_runtime_provider_override' }); return null }
  }
  if (launch.runtimeProviderOverride && launch.runtimeProviderOverride.provider !== engineCheck.provider) {
    res.status(400).json({ error: 'runtime_provider_mismatch' }); return null
  }
  if (localEngine && launch.runtimeProviderOverride?.effort !== undefined) {
    launch.runtimeProviderOverride = { provider: launch.runtimeProviderOverride.provider, ...(launch.runtimeProviderOverride.model !== undefined ? { model: launch.runtimeProviderOverride.model } : {}) }
  }
  if (!ownsLoopEngine && localEngine && req.body?.maxCostUsd !== undefined && req.body?.maxCostUsd !== null) {
    res.status(400).json({ error: 'local_engine_no_cost_cap' }); return null
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
  return { loopAgents, ownsLoopEngine, rolesMode, loopRoleEngines, railProvider, localEngine, resolvedProfile }
}
