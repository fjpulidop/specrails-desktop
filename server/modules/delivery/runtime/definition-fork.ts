import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createJob, getJob } from '../../../db'
import type { ProjectContext } from '../../../project-registry'
import { runAgentRuntimeControl, readFrozenRuntimeHost, assertRetainedForkSupport, type AgentRuntimeForkResult, type AgentRuntimeControlInvocation } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { claimDefinitionExecution, createLoopRun, definitionRepositoryMounts, linkDefinitionFork, readDefinitionExecutionClaim, readDefinitionRun, readDefinitionSuccessor, saveDefinitionRun } from '../../loops/runtime/loop-runs-store'
import { probeDefinitionRun } from '../../loops/runtime/loop-definition-recovery'
import { claimPrDeliveryOperation, getPrDelivery, releasePrDeliveryOperation, transitionClaimedDecision, type DeliverBranchRecord } from './rail-pr-store'
import { readIsolatedSettlementRecords, saveIsolatedSettlementSnapshot } from './isolated-settlement-store'
import { getRailWorktree } from './rail-worktrees-store'

export interface DefinitionForkRequest {
  requestId: string
  fromNodePath: string
  scopeId?: string
  visit?: number
  state?: Record<string, unknown>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export function validateDefinitionForkRequest(value: unknown): DefinitionForkRequest {
  if (!object(value) || Object.keys(value).some(key => !['requestId', 'fromNodePath', 'scopeId', 'visit', 'state'].includes(key)) ||
    typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.requestId) ||
    typeof value.fromNodePath !== 'string' || !value.fromNodePath.trim() || value.fromNodePath.length > 2048 ||
    value.scopeId !== undefined && (typeof value.scopeId !== 'string' || !value.scopeId || value.scopeId.length > 2048) ||
    value.visit !== undefined && (!Number.isSafeInteger(value.visit) || Number(value.visit) < 1) ||
    value.state !== undefined && (!object(value.state) || Object.keys(value.state).some(key => !['$vars', '$outputs'].includes(key)) || Object.values(value.state).some(channel => !object(channel)))) throw new Error('invalid_fork_request')
  if (JSON.stringify(value).length > 2 * 1024 * 1024) throw new Error('invalid_fork_request: State exceeds 2 MiB')
  return value as unknown as DefinitionForkRequest
}
interface ForkOperation { child_run_id: string; request_json: string; result_json: string | null; adopted: number }
export interface DefinitionForkResult { loopRunId: string; forkOf: string; fromNodePath: string; scopeId: string | null; visit: number | null }

/** Core owns the historical cut; Desktop atomically moves only host ownership.
 * A durable request precedes Core publication so a lost acknowledgement can be
 * retried. The source job, frozen inputs, events and accounting remain untouched.
 */
export async function forkDefinitionRun(ctx: ProjectContext, runId: string, input: DefinitionForkRequest, io: {
  probe?: typeof probeDefinitionRun
  fork?: (options: Extract<AgentRuntimeControlInvocation, { kind: 'fork' }>) => Promise<AgentRuntimeForkResult>
} = {}): Promise<DefinitionForkResult> {
  const db = ctx.db, projectId = ctx.project.id
  const frozen = readDefinitionRun(db, runId), sourceJob = getJob(db, runId)
  if (!frozen || frozen.row.project_id !== projectId || !frozen.metadata.contextPath || !sourceJob) throw new Error('runtime_run_not_found')
  const request = validateDefinitionForkRequest(input), encoded = JSON.stringify(canonical(request))
  const prior = db.prepare('SELECT * FROM definition_fork_operations WHERE project_id=? AND source_run_id=? AND request_id=?').get(projectId, runId, request.requestId) as ForkOperation | undefined
  if (prior && prior.request_json !== encoded) throw new Error('fork_request_conflict')
  if (prior?.adopted && prior.result_json) return JSON.parse(prior.result_json) as DefinitionForkResult
  if (readDefinitionSuccessor(db, runId)) throw new Error('runtime_fork_owns_worktree')
  if (!prior && db.prepare('SELECT 1 FROM definition_fork_operations WHERE source_run_id=? LIMIT 1').get(runId)) throw new Error('fork_request_pending: Retry the original request')
  const childRunId = prior?.child_run_id ?? `fork-${createHash('sha256').update(JSON.stringify([projectId, runId, request.requestId])).digest('hex').slice(0, 32)}`
  const observed = readDefinitionExecutionClaim(db, runId)
  const probe = await (io.probe ?? probeDefinitionRun)({ db, cwd: ctx.project.path, env: process.env }, runId)
  if (probe.status === 'unavailable') throw new Error('runtime_status_unavailable')
  if (probe.lease?.active || ctx.loopRunManager.isDefinitionCancellationPending(runId)) throw new Error('runtime_run_active')
  if (readDefinitionRun(db, runId)?.row.status === 'running') throw new Error('runtime_run_active: Wait for the host pause or terminal settlement')
  if (observed && !ctx.loopRunManager.isDefinitionRunActive(runId)) db.prepare(`DELETE FROM definition_execution_claims WHERE run_id=? AND owner=?
    AND EXISTS (SELECT 1 FROM loop_runs WHERE id=? AND status='paused' AND restart_reason='restart')`).run(runId, observed.owner, runId)
  const token = `fork:${randomUUID()}`
  const execution = claimDefinitionExecution(db, runId, { owner: token, repositoryMounts: definitionRepositoryMounts(frozen.request) })
  if (!execution.ok) throw new Error('runtime_run_active')
  const claimed: Array<NonNullable<ReturnType<typeof getPrDelivery>>> = []
  try {
    const owned = db.prepare('SELECT delivery_id FROM definition_delivery_settlements WHERE project_id=? AND run_id=? AND superseded_by IS NULL').all(projectId, runId) as Array<{ delivery_id: string }>
    const deliveries = owned.map(row => getPrDelivery(db, row.delivery_id)!)
    const parentIds = deliveries.flatMap(row => row?.parent_delivery_id ? [row.parent_delivery_id] : [])
    const all = [...deliveries, ...[...new Set(parentIds)].map(id => getPrDelivery(db, id)!)]
    if (frozen.request.deferTerminalOutcome && !deliveries.length) throw new Error('Original isolated settlement snapshot is unavailable')
    if (frozen.row.status === 'completed' && deliveries.some(row => !readIsolatedSettlementRecords(db, projectId, row.id).find(record => record.snapshot.run.runId === runId)?.result)) throw new Error('runtime_settlement_pending: Finish original settlement before forking')
    if (all.some(row => !row || ['discarded', 'superseded', 'merged', 'completed'].includes(row.decision))) throw new Error('Delivery ownership has already changed')
    const host = readFrozenRuntimeHost(frozen.metadata.contextPath, process.env, runId)
    const forkOptions = { ...request, kind: 'fork' as const, runId, childRunId, contextPath: frozen.metadata.contextPath, cwd: host.cwd, env: host.env }
    if (!io.fork) await assertRetainedForkSupport(forkOptions)
    db.transaction(() => {
      for (const row of all) {
        if (!claimPrDeliveryOperation(db, row.id, row.decision, 'recover-and-retry', token)) throw new Error('Delivery is busy')
        claimed.push(row)
      }
      if (!prior) db.prepare('INSERT INTO definition_fork_operations(project_id,source_run_id,request_id,child_run_id,request_json) VALUES (?,?,?,?,?)').run(projectId, runId, request.requestId, childRunId, encoded)
    })()
    let fork: AgentRuntimeForkResult
    try { fork = io.fork ? await io.fork(forkOptions) : await runAgentRuntimeControl(forkOptions) }
    catch (error) {
      // An authoritative pre-publication rejection is not a lost receipt. Only
      // drop its intent when the destination does not exist; uncertain failures
      // and all published/partial children keep the exact retry identity.
      if (error instanceof Error && /^(fork_ambiguous|fork_checkpoint_missing|invalid_arguments|resume_incompatible|lease_held):/.test(error.message) &&
        !existsSync(join(dirname(dirname(frozen.metadata.contextPath)), childRunId))) {
        db.prepare('DELETE FROM definition_fork_operations WHERE project_id=? AND source_run_id=? AND request_id=? AND adopted=0 AND result_json IS NULL').run(projectId, runId, request.requestId)
      }
      throw error
    }
    if (fork.runId !== childRunId || fork.forkOf !== runId) throw new Error('Core returned another fork identity')
    const result: DefinitionForkResult = { loopRunId: childRunId, forkOf: runId, fromNodePath: fork.fromNodePath, scopeId: fork.scopeId, visit: fork.visit }
    db.transaction(() => {
      // Recheck all ownership after asynchronous Core work; a failed adoption
      // rolls back entirely and retains the published child for the same retry.
      const tickets = JSON.parse(frozen.row.ticket_ids_json ?? '[]') as number[]
      for (const ticket of tickets) {
        const owner = db.prepare('SELECT owner_id FROM ticket_outcome_ownership WHERE ticket_id=?').get(ticket) as { owner_id: string } | undefined
        if (owner?.owner_id !== runId) throw new Error('Ticket ownership changed before fork adoption')
      }
      createLoopRun(db, { id: childRunId, projectId, loopId: frozen.row.loop_id, loopName: frozen.row.loop_name, railIndex: frozen.row.rail_index,
        ticketId: frozen.row.ticket_id, ticketIds: tickets, ticketCompletionStatus: frozen.row.ticket_completion_status, causalOwnership: !!frozen.row.causal_ownership,
        provider: frozen.row.provider, model: frozen.row.model, reasoningEffort: frozen.row.reasoning_effort, iterationLimit: frozen.row.iteration_limit, startedAt: new Date().toISOString() })
      createJob(db, { id: childRunId, command: sourceJob.command, owner: 'loop', provider: sourceJob.provider, causal_ownership: !!frozen.row.causal_ownership, started_at: new Date().toISOString() })
      saveDefinitionRun(db, childRunId, { ...frozen.metadata, contextPath: fork.contextPath, runtimeDirectory: fork.runtimeDirectory,
        definitionPath: fork.definitionPath, configPath: fork.configPath, context: fork.context,
        inheritedAddendaClaims: [...(frozen.metadata.inheritedAddendaClaims ?? []), ...(frozen.request.addenda?.ids.length ? [{ runId, ids: frozen.request.addenda.ids }] : [])],
        request: { ...frozen.request, runId: childRunId } })
      linkDefinitionFork(db, childRunId, { forkOf: runId, forkCut: { fromNodePath: fork.fromNodePath, scopeId: fork.scopeId, visit: fork.visit, revision: fork.revision } })
      db.prepare("UPDATE loop_runs SET status='paused',restart_reason='fork' WHERE id=?").run(childRunId)
      if (frozen.request.executionManifest) db.prepare('UPDATE loop_runs SET execution_manifest=? WHERE id=?').run(JSON.stringify(frozen.request.executionManifest), childRunId)
      db.prepare("UPDATE ticket_outcome_ownership SET owner_id=?,generation=generation+1,claimed_at=datetime('now') WHERE owner_id=?").run(childRunId, runId)
      db.prepare("UPDATE rail_ticket_ownership SET owner_id=?,generation=generation+1,claimed_at=datetime('now') WHERE owner_id=?").run(childRunId, runId)
      for (const row of deliveries) {
        const source = readIsolatedSettlementRecords(db, projectId, row.id).find(record => record.snapshot.run.runId === runId)
        if (!source) throw new Error('Original isolated allocation is missing')
        const snapshot = source.snapshot, ledger = getRailWorktree(db, snapshot.run.ledgerId)
        if (!ledger || ledger.run_id !== runId || ledger.branch !== snapshot.run.handle.branch || ledger.worktree_path !== snapshot.run.handle.worktreePath) throw new Error('Worktree ownership changed before fork adoption')
        saveIsolatedSettlementSnapshot(db, { ...snapshot, run: { ...snapshot.run, runId: childRunId } })
        db.prepare('UPDATE definition_delivery_settlements SET superseded_by=? WHERE project_id=? AND delivery_id=? AND run_id=? AND superseded_by IS NULL').run(childRunId, projectId, row.id, runId)
        db.prepare("UPDATE rail_worktrees SET run_id=?,merge_state='building' WHERE id=? AND run_id=?").run(childRunId, ledger.id, runId)
      }
      for (const row of all) {
        const runIds = (JSON.parse(row.run_ids) as string[]).map(id => id === runId ? childRunId : id)
        if (!runIds.includes(childRunId)) runIds.push(childRunId)
        const branches = (JSON.parse(row.branches) as DeliverBranchRecord[]).filter(branch => branch.runId !== runId)
        if (!transitionClaimedDecision(db, row.id, row.decision, 'building', token, { runIds, branches, implementationOutcome: 'unknown', deliveryOutcome: 'not_started', statusCode: 'restart_pending', statusDetail: 'Fork created; resume the linked run to continue.', settleEvidence: null })) throw new Error('Delivery changed before fork adoption')
      }
      db.prepare('UPDATE definition_fork_operations SET result_json=?,adopted=1 WHERE project_id=? AND source_run_id=? AND request_id=?').run(JSON.stringify(result), projectId, runId, request.requestId)
    })()
    return result
  } finally {
    for (const row of claimed) releasePrDeliveryOperation(db, row.id, token)
    execution.release()
  }
}
