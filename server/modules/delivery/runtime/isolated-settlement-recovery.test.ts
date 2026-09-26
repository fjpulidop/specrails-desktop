import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, createJob, type DbInstance } from '../../../db'
import type { ProjectContext } from '../../../project-registry'
import { createPrDelivery, getPrDelivery, claimPrDeliveryOperation } from './rail-pr-store'
import { createRailWorktree } from './rail-worktrees-store'
import { createLoopRun, saveDefinitionRun, finishLoopRunAndJob } from '../../loops/runtime/loop-runs-store'
import type { LoopRunRequest } from '../../loops/runtime/loop-run-manager'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import { saveIsolatedSettlementSnapshot, readIsolatedSettlementRecords, saveIsolatedSettlementResult } from './isolated-settlement-store'
import { reattachIsolatedSettlement, type AllocatedRun } from './rail-isolated-launch'
import { harvestDeliveryEvidence } from './delivery-evidence'

const fixture = vi.hoisted(() => ({ probe: null as unknown, evidence: vi.fn() }))
vi.mock('../../loops/runtime/loop-definition-recovery', () => ({ probeDefinitionRun: async () => fixture.probe, probeDefinitionRuns: fixture.evidence }))
let db: DbInstance, root: string, ctx: ProjectContext, run: AllocatedRun
const git = { run: vi.fn(async (args: string[]) => ({ code: 0, stderr: '', stdout: args[0] === 'branch' ? 'work' : args[0] === 'rev-parse' ? 'b'.repeat(40) : '' })) }
const recordProvenance = vi.fn()
const probe = (): DefinitionRunProbe => ({ runId: 'run', engineVersion: 2, status: 'succeeded', resumable: false, lease: null, recoverableSteps: [], pendingInterrupts: [], completion: { ok: true, verified: true, reasons: [] }, coreRevision: 7, eventCursor: 11, probedAt: new Date().toISOString(), scopes: [] })
beforeEach(() => {
  db = initDb(':memory:'); root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reattach-')))
  git.run.mockClear(); recordProvenance.mockClear(); fixture.probe = probe()
  fixture.evidence.mockReset().mockImplementation(async (_ctx: unknown, ids: string[]) => new Map(ids.map(id => [id, { ...probe(), runId: id }])))
  createPrDelivery(db, { id: 'delivery', railIndex: 0, loopId: 'loop', railKey: '0-loop', ticketIds: [1], baseBranch: 'main', loopName: 'Loop', originSurface: 'dashboard' })
  createRailWorktree(db, { id: 'mount', runId: 'run', railIndex: 0, ticketId: 1, branch: 'work', worktreePath: root })
  createJob(db, { id: 'run', command: 'loop:test', started_at: new Date().toISOString(), owner: 'loop' })
  createLoopRun(db, { id: 'run', projectId: 'p', loopId: 'loop', ticketIds: [1], railIndex: 0, ticketCompletionStatus: 'on_review', iterationLimit: 5, startedAt: new Date().toISOString() })
  saveDefinitionRun(db, 'run', { request: { runId: 'run', projectId: 'p', loopId: 'loop', cwd: root, graph: { nodes: [], edges: [], config: {} }, provider: 'test', model: 'test' } as LoopRunRequest,
    definition: { delivery: { requiresVerified: true } }, context: { runId: 'run', repositories: [{ id: 'repo', path: root }] } })
  finishLoopRunAndJob(db, 'run', { outcome: 'success', finishedAt: new Date().toISOString(), callbackOutcome: 'failed', outcomeFinalized: false,
    counters: { iterationCount: 1, totalCostUsd: 5, totalTokens: 8, totalDurationMs: 10 },
    job: { status: 'completed', exitCode: 0, totalCostUsd: 5, tokensIn: 3, tokensOut: 5, tokensCacheRead: null, tokensCacheCreate: null, numTurns: 1, durationMs: 10 } })
  run = { ticketId: 1, ticketIds: [1], runId: 'run', ledgerId: 'mount', handle: { branch: 'work', worktreePath: root }, overlayExcludes: [], overlayCleanupEvidence: [], warmLinkEvidence: [], provenanceSnapshot: null, continuationTarget: null, baseRef: 'main', initialSha: 'a'.repeat(40), branchOwnership: 'created', worktreeOwnership: 'created' }
  saveIsolatedSettlementSnapshot(db, { version: 1, projectId: 'p', deliveryId: 'delivery', baseRepo: root, overlaySourceRoot: root, overlayProviderDir: '.claude', overlayInstructions: 'CLAUDE.md', commitMessage: 'settle', partialCommitMessage: 'partial', run })
  ctx = { db, project: { id: 'p', path: root }, broadcast: vi.fn(), onLoopRunFinished: vi.fn(() => {
    db.prepare('UPDATE loop_terminal_recovery SET callback_completed=1 WHERE run_id=? AND callback_completed=0').run('run')
  }) } as unknown as ProjectContext
})
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
it('reattaches the original worktree to review with unchanged accounting and idempotent Git/provenance', async () => {
  await reattachIsolatedSettlement(ctx, 'delivery', 'run', { git, recordProvenance })
  expect(getPrDelivery(db, 'delivery')).toMatchObject({ decision: 'on_review', implementation_outcome: 'succeeded', operation_token: null })
  expect(db.prepare('SELECT total_cost_usd FROM jobs WHERE id=?').get('run')).toEqual({ total_cost_usd: 5 })
  const calls = git.run.mock.calls.length
  await reattachIsolatedSettlement(ctx, 'delivery', 'run', { git, recordProvenance })
  expect(git.run).toHaveBeenCalledTimes(calls); expect(recordProvenance).toHaveBeenCalledTimes(1)
  expect(db.prepare('SELECT COUNT(*) AS n FROM definition_execution_claims').get()).toEqual({ n: 0 })
  expect(readIsolatedSettlementRecords(db, 'p', 'delivery')[0].result?.deliveryOutcome).toBe('ready')
  expect(readIsolatedSettlementRecords(db, 'other-project', 'delivery')).toEqual([])
})
it.each(['unavailable', 'running'] as const)('performs no Git effects when retained status is %s', async status => {
  fixture.probe = { ...probe(), status }
  await expect(reattachIsolatedSettlement(ctx, 'delivery', 'run', { git })).rejects.toThrow('inactive terminal')
  expect(git.run).not.toHaveBeenCalled()
})
it('keeps an unverified writing run blocked without committing or calling success', async () => {
  fixture.probe = { ...probe(), completion: { ok: true, verified: false, reasons: [] } }
  await reattachIsolatedSettlement(ctx, 'delivery', 'run', { git, recordProvenance })
  expect(getPrDelivery(db, 'delivery')?.decision).toBe('implementation_failed')
  expect(git.run.mock.calls.some(([args]) => args[0] === 'commit')).toBe(false)
  expect(ctx.onLoopRunFinished).toHaveBeenCalledWith('run', 'blocked', { ticketCompletionStatus: 'on_review' })
})
it('rejects moved ownership before staging and releases both claims', async () => {
  db.prepare("UPDATE rail_worktrees SET branch='other' WHERE id='mount'").run()
  await expect(reattachIsolatedSettlement(ctx, 'delivery', 'run', { git })).rejects.toThrow('ownership changed')
  expect(git.run).not.toHaveBeenCalled()
  expect(getPrDelivery(db, 'delivery')?.operation_token).toBeNull()
  expect(db.prepare('SELECT COUNT(*) AS n FROM definition_execution_claims').get()).toEqual({ n: 0 })
})
it('does not overwrite frozen allocation data on retry', () => {
  const snapshot = readIsolatedSettlementRecords(db, 'p', 'delivery')[0].snapshot
  expect(() => saveIsolatedSettlementSnapshot(db, snapshot)).not.toThrow()
  expect(() => saveIsolatedSettlementSnapshot(db, { ...snapshot, baseRepo: '/other' })).toThrow('cannot change')
})
it('preserves an acquired delivery operation and releases its execution claim on conflict', async () => {
  expect(claimPrDeliveryOperation(db, 'delivery', 'building', 'recover-and-retry', 'other')).toBe(true)
  await expect(reattachIsolatedSettlement(ctx, 'delivery', 'run', { git })).rejects.toThrow('busy')
  expect(git.run).not.toHaveBeenCalled()
  expect(getPrDelivery(db, 'delivery')?.operation_token).toBe('other')
  expect(db.prepare('SELECT COUNT(*) AS n FROM definition_execution_claims').get()).toEqual({ n: 0 })
})
it('retains evidence from every settled sibling when the last recovered run finishes', async () => {
  const snapshot = readIsolatedSettlementRecords(db, 'p', 'delivery')[0].snapshot
  const sibling = { ...run, runId: 'sibling', ticketId: 2, ticketIds: [2], ledgerId: 'sibling-mount' }
  saveIsolatedSettlementSnapshot(db, { ...snapshot, run: sibling })
  saveIsolatedSettlementResult(db, 'delivery', { run: sibling, implementationOutcome: 'succeeded', deliveryOutcome: 'ready', initialSha: 'a'.repeat(40), finalSha: 'b'.repeat(40), safeToRelease: false })
  const harvest = vi.fn(harvestDeliveryEvidence)
  await reattachIsolatedSettlement(ctx, 'delivery', 'run', { git, recordProvenance, harvestEvidence: harvest })
  expect(fixture.evidence).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['run', 'sibling']), true)
  expect(harvest.mock.calls[0][1]).toEqual(expect.arrayContaining([
    expect.objectContaining({ runId: 'run', definitionStatus: expect.objectContaining({ runId: 'run' }) }),
    expect.objectContaining({ runId: 'sibling', definitionStatus: expect.objectContaining({ runId: 'sibling' }) }),
  ]))
})
it('settles from compact terminal proof even when full evidence is unavailable', async () => {
  fixture.evidence.mockResolvedValue(new Map([['run', { ...probe(), status: 'unavailable', scopes: undefined }]]))
  await reattachIsolatedSettlement(ctx, 'delivery', 'run', { git, recordProvenance })
  expect(getPrDelivery(db, 'delivery')?.decision).toBe('on_review')
  expect(JSON.parse(getPrDelivery(db, 'delivery')!.settle_evidence!)).toMatchObject({ harvest: 'failed', units: [{ runId: 'run', runtime: null }] })
})
it('preserves the branch record for a ticketless repository leg', async () => {
  const snapshot = readIsolatedSettlementRecords(db, 'p', 'delivery')[0].snapshot
  snapshot.run.ticketId = 0; snapshot.run.ticketIds = []
  db.prepare('UPDATE definition_delivery_settlements SET snapshot_json=? WHERE delivery_id=? AND run_id=?').run(JSON.stringify(snapshot), 'delivery', 'run')
  await reattachIsolatedSettlement(ctx, 'delivery', 'run', { git, recordProvenance })
  expect(JSON.parse(getPrDelivery(db, 'delivery')!.branches)).toMatchObject([{ ticketId: 0, runId: 'run', branch: 'work', worktreePath: root }])
})
