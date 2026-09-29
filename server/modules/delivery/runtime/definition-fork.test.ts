import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { initDb, createJob, getJob, type DbInstance } from '../../../db'
import type { ProjectContext } from '../../../project-registry'
import { createLoopRun, saveDefinitionRun, readDefinitionRun, readDefinitionSuccessor, claimDefinitionExecution } from '../../loops/runtime/loop-runs-store'
import type { LoopRunRequest } from '../../loops/runtime/loop-run-manager'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import type { AgentRuntimeControlInvocation } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { forkDefinitionRun, validateDefinitionForkRequest } from './definition-fork'
import { createPrDelivery, getPrDelivery } from './rail-pr-store'
import { createRailWorktree, getRailWorktree } from './rail-worktrees-store'
import { saveIsolatedSettlementSnapshot, readIsolatedSettlementRecords } from './isolated-settlement-store'
import type { AllocatedRun } from './rail-isolated-launch'

let db: DbInstance, root: string, ctx: ProjectContext, contextPath: string
const request = { requestId: 'fork-request', fromNodePath: 'map/read', scopeId: 'branch-1', visit: 2 }
const probe = vi.fn(async (): Promise<DefinitionRunProbe> => ({ runId: 'source', engineVersion: 2, status: 'paused', resumable: true, lease: null, recoverableSteps: [], pendingInterrupts: [], completion: null, coreRevision: 4, eventCursor: 3, probedAt: new Date().toISOString() }))
const fork = vi.fn(async (input: Extract<AgentRuntimeControlInvocation, { kind: 'fork' }>) => ({ kind: 'fork' as const, runId: input.childRunId, forkOf: input.runId, fromNodePath: input.fromNodePath, scopeId: input.scopeId ?? null, visit: input.visit ?? null, revision: 5,
  directory: path.join(root, input.childRunId, 'agent-workflow'), runtimeDirectory: path.join(root, input.childRunId), contextPath: path.join(root, input.childRunId, 'desktop-context.json'), definitionPath: path.join(root, input.childRunId, 'definition.json'), configPath: path.join(root, input.childRunId, 'config.json'), context: { runId: input.childRunId, repositories: [{ path: root }] } }))
beforeEach(() => {
  vi.clearAllMocks(); db = initDb(':memory:'); root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-fork-')))
  contextPath = path.join(root, 'desktop-context.json')
  fs.writeFileSync(contextPath, JSON.stringify({ runId: 'source', backlogRoot: root, artifactRoot: root, repositories: [{ path: root }] }))
  fs.writeFileSync(path.join(root, 'desktop-runtime-host.json'), JSON.stringify({ schemaVersion: 1, cwd: root, env: { SPECRAILS_GIT_AUTO: 'false' } }))
  createLoopRun(db, { id: 'source', projectId: 'p', loopId: 'loop', iterationLimit: 10, ticketIds: [1], railIndex: 0, causalOwnership: true, startedAt: new Date().toISOString() })
  createJob(db, { id: 'source', command: 'loop: fixture', owner: 'loop', started_at: new Date().toISOString() })
  saveDefinitionRun(db, 'source', { contextPath, request: { runId: 'source', projectId: 'p', loopId: 'loop', cwd: root, provider: 'fixture', model: 'fixture', graph: { nodes: [], edges: [], config: {} } } as LoopRunRequest })
  db.prepare("UPDATE loop_runs SET status='paused' WHERE id='source'").run()
  db.prepare("INSERT INTO ticket_outcome_ownership(ticket_id,owner_id,generation,claimed_at) VALUES (1,'source',1,datetime('now'))").run()
  db.prepare("INSERT INTO rail_ticket_ownership(rail_index,ticket_id,owner_id,generation,claimed_at) VALUES (0,1,'source',1,datetime('now'))").run()
  ctx = { db, project: { id: 'p', path: root }, loopRunManager: { isDefinitionRunActive: () => false, isDefinitionCancellationPending: () => false } } as unknown as ProjectContext
})
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
it('adopts one new child and causal owner while preserving the complete source row and job', async () => {
  const source = readDefinitionRun(db, 'source'), job = getJob(db, 'source')
  const result = await forkDefinitionRun(ctx, 'source', request, { probe, fork })
  expect(result).toMatchObject({ forkOf: 'source', scopeId: 'branch-1', visit: 2 })
  expect(readDefinitionRun(db, 'source')).toEqual(source)
  expect(getJob(db, 'source')).toEqual(job)
  expect(readDefinitionRun(db, result.loopRunId)).toMatchObject({ row: { fork_of: 'source', status: 'paused' }, request: { runId: result.loopRunId, cwd: root } })
  expect(db.prepare('SELECT owner_id FROM ticket_outcome_ownership WHERE ticket_id=1').get()).toEqual({ owner_id: result.loopRunId })
  expect(readDefinitionSuccessor(db, 'source')).toBe(result.loopRunId)
  expect(claimDefinitionExecution(db, 'source', { owner: 'late-source', repositoryMounts: [root] })).toMatchObject({ ok: false, reason: 'lineage_conflict' })
  expect(await forkDefinitionRun(ctx, 'source', request, { probe, fork })).toEqual(result)
  expect(fork).toHaveBeenCalledOnce()
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_invocations').get()).toEqual({ n: 0 })
})
it('rolls back failed adoption and retries the same published child identity', async () => {
  db.exec("CREATE TRIGGER fail_fork BEFORE INSERT ON jobs WHEN NEW.id!='source' BEGIN SELECT RAISE(ABORT,'injected host failure'); END")
  await expect(forkDefinitionRun(ctx, 'source', request, { probe, fork })).rejects.toThrow('injected host failure')
  expect(readDefinitionSuccessor(db, 'source')).toBeUndefined()
  expect(db.prepare('SELECT COUNT(*) AS n FROM loop_runs').get()).toEqual({ n: 1 })
  expect(db.prepare('SELECT COUNT(*) AS n FROM definition_execution_claims').get()).toEqual({ n: 0 })
  db.exec('DROP TRIGGER fail_fork')
  const result = await forkDefinitionRun(ctx, 'source', request, { probe, fork })
  expect(fork.mock.calls[0][0].childRunId).toBe(result.loopRunId)
  expect(fork.mock.calls[1][0].requestId).toBe(request.requestId)
})
it('rejects a changed request after the durable intent was recorded', async () => {
  fork.mockRejectedValueOnce(new Error('lost acknowledgement'))
  await expect(forkDefinitionRun(ctx, 'source', request, { probe, fork })).rejects.toThrow('lost acknowledgement')
  expect(claimDefinitionExecution(db, 'source', { owner: 'new-process', repositoryMounts: [root] })).toMatchObject({ ok: false, reason: 'lineage_conflict' })
  await expect(forkDefinitionRun(ctx, 'source', { ...request, visit: 3 }, { probe, fork })).rejects.toThrow('fork_request_conflict')
  expect(fork).toHaveBeenCalledOnce()
})
it('releases a conclusively rejected unpublished intent so a corrected cut can be selected', async () => {
  fork.mockRejectedValueOnce(new Error('fork_ambiguous: select an exact visit'))
  await expect(forkDefinitionRun(ctx, 'source', request, { probe, fork })).rejects.toThrow('fork_ambiguous')
  expect(db.prepare('SELECT COUNT(*) AS n FROM definition_fork_operations').get()).toEqual({ n: 0 })
  expect(await forkDefinitionRun(ctx, 'source', { ...request, visit: 3 }, { probe, fork })).toMatchObject({ visit: 3 })
})
it('rechecks ticket ownership after asynchronous Core work and retains the retry intent', async () => {
  const original = fork.getMockImplementation()!
  fork.mockImplementationOnce(async input => {
    const result = await original(input)
    db.prepare("UPDATE ticket_outcome_ownership SET owner_id='new-launch'").run()
    return result
  })
  await expect(forkDefinitionRun(ctx, 'source', request, { probe, fork })).rejects.toThrow('Ticket ownership changed')
  expect(readDefinitionSuccessor(db, 'source')).toBeUndefined()
  expect(db.prepare('SELECT COUNT(*) AS n FROM loop_runs').get()).toEqual({ n: 1 })
})
it('transfers the original isolated allocation and retains its historical snapshot', async () => {
  createPrDelivery(db, { id: 'delivery', railIndex: 0, loopId: 'loop', railKey: 'key', loopName: 'Loop', ticketIds: [1], baseBranch: 'main', originSurface: 'dashboard' })
  createRailWorktree(db, { id: 'mount', runId: 'source', railIndex: 0, ticketId: 1, branch: 'work', worktreePath: root })
  const run: AllocatedRun = { ticketId: 1, ticketIds: [1], runId: 'source', ledgerId: 'mount', handle: { branch: 'work', worktreePath: root }, overlayExcludes: [], overlayCleanupEvidence: [], warmLinkEvidence: [], provenanceSnapshot: null, continuationTarget: null, baseRef: 'main', initialSha: 'a'.repeat(40), branchOwnership: 'created', worktreeOwnership: 'created' }
  saveIsolatedSettlementSnapshot(db, { version: 1, projectId: 'p', deliveryId: 'delivery', baseRepo: root, overlaySourceRoot: root, overlayProviderDir: '.claude', overlayInstructions: 'CLAUDE.md', commitMessage: 'commit', partialCommitMessage: 'partial', run })
  const sourceSnapshot = db.prepare('SELECT snapshot_json FROM definition_delivery_settlements').get()
  const result = await forkDefinitionRun(ctx, 'source', request, { probe, fork })
  expect(readIsolatedSettlementRecords(db, 'p', 'delivery').map(record => record.snapshot.run.runId)).toEqual([result.loopRunId])
  expect(db.prepare("SELECT snapshot_json FROM definition_delivery_settlements WHERE run_id='source'").get()).toEqual(sourceSnapshot)
  expect(getRailWorktree(db, 'mount')?.run_id).toBe(result.loopRunId)
  expect(getPrDelivery(db, 'delivery')).toMatchObject({ decision: 'building', operation_token: null })
})
it.each([{ ...request, requestId: '../unsafe' }, { ...request, visit: 0 }, { ...request, state: { budget: {} } }, { ...request, unexpected: true }])('rejects malformed controls before execution', value => {
  expect(() => validateDefinitionForkRequest(value)).toThrow('invalid_fork_request')
})
