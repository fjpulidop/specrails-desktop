/**
 * Restart recovery for isolated rails: reattach a durable allocation after
 * Core finishes (no new generation or remote effects) and the startup sweep
 * that reconciles non-terminal worktree ledger rows and recovery commits.
 */
import { ensureIsolatedSettlementSnapshot } from './isolated-settlement-reconstruction'
import * as path from 'path'
import * as fs from 'fs'
import { newId } from '../../../ids'
import { definitionForkChain } from './fork-change-supersession'
import { defaultGitRunner, removeWorktree, listWorktrees, PR_NEVER_STAGE_PATHSPEC_ROOTS, type GitRunner } from '../../../worktree-manager'
import { hasAgentRuntimeRequest } from '../../agent-runtime/runtime/agent-runtime-paths'
import { updateRailWorktreeState, listNonTerminalRailWorktrees, getRailWorktree } from './rail-worktrees-store'
import { formatConventionalSubject, isConventionalCommitSubject } from './pr-naming'
import type { DbInstance } from '../../../db'
import { getJobEvents } from '../../../db'
import { coreAnnouncesReviewBrief, harvestDeliveryEvidence } from './delivery-evidence'
import { phase3HarvestOptions } from './phase3-harvest'
import {
  saveIsolatedSettlementResult, readIsolatedSettlementRecords, recordIsolatedProvenanceOnce,
} from './isolated-settlement-store'
import {
  getLoopRun, readDefinitionRun, claimDefinitionExecution, definitionRepositoryMounts,
} from '../../loops/runtime/loop-runs-store'
import { probeDefinitionRun, probeDefinitionRuns } from '../../loops/runtime/loop-definition-recovery'
import { withRepoLock } from '../../../repo-lock'
import { readExecutionManifest } from './multi-repo-execution-store'
import {
  getPrDelivery, reconcileFailedBuildingPrDeliveries, transitionDecision, toPrDeliverySnapshot, toRailPrStateMessage, 
  toPrDecisionCardEnvelope, claimPrDeliveryOperation, releasePrDeliveryOperation, transitionClaimedDecision, 
  type DeliverBranchRecord, type PrDecision, type PrDeliveryStatusCode,
} from './rail-pr-store'
import { getAgentChatManager } from '../../missions/runtime/agent-chat-registry'
import { refreshPrCiOffer } from './pr-ci/pr-ci-projection'
import { OVERLAY_MANIFEST } from '../../../worktree-overlay'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { recordLoopRunProvenance } from '../../code/runtime/file-story'
import { defaultExec, type Exec } from './pr-publisher'
import { isExactOpenPr, matchesRecordedPrIdentity, observePrLifecycle } from './pr-lifecycle'
import {
  commitCarriesRunMarker, discoverRunMarkedCommit, inspectRecoveryCommitProtection, listRecoveryCommitProtections, 
  protectRecoveryCommit, recoveryRefForDelivery, releaseRecoveryCommit, scanUnreachableRecoveryCommits, 
  type RecoveryCommitProtectionScan, type UnreachableRecoveryScan,
} from './rail-pr-recovery-git'
import type { ProjectContext } from '../../../project-registry'
import type { IsolatedLaunchIO } from './rail-isolated-launch-contracts'
import { RUN_STOPPED_DETAIL, isStoppedByPerson } from './rail-isolated-launch-contracts'
import { COMMIT_SHA_RE, answeredCommitMessage, branchRecords, errorDetail, runIntent } from './rail-isolated-launch-support'
import { createIsolatedRunSettlement } from './rail-isolated-run-settlement'
import { copiedEnvFilePaths } from '../../../worktree-env-files'

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

interface RecoveryWorktreeInspection {
  safe: boolean
  sha: string | null
  detail?: string
}

/** Git and Node can spell the same Windows directory differently. Compare its
 * filesystem identity instead of case-folding paths (which could admit another
 * repository on a case-sensitive volume). */
function sameRecoveryDirectory(observed: string, expected: string): boolean {
  const left = fs.statSync(observed, { bigint: true })
  const right = fs.statSync(expected, { bigint: true })
  if (!left.isDirectory() || !right.isDirectory()) return false
  if (left.ino !== 0n && right.ino !== 0n) return left.dev === right.dev && left.ino === right.ino
  return fs.realpathSync.native(observed) === fs.realpathSync.native(expected)
}

/** Reattach the original allocation after Core finishes; no new generation or remote effects. */
export async function reattachIsolatedSettlement(ctx: ProjectContext, deliveryId: string, runId: string, io: IsolatedLaunchIO = {}): Promise<void> {
  const frozen = readDefinitionRun(ctx.db, runId)
  if (!frozen || frozen.row.project_id !== ctx.project.id || frozen.row.status !== 'completed') throw new Error('Recovered workflow must finish before delivery settlement')
  ensureIsolatedSettlementSnapshot(ctx.db, ctx.project.id, runId)
  const ids = ctx.db.prepare('SELECT delivery_id FROM definition_delivery_settlements WHERE project_id=? AND run_id=? ORDER BY delivery_id')
    .all(ctx.project.id, runId) as Array<{ delivery_id: string }>
  const rows = ids.map(({ delivery_id }) => getPrDelivery(ctx.db, delivery_id))
  if (!rows.length || rows.some(row => !row) || !rows.some(row => row!.id === deliveryId || row!.parent_delivery_id === deliveryId)) throw new Error('Original isolated settlement is unavailable')
  const deliveries = rows.filter((row): row is NonNullable<typeof row> => !!row)
  if (deliveries.some(row => ['discarded', 'superseded', 'merged', 'completed'].includes(row.decision))) throw new Error('Delivery ownership has already changed')
  const parents = [...new Set(deliveries.map(row => row.parent_delivery_id).filter((id): id is string => !!id))]
  const allRows = [...deliveries, ...parents.map(id => getPrDelivery(ctx.db, id)).filter((row): row is NonNullable<typeof row> => !!row)]
  if (allRows.some(row => ['discarded', 'superseded', 'merged', 'completed'].includes(row.decision))) throw new Error('Delivery group ownership has already changed')
  const pending = deliveries.filter(row => !['on_review', 'no_changes', 'pr_draft', 'pr_ready'].includes(row.decision))
  if (!pending.length) { ctx.onLoopRunFinished(runId, frozen.row.final_outcome ?? 'failed', { ticketCompletionStatus: 'on_review' }); return }
  // Terminal admission must not depend on optional, potentially large evidence
  // outputs. A failed full-status harvest stays visible in the review packet.
  const probe = await probeDefinitionRun({ db: ctx.db, cwd: ctx.project.path, env: process.env }, runId)
  if (probe.status === 'unavailable' || probe.lease?.active || ['paused', 'running'].includes(probe.status)) throw new Error('Core has not provided an inactive terminal result')
  const policy = frozen.metadata.definition?.delivery as { requiresVerified?: boolean } | undefined
  const accepted = probe.status === 'succeeded' && probe.completion?.ok === true && (policy?.requiresVerified === false || probe.completion.verified)
  const outcome = accepted ? 'success' : probe.status === 'cancelled' ? 'stopped' : 'blocked'
  const token = newId()
  const execution = claimDefinitionExecution(ctx.db, runId, { owner: token, repositoryMounts: definitionRepositoryMounts(frozen.request) })
  if (!execution.ok) throw new Error(`runtime_run_active: ${execution.conflictingRunId}`)
  const claimed: typeof allRows = []
  const git = io.git ?? defaultGitRunner
  try {
    ctx.db.transaction(() => {
      for (const row of allRows) {
        if (!claimPrDeliveryOperation(ctx.db, row.id, row.decision, 'recover-and-retry', token)) throw new Error('Delivery is busy; retry settlement')
        claimed.push(row)
      }
    })()
    for (const row of pending) {
      const records = readIsolatedSettlementRecords(ctx.db, ctx.project.id, row.id)
      const record = records.find(item => item.snapshot.run.runId === runId)
      if (!record) throw new Error('Original isolated allocation is missing')
      const snapshot = record.snapshot, run = snapshot.run
      const ledger = getRailWorktree(ctx.db, run.ledgerId)
      if (!ledger || ledger.run_id !== runId || ledger.branch !== run.handle.branch || ledger.worktree_path !== run.handle.worktreePath) throw new Error('Worktree ownership changed before recovery')
      const context = frozen.metadata.context ?? (frozen.metadata.contextPath ? JSON.parse(fs.readFileSync(frozen.metadata.contextPath, 'utf8')) : null)
      if (!context || context.runId !== runId || !Array.isArray(context.repositories) || !context.repositories.some((repo: { path?: string }) => repo.path && fs.realpathSync(repo.path) === fs.realpathSync(run.handle.worktreePath))) throw new Error('Recovered mount is outside the frozen Core context')
      if (snapshot.reconstructedFrom) {
        const repository = frozen.request.executionManifest?.repositories.find(item => item.worktreeId === run.ledgerId)
        const common = await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir'], run.handle.worktreePath)
        if (!repository || common.code !== 0 || !common.stdout.trim() ||
          !sameRecoveryDirectory(common.stdout.trim(), repository.gitCommonDir)) throw new Error('Recovered worktree belongs to another Git repository')
      }
      const branch = await git.run(['branch', '--show-current'], run.handle.worktreePath)
      if (branch.code !== 0 || branch.stdout.trim() !== run.handle.branch) throw new Error('Recovered worktree is on another branch')
      const settle = createIsolatedRunSettlement({
        ...snapshot, git,
        onFinished: () => { /* Apply the shared terminal outbox after all repository legs. */ },
        // A terminal, non-resumable failure can preserve partial work in a
        // commit; interrupted/resumable Core work still owns its dirty mount.
        hasRuntimeRequest: () => probe.status !== 'failed' || probe.resumable,
        commitMessage: (_run, partial) => {
          // The snapshot froze the message at launch; an answer given since may have changed the goal.
          const answered = partial ? null : (() => { try { return answeredCommitMessage(ctx, run.ticketId, runId, run.handle.worktreePath) } catch { return null } })()
          const message = answered ?? (partial ? snapshot.partialCommitMessage : snapshot.commitMessage)
          if (isConventionalCommitSubject(message.split('\n')[0])) return message
          const subject = formatConventionalSubject({ type: 'chore', change: 'recover follow-up', ref: String(run.ticketId) })
          return `${subject}\n\nRun: ${run.runId.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')}${partial ? '\n(partial)' : ''}`
        },
        intentFor: (unit) => runIntent(ctx, unit),
        forkChain: forkRunId => definitionForkChain(ctx.db, forkRunId),
        markWorktree: (unit, state) => updateRailWorktreeState(ctx.db, unit.ledgerId, state) ? null : 'Worktree ledger disappeared',
        recordRunProvenance: unit => recordIsolatedProvenanceOnce(ctx.db, row.id, runId, commit => (io.recordProvenance ?? recordLoopRunProvenance)({
          db: ctx.db, projectId: ctx.project.id, runId, ticketId: unit.ticketId, repoDir: unit.handle.worktreePath,
          repositoryId: row.repository_id ?? undefined, snapshot: unit.provenanceSnapshot, broadcast: message => ctx.broadcast(message),
        }, undefined, commit)),
      })
      const result = await settle(run, Promise.resolve({ runId, outcome }))
      saveIsolatedSettlementResult(ctx.db, row.id, result)
      const latest = readIsolatedSettlementRecords(ctx.db, ctx.project.id, row.id)
      const results = latest.flatMap(item => item.result ? [item.result] : [])
      const complete = results.length === latest.length
      const successes = results.filter(item => item.implementationOutcome === 'succeeded')
      const ready = results.filter(item => item.deliveryOutcome === 'ready')
      const noChanges = complete && results.every(item => item.deliveryOutcome === 'no_changes')
      const partial = complete && ready.length > 0 && results.some(item => item.implementationOutcome !== 'succeeded' || !['ready', 'no_changes'].includes(item.deliveryOutcome))
      const next: PrDecision = !complete ? 'building' : !successes.length ? 'implementation_failed' : row.pr_url ? 'pr_failed' : ready.length ? 'on_review' : noChanges ? 'no_changes' : 'pr_failed'
      // Recovered Stop (server restart, then the person stopped the run): the
      // same classification as a fresh settlement. This run's outcome is the
      // probe's; sibling runs settled earlier carry their durable outcome.
      const stoppedByPerson = complete && isStoppedByPerson({
        loopId: row.loop_id, implementationOutcome: successes.length === results.length ? 'succeeded' : successes.length ? 'partially_succeeded' : 'failed', prUrl: row.pr_url,
        runOutcomes: results.map(item => item.run.runId === runId ? outcome : getLoopRun(ctx.db, item.run.runId)?.final_outcome),
      })
      const definitionEvidence = await probeDefinitionRuns({ db: ctx.db, cwd: ctx.project.path, env: process.env }, results.map(item => item.run.runId), true)
      const reviewBrief = await (io.reviewBriefCapability ?? coreAnnouncesReviewBrief)()
      const phase3 = await phase3HarvestOptions({ db: ctx.db, project: ctx.project, capabilities: io.phase3Capabilities })
      const evidence = (io.harvestEvidence ?? harvestDeliveryEvidence)({ readEvents: id => getJobEvents(ctx.db, id), reviewBrief, ...phase3 }, results.map(item => ({
        ticketId: item.run.ticketId, runId: item.run.runId, worktreePath: item.run.handle.worktreePath,
        // Phase-3 run records only (spec trace, baseline); runtime evidence keeps its probe.
        recordsDir: path.join((io.resolveExecution ?? resolveProjectExecution)(ctx.project).specrailsDir, 'pipeline', item.run.runId),
        definitionStatus: definitionEvidence.get(item.run.runId),
        reviewerStepId: readDefinitionRun(ctx.db, item.run.runId)?.request.graph.config.reviewerStepId,
      })))
      if (!transitionClaimedDecision(ctx.db, row.id, row.decision, next, token, {
        branches: branchRecords(results), runIds: latest.map(item => item.snapshot.run.runId), worktreeIds: latest.map(item => item.snapshot.run.ledgerId),
        implementationOutcome: !complete ? 'unknown' : successes.length === results.length ? 'succeeded' : successes.length ? 'partially_succeeded' : 'failed',
        deliveryOutcome: !complete ? 'not_started' : row.pr_url && ready.length ? 'retryable_failure' : ready.length ? (partial ? 'partial' : 'ready') : noChanges ? 'no_changes' : 'blocked',
        statusCode: !complete ? 'restart_pending' : row.pr_url && ready.length ? 'settlement_interrupted' : ready.length ? (partial ? 'partial_success' : 'ready_for_review') : noChanges ? 'no_changes' : stoppedByPerson ? 'run_stopped' : 'implementation_failed',
        statusDetail: row.pr_url && ready.length ? 'Recovered local work is ready. Retry delivery to update the existing PR.' : stoppedByPerson ? RUN_STOPPED_DETAIL : null,
        ...(results.length === 1 ? { deliverySha: results[0].finalSha } : {}), settleEvidence: evidence,
      })) throw new Error('Delivery changed during recovered settlement')
    }
    const { refreshRepositoryDeliveryGroup } = await import('./multi-repo-execution')
    for (const parent of parents) refreshRepositoryDeliveryGroup(ctx.db, parent)
    ctx.onLoopRunFinished(runId, outcome, { ticketCompletionStatus: 'on_review' })
  } finally {
    for (const row of claimed) releasePrDeliveryOperation(ctx.db, row.id, token)
    execution.release()
  }
  for (const row of allRows) {
    const latest = getPrDelivery(ctx.db, row.id)
    if (!latest) continue
    const snapshot = toPrDeliverySnapshot(latest)
    ctx.broadcast(toRailPrStateMessage(ctx.project.id, snapshot))
    // A recovered settlement (server restart mid-run, then resume/reattach)
    // has no launch closure left to refresh the origin mission card. Without
    // this the persisted card stays `building` after the delivery reached
    // review, and every client hydration faithfully re-reads the stale card.
    if (latest.origin_conversation_id) {
      try {
        getAgentChatManager()?.updatePrDecisionCard(latest.origin_conversation_id, toPrDecisionCardEnvelope(ctx.project.id, snapshot))
      } catch { /* the durable row is authoritative; startup reprojection heals */ }
      refreshPrCiOffer(ctx, latest.id)
    }
  }
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
      if (!/^\.(?:claude|codex|gemini|kimi-code)\/[^/]+(?:\/[^/]+)*$/.test(value)) return false
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
  // Env-file copies (opt-in setting) are the person's files, not the run's work.
  const overlayExcludes = [...new Set([...recoveryOverlayExcludes(repoDir, row.worktree_path), ...copiedEnvFilePaths(row.worktree_path)])]
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
    repositoryOnly?: boolean
    primaryRepoDir?: string
  } = {}
): Promise<number> {
  const git = io.git ?? defaultGitRunner
  const exec = io.exec ?? defaultExec
  const remove = io.remove ?? removeWorktree
  if (!io.repositoryOnly) {
    const paths = db.prepare('SELECT DISTINCT repository_path FROM rail_worktrees WHERE repository_path IS NOT NULL UNION SELECT DISTINCT repository_path FROM rail_pr_deliveries WHERE repository_path IS NOT NULL').all() as Array<{ repository_path: string }>
    if (paths.length) {
      let count = 0
      for (const target of [...new Set([repoDir, ...paths.map((row) => row.repository_path)])]) {
        count += await reconcileRailWorktrees(db, target, { ...io, repositoryOnly: true, primaryRepoDir: repoDir })
      }
      const { refreshRepositoryDeliveryGroup } = await import('./multi-repo-execution')
      const groups = db.prepare('SELECT id FROM rail_pr_deliveries WHERE parent_delivery_id IS NULL AND execution_manifest IS NOT NULL').all() as Array<{ id: string }>
      for (const group of groups) { refreshRepositoryDeliveryGroup(db, group.id, { startup: true }); io.onDeliveryRecovered?.(group.id) }
      return count
    }
  }
  const belongsHere = (row: { repository_path?: string | null }): boolean => (row.repository_path ?? io.primaryRepoDir ?? repoDir) === repoDir
  return withRepoLock(repoDir, async () => {
    const stuck = listNonTerminalRailWorktrees(db).filter(belongsHere)
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
      if (row.run_id && run?.final_outcome !== 'success' && hasAgentRuntimeRequest({ path: io.primaryRepoDir ?? repoDir }, row.run_id)) {
        updateRailWorktreeState(db, row.id, 'needs-review')
        continue
      }
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

    const recovered = reconcileFailedBuildingPrDeliveries(db, { startup: true, repositoryPath: repoDir, legacyRepositoryPath: io.primaryRepoDir ?? repoDir })
    // Multi-repository recovery must not conflate the same run/branch names
    // across object stores. Promote only a clean unchanged base or an exact
    // app-marked settlement commit; retain uncertain work for explicit revision.
    for (const delivery of recovered) {
      const manifest = readExecutionManifest(delivery.execution_manifest)
      if (!delivery.parent_delivery_id || !manifest || delivery.pr_url || delivery.implementation_outcome !== 'succeeded') continue
      const units = toPrDeliverySnapshot(delivery).branches
      const recoveredUnits = await Promise.all(units.map(async (unit): Promise<DeliverBranchRecord> => {
        const ledger = stuck.find((row) => row.run_id === unit.runId && row.branch === unit.branch)
        const snapshot = manifest.repositories.find((repo) => repo.worktreeId === ledger?.id)
        const sha = unit.runId ? verifiedShaByRun.get(unit.runId) : undefined
        const proven = Boolean(snapshot && sha && (sha === snapshot.baseSha || await commitCarriesRunMarker(git, repoDir, sha, unit.runId!)))
        const noChanges = proven && sha === snapshot!.baseSha
        return {
          ...unit, repositoryId: delivery.repository_id ?? undefined,
          succeeded: proven && !noChanges, initialSha: snapshot?.baseSha ?? null, finalSha: proven ? sha! : null,
          changed: proven ? !noChanges : undefined, worktreePath: ledger?.worktree_path,
          branchOwnership: 'preexisting', deliveryOutcome: proven ? noChanges ? 'no_changes' : 'ready' : 'blocked',
          failureCode: proven ? null : 'settlement_interrupted',
        }
      }))
      const ready = recoveredUnits.filter((unit) => unit.deliveryOutcome === 'ready').length
      const unchanged = recoveredUnits.length > 0 && recoveredUnits.every((unit) => unit.deliveryOutcome === 'no_changes')
      const blocked = recoveredUnits.some((unit) => unit.deliveryOutcome === 'blocked')
      const next: PrDecision = blocked ? 'pr_failed' : unchanged ? 'no_changes' : ready ? 'on_review' : 'pr_failed'
      transitionDecision(db, delivery.id, delivery.decision, next, {
        branches: recoveredUnits, deliveryOutcome: blocked ? 'blocked' : unchanged ? 'no_changes' : 'ready',
        statusCode: blocked ? 'settlement_interrupted' : unchanged ? 'no_changes' : 'ready_for_review',
      })
    }
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
      if (!belongsHere(delivery)) continue
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
