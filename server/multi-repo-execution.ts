import { newId } from './ids'
import { getProjectSettings, type DbInstance } from './db'
import { resolveIntegrationBranch } from './integration-branch'
import { getProjectRepositories } from './project-repositories'
import { repositoryLockKey } from './repo-lock'
import { defaultGitRunner } from './worktree-manager'
import { resolveProjectExecution } from './workspace-resolution'
import type { IsolatedLaunchInput, IsolatedLaunchIO } from './rail-isolated-launch'
import { launchIsolatedRail, buildSpecSnapshot } from './rail-isolated-launch'
import type { LoopRunRequest, LoopRunResult } from './loop-run-manager'
import type { ProjectContext } from './project-registry'
import {
  createPrDeliveryGeneration, getPrDelivery, transitionDecision, toPrDeliverySnapshot, claimPrDeliveryOperation, releasePrDeliveryOperation,
  toRailPrStateMessage, toPrDecisionCardEnvelope, failPrDeliveryAndRestoreSuperseded,
  type PrDecision, type PrDeliveryPatch, type RailPrDeliveryRow,
} from './rail-pr-store'
import { getAgentChatManager } from './agent-chat-registry'
import { transitionClaimedDecisionWithTicketEffect } from './rail-pr-ticket-effects'
import { readExecutionManifest, type RunExecutionManifest, type RepositoryDeliverySnapshot } from './multi-repo-execution-store'
export { migrateMultiRepoExecution, getRepositoryExecutionReferences } from './multi-repo-execution-store'
export type { RunExecutionManifest, RunRepositorySnapshot, RepositoryDeliverySnapshot } from './multi-repo-execution-store'

export function listRepositoryDeliveries(db: DbInstance, parentId: string): RailPrDeliveryRow[] {
  return db.prepare('SELECT * FROM rail_pr_deliveries WHERE parent_delivery_id = ? ORDER BY rowid').all(parentId) as RailPrDeliveryRow[]
}

function repositorySnapshot(row: RailPrDeliveryRow, manifest: RunExecutionManifest): RepositoryDeliverySnapshot {
  const snap = toPrDeliverySnapshot(row)
  const repo = manifest.repositories.find((entry) => entry.repositoryId === row.repository_id)
  return {
    repositoryId: row.repository_id!, name: repo?.name ?? row.repository_id!, path: row.repository_path!,
    deliveryId: row.id, baseBranch: row.base_branch, integrationBranch: repo?.integrationBranch ?? row.base_branch,
    branch: row.branch ?? (snap.branches.length === 1 ? snap.branches[0].branch : null),
    deliverySha: row.delivery_sha ?? (snap.branches.length === 1 ? snap.branches[0].finalSha ?? null : null),
    decision: row.decision, implementationOutcome: snap.implementationOutcome, deliveryOutcome: snap.deliveryOutcome,
    statusCode: snap.statusCode, statusDetail: snap.statusDetail, prUrl: row.pr_url, prNumber: row.pr_number,
    worktreeIds: snap.worktreeIds, runIds: snap.runIds,
  }
}

/** Projection is durable: late clients receive the same group as live cards. */
export function refreshRepositoryDeliveryGroup(db: DbInstance, parentId: string, opts: { startup?: boolean } = {}): RailPrDeliveryRow | undefined {
  const parent = getPrDelivery(db, parentId)
  const manifest = readExecutionManifest(parent?.execution_manifest)
  if (!parent || !manifest || ['merged', 'completed', 'discarded', 'superseded'].includes(parent.decision)) return parent
  const children = listRepositoryDeliveries(db, parentId)
  if (opts.startup && children.length < manifest.selectedRepositoryIds.length) {
    transitionDecision(db, parent.id, parent.decision, 'pr_failed', {
      implementationOutcome: 'unknown', deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted',
      statusDetail: 'The previous process stopped before all repository worktrees were allocated. Existing work was preserved; revise the group to retry.',
      repositoryDeliveries: children.map((row) => repositorySnapshot(row, manifest)),
    })
    return getPrDelivery(db, parentId)
  }
  if (children.length === 0) return parent
  const snapshots = children.map((row) => repositorySnapshot(row, manifest))
  const finished = children.length === manifest.selectedRepositoryIds.length && children.every((row) => row.decision !== 'building')
  const accepted = children.filter((row) => row.decision === 'merged' || row.decision === 'completed')
  const active = children.filter((row) => row.decision !== 'no_changes' && row.decision !== 'merged' && row.decision !== 'completed')
  let decision: PrDecision = parent.decision
  const patch: PrDeliveryPatch = {
    repositoryDeliveries: snapshots,
    runIds: [...new Set(snapshots.flatMap((row) => row.runIds))],
    worktreeIds: [...new Set(snapshots.flatMap((row) => row.worktreeIds))],
    branches: children.flatMap((row) => toPrDeliverySnapshot(row).branches.map((unit) => ({ ...unit, repositoryId: row.repository_id! }))),
    cleanupWarnings: children.flatMap((row) => toPrDeliverySnapshot(row).cleanupWarnings),
    safetyArchives: children.flatMap((row) => toPrDeliverySnapshot(row).safetyArchives),
  }
  if (finished) {
    const successes = children.filter((row) => row.implementation_outcome === 'succeeded').length
    patch.implementationOutcome = successes === children.length ? 'succeeded' : successes ? 'partially_succeeded' : 'failed'
    const completeAcceptance = children.every((row) => row.implementation_outcome === 'succeeded' && toPrDeliverySnapshot(row).branches.every((unit) => unit.implementationOutcome !== 'failed' && unit.deliveryOutcome !== 'blocked' && unit.deliveryOutcome !== 'not_started'))
    if (accepted.length === children.length && completeAcceptance) {
      decision = children.some((row) => row.decision === 'merged') ? 'merged' : 'completed'
      patch.deliveryOutcome = 'delivered'; patch.statusCode = 'merged'; patch.statusDetail = null
    } else if (accepted.length === children.length) {
      decision = 'pr_failed'; patch.deliveryOutcome = 'blocked'; patch.statusCode = 'partial_delivery'
      patch.statusDetail = 'Only part of the shared implementation was delivered. Revise the group to complete the outstanding scope.'
    } else if (children.every((row) => row.decision === 'discarded')) {
      decision = 'discarded'; patch.deliveryOutcome = 'not_started'; patch.statusCode = 'discarded'
    } else if (children.every((row) => row.decision === 'no_changes')) {
      decision = 'no_changes'; patch.deliveryOutcome = 'no_changes'; patch.statusCode = 'no_changes'
    } else if (children.some((row) => row.decision === 'implementation_failed')) {
      decision = 'implementation_failed'; patch.deliveryOutcome = 'blocked'; patch.statusCode = 'implementation_failed'
    } else if (children.some((row) => row.decision === 'pr_failed')) {
      decision = 'pr_failed'; patch.deliveryOutcome = children.some((row) => row.delivery_outcome === 'blocked') ? 'blocked' : 'retryable_failure'
      patch.statusCode = children.find((row) => row.decision === 'pr_failed')?.status_code ?? 'delivery_failed'
    } else if (active.length > 0 && active.every((row) => row.decision === 'pr_ready')) {
      decision = 'pr_ready'; patch.deliveryOutcome = 'delivered'; patch.statusCode = 'pr_ready'
    } else if (active.length > 0 && active.every((row) => row.decision === 'pr_draft' || row.decision === 'pr_ready')) {
      decision = 'pr_draft'; patch.deliveryOutcome = 'delivered'; patch.statusCode = 'pr_draft_ready'
    } else if (active.length > 0 && active.every((row) => row.decision === 'pr_closed')) {
      decision = 'pr_closed'; patch.deliveryOutcome = 'delivered'; patch.statusCode = 'pr_closed'
    } else {
      decision = 'on_review'; patch.deliveryOutcome = accepted.length > 0 ? 'partial' : 'ready'
      patch.statusCode = accepted.length > 0 ? 'partial_delivery' : 'ready_for_review'
    }
    if (accepted.length > 0 && accepted.length < children.length) {
      patch.deliveryOutcome = 'partial'; patch.statusCode = 'partial_delivery'
      patch.statusDetail = `${accepted.length}/${children.length} repositories accepted. The shared spec remains pending until every repository is accepted.`
    } else if (patch.statusDetail === undefined) {
      patch.statusDetail = children.find((row) => row.status_detail)?.status_detail ?? null
    }
  }
  if (decision === 'merged' || decision === 'completed' || decision === 'discarded') {
    // Parent acceptance and its shared-ticket outbox MUST commit together. A
    // restart after the last child accepted can safely recreate this projection.
    const accepted = decision !== 'discarded'
    db.transaction(() => {
      const token = parent.operation_token ?? newId()
      const claimedHere = !parent.operation_token
      if (claimedHere && !claimPrDeliveryOperation(db, parent.id, parent.decision, accepted ? 'merge-local' : 'discard', token)) return
      try {
        transitionClaimedDecisionWithTicketEffect(db, parent.id, parent.decision, decision, token, patch, {
          deliveryId: parent.id, ticketIds: toPrDeliverySnapshot(parent).ticketIds,
          targetStatus: accepted ? 'done' : 'todo', jiraAction: accepted ? 'merged' : 'discard', prUrl: null,
        })
      } finally { if (claimedHere) releasePrDeliveryOperation(db, parent.id, token) }
    })()
  } else {
    transitionDecision(db, parent.id, parent.decision, decision, patch)
  }
  return getPrDelivery(db, parentId)
}

function emitGroup(ctx: Pick<ProjectContext, 'db' | 'project' | 'broadcast'>, parentId: string, post = false): void {
  const row = getPrDelivery(ctx.db, parentId)
  if (!row) return
  const snap = toPrDeliverySnapshot(row)
  try { ctx.broadcast(toRailPrStateMessage(ctx.project.id, snap)) } catch { /* durable projection is authoritative */ }
  if (row.origin_conversation_id) {
    const agent = getAgentChatManager()
    const envelope = toPrDecisionCardEnvelope(ctx.project.id, snap)
    try {
      if (post) agent?.postPrDecisionCard(row.origin_conversation_id, envelope)
      else agent?.updatePrDecisionCard(row.origin_conversation_id, envelope)
    } catch { /* a disconnected origin must not alter execution */ }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** One pipeline per spec/batch; allocation and settlement compose the proven
 * single-repository implementation without launching an independent AI per repo. */
export async function launchMultiRepositoryRail(input: IsolatedLaunchInput, io: IsolatedLaunchIO = {}): Promise<string[]> {
  const { ctx } = input
  const members = getProjectRepositories(ctx.project)
  const primary = members.find((repo) => repo.isPrimary) ?? members[0]
  const requested = input.repositoryIds ?? [primary.id]
  if (requested.length === 0 || new Set(requested).size !== requested.length) throw new Error('repositoryIds must contain distinct registered repositories')
  const selected = requested.map((id) => {
    const repo = members.find((entry) => entry.id === id)
    if (!repo) throw new Error(`Unknown project repository: ${id}`)
    if (repo.kind !== 'git') throw new Error(`Repository ${repo.name} is context-only; isolated write targets must be Git repositories`)
    return { ...repo }
  })
  if (new Set(selected.map((repo) => repositoryLockKey(repo.path))).size !== selected.length) {
    throw new Error('An execution cannot target the same physical Git repository more than once')
  }
  if (input.explicitPrTarget && selected.length !== 1) throw new Error('An explicit pull request target must name one repository')
  const artifactRepositoryId = selected.find((repo) => repo.isPrimary)?.id ?? selected[0].id
  const graph = structuredClone(input.loopGraph)
  for (const node of graph.nodes) {
    if (node.type !== 'shell') continue
    if (selected.length === 1 && !node.data?.repositoryId) node.data = { ...node.data, repositoryId: selected[0].id }
    if (input.loopId === 'factory:sdd-quick-openspec' && node.id === 'archive' && !node.data?.repositoryId) {
      node.data = { ...node.data, repositoryId: artifactRepositoryId }
    }
    if (typeof node.data?.repositoryId !== 'string' || !selected.some((repo) => repo.id === node.data?.repositoryId)) {
      throw new Error(`Shell step ${node.id} requires an explicit selected repositoryId`)
    }
  }
  const git = io.git ?? defaultGitRunner
  const integrationBranches = new Map<string, string>()
  // Validate all targets before allocating any worktree or delivery child.
  for (const repo of selected) {
    const result = await git.run(['rev-parse', '--verify', 'HEAD'], repo.path)
    if (result.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(result.stdout.trim())) throw new Error(`Repository ${repo.name} has no readable commit`)
    if (input.repositoryBaseBranches?.[repo.id]) {
      const target = await resolveIntegrationBranch(git, { repoDir: repo.path, projectSetting: repo.integrationBranch ?? (repo.isPrimary ? getProjectSettings(ctx.db).integrationBranch : undefined) })
      integrationBranches.set(repo.id, target.branch)
    }
  }
  const previousParentId = input.revision?.ofDeliveryId ?? input.repositoryContinuation?.deliveryId
  const previousParent = previousParentId ? getPrDelivery(ctx.db, previousParentId) : undefined
  const previousManifest = readExecutionManifest(previousParent?.execution_manifest)
  const previousChildren = previousParentId ? listRepositoryDeliveries(ctx.db, previousParentId) : []
  if (previousParentId && (!previousParent || !previousManifest ||
    selected.length !== previousManifest.selectedRepositoryIds.length ||
    selected.some((repo) => !previousManifest.selectedRepositoryIds.includes(repo.id)))) {
    throw new Error('A repository delivery revision must keep its exact registered repository scope')
  }
  for (const previous of previousChildren) {
    if (previous.operation_token) throw new Error('A repository delivery action is still in progress')
    if (previous.repository_path !== selected.find((repo) => repo.id === previous.repository_id)?.path) {
      throw new Error('The repository location changed since the delivery; restore it before revising')
    }
  }
  const artifactExecution = (io.resolveExecution ?? resolveProjectExecution)(ctx.project)
  const parentId = newId()
  const effectiveScope = previousChildren.some((row) => row.pr_url && row.branch) ? 'all' : input.scope
  const groups = input.ticketIds.length === 0 || effectiveScope === 'all' ? [input.ticketIds] : input.ticketIds.map((id) => [id])
  const runIds = new Map(groups.map((ids) => [ids[0] ?? 0, newId()]))
  const gates = new Map([...runIds.values()].map((id) => [id, deferred<LoopRunResult>()]))
  // Every rejection has a sink even if allocation fails before a child subscribes.
  for (const gate of gates.values()) void gate.promise.catch(() => {})
  const requests = new Map<string, Map<string, LoopRunRequest>>()
  const settledChildren = new Set<string>()
  const childSettlements: Promise<void>[] = []
  const results = new Map<string, LoopRunResult>()
  let aborted = false
  let allocationComplete = false
  let groupFinished = false
  const manifest: RunExecutionManifest = {
    version: 1, groupId: parentId, projectId: ctx.project.id, primaryRepositoryId: primary.id,
    artifactRepositoryId, selectedRepositoryIds: selected.map((repo) => repo.id), repositories: [],
  }
  const generation = createPrDeliveryGeneration(ctx.db, {
    id: parentId, railIndex: input.railIndex, loopId: input.loopId, railKey: `${input.railIndex}-${input.loopId}`,
    ticketIds: input.ticketIds, baseBranch: input.baseBranch ?? '', loopName: input.loopName,
    originSurface: input.originSurface ?? 'dashboard', originConversationId: input.originConversationId,
    specSnapshot: buildSpecSnapshot(ctx, input.ticketIds),
    ...(input.revision ? { revisionNote: input.revision.note, revisionOf: input.revision.ofDeliveryId } : {}),
  }, input.revision ? { id: input.revision.ofDeliveryId, decision: input.revision.decision } : input.repositoryContinuation ? { id: input.repositoryContinuation.deliveryId, decision: input.repositoryContinuation.decision } : null)
  for (const child of previousChildren) {
    if (!['merged', 'completed', 'discarded', 'superseded'].includes(child.decision)) transitionDecision(ctx.db, child.id, child.decision, 'superseded')
  }
  transitionDecision(ctx.db, parentId, 'building', 'building', { executionManifest: manifest, runIds: [...runIds.values()] })
  try { input.onPrDeliveryCreated?.(parentId) } catch { /* durable group hydration remains available */ }
  emitGroup(ctx, parentId, true)
  const finishGroup = (): void => {
    if (aborted || groupFinished || !allocationComplete || settledChildren.size !== selected.length) return
    groupFinished = true
    const failures: string[] = []
    for (const [runId, result] of results) {
      try {
        ctx.onLoopRunFinished(runId, result.outcome, { ticketCompletionStatus: 'on_review', ...(result.stallReason ? { stallReason: result.stallReason } : {}) })
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (failures.length > 0) {
      const detail = `The shared run could not finish its ticket settlement: ${failures.join('; ')}`
      for (const child of listRepositoryDeliveries(ctx.db, parentId)) {
        const snapshot = toPrDeliverySnapshot(child)
        transitionDecision(ctx.db, child.id, child.decision, 'pr_failed', {
          deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted', statusDetail: detail,
          branches: snapshot.branches.map((unit) => ({ ...unit, deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted', statusDetail: detail })),
        })
      }
    }
    refreshRepositoryDeliveryGroup(ctx.db, parentId)
    emitGroup(ctx, parentId)
  }
  try {
    for (const repository of selected) {
      const childSettlement = deferred<void>()
      const previous = previousChildren.find((row) => row.repository_id === repository.id)
      const previousRepository = previousManifest?.repositories.find((row) => row.repositoryId === repository.id)
      const previousBaseBranch = previous && ['merged', 'completed'].includes(previous.decision)
        ? previousRepository?.integrationBranch ?? previous.base_branch
        : previous?.base_branch
      const oldSnapshot = previous ? toPrDeliverySnapshot(previous) : null
      const revisionBranches = new Map<number, { branch: string; sha: string }>()
      if (oldSnapshot && !['merged', 'completed', 'discarded'].includes(oldSnapshot.decision) && !previous?.pr_url) {
        for (const unit of oldSnapshot.branches) {
          if (unit.finalSha) revisionBranches.set(unit.ticketId, { branch: unit.branch, sha: unit.finalSha })
        }
      }
      const continuation = previous?.pr_url && previous.branch && previous.delivery_sha && previous.pr_number &&
        (previous.decision === 'pr_draft' || previous.decision === 'pr_ready')
        ? { deliveryId: previous.id, decision: previous.decision, branch: previous.branch,
            baseBranch: previous.base_branch, prUrl: previous.pr_url, prNumber: previous.pr_number, deliverySha: previous.delivery_sha }
        : undefined
      const manager = Object.create(ctx.loopRunManager) as ProjectContext['loopRunManager']
      manager.run = (request) => {
        const gate = gates.get(request.runId!)
        if (!gate) throw new Error('Repository allocation changed the coordinated ticket scope')
        const byRepository = requests.get(request.runId!) ?? new Map<string, LoopRunRequest>()
        byRepository.set(repository.id, request)
        requests.set(request.runId!, byRepository)
        return gate.promise
      }
      const childCtx: ProjectContext = {
        ...ctx,
        project: { ...ctx.project, path: repository.path },
        loopRunManager: manager,
        railLoopRuns: new Map(),
        onLoopRunFinished: () => {},
        jiraSyncManager: Object.assign(Object.create(ctx.jiraSyncManager), { onRailLaunch: () => {} }),
        broadcast: (message) => { if (message.type !== 'rail.pr_state') ctx.broadcast(message) },
      }
      await launchIsolatedRail({
        ...input, ctx: childCtx, scope: effectiveScope, loopGraph: graph,
        revision: input.revision && previous ? { ...input.revision, ofDeliveryId: previous.id, decision: previous.decision } : undefined,
        requiredPrContinuation: continuation,
        explicitPrTarget: continuation?.prNumber ? { prNumber: continuation.prNumber } : input.explicitPrTarget,
        originConversationId: undefined,
        baseBranch: input.repositoryBaseBranches?.[repository.id] ?? (repository.isPrimary ? input.baseBranch ?? previousBaseBranch : previousBaseBranch),
        onPrDeliveryCreated: undefined,
        repositoryExecution: {
          parentDeliveryId: parentId, repositoryId: repository.id, primary: repository.isPrimary, runIds, revisionBranches, isAborted: () => aborted, expectedBaseSha: input.repositoryBaseShas?.[repository.id],
          onSettled: (id) => {
            if (id) settledChildren.add(id)
            try { finishGroup() } catch (error) {
              // The existing ledger and child snapshots let startup reconciliation
              // recover even if a database failure interrupts the final projection.
              console.error('[multi-repo] group settlement interrupted:', error)
            } finally { childSettlement.resolve(undefined) }
          },
        },
      }, { ...io, resolveExecution: () => artifactExecution })
      childSettlements.push(childSettlement.promise)
      const child = listRepositoryDeliveries(ctx.db, parentId).find((row) => row.repository_id === repository.id)!
      const ledger = ctx.db.prepare('SELECT * FROM rail_worktrees WHERE id IN (SELECT value FROM json_each(?))').all(child.worktree_ids) as Array<{ id: string; worktree_path: string; branch: string; run_id: string }>
      // worktree_ids is normally written at settlement; allocation is already durable in the ledger.
      const allocated = ledger.length ? ledger : ctx.db.prepare('SELECT * FROM rail_worktrees WHERE repository_id = ? AND run_id IN (SELECT value FROM json_each(?))').all(repository.id, JSON.stringify([...runIds.values()])) as typeof ledger
      for (const worktree of allocated) {
        const head = await git.run(['rev-parse', '--verify', 'HEAD'], worktree.worktree_path)
        if (head.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(head.stdout.trim())) throw new Error(`Cannot freeze HEAD for ${repository.name}`)
        manifest.repositories.push({ repositoryId: repository.id, name: repository.name, sourcePath: repository.path,
          gitCommonDir: repositoryLockKey(repository.path), baseBranch: child.base_branch, integrationBranch: integrationBranches.get(repository.id) ?? previousRepository?.integrationBranch ?? child.base_branch, baseSha: head.stdout.trim(),
          worktreePath: worktree.worktree_path, branch: worktree.branch, worktreeId: worktree.id })
      }
    }
    for (const [runId, byRepository] of requests) {
      if (byRepository.size !== selected.length) throw new Error(`Run ${runId} is missing a repository allocation`)
    }
    if (requests.size !== groups.length) throw new Error('The launch did not allocate every coordinated run')
    allocationComplete = true
    // Serialize first; no provider starts until every repository snapshot exists.
    transitionDecision(ctx.db, parentId, 'building', 'building', {
      executionManifest: manifest, worktreeIds: manifest.repositories.map((repo) => repo.worktreeId),
    })
    for (const child of listRepositoryDeliveries(ctx.db, parentId)) {
      transitionDecision(ctx.db, child.id, 'building', 'building', { executionManifest: { ...manifest, selectedRepositoryIds: [child.repository_id!], repositories: manifest.repositories.filter((repo) => repo.repositoryId === child.repository_id) } })
    }
    refreshRepositoryDeliveryGroup(ctx.db, parentId)
    emitGroup(ctx, parentId)
    for (const [runId, byRepository] of requests) {
      const primaryRequest = byRepository.get(artifactRepositoryId) ?? byRepository.values().next().value!
      const runManifest: RunExecutionManifest = {
        ...manifest,
        repositories: manifest.repositories.filter((repo) => byRepository.get(repo.repositoryId)?.repoDir === repo.worktreePath),
      }
      ctx.railLoopRuns.set(runId, { railIndex: input.railIndex, ticketIds: primaryRequest.spec?.ticketIds ?? [], requiresTerminalIntent: true })
      const resultPromise = ctx.loopRunManager.run({ ...primaryRequest, graph, executionManifest: runManifest })
      try { ctx.jiraSyncManager.onRailLaunch(primaryRequest.spec?.ticketIds ?? [], runId) } catch { /* non-fatal */ }
      void resultPromise.then((result) => { results.set(runId, result); gates.get(runId)!.resolve(result) }, (error) => {
        results.set(runId, { runId, outcome: 'failed' } as LoopRunResult)
        gates.get(runId)!.reject(error)
      })
    }
    return [...runIds.values()]
  } catch (error) {
    aborted = true
    allocationComplete = true
    for (const gate of gates.values()) gate.reject(error)
    await Promise.all(childSettlements)
    if (generation.superseded && failPrDeliveryAndRestoreSuperseded(ctx.db, parentId, generation.superseded)) {
      for (const previous of previousChildren) {
        const live = getPrDelivery(ctx.db, previous.id)
        if (live?.decision === 'superseded' && previous.decision !== 'superseded') transitionDecision(ctx.db, previous.id, 'superseded', previous.decision)
      }
      emitGroup(ctx, generation.superseded.id)
    }
    const row = getPrDelivery(ctx.db, parentId)
    if (row?.decision === 'building') transitionDecision(ctx.db, parentId, 'building', 'pr_failed', {
      implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: 'delivery_failed',
      statusDetail: error instanceof Error ? error.message : String(error), executionManifest: manifest,
    })
    emitGroup(ctx, parentId)
    throw error
  }
}
