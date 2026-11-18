// Rail launch door, loop planning stages: the runnable loop graph, the frozen
// run plan (provider, model, effort, Decider engine, ticket scope and the
// admitted launch configuration) and the PR-continuation contract with the
// rail's active delivery (revision, retry or continuation). All synchronous;
// the one await of graph validation (engine support) is left to the caller.

import { getAdapter, reasoningEffortsForModel, supportsToolPolicy } from '../../../providers'
import { isReasoningEffortValidForModel } from '../../../providers/runtime'
import type { ReasoningEffort } from '../../../providers/types'
import { areDeliveryRevisionsEnabled } from '../../../feature-flags'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { ROLES_ENGINE, resolveLoopRoleEngine } from '../../loops/runtime/loop-role-engines'
import { resolveAgentDefaults } from '../../agents/runtime/agent-defaults'
import { resolveProfile } from '../../agents/runtime/profile-manager'
import { isValidModelForProvider, getModelsForProvider, type SpecProvider } from '../../specs/runtime/spec-models'
import { isFactoryLoopId, FLOW_SPEC_LOOP_ID } from '../../loops/runtime/loop-factory'
import { dominantTicketScope, referencesUnsupportedProviderCommand } from '../../loops/runtime/loop-command-catalog'
import { loopNeedsTicket, validateLoopGraph, type LoopGraph } from '../../loops/runtime/loop-graph'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import { getActivePrDeliveryByRail, toPrDeliverySnapshot, transitionDecision, type PrDecision, type PrDeliverySnapshot, isPreparationFailureRow } from './rail-pr-store'
import { emitPrDeliveryUpdate } from './rails-http-shared'
import { prDeliveryContinuesTickets, prDeliveryRevisionAllowed, hasDeliveredWork } from './rail-delivery-revision'
import type { LaunchLoopSelection, RailLaunchDoor, RailLaunchEngine, RailLaunchScope } from './rail-launch-admission'

/** The runnable graph of a loop launch. `checkEngineSupport` asks the caller
 *  to await `engineSupportRejection` for it before going further. */
export interface RailLoopGraph {
  loopGraph: LoopGraph
  loopName: string
  checkEngineSupport: boolean
}

/** The frozen execution choices of a loop launch. */
export interface RailLoopRunPlan {
  loopProvider: string
  loopModel: string
  effort: ReasoningEffort | undefined
  deciderEngine: ReturnType<typeof resolveLoopRoleEngine> | undefined
  ticketScope: ReturnType<typeof dominantTicketScope> | 'all' | 'per-ticket'
  /** Admitted launch choices recorded for Relaunch (never run ids or claims). */
  launchConfig: Record<string, unknown>
}

/** How a loop launch relates to the rail's active PR delivery. */
export interface RailPrContinuation {
  continuablePrDelivery: PrDeliverySnapshot | null
  revisionRequest: { ofDeliveryId: string; decision: PrDecision; note: string } | null
  retryOfDelivery: { deliveryId: string; decision: PrDecision } | null
}

/** Graph stage: the built-in (published edit or code default) or library
 *  loop to run on the rail, validated for rail use. */
export function resolveRailLoopGraph(door: RailLaunchDoor, loopId: string, selection: LaunchLoopSelection): RailLoopGraph | null {
  const { res } = door
  const { builtinSelection, librarySelection } = selection
  if (isFactoryLoopId(loopId)) {
    // Editable built-ins: an edited row runs its Published graph (or the
    // last Published snapshot while an edit is Draft); otherwise the
    // current code default for this Core.
    const f = builtinSelection
    // Intent -> Spec exists only on a Core that advertises `deriveChange`.
    if (!f && loopId === FLOW_SPEC_LOOP_ID) {
      res.status(409).json({ error: 'engine_unsupported', detail: 'Update Core to run the Intent → Spec loop (derive-change).' }); return null
    }
    if (!f) { res.status(404).json({ error: 'Factory loop not found' }); return null }
    if (f.source !== 'default') {
      const validation = validateLoopGraph(f.graph)
      if (!validation.valid) {
        res.status(422).json({ error: 'Loop graph is invalid', errors: validation.errors }); return null
      }
    }
    return { loopGraph: f.graph, loopName: f.name, checkEngineSupport: f.source !== 'default' }
  }
  const loop = librarySelection
  if (!loop) { res.status(404).json({ error: 'Loop not found' }); return null }
  if (loop.status !== 'published') {
    res.status(400).json({ error: 'Loop must be published before it can run on a rail' }); return null
  }
  const validation = validateLoopGraph(loop.graph)
  if (!validation.valid) {
    res.status(422).json({ error: 'Loop graph is invalid', errors: validation.errors }); return null
  }
  // A standalone loop (no {{spec.*}} and no ticket command) ignores the
  // rail's spec — it would just re-run once per ticket. Those belong to
  // the Loops page "Run" action; reject them here as a defence-in-depth
  // behind the rail picker, which already hides them.
  if (!loopNeedsTicket(loop.graph)) {
    res.status(400).json({ error: 'This loop runs standalone — launch it from the Loops page, not a rail.' }); return null
  }
  return { loopGraph: loop.graph, loopName: loop.name, checkEngineSupport: true }
}

/** Plan stage: provider capability checks, model/effort resolution (body >
 *  recipe > profile > global Specrails Agents defaults > adapter default),
 *  the Decider engine, the ticket scope and the frozen launch config. */
export function planRailLoopRun(
  door: RailLaunchDoor, scope: RailLaunchScope, engine: RailLaunchEngine, loopGraph: LoopGraph,
): RailLoopRunPlan | null {
  const { c, req, res, launch } = door
  const { mode, loopId, model, reasoning_effort, runtimeProviderOverride, baseBranch, baseDeliveryIds, targetPrNumber, followUp } = launch
  const { repositoryIds, workspaceSelection } = scope
  const { railProvider, ownsLoopEngine, loopAgents, resolvedProfile, rolesMode, loopRoleEngines, localEngine } = engine
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
    return null
  }
  if (!ownsLoopEngine && typeof model === 'string' && model && !isValidModelForProvider(model, loopProvider as SpecProvider)) {
    res.status(400).json({ error: `model is not valid for provider "${loopProvider}"`, allowed: getModelsForProvider(loopProvider as SpecProvider) }); return null
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
      return null
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
      }); return null
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
    return null
  }
  // The loop's command(s) declare ticket scope + required capabilities.
  const promptsText = loopGraph.nodes
    .filter((n) => n.type === 'ai-step')
    .map((n) => String(n.data?.prompt ?? ''))
    .join('\n')
  if (referencesUnsupportedProviderCommand(promptsText, loopProvider)) {
    res.status(400).json({ error: `This loop uses a command unsupported by provider '${loopProvider}'` }); return null
  }
  const ticketScope = loopGraph.config.ticketScope ?? (loopGraph.config.journal === 'implementation' ? 'all' : dominantTicketScope(promptsText))
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
  return { loopProvider, loopModel, effort, deciderEngine, ticketScope, launchConfig }
}

/**
 * PR continuation stage (ask-first PR delivery): decides whether this launch
 * revises, retries or continues the rail's active delivery, or must refuse.
 * A preparation-failure generation is closed in place (relaunch IS the
 * decision). Runs even when the worktree kill-switch is off.
 */
export function resolvePrContinuation(door: RailLaunchDoor, scope: RailLaunchScope): RailPrContinuation | null {
  const { c, res, railIndex, relaunchSource } = door
  const { revisionOfDeliveryId, revisionNote, targetPrNumber } = door.launch
  const { launchAddenda, rail, repositoryIds } = scope
  let continuablePrDelivery: PrDeliverySnapshot | null = null
  let revisionRequest: { ofDeliveryId: string; decision: PrDecision; note: string } | null = null
  let retryOfDelivery: { deliveryId: string; decision: PrDecision } | null = null
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
        }); return null
      }
      if (transitionDecision(c.db, pending.id, 'pr_failed', 'discarded', { deliveryOutcome: 'not_started', statusCode: 'discarded' })) {
        emitPrDeliveryUpdate(c, pending.id)
        pending = undefined
      }
    }
    const pendingSnapshot = pending ? toPrDeliverySnapshot(pending) : null
    if (revisionOfDeliveryId && !pendingSnapshot) {
      res.status(409).json({ error: 'invalid_revision_target', detail: 'The delivery is no longer active; refresh before continuing.' }); return null
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
      }); return null
    }
    if (pendingSnapshot && !revisionOfPending && !failedAddendumRetry && !identifiedFailureRetry && !prDeliveryContinuesTickets(pendingSnapshot, rail.ticketIds)) {
      res.status(409).json({ error: 'pr_decision_pending', prDeliveryId: pendingSnapshot.id }); return null
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
      res.status(409).json({ error: 'pr_decision_pending', prDeliveryId: pendingSnapshot.id }); return null
    }
    if (pendingSnapshot?.executionManifest) {
      const previousIds = pendingSnapshot.executionManifest.selectedRepositoryIds
      if (previousIds.length !== repositoryIds.length || previousIds.some((id) => !repositoryIds.includes(id))) {
        res.status(409).json({ error: 'delivery_repository_scope_changed', detail: 'A follow-up must retain the delivered repository scope.' }); return null
      }
    }
    continuablePrDelivery = pendingSnapshot
  }
  return { continuablePrDelivery, revisionRequest, retryOfDelivery }
}
