/**
 * Helpers shared by the isolated launch stages and restart recovery: revision
 * briefing and spec snapshots, commit messages, continuation / Intent worktree
 * verification, settlement ignored-path capture and branch records.
 */
import * as path from 'path'
import * as fs from 'fs'
import { normalizeSpecIntent, type SpecIntent } from '../../specs/domain/intent'
import { readStore } from '../../specs/runtime/ticket-store'
import type { GitRunner, WorktreeHandle, CommitWorktreeResult } from '../../../worktree-manager'
import { IntentWorktreeMismatchError, type RequiredFlowWorktree } from './flow-worktree-handoff'
import { ticketRef, buildPrTitle } from './pr-naming'
import { readHeadSha, ticketNamingInput } from './isolated-worktree'
import type { DbInstance } from '../../../db'
import { readSettleEvidence } from './delivery-evidence'
import {
  getPrDelivery, readSpecSnapshot, type DeliverBranchRecord, type DeliverySpecSnapshotEntry, type PrImplementationOutcome,
} from './rail-pr-store'
import { getRail } from './rails-store'
import { buildRevisionSeed } from '../../execution/runtime/revision-seed'
import { ticketStorePathForProject } from '../../specs/runtime/spec-addenda'
import type { ActivePrContinuationTarget } from './active-pr-continuation'
import type { ProjectContext } from '../../../project-registry'
import type { IsolatedLaunchInput, AllocatedRun, SettledRun } from './rail-isolated-launch-contracts'
import { PrContinuationIsolationError } from './rail-isolated-launch-contracts'

/**
 * Assemble the revision briefing from the generation being revised. Reads only
 * durable rows, tolerates every one of them being absent (a legacy row carries
 * no snapshot or evidence), and never throws — a thinner briefing is far better
 * than a failed revision launch.
 */
export function buildRevisionSeedForLaunch(
  db: DbInstance,
  revision: NonNullable<IsolatedLaunchInput['revision']>,
  ticketIds: readonly number[],
  includeSpecBody = true,
): { briefing: string; number: number } {
  try {
    const previous = getPrDelivery(db, revision.ofDeliveryId)
    const branches = previous
      ? [...new Set((JSON.parse(previous.branches || '[]') as DeliverBranchRecord[]).map((b) => b.branch).filter(Boolean))]
      : []
    // Revision depth walks the supersession chain, bounded so a corrupted
    // lineage can never spin here.
    let depth = 1
    let cursor = previous
    for (let hops = 0; hops < 20 && cursor?.revision_of; hops++) {
      depth += 1
      cursor = getPrDelivery(db, cursor.revision_of) ?? undefined
    }
    return { number: depth, briefing: buildRevisionSeed({
      note: revision.note,
      includeSpecBody,
      specSnapshot: previous ? readSpecSnapshot(previous.spec_snapshot) : null,
      ticketIds: [...ticketIds],
      branches,
      baseBranch: previous?.base_branch ?? 'the integration branch',
      branchDiffSummary: null,
      evidence: previous ? readSettleEvidence(previous.settle_evidence) : null,
      revisionNumber: depth,
    }) }
  } catch {
    // Absolute floor: the user's instruction still reaches the run.
    return { briefing: revision.note, number: 1 }
  }
}

/** The intent of a one-spec run's spec (a batch run carries several and writes none). */
export function runIntent(ctx: ProjectContext, run: Pick<AllocatedRun, 'ticketIds'>): { intent: SpecIntent; title: string | null } | null {
  if (run.ticketIds.length !== 1) return null
  try {
    const ticket = readStore(ticketStorePathForProject(ctx.project)).tickets[String(run.ticketIds[0])]
    const intent = normalizeSpecIntent(ticket?.intent)
    return intent ? { intent, title: ticket?.title ?? null } : null
  } catch {
    return null
  }
}

/**
 * Launch-time freeze of every covered ticket for the delivery row's
 * spec_snapshot column (migration 56). The review packet's "what you asked"
 * section renders this snapshot, never the live store — a spec edited mid-run
 * must not rewrite what the delivery was asked to do. Failure-tolerant: an
 * unreadable ticket degrades to a bare-id entry.
 */
export function buildSpecSnapshot(ctx: ProjectContext, ticketIds: readonly number[]): DeliverySpecSnapshotEntry[] {
  return ticketIds.map((ticketId) => {
    let spec: { title?: string; description?: string; labels?: string[] } | undefined
    try {
      spec = ctx.getTicketSpec(ticketId) as typeof spec
    } catch {
      /* tolerated — snapshot stays bare */
    }
    return {
      ticketId,
      title: spec?.title ?? null,
      description: spec?.description ?? null,
      labels: Array.isArray(spec?.labels) ? spec.labels : [],
    }
  })
}

/**
 * Commit messages are consumed by GitHub↔Jira development panels. Branch names
 * already carry the Jira key for new work; commits must too, especially when
 * continuing an existing PR whose branch name may predate the current ticket
 * key. Keep the local id as a fallback/cross-reference for Specrails.
 */
export function worktreeCommitMessage(ctx: ProjectContext, ticketId: number, runId: string, partial = false): string {
  const input = ticketNamingInput(ctx, ticketId)
  const ref = ticketRef(input)
  const subject = partial
    ? buildPrTitle([{ ...input, labels: ['chore'] }])
    : buildPrTitle([input])
  const run = runId.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
  return `${subject}\n\nRun: ${run}${ref !== String(ticketId) ? `\nTicket: ticket-${ticketId}` : ''}${partial ? '\n(partial)' : ''}`
}

export function commitFailureSummary(result: CommitWorktreeResult): string {
  const dirty = result.dirty.length > 0 ? `; dirty=${result.dirty.slice(0, 8).join(', ')}` : ''
  return `${result.error ?? 'worktree still has uncommitted deliverable changes'}${dirty}`
}

export const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i

/** Prove that the linked checkout is on the expected PR branch and that its
 * HEAD is exactly the commit named by refs/heads/<branch>. When expectedHeadSha
 * is supplied (allocation and pre-push phases), also freeze the checkout to
 * that immutable object. Post-run verification deliberately omits the old
 * baseline because a successful implementation is expected to create a new
 * commit. The handle's branch string alone is insufficient: createWorktree may
 * reuse a stale mounted path. */
export async function verifyContinuationWorktree(
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

function canonicalPath(value: string): string {
  try { return fs.realpathSync.native(value) } catch { return path.resolve(value) }
}

/** The adopted mount must be the Intent's own path, on its branch, at its frozen HEAD. */
export async function verifyFlowWorktree(git: GitRunner, mounted: WorktreeHandle, required: RequiredFlowWorktree): Promise<string> {
  if (canonicalPath(mounted.worktreePath) !== canonicalPath(required.worktreePath)) {
    throw new IntentWorktreeMismatchError(`The Intent worktree is not mounted at ${required.worktreePath}`)
  }
  if (mounted.branch !== required.branch) {
    throw new IntentWorktreeMismatchError(`The Intent worktree is on ${mounted.branch}, not ${required.branch}`)
  }
  const head = await readHeadSha(git, mounted.worktreePath)
  if (!head || head !== required.headSha) {
    throw new IntentWorktreeMismatchError(`The Intent worktree HEAD ${head ?? 'unknown'} does not match the frozen ${required.headSha}`)
  }
  return head
}

export async function branchHasDelta(git: GitRunner, cwd: string, baseRef: string): Promise<boolean | null> {
  try {
    const result = await git.run(['diff', '--quiet', `${baseRef}...HEAD`, '--'], cwd)
    if (result.code === 0) return false
    if (result.code === 1) return true
    return null
  } catch {
    return null
  }
}

export function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function aggregateImplementationOutcome(results: readonly SettledRun[]): PrImplementationOutcome {
  const succeeded = results.filter((result) => result.implementationOutcome === 'succeeded').length
  if (succeeded === results.length && results.length > 0) return 'succeeded'
  if (succeeded > 0) return 'partially_succeeded'
  return results.length > 0 ? 'failed' : 'unknown'
}

const SETTLEMENT_IGNORED_SNAPSHOT_CAP = 400

/** Capture the gitignored paths present at the moment the worktree was proven
 * clean — the IMMUTABLE settlement snapshot that later authorizes releasing
 * run-created ignored artifacts (build caches like __pycache__/node_modules).
 * Fail-safe: any git failure, malformed line, or overflow records null (no
 * ignored authorization → release preserves exactly as before). */
export async function captureSettlementIgnoredPaths(
  git: GitRunner,
  worktreePath: string,
  overlayExcludes: readonly string[],
): Promise<string[] | null> {
  try {
    const status = await git.run([
      'status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', '.',
      ...overlayExcludes.map((entry) => `:(top,exclude,literal)${entry}`),
    ], worktreePath)
    if (status.code !== 0) return null
    const paths: string[] = []
    for (const raw of status.stdout.split('\n')) {
      const line = raw.trimEnd()
      if (!line) continue
      // Non-ignored entries are the dirty check's jurisdiction, not the snapshot's.
      if (!line.startsWith('!! ')) continue
      const entry = line.slice(3).replace(/\/$/, '')
      if (!entry) return null
      paths.push(entry)
      if (paths.length > SETTLEMENT_IGNORED_SNAPSHOT_CAP) return null
    }
    return paths
  } catch {
    return null
  }
}

export function branchRecords(results: readonly SettledRun[]): DeliverBranchRecord[] {
  return results.flatMap((result) => (result.run.ticketIds.length ? result.run.ticketIds : [result.run.ticketId]).map((ticketId) => ({
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
    overlayCleanupEvidence: [...result.run.overlayCleanupEvidence, ...result.run.warmLinkEvidence],
    settlementIgnoredPaths: result.run.settlementIgnoredPaths ?? null,
  })))
}

export function getRailName(ctx: ProjectContext, railIndex: number): string | null {
  try { return getRail(ctx.db, railIndex).name ?? null } catch { return null }
}
