// Rail launch door, request stages: resolve a Relaunch to its original source
// (or hand a CI loop generation back to the Fix CI admission), then shape-
// validate and freeze the launch choices. Nothing here admits, allocates or
// spawns. Every stage of the launch door answers a refused request itself and
// returns null; otherwise it returns its explicit output.

import type { Request, Response } from 'express'
import type { ProjectContext } from '../../../project-registry'
import { FollowUpValidationError, freezeFollowUp, parseFollowUpInput, type PrFollowUp } from './pr-follow-up'
import { validateRuntimeProviderOverride, type RuntimeProviderOverride } from '../../agent-runtime/runtime/agent-runtime-settings'
import { isLoopsEnabled } from '../../../feature-flags'
import { PR_CI_LOOP_ID } from '../../loops/runtime/loop-pr-ci-recipe'
import { getPrDelivery, type RailPrDeliveryRow } from './rail-pr-store'
import { isFactoryLoopId, isRetiredFactoryLoopId, factoryLoopMode, canonicalFactoryLoopId, factoryLoopForMode, FLOW_SPEC_LOOP_ID, RETIRED_FACTORY_REPLACEMENT_ID } from '../../loops/runtime/loop-factory'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import { IntentHandOffNotReadyError, type RequiredFlowWorktree } from './flow-worktree-handoff'
import { resolveRailRelaunch, RailRelaunchError, type RailRelaunch } from './rail-relaunch'
import { isValidBranchName } from '../../../integration-branch'
import { VALID_MODES, normalizeRailMode } from './rails-http-shared'
import { hasDeliveredWork } from './rail-delivery-revision'

/** Outcome of the relaunch stage: a CI loop generation re-enters Fix CI;
 *  anything else continues the ordinary launch (with its frozen source). */
export type RelaunchResolution =
  | { kind: 'pr-ci'; source: RailPrDeliveryRow }
  | { kind: 'launch'; relaunchSource: RailRelaunch | undefined }

/**
 * The shape-validated launch request. `mode`, `loopId`, `baseBranch` and
 * `runtimeProviderOverride` stay mutable: later stages derive the factory
 * loop (spec addenda), the stacked base (base deliveries) and the effective
 * engine override exactly where the original single handler did.
 * Body fields keep the request's own (unvalidated) types.
 */
export interface RailLaunchRequest {
  runtimeProviderOverride: RuntimeProviderOverride | undefined
  mode: string
  loopId: unknown
  /** The caller chose a workflow (loopId or mode) rather than the default. */
  explicitLoop: boolean
  rawRepositoryIds: any
  rawWorkspaceSelection: any
  baseDeliveryIds: any
  profileName: any
  aiEngine: any
  model: any
  reasoning_effort: any
  originConversationId: any
  originSurface: any
  targetPrNumber: any
  revisionOfDeliveryId: any
  revisionNote: any
  runCapUsd: number | undefined
  followUp: PrFollowUp | undefined
  baseBranch: string | null
  flowWorktree: (RequiredFlowWorktree & { ticketId: number }) | null
}

/** Relaunch stage: binds `/relaunch` to its original source before any launch
 *  option is read, never to the mutable slot's new specs. Rewrites `req.body`
 *  to the source's frozen launch configuration. */
export function resolveRelaunchSource(
  c: ProjectContext, req: Request, res: Response, railIndex: number, isPrCiLaunch: boolean,
): RelaunchResolution | null {
  let relaunchSource: RailRelaunch | undefined
  if (/\/relaunch\/?$/i.test(req.path) && !isPrCiLaunch) {
    // pr-ci-loop: running a CI loop generation again means watching its PR
    // again, through the Fix CI admission (never a generic relaunch).
    const ciSource = typeof req.body?.sourceId === 'string' ? getPrDelivery(c.db, req.body.sourceId) : undefined
    if (ciSource && ciSource.loop_id === PR_CI_LOOP_ID && ciSource.rail_index === railIndex) {
      return { kind: 'pr-ci', source: ciSource }
    }
    try {
      if (!isLoopsEnabled()) {
        res.status(409).json({ error: 'relaunch_workflow_unavailable', detail: 'The original loop workflow cannot run while Loops are disabled.',
          action: 'Enable Loops before retrying this attempt.' }); return null
      }
      relaunchSource = resolveRailRelaunch(c, railIndex, req.body?.sourceId)
      if (relaunchSource.delivery && !isRailPrDeliveryEnabled()) {
        res.status(409).json({ error: 'relaunch_delivery_unavailable', detail: 'The original attempt belongs to isolated PR delivery, which is disabled.',
          action: 'Enable PR delivery before retrying this attempt.' }); return null
      }
      if (relaunchSource.delivery && hasDeliveredWork(relaunchSource.delivery)) {
        res.status(409).json({ error: 'relaunch_requires_recovery',
          detail: 'This attempt has delivered work that must be recovered before it can be retried.',
          action: 'Use Recover & retry or the delivery actions on this card.' }); return null
      }
      req.body = { ...relaunchSource.config,
        originConversationId: req.body?.originConversationId ?? relaunchSource.delivery?.originConversationId,
        originSurface: req.body?.originSurface ?? relaunchSource.delivery?.originSurface ?? 'dashboard',
      }
    } catch (error) {
      res.status(409).json({ error: error instanceof RailRelaunchError ? error.code : 'relaunch_config_unavailable',
        detail: error instanceof Error ? error.message : String(error),
        action: error instanceof RailRelaunchError ? error.action : 'Configure a fresh launch on a free rail.' }); return null
    }
  }
  return { kind: 'launch', relaunchSource }
}

/** Request stage: shape validation, frozen follow-up scope, Intent hand-off
 *  resolution and the mode → factory-loop derivation. Records the derived
 *  mode on the relaunch source's config. */
export function parseRailLaunchRequest(
  c: ProjectContext, req: Request, res: Response, relaunchSource: RailRelaunch | undefined, isPrCiLaunch: boolean,
): RailLaunchRequest | null {
  let runtimeProviderOverride
  try { runtimeProviderOverride = validateRuntimeProviderOverride(req.body?.runtimeProviderOverride) }
  catch { res.status(400).json({ error: 'invalid_runtime_provider_override' }); return null }
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
        res.status(400).json({ error: 'invalid_follow_up', code: err.code, detail: err.message }); return null
      }
      throw err
    }
    if (typeof targetPrNumber !== 'number' && !revisionOfDeliveryId) {
      res.status(400).json({ error: 'follow_up_requires_target', detail: 'followUp needs the pull request to follow up on: pass targetPrNumber (an open PR) or revisionOfDeliveryId (an undecided delivery)' }); return null
    }
  }
  // Revision launch (nontech-review-experience Wave 3): the user asked for a
  // change to a delivery that is already awaiting their decision. Shape is
  // validated here; the narrow guard exemption is enforced below.
  if (revisionOfDeliveryId !== undefined && revisionOfDeliveryId !== null) {
    if (typeof revisionOfDeliveryId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(revisionOfDeliveryId)) {
      res.status(400).json({ error: 'invalid_revision_target', detail: 'revisionOfDeliveryId must be a delivery id' }); return null
    }
    if (typeof revisionNote !== 'string' || revisionNote.trim().length === 0) {
      res.status(400).json({ error: 'revision_note_required', detail: 'revisionNote must describe the change to make' }); return null
    }
  }
  // Explicit target PR (deliver-rail-into-existing-pr): the user names an
  // existing open PR as the delivery destination. Shape-validated here;
  // resolved and verified inside the isolated launch, fail-closed.
  if (targetPrNumber !== undefined && targetPrNumber !== null) {
    if (typeof targetPrNumber !== 'number' || !Number.isSafeInteger(targetPrNumber) || targetPrNumber <= 0 || targetPrNumber > 1_000_000_000) {
      res.status(400).json({ error: 'invalid_target_pr', detail: 'targetPrNumber must be a positive integer' }); return null
    }
  }
  // Explicit base branch (premium-milestone-progress): a milestone chain
  // stacks chunk k+1 on chunk k's delivered branch. Shape-validated here;
  // resolved locally and isolation-gated below. Never silently ignored.
  let baseBranch: string | null = null
  if (rawBaseBranch !== undefined && rawBaseBranch !== null) {
    if (typeof rawBaseBranch !== 'string' || !isValidBranchName(rawBaseBranch)) {
      res.status(400).json({ error: 'invalid_base_branch', detail: 'baseBranch must be a valid local branch name' }); return null
    }
    baseBranch = rawBaseBranch
  }
  if (baseBranch && !isLoopsEnabled()) {
    res.status(400).json({ error: 'base_branch_requires_isolation', detail: 'baseBranch requires an isolated (worktree) loop launch; loops are disabled' }); return null
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
      res.status(400).json({ error: 'invalid_flow_id' }); return null
    }
    if (relaunchSource || revisionOfDeliveryId || targetPrNumber !== undefined && targetPrNumber !== null || followUp || baseBranch || baseDeliveryIds !== undefined) {
      res.status(400).json({ error: 'flow_handoff_incompatible', detail: 'An Intent session hand-off launches the Intent spec on its own worktree only' }); return null
    }
    if (!isLoopsEnabled()) {
      res.status(409).json({ error: 'flow_requires_isolation', detail: 'An Intent session hand-off needs Loops and worktree isolation' }); return null
    }
    if (!c.flowHandOff) { res.status(409).json({ error: 'feature_unavailable', detail: 'Intent is not available in this project' }); return null }
    try {
      flowWorktree = c.flowHandOff.resolve(rawFlowId)
    } catch (err) {
      if (err instanceof IntentHandOffNotReadyError) { res.status(409).json({ error: err.code, detail: err.message }); return null }
      throw err
    }
  } else if (rawLoopId === FLOW_SPEC_LOOP_ID) {
    res.status(400).json({ error: 'flow_id_required', detail: 'The Intent -> Spec loop is launched from an Intent session hand-off' }); return null
  }
  // The PR CI loop runs only on an attached PR, through `POST /:railIndex/pr-ci`.
  if (rawLoopId === PR_CI_LOOP_ID && !isPrCiLaunch) {
    res.status(400).json({ error: 'pr_ci_requires_delivery', detail: 'The PR CI loop is started from a delivery with POST /rails/:railIndex/pr-ci' }); return null
  }
  // Origin link (safe-pr-review-flow): an agent-chat/MCP launch tags itself so
  // the PR decision can later be posted back into the launching conversation.
  // Both fields are optional; malformed values are rejected outright.
  if (originConversationId !== undefined && originConversationId !== null) {
    if (typeof originConversationId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(originConversationId)) {
      res.status(400).json({ error: 'originConversationId must be 1-64 chars of [A-Za-z0-9-]' }); return null
    }
  }
  if (originSurface !== undefined && originSurface !== 'dashboard' && originSurface !== 'agent-chat') {
    res.status(400).json({ error: "originSurface must be 'dashboard' or 'agent-chat'" }); return null
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
    }); return null
  }
  // rails-as-loops: a FACTORY loop id (`factory:implement` etc.) maps to its
  // legacy mode for validation/back-compat; the loop branch below still runs
  // it through the LoopRunManager. A CUSTOM loop id keeps mode='loop'.
  if (typeof loopId === 'string' && isFactoryLoopId(loopId)) {
    const fmode = factoryLoopMode(loopId)
    if (!fmode) { res.status(404).json({ error: 'Factory loop not found' }); return null }
    loopId = canonicalFactoryLoopId(loopId)! // canonicalize saved legacy aliases
    mode = fmode
  }
  if (relaunchSource) relaunchSource.config = { ...relaunchSource.config, mode }
  if (!VALID_MODES.has(mode as string)) {
    res.status(400).json({ error: 'mode must be "implement" or "loop"' }); return null
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
    res.status(403).json({ error: 'Loops are disabled on this server' }); return null
  }
  // An explicit target PR is only meaningful on the isolated PR-delivery
  // path. Reject early when that path is structurally unavailable rather
  // than silently launching fresh work next to the designated PR.
  if (typeof targetPrNumber === 'number' && (!isLoopsEnabled() || !isRailPrDeliveryEnabled())) {
    res.status(400).json({ error: 'target_pr_requires_pr_mode', detail: 'targetPrNumber requires loops and PR delivery to be enabled' }); return null
  }
  if (followUp && (!isLoopsEnabled() || !isRailPrDeliveryEnabled())) {
    res.status(400).json({ error: 'follow_up_requires_pr_mode', detail: 'a PR review follow-up runs on the isolated PR-delivery path; loops and PR delivery must be enabled' }); return null
  }
  // Interactive in-job chat is ON by default for providers that expose the
  // spawn-time gate in QueueManager (kill-switch + persistent-stdin
  // capability) decides, so the launch no longer passes an explicit flag. A
  // legacy `interactive` body param is accepted and ignored (wire compat).
  return {
    runtimeProviderOverride, mode, loopId, explicitLoop,
    rawRepositoryIds, rawWorkspaceSelection, baseDeliveryIds, profileName, aiEngine, model, reasoning_effort,
    originConversationId, originSurface, targetPrNumber, revisionOfDeliveryId, revisionNote,
    runCapUsd, followUp, baseBranch, flowWorktree,
  }
}
