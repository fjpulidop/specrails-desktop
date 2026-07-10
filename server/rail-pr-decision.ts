/**
 * Execute a user's ask-first PR decision (safe-pr-review-flow) against its
 * authoritative `rail_pr_deliveries` row: the actions both decision
 * surfaces (the dashboard rail row and the launching agent-chat card) POST to
 * `/rails/pr-decision`.
 *
 *   create-pr  → deferred deliverRailAsPr, reconstructed from the row's durable
 *                columns (nothing survives in memory after build-settle). The
 *                PR title/body are composed HERE (canonical OSS style — see
 *                pr-naming/pr-body) from the ticket store + jira_links + the
 *                branch diffs, all failure-tolerant.
 *   publish    → `gh pr ready` opens the draft for team review.
 *   discard    → close the PR, sweep the launch's worktrees + branches, revert
 *                the on_review tickets to todo.
 *   poll-merge → `gh pr view` — MERGED promotes the tickets to done.
 *   merge-local→ the REMOTE-LESS acceptance path: merge the delivered branches
 *                into the integration branch directly in the user's checkout
 *                (guarded: correct branch checked out + clean tree, abort on
 *                conflict). Without it, a repo with no GitHub remote wedges
 *                forever in retry(local-only)/discard — no way to ACCEPT work.
 *
 * Every mutation rides a lease-owned compare-and-set (a raced concurrent
 * decision loses with a 409 before effects) and re-broadcasts the durable
 * `rail.pr_state` snapshot so both surfaces converge; agent-chat-originated
 * rows also update their inline decision card in place. Deps are injected
 * (db/git/exec/broadcast/jira/agent-chat) so the whole matrix is unit-testable
 * without git/gh/net — the route in rails-router validates and delegates here.
 */
import * as path from 'path'
import * as fs from 'fs'
import { resolveHome } from './artifact-registry'
import type { DbInstance } from './db'
import type { GitRunner } from './worktree-manager'
import { publishDraftPr, pushBranch, type Exec, type ExecResult } from './pr-publisher'
import { deliverRailAsPr } from './rail-pr-delivery'
import { durableBranchHeads, durableOverlayCleanupEvidence, releaseRailWorktrees } from './rail-worktree-release'
import { batchBranchNameFor, buildPrTitle, type TicketNamingInput } from './pr-naming'
import { buildCanonicalPrBody, collectBranchChanges, type BranchChanges } from './pr-body'
import { getLinkByLocalId } from './jira/jira-db'
import {
  appendPrDeliverySafetyArchive, claimPrDeliveryOperation, getPrDelivery,
  releasePrDeliveryOperation, transitionClaimedDecision,
  toPrDeliverySnapshot, toRailPrStateMessage, toPrDecisionCardEnvelope,
  type DeliverBranchRecord, type PrDecision, type PrDeliveryPatch, type PrDeliverySnapshot, type RailPrDeliveryRow,
} from './rail-pr-store'
import { getRailWorktree } from './rail-worktrees-store'
import { readStore, resolveTicketStoragePath } from './ticket-store'
import { resolveProjectExecution } from './workspace-resolution'
import { getAgentChatManager } from './agent-chat-registry'
import { newId } from './ids'
import { withRepoLock } from './repo-lock'
import {
  applyRailPrTicketEffect,
  transitionClaimedDecisionWithTicketEffect,
  type RailPrTicketEffect,
} from './rail-pr-ticket-effects'
import {
  isExactOpenPr,
  matchesRecordedPrIdentity,
  observePrLifecycle as observeGithubPrLifecycle,
  type PrLifecycleObservation,
} from './pr-lifecycle'
import type { WsMessage, PrDecisionCardEnvelope } from './types'

export const PR_DECISION_ACTIONS = ['create-pr', 'publish', 'discard', 'dismiss', 'poll-merge', 'reopen', 'merge-local', 'acknowledge-no-changes'] as const
export type PrDecisionAction = (typeof PR_DECISION_ACTIONS)[number]

function safetyArchiveRecorder(deps: PrDecisionDeps, row: RailPrDeliveryRow) {
  return (archive: string): void => {
    if (!appendPrDeliverySafetyArchive(deps.db, row.id, archive)) {
      throw new Error(`delivery ${row.id} disappeared while recording safety archive ${archive}`)
    }
  }
}

export function isPrDecisionAction(v: unknown): v is PrDecisionAction {
  return typeof v === 'string' && (PR_DECISION_ACTIONS as readonly string[]).includes(v)
}

export interface PrDecisionDeps {
  db: DbInstance
  project: { id: string; slug: string; path: string }
  git: GitRunner
  exec: Exec
  broadcast: (msg: WsMessage) => void
  /** Optional (tests / partial contexts); calls are best-effort and never fatal. */
  jiraSyncManager?: {
    onRailMerged(ticketIds: number[], refId: string, prUrl: string | null): boolean | void
    onRailDiscard(ticketIds: number[], refId: string): boolean | void
    onRailCompleted?(ticketIds: number[], refId: string): boolean | void
    onRailRefined?(ticketIds: number[], refId: string): boolean | void
  }
  /** Agent-chat accessor (default: the process-wide registry). Null-safe. */
  agentChat?: () => { updatePrDecisionCard(conversationId: string, envelope: PrDecisionCardEnvelope): void } | null
  /** Ticket-store file override (tests) — default resolves via workspace-resolution. */
  ticketFile?: string
  /** Temporary local-integration worktree root override (tests). */
  assemblyRoot?: string
  /** Router-captured project generation, rechecked only after acquiring the
   * repository lock so a queued action cannot outlive project quiescence. */
  assertAdmission?: () => void
}

export interface PrDecisionInput {
  prDeliveryId: string
  action: PrDecisionAction
  expectedDecision: string
}

/** HTTP-shaped outcome the route relays verbatim. */
export interface PrDecisionResult {
  status: number
  body: Record<string, unknown>
}

// Action handlers keep using one finalization helper, but the operation lease
// must be absent from every emitted snapshot. Calls made while a lease is held
// are deferred until executePrDecision's finally releases that exact token.
const deferredFinalizations = new Set<string>()

function staleDecision(current: string): PrDecisionResult {
  return { status: 409, body: { error: 'stale_decision', current } }
}

function illegalAction(current: string): PrDecisionResult {
  return { status: 409, body: { error: 'stale_decision', current, reason: 'illegal_action' } }
}

function ghFailed(r: ExecResult): PrDecisionResult {
  const detail = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`
  return { status: 502, body: { error: 'gh_failed', detail } }
}

/**
 * The D3 state machine's action legality. `create-pr` is also the RETRY path:
 * from a retryable pr_failed, or from a pr_draft whose delivery degraded before
 * a PR existed (pushed/local-only → pr_url null). Publish/poll require a real
 * PR URL — a degraded draft only offers retry or discard.
 */
function actionAllowed(action: PrDecisionAction, row: RailPrDeliveryRow): boolean {
  switch (action) {
    case 'create-pr':
      return row.decision === 'on_review' ||
        (row.decision === 'pr_failed' && (row.delivery_outcome === 'retryable_failure' || row.delivery_outcome === 'unknown')) ||
        (row.decision === 'pr_draft' && row.pr_url === null)
    case 'publish':
      return row.decision === 'pr_draft' && row.pr_url !== null
    case 'discard':
      return row.decision === 'on_review' || row.decision === 'pr_draft' ||
        row.decision === 'pr_ready' || row.decision === 'pr_closed' || row.decision === 'no_changes' ||
        row.decision === 'implementation_failed' ||
        row.decision === 'pr_failed'
    case 'dismiss':
      return row.is_continuation === 1 && row.decision !== 'building' &&
        row.decision !== 'merged' && row.decision !== 'discarded' && row.decision !== 'superseded' &&
        row.delivery_outcome !== 'blocked'
    case 'poll-merge':
      return (row.decision === 'pr_draft' || row.decision === 'pr_ready' || row.decision === 'pr_closed') && row.pr_url !== null
    case 'reopen':
      return row.decision === 'pr_closed' && row.pr_url !== null
    case 'merge-local':
      // Remote-less acceptance ONLY: once a real PR exists (pr_url), GitHub is
      // the merge authority — merging under an open PR would leave it dangling.
      return row.pr_url === null &&
        (row.decision === 'on_review' || row.decision === 'pr_failed' || row.decision === 'pr_draft')
    case 'acknowledge-no-changes':
      return row.decision === 'no_changes' && row.is_continuation !== 1
  }
}

export async function executePrDecision(deps: PrDecisionDeps, input: PrDecisionInput): Promise<PrDecisionResult> {
  const row = getPrDelivery(deps.db, input.prDeliveryId)
  if (!row) return { status: 404, body: { error: 'Unknown prDeliveryId' } }

  // Compare-and-set pre-check: the caller decided against a snapshot — if the
  // row moved on (the other surface answered first), it must reconcile, not act.
  if (row.decision !== input.expectedDecision) return staleDecision(row.decision)
  if (!actionAllowed(input.action, row)) return illegalAction(row.decision)

  // Claim before any git/GitHub/cleanup/ticket effect. The visible decision is
  // unchanged while the winner works, but a second surface cannot start.
  const operationToken = newId()
  if (!claimPrDeliveryOperation(deps.db, row.id, row.decision, input.action, operationToken)) {
    const current = getPrDelivery(deps.db, row.id)
    if (!current || current.decision !== input.expectedDecision) {
      return staleDecision(current?.decision ?? row.decision)
    }
    return {
      status: 409,
      body: { error: 'operation_in_progress', current: current.decision, operation: current.operation },
    }
  }

  const claimedRow = getPrDelivery(deps.db, row.id)
  if (!claimedRow || claimedRow.operation_token !== operationToken) {
    return { status: 409, body: { error: 'operation_in_progress', current: claimedRow?.decision ?? row.decision } }
  }

  try {
    switch (input.action) {
      case 'create-pr': return await runCreatePr(deps, claimedRow)
      case 'publish': return await runPublish(deps, claimedRow)
      case 'discard': return await runDiscard(deps, claimedRow)
      case 'dismiss': return await runDismiss(deps, claimedRow)
      case 'poll-merge': return await runPollMerge(deps, claimedRow)
      case 'reopen': return await runReopen(deps, claimedRow)
      case 'merge-local': return await runMergeLocal(deps, claimedRow)
      case 'acknowledge-no-changes': return await runAcknowledgeNoChanges(deps, claimedRow)
    }
    return illegalAction(row.decision)
  } finally {
    try { releasePrDeliveryOperation(deps.db, row.id, operationToken) } catch { /* durable state remains authoritative */ }
    if (deferredFinalizations.delete(row.id)) finalizeTransition(deps, row.id)
  }
}

/**
 * Atomic CAS transition; a `false` return means a concurrent mutation raced us
 * between the pre-check and here — surface the same 409 with the fresh state.
 */
function casTransition(deps: PrDecisionDeps, row: RailPrDeliveryRow, next: PrDecision, patch: PrDeliveryPatch = {}): PrDecisionResult | null {
  if (row.operation_token && transitionClaimedDecision(deps.db, row.id, row.decision, next, row.operation_token, patch)) return null
  const current = getPrDelivery(deps.db, row.id)
  return staleDecision(current?.decision ?? row.decision)
}

function casTransitionWithTicketEffect(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  next: PrDecision,
  patch: PrDeliveryPatch,
  effect: RailPrTicketEffect,
): PrDecisionResult | null {
  if (
    row.operation_token &&
    transitionClaimedDecisionWithTicketEffect(
      deps.db, row.id, row.decision, next, row.operation_token, patch, effect,
    )
  ) return null
  const current = getPrDelivery(deps.db, row.id)
  return staleDecision(current?.decision ?? row.decision)
}

function applyTerminalTicketEffect(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  terminalDecision: PrDecision,
  cleanupWarnings: string[],
): void {
  const result = applyRailPrTicketEffect(deps, row.id)
  if (result.ok) return
  cleanupWarnings.push(`ticket status update pending: ${result.error ?? 'unknown ticket-store error'}`)
  if (!row.operation_token) return
  transitionClaimedDecision(deps.db, row.id, terminalDecision, terminalDecision, row.operation_token, {
    statusCode: 'cleanup_incomplete',
    cleanupWarnings,
  })
}

/**
 * Post-transition fan-out: re-broadcast the durable rail.pr_state snapshot
 * (both surfaces converge on it) and, for agent-chat-originated launches,
 * update the persisted inline card in place.
 */
function finalizeTransition(deps: PrDecisionDeps, id: string): PrDeliverySnapshot | undefined {
  const row = getPrDelivery(deps.db, id)
  if (!row) return undefined
  const snap = toPrDeliverySnapshot(row)
  if (row.operation_token) {
    deferredFinalizations.add(id)
    return snap
  }
  deps.broadcast(toRailPrStateMessage(deps.project.id, snap))
  if (row.origin_conversation_id) {
    const agent = (deps.agentChat ?? getAgentChatManager)()
    // Shared mapper (rail-pr-store.toPrDecisionCardEnvelope) — the SAME shape
    // rail-isolated-launch's origin-card sync posts, so the two card-writing
    // sites (incl. the runIds chip data) can never drift.
    agent?.updatePrDecisionCard(row.origin_conversation_id, toPrDecisionCardEnvelope(deps.project.id, snap))
  }
  return snap
}

function parsePrNumber(prUrl: string): number | null {
  const m = /\/pull\/(\d+)/.exec(prUrl)
  return m ? parseInt(m[1], 10) : null
}

function batchWorktreeRoot(slug: string): string {
  // Mirrors rail-isolated-launch's worktreesRoot — derivable, never stored.
  return path.join(resolveHome(), '.specrails', 'projects', slug, 'worktrees')
}

/** A legacy record's `succeeded` bit meant delivery eligibility. New records
 * state that eligibility directly; blocked/no-change units are never swept as
 * a side effect of delivering another unit in the same batch. */
function unitWasDelivered(unit: DeliverBranchRecord): boolean {
  return unit.deliveryOutcome === undefined ? unit.succeeded : unit.deliveryOutcome === 'ready'
}

/** Branch deletion is ownership-based, never name-derived. Legacy rows without
 * ownership evidence degrade to preservation. A multi-unit assembled head is
 * owned when it is distinct from every recorded unit branch. */
function ownedDeliveryBranches(
  row: RailPrDeliveryRow,
  snap: PrDeliverySnapshot,
  cleanupWarnings?: string[],
): Set<string> {
  const unknownOwnership = row.is_continuation !== 1
    ? snap.branches.filter((unit) => unitWasDelivered(unit) && unit.branchOwnership === undefined)
    : []
  if (cleanupWarnings && unknownOwnership.length > 0) {
    cleanupWarnings.push(
      `branch cleanup preserved ${unknownOwnership.length} legacy ${unknownOwnership.length === 1 ? 'branch' : 'branches'} because ownership was not recorded`,
    )
  }
  const owned = new Set(
    snap.branches
      .filter((unit) => unit.branchOwnership === 'created' && unitWasDelivered(unit))
      .map((unit) => unit.branch),
  )
  if (
    row.is_continuation !== 1 && snap.branches.length > 1 && row.branch &&
    !snap.branches.some((unit) => unit.branch === row.branch)
  ) owned.add(row.branch)
  return owned
}

function immutableHeadForOwnedBranch(
  row: RailPrDeliveryRow,
  snap: PrDeliverySnapshot,
  branch: string,
): string | null {
  if (branch === row.branch && row.delivery_sha && COMMIT_SHA_RE.test(row.delivery_sha)) {
    return row.delivery_sha.toLowerCase()
  }
  const unitHeads = new Set(
    snap.branches
      .filter((unit) => unitWasDelivered(unit) && unit.branch === branch && unit.finalSha && COMMIT_SHA_RE.test(unit.finalSha))
      .map((unit) => unit.finalSha!.toLowerCase()),
  )
  return unitHeads.size === 1 ? [...unitHeads][0] : null
}

async function deleteOwnedBranchesIfUnchanged(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  snap: PrDeliverySnapshot,
  cleanupWarnings: string[],
  protectedBranches: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const branch of ownedDeliveryBranches(row, snap, cleanupWarnings)) {
    if (!branch || branch === row.base_branch) continue
    // A failed release leaves the linked worktree mounted for inspection. Do
    // not even attempt to delete its checked-out branch: preserving the files
    // while erasing their durable ref would make the recovery story depend on
    // Git's incidental checked-out-branch rejection.
    if (protectedBranches.has(branch)) {
      cleanupWarnings.push(`branch ${branch}: retained with its worktree for inspection`)
      continue
    }
    try {
      const expectedHead = immutableHeadForOwnedBranch(row, snap, branch)
      if (!expectedHead) {
        cleanupWarnings.push(`branch ${branch}: retained because no unambiguous immutable delivered HEAD was recorded`)
        continue
      }
      const observed = await deps.git.run(['rev-parse', '--verify', `refs/heads/${branch}`], deps.project.path)
      const observedHead = observed.code === 0 ? observed.stdout.trim().toLowerCase() : ''
      if (!COMMIT_SHA_RE.test(observedHead) || observedHead !== expectedHead) {
        cleanupWarnings.push(
          `branch ${branch}: retained because its current tip no longer matches delivered HEAD ${expectedHead.slice(0, 12)}`,
        )
        continue
      }
      const deleted = await deps.git.run(['branch', '-D', branch], deps.project.path)
      if (deleted.code !== 0) {
        cleanupWarnings.push(`branch ${branch}: ${(deleted.stderr.trim() || deleted.stdout.trim()).split('\n')[0] || `exit ${deleted.code}`}`)
      }
    } catch (err) {
      cleanupWarnings.push(`branch ${branch}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function releasableWorktreeIds(
  deps: PrDecisionDeps,
  snap: PrDeliverySnapshot,
): string[] {
  const preservedBranches = new Set(snap.branches.filter((unit) => !unitWasDelivered(unit)).map((unit) => unit.branch))
  return snap.worktreeIds.filter((id) => {
    const wt = getRailWorktree(deps.db, id)
    return !wt || !preservedBranches.has(wt.branch)
  })
}

function mergedEvidenceDetail(observation: PrLifecycleObservation): string {
  return observation.includesExpectedSha === null
    ? 'GitHub did not return enough commit evidence to prove the previous PR included the verified implementation commit'
    : 'the previous PR merged without the verified implementation commit'
}

async function rerouteFromStalePr(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  detail: string,
  exactWasPushed: boolean,
): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings = await releaseRailWorktrees({
    db: deps.db, git: deps.git, repoDir: deps.project.path,
    worktreeIds: releasableWorktreeIds(deps, snap),
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  })
  const partial = row.implementation_outcome === 'partially_succeeded'
  const preserved = row.delivery_sha ? 'the preserved exact commit' : 'the preserved recorded branch'
  const conflict = casTransition(deps, row, 'on_review', {
    prUrl: null,
    prNumber: null,
    prState: exactWasPushed ? 'pushed' : 'local-only',
    deliveryOutcome: partial ? 'partial' : 'ready',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : partial ? 'partial_success' : 'ready_for_review',
    statusDetail: `${detail}; create a new draft PR from ${preserved}`,
    cleanupWarnings,
    // The replacement PR belongs to this generation. Per-unit branch ownership
    // remains unchanged so a borrowed/pre-existing ref is still never deleted.
    isContinuation: false,
  })
  if (conflict) return conflict
  const after = finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'on_review',
      prUrl: null,
      prState: after?.prState ?? (exactWasPushed ? 'pushed' : 'local-only'),
      rerouted: true,
      detail,
    },
  }
}

async function settleObservedExistingPr(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  observation: PrLifecycleObservation,
  pushed: boolean,
): Promise<PrDecisionResult> {
  const next: Extract<PrDecision, 'pr_draft' | 'pr_ready'> =
    observation.state === 'MERGED' || observation.isDraft === false ? 'pr_ready' : 'pr_draft'
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings = await releaseRailWorktrees({
    db: deps.db, git: deps.git, repoDir: deps.project.path,
    worktreeIds: releasableWorktreeIds(deps, snap),
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  })
  const conflict = casTransition(deps, row, next, {
    prState: 'pr-created',
    deliveryOutcome: 'delivered',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : next === 'pr_ready' ? 'pr_ready' : 'existing_pr_updated',
    statusDetail: null,
    cleanupWarnings,
  })
  if (conflict) return conflict
  const after = finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: next,
      prUrl: after?.prUrl ?? row.pr_url,
      prState: 'pr-created',
      deliveryVerified: true,
      verifiedSha: row.delivery_sha,
      remoteHeadSha: observation.headRefOid,
      pushed,
    },
  }
}

async function settleObservedClosedPr(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  observation: PrLifecycleObservation,
): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings = await releaseRailWorktrees({
    db: deps.db, git: deps.git, repoDir: deps.project.path,
    worktreeIds: releasableWorktreeIds(deps, snap),
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  })
  const conflict = casTransition(deps, row, 'pr_closed', {
    prState: 'pr-created',
    deliveryOutcome: 'delivered',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'pr_closed',
    statusDetail: null,
    cleanupWarnings,
  })
  if (conflict) return conflict
  const after = finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'pr_closed',
      closed: true,
      merged: false,
      prUrl: after?.prUrl ?? row.pr_url,
      prState: 'pr-created',
      deliveryVerified: true,
      verifiedSha: row.delivery_sha,
      remoteHeadSha: observation.headRefOid,
      pushed: false,
    },
  }
}

function persistRetryablePrObservationFailure(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  detail: string,
): PrDecisionResult {
  const conflict = casTransition(deps, row, 'pr_failed', {
    deliveryOutcome: 'retryable_failure',
    statusCode: 'push_failed',
    statusDetail: detail,
  })
  if (conflict) return conflict
  finalizeTransition(deps, row.id)
  return { status: 200, body: { ok: true, decision: 'pr_failed', prUrl: row.pr_url, detail } }
}

function persistMovedPrHead(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  detail: string,
): PrDecisionResult {
  const conflict = casTransition(deps, row, 'pr_failed', {
    deliveryOutcome: 'blocked',
    statusCode: 'branch_verification_failed',
    statusDetail: detail,
  })
  if (conflict) return conflict
  finalizeTransition(deps, row.id)
  return { status: 200, body: { ok: true, decision: 'pr_failed', prUrl: row.pr_url, detail } }
}

async function retryExistingPrFollowupPush(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (!row.branch || !row.pr_url) return { status: 502, body: { error: 'push_failed', detail: 'missing PR branch/url' } }
  if (!row.delivery_sha) {
    const detail = 'missing verified delivery SHA; refusing to resolve a mutable branch for retry'
    const conflict = casTransition(deps, row, 'pr_failed', {
      deliveryOutcome: 'blocked',
      statusCode: 'branch_verification_failed',
      statusDetail: detail,
    })
    if (conflict) return conflict
    finalizeTransition(deps, row.id)
    return { status: 409, body: { error: 'missing_verified_sha', decision: 'pr_failed', prUrl: row.pr_url, detail } }
  }

  const beforePush = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url, row.delivery_sha,
  )
  if (!beforePush.ok) {
    return persistRetryablePrObservationFailure(
      deps, row, `could not confirm the existing PR is open before retry: ${beforePush.detail}`,
    )
  }
  if (!isExactOpenPr(beforePush, row.branch, row.base_branch)) {
    const identityMatches = matchesRecordedPrIdentity(beforePush, row.branch, row.base_branch)
    if (beforePush.state === 'MERGED' && identityMatches && beforePush.includesExpectedSha === true) {
      return settleMergedPr(deps, row)
    }
    if (beforePush.state === 'MERGED') {
      return rerouteFromStalePr(
        deps,
        row,
        identityMatches ? mergedEvidenceDetail(beforePush) : 'the previous PR merged after its recorded head/base identity changed',
        false,
      )
    }
    if (beforePush.state === 'CLOSED') {
      if (identityMatches && beforePush.includesExpectedSha === true) {
        return settleObservedClosedPr(deps, row, beforePush)
      }
      return rerouteFromStalePr(deps, row, 'the previous PR closed before this implementation was delivered', false)
    }
    return rerouteFromStalePr(
      deps,
      row,
      'the existing open PR no longer matches its recorded head/base identity',
      false,
    )
  }

  if (beforePush.includesExpectedSha === true) {
    return settleObservedExistingPr(deps, row, beforePush, false)
  }

  const pushed = await pushBranch(deps.exec, {
    repoDir: deps.project.path,
    branch: row.branch,
    baseBranch: row.base_branch,
    sourceSha: row.delivery_sha,
  })
  if (pushed.state === 'local-only') {
    const conflict = casTransition(deps, row, 'pr_failed', {
      prState: 'local-only',
      deliveryOutcome: 'retryable_failure',
      statusCode: 'push_failed',
      statusDetail: pushed.reason,
    })
    if (conflict) return conflict
    finalizeTransition(deps, row.id)
    return { status: 200, body: { ok: true, decision: 'pr_failed', prUrl: row.pr_url, detail: pushed.reason } }
  }

  const afterPush = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url, row.delivery_sha,
  )
  if (!afterPush.ok) {
    return persistRetryablePrObservationFailure(
      deps, row, `exact commit was pushed, but the PR lifecycle could not be confirmed: ${afterPush.detail}`,
    )
  }
  if (isExactOpenPr(afterPush, row.branch, row.base_branch)) {
    if (afterPush.includesExpectedSha !== true) {
      return persistRetryablePrObservationFailure(
        deps, row, 'the exact push completed, but the PR does not yet expose the verified commit as its head; Retry push remains safe and uses the preserved SHA',
      )
    }
    return settleObservedExistingPr(deps, row, afterPush, true)
  }
  const identityMatches = matchesRecordedPrIdentity(afterPush, row.branch, row.base_branch)
  if (afterPush.state === 'MERGED' && identityMatches && afterPush.includesExpectedSha === true) {
    return settleMergedPr(deps, row)
  }
  if (afterPush.state === 'MERGED') {
    return rerouteFromStalePr(
      deps,
      row,
      identityMatches ? mergedEvidenceDetail(afterPush) : 'the previous PR merged after its recorded head/base identity changed',
      true,
    )
  }
  if (afterPush.state === 'CLOSED') {
    if (identityMatches && afterPush.includesExpectedSha === true) {
      return settleObservedClosedPr(deps, row, afterPush)
    }
    return rerouteFromStalePr(deps, row, 'the previous PR closed before this implementation was delivered', true)
  }
  return rerouteFromStalePr(
    deps,
    row,
    'the existing open PR no longer matches its recorded head/base identity after the exact push',
    true,
  )
}

/** Naming + body data for a PR's ticket, resolved at create-pr time. */
interface PrTicketData extends TicketNamingInput {
  description?: string | null
}

/**
 * Load the PR's ticket data (title/labels/description) from the ticket store,
 * with the Jira key resolved PER TICKET: the authoritative `jira_links` row
 * prevails over the ticket's `jira_key` field (JIRA ALWAYS PREVAILS), no HTTP.
 * Tolerant of a missing/corrupt store or link table — degrades to bare local
 * ids, never throws, never blocks PR creation.
 */
function loadPrTicketData(deps: PrDecisionDeps, ticketIds: number[]): PrTicketData[] {
  let tickets: Record<string, { title?: string; description?: string; labels?: string[]; jira_key?: string | null }> = {}
  try {
    tickets = readStore(resolveTicketFile(deps)).tickets as typeof tickets
  } catch {
    /* tolerated — the PR falls back to bare ticket refs */
  }
  return ticketIds.map((id) => {
    const t = tickets[String(id)]
    let jiraKey: string | null = t?.jira_key ?? null
    try {
      const link = getLinkByLocalId(deps.db, id)
      if (link && !link.tombstoned && link.jiraKey) jiraKey = link.jiraKey
    } catch {
      /* tolerated — fall back to the ticket field */
    }
    return {
      ticketId: id,
      title: t?.title ?? null,
      labels: t?.labels ?? null,
      description: t?.description ?? null,
      jiraKey,
    }
  })
}

/** True when the branch exists as a local ref in the base repo. */
async function branchExists(deps: PrDecisionDeps, branch: string): Promise<boolean> {
  const r = await deps.git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], deps.project.path)
  return r.code === 0
}

const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i

async function commitObjectExists(deps: PrDecisionDeps, sha: string): Promise<boolean> {
  if (!COMMIT_SHA_RE.test(sha)) return false
  try {
    return (await deps.git.run(['cat-file', '-e', `${sha}^{commit}`], deps.project.path)).code === 0
  } catch {
    return false
  }
}

/** Resolve a legacy mutable ref once into an immutable object. New settlement
 * rows already carry finalSha and never take this compatibility path. */
async function captureBranchSha(deps: PrDecisionDeps, branch: string): Promise<string | null> {
  try {
    const result = await deps.git.run(['rev-parse', '--verify', `refs/heads/${branch}`], deps.project.path)
    const sha = result.code === 0 ? result.stdout.trim() : ''
    return COMMIT_SHA_RE.test(sha) ? sha : null
  } catch {
    return null
  }
}

async function runCreatePr(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (row.decision === 'pr_failed' && row.pr_url && row.branch) {
    return retryExistingPrFollowupPush(deps, row)
  }

  const snap = toPrDeliverySnapshot(row)

  // Resolve every deliverable unit to an immutable object. New rows carry the
  // verified final SHA from settlement; legacy rows may capture their recorded
  // ref once. Never substitute another historical branch merely because it
  // belongs to the same ticket.
  let effectiveBranches = snap.branches
  let branchEvidenceCaptured = false
  const singleDeliverable = snap.branches.filter((unit) => unit.succeeded).length === 1
  const frozenSingleSha = singleDeliverable && row.delivery_sha && COMMIT_SHA_RE.test(row.delivery_sha) &&
    await commitObjectExists(deps, row.delivery_sha)
    ? row.delivery_sha
    : null
  for (let index = 0; index < snap.branches.length; index++) {
    const unit = snap.branches[index]
    if (!unit.succeeded) continue
    // A detached/stale single-unit delivery already has authoritative immutable
    // evidence. Prefer it over both legacy unit gaps and a branch ref that may
    // have advanced while the card waited for the user's decision.
    let sourceSha = frozenSingleSha ?? (unit.finalSha && COMMIT_SHA_RE.test(unit.finalSha) ? unit.finalSha : null)
    if (sourceSha) {
      if (!(await commitObjectExists(deps, sourceSha))) sourceSha = null
    } else {
      sourceSha = await captureBranchSha(deps, unit.branch)
      if (sourceSha && !(await commitObjectExists(deps, sourceSha))) sourceSha = null
    }
    if (!sourceSha) {
      const detail = `the verified commit for branch '${unit.branch}' (ticket #${unit.ticketId}) is unavailable; refusing to deliver a mutable or unrelated ref`
      const conflict = casTransition(deps, row, 'pr_failed', {
        deliveryOutcome: 'blocked', statusCode: 'branch_verification_failed', statusDetail: detail,
      })
      if (conflict) return conflict
      finalizeTransition(deps, row.id)
      return { status: 200, body: { ok: true, decision: 'pr_failed', detail } }
    }
    if (unit.finalSha !== sourceSha) branchEvidenceCaptured = true
    effectiveBranches = effectiveBranches.map((branch, branchIndex) => branchIndex === index
      ? { ...branch, finalSha: sourceSha }
      : branch)
  }

  // Succeeded COVERED tickets for the PR title/body: a single unit covers every
  // launch ticket (scope='all'), per-ticket units cover exactly their own.
  const succeededUnits = effectiveBranches.filter((b) => b.succeeded)
  const succeededTicketIds =
    effectiveBranches.length === 1 && succeededUnits.length === 1
      ? snap.ticketIds
      : succeededUnits.map((b) => b.ticketId)

  const ticketData = loadPrTicketData(deps, succeededTicketIds)
  // The batch name is derived ONLY for multi-unit deliveries — the single-ticket
  // path delivers straight from its unit branch and must never even compute one.
  const batchPreferred = succeededUnits.length > 1 ? batchBranchNameFor(ticketData) : null

  const unitBranches = new Set(effectiveBranches.map((b) => b.branch))

  // Per-ticket covering branch for the body's honest Tests digest: per-ticket
  // units map 1:1; a single 'all'-scope unit covers every launch ticket.
  const branchFor = (ticketId: number): string | null => {
    const unit = succeededUnits.find((b) => b.ticketId === ticketId)
    if (unit) return unit.branch
    return succeededUnits.length === 1 ? succeededUnits[0].branch : null
  }

  // Diffstats are best-effort: a git failure degrades the body (section
  // omitted / "diff unavailable" note), never blocks the PR.
  let changes: Map<string, BranchChanges> | null = null
  try {
    changes = await collectBranchChanges(deps.git, deps.project.path, row.base_branch, succeededUnits.map((b) => b.branch))
  } catch {
    changes = null
  }

  const title = buildPrTitle(ticketData, { loopName: row.loop_name })
  const body = buildCanonicalPrBody({
    loopName: row.loop_name,
    baseBranch: row.base_branch,
    tickets: ticketData.map((t) => ({ ...t, branch: branchFor(t.ticketId) })),
    changes,
  })

  let next: PrDecision
  // Underlying git/gh failure detail for a degraded or failed delivery —
  // relayed on the response and persisted as bounded secondary diagnostics.
  let detail: string | null = null
  const patch: PrDeliveryPatch = {}
  if (branchEvidenceCaptured) patch.branches = effectiveBranches
  try {
    // A degraded multi-unit attempt already owns an assembled batch branch.
    // Retry that exact head so exact head/base PR discovery remains idempotent;
    // never `branch -D` a merely name-matching ref, which could destroy a user's
    // unrelated or subsequently edited local branch.
    let degradedBatchSha: string | null = null
    if (
      batchPreferred && row.branch && row.pr_url === null &&
      (row.pr_state === 'pushed' || row.pr_state === 'local-only') &&
      row.branch !== row.base_branch && !unitBranches.has(row.branch)
    ) {
      if (row.delivery_sha && await commitObjectExists(deps, row.delivery_sha)) {
        degradedBatchSha = row.delivery_sha
      } else {
        degradedBatchSha = await captureBranchSha(deps, row.branch)
      }
    }
    const result = degradedBatchSha
      ? {
          state: 'delivered' as const,
          branch: row.branch!,
          pr: await publishDraftPr(deps.exec, {
            repoDir: deps.project.path,
            branch: row.branch!,
            baseBranch: row.base_branch,
            title,
            body,
            sourceSha: degradedBatchSha,
          }),
          ticketIds: succeededTicketIds,
        }
      : await deliverRailAsPr(deps.git, deps.exec, {
          baseRepo: deps.project.path,
          integrationBranch: row.base_branch,
          railKey: row.rail_key,
          batchBranch: batchPreferred ?? undefined,
          batchWorktreeRoot: batchWorktreeRoot(deps.project.slug),
          branches: effectiveBranches.map((unit) => ({
            ...unit,
            sourceSha: unit.finalSha ?? undefined,
          })),
          title,
          body,
        })
    if (result.state === 'delivered') {
      next = result.pr.state === 'pr-created' && result.pr.isDraft === false ? 'pr_ready' : 'pr_draft'
      patch.branch = result.branch
      patch.prState = result.pr.state
      const resultSha = degradedBatchSha
        ?? (succeededUnits.length === 1 ? succeededUnits[0].finalSha ?? null : await captureBranchSha(deps, result.branch))
      if (resultSha && await commitObjectExists(deps, resultSha)) patch.deliverySha = resultSha
      if (result.pr.state === 'pr-created' && result.pr.prUrl) {
        patch.prUrl = result.pr.prUrl
        patch.prNumber = parsePrNumber(result.pr.prUrl)
        patch.deliveryOutcome = 'delivered'
        patch.statusCode = next === 'pr_ready' ? 'pr_ready' : 'pr_draft_ready'
      } else {
        // Degraded (pushed / local-only): no PR exists — only retry or discard.
        patch.prUrl = null
        patch.prNumber = null
        detail = result.pr.reason ?? null
        patch.deliveryOutcome = 'retryable_failure'
        patch.statusCode = result.pr.state === 'local-only' ? 'push_failed' : 'delivery_failed'
      }
    } else {
      // 'assembly-failed' (or an unexpected 'no-op' — settle guarantees ≥1
      // succeeded unit, but a wedged row must not 500) → retryable failure.
      next = 'pr_failed'
      detail = result.reason
      const retryable = !result.reason.startsWith('merge-conflict:') &&
        !result.reason.startsWith('batch-branch-collision:') &&
        result.reason !== 'missing-batch-branch' && result.state === 'assembly-failed'
      patch.deliveryOutcome = retryable ? 'retryable_failure' : 'blocked'
      patch.statusCode = 'delivery_failed'
    }
  } catch (err) {
    // publishDraftPr can propagate GitGuardrailError — a guardrail violation is
    // a retryable delivery failure, never a crash.
    console.error('[rail-pr-decision] create-pr delivery failed:', err)
    next = 'pr_failed'
    detail = err instanceof Error ? err.message : String(err)
    patch.deliveryOutcome = 'blocked'
    patch.statusCode = 'delivery_failed'
  }

  if (detail) patch.statusDetail = detail
  if ((next === 'pr_draft' || next === 'pr_ready') && patch.prUrl) {
    patch.cleanupWarnings = await releaseRailWorktrees({
      db: deps.db, git: deps.git, repoDir: deps.project.path, worktreeIds: releasableWorktreeIds(deps, snap),
      expectedHeadByBranch: durableBranchHeads(effectiveBranches),
      overlayEvidenceByBranch: durableOverlayCleanupEvidence(effectiveBranches),
      onSafetyArchive: safetyArchiveRecorder(deps, row),
    })
    if (patch.cleanupWarnings.length > 0) patch.statusCode = 'cleanup_incomplete'
  }
  const conflict = casTransition(deps, row, next, patch)
  if (conflict) return conflict
  const after = finalizeTransition(deps, row.id)
  // Tickets stay on_review — a draft PR is still awaiting the engineer's merge.
  return {
    status: 200,
    body: {
      ok: true,
      decision: next,
      prUrl: after?.prUrl ?? null,
      prState: after?.prState ?? row.pr_state,
      ...(detail ? { detail } : {}),
    },
  }
}

async function runPublish(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (!row.delivery_sha || !row.branch) {
    return persistMovedPrHead(
      deps,
      row,
      'the draft PR has no immutable delivery SHA/head identity; refusing to mutate unverifiable review state',
    )
  }

  const beforePublish = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url!, row.delivery_sha,
  )
  if (!beforePublish.ok) {
    return { status: 502, body: { error: 'gh_failed', detail: beforePublish.detail } }
  }
  if (!matchesRecordedPrIdentity(beforePublish, row.branch, row.base_branch)) {
    return rerouteFromStalePr(
      deps,
      row,
      `the recorded PR is ${beforePublish.state.toLowerCase()} but no longer matches its original head/base identity`,
      beforePublish.includesExpectedSha === true,
    )
  }
  if (beforePublish.state === 'MERGED') {
    return beforePublish.includesExpectedSha === true
      ? settleMergedPr(deps, row)
      : rerouteFromStalePr(deps, row, mergedEvidenceDetail(beforePublish), false)
  }
  if (beforePublish.state === 'CLOSED') {
    return beforePublish.includesExpectedSha === true
      ? settleObservedClosedPr(deps, row, beforePublish)
      : rerouteFromStalePr(deps, row, 'the draft PR closed without the verified implementation commit', false)
  }
  if (beforePublish.includesExpectedSha !== true) {
    return persistRetryablePrObservationFailure(
      deps,
      row,
      'the draft PR no longer exposes the verified implementation commit; Retry push is available and will use the preserved exact SHA',
    )
  }
  if (beforePublish.isDraft === false) {
    return settleObservedExistingPr(deps, row, beforePublish, false)
  }

  let r: ExecResult
  try {
    r = await deps.exec.run('gh', ['pr', 'ready', row.pr_url!], deps.project.path)
  } catch (err) {
    r = { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
  // `gh pr ready` is externally mutating and may return an ambiguous error.
  // Re-observe exact remote truth in every case before changing the ledger.
  const afterPublish = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url!, row.delivery_sha,
  )
  if (!afterPublish.ok) {
    if (r.code !== 0) return ghFailed(r)
    return { status: 502, body: { error: 'gh_failed', detail: `PR readiness could not be verified: ${afterPublish.detail}` } }
  }
  if (!matchesRecordedPrIdentity(afterPublish, row.branch, row.base_branch)) {
    return rerouteFromStalePr(
      deps,
      row,
      `the PR identity changed while publishing it for review (${afterPublish.state.toLowerCase()})`,
      afterPublish.includesExpectedSha === true,
    )
  }
  if (afterPublish.state === 'MERGED') {
    return afterPublish.includesExpectedSha === true
      ? settleMergedPr(deps, row)
      : rerouteFromStalePr(deps, row, mergedEvidenceDetail(afterPublish), false)
  }
  if (afterPublish.state === 'CLOSED') {
    return afterPublish.includesExpectedSha === true
      ? settleObservedClosedPr(deps, row, afterPublish)
      : rerouteFromStalePr(deps, row, 'the PR closed without the verified implementation commit while being published', false)
  }
  if (afterPublish.includesExpectedSha !== true) {
    return persistRetryablePrObservationFailure(
      deps,
      row,
      'the PR no longer exposes the verified implementation commit after publishing; Retry push is available',
    )
  }
  if (afterPublish.isDraft) {
    if (r.code !== 0) return ghFailed(r)
    return { status: 502, body: { error: 'gh_failed', detail: 'PR remained a draft after publishing' } }
  }
  return settleObservedExistingPr(deps, row, afterPublish, false)
}

async function runDiscard(
  deps: PrDecisionDeps,
  row: RailPrDeliveryRow,
  opts: { removeNeedsReview?: boolean } = { removeNeedsReview: true },
): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const implementationFailed = row.decision === 'implementation_failed'
  // PR lifecycle ownership and head-ref ownership are separate. Startup repairs
  // historical continuation rows before admission opens; only that durable bit
  // borrows the PR/ticket lifecycle. Per-unit ownership below independently
  // prevents deletion of borrowed/pre-existing head refs for fresh replacements.
  const preserveExternalReview = row.is_continuation === 1
  const cleanupWarnings: string[] = []

  // A continuation borrows an existing PR/head. Discarding its local iteration
  // may remove Specrails' worktree, but never closes or deletes borrowed review
  // state. A fresh PR is closed without GitHub's unleased --delete-branch: its
  // remote head may have advanced since the card was rendered.
  if (row.pr_url && !implementationFailed && !preserveExternalReview) {
    try {
      const r = await deps.exec.run('gh', ['pr', 'close', row.pr_url], deps.project.path)
      if (r.code !== 0) {
        const detail = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`
        cleanupWarnings.push(`PR close ${row.pr_url}: ${detail}`)
        console.warn(`[rail-pr-decision] gh pr close failed (continuing discard): ${detail}`)
      }
    } catch (err) {
      cleanupWarnings.push(`PR close ${row.pr_url}: ${err instanceof Error ? err.message : String(err)}`)
      console.warn('[rail-pr-decision] gh pr close threw (continuing discard):', err)
    }
  }

  // 2. Release only worktrees whose live tracked/untracked/ignored state and
  //    exact HEAD/ref still match durable settlement evidence. Explicit
  //    discard is not permission to contradict the confirmation copy by
  //    force-removing subsequently changed local work. Authenticated overlays
  //    take the same lossless quarantine path as automatic settlement.
  const deleteOwnedBranches = !implementationFailed && !preserveExternalReview
  const skippedNeedsReview = opts.removeNeedsReview === true
    ? []
    : snap.worktreeIds
        .map((wtId) => getRailWorktree(deps.db, wtId))
        .filter((wt) => wt?.merge_state === 'needs-review')
  for (const worktree of skippedNeedsReview) {
    cleanupWarnings.push(
      `worktree ${worktree!.worktree_path}: preserved for inspection because it already requires review`,
    )
  }
  const skippedIds = new Set(skippedNeedsReview.map((wt) => wt!.id))
  const worktreeIds = snap.worktreeIds.filter((wtId) => !skippedIds.has(wtId))
  cleanupWarnings.push(...await releaseRailWorktrees({
    db: deps.db,
    git: deps.git,
    repoDir: deps.project.path,
    worktreeIds,
    state: 'failed',
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  }))

  const retainedWorktreeBranches = new Set(
    snap.worktreeIds
      .map((wtId) => getRailWorktree(deps.db, wtId))
      .filter((wt) => Boolean(wt && (wt.merge_state === 'needs-review' || fs.existsSync(wt.worktree_path))))
      .map((wt) => wt!.branch),
  )

  // 3. Delete only branches this delivery durably records as created, and only
  //    while their live tips still equal the immutable delivered commits.
  //    Later user/collaborator commits are retained with a cleanup warning.
  if (deleteOwnedBranches) {
    await deleteOwnedBranchesIfUnchanged(deps, row, snap, cleanupWarnings, retainedWorktreeBranches)
  }

  const terminalPatch: PrDeliveryPatch = {
    deliveryOutcome: 'not_started',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'discarded',
    cleanupWarnings,
  }
  const conflict = preserveExternalReview
    ? casTransition(deps, row, 'discarded', terminalPatch)
    : casTransitionWithTicketEffect(deps, row, 'discarded', terminalPatch, {
        deliveryId: row.id,
        ticketIds: snap.ticketIds,
        targetStatus: 'todo',
        // The dashboard labels discard-from-no_changes as Refine. Jira must
        // mirror that truthful backlog return and never apply discardStatus.
        jiraAction: row.decision === 'no_changes' ? 'refine' : 'discard',
        prUrl: null,
      })
  if (conflict) return conflict
  if (!preserveExternalReview) applyTerminalTicketEffect(deps, row, 'discarded', cleanupWarnings)
  finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'discarded',
      ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      ...(preserveExternalReview ? { preservedBorrowedReview: true, preservedExternalReview: true } : {}),
    },
  }
}

async function runDismiss(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  // Legality restricts dismiss to a clean/retryable continuation. Reuse the
  // ownership-safe discard path; its external PR, head and tickets are borrowed.
  return runDiscard(deps, row, { removeNeedsReview: false })
}

async function runAcknowledgeNoChanges(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings = await releaseRailWorktrees({
    db: deps.db,
    git: deps.git,
    repoDir: deps.project.path,
    worktreeIds: snap.worktreeIds,
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  })

  // A fresh no-change branch is disposable only while Git still proves that it
  // has no commits ahead of the integration base. If the user added work after
  // settlement, preserve it and disclose the incomplete cleanup.
  for (const branch of ownedDeliveryBranches(row, snap, cleanupWarnings)) {
    if (!branch || branch === row.base_branch) continue
    try {
      const ahead = await deps.git.run(['rev-list', '--count', `${row.base_branch}..${branch}`], deps.project.path)
      if (ahead.code !== 0 || Number.parseInt(ahead.stdout.trim(), 10) !== 0) {
        cleanupWarnings.push(`branch ${branch}: retained because no-change cleanup could not prove it has zero commits ahead of ${row.base_branch}`)
        continue
      }
      const deleted = await deps.git.run(['branch', '-d', branch], deps.project.path)
      if (deleted.code !== 0) {
        cleanupWarnings.push(`branch ${branch}: ${(deleted.stderr.trim() || deleted.stdout.trim()).split('\n')[0] || `exit ${deleted.code}`}`)
      }
    } catch (err) {
      cleanupWarnings.push(`branch ${branch}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const conflict = casTransitionWithTicketEffect(deps, row, 'completed', {
    deliveryOutcome: 'no_changes',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'no_changes',
    cleanupWarnings,
  }, {
    deliveryId: row.id,
    ticketIds: snap.ticketIds,
    targetStatus: 'done',
    jiraAction: 'completed',
    prUrl: null,
  })
  if (conflict) return conflict
  applyTerminalTicketEffect(deps, row, 'completed', cleanupWarnings)
  finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true,
      decision: 'completed',
      noChanges: true,
      ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
    },
  }
}

async function settleMergedPr(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings = await releaseRailWorktrees({
    db: deps.db, git: deps.git, repoDir: deps.project.path,
    worktreeIds: releasableWorktreeIds(deps, snap), state: 'merged',
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  })
  await deleteOwnedBranchesIfUnchanged(deps, row, snap, cleanupWarnings)

  const conflict = casTransitionWithTicketEffect(deps, row, 'merged', {
    deliveryOutcome: 'delivered',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'merged',
    statusDetail: null,
    cleanupWarnings,
  }, {
    deliveryId: row.id,
    ticketIds: snap.ticketIds,
    targetStatus: 'done',
    jiraAction: 'merged',
    prUrl: row.pr_url,
  })
  if (conflict) return conflict
  applyTerminalTicketEffect(deps, row, 'merged', cleanupWarnings)
  finalizeTransition(deps, row.id)
  return { status: 200, body: { ok: true, decision: 'merged', merged: true, prUrl: row.pr_url } }
}

async function runPollMerge(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  const observed = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url!, row.delivery_sha,
  )
  if (!observed.ok) return { status: 502, body: { error: 'gh_failed', detail: observed.detail } }
  const { state, isDraft } = observed

  if (!row.branch) {
    return persistMovedPrHead(
      deps, row, `the ${state.toLowerCase()} PR has no recorded delivery branch; refusing to infer recoverable work`,
    )
  }
  if (!row.delivery_sha) {
    // A legacy OPEN row cannot be retried without an immutable object. Once the
    // attached PR is terminal, however, keeping that stale URL would strand the
    // only recorded branch behind Discard. Detach it so Create PR can perform
    // the existing one-time legacy ref capture, without claiming any delivery.
    if (state === 'CLOSED' || state === 'MERGED') {
      return rerouteFromStalePr(
        deps,
        row,
        `the previous PR is ${state.toLowerCase()} and this legacy delivery has no persisted verified SHA`,
        false,
      )
    }
    return persistMovedPrHead(
      deps, row, 'the open PR has no persisted verified delivery SHA; refusing to infer delivery from a mutable branch',
    )
  }
  if (!matchesRecordedPrIdentity(observed, row.branch, row.base_branch)) {
    return rerouteFromStalePr(
      deps,
      row,
      `the recorded PR is ${state.toLowerCase()} but no longer matches its original head/base identity`,
      observed.includesExpectedSha === true,
    )
  }

  if (state === 'CLOSED') {
    if (observed.includesExpectedSha !== true) {
      return rerouteFromStalePr(
        deps,
        row,
        'the previous PR closed without the verified implementation commit',
        false,
      )
    }
    return settleObservedClosedPr(deps, row, observed)
  }

  if (state === 'OPEN') {
    if (observed.includesExpectedSha !== true) {
      const detail = 'the open PR no longer exposes the verified implementation commit; Retry push is available and will use the preserved exact SHA'
      const result = persistRetryablePrObservationFailure(deps, row, detail)
      return {
        ...result,
        body: {
          ...result.body,
          deliveryVerified: false,
          verifiedSha: row.delivery_sha,
          remoteHeadSha: observed.headRefOid,
        },
      }
    }
    // A successful reopen can be observed even if the explicit action lost its
    // follow-up `gh view` response. Polling heals pr_closed from remote truth.
    if (row.decision === 'pr_closed') {
      const next = isDraft ? 'pr_draft' as const : 'pr_ready' as const
      const conflict = casTransition(deps, row, next, {
        deliveryOutcome: 'delivered', statusCode: isDraft ? 'pr_draft_ready' : 'pr_ready',
      })
      if (conflict) return conflict
      finalizeTransition(deps, row.id)
      return {
        status: 200,
        body: {
          ok: true,
          decision: next,
          merged: false,
          reopened: true,
          prUrl: row.pr_url,
          deliveryVerified: true,
          verifiedSha: row.delivery_sha,
          remoteHeadSha: observed.headRefOid,
          pushed: false,
        },
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        decision: row.decision,
        merged: false,
        deliveryVerified: true,
        verifiedSha: row.delivery_sha,
        remoteHeadSha: observed.headRefOid,
        pushed: false,
      },
    }
  }

  if (state !== 'MERGED') {
    return { status: 502, body: { error: 'gh_failed', detail: `unexpected PR state: ${state}` } }
  }

  // A PR can merge just before a continuation push; GitHub may then accept a
  // later update to the head branch even though that object was never part of
  // the merge. Never move tickets to Done from state=MERGED alone.
  if (observed.includesExpectedSha !== true) {
    return rerouteFromStalePr(deps, row, mergedEvidenceDetail(observed), false)
  }

  return settleMergedPr(deps, row)
}

async function runReopen(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  if (!row.delivery_sha || !row.branch) {
    return rerouteFromStalePr(
      deps,
      row,
      'the closed PR cannot be reopened safely because its immutable delivery SHA/head identity is unavailable',
      false,
    )
  }
  const beforeReopen = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url!, row.delivery_sha,
  )
  if (!beforeReopen.ok) {
    return { status: 502, body: { error: 'gh_failed', detail: beforeReopen.detail } }
  }
  if (
    !matchesRecordedPrIdentity(beforeReopen, row.branch, row.base_branch) ||
    beforeReopen.includesExpectedSha !== true
  ) {
    return rerouteFromStalePr(
      deps,
      row,
      'the closed PR no longer proves the recorded head/base and verified implementation commit',
      false,
    )
  }
  if (beforeReopen.state === 'MERGED') return settleMergedPr(deps, row)
  if (beforeReopen.state === 'OPEN') {
    const next = beforeReopen.isDraft ? 'pr_draft' as const : 'pr_ready' as const
    const conflict = casTransition(deps, row, next, {
      deliveryOutcome: 'delivered', statusCode: beforeReopen.isDraft ? 'pr_draft_ready' : 'pr_ready',
      statusDetail: null,
    })
    if (conflict) return conflict
    finalizeTransition(deps, row.id)
    return {
      status: 200,
      body: {
        ok: true, decision: next, reopened: true, prUrl: row.pr_url,
        deliveryVerified: true, verifiedSha: row.delivery_sha,
        remoteHeadSha: beforeReopen.headRefOid, pushed: false,
      },
    }
  }

  let reopened: ExecResult
  try {
    reopened = await deps.exec.run('gh', ['pr', 'reopen', row.pr_url!], deps.project.path)
  } catch (err) {
    reopened = { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
  const observed = await observeGithubPrLifecycle(
    deps.exec, deps.project.path, row.pr_url!, row.delivery_sha,
  )
  if (!observed.ok) {
    if (reopened.code !== 0) return ghFailed(reopened)
    return { status: 502, body: { error: 'gh_failed', detail: observed.detail } }
  }
  const identityMatches = matchesRecordedPrIdentity(observed, row.branch, row.base_branch)
  if (observed.state === 'MERGED') {
    if (identityMatches && observed.includesExpectedSha === true) return settleMergedPr(deps, row)
    return rerouteFromStalePr(
      deps,
      row,
      identityMatches ? mergedEvidenceDetail(observed) : 'the PR identity changed while it was being reopened',
      false,
    )
  }
  if (observed.state === 'CLOSED') {
    if (!identityMatches || observed.includesExpectedSha !== true) {
      return rerouteFromStalePr(
        deps,
        row,
        'the PR remained closed without proving the recorded head/base and verified implementation commit',
        false,
      )
    }
    if (reopened.code !== 0) return ghFailed(reopened)
    return { status: 502, body: { error: 'gh_failed', detail: 'PR remained closed after reopen' } }
  }
  if (!identityMatches || observed.includesExpectedSha !== true) {
    return rerouteFromStalePr(
      deps,
      row,
      'the reopened PR no longer proves the recorded head/base and verified implementation commit',
      true,
    )
  }

  const next = observed.isDraft ? 'pr_draft' as const : 'pr_ready' as const
  const conflict = casTransition(deps, row, next, {
    deliveryOutcome: 'delivered', statusCode: observed.isDraft ? 'pr_draft_ready' : 'pr_ready',
    statusDetail: null,
  })
  if (conflict) return conflict
  finalizeTransition(deps, row.id)
  return {
    status: 200,
    body: {
      ok: true, decision: next, reopened: true, prUrl: row.pr_url,
      deliveryVerified: true, verifiedSha: row.delivery_sha,
      remoteHeadSha: observed.headRefOid, pushed: false,
    },
  }
}

async function runMergeLocal(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  return withRepoLock(deps.project.path, () => runMergeLocalLocked(deps, row))
}

async function runMergeLocalLocked(deps: PrDecisionDeps, row: RailPrDeliveryRow): Promise<PrDecisionResult> {
  deps.assertAdmission?.()
  const snap = toPrDeliverySnapshot(row)
  const cleanupWarnings: string[] = []

  // Snapshot the checkout the user authorized. The same three invariants are
  // revalidated immediately before the one final fast-forward.
  const head = await deps.git.run(['rev-parse', '--abbrev-ref', 'HEAD'], deps.project.path)
  const currentBranch = head.code === 0 ? head.stdout.trim() : ''
  if (currentBranch !== row.base_branch) {
    return {
      status: 409,
      body: { error: 'merge_local_blocked', reason: 'wrong_branch', current: currentBranch || null, base: row.base_branch },
    }
  }
  const status = await deps.git.run(['status', '--porcelain'], deps.project.path)
  if (status.code !== 0 || status.stdout.trim() !== '') {
    return { status: 409, body: { error: 'merge_local_blocked', reason: 'dirty', base: row.base_branch } }
  }
  const startingHead = await deps.git.run(['rev-parse', '--verify', 'HEAD'], deps.project.path)
  const startingSha = startingHead.code === 0 ? startingHead.stdout.trim() : ''
  if (!/^[0-9a-f]{40,64}$/i.test(startingSha)) {
    return { status: 409, body: { error: 'merge_local_blocked', reason: 'unresolved_head', base: row.base_branch } }
  }

  // What to merge: immutable object ids only. The assembled head carries every
  // unit already; without one, merge each settled unit's exact final SHA.
  let toMerge: string[]
  let deliveryHeadSha: string | null = null
  if (row.delivery_sha && await commitObjectExists(deps, row.delivery_sha)) {
    deliveryHeadSha = row.delivery_sha
  } else if (row.branch) {
    deliveryHeadSha = await captureBranchSha(deps, row.branch)
  }
  if (deliveryHeadSha) {
    toMerge = [deliveryHeadSha]
  } else {
    toMerge = []
    for (const unit of snap.branches.filter((b) => b.succeeded)) {
      let sourceSha = unit.finalSha && COMMIT_SHA_RE.test(unit.finalSha) ? unit.finalSha : null
      if (sourceSha) {
        if (!(await commitObjectExists(deps, sourceSha))) sourceSha = null
      } else {
        sourceSha = await captureBranchSha(deps, unit.branch)
      }
      if (!sourceSha) {
        return {
          status: 502,
          body: { error: 'merge_failed', detail: `verified commit for '${unit.branch}' (ticket #${unit.ticketId}) is unavailable` },
        }
      }
      toMerge.push(sourceSha)
    }
  }
  if (toMerge.length === 0) {
    return { status: 502, body: { error: 'merge_failed', detail: 'no succeeded branch to merge' } }
  }

  // Assemble every merge away from the user's checkout. A conflict can only
  // dirty this disposable detached worktree, never the integration branch.
  const safeId = row.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'delivery'
  const assemblyPath = path.join(deps.assemblyRoot ?? batchWorktreeRoot(deps.project.slug), `local-merge-${safeId}-${newId()}`)
  const added = await deps.git.run(['worktree', 'add', '--detach', assemblyPath, startingSha], deps.project.path)
  if (added.code !== 0) {
    const detail = (added.stderr.trim() || added.stdout.trim()).split('\n')[0] || `exit ${added.code}`
    return { status: 502, body: { error: 'merge_failed', detail: `creating isolated assembly: ${detail}` } }
  }

  const removeAssembly = async (): Promise<void> => {
    try {
      const removed = await deps.git.run(['worktree', 'remove', '--force', assemblyPath], deps.project.path)
      if (removed.code !== 0) {
        cleanupWarnings.push(`assembly worktree ${assemblyPath}: ${(removed.stderr.trim() || removed.stdout.trim()).split('\n')[0] || `exit ${removed.code}`}`)
      }
    } catch (err) {
      cleanupWarnings.push(`assembly worktree ${assemblyPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const persistAssemblyFailure = (detail: string): PrDecisionResult | null => {
    const conflict = casTransition(deps, row, row.decision, {
      deliveryOutcome: 'blocked', statusCode: 'delivery_failed', statusDetail: detail, cleanupWarnings,
    })
    if (conflict) return conflict
    finalizeTransition(deps, row.id)
    return null
  }

  for (const branch of toMerge) {
    const r = await deps.git.run(['merge', '--no-ff', '--no-edit', branch], assemblyPath)
    if (r.code !== 0) {
      try {
        const aborted = await deps.git.run(['merge', '--abort'], assemblyPath)
        if (aborted.code !== 0) cleanupWarnings.push(`assembly abort ${branch}: exit ${aborted.code}`)
      } catch (err) {
        cleanupWarnings.push(`assembly abort ${branch}: ${err instanceof Error ? err.message : String(err)}`)
      }
      await removeAssembly()
      const detail = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`
      const conflict = persistAssemblyFailure(`merging '${branch}': ${detail}`)
      if (conflict) return conflict
      return { status: 502, body: { error: 'merge_failed', detail: `merging '${branch}': ${detail}` } }
    }
  }

  const assembled = await deps.git.run(['rev-parse', '--verify', 'HEAD'], assemblyPath)
  const assembledSha = assembled.code === 0 ? assembled.stdout.trim() : ''
  if (!/^[0-9a-f]{40,64}$/i.test(assembledSha)) {
    await removeAssembly()
    const detail = 'isolated assembly produced no verifiable HEAD'
    const conflict = persistAssemblyFailure(detail)
    if (conflict) return conflict
    return { status: 502, body: { error: 'merge_failed', detail } }
  }

  const [finalBranch, finalStatus, finalHead] = await Promise.all([
    deps.git.run(['rev-parse', '--abbrev-ref', 'HEAD'], deps.project.path),
    deps.git.run(['status', '--porcelain'], deps.project.path),
    deps.git.run(['rev-parse', '--verify', 'HEAD'], deps.project.path),
  ])
  const changedReason = finalBranch.code !== 0 || finalBranch.stdout.trim() !== row.base_branch
    ? 'wrong_branch'
    : finalStatus.code !== 0 || finalStatus.stdout.trim() !== ''
      ? 'dirty'
      : finalHead.code !== 0 || finalHead.stdout.trim() !== startingSha
        ? 'head_changed'
        : null
  if (changedReason) {
    await removeAssembly()
    if (cleanupWarnings.length > 0) {
      const conflict = casTransition(deps, row, row.decision, { cleanupWarnings })
      if (conflict) return conflict
      finalizeTransition(deps, row.id)
    }
    return { status: 409, body: { error: 'merge_local_blocked', reason: changedReason, base: row.base_branch } }
  }

  const advanced = await deps.git.run(['merge', '--ff-only', assembledSha], deps.project.path)
  if (advanced.code !== 0) {
    await removeAssembly()
    const detail = (advanced.stderr.trim() || advanced.stdout.trim()).split('\n')[0] || `exit ${advanced.code}`
    const conflict = persistAssemblyFailure(`advancing '${row.base_branch}': ${detail}`)
    if (conflict) return conflict
    return { status: 502, body: { error: 'merge_failed', detail: `advancing '${row.base_branch}': ${detail}` } }
  }
  await removeAssembly()

  // Post-advance sweep: the work now lives on
  // the integration branch, so the launch's worktrees + branches are spent.
  cleanupWarnings.push(...await releaseRailWorktrees({
    db: deps.db,
    git: deps.git,
    repoDir: deps.project.path,
    worktreeIds: releasableWorktreeIds(deps, snap),
    state: 'merged',
    expectedHeadByBranch: durableBranchHeads(snap.branches),
    overlayEvidenceByBranch: durableOverlayCleanupEvidence(snap.branches),
    onSafetyArchive: safetyArchiveRecorder(deps, row),
  }))
  await deleteOwnedBranchesIfUnchanged(deps, row, snap, cleanupWarnings)

  const conflict = casTransitionWithTicketEffect(deps, row, 'merged', {
    deliveryOutcome: 'delivered',
    statusCode: cleanupWarnings.length > 0 ? 'cleanup_incomplete' : 'merged',
    cleanupWarnings,
  }, {
    deliveryId: row.id,
    ticketIds: snap.ticketIds,
    targetStatus: 'done',
    jiraAction: 'merged',
    prUrl: null,
  })
  if (conflict) return conflict
  applyTerminalTicketEffect(deps, row, 'merged', cleanupWarnings)
  finalizeTransition(deps, row.id)
  return { status: 200, body: { ok: true, decision: 'merged', merged: true, local: true } }
}

function resolveTicketFile(deps: PrDecisionDeps): string {
  if (deps.ticketFile) return deps.ticketFile
  const exec = resolveProjectExecution({ slug: deps.project.slug, path: deps.project.path })
  return exec.relocated ? exec.ticketsPath : resolveTicketStoragePath(deps.project.path)
}
