/**
 * Isolated rail launch contracts: the launch input, the injectable IO, the
 * allocated/settled run records that settlement and durable reattachment
 * persist, and the stop / continuation-isolation vocabulary they share.
 */
import type { RuntimeProviderOverride } from '../../agent-runtime/runtime/agent-runtime-settings'
import type { WorktreeHandle } from '../../../worktree-manager'
import type { RequiredFlowWorktree } from './flow-worktree-handoff'
import type { IsolatedBranchOwnership, IsolatedWorktreeIO, IsolatedWorktreeOwnership } from './isolated-worktree'
import { harvestDeliveryEvidence } from './delivery-evidence'
import type {
  PrDecision, PrDeliveryOutcome, PrDeliveryStatusCode, PrImplementationOutcome, PrOriginSurface,
} from './rail-pr-store'
import { PR_CI_LOOP_ID } from './pr-ci/pr-ci-target'
import type { OverlayCleanupEvidence } from '../../../worktree-overlay'
import type { PrFollowUp } from './pr-follow-up'
import type { WorkingTreeSnapshot } from '../../code/runtime/file-provenance'
import { recordLoopRunProvenance } from '../../code/runtime/file-story'
import type { Exec } from './pr-publisher'
import type { ActivePrContinuationTarget } from './active-pr-continuation'
import type { LoopGraph } from '../../loops/runtime/loop-graph'
import type { ProjectContext } from '../../../project-registry'
import type { ReasoningEffort } from '../../../providers/types'

export interface IsolatedLaunchInput {
  launchConfig?: Record<string, unknown>
  /** Spec triage (launch-triage): recorded on the delivery row for triage accuracy. */
  loopChoice?: { recommendedLoop: string | null; chosenLoop: string | null } | null
  runtimeProviderOverride?: RuntimeProviderOverride
  /** Registered write targets. When omitted, use the specs' targets, then primary. */
  repositoryIds?: string[]
  workspaceSelection?: Record<string, string[]>
  repositoryContinuation?: { deliveryId: string; decision: PrDecision }
  /** Replace an undelivered failed generation without inheriting its checkout. */
  retryOfDelivery?: { deliveryId: string; decision: PrDecision }
  repositoryBaseBranches?: Record<string, string>
  repositoryBaseShas?: Record<string, string>
  /** Internal owner of runtime state when this launch is a repository child. */
  runtimeStateProject?: { path: string; slug?: string }
  /** Internal per-repository leg of one coordinated execution. Never accepted from HTTP. */
  repositoryExecution?: {
    parentDeliveryId: string
    repositoryId: string
    runIds: Map<number, string>
    primary: boolean
    revisionBranches?: Map<number, { branch: string; sha: string }>
    isAborted?: () => boolean
    expectedBaseSha?: string
    onSettled: (deliveryId: string | null) => void
  }
  profileName?: string | null
  /** Per-launch soft cap override (USD); 0 waives the default. Absent ⇒ the project/app default. */
  runCapUsd?: number
  ctx: ProjectContext
  railIndex: number
  ticketIds: number[]
  loopId: string
  loopName: string
  loopGraph: LoopGraph
  provider: string
  model: string
  effort?: ReasoningEffort
  /** Loop Decider engine when the rail launched by roles (hybrid-role-engines). */
  deciderEngine?: { provider: string; model: string; effort?: ReasoningEffort }
  /** How the rail fans out: `per-ticket` = one worktree+run per ticket; `all` =
   *  ONE worktree+run covering every ticket (e.g. `{{cmd:implement}}` which runs
   *  the whole batch in a single pipeline invocation). Default `per-ticket`. */
  scope?: 'per-ticket' | 'all'
  /** Which surface launched the rail (persisted on the rail_pr_deliveries row so
   *  the PR decision can be surfaced back at its origin). Default `dashboard`. */
  originSurface?: PrOriginSurface
  /** The launching agent-chat conversation id (agent-chat/MCP launches only);
   *  null/omitted for dashboard launches. */
  originConversationId?: string | null
  /** Called immediately after the PR-delivery row is inserted. */
  onPrDeliveryCreated?: (id: string) => void
  /** Explicit base branch (premium-milestone-progress): a milestone chain
   *  stacks chunk k+1 on chunk k's delivered branch. Resolved as the
   *  integration branch's `explicit` source; recorded as the delivery row's
   *  `base_branch`, so the PR (if any) is created stacked on it. */
  baseBranch?: string | null
  /** Router-established continuation contract. When present, resolving or
   * materializing any other branch is an error; never start fresh work. */
  requiredPrContinuation?: {
    deliveryId: string
    decision: Extract<PrDecision, 'pr_draft' | 'pr_ready'>
    branch: string
    baseBranch: string
    prUrl: string
    prNumber: number | null
    deliverySha: string
  }
  /** Intent hand-off contract (Intent mode): adopt exactly this Intent worktree —
   * same mount, branch and frozen HEAD — instead of allocating a fresh one.
   * Any discrepancy throws `IntentWorktreeMismatchError` before agents start. */
  requiredFlowWorktree?: RequiredFlowWorktree
  /** Explicit user-designated target PR (deliver-rail-into-existing-pr).
   * When present, this launch continues that exact open PR — automatic
   * continuation discovery is skipped and validation failure throws
   * `ExplicitPrTargetError` BEFORE any delivery row or worktree exists. */
  explicitPrTarget?: { prNumber: number }
  /** Revision of an undecided delivery (nontech-review-experience Wave 3): the
   * router has already verified the exemption. The new generation supersedes
   * that one and records the user's instruction, so packet v2 can show what was
   * asked to change and the version chain reads as v1 → v2. */
  revision?: {
    ofDeliveryId: string
    decision: PrDecision
    note: string
  }
  /** Frozen PR review follow-up scope (pr-follow-up-fixes): persisted on the
   * delivery row and appended to EVERY ai-step prompt of the run. The route has
   * validated and frozen it (id/version/hash) before the launch. */
  followUp?: PrFollowUp
}

/** A PR follow-up may only run on the verified PR branch in a dedicated
 * worktree. Routers must surface this error instead of degrading to shared cwd. */
export class PrContinuationIsolationError extends Error {
  readonly code = 'pr_continuation_isolation_required'

  constructor(message: string) {
    super(message)
    this.name = 'PrContinuationIsolationError'
  }
}

/** Injectable git/worktree IO (defaults to the real implementations) — lets the
 *  allocation + teardown logic be unit-tested without a real repo. */
export interface IsolatedLaunchIO extends IsolatedWorktreeIO {
  /** Code-Explorer provenance settle recorder (the pre-run snapshot lives in
   *  IsolatedWorktreeIO; injectable so unit tests need no real git repo). */
  recordProvenance?: typeof recordLoopRunProvenance
  /** Settle-time review-packet evidence harvest (injectable for tests). */
  harvestEvidence?: typeof harvestDeliveryEvidence
  /** Core `reviewBrief: 1` probe (injectable for tests). */
  reviewBriefCapability?: () => Promise<boolean>
  /** Phase-3 Core capabilities (spec trace, baseline, rules); injectable for tests. */
  phase3Capabilities?: () => Promise<import('../../agent-runtime/runtime/core-capabilities').CorePhase3Capabilities>
  /** gh-backed PR discovery for continuing already-open PR branches. */
  exec?: Exec
}

export interface AllocatedRun {
  /** The primary ticket (branch/ledger key). */
  ticketId: number
  /** Every ticket this run covers (= [ticketId] for per-ticket; all rail tickets for `all`). */
  ticketIds: number[]
  runId: string
  ledgerId: string
  handle: WorktreeHandle
  /** Worktree-relative overlay-owned paths — excluded from commitWorktree so
   *  the app's framework scaffolding never lands on the ticket branch/PR. */
  overlayExcludes: string[]
  /** Fingerprints proving the excluded paths are still allocator-owned. */
  overlayCleanupEvidence: OverlayCleanupEvidence[]
  /** Warm-dependency link fingerprints. Kept apart from the overlay evidence
   *  because overlay revalidation authenticates against the framework source,
   *  which a `node_modules` link has no entry in — folding them together would
   *  silently revoke them at settle. They are re-proven against the base repo
   *  instead and merged only into the durable record. */
  warmLinkEvidence: OverlayCleanupEvidence[]
  /** Immutable settlement snapshot of gitignored paths (captured the moment
   *  the worktree is proven clean). null = no ignored-release authorization. */
  settlementIgnoredPaths?: string[] | null
  /** Pre-run Code-Explorer snapshot of the fresh worktree (null when the
   *  explorer is disabled or the snapshot failed) — diffed at settle so
   *  isolated loop runs record file_provenance like QueueManager jobs do. */
  provenanceSnapshot: WorkingTreeSnapshot | null
  /** Existing open PR branch this run is intentionally continuing, if any. */
  continuationTarget: ActivePrContinuationTarget | null
  /** Ref the worktree was materialized/refreshed from (fresh/resume evidence). */
  baseRef: string
  /** Frozen integration/base commit used to detect foreign active changes. */
  hygieneBaseSha?: string | null
  /** HEAD observed before the loop starts. Null means Git could not prove it. */
  initialSha: string | null
  /** Ownership is captured at allocation so rollback cannot delete a borrowed
   *  PR branch or a pre-existing/resumable local branch. */
  branchOwnership: IsolatedBranchOwnership
  worktreeOwnership: IsolatedWorktreeOwnership
  /** Historical reconstruction cannot grant new automatic cleanup authority. */
  automaticRelease?: false
}

export interface SettledRun {
  run: AllocatedRun
  implementationOutcome: 'succeeded' | 'failed'
  deliveryOutcome: Extract<PrDeliveryOutcome, 'ready' | 'no_changes' | 'blocked' | 'not_started'>
  initialSha: string | null
  finalSha: string | null
  changed?: boolean
  failureCode?: PrDeliveryStatusCode
  failureDetail?: string
  /** False only after cleanliness and durable-ref checks prove force-removal safe. */
  safeToRelease: boolean
}

/** What a branch record says when a person stopped its run before delivery. */
export const RUN_STOPPED_DETAIL = 'Stopped before delivery; partial changes stay in its original worktree. Relaunch it when you want to continue.'

/**
 * A person stopped every run of this delivery before it delivered: report a
 * stop (`run_stopped`), not an implementation failure. Shared by fresh
 * settlement and recovered reattachment (server restart, then Stop) so both
 * classify the same facts the same way. Never a stop: a run that failed or
 * stalled on its own, a delivery that already has a PR (its PR keeps its own
 * status), or a CI loop generation (`factory:pr-ci` reports CI outcomes).
 * Multi-repository parents aggregate their children's codes instead
 * (`refreshRepositoryDeliveryGroup`).
 */
export function isStoppedByPerson(input: {
  loopId: string | null | undefined
  implementationOutcome: PrImplementationOutcome
  runOutcomes: ReadonlyArray<string | null | undefined>
  prUrl?: string | null
}): boolean {
  return input.implementationOutcome === 'failed'
    && input.loopId !== PR_CI_LOOP_ID
    && !input.prUrl
    && input.runOutcomes.length > 0
    && input.runOutcomes.every(outcome => outcome === 'stopped')
}
