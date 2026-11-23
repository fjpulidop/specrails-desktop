/**
 * Base refresh of a conflicted local delivery (see
 * modules/delivery/runtime/delivery-base-refresh.ts for the git contract).
 *
 * A milestone chain calls this, over loopback, when integrating a delivery
 * failed with a conflict: the base is merged into the delivery's own run
 * worktree (an agent step resolves real conflicts with the spec as context),
 * then the run forks from its final verification so the host verifies the
 * merged candidate and settles the same delivery again. A pass returns the
 * delivery to review with a commit that contains the base; the next
 * integration fast-forwards it. Anything this cannot do safely is refused with
 * a reason, and the chain pauses with its usual options.
 */
import { createHash, randomUUID } from 'node:crypto'
import { claimPrDeliveryOperation, getPrDelivery, releasePrDeliveryOperation, toPrDeliverySnapshot, toRailPrStateMessage } from './modules/delivery/runtime/rail-pr-store'
import { readIsolatedSettlementRecords } from './modules/delivery/runtime/isolated-settlement-store'
import { forkDefinitionRun } from './modules/delivery/runtime/definition-fork'
import { deliveryIntegrationTarget } from './modules/delivery/adapters/decisions/metadata'
import {
  BASE_REFRESH_FORK_NODE, BASE_REFRESH_LIMIT, BASE_REFRESH_REQUEST_PREFIX, buildBaseRefreshResolverPrompt, mergeBaseIntoDelivery, rollbackBaseRefresh,
  type BaseRefreshSpec, type ResolverInput,
} from './modules/delivery/runtime/delivery-base-refresh'
import { recordMergeStep } from './modules/delivery/runtime/rail-merge-orchestrator'
import { getLoopRun, readDefinitionSuccessor } from './modules/loops/runtime/loop-runs-store'
import { probeDefinitionRun } from './modules/loops/runtime/loop-definition-recovery'
import { BUILTIN_CONSTANTS } from './modules/loops/runtime/loop-constants'
import { createLoopExecutors } from './modules/loops/runtime/loop-executors'
import { defaultMachineProvider } from './provider-selection'
import { getProviderDefault, isValidModelForProvider, type SpecProvider } from './modules/specs/runtime/spec-models'
import { hasAdapter } from './providers'
import { defaultGitRunner, type GitRunner } from './worktree-manager'
import type { ProjectContext } from './project-registry'
import type { DeliveryBaseRefreshMessage } from './types'

export type DeliveryBaseRefreshOutcome =
  | { status: 202; body: { ok: true; deliveryId: string; loopRunId: string; mergeSha: string; conflicts: string[] } }
  | { status: 404 | 409 | 502; body: { ok: false; error: string; detail: string; conflicts?: string[] } }

export interface DeliveryBaseRefreshIo {
  git?: GitRunner
  resolve?: (input: ResolverInput) => Promise<void>
  fork?: typeof forkDefinitionRun
  resume?: (c: ProjectContext, runId: string) => Promise<{ ok: true } | { ok: false; error: string; detail?: string }>
}

/** Base refreshes already started for this delivery lineage (fork requests by prefix). */
export function baseRefreshCount(c: Pick<ProjectContext, 'db' | 'project'>, runIds: readonly string[]): number {
  if (!runIds.length) return 0
  const row = c.db.prepare(`SELECT COUNT(*) AS n FROM definition_fork_operations WHERE project_id=? AND request_id LIKE ? AND source_run_id IN (${runIds.map(() => '?').join(',')})`)
    .get(c.project.id, `${BASE_REFRESH_REQUEST_PREFIX}%`, ...runIds) as { n: number }
  return row.n
}

const refused = (status: 404 | 409 | 502, error: string, detail: string, conflicts?: string[]): DeliveryBaseRefreshOutcome =>
  ({ status, body: { ok: false, error, detail, ...(conflicts?.length ? { conflicts } : {}) } })

/** The resolver's provider and model: the delivery run's own when it recorded concrete ones, else the machine default. */
export function resolverRoute(route: { provider: string | null; model: string | null }): { provider: string; model: string } {
  const provider = route.provider && hasAdapter(route.provider) ? route.provider : defaultMachineProvider()
  const model = route.provider === provider && isValidModelForProvider(route.model, provider as SpecProvider) ? route.model : getProviderDefault(provider as SpecProvider)
  return { provider, model }
}

/** The default resolver: the delivery run's route in the delivery worktree, with cost recorded. */
function defaultResolver(c: ProjectContext, deliveryId: string, ticketId: number | null, route: { provider: string | null; model: string | null }): (input: ResolverInput) => Promise<void> {
  return async (input) => {
    // The delivery run's own provider and model when it recorded concrete ones, else the machine default.
    const { provider, model } = resolverRoute(route)
    const startedAt = new Date().toISOString()
    const result = await createLoopExecutors().runAiStep({ prompt: buildBaseRefreshResolverPrompt(input, BUILTIN_CONSTANTS.MERGE_SAFE), provider, model, cwd: input.worktreePath, repoDir: input.worktreePath })
    recordMergeStep({ db: c.db, projectId: c.project.id, jobId: deliveryId, ticketId, broadcast: c.broadcast as never }, 'resolve-base', result, startedAt, provider, model)
    if (result.failed) throw new Error(`the conflict resolver did not finish (${provider})`)
  }
}

/** The delivery's current snapshot to every surface (its operation lease changed). */
function publishDelivery(c: ProjectContext, deliveryId: string): void {
  try {
    const row = getPrDelivery(c.db, deliveryId)
    if (row) c.broadcast(toRailPrStateMessage(c.project.id, toPrDeliverySnapshot(row)))
  } catch { /* WS delivery is advisory */ }
}

/** Tell every surface (and the milestone chain) where the refresh stands; advisory, never fails the refresh. */
function announce(c: ProjectContext, deliveryId: string, phase: DeliveryBaseRefreshMessage['phase'], extra: Pick<DeliveryBaseRefreshMessage, 'conflicts' | 'loopRunId' | 'reason'> = {}): void {
  try { c.broadcast({ type: 'delivery.base_refresh', projectId: c.project.id, deliveryId, phase, ...extra }) } catch { /* WS delivery is advisory */ }
}

export async function refreshDeliveryOnBase(c: ProjectContext, deliveryId: string, io: DeliveryBaseRefreshIo = {}): Promise<DeliveryBaseRefreshOutcome> {
  const outcome = await refreshDeliveryOnBaseSteps(c, deliveryId, io)
  if (!outcome.body.ok && outcome.status !== 404) announce(c, deliveryId, 'refused', { reason: outcome.body.error, ...(outcome.body.conflicts?.length ? { conflicts: outcome.body.conflicts } : {}) })
  return outcome
}

async function refreshDeliveryOnBaseSteps(c: ProjectContext, deliveryId: string, io: DeliveryBaseRefreshIo): Promise<DeliveryBaseRefreshOutcome> {
  const git = io.git ?? defaultGitRunner
  const row = getPrDelivery(c.db, deliveryId)
  if (!row) return refused(404, 'delivery_not_found', 'No such delivery in this project')
  const snap = toPrDeliverySnapshot(row)
  // Only a delivery awaiting local review: a pull request keeps its own CI and merge flow.
  if (snap.decision !== 'on_review') return refused(409, 'refresh_not_applicable', `a ${snap.decision} delivery is not refreshed on its base`)
  if (snap.executionManifest) return refused(409, 'refresh_not_applicable', 'multi-repository deliveries are refreshed per repository by hand')
  if (baseRefreshCount(c, snap.runIds) >= BASE_REFRESH_LIMIT) return refused(409, 'refresh_limit_reached', `this delivery was already updated on its base ${BASE_REFRESH_LIMIT} times`)
  const records = readIsolatedSettlementRecords(c.db, c.project.id, deliveryId)
  if (records.length !== 1 || !records[0].result) return refused(409, 'refresh_not_applicable', 'the delivery has no single settled run to refresh')
  const { run } = records[0].snapshot
  if (run.continuationTarget) return refused(409, 'refresh_not_applicable', 'a pull request continuation is refreshed by its CI loop')
  const loopRun = getLoopRun(c.db, run.runId)
  if (!loopRun || loopRun.engine_version !== 2 || readDefinitionSuccessor(c.db, run.runId)) return refused(409, 'refresh_not_applicable', 'the delivery run cannot be continued')
  const unit = snap.branches.find((branch) => branch.succeeded && branch.branch === run.handle.branch)
  const deliverySha = row.delivery_sha ?? unit?.finalSha ?? null
  if (!deliverySha) return refused(409, 'refresh_not_applicable', 'the verified delivery commit is unknown')
  const probe = await probeDefinitionRun({ db: c.db, cwd: c.project.path, env: process.env }, run.runId, true)
  const finalVerify = (probe.scopes ?? []).filter((scope) => scope.scopeId === 'root' && scope.nodePath === BASE_REFRESH_FORK_NODE && typeof scope.visits === 'number' && scope.visits > 0)
  if (probe.status !== 'succeeded' || !finalVerify.length) return refused(409, 'refresh_not_applicable', 'the delivery run has no final verification to repeat')
  const visit = Math.max(...finalVerify.map((scope) => scope.visits!))

  const baseBranch = deliveryIntegrationTarget(c.db, row)
  const baseHead = await git.run(['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`], c.project.path)
  const baseSha = baseHead.code === 0 ? baseHead.stdout.trim() : ''
  if (!baseSha) return refused(409, 'refresh_not_applicable', `the integration branch \`${baseBranch}\` cannot be resolved`)
  const specs: BaseRefreshSpec[] = snap.ticketIds.map((ticketId) => {
    let spec: { title?: string; description?: string } | undefined
    try { spec = c.getTicketSpec(ticketId) } catch { spec = undefined }
    return { ticketId, title: spec?.title ?? null, description: spec?.description ?? null }
  })
  // The delivery is busy while its worktree is merged: no decision (accept, discard...) races the merge,
  // and every delivery surface says what is happening (its `operation`).
  const lease = randomUUID()
  if (!claimPrDeliveryOperation(c.db, deliveryId, 'on_review', 'refresh-on-base', lease)) return refused(409, 'refresh_busy', 'another action on this delivery is in progress')
  publishDelivery(c, deliveryId)
  announce(c, deliveryId, 'merging')
  const resolver = io.resolve ?? defaultResolver(c, deliveryId, snap.ticketIds[0] ?? null, { provider: loopRun.provider ?? null, model: loopRun.model ?? null })
  const resolve = async (input: ResolverInput) => {
    announce(c, deliveryId, 'resolving', { conflicts: [...input.conflictPaths] })
    await resolver(input)
  }
  let merged: Awaited<ReturnType<typeof mergeBaseIntoDelivery>>
  try {
    merged = await mergeBaseIntoDelivery({ git, resolve }, {
      worktreePath: run.handle.worktreePath, branch: run.handle.branch, deliverySha, baseBranch, baseSha,
      protectedBranches: [...new Set([baseBranch, row.base_branch, 'main', 'master'])], specs,
      ticketRef: snap.ticketIds.length ? `${snap.ticketIds[0]}${snap.ticketIds.length > 1 ? ` +${snap.ticketIds.length - 1}` : ''}` : '',
    })
  } finally {
    // Released before the re-verification forks the run: the fork takes the delivery's lease itself.
    if (releasePrDeliveryOperation(c.db, deliveryId, lease)) publishDelivery(c, deliveryId)
  }
  if (!merged.ok) return refused(merged.reason === 'git_failed' ? 502 : 409, `refresh_${merged.reason}`, merged.detail, merged.conflicts)

  // Re-verify the merged candidate: the run forks from its final verification, in the same worktree.
  const requestId = `${BASE_REFRESH_REQUEST_PREFIX}${createHash('sha256').update(`${run.runId}:${baseSha}`).digest('hex').slice(0, 24)}`
  let loopRunId: string
  try {
    loopRunId = (await (io.fork ?? forkDefinitionRun)(c, run.runId, { requestId, fromNodePath: BASE_REFRESH_FORK_NODE, scopeId: 'root', visit })).loopRunId
  } catch (error) {
    const restored = await rollbackBaseRefresh(git, { worktreePath: run.handle.worktreePath, branch: run.handle.branch, deliverySha, mergeSha: merged.mergeSha })
    return refused(409, 'refresh_verification_unavailable', `${error instanceof Error ? error.message : String(error)}${restored ? '' : ' (the merge commit stays on the branch)'}`, merged.conflicts)
  }
  const resume = io.resume ?? (await import('./project-router-loop-runs')).resumeDefinitionRunFromStop
  const resumed = await resume(c, loopRunId)
  if (!resumed.ok) console.warn(`[base-refresh] ${deliveryId}: the re-verification ${loopRunId} did not start (${resumed.error}); resume it from its run page`)
  announce(c, deliveryId, 'verifying', { loopRunId, ...(merged.conflicts.length ? { conflicts: merged.conflicts } : {}) })
  return { status: 202, body: { ok: true, deliveryId, loopRunId, mergeSha: merged.mergeSha, conflicts: merged.conflicts } }
}
