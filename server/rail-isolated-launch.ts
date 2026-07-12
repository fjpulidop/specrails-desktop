/**
 * Isolated (worktree-per-ticket) rail launch — the live wiring that turns the
 * tested building blocks (worktree-manager, merge-manager, rail-merge-orchestrator,
 * ledger) into a running parallel rail. Gated OFF by default (rail-isolation's
 * opt-in flag), so this path is inert unless explicitly enabled.
 *
 * Flow: allocate one worktree+branch per independent delivery → fan out the loop
 * runs IN those worktrees (so concurrent AI CLIs never collide) → when ALL runs
 * settle, run the sequential validated merge-back on the base repo, then clean
 * up worktrees. Tickets continuing one PR are grouped into its single checkout.
 *
 * The run spawns with cwd = the worktree (and repoDir = the worktree, so
 * writes/git land there). Because `git worktree add` materializes only TRACKED
 * files, each worktree gets a PER-RUN OVERLAY at allocation
 * (worktree-overlay.ts): the framework surface (`/specrails:*` commands, sr-*
 * agents, skills, rules, `.mcp.json`, the instruction file) is merge-linked in
 * from the project's EFFECTIVE artifact root — the workspace for RELOCATED
 * projects, the repo's own on-disk untracked entries for legacy ones — never
 * overwriting anything the checkout brought. Overlay entries are excluded from
 * `commitWorktree` so they never land on the ticket branch/PR; overlay failures
 * degrade (log + `rail.overlay_degraded` broadcast) instead of aborting the
 * rail. Relocated artifact state (tickets/backlog/profiles) reaches the spawn
 * via the executors' base env (see workspace-resolution.resolveLoopBaseEnv).
 */
import * as path from 'path'
import * as fs from 'fs'
import { resolveHome } from './artifact-registry'
import { newId } from './ids'
import { loadConstantMap } from './loop-constants'
import { defaultGitRunner, createWorktree, removeWorktree, commitWorktreeAndVerify, listLocalBranches, listWorktrees, worktreeBranch, PR_NEVER_STAGE_PATHSPEC_ROOTS, type GitRunner, type WorktreeHandle, type CommitWorktreeResult } from './worktree-manager'
import { createRailWorktree, updateRailWorktreeState, listNonTerminalRailWorktrees, railWorktreeBranchExistsForTicket, getRailWorktree, isTerminalMergeState } from './rail-worktrees-store'
import { ticketBranchName, ticketRef, resolveCollisionFreeName, type TicketNamingInput } from './pr-naming'
import { getLinkByLocalId } from './jira/jira-db'
import type { DbInstance } from './db'
import { getProjectSettings } from './db'
import { resolveIntegrationBranch, fetchOrigin, resolveWorktreeBaseRef, type ResolvedIntegrationBranch } from './integration-branch'
import { withRepoLock } from './repo-lock'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import {
  appendPrDeliverySafetyArchive, createPrDeliveryGeneration, failPrDeliveryAndRestoreSuperseded,
  getPrDelivery, reconcileFailedBuildingPrDeliveries, transitionDecision, toPrDeliverySnapshot,
  toRailPrStateMessage, toPrDecisionCardEnvelope,
  type DeliverBranchRecord, type PrDecision, type PrDeliveryOutcome,
  type PrDeliveryStatusCode, type PrImplementationOutcome, type PrOriginSurface,
  type SupersededPrDelivery,
} from './rail-pr-store'
import { getAgentChatManager } from './agent-chat-registry'
import { runMergeBack } from './rail-merge-orchestrator'
import { createLoopExecutors } from './loop-executors'
import {
  applyWorktreeOverlay, revalidateOverlayCleanupEvidence, OVERLAY_MANIFEST,
  type OverlayCleanupEvidence,
} from './worktree-overlay'
import { resolveProjectExecution } from './workspace-resolution'
import { isCodeExplorerEnabled } from './feature-flags'
import { snapshotWorkingTree, type WorkingTreeSnapshot } from './file-provenance'
import { recordLoopRunProvenance } from './file-story'
import { getAdapter } from './providers'
import { defaultExec, pushBranch, type Exec } from './pr-publisher'
import { resolveActivePrContinuationTargets, resolveExplicitPrTarget, type ActivePrContinuationTarget } from './active-pr-continuation'
import { isExactOpenPr, matchesRecordedPrIdentity, observePrLifecycle, verifyPushRemoteForPr } from './pr-lifecycle'
import { durableBranchHeads, durableOverlayCleanupEvidence, releaseRailWorktrees } from './rail-worktree-release'
import {
  commitCarriesRunMarker,
  discoverRunMarkedCommit,
  inspectRecoveryCommitProtection,
  listRecoveryCommitProtections,
  protectRecoveryCommit,
  recoveryRefForDelivery,
  releaseRecoveryCommit,
  scanUnreachableRecoveryCommits,
  type RecoveryCommitProtectionScan,
  type UnreachableRecoveryScan,
} from './rail-pr-recovery-git'
import type { BranchToMerge } from './merge-manager'
import type { LoopGraph } from './loop-graph'
import type { ProjectContext } from './project-registry'
import type { ReasoningEffort } from './providers/types'

export interface IsolatedLaunchInput {
  ctx: ProjectContext
  railIndex: number
  ticketIds: number[]
  loopId: string
  loopName: string
  loopGraph: LoopGraph
  provider: string
  model: string
  effort?: ReasoningEffort
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
  /** Explicit user-designated target PR (deliver-rail-into-existing-pr).
   * When present, this launch continues that exact open PR — automatic
   * continuation discovery is skipped and validation failure throws
   * `ExplicitPrTargetError` BEFORE any delivery row or worktree exists. */
  explicitPrTarget?: { prNumber: number }
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
export interface IsolatedLaunchIO {
  git?: GitRunner
  create?: typeof createWorktree
  remove?: typeof removeWorktree
  /** Per-run framework overlay applied to each fresh worktree. */
  overlay?: typeof applyWorktreeOverlay
  /** Resolves the project's execution (relocated vs legacy) — decides the
   *  overlay's source root (workspace vs repo). */
  resolveExecution?: typeof resolveProjectExecution
  /** Code-Explorer provenance: pre-run worktree snapshot + settle recorder
   *  (injectable so unit tests need no real git repo). */
  snapshot?: typeof snapshotWorkingTree
  recordProvenance?: typeof recordLoopRunProvenance
  /** gh-backed PR discovery for continuing already-open PR branches. */
  exec?: Exec
}

interface AllocatedRun {
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
  /** Pre-run Code-Explorer snapshot of the fresh worktree (null when the
   *  explorer is disabled or the snapshot failed) — diffed at settle so
   *  isolated loop runs record file_provenance like QueueManager jobs do. */
  provenanceSnapshot: WorkingTreeSnapshot | null
  /** Existing open PR branch this run is intentionally continuing, if any. */
  continuationTarget: ActivePrContinuationTarget | null
  /** Ref the worktree was materialized/refreshed from (fresh/resume evidence). */
  baseRef: string
  /** HEAD observed before the loop starts. Null means Git could not prove it. */
  initialSha: string | null
  /** Ownership is captured at allocation so rollback cannot delete a borrowed
   *  PR branch or a pre-existing/resumable local branch. */
  branchOwnership: 'created' | 'preexisting' | 'borrowed-pr'
  worktreeOwnership: 'created' | 'preexisting'
}

interface SettledRun {
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

/**
 * Ticket data for the conventional branch name (pr-naming): title/labels from
 * the ticket-spec reader, the Jira key resolved with the authoritative
 * `jira_links` row prevailing over the ticket's own `jira_key` field (JIRA
 * ALWAYS PREVAILS). Fully failure-tolerant — a missing store/link degrades to
 * the bare local ticket id.
 */
function unitNamingInput(ctx: ProjectContext, ticketId: number): TicketNamingInput {
  let spec: { title?: string; labels?: string[]; jira_key?: string | null } | undefined
  try {
    spec = ctx.getTicketSpec(ticketId) as typeof spec
  } catch {
    /* tolerated */
  }
  let jiraKey: string | null = spec?.jira_key ?? null
  try {
    const link = getLinkByLocalId(ctx.db, ticketId)
    if (link && !link.tombstoned && link.jiraKey) jiraKey = link.jiraKey
  } catch {
    /* tolerated */
  }
  return { ticketId, title: spec?.title ?? null, labels: spec?.labels ?? null, jiraKey }
}

/**
 * Commit messages are consumed by GitHub↔Jira development panels. Branch names
 * already carry the Jira key for new work; commits must too, especially when
 * continuing an existing PR whose branch name may predate the current ticket
 * key. Keep the local id as a fallback/cross-reference for Specrails.
 */
function worktreeCommitMessage(ctx: ProjectContext, ticketId: number, runId: string, partial = false): string {
  const input = unitNamingInput(ctx, ticketId)
  const ref = ticketRef(input)
  const subjectRef = ref === String(ticketId) ? `ticket-${ticketId}` : `${ref} ticket-${ticketId}`
  return `specrails: ${subjectRef}${partial ? ' partial' : ''} (run ${runId})`
}

function commitFailureSummary(result: CommitWorktreeResult): string {
  const dirty = result.dirty.length > 0 ? `; dirty=${result.dirty.slice(0, 8).join(', ')}` : ''
  return `${result.error ?? 'worktree still has uncommitted deliverable changes'}${dirty}`
}

const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i

async function recoveryCommitObjectExists(
  git: GitRunner,
  repoDir: string,
  sha: string,
): Promise<boolean> {
  if (!COMMIT_SHA_RE.test(sha)) return false
  try {
    return (await git.run(['cat-file', '-e', `${sha}^{commit}`], repoDir)).code === 0
  } catch {
    return false
  }
}

async function isFastForwardRecoveryCommit(
  git: GitRunner,
  repoDir: string,
  baselineSha: string,
  candidateSha: string,
): Promise<boolean> {
  if (!COMMIT_SHA_RE.test(baselineSha) || !COMMIT_SHA_RE.test(candidateSha)) return false
  if (baselineSha.toLowerCase() === candidateSha.toLowerCase()) return true
  try {
    return (await git.run(
      ['merge-base', '--is-ancestor', baselineSha, candidateSha],
      repoDir,
    )).code === 0
  } catch {
    return false
  }
}

async function releaseDeliveredRecoveryLineage(
  db: DbInstance,
  git: GitRunner,
  repoDir: string,
  delivery: NonNullable<ReturnType<typeof getPrDelivery>>,
  deliveredSha: string,
): Promise<void> {
  const currentProtection = await inspectRecoveryCommitProtection(git, repoDir, delivery.id)
  if (
    currentProtection.kind === 'present' &&
    currentProtection.sha.toLowerCase() === deliveredSha.toLowerCase()
  ) {
    await releaseRecoveryCommit(git, repoDir, delivery.id, deliveredSha)
  }
  const visited = new Set<string>([delivery.id])
  let predecessorId = delivery.supersedes_delivery_id
  for (let depth = 0; predecessorId && depth < 32 && !visited.has(predecessorId); depth++) {
    visited.add(predecessorId)
    const predecessor = getPrDelivery(db, predecessorId)
    if (!predecessor) break
    if (predecessor.decision !== 'discarded' && predecessor.decision !== 'superseded') break
    const protection = await inspectRecoveryCommitProtection(git, repoDir, predecessor.id)
    if (protection.kind === 'present' && await isFastForwardRecoveryCommit(
      git,
      repoDir,
      protection.sha,
      deliveredSha,
    )) {
      await releaseRecoveryCommit(git, repoDir, predecessor.id, protection.sha)
    }
    predecessorId = predecessor.supersedes_delivery_id
  }
}

/** Prove that the linked checkout is on the expected PR branch and that its
 * HEAD is exactly the commit named by refs/heads/<branch>. When expectedHeadSha
 * is supplied (allocation and pre-push phases), also freeze the checkout to
 * that immutable object. Post-run verification deliberately omits the old
 * baseline because a successful implementation is expected to create a new
 * commit. The handle's branch string alone is insufficient: createWorktree may
 * reuse a stale mounted path. */
async function verifyContinuationWorktree(
  git: GitRunner,
  repoDir: string,
  handle: WorktreeHandle,
  target: ActivePrContinuationTarget,
  expectedHeadSha?: string | null,
): Promise<string> {
  if (handle.branch !== target.branch) {
    throw new PrContinuationIsolationError(
      `PR branch ${target.branch} resolved to mounted branch ${handle.branch}; free the stale worktree and retry`,
    )
  }
  const checkedOut = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], handle.worktreePath)
  const actualBranch = checkedOut.code === 0 ? checkedOut.stdout.trim() : ''
  if (actualBranch !== target.branch) {
    throw new PrContinuationIsolationError(
      `worktree ${handle.worktreePath} is on ${actualBranch || 'an unverifiable ref'}, expected PR branch ${target.branch}; fix the checkout and retry`,
    )
  }
  const [head, branchRef] = await Promise.all([
    git.run(['rev-parse', '--verify', 'HEAD'], handle.worktreePath),
    git.run(['rev-parse', '--verify', `refs/heads/${target.branch}`], repoDir),
  ])
  const headSha = head.code === 0 ? head.stdout.trim() : ''
  const branchSha = branchRef.code === 0 ? branchRef.stdout.trim() : ''
  if (!COMMIT_SHA_RE.test(headSha) || headSha !== branchSha) {
    throw new PrContinuationIsolationError(
      `worktree HEAD does not match refs/heads/${target.branch}; reconcile the PR branch and retry`,
    )
  }
  if (expectedHeadSha !== undefined && (
    !expectedHeadSha || headSha.toLowerCase() !== expectedHeadSha.toLowerCase()
  )) {
    throw new PrContinuationIsolationError(
      `local PR branch ${target.branch} is not at the verified continuation commit; preserve or reconcile the local commits before retrying`,
    )
  }
  return headSha
}

async function readHeadSha(git: GitRunner, cwd: string): Promise<string | null> {
  try {
    const result = await git.run(['rev-parse', '--verify', 'HEAD'], cwd)
    const sha = result.code === 0 ? result.stdout.trim() : ''
    return COMMIT_SHA_RE.test(sha) ? sha : null
  } catch {
    return null
  }
}

async function branchHasDelta(git: GitRunner, cwd: string, baseRef: string): Promise<boolean | null> {
  try {
    const result = await git.run(['diff', '--quiet', `${baseRef}...HEAD`, '--'], cwd)
    if (result.code === 0) return false
    if (result.code === 1) return true
    return null
  } catch {
    return null
  }
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function aggregateImplementationOutcome(results: readonly SettledRun[]): PrImplementationOutcome {
  const succeeded = results.filter((result) => result.implementationOutcome === 'succeeded').length
  if (succeeded === results.length && results.length > 0) return 'succeeded'
  if (succeeded > 0) return 'partially_succeeded'
  return results.length > 0 ? 'failed' : 'unknown'
}

function branchRecords(results: readonly SettledRun[]): DeliverBranchRecord[] {
  return results.flatMap((result) => result.run.ticketIds.map((ticketId) => ({
    ticketId,
    branch: result.run.handle.branch,
    // Legacy consumers interpret this as delivery eligibility, not engine truth.
    succeeded: result.deliveryOutcome === 'ready',
    runId: result.run.runId,
    implementationOutcome: result.implementationOutcome,
    deliveryOutcome: result.deliveryOutcome,
    initialSha: result.initialSha,
    finalSha: result.finalSha,
    ...(result.changed === undefined ? {} : { changed: result.changed }),
    failureCode: result.failureCode ?? null,
    branchOwnership: result.run.branchOwnership,
    worktreePath: result.run.handle.worktreePath,
    overlayExcludes: result.run.overlayExcludes,
    overlayCleanupEvidence: result.run.overlayCleanupEvidence,
  })))
}

/**
 * Launch the rail's tickets in isolated worktrees + schedule the merge-back.
 * Returns the loop run ids. Throws if worktree allocation fails, but only after
 * tearing down owned partial allocation. A fresh launch may degrade to shared
 * cwd in the router; a PR continuation raises PrContinuationIsolationError and
 * must fail closed because shared cwd cannot prove which branch receives work.
 */
export async function launchIsolatedRail(input: IsolatedLaunchInput, io: IsolatedLaunchIO = {}): Promise<string[]> {
  const { ctx, railIndex, ticketIds, loopId, loopName, loopGraph, provider, model, effort } = input
  const git = io.git ?? defaultGitRunner
  const exec = io.exec ?? defaultExec
  const create = io.create ?? createWorktree
  const remove = io.remove ?? removeWorktree
  const overlay = io.overlay ?? applyWorktreeOverlay
  const resolveExecution = io.resolveExecution ?? resolveProjectExecution
  const baseRepo = ctx.project.path
  const slug = ctx.project.slug
  const worktreesRoot = path.join(resolveHome(), '.specrails', 'projects', slug, 'worktrees')
  const constants = loadConstantMap(ctx.desktopDb)
  // Capture the PR-delivery mode ONCE at launch entry so a mid-flight env flip
  // can never split one launch across the two delivery paths.
  const prMode = isRailPrDeliveryEnabled()

  // Ask-first PR delivery (safe-pr-review-flow): persist the authoritative
  // decision row UP FRONT (decision='building') — so the origin link survives
  // every await and late-joining clients hydrate mid-build via GET /rails —
  // and re-broadcast the durable rail.pr_state snapshot on every mutation.
  let prDeliveryId: string | null = null
  let supersededDelivery: SupersededPrDelivery | null = null
  // Origin-conversation card sync: when the launch came from an agent-chat
  // conversation, mirror the row's state into its inline decision card —
  // 'post' at launch (the user sees "working in an isolated worktree" from
  // second zero), 'update' on every later transition (settle, alloc-failure).
  // Null-safe: registry empty in tests / disabled builds; update falls back to
  // post when no card exists yet.
  const broadcastDeliveryState = (deliveryId: string): void => {
    const row = getPrDelivery(ctx.db, deliveryId)
    if (!row) return
    ctx.broadcast(toRailPrStateMessage(ctx.project.id, toPrDeliverySnapshot(row)))
  }
  const syncDeliveryCard = (deliveryId: string, verb: 'post' | 'update'): void => {
    const row = getPrDelivery(ctx.db, deliveryId)
    if (!row?.origin_conversation_id) return
    const mgr = getAgentChatManager()
    if (!mgr) return
    const envelope = toPrDecisionCardEnvelope(ctx.project.id, toPrDeliverySnapshot(row))
    if (verb === 'post') mgr.postPrDecisionCard(row.origin_conversation_id, envelope)
    else mgr.updatePrDecisionCard(row.origin_conversation_id, envelope)
  }
  const emitPrDeliveryState = (deliveryId: string, verb: 'post' | 'update'): void => {
    broadcastDeliveryState(deliveryId)
    syncDeliveryCard(deliveryId, verb)
  }
  const broadcastPrState = (): void => {
    if (prDeliveryId) broadcastDeliveryState(prDeliveryId)
  }
  const syncOriginCard = (verb: 'post' | 'update'): void => {
    if (prDeliveryId) syncDeliveryCard(prDeliveryId, verb)
  }
  const closeFailedGeneration = (err: unknown): void => {
    if (!prDeliveryId || getPrDelivery(ctx.db, prDeliveryId)?.decision !== 'building') return
    const closed = supersededDelivery
      ? failPrDeliveryAndRestoreSuperseded(ctx.db, prDeliveryId, supersededDelivery)
      : transitionDecision(ctx.db, prDeliveryId, 'building', 'discarded', {
          implementationOutcome: 'unknown',
          deliveryOutcome: 'blocked',
          statusCode: 'delivery_failed',
          statusDetail: errorDetail(err),
        })
    if (!closed) return
    try { emitPrDeliveryState(prDeliveryId, 'update') } catch { /* durable row is authoritative */ }
    if (supersededDelivery) {
      try { emitPrDeliveryState(supersededDelivery.id, 'update') } catch { /* durable row is authoritative */ }
    }
  }
  // Units of isolation: `all` → ONE unit covering every ticket (one worktree, one
  // run — the batch pipeline handles the tickets internally); `per-ticket` → one
  // unit per ticket. The branch/ledger key is the unit's primary (first) ticket.
  const scope = input.scope ?? 'per-ticket'
  let units: { ticketId: number; ticketIds: number[] }[] =
    scope === 'all'
      ? [{ ticketId: ticketIds[0], ticketIds: [...ticketIds] }]
      : ticketIds.map((id) => ({ ticketId: id, ticketIds: [id] }))

  // Effective artifact root for the per-worktree overlay: a RELOCATED project's
  // framework surface (slash commands, sr-* agents, skills, rules, .mcp.json,
  // instruction file) lives in the WORKSPACE, not the repo — and `git worktree
  // add` materializes only TRACKED files, so without the overlay a relocated
  // worktree spawn has no `/specrails:*` commands at all. Legacy projects
  // overlay their repo's own untracked on-disk entries instead. Resolved ONCE
  // per launch; a resolution failure degrades to the legacy (repo) source.
  let overlaySourceRoot = baseRepo
  try {
    const exec = resolveExecution({ slug, path: baseRepo })
    if (exec.relocated && exec.workspaceDir) overlaySourceRoot = exec.workspaceDir
  } catch { /* legacy fallback */ }
  let overlayProviderDir = '.claude'
  let overlayInstructions = 'CLAUDE.md'
  try {
    const adapter = getAdapter(input.provider)
    overlayProviderDir = adapter.projectDirName
    overlayInstructions = adapter.instructionsFilename
  } catch { /* unknown provider — claude-shaped defaults */ }
  // Degraded overlay = the run may be missing native commands/agents. Never
  // aborts the rail (a partial surface beats no run) but MUST be visible:
  // stderr-style server log + a project-scoped WS event.
  const notifyOverlayDegraded = (ticketId: number, warnings: string[]): void => {
    console.error(`[rail-isolated] worktree overlay degraded (ticket ${ticketId}): ${warnings.join('; ')}`)
    try {
      ctx.broadcast({ type: 'rail.overlay_degraded', projectId: ctx.project.id, railIndex, ticketId, warnings })
    } catch { /* non-fatal */ }
  }

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
  let integration!: ResolvedIntegrationBranch
  let launchContinuation: ActivePrContinuationTarget | null = null
  const allocated: AllocatedRun[] = []
  try {
    await withRepoLock(baseRepo, async () => {
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
  const fetchResult = await fetchOrigin(git, baseRepo)

  // Resolve the project's designated integration branch ONCE, and branch every
  // ticket's worktree off it (not the ambient HEAD). Empty setting → auto-resolve
  // (repo default → HEAD fallback). See server/integration-branch.ts.
  integration = await resolveIntegrationBranch(git, {
    repoDir: baseRepo,
    projectSetting: getProjectSettings(ctx.db).integrationBranch,
  })

  // Prefer the freshly-fetched remote-tracking ref (origin/<branch>) over the
  // bare local name for repo-default/project-setting sources — see
  // resolveWorktreeBaseRef for the exact fallback policy. `explicit` is left
  // completely untouched (rare, launch-time-chosen override).
  const worktreeBaseRef = await resolveWorktreeBaseRef(git, {
    repoDir: baseRepo, integration, fetchOk: fetchResult.ok,
  })
  if (worktreeBaseRef.warning) {
    console.warn(`[rail-isolated] ${worktreeBaseRef.warning} (repo ${baseRepo})`)
    try {
      ctx.broadcast({ type: 'rail.fetch_degraded', projectId: ctx.project.id, railIndex, warning: worktreeBaseRef.warning })
    } catch { /* non-fatal, mirrors notifyOverlayDegraded's broadcast guard below */ }
  }

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
            try { return ctx.getTicketSpec(ticketId) as ReturnType<typeof unitNamingInput> & { status?: string; description?: string } }
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

  if (prMode) {
    const generation = createPrDeliveryGeneration(ctx.db, {
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
    }, input.requiredPrContinuation
      ? { id: input.requiredPrContinuation.deliveryId, decision: input.requiredPrContinuation.decision }
      : null)
    prDeliveryId = generation.delivery.id
    supersededDelivery = generation.superseded
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

  // Conventional branch naming (pr-naming): `<type>/<ref>-<kebab-title>`, the
  // Jira key prevailing over the local id when linked. Collisions with foreign
  // branches suffix `-2`… (bounded); a branch a PRIOR rail run allocated for
  // the SAME ticket is ours to resume, so it is NOT treated as a collision.
  // The integration branch is never used; exhaustion falls back to the legacy
  // `sr/<slug>/ticket-<id>` name. Snapshot under the lock so concurrent
  // launches see each other's just-created branches.
  const takenBranches = await listLocalBranches(git, baseRepo)
  const preexistingBranches = new Set(takenBranches)
  const unitBranchName = (ticketId: number): { branch: string; ownership: AllocatedRun['branchOwnership'] } => {
    const continuation = launchContinuation && continuationTargets.get(ticketId)
    if (continuation) {
      takenBranches.add(continuation.branch)
      return { branch: continuation.branch, ownership: 'borrowed-pr' }
    }
    const preferred = ticketBranchName(unitNamingInput(ctx, ticketId))
    const branch = resolveCollisionFreeName(preferred, {
      taken: (name) => takenBranches.has(name) && !railWorktreeBranchExistsForTicket(ctx.db, ticketId, name),
      reserved: [integration.branch],
    }) ?? worktreeBranch(slug, ticketId)
    takenBranches.add(branch)
    return { branch, ownership: preexistingBranches.has(branch) ? 'preexisting' : 'created' }
  }

  try {
    for (const unit of units) {
      const continuationTarget = launchContinuation ? continuationTargets.get(unit.ticketId) ?? null : null
      const branchPlan = unitBranchName(unit.ticketId)
      let handle: WorktreeHandle | null = null
      let branchOwnership = branchPlan.ownership
      let worktreeOwnership: AllocatedRun['worktreeOwnership'] = 'created'
      let initialSha: string | null = null
      try {
        handle = await create(git, {
          repoDir: baseRepo,
          worktreesRoot,
          slug,
          ticketId: unit.ticketId,
          baseRef: continuationTarget?.baseRef ?? worktreeBaseRef.baseRef,
          branch: branchPlan.branch,
          refreshFromBaseRef: Boolean(continuationTarget?.baseRef),
        })
        worktreeOwnership = handle.worktreeCreated === false ? 'preexisting' : 'created'
        if (!continuationTarget && (handle.branch !== branchPlan.branch || handle.branchCreated === false)) {
          branchOwnership = 'preexisting'
        }
        if (continuationTarget) {
          initialSha = await verifyContinuationWorktree(
            git,
            baseRepo,
            handle,
            continuationTarget,
            continuationTarget.deliverySha,
          )
        } else {
          initialSha = await readHeadSha(git, handle.worktreePath)
        }

        // Per-run overlay: merge-link the framework surface the checkout didn't
        // bring into the worktree (idempotent; resume-safe via its manifest).
        let overlayExcludes: string[] = []
        let overlayCleanupEvidence: OverlayCleanupEvidence[] = []
        try {
          const res = overlay({
            worktreePath: handle.worktreePath,
            sourceRoot: overlaySourceRoot,
            providerDir: overlayProviderDir,
            instructionsFilename: overlayInstructions,
          })
          overlayExcludes = res.createdPaths
          overlayCleanupEvidence = res.cleanupEvidence ?? []
          if (res.warnings.length > 0) notifyOverlayDegraded(unit.ticketId, res.warnings)
        } catch (err) {
          // applyWorktreeOverlay never throws; this guards injected test doubles
          // and future edits — the spawn proceeds regardless.
          notifyOverlayDegraded(unit.ticketId, [err instanceof Error ? err.message : String(err)])
        }
        // Code-Explorer provenance: freeze the worktree's pre-run state (HEAD sha
        // + the overlay's untracked set) so the settle diff attributes exactly
        // the run's own writes. Best-effort — a snapshot failure only loses
        // provenance, never the run.
        let provenanceSnapshot: WorkingTreeSnapshot | null = null
        if (isCodeExplorerEnabled()) {
          try {
            provenanceSnapshot = (io.snapshot ?? snapshotWorkingTree)(handle.worktreePath)
          } catch (err) {
            console.warn(`[rail-isolated] provenance snapshot failed: ${(err as Error).message}`)
          }
        }
        const runId = newId()
        const ledgerId = newId()
        createRailWorktree(ctx.db, {
          id: ledgerId, railIndex, ticketId: unit.ticketId, runId,
          branch: handle.branch, worktreePath: handle.worktreePath,
        })
        allocated.push({
          ticketId: unit.ticketId,
          ticketIds: unit.ticketIds,
          runId,
          ledgerId,
          handle,
          overlayExcludes,
          overlayCleanupEvidence,
          provenanceSnapshot,
          continuationTarget,
          baseRef: continuationTarget?.baseRef ?? worktreeBaseRef.baseRef,
          initialSha,
          branchOwnership,
          worktreeOwnership,
        })
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
  } catch (err) {
    for (const a of allocated) {
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
    }) // withRepoLock — allocation done; the fan-out below runs in parallel.
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

  // 2. Fan out: one loop run per independent worktree. Same-PR tickets form one
  //    atomic batch run because git cannot mount one branch in multiple linked
  //    worktrees. In PR mode a COMPLETED run's tickets park at on_review (the
  //    user decides done vs discard via the PR flow); failures ignore the field.
  const runFinishedOpts = { ticketCompletionStatus: prMode ? ('on_review' as const) : ('done' as const) }
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
  const recordRunProvenance = (a: AllocatedRun): void => {
    if (provenanceRecorded.has(a.runId)) return
    provenanceRecorded.add(a.runId)
    try {
      recordProvenance({
        db: ctx.db,
        projectId: ctx.project.id,
        runId: a.runId,
        ticketId: a.ticketId,
        repoDir: a.handle.worktreePath,
        snapshot: a.provenanceSnapshot,
        broadcast: (msg) => ctx.broadcast(msg),
      })
    } catch (err) {
      console.warn(`[rail-isolated] provenance recording failed for ${a.runId}: ${errorDetail(err)}`)
    }
  }

  const markWorktree = (a: AllocatedRun, state: 'built' | 'failed' | 'needs-review'): string | null => {
    try {
      return updateRailWorktreeState(ctx.db, a.ledgerId, state)
        ? null
        : `worktree ledger ${a.ledgerId} no longer exists`
    } catch (err) {
      return errorDetail(err)
    }
  }

  /** This function resolves for every allocated unit. Engine truth is captured
   * before any delivery effect and is the only value sent to the deferred
   * terminal callback. Delivery failures become blocked evidence instead. */
  const settleAllocatedRun = async (
    a: AllocatedRun,
    enginePromise: Promise<{ runId: string; outcome: string }>,
  ): Promise<SettledRun> => {
    let actualOutcome = 'failed'
    let engineFailure: string | undefined
    try {
      const result = await enginePromise
      actualOutcome = result.outcome
    } catch (err) {
      engineFailure = errorDetail(err)
      console.error(`[rail-isolated] loop run ${a.runId} rejected: ${engineFailure}`)
    }

    const implementationOutcome = actualOutcome === 'success' ? 'succeeded' as const : 'failed' as const
    recordRunProvenance(a)

    let callbackFailure: string | undefined
    try {
      ctx.onLoopRunFinished(a.runId, actualOutcome, runFinishedOpts)
    } catch (err) {
      callbackFailure = errorDetail(err)
      console.error(`[rail-isolated] terminal callback failed for ${a.runId}: ${callbackFailure}`)
    }

    // The engine may have edited a copied overlay file. Re-authenticate only
    // automatic-cleanup authority. Allocation-time paths remain conservative
    // NEVER-COMMIT exclusions, while a modified copy is preserved in the
    // worktree instead of being silently staged or deleted.
    if (a.overlayCleanupEvidence.length > 0) {
      a.overlayCleanupEvidence = revalidateOverlayCleanupEvidence({
        worktreePath: a.handle.worktreePath,
        sourceRoot: overlaySourceRoot,
        providerDir: overlayProviderDir,
        instructionsFilename: overlayInstructions,
      }, a.overlayCleanupEvidence)
    }

    let commit: CommitWorktreeResult
    try {
      commit = await commitWorktreeAndVerify(
        git,
        a.handle.worktreePath,
        worktreeCommitMessage(ctx, a.ticketId, a.runId, implementationOutcome === 'failed'),
        a.overlayExcludes,
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
        safeToRelease: true,
      }
    }

    // A resumed non-PR branch may already contain reviewable commits from an
    // earlier attempt, even when this iteration itself did not add one.
    let resumedBranchDelta: boolean | null = null
    if (!changed && a.continuationTarget === null && a.branchOwnership === 'preexisting') {
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
      safeToRelease: true,
    }
  }

  const runPromises: Promise<SettledRun>[] = []
  for (const a of allocated) {
    ctx.railLoopRuns.set(a.runId, {
      railIndex,
      ticketIds: a.ticketIds,
      requiresTerminalIntent: true,
    })
    const spec = ctx.getTicketSpec(a.ticketId)
    const enginePromise = ctx.loopRunManager.run({
        runId: a.runId, loopId, loopName, graph: loopGraph, projectId: ctx.project.id,
        cwd: a.handle.worktreePath, repoDir: a.handle.worktreePath,
        isolation: { branch: a.handle.branch, worktreePath: a.handle.worktreePath },
        railIndex, ticketId: a.ticketId,
        spec: spec ? { ...spec, ticketIds: a.ticketIds } : { ticketIds: a.ticketIds },
        ticketCompletionStatus: runFinishedOpts.ticketCompletionStatus,
        deferTerminalOutcome: true,
        constants, provider, model, effort,
      })
    runPromises.push(settleAllocatedRun(a, enginePromise))
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

  // 3. When ALL runs settle → integrate on the base repo (background; the HTTP
  //    response has already returned the run ids). Two mutually-exclusive paths:
  //     • DEFAULT (flag off): legacy local merge-back into the checked-out branch.
  //     • PR mode (SPECRAILS_RAIL_DELIVER_PR on, captured at entry): leave the
  //       work isolated on its branches and mark the decision row on_review —
  //       the draft PR is only created when the user clicks [Create PR] on the
  //       pr-decision endpoint (ask-first, safe-pr-review-flow).
  const guardedRunPromises = runPromises.map((promise, index) => promise.catch(async (err): Promise<SettledRun> => {
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

  void Promise.all(guardedRunPromises).then(async (settledResults) => {
    // Cardinality is invariant: one structured result per allocated unit. The
    // guarded promises above synthesize a blocked record for any rejection.
    let results = settledResults

    if (prMode) {
      // Build-settle: persist the per-unit branch outcomes + this launch's
      // worktree ledger ids on the row (the deferred create-pr / discard actions
      // reconstruct their inputs from these — nothing survives in memory), then
      // hand the decision to the user. 0 succeeded units → nothing deliverable;
      // keep the implementation card visible as a failed job state with run-log
      // chips instead of silently auto-discarding or leaving it at "building".
      const worktreeIds = allocated.map((a) => a.ledgerId)
      let deliverySha: string | null = null
      let continuationPushFailed = false
      let continuationPushFailureReason: string | null = null
      let continuationNeedsNewPr = false
      let continuationExactPushCompleted = false
      let continuationRemoteIsDraft = launchContinuation?.isDraft ?? null
      let continuationMergedWithSha = false
      let continuationClosedWithSha = false
      let continuationLifecycleBlocked = false

      const unchangedContinuation = launchContinuation
        ? results.find((result) => result.run.continuationTarget && result.deliveryOutcome === 'no_changes')
        : undefined
      if (unchangedContinuation?.finalSha) deliverySha = unchangedContinuation.finalSha

      // Revalidate immediately before an existing-PR push. Settlement's SHA is
      // immutable delivery evidence; a moved ref blocks instead of substituting
      // a newer object behind the user's back.
      if (launchContinuation) {
        const candidateIndex = results.findIndex((result) =>
          result.deliveryOutcome === 'ready' && result.run.continuationTarget !== null,
        )
        if (candidateIndex >= 0) {
          const candidate = results[candidateIndex]
          try {
            const verified = await verifyContinuationWorktree(
              git,
              baseRepo,
              candidate.run.handle,
              candidate.run.continuationTarget!,
              candidate.finalSha,
            )
            if (!candidate.finalSha || verified !== candidate.finalSha) {
              throw new PrContinuationIsolationError('PR branch moved after settlement; refusing to push an unverified object')
            }
            deliverySha = candidate.finalSha
          } catch (err) {
            const detail = errorDetail(err)
            markWorktree(candidate.run, 'needs-review')
            results = results.map((result, resultIndex) => resultIndex === candidateIndex
              ? {
                  ...result,
                  deliveryOutcome: 'blocked' as const,
                  failureCode: 'branch_verification_failed' as const,
                  failureDetail: detail,
                  safeToRelease: false,
                }
              : result)
          }
        }
      }

      const implementationOutcome = aggregateImplementationOutcome(results)
      let ready = results.filter((result) => result.deliveryOutcome === 'ready')
      let blocked = results.filter((result) => result.deliveryOutcome === 'blocked')
      let noChanges = results.filter((result) => result.deliveryOutcome === 'no_changes')
      const continuationHadReadyWork = ready.length > 0

      if (launchContinuation && deliverySha && (continuationHadReadyWork || noChanges.length > 0)) {
        const beforePush = await observePrLifecycle(
          exec, baseRepo, launchContinuation.prUrl!, deliverySha,
        )
        if (!beforePush.ok) {
          continuationPushFailed = true
          continuationPushFailureReason = `could not confirm the existing PR is open before push: ${beforePush.detail}`
        } else if (!isExactOpenPr(beforePush, launchContinuation.branch, launchContinuation.baseBranch)) {
          const identityMatches = matchesRecordedPrIdentity(
            beforePush,
            launchContinuation.branch,
            launchContinuation.baseBranch,
          )
          if (beforePush.state === 'MERGED' && identityMatches && beforePush.includesExpectedSha === true) {
            // Another actor delivered the exact object before our push. Keep the
            // old PR attached so poll-merge can apply the terminal ticket effect.
            continuationRemoteIsDraft = false
            continuationMergedWithSha = true
          } else if (
            beforePush.state === 'CLOSED' && identityMatches &&
            beforePush.includesExpectedSha === true && !continuationHadReadyWork
          ) {
            // An unchanged iteration may safely offer Reopen when the closed PR
            // already contains its exact head. Changed work is never assumed to
            // belong to a closed PR before we push it.
            continuationClosedWithSha = true
          } else {
            continuationNeedsNewPr = true
            continuationPushFailureReason = beforePush.includesExpectedSha === null
              ? `the previous PR is ${beforePush.state.toLowerCase()} and GitHub could not prove it included this implementation; create a new draft PR from the preserved commit`
              : `the previous PR is ${beforePush.state.toLowerCase()} without this implementation; create a new draft PR from the preserved commit`
          }
        } else if (!continuationHadReadyWork) {
          // No-change still needs lifecycle truth: the PR may have merged while
          // the run was active, and an advanced remote head must not be silently
          // dismissed as though it were the verified unchanged object.
          if (beforePush.headRefOid?.toLowerCase() !== deliverySha.toLowerCase()) {
            continuationLifecycleBlocked = true
            continuationPushFailureReason = 'the open PR head no longer exposes the exact verified commit from this unchanged iteration'
          } else {
            continuationRemoteIsDraft = beforePush.isDraft
          }
        } else {
          continuationRemoteIsDraft = beforePush.isDraft
          const pushRemote = await verifyPushRemoteForPr(
            exec, baseRepo, launchContinuation.prUrl!,
          )
          if (!pushRemote.ok) {
            continuationPushFailed = true
            continuationPushFailureReason = `refusing to push the preserved implementation: ${pushRemote.detail}`
          } else {
            try {
              const pushed = await pushBranch(exec, {
                repoDir: baseRepo,
                branch: launchContinuation.branch,
                baseBranch: launchContinuation.baseBranch,
                remote: pushRemote.pushTarget,
                sourceSha: deliverySha,
              })
              if (pushed.state === 'local-only') {
                continuationPushFailed = true
                continuationPushFailureReason = pushed.reason
              } else {
                continuationExactPushCompleted = true
                const afterPush = await observePrLifecycle(
                  exec, baseRepo, launchContinuation.prUrl!, deliverySha,
                )
                if (!afterPush.ok) {
                  continuationPushFailed = true
                  continuationPushFailureReason = `exact commit was pushed, but the PR lifecycle could not be confirmed: ${afterPush.detail}`
                } else if (isExactOpenPr(afterPush, launchContinuation.branch, launchContinuation.baseBranch)) {
                  if (afterPush.headRefOid?.toLowerCase() === deliverySha.toLowerCase()) {
                    continuationRemoteIsDraft = afterPush.isDraft
                  } else {
                    // GitHub observation can lag a successful push, or another
                    // writer may have moved the remote head. The retry remains
                    // safe because it always uses the immutable SHA and a normal
                    // non-forced refspec; preserve evidence and keep Retry push.
                    continuationPushFailed = true
                    continuationPushFailureReason = 'the exact push completed, but the PR does not yet expose the verified commit as its head; Retry push remains safe and uses the preserved SHA'
                  }
                } else if (
                  afterPush.state === 'MERGED' &&
                  matchesRecordedPrIdentity(
                    afterPush,
                    launchContinuation.branch,
                    launchContinuation.baseBranch,
                  ) &&
                  afterPush.includesExpectedSha === true
                ) {
                  // The PR won the race but demonstrably included this exact SHA.
                  continuationRemoteIsDraft = false
                  continuationMergedWithSha = true
                } else if (
                  afterPush.state === 'CLOSED' &&
                  matchesRecordedPrIdentity(
                    afterPush,
                    launchContinuation.branch,
                    launchContinuation.baseBranch,
                  ) &&
                  afterPush.includesExpectedSha === true
                ) {
                  continuationClosedWithSha = true
                } else if (afterPush.state === 'MERGED' || afterPush.state === 'CLOSED') {
                  continuationNeedsNewPr = true
                  continuationPushFailureReason = afterPush.includesExpectedSha === null
                    ? `the previous PR became ${afterPush.state.toLowerCase()} and GitHub could not prove it included this implementation; create a new draft PR from the preserved commit`
                    : `the previous PR became ${afterPush.state.toLowerCase()} without this implementation; create a new draft PR from the preserved commit`
                } else {
                  continuationNeedsNewPr = true
                  continuationPushFailureReason = 'the existing PR no longer matches its recorded head/base after the exact push; create a new draft PR from the preserved commit'
                }
              }
            } catch (err) {
              continuationPushFailed = true
              continuationPushFailureReason = errorDetail(err)
            }
          }
        }
        if (continuationPushFailed) {
          console.warn(`[rail-isolated] existing PR follow-up push failed for ${launchContinuation.branch}: ${continuationPushFailureReason}`)
        }
      }

      if (continuationNeedsNewPr && noChanges.length > 0) {
        // The iteration itself made no new commit, but the old PR did not deliver
        // its verified head. That head is therefore real work for a fresh PR.
        const noChangeRuns = new Set(noChanges.map((result) => result.run.runId))
        results = results.map((result) => noChangeRuns.has(result.run.runId)
          ? { ...result, deliveryOutcome: 'ready' as const }
          : result)
      }
      if (continuationLifecycleBlocked) {
        const affectedRuns = new Set(
          results
            .filter((result) => result.run.continuationTarget !== null &&
              (result.deliveryOutcome === 'ready' || result.deliveryOutcome === 'no_changes'))
            .map((result) => result.run.runId),
        )
        for (const result of results) {
          if (affectedRuns.has(result.run.runId)) markWorktree(result.run, 'needs-review')
        }
        results = results.map((result) => affectedRuns.has(result.run.runId)
          ? {
              ...result,
              deliveryOutcome: 'blocked' as const,
              failureCode: 'branch_verification_failed' as const,
              failureDetail: continuationPushFailureReason ?? 'PR lifecycle verification failed',
              safeToRelease: false,
            }
          : result)
      }

      ready = results.filter((result) => result.deliveryOutcome === 'ready')
      blocked = results.filter((result) => result.deliveryOutcome === 'blocked')
      noChanges = results.filter((result) => result.deliveryOutcome === 'no_changes')

      let deliveryOutcome: PrDeliveryOutcome
      if (implementationOutcome === 'failed') {
        deliveryOutcome = blocked.length > 0 ? 'blocked' : 'not_started'
      } else if (continuationLifecycleBlocked) {
        deliveryOutcome = 'blocked'
      } else if (continuationMergedWithSha || continuationClosedWithSha) {
        deliveryOutcome = 'delivered'
      } else if (launchContinuation && ready.length > 0) {
        deliveryOutcome = continuationNeedsNewPr
          ? (implementationOutcome === 'partially_succeeded' ? 'partial' : 'ready')
          : continuationPushFailed ? 'retryable_failure' : 'delivered'
      } else if (ready.length > 0) {
        deliveryOutcome = implementationOutcome === 'partially_succeeded' || blocked.length > 0 ? 'partial' : 'ready'
      } else if (noChanges.length === results.length && implementationOutcome === 'succeeded') {
        deliveryOutcome = 'no_changes'
      } else if (implementationOutcome === 'partially_succeeded') {
        deliveryOutcome = 'partial'
      } else {
        deliveryOutcome = 'blocked'
      }

      const next: PrDecision = implementationOutcome === 'failed'
        ? 'implementation_failed'
        : continuationLifecycleBlocked
          ? 'pr_failed'
          : continuationMergedWithSha
            ? 'pr_ready'
            : continuationClosedWithSha
              ? 'pr_closed'
        : ready.length > 0
          ? (launchContinuation
              ? (continuationNeedsNewPr
                  ? 'on_review'
                  : continuationPushFailed
                  ? 'pr_failed'
                  : (continuationRemoteIsDraft === false ? 'pr_ready' : 'pr_draft'))
              : 'on_review')
          : deliveryOutcome === 'no_changes'
            ? 'no_changes'
            : 'pr_failed'

      const firstFailure = results.find((result) => result.failureCode)
      const statusCode: PrDeliveryStatusCode = implementationOutcome === 'failed'
        ? 'implementation_failed'
        : continuationLifecycleBlocked
          ? 'branch_verification_failed'
          : continuationMergedWithSha
            ? 'pr_ready'
            : continuationClosedWithSha
              ? 'pr_closed'
              : continuationNeedsNewPr
          ? 'ready_for_review'
          : continuationPushFailed
          ? 'push_failed'
          : deliveryOutcome === 'no_changes'
            ? 'no_changes'
            : implementationOutcome === 'partially_succeeded'
              ? 'partial_success'
              : firstFailure?.failureCode
                ?? (launchContinuation && ready.length > 0 ? 'existing_pr_updated' : 'ready_for_review')
      const statusDetail = continuationPushFailureReason ?? firstFailure?.failureDetail ?? null

      // Only proven-clean, durably referenced results are automatically
      // detached. Fresh reviewable worktrees stay mounted for the later PR
      // decision; dirty/unknown/ref-mismatched work is never passed to --force.
      const failedSafeIds = results
        .filter((result) => result.implementationOutcome === 'failed' && result.safeToRelease)
        .map((result) => result.run.ledgerId)
      const completedSafeIds = results
        .filter((result) => result.safeToRelease && (
          result.deliveryOutcome === 'no_changes' ||
          (launchContinuation !== null && result.deliveryOutcome === 'ready')
        ))
        .map((result) => result.run.ledgerId)
      const settledBranchRecords = branchRecords(results)
      const expectedHeadByBranch = durableBranchHeads(settledBranchRecords)
      const overlayEvidenceByBranch = durableOverlayCleanupEvidence(settledBranchRecords)
      const patch = {
        branches: settledBranchRecords,
        worktreeIds,
        implementationOutcome,
        deliveryOutcome,
        statusCode,
        statusDetail,
        deliverySha,
        ...(launchContinuation ? {
          branch: launchContinuation.branch,
          prUrl: continuationNeedsNewPr ? null : launchContinuation.prUrl,
          prNumber: continuationNeedsNewPr ? null : launchContinuation.prNumber,
          // A stale CLOSED/MERGED PR is detached from this generation. The exact
          // object remains locally or on its recorded branch, ready for Create PR.
          prState: continuationNeedsNewPr
            ? (continuationExactPushCompleted ? 'pushed' as const : 'local-only' as const)
            : 'pr-created' as const,
          // Once detached, this generation owns the lifecycle of the new PR,
          // while per-unit branchOwnership still protects the borrowed branch.
          isContinuation: !continuationNeedsNewPr,
        } : {}),
      }
      if (prDeliveryId && transitionDecision(ctx.db, prDeliveryId, 'building', next, patch)) {
        // Persist truthful settlement before cleanup. A crash can leave a
        // safely-recoverable mount, but can no longer lose no-change/partial/
        // exact-SHA evidence and regress the card back to `building`.
        const settledPrDeliveryId = prDeliveryId
        const onSafetyArchive = (archive: string): void => {
          if (!appendPrDeliverySafetyArchive(ctx.db, settledPrDeliveryId, archive)) {
            throw new Error(`delivery ${settledPrDeliveryId} disappeared while recording safety archive ${archive}`)
          }
        }
        const cleanupWarnings = [
          ...await releaseRailWorktrees({
            db: ctx.db, git, repoDir: baseRepo, worktreeIds: failedSafeIds,
            state: 'failed', remove, expectedHeadByBranch, overlayEvidenceByBranch, onSafetyArchive,
          }),
          ...await releaseRailWorktrees({
            db: ctx.db, git, repoDir: baseRepo, worktreeIds: completedSafeIds,
            remove, expectedHeadByBranch, overlayEvidenceByBranch, onSafetyArchive,
          }),
        ]
        if (cleanupWarnings.length > 0) {
          transitionDecision(ctx.db, prDeliveryId, next, next, { cleanupWarnings })
        }
        broadcastPrState()
        // Completion driver: refresh the origin conversation's card in place —
        // on_review asks the question, discarded informs the outcome.
        syncOriginCard('update')
      }
      return // legacy merge-back never runs in PR mode
    }

    const branches: BranchToMerge[] = results.flatMap((result) =>
      result.run.ticketIds.map((ticketId) => ({
        ticketId,
        branch: result.run.handle.branch,
        succeeded: result.deliveryOutcome === 'ready',
      })),
    )

    try {
      const outcomes = await runMergeBack({
        git, executor: createLoopExecutors(), baseDir: baseRepo,
        provider, model, effort, constants, branches,
        // CRIT-2: record every merge-back AI step (verify/resolve-merge/fix) as a
        // `surface='job'` invocation tied to the rail (surface_ref_id
        // `${jobId}:merge:${step}`), primary ticket = ticketIds[0].
        recording: {
          db: ctx.db,
          projectId: ctx.project.id,
          jobId: `rail-${railIndex}-${loopId}`,
          ticketId: ticketIds[0] ?? null,
          broadcast: (msg) => ctx.broadcast(msg),
        },
        onState: (ticketId, state) => {
          const r = results.find((x) => x.run.ticketId === ticketId)
          if (state === 'merged' || state === 'needs-review') {
            if (r) updateRailWorktreeState(ctx.db, r.run.ledgerId, state)
            ctx.broadcast({ type: 'rail.worktree_progress', projectId: ctx.project.id, railIndex, ticketId, state })
          }
        },
      })
      for (const o of outcomes) {
        const r = results.find((x) => x.run.ticketId === o.ticketId)
        if (!r) continue
        if (!r.safeToRelease) {
          updateRailWorktreeState(ctx.db, r.run.ledgerId, 'needs-review')
          continue
        }
        // Merged → drop the branch; needs-review / skipped → keep the branch for the human.
        await remove(git, {
          repoDir: baseRepo, worktreePath: r.run.handle.worktreePath, branch: o.branch,
          // Legacy merge-back is still an automatic cleanup path. A non-force
          // unmount fails closed if anything changed after merge-back, and the
          // branch is retained because this path has no durable immutable tip
          // evidence with which to authorize a destructive `branch -D`.
          deleteBranch: false,
          force: false,
        }).then(() => {
          if (r.implementationOutcome === 'failed') updateRailWorktreeState(ctx.db, r.run.ledgerId, 'failed')
        }).catch(() => {})
      }
    } catch (err) {
      console.error('[rail-isolated] merge-back failed:', err)
    }
  }).catch(async (err) => {
    const detail = errorDetail(err)
    console.error(`[rail-isolated] aggregate settlement failed: ${detail}`)
    if (!prMode || !prDeliveryId || getPrDelivery(ctx.db, prDeliveryId)?.decision !== 'building') return
    const retained = await Promise.all(guardedRunPromises)
    for (const result of retained) markWorktree(result.run, 'needs-review')
    if (transitionDecision(ctx.db, prDeliveryId, 'building', 'pr_failed', {
      branches: branchRecords(retained.map((result) => ({
        ...result,
        deliveryOutcome: 'blocked' as const,
        failureCode: result.failureCode ?? 'settlement_interrupted',
        failureDetail: result.failureDetail ?? detail,
        safeToRelease: false,
      }))),
      worktreeIds: allocated.map((run) => run.ledgerId),
      implementationOutcome: aggregateImplementationOutcome(retained),
      deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted',
      statusDetail: detail,
    })) {
      broadcastPrState()
      syncOriginCard('update')
    }
  })

  return allocated.map((a) => a.runId)
}

interface RecoveryWorktreeInspection {
  safe: boolean
  sha: string | null
  detail?: string
}

function recoveryOverlayExcludes(repoDir: string, worktreePath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(worktreePath, OVERLAY_MANIFEST), 'utf8')) as unknown
    const values = Array.isArray(parsed) ? parsed : (parsed as { paths?: unknown })?.paths
    if (!Array.isArray(values)) return []
    return values.filter((value): value is string => {
      if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) return false
      if (value.includes('\\') || value.split('/').includes('..') || /[\0:*?\[\]]/.test(value)) return false
      if (value === OVERLAY_MANIFEST) return true
      if (!/^\.(?:claude|codex|gemini)\/[^/]+(?:\/[^/]+)*$/.test(value)) return false
      try {
        // Manifest contents are worktree-writable and therefore not authority.
        // Ignore only links that still prove they are overlay scaffolding;
        // copied/modified files remain recoverable dirty data.
        const destination = path.join(worktreePath, value)
        if (!fs.lstatSync(destination).isSymbolicLink()) return false
        const linkTarget = fs.readlinkSync(destination)
        return path.resolve(path.dirname(destination), linkTarget) === path.resolve(repoDir, value)
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

async function authenticatedRecoveryDisplayPath(
  git: GitRunner,
  repoDir: string,
  ledgerPath: string,
  expectedBranch: string,
  registeredPaths: readonly string[],
): Promise<string | null> {
  if (!path.isAbsolute(ledgerPath)) return null
  let realPath: string
  let repoRealPath: string
  try {
    const stat = fs.lstatSync(ledgerPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
    realPath = fs.realpathSync(ledgerPath)
    repoRealPath = fs.realpathSync(repoDir)
  } catch {
    return null
  }
  if (realPath === repoRealPath) return null
  const registeredMatches = registeredPaths.filter((registeredPath) => {
    try {
      return fs.realpathSync(registeredPath) === realPath
    } catch {
      return false
    }
  })
  if (registeredMatches.length !== 1) return null
  try {
    const [branch, head] = await Promise.all([
      git.run(['rev-parse', '--abbrev-ref', 'HEAD'], realPath),
      git.run(['rev-parse', '--verify', 'HEAD'], realPath),
    ])
    if (branch.code !== 0 || branch.stdout.trim() !== expectedBranch) return null
    if (head.code !== 0 || !COMMIT_SHA_RE.test(head.stdout.trim())) return null
    return realPath
  } catch {
    return null
  }
}

async function inspectRecoveryWorktree(
  git: GitRunner,
  repoDir: string,
  row: { branch: string; worktree_path: string },
): Promise<RecoveryWorktreeInspection> {
  const overlayExcludes = recoveryOverlayExcludes(repoDir, row.worktree_path)
  try {
    const [status, actualBranch, head, branchRef] = await Promise.all([
      git.run([
        'status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', '.',
        ...PR_NEVER_STAGE_PATHSPEC_ROOTS.map((entry) => `:(exclude)${entry}`),
        ...overlayExcludes.map((entry) => `:(top,exclude,literal)${entry}`),
      ], row.worktree_path),
      git.run(['rev-parse', '--abbrev-ref', 'HEAD'], row.worktree_path),
      git.run(['rev-parse', '--verify', 'HEAD'], row.worktree_path),
      git.run(['rev-parse', '--verify', `refs/heads/${row.branch}`], repoDir),
    ])
    const sha = head.code === 0 && COMMIT_SHA_RE.test(head.stdout.trim()) ? head.stdout.trim() : null
    const refSha = branchRef.code === 0 ? branchRef.stdout.trim() : ''
    if (status.code !== 0) return { safe: false, sha, detail: 'git status could not verify worktree cleanliness' }
    if (status.stdout.trim().length > 0) return { safe: false, sha, detail: 'the interrupted worktree contains uncommitted changes' }
    if (actualBranch.code !== 0 || actualBranch.stdout.trim() !== row.branch) {
      return { safe: false, sha, detail: `worktree is not on expected branch ${row.branch}` }
    }
    if (!sha || refSha !== sha) {
      return { safe: false, sha, detail: `HEAD does not match refs/heads/${row.branch}` }
    }
    return { safe: true, sha }
  } catch (err) {
    return { safe: false, sha: null, detail: errorDetail(err) }
  }
}

/**
 * Startup reconciliation is serialized with launch allocation. It proves each
 * orphan clean and durably referenced before removal; successful, dirty,
 * unknown, or ref-mismatched work remains mounted as needs-review. Building
 * delivery generations are then recovered from the durable engine outcomes.
 */
export async function reconcileRailWorktrees(
  db: DbInstance,
  repoDir: string,
  io: {
    git?: GitRunner
    exec?: Exec
    remove?: typeof removeWorktree
    onDeliveryRecovered?: (deliveryId: string) => void
  } = {}
): Promise<number> {
  const git = io.git ?? defaultGitRunner
  const exec = io.exec ?? defaultExec
  const remove = io.remove ?? removeWorktree
  return withRepoLock(repoDir, async () => {
    const stuck = listNonTerminalRailWorktrees(db)
    const autoReleaseWorktreeIds = new Set<string>()
    const settledDeliveries = db.prepare(`
      SELECT decision, delivery_outcome, worktree_ids FROM rail_pr_deliveries
       WHERE decision <> 'building'
         AND delivery_outcome IN ('delivered', 'no_changes', 'retryable_failure')
    `).all() as Array<{ decision: string; delivery_outcome: string; worktree_ids: string }>
    for (const delivery of settledDeliveries) {
      try {
        const ids = JSON.parse(delivery.worktree_ids) as unknown
        if (Array.isArray(ids)) {
          for (const id of ids) if (typeof id === 'string') autoReleaseWorktreeIds.add(id)
        }
      } catch { /* malformed history never authorizes cleanup */ }
    }
    const verifiedShaByRun = new Map<string, string>()
    for (const row of stuck) {
      const run = row.run_id
        ? db.prepare('SELECT status, final_outcome FROM loop_runs WHERE id = ?').get(row.run_id) as
            | { status: string; final_outcome: string | null }
            | undefined
        : undefined
      const inspection = await inspectRecoveryWorktree(git, repoDir, row)

      if (run?.status === 'completed' && run.final_outcome === 'success') {
        if (inspection.safe && inspection.sha) {
          if (row.run_id) verifiedShaByRun.set(row.run_id, inspection.sha)
          if (autoReleaseWorktreeIds.has(row.id)) {
            try {
              await remove(git, {
                repoDir,
                worktreePath: row.worktree_path,
                branch: row.branch,
                deleteBranch: false,
                force: false,
              })
              updateRailWorktreeState(db, row.id, 'released')
            } catch {
              updateRailWorktreeState(db, row.id, 'built')
            }
          } else {
            updateRailWorktreeState(db, row.id, 'built')
          }
        } else {
          updateRailWorktreeState(db, row.id, 'needs-review')
        }
        continue
      }

      if (run?.status === 'completed' && inspection.safe) {
        try {
          await remove(git, {
            repoDir,
            worktreePath: row.worktree_path,
            branch: row.branch,
            deleteBranch: false,
            force: false,
          })
          updateRailWorktreeState(db, row.id, 'failed')
        } catch {
          // A failed non-force removal leaves mount state uncertain; retain the ledger as
          // needs-review instead of claiming cleanup succeeded.
          updateRailWorktreeState(db, row.id, 'needs-review')
        }
        continue
      }

      // Missing/incomplete run evidence, dirty state, status failure, and ref
      // mismatch are all recoverable uncertainty. Never force-remove them.
      updateRailWorktreeState(db, row.id, 'needs-review')
    }

    const recovered = reconcileFailedBuildingPrDeliveries(db, { startup: true })
    // Migration 49 repairs legacy false implementation failures before Git is
    // available. Revisit those already-pr_failed rows here: if their own
    // durable run/worktree ledger proves one exact clean object, the card can
    // safely offer Retry push instead of forcing destructive cleanup.
    const migratedInterrupted = (db.prepare(`
      SELECT id FROM rail_pr_deliveries
       WHERE decision = 'pr_failed'
         AND implementation_outcome IN ('succeeded', 'partially_succeeded')
         AND delivery_outcome = 'blocked'
         AND status_code IN ('settlement_interrupted', 'recovery_unavailable')
         AND pr_url IS NOT NULL
         AND branch IS NOT NULL
    `).all() as Array<{ id: string }>)
      .map(({ id }) => getPrDelivery(db, id))
      .filter((delivery): delivery is NonNullable<ReturnType<typeof getPrDelivery>> => delivery !== undefined)
    // Audit rows healed by an earlier release too. Migration 49 left its causal
    // marker in the unit records even after Retry push changed the top-level
    // status, which lets a newer build replace a mistakenly frozen old branch
    // tip with the unique run-owned settlement commit.
    const previouslyRecovered = (db.prepare(`
      SELECT id FROM rail_pr_deliveries
       WHERE decision IN ('pr_draft', 'pr_ready')
         AND implementation_outcome IN ('succeeded', 'partially_succeeded')
         AND delivery_outcome = 'delivered'
         AND delivery_sha IS NOT NULL
         AND pr_url IS NOT NULL
         AND branch IS NOT NULL
    `).all() as Array<{ id: string }>)
      .map(({ id }) => getPrDelivery(db, id))
      .filter((delivery): delivery is NonNullable<ReturnType<typeof getPrDelivery>> => {
        if (!delivery) return false
        try {
          const units = JSON.parse(delivery.branches) as Array<{ failureCode?: unknown }>
          return Array.isArray(units) && units.some((unit) => unit?.failureCode === 'settlement_interrupted')
        } catch {
          return false
        }
      })
    const recoveryCandidates = [...new Map(
      [...recovered, ...migratedInterrupted, ...previouslyRecovered].map((delivery) => [delivery.id, delivery]),
    ).values()]
    // `git fsck` can be materially more expensive than the ordinary refs/log
    // lookup. Defer it until a causally eligible legacy run actually needs
    // inspection, then share the exact result across every candidate in this
    // serialized reconciliation pass.
    let unreachableRecoveryScan: Promise<UnreachableRecoveryScan> | null = null
    const getUnreachableRecoveryScan = (): Promise<UnreachableRecoveryScan> => {
      if (!unreachableRecoveryScan) {
        unreachableRecoveryScan = scanUnreachableRecoveryCommits(git, repoDir)
      }
      return unreachableRecoveryScan
    }
    let recoveryProtectionScan: Promise<RecoveryCommitProtectionScan> | null = null
    const getRecoveryProtectionScan = (): Promise<RecoveryCommitProtectionScan> => {
      if (!recoveryProtectionScan) {
        recoveryProtectionScan = listRecoveryCommitProtections(git, repoDir)
      }
      return recoveryProtectionScan
    }
    for (const delivery of recoveryCandidates) {
      if (!['succeeded', 'partially_succeeded'].includes(delivery.implementation_outcome)) continue
      // Exact-SHA promotion here is specifically an existing-PR retry. A fresh
      // recovered generation remains on_review/ready and follows normal draft
      // creation; it must not be relabelled as a failed push merely because its
      // clean worktree also yielded a verifiable SHA.
      if (!delivery.pr_url || !delivery.branch) continue
      let runIds: string[] = []
      try {
        const parsed = JSON.parse(delivery.run_ids) as unknown
        if (Array.isArray(parsed)) runIds = parsed.filter((value): value is string => typeof value === 'string')
      } catch { /* malformed legacy row remains blocked without a retry SHA */ }
      let recoveryAwareBranches: DeliverBranchRecord[] | undefined
      const liveRecoveryPaths: string[] = []
      try {
        const units = JSON.parse(delivery.branches) as DeliverBranchRecord[]
        const worktreeIds = JSON.parse(delivery.worktree_ids) as unknown
        const ledgers = Array.isArray(worktreeIds)
          ? worktreeIds
              .filter((value): value is string => typeof value === 'string')
              .map((worktreeId) => getRailWorktree(db, worktreeId))
              .filter((worktree): worktree is NonNullable<ReturnType<typeof getRailWorktree>> => Boolean(worktree))
          : []
        if (Array.isArray(units)) {
          const registeredPaths = await listWorktrees(git, repoDir)
          recoveryAwareBranches = []
          for (const unit of units) {
            const ledger = ledgers.find((candidate) => (
              candidate.branch === unit.branch &&
              (unit.runId ? candidate.run_id === unit.runId : true) &&
              fs.existsSync(candidate.worktree_path)
            ))
            if (!ledger) {
              // A path is device-local, ephemeral evidence. Never keep an old
              // pointer merely because a previous reconciliation projected it:
              // another computer or later cleanup may no longer have those
              // bytes, and the UI must not advertise a historical path as live.
              const { worktreePath: _stalePath, ...withoutStalePath } = unit
              recoveryAwareBranches.push(withoutStalePath)
              continue
            }
            const authenticatedPath = await authenticatedRecoveryDisplayPath(
              git, repoDir, ledger.worktree_path, unit.branch, registeredPaths,
            )
            if (!authenticatedPath) {
              const { worktreePath: _stalePath, ...withoutUnauthenticatedPath } = unit
              recoveryAwareBranches.push(withoutUnauthenticatedPath)
              continue
            }
            liveRecoveryPaths.push(authenticatedPath)
            recoveryAwareBranches.push({ ...unit, worktreePath: authenticatedPath })
          }
        }
      } catch { /* malformed legacy unit/path evidence stays undisclosed */ }
      const recoveryLocation = [...new Set(liveRecoveryPaths)][0] ?? null
      const retainBlockedWithDetail = (
        detail: string,
        deliverySha: string | null = null,
        // A currently authenticated worktree is actionable local evidence;
        // without one, repeated Commit promises are misleading. Recheck stays
        // legal in recovery_unavailable and can still promote a later restored
        // worktree or newly discovered orphan object.
        statusCode: PrDeliveryStatusCode = recoveryLocation
          ? 'settlement_interrupted'
          : 'recovery_unavailable',
      ): void => {
        const next = delivery.decision === 'pr_draft' || delivery.decision === 'pr_ready'
          ? 'pr_failed'
          : delivery.decision
        const projectedBranchesUnchanged = recoveryAwareBranches === undefined ||
          delivery.branches === JSON.stringify(recoveryAwareBranches)
        if (
          delivery.decision === next && delivery.status_detail === detail &&
          delivery.delivery_sha === deliverySha && delivery.is_continuation === 1 &&
          delivery.status_code === statusCode && projectedBranchesUnchanged
        ) return
        transitionDecision(db, delivery.id, delivery.decision, next, {
          deliveryOutcome: 'blocked',
          statusCode,
          statusDetail: detail,
          deliverySha,
          isContinuation: true,
          branches: recoveryAwareBranches,
        })
      }
      const retainRetryableWithDetail = (detail: string, deliverySha: string): void => {
        transitionDecision(db, delivery.id, delivery.decision, 'pr_failed', {
          deliveryOutcome: 'retryable_failure',
          statusCode: 'settlement_interrupted',
          statusDetail: detail,
          deliverySha,
          isContinuation: true,
          branches: recoveryAwareBranches,
        })
      }
      if (runIds.length === 0) {
        retainBlockedWithDetail(recoveryLocation
          ? `Exact commit recovery is unavailable because this legacy delivery has no durable run identifiers; inspect the preserved worktree at ${recoveryLocation}.`
          : 'Exact commit recovery is unavailable because this legacy delivery has no durable run identifiers; no remaining local evidence was deleted.')
        continue
      }
      const protectionScan = await getRecoveryProtectionScan()
      const protectedCandidateSha = protectionScan.ok
        ? protectionScan.protections.get(recoveryRefForDelivery(delivery.id)) ?? null
        : null
      const protectedRunSha = protectedCandidateSha && runIds.length === 1 &&
        await commitCarriesRunMarker(git, repoDir, protectedCandidateSha, runIds[0])
        ? protectedCandidateSha
        : null
      const ambiguousRunCommits = new Set<string>()
      const unsafeRunEvidence = new Set<string>()
      if (protectedCandidateSha && !protectedRunSha) unsafeRunEvidence.add('protected-ref')
      let unreachableDiscoveryFailed = false
      for (const runId of runIds) {
        let inspectedSha = verifiedShaByRun.get(runId) ?? null
        verifiedShaByRun.delete(runId)
        const ledger = db.prepare(`
          SELECT branch, worktree_path, merge_state FROM rail_worktrees
           WHERE run_id = ? AND branch = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(runId, delivery.branch) as {
          branch: string
          worktree_path: string
          merge_state: string
        } | undefined
        if (ledger?.merge_state === 'needs-review') {
          unsafeRunEvidence.add(runId)
        } else if (ledger && fs.existsSync(ledger.worktree_path)) {
          const inspection = await inspectRecoveryWorktree(git, repoDir, ledger)
          if (!inspection.safe || !inspection.sha) {
            unsafeRunEvidence.add(runId)
          } else {
            inspectedSha = inspection.sha
          }
        } else if (
          ledger && !['released', 'failed'].includes(ledger.merge_state) && !inspectedSha
        ) {
          unsafeRunEvidence.add(runId)
        }
        if (protectedRunSha && runId === runIds[0]) {
          if (inspectedSha && inspectedSha.toLowerCase() !== protectedRunSha.toLowerCase()) {
            unsafeRunEvidence.add(runId)
          }
          verifiedShaByRun.set(runId, protectedRunSha)
          continue
        }
        const discovery = await discoverRunMarkedCommit(
          git,
          repoDir,
          runId,
          await getUnreachableRecoveryScan(),
        )
        if (discovery.kind === 'unique') {
          if (inspectedSha && inspectedSha.toLowerCase() !== discovery.sha.toLowerCase()) {
            unsafeRunEvidence.add(runId)
          }
          verifiedShaByRun.set(runId, discovery.sha)
          continue
        }
        if (discovery.kind === 'ambiguous') {
          ambiguousRunCommits.add(runId)
          continue
        }
        if (discovery.kind === 'scan_failed') {
          unreachableDiscoveryFailed = true
          continue
        }
        const terminal = ledger && ['released', 'failed'].includes(ledger.merge_state) ? ledger : undefined
        if (!terminal && !inspectedSha) continue
        try {
          let sha = inspectedSha ?? ''
          if (!sha && terminal && fs.existsSync(terminal.worktree_path)) {
            const inspection = await inspectRecoveryWorktree(git, repoDir, terminal)
            if (inspection.safe && inspection.sha) sha = inspection.sha
          } else if (!sha && terminal) {
            const ref = await git.run(['rev-parse', '--verify', `refs/heads/${terminal.branch}`], repoDir)
            sha = ref.code === 0 ? ref.stdout.trim() : ''
          }
          if (COMMIT_SHA_RE.test(sha) && await commitCarriesRunMarker(git, repoDir, sha, runId)) {
            verifiedShaByRun.set(runId, sha)
          }
        } catch { /* exact retry remains blocked */ }
      }
      const shas = [...new Set(runIds.map((runId) => verifiedShaByRun.get(runId)).filter((sha): sha is string => !!sha))]
      const hasOneCompleteCandidate = !unreachableDiscoveryFailed &&
        ambiguousRunCommits.size === 0 && shas.length === 1 &&
        runIds.every((runId) => verifiedShaByRun.has(runId))
      let protectedUnsafeCandidate: string | null = null
      if (unsafeRunEvidence.size > 0 && hasOneCompleteCandidate) {
        const protection = await protectRecoveryCommit(git, repoDir, delivery.id, shas[0])
        if (!protection.ok) {
          retainBlockedWithDetail(
            `${protection.detail}; the unsafe worktree and every user-visible ref were left unchanged.`,
          )
          continue
        }
        protectedUnsafeCandidate = shas[0]
      }
      if (
        unsafeRunEvidence.size > 0 || unreachableDiscoveryFailed ||
        ambiguousRunCommits.size > 0 || shas.length !== 1 ||
        runIds.some((runId) => !verifiedShaByRun.has(runId))
      ) {
        retainBlockedWithDetail(unsafeRunEvidence.size > 0
          ? recoveryLocation
            ? `Exact commit recovery found dirty, needs-review, missing, or mismatched worktree evidence; inspect the preserved worktree at ${recoveryLocation}.`
            : 'Exact commit recovery found dirty, needs-review, missing, or mismatched worktree evidence; no remaining local evidence was deleted.'
          : ambiguousRunCommits.size > 0 || shas.length > 1
            ? recoveryLocation
              ? `Exact commit recovery found multiple different commits in this legacy delivery; inspect the preserved worktree at ${recoveryLocation}.`
              : 'Exact commit recovery found multiple different commits; no ambiguous object was selected or deleted.'
            : recoveryLocation
              ? `Exact commit recovery could not prove a run-owned commit; inspect the preserved worktree at ${recoveryLocation}.`
              : 'Exact commit recovery could not prove a run-owned commit from this delivery’s refs, reflogs, or unreachable objects; no remaining local evidence was deleted.',
          protectedUnsafeCandidate,
          recoveryLocation ? 'settlement_interrupted' : 'recovery_unavailable')
        continue
      }
      const candidateSha = shas[0]
      const protectedCommit = await protectRecoveryCommit(
        git,
        repoDir,
        delivery.id,
        candidateSha,
      )
      if (!protectedCommit.ok) {
        retainBlockedWithDetail(
          `${protectedCommit.detail}; no local evidence was changed or removed.`,
        )
        continue
      }
      let causallyRecoveredBranches: DeliverBranchRecord[] | undefined
      try {
        const units = recoveryAwareBranches ?? JSON.parse(delivery.branches) as DeliverBranchRecord[]
        if (Array.isArray(units)) {
          causallyRecoveredBranches = units.map((unit) => {
            const sha = unit.runId ? verifiedShaByRun.get(unit.runId) : undefined
            if (unit.failureCode !== 'settlement_interrupted' || !sha) return unit
            const { failureCode: _legacyFailure, ...rest } = unit
            return {
              ...rest,
              succeeded: true,
              deliveryOutcome: 'ready',
              finalSha: sha,
              changed: true,
            }
          })
        }
      } catch { /* malformed unit evidence stays untouched and conservative */ }
      const detachFromStalePr = (detail: string): void => {
        const partial = delivery.implementation_outcome === 'partially_succeeded'
        transitionDecision(db, delivery.id, delivery.decision, 'on_review', {
          prUrl: null,
          prNumber: null,
          prState: 'local-only',
          deliveryOutcome: partial ? 'partial' : 'ready',
          statusCode: partial ? 'partial_success' : 'ready_for_review',
          statusDetail: `${detail}; create a new draft PR from the preserved run-owned commit`,
          deliverySha: candidateSha,
          branches: causallyRecoveredBranches,
          isContinuation: false,
        })
      }
      const observed = await observePrLifecycle(exec, repoDir, delivery.pr_url, candidateSha)
      if (!observed.ok) {
        retainRetryableWithDetail(
          `Recovered the exact run-owned commit, but the recorded PR could not be observed: ${observed.detail}; Retry push will revalidate before any push.`,
          candidateSha,
        )
        continue
      }
      const identityMatches = matchesRecordedPrIdentity(observed, delivery.branch, delivery.base_branch)
      if (observed.state === 'MERGED') {
        if (identityMatches && observed.includesExpectedSha === true) {
          const transitioned = transitionDecision(db, delivery.id, delivery.decision, 'pr_ready', {
            deliveryOutcome: 'delivered', statusCode: 'pr_ready', statusDetail: null,
            deliverySha: candidateSha, branches: causallyRecoveredBranches, isContinuation: true,
          })
          if (transitioned) await releaseDeliveredRecoveryLineage(db, git, repoDir, delivery, candidateSha)
        } else {
          detachFromStalePr(observed.includesExpectedSha === true
            ? 'the previous PR was merged after its recorded head/base identity changed'
            : 'the previous PR was merged without the recovered implementation commit')
        }
        continue
      }
      if (observed.state === 'CLOSED') {
        if (identityMatches && observed.includesExpectedSha === true) {
          const transitioned = transitionDecision(db, delivery.id, delivery.decision, 'pr_closed', {
            deliveryOutcome: 'delivered', statusCode: 'pr_closed', statusDetail: null,
            deliverySha: candidateSha, branches: causallyRecoveredBranches, isContinuation: true,
          })
          if (transitioned) await releaseDeliveredRecoveryLineage(db, git, repoDir, delivery, candidateSha)
        } else {
          detachFromStalePr(observed.includesExpectedSha === true
            ? 'the previous PR was closed after its recorded head/base identity changed'
            : 'the previous PR was closed without the recovered implementation commit')
        }
        continue
      }
      if (!isExactOpenPr(observed, delivery.branch, delivery.base_branch)) {
        detachFromStalePr('the previous open PR no longer matches its recorded head/base identity')
        continue
      }
      if (observed.includesExpectedSha === true) {
        const next = observed.isDraft ? 'pr_draft' : 'pr_ready'
        const transitioned = transitionDecision(db, delivery.id, delivery.decision, next, {
          deliveryOutcome: 'delivered',
          statusCode: next === 'pr_ready' ? 'pr_ready' : 'existing_pr_updated',
          statusDetail: null,
          deliverySha: candidateSha,
          branches: causallyRecoveredBranches,
          isContinuation: true,
        })
        if (transitioned) await releaseDeliveredRecoveryLineage(db, git, repoDir, delivery, candidateSha)
        continue
      }
      if (observed.headRefOid && !await recoveryCommitObjectExists(git, repoDir, observed.headRefOid)) {
        try {
          await git.run(['fetch', 'origin', `refs/heads/${delivery.branch}`], repoDir)
        } catch { /* the immutable object check below remains authoritative */ }
      }
      if (
        !observed.headRefOid ||
        !await recoveryCommitObjectExists(git, repoDir, observed.headRefOid) ||
        !await isFastForwardRecoveryCommit(git, repoDir, observed.headRefOid, candidateSha)
      ) {
        retainBlockedWithDetail(
          observed.headRefOid && await recoveryCommitObjectExists(git, repoDir, observed.headRefOid)
            ? 'Recovered the exact run-owned commit, but it is not a fast-forward of the live PR head. The commit remains protected and nothing was pushed or removed.'
            : 'Recovered the exact run-owned commit, but the live PR head object could not be verified locally. The commit remains protected and nothing was pushed or removed.',
          candidateSha,
          'recovery_unavailable',
        )
        continue
      }
      transitionDecision(db, delivery.id, delivery.decision, 'pr_failed', {
        deliveryOutcome: 'retryable_failure',
        statusCode: 'settlement_interrupted',
        statusDetail: 'Recovered a clean exact continuation commit; delivery can be retried safely.',
        deliverySha: candidateSha,
        branches: causallyRecoveredBranches,
        isContinuation: true,
      })
    }
    // Internal refs are deliberately released only after the durable row proves
    // exact delivery/no-change. If a previous process crashed after that row
    // transition but before `update-ref -d`, retry the idempotent exact cleanup
    // now, including discarded/superseded predecessor refs whose objects are
    // ancestors of the delivered successor.
    const settledRecoveryRefs = (db.prepare(`
      SELECT id FROM rail_pr_deliveries
       WHERE delivery_sha IS NOT NULL
         AND (delivery_outcome IN ('delivered','no_changes') OR decision IN ('merged','completed'))
    `).all() as Array<{ id: string }>)
      .map(({ id }) => getPrDelivery(db, id))
      .filter((row): row is NonNullable<ReturnType<typeof getPrDelivery>> => Boolean(row?.delivery_sha))
    if (settledRecoveryRefs.length > 0) {
      const protectionScan = await getRecoveryProtectionScan()
      if (protectionScan.ok && protectionScan.protections.size > 0) {
        for (const settled of settledRecoveryRefs) {
          const visited = new Set<string>()
          let lineage: typeof settled | undefined = settled
          let hasProtectedLineage = false
          for (let depth = 0; lineage && depth < 32 && !visited.has(lineage.id); depth++) {
            visited.add(lineage.id)
            if (protectionScan.protections.has(recoveryRefForDelivery(lineage.id))) {
              hasProtectedLineage = true
              break
            }
            lineage = lineage.supersedes_delivery_id
              ? getPrDelivery(db, lineage.supersedes_delivery_id)
              : undefined
          }
          if (hasProtectedLineage) {
            await releaseDeliveredRecoveryLineage(db, git, repoDir, settled, settled.delivery_sha!)
          }
        }
      }
    }
    for (const delivery of recoveryCandidates) {
      try { io.onDeliveryRecovered?.(delivery.id) } catch { /* durable state wins over advisory surfaces */ }
    }
    return stuck.length
  })
}
