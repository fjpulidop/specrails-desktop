/**
 * Project builder milestones for one project (premium-milestone-progress).
 *
 * Owns the server-durable milestone launch chain and the debounced
 * `blueprint.milestone_progress` broadcaster. Chunks launch through the app's
 * OWN rails routes over loopback (the single authority for every guard) —
 * never by re-implementing a handler.
 */
import type { DbInstance } from './db'
import { getProjectSettings } from './db'
import type { ProjectRow } from './desktop-db'
import { resolveIntegrationBranch } from './integration-branch'
import { internalApiError, type InternalApi } from './internal-api'
import { readBlueprint } from './modules/builder/runtime/blueprint-render'
import { MilestoneChainManager } from './modules/builder/runtime/milestone-chain'
import { MilestoneProgressBroadcaster, markMilestoneDone, readMilestoneProgress, resolveBlueprintWorkspace } from './modules/builder/runtime/milestone-progress'
import { getActivePrDeliveryByRail, getPrDelivery, listActivePrDeliveries, listTerminalPrDeliveries, toPrDeliverySnapshot } from './modules/delivery/runtime/rail-pr-store'
import { getRails } from './modules/delivery/runtime/rails-store'
import { getLoopRun, type LoopRunRow } from './modules/loops/runtime/loop-runs-store'
import type { ReconcileRun } from './modules/builder/runtime/milestone-chain-reconcile'
import { readStore } from './modules/specs/runtime/ticket-store'
import type { ProjectContext } from './project-registry'
import type { WsMessage } from './types'
import { defaultGitRunner } from './worktree-manager'

/** The project's blueprint workspace (null when none is resolvable). */
export function createBlueprintWorkspaceResolver(project: Pick<ProjectRow, 'slug' | 'path'>): () => string | null {
  return (): string | null => resolveBlueprintWorkspace({ slug: project.slug, path: project.path })
}

/** Milestone launch chain (premium-milestone-progress D3). */
export function createProjectMilestoneChains(deps: {
  project: ProjectRow
  db: DbInstance
  internalApi: InternalApi
  railJobs: ProjectContext['railJobs']
  railLoopRuns: ProjectContext['railLoopRuns']
  ticketStorePath: () => string
  blueprintWorkspace: () => string | null
  broadcast: (msg: WsMessage) => void
}): MilestoneChainManager {
  const { project, db, internalApi, railJobs, railLoopRuns, ticketStorePath, blueprintWorkspace, broadcast: boundBroadcast } = deps
  const railsBase = `/projects/${project.id}/rails`
  return new MilestoneChainManager(db, project.id, {
    createRail: async (name) => {
      const r = await internalApi.call('POST', railsBase, { name })
      const railIndex = (r.body as { rail?: { railIndex?: unknown } } | null)?.rail?.railIndex
      return r.ok && typeof railIndex === 'number'
        ? { ok: true, railIndex }
        : { ok: false, status: r.status, ...internalApiError(r) }
    },
    assignTickets: async (railIndex, ticketIds) => {
      const r = await internalApi.call('PUT', `${railsBase}/${railIndex}/tickets`, { ticketIds, mode: 'implement' })
      return r.ok ? { ok: true } : { ok: false, status: r.status, ...internalApiError(r) }
    },
    launch: async (railIndex, body) => {
      const r = await internalApi.call('POST', `${railsBase}/${railIndex}/launch`, body)
      if (!r.ok) return { ok: false, status: r.status, ...internalApiError(r) }
      const data = (r.body ?? {}) as { loopRunIds?: unknown; jobIds?: unknown; jobId?: unknown }
      const ids = Array.isArray(data.loopRunIds) ? data.loopRunIds
        : Array.isArray(data.jobIds) ? data.jobIds
          : typeof data.jobId === 'string' ? [data.jobId] : []
      return { ok: true, loopRunIds: ids.filter((v): v is string => typeof v === 'string') }
    },
    integrateDelivery: async (delivery) => {
      const action = delivery.decision === 'no_changes' ? 'acknowledge-no-changes' : 'merge-local'
      const r = await internalApi.call('POST', `${railsBase}/pr-decision`, { prDeliveryId: delivery.id, expectedDecision: delivery.decision, action })
      return r.ok ? { ok: true } : { ok: false, status: r.status, ...internalApiError(r) }
    },
    refreshDelivery: async (delivery) => {
      const r = await internalApi.call('POST', `/projects/${project.id}/pr-deliveries/${encodeURIComponent(delivery.id)}/refresh-on-base`, {})
      const runId = (r.body as { loopRunId?: unknown } | null)?.loopRunId
      return r.ok && typeof runId === 'string' ? { ok: true, runId } : { ok: false, status: r.status, ...internalApiError(r) }
    },
    activeDeliveryForRail: (railIndex) => {
      const row = getActivePrDeliveryByRail(db, railIndex)
      return row ? toPrDeliverySnapshot(row) : null
    },
    findRailByName: (name) => {
      try {
        const hit = getRails(db).find((r) => r.name === name)
        return hit ? hit.railIndex : null
      } catch { return null }
    },
    listRails: () => {
      try { return getRails(db).map((r) => ({ railIndex: r.railIndex, name: r.name ?? null })) } catch { return [] }
    },
    railBusy: (railIndex) => [...railJobs.values(), ...railLoopRuns.values()].some((entry) => entry.railIndex === railIndex),
    renameRail: async (railIndex, name) => {
      const r = await internalApi.call('PUT', `${railsBase}/${railIndex}/name`, { name })
      return r.ok ? { ok: true } : { ok: false, status: r.status, ...internalApiError(r) }
    },
    getDelivery: (id) => {
      const row = getPrDelivery(db, id)
      return row ? toPrDeliverySnapshot(row) : null
    },
    branchExists: async (branch) => {
      const r = await defaultGitRunner.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], project.path)
      return r.code === 0
    },
    readTickets: () => {
      try {
        return Object.values(readStore(ticketStorePath()).tickets).map((t) => ({ id: t.id, status: t.status, labels: t.labels ?? [], title: t.title ?? null, prerequisites: Array.isArray(t.prerequisites) ? t.prerequisites : [], executionOrder: t.execution_order ?? null }))
      } catch { return [] }
    },
    readBlueprint: () => { const ws = blueprintWorkspace(); return ws ? readBlueprint(ws) : null },
    integrationBranch: async () => {
      try {
        return (await resolveIntegrationBranch(defaultGitRunner, { repoDir: project.path, projectSetting: getProjectSettings(db).integrationBranch })).branch
      } catch { return null }
    },
    resumeFailedRun: async (runId) => {
      // Through the app's own recovery + resume routes (the single authority
      // for budget, lease and settlement guards): authorize re-running every
      // interrupted step, then continue the run in place.
      const runPath = `/projects/${project.id}/loop-runs/${encodeURIComponent(runId)}`
      const probe = await internalApi.call('GET', `${runPath}/recovery`)
      if (!probe.ok) return { ok: false, status: probe.status, ...internalApiError(probe) }
      const state = (probe.body ?? {}) as { resumable?: unknown; recoverableSteps?: unknown }
      if (state.resumable !== true) return { ok: false, status: 409, error: 'run_not_resumable', detail: 'this run cannot continue from its failed step' }
      const recover = Array.isArray(state.recoverableSteps)
        ? state.recoverableSteps.flatMap((step) => typeof (step as { attemptId?: unknown })?.attemptId === 'string' ? [(step as { attemptId: string }).attemptId] : [])
        : []
      const r = await internalApi.call('POST', `${runPath}/resume`, recover.length ? { recover } : {})
      return r.ok ? { ok: true } : { ok: false, status: r.status, ...internalApiError(r) }
    },
    resumeRun: async (runId) => {
      // The run's own resume route (user / restart / budget / limit pauses):
      // the same attempt continues from its next step, every guard applies.
      const r = await internalApi.call('POST', `/projects/${project.id}/loop-runs/${encodeURIComponent(runId)}/resume`, {})
      return r.ok ? { ok: true } : { ok: false, status: r.status, ...internalApiError(r) }
    },
    listDeliveriesForTickets: (ticketIds) => {
      const wanted = new Set(ticketIds)
      return [...listActivePrDeliveries(db), ...listTerminalPrDeliveries(db)]
        .map(toPrDeliverySnapshot)
        .filter((d) => d.ticketIds.some((id) => wanted.has(id)))
    },
    listRunsForTickets: (ticketIds) => listChainRuns(db, project.id, ticketIds, railJobs),
    runState: (runId) => {
      const run = getLoopRun(db, runId)
      if (!run) return null
      return { settled: run.status !== 'running' && run.status !== 'paused', outcome: run.final_outcome ?? null }
    },
    broadcast: boundBroadcast,
  })
}

export function createProjectMilestoneProgress(deps: {
  project: ProjectRow
  db: DbInstance
  railJobs: ProjectContext['railJobs']
  railLoopRuns: ProjectContext['railLoopRuns']
  ticketStorePath: () => string
  blueprintWorkspace: () => string | null
  /** The chain manager, read per derivation. */
  getChains: () => MilestoneChainManager | null
  broadcast: (msg: WsMessage) => void
}): MilestoneProgressBroadcaster {
  const { project, db, railJobs, railLoopRuns, ticketStorePath, blueprintWorkspace, broadcast: boundBroadcast } = deps
  return new MilestoneProgressBroadcaster({
    projectId: project.id,
    read: () => readMilestoneProgress({
      db,
      projectId: project.id,
      workspaceDir: blueprintWorkspace,
      ticketsPath: ticketStorePath,
      railJobs,
      railLoopRuns,
      chains: () => deps.getChains()?.listForProgress() ?? [],
    }),
    persistDone: (milestoneId) => markMilestoneDone(blueprintWorkspace(), milestoneId) !== null,
    broadcast: boundBroadcast,
  })
}

/** Recent runs carrying one of these specs (any origin: the chain's, the
 *  person's, forks), plus live rail jobs without a loop-run row. */
export function listChainRuns(
  db: DbInstance,
  projectId: string,
  ticketIds: number[],
  railJobs?: Map<string, { railIndex: number; ticketIds: number[] }>,
): ReconcileRun[] {
  if (ticketIds.length === 0) return []
  const wanted = new Set(ticketIds)
  const placeholders = ticketIds.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT loop_runs.*,
           EXISTS (SELECT 1 FROM definition_fork_operations AS fork WHERE fork.source_run_id = loop_runs.id AND fork.adopted = 1) AS fork_adopted
      FROM loop_runs
     WHERE project_id = ?
       AND (ticket_id IN (${placeholders})
            OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ticket_ids_json) THEN ticket_ids_json ELSE '[]' END) WHERE json_each.value IN (${placeholders})))
     ORDER BY started_at DESC
     LIMIT 200`).all(projectId, ...ticketIds, ...ticketIds) as Array<LoopRunRow & { fork_adopted: number }>
  const runs: ReconcileRun[] = rows.map((run) => {
    let ids: number[] = []
    try { const parsed = JSON.parse(run.ticket_ids_json ?? '[]'); if (Array.isArray(parsed)) ids = parsed.filter((v): v is number => typeof v === 'number') } catch { ids = [] }
    if (ids.length === 0 && run.ticket_id != null) ids = [run.ticket_id]
    return {
      // A run whose Continue fork was adopted no longer owns the execution.
      id: run.id, ticketIds: ids, railIndex: run.rail_index ?? null, status: run.fork_adopted ? 'superseded' : run.status, outcome: run.final_outcome ?? null,
      pauseReason: run.restart_reason ?? null, forkOf: run.fork_of ?? null, engineVersion: run.engine_version ?? null, startedAt: run.started_at ?? null,
    }
  })
  const seen = new Set(runs.map((r) => r.id))
  for (const [jobId, meta] of railJobs?.entries() ?? []) {
    if (seen.has(jobId) || !meta.ticketIds.some((id) => wanted.has(id))) continue
    runs.push({ id: jobId, ticketIds: meta.ticketIds, railIndex: meta.railIndex, status: 'running', outcome: null, pauseReason: null, forkOf: null, engineVersion: null, startedAt: null })
  }
  return runs
}
