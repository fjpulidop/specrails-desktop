import type { ProjectContext } from '../../../project-registry'
import { getLoopRun, type LoopRunRow } from '../../loops/runtime/loop-runs-store'
import { getActivePrDeliveryByRail, getPrDelivery, toPrDeliverySnapshot, type PrDeliverySnapshot } from './rail-pr-store'
import { getRail, railExists, setRailTickets, type RailState } from './rails-store'

export class RailRelaunchError extends Error {
  constructor(readonly code: string, detail: string, readonly action: string) { super(detail) }
}

export interface RailRelaunch {
  sourceId: string
  ticketIds: number[]
  config: Record<string, unknown>
  delivery?: PrDeliverySnapshot
}

function jsonObject(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved launch configuration')
  return value as Record<string, unknown>
}

function historicalConfig(run?: LoopRunRow): Record<string, unknown> {
  if (!run) return {}
  const request = jsonObject(run.run_request_json)
  return {
    mode: 'loop',
    ...(run.loop_id ? { loopId: run.loop_id } : {}),
    ...(run.provider ? { aiEngine: run.provider } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.reasoning_effort ? { reasoning_effort: run.reasoning_effort } : {}),
    // These are launch options, not the old cwd, worktree, graph or run id.
    ...(request?.profileName !== undefined ? { profileName: request.profileName } : {}),
    ...(request?.runtimeProviderOverride ? { runtimeProviderOverride: request.runtimeProviderOverride } : {}),
    ...(request?.repositoryId ? { repositoryIds: [request.repositoryId] } : {}),
    ...(request?.repositoryId && request.workspacePaths ? { workspaceSelection: { [String(request.repositoryId)]: request.workspacePaths } } : {}),
  }
}

function unavailable(code: string, detail: string): never {
  throw new RailRelaunchError(code, detail, 'Refresh the mission and configure a fresh launch on a free rail.')
}

/** Per-ticket launches share a rail but settle independently. A later sibling
 * is not a replacement; only a run covering one of this source's specs is. */
function latestOverlappingRun(c: ProjectContext, railIndex: number, ticketIds: number[]): { id: string; status: string } | undefined {
  const ids = JSON.stringify(ticketIds)
  return c.db.prepare(`SELECT id, status FROM loop_runs
    WHERE rail_index = ? AND (ticket_id IN (SELECT value FROM json_each(?))
      OR EXISTS (SELECT 1 FROM json_each(COALESCE(ticket_ids_json, '[]')) AS ticket
        WHERE ticket.value IN (SELECT value FROM json_each(?))))
    ORDER BY rowid DESC LIMIT 1`).get(railIndex, ids, ids) as { id: string; status: string } | undefined
}

/** Resolve the source in this project's database. A card never authorizes the
 * current contents of its mutable rail slot, or arbitrary launch overrides. */
export function resolveRailRelaunch(c: ProjectContext, railIndex: number, sourceId: unknown): RailRelaunch {
  if (typeof sourceId !== 'string' || !/^(?:run:)?[A-Za-z0-9-]{1,128}$/.test(sourceId)) {
    unavailable('invalid_relaunch_source', 'Relaunch requires the original delivery or run id.')
  }
  let ticketIds: number[], config: Record<string, unknown>, delivery: PrDeliverySnapshot | undefined
  if (sourceId.startsWith('run:')) {
    const run = getLoopRun(c.db, sourceId.slice(4))
    if (!run || run.project_id !== c.project.id || run.rail_index !== railIndex) unavailable('relaunch_source_missing', 'The original run is unavailable in this project and rail.')
    if (run.status !== 'completed') unavailable('relaunch_source_active', 'The original run is still active or paused.')
    ticketIds = JSON.parse(run.ticket_ids_json ?? '[]') as number[]
    if (!ticketIds.length && run.ticket_id != null) ticketIds = [run.ticket_id]
    config = jsonObject(run.launch_config_json) ?? historicalConfig(run)
    const newer = latestOverlappingRun(c, railIndex, ticketIds)
    if (newer?.id !== run.id || getActivePrDeliveryByRail(c.db, railIndex)) unavailable('relaunch_source_stale', 'Another attempt has already replaced this run on the rail.')
  } else {
    const row = getPrDelivery(c.db, sourceId)
    if (!row || row.rail_index !== railIndex || row.parent_delivery_id) unavailable('relaunch_source_missing', 'The original delivery is unavailable in this project and rail.')
    delivery = toPrDeliverySnapshot(row)
    if (!['implementation_failed', 'pr_failed'].includes(row.decision) && !(row.decision === 'discarded' && ['delivery_failed', 'cancelled'].includes(row.status_code ?? ''))) {
      unavailable('relaunch_source_stale', 'The original delivery is no longer a failed attempt awaiting relaunch.')
    }
    if (row.operation_token) unavailable('relaunch_source_busy', 'A delivery operation is still in progress.')
    const active = getActivePrDeliveryByRail(c.db, railIndex)
    const latest = c.db.prepare('SELECT id FROM rail_pr_deliveries WHERE rail_index = ? AND parent_delivery_id IS NULL ORDER BY rowid DESC LIMIT 1').get(railIndex) as { id: string } | undefined
    if (active ? active.id !== sourceId : latest?.id !== sourceId) unavailable('relaunch_source_stale', 'Another delivery has already replaced this attempt on the rail.')
    ticketIds = delivery.ticketIds
    const run = delivery.runIds.map(id => getLoopRun(c.db, id)).find(Boolean)
    const savedConfig = jsonObject(row.launch_config_json)
    config = savedConfig ?? {
      mode: 'loop',
      ...historicalConfig(run),
      ...(row.loop_id ? { loopId: row.loop_id } : {}),
      ...(delivery.followUp ? { targetPrNumber: delivery.prNumber, followUp: delivery.followUp } : {}),
    }
    // Always retain the admitted base; ordinary launch defaults may have changed.
    if (!config.baseBranch && row.base_branch) config.baseBranch = row.base_branch
    if (delivery.executionManifest) {
      config.repositoryIds = delivery.executionManifest.selectedRepositoryIds
      config.workspaceSelection = savedConfig?.workspaceSelection ?? Object.fromEntries(delivery.executionManifest.repositories
        .filter(repo => repo.selectedWorkspacePaths).map(repo => [repo.repositoryId, repo.selectedWorkspacePaths]))
    }
  }
  if (!Array.isArray(ticketIds) || !ticketIds.length || ticketIds.some(id => !Number.isSafeInteger(id) || id <= 0)) unavailable('relaunch_specs_unavailable', 'The original spec set is unavailable.')
  if (typeof config.loopId !== 'string' || !config.loopId) unavailable('relaunch_config_unavailable', 'The original workflow was not recorded; Relaunch cannot safely choose a replacement.')
  // Revision identity belongs to the old generation. Retry uses the original
  // complete spec set and the separate atomic retryOfDelivery contract.
  const { revisionOfDeliveryId: _revisionId, revisionNote: _revisionNote, ...retryConfig } = config
  const source = { sourceId, ticketIds, config: retryConfig, delivery }
  assertRelaunchRail(c, railIndex, source)
  return source
}

export function assertRelaunchRail(c: ProjectContext, railIndex: number, source: RailRelaunch): RailState {
  if (!railExists(c.db, railIndex)) unavailable('relaunch_rail_missing', 'The original rail was removed.')
  const rail = getRail(c.db, railIndex)
  if (rail.ticketIds.length && (rail.ticketIds.length !== source.ticketIds.length || rail.ticketIds.some(id => !source.ticketIds.includes(id)))) {
    unavailable('relaunch_rail_changed', 'This rail now contains different specs. Relaunch has not changed or launched them.')
  }
  if (source.delivery) {
    const current = getPrDelivery(c.db, source.sourceId)
    const active = getActivePrDeliveryByRail(c.db, railIndex)
    const latest = c.db.prepare('SELECT id FROM rail_pr_deliveries WHERE rail_index = ? AND parent_delivery_id IS NULL ORDER BY rowid DESC LIMIT 1').get(railIndex) as { id: string } | undefined
    if (!current || current.decision !== source.delivery.decision || current.operation_token || (active ? active.id !== current.id : latest?.id !== current.id)) {
      unavailable('relaunch_source_stale', 'The original delivery changed while Relaunch was being prepared.')
    }
  } else {
    const latest = latestOverlappingRun(c, railIndex, source.ticketIds)
    if (latest?.id !== source.sourceId.slice(4) || latest.status !== 'completed' || getActivePrDeliveryByRail(c.db, railIndex)) {
      unavailable('relaunch_source_stale', 'The original run changed while Relaunch was being prepared.')
    }
  }
  return rail
}

/** Called after preflight, immediately before admission. Empty assignment is
 * terminal cleanup; a different assignment remains the user's current work. */
export function restoreRelaunchRail(c: ProjectContext, railIndex: number, source: RailRelaunch): boolean {
  const rail = assertRelaunchRail(c, railIndex, source)
  if (!rail.ticketIds.length) {
    setRailTickets(c.db, railIndex, source.ticketIds, String(source.config.mode ?? 'implement'),
      typeof source.config.profileName === 'string' ? source.config.profileName : null,
      typeof source.config.aiEngine === 'string' ? source.config.aiEngine : null)
    return true
  }
  return false
}
