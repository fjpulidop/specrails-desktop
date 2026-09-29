import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initDb, createJob, type DbInstance } from '../../../db'
import type { ProjectContext } from '../../../project-registry'
import { defaultGitRunner } from '../../../worktree-manager'
import { createLoopRun, saveDefinitionRun, readDefinitionRun, finishLoopRunAndJob, reconcileOrphanLoopRuns } from '../../loops/runtime/loop-runs-store'
import { probeDefinitionRun } from '../../loops/runtime/loop-definition-recovery'
import type { LoopRunRequest } from '../../loops/runtime/loop-run-manager'
import { createPrDelivery, getPrDelivery, clearOrphanedPrDeliveryOperations } from './rail-pr-store'
import { createRailWorktree } from './rail-worktrees-store'
import { saveIsolatedSettlementSnapshot, readIsolatedSettlementRecords } from './isolated-settlement-store'
import { forkDefinitionRun } from './definition-fork'
import { reattachIsolatedSettlement, type AllocatedRun } from './rail-isolated-launch'
import { getRepositoryExecutionReferences, type RunExecutionManifest } from './multi-repo-execution-store'

const retained = vi.hoisted(() => ({ cli: '' }))
vi.mock('../../agent-runtime/runtime/agent-runtime-package', () => ({ resolveRetainedAgentRuntime: () => retained.cli }))
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
let root: string | undefined, db: DbInstance | undefined
afterEach(() => { db?.close(); if (root) rmSync(root, { recursive: true, force: true }) })

it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))).each(['exception', 'process', 'historical'] as const)('forks a real Core run across two Git worktrees and recovers a %s crash between repository settlements', async crash => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'paired fork git ')))
  const databasePath = path.join(root, 'project.sqlite')
  db = initDb(databasePath)
  retained.cli = path.join(core!, 'dist/agent-runtime/cli.js')
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0); return result.stdout.trim()
  }
  const repos = ['frontend', 'backend'].map(id => {
    const sourcePath = path.join(root!, id), worktreePath = path.join(root!, `${id}-work`)
    mkdirSync(sourcePath); git(sourcePath, ['init', '-q', '-b', 'main'])
    git(sourcePath, ['config', 'user.name', 'Fork fixture']); git(sourcePath, ['config', 'user.email', 'fixture@example.invalid'])
    writeFileSync(path.join(sourcePath, 'base.txt'), 'baseline\n')
    git(sourcePath, ['add', '.']); git(sourcePath, ['commit', '-qm', 'baseline'])
    const baseSha = git(sourcePath, ['rev-parse', 'HEAD'])
    git(sourcePath, ['worktree', 'add', '-qb', 'work', worktreePath])
    return { repositoryId: id, name: id, sourcePath, gitCommonDir: path.join(sourcePath, '.git'), baseBranch: 'main', baseSha, worktreePath, branch: 'work', worktreeId: `mount-${id}` }
  })
  const manifest: RunExecutionManifest = { version: 1, groupId: 'group', projectId: 'p', primaryRepositoryId: 'frontend', artifactRepositoryId: 'frontend', selectedRepositoryIds: repos.map(repo => repo.repositoryId), repositories: repos }
  const runtime = path.join(root, '.specrails', 'pipeline', 'source'); mkdirSync(runtime, { recursive: true })
  const contextPath = path.join(runtime, 'desktop-context.json'), configPath = path.join(runtime, 'desktop-runtime-config.json'), definitionPath = path.join(runtime, 'desktop-workflow-definition.json')
  const context = { schemaVersion: 1, runId: 'source', backlogRoot: root, artifactRoot: repos[0].worktreePath, artifactRepositoryId: 'frontend', repositories: repos.map(repo => ({ id: repo.repositoryId, name: repo.name, path: repo.worktreePath })), ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Paired fork', description: 'Preserve history and settle both repositories', repositoryIds: repos.map(repo => repo.repositoryId) }] }
  writeFileSync(contextPath, JSON.stringify(context))
  writeFileSync(path.join(runtime, 'desktop-runtime-host.json'), JSON.stringify({ schemaVersion: 1, cwd: repos[0].worktreePath, env: { SPECRAILS_GIT_AUTO: 'false' } }))
  if (crash === 'process') {
    const realRetention = await vi.importActual<typeof import('../../agent-runtime/runtime/agent-runtime-package')>('../../agent-runtime/runtime/agent-runtime-package')
    realRetention.retainAgentRuntime(retained.cli, contextPath)
  } else writeFileSync(path.join(runtime, 'desktop-runtime-package.json'), JSON.stringify({ cli: retained.cli }))
  writeFileSync(configPath, readFileSync(path.join(core!, 'src/agent-runtime/engine/__fixtures__/acceptance/runtime-config.json')))
  const definition = { schemaVersion: 1, id: 'paired-fork', title: 'Paired fork', journal: 'ledger-only', change: 'none', roles: [], maxTransitions: 20, entry: 'ask', delivery: { requiresVerified: true }, nodes: {
    ask: { kind: 'question', params: { text: 'Continue?' }, ends: { next: 'write-front' } },
    'write-front': { kind: 'shell', params: { repositoryId: 'frontend', argv: [process.execPath, '-e', "require('fs').writeFileSync('change.txt','verified')"] }, ends: { ok: 'write-back', fail: 'failed', failed: 'failed' } },
    'write-back': { kind: 'shell', params: { repositoryId: 'backend', argv: [process.execPath, '-e', "require('fs').writeFileSync('change.txt','verified')"] }, ends: { ok: 'verify', fail: 'failed', failed: 'failed' } },
    verify: { kind: 'verify', params: { commands: repos.map(repo => ({ repositoryId: repo.repositoryId, command: process.execPath, args: ['-e', "require('assert').equal(require('fs').readFileSync('change.txt','utf8'),'verified')"] })) }, ends: { pass: 'done', fail: 'failed', failed: 'failed' } },
    done: { kind: 'end', params: { outcome: 'success', requiresVerified: true }, ends: {} },
    failed: { kind: 'end', params: { outcome: 'failure' }, ends: {} },
  } }
  const validate = spawnSync(process.execPath, [retained.cli, 'workflows', 'validate', '--stdin'], { input: JSON.stringify(definition), encoding: 'utf8', timeout: 90_000 })
  expect(validate.status, validate.stdout + validate.stderr).toBe(0)
  writeFileSync(definitionPath, JSON.stringify(JSON.parse(validate.stdout).definition))
  const invoke = (args: string[]) => spawnSync(process.execPath, [retained.cli, ...args], { encoding: 'utf8', timeout: 90_000 })
  const initial = invoke(['run', '--context', contextPath, '--config', configPath, '--definition', definitionPath])
  expect(initial.status, initial.stdout + initial.stderr).toBe(2)
  createLoopRun(db, { id: 'source', projectId: 'p', loopId: 'loop', ticketIds: [1], railIndex: 0, causalOwnership: true, iterationLimit: 20, startedAt: new Date().toISOString() })
  createJob(db, { id: 'source', command: 'loop: paired-git', owner: 'loop', started_at: new Date().toISOString() })
  saveDefinitionRun(db, 'source', { contextPath, definition, context, request: { runId: 'source', projectId: 'p', loopId: 'loop', cwd: repos[0].worktreePath, provider: 'claude', model: 'fixture', graph: { nodes: [], edges: [], config: {} }, executionManifest: manifest, deferTerminalOutcome: true } as LoopRunRequest })
  db.prepare('UPDATE loop_runs SET execution_manifest=? WHERE id=?').run(JSON.stringify(manifest), 'source')
  db.prepare("UPDATE loop_runs SET status='paused' WHERE id='source'").run()
  db.prepare("INSERT INTO ticket_outcome_ownership(ticket_id,owner_id,generation,claimed_at) VALUES (1,'source',1,datetime('now'))").run()
  createPrDelivery(db, { id: 'group', railIndex: 0, railKey: 'group', loopName: 'Paired', ticketIds: [1], baseBranch: 'main', originSurface: 'dashboard' })
  db.prepare('UPDATE rail_pr_deliveries SET execution_manifest=? WHERE id=?').run(JSON.stringify(manifest), 'group')
  for (const repo of repos) {
    createPrDelivery(db, { id: repo.repositoryId, parentDeliveryId: 'group', repositoryId: repo.repositoryId, repositoryPath: repo.sourcePath, railIndex: 0, railKey: repo.repositoryId, loopName: 'Paired', ticketIds: [1], baseBranch: 'main', originSurface: 'dashboard' })
    createRailWorktree(db, { id: repo.worktreeId, repositoryId: repo.repositoryId, repositoryPath: repo.sourcePath, runId: 'source', railIndex: 0, ticketId: 1, branch: repo.branch, worktreePath: repo.worktreePath })
    db.prepare('UPDATE rail_pr_deliveries SET run_ids=?,worktree_ids=? WHERE id=?').run(JSON.stringify(['source']), JSON.stringify([repo.worktreeId]), repo.repositoryId)
    const run: AllocatedRun = { ticketId: 1, ticketIds: [1], runId: 'source', ledgerId: repo.worktreeId, handle: { branch: repo.branch, worktreePath: repo.worktreePath }, initialSha: repo.baseSha, baseRef: 'main', overlayExcludes: [], overlayCleanupEvidence: [], warmLinkEvidence: [], provenanceSnapshot: null, continuationTarget: null, branchOwnership: 'created', worktreeOwnership: 'created' }
    saveIsolatedSettlementSnapshot(db, { version: 1, projectId: 'p', deliveryId: repo.repositoryId, baseRepo: repo.sourcePath, overlaySourceRoot: repo.sourcePath, overlayProviderDir: '.claude', overlayInstructions: 'CLAUDE.md', commitMessage: 'Paired implementation', partialCommitMessage: 'Partial implementation', run })
  }
  const onFinished = vi.fn(), provenance = vi.fn()
  const ctx = { db, project: { id: 'p', path: root }, loopRunManager: { isDefinitionRunActive: () => false, isDefinitionCancellationPending: () => false }, broadcast: vi.fn(), onLoopRunFinished: onFinished } as unknown as ProjectContext
  const sourceBytes = readFileSync(path.join(runtime, 'agent-workflow', 'run.sqlite')), sourceRow = readDefinitionRun(db, 'source')
  const child = await forkDefinitionRun(ctx, 'source', { requestId: 'multi-repo-fork', fromNodePath: 'ask', scopeId: 'root', visit: 1 })
  for (const repo of repos) expect(getRepositoryExecutionReferences(db, repo.repositoryId).runIds).toEqual([child.loopRunId])
  const childContext = readDefinitionRun(db, child.loopRunId)!.metadata.contextPath!
  expect(invoke(['resume', '--context', childContext]).status).toBe(2)
  const paused = await probeDefinitionRun({ db, cwd: root, env: process.env }, child.loopRunId)
  const completed = invoke(['resume', '--context', childContext, '--answer', 'Yes', '--interrupt-id', paused.pendingInterrupts[0].id])
  expect(completed.status, completed.stderr + completed.stdout).toBe(0)
  expect(await probeDefinitionRun({ db, cwd: root, env: process.env }, child.loopRunId)).toMatchObject({ status: 'succeeded', completion: { ok: true, verified: true } })
  finishLoopRunAndJob(db, child.loopRunId, { outcome: 'success', finishedAt: new Date().toISOString(), callbackOutcome: 'success', outcomeFinalized: false, counters: { iterationCount: 1, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0 }, job: { status: 'completed', exitCode: 0, totalCostUsd: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: null, tokensCacheCreate: null, durationMs: 0, numTurns: 0 } })
  if (crash === 'historical') {
    // Older records captured branches/manifests but not the complete allocation.
    for (const repo of repos) {
      const saved = readIsolatedSettlementRecords(db, 'p', repo.repositoryId).find(record => record.snapshot.run.runId === child.loopRunId)!.snapshot.run
      db.prepare('UPDATE rail_pr_deliveries SET branches=? WHERE id=?').run(JSON.stringify([{ ticketId: 1, runId: child.loopRunId,
        branch: saved.handle.branch, worktreePath: saved.handle.worktreePath, initialSha: saved.initialSha,
        branchOwnership: saved.branchOwnership, overlayExcludes: saved.overlayExcludes, succeeded: false }]), repo.repositoryId)
    }
    db.prepare('DELETE FROM definition_delivery_settlements WHERE run_id=?').run(child.loopRunId)
  }
  // The first leg commits; the next repository loses its host process boundary.
  // Retry must retain the committed leg and its provenance, then finish the group.
  let interrupted = false
  const failingGit = { run: async (args: string[], cwd: string) => {
    if (!interrupted && cwd === repos[0].worktreePath && args[0] === 'branch') { interrupted = true; throw new Error('host interrupted between repositories') }
    return defaultGitRunner.run(args, cwd)
  } }
  if (crash !== 'process') {
    await expect(reattachIsolatedSettlement(ctx, 'group', child.loopRunId, { git: failingGit, recordProvenance: provenance })).rejects.toThrow('host interrupted')
  } else {
    const worker = fileURLToPath(new URL('./__fixtures__/settlement-crash-worker.mjs', import.meta.url))
    const killed = spawnSync(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, worker, databasePath, root, child.loopRunId, repos[0].worktreePath], { encoding: 'utf8', timeout: 90_000 })
    expect(killed.stderr).toContain('desktop-settlement-crash:between-repositories')
    expect(killed.status).not.toBe(0)
    if (process.platform !== 'win32') expect(killed.signal).toBe('SIGKILL')
    expect(existsSync(path.join(root, 'premature-finish'))).toBe(false)
    db.close(); db = initDb(databasePath); ctx.db = db
    expect(db.prepare('SELECT COUNT(*) AS n FROM definition_execution_claims').get()).toEqual({ n: 1 })
    clearOrphanedPrDeliveryOperations(db)
    reconcileOrphanLoopRuns(db, new Date().toISOString())
    expect(readFileSync(path.join(root, 'child-provenance.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  }
  const firstHead = git(repos[1].worktreePath, ['rev-parse', 'HEAD'])
  expect(firstHead).not.toBe(repos[1].baseSha)
  expect(onFinished).not.toHaveBeenCalled()
  await reattachIsolatedSettlement(ctx, 'group', child.loopRunId, { recordProvenance: provenance })
  for (const repo of repos) {
    expect(getPrDelivery(db, repo.repositoryId)).toMatchObject({ decision: 'on_review', implementation_outcome: 'succeeded' })
    expect(git(repo.worktreePath, ['rev-list', '--count', 'main..HEAD'])).toBe('1')
    expect(git(repo.worktreePath, ['status', '--porcelain'])).toBe('')
  }
  expect(git(repos[1].worktreePath, ['rev-parse', 'HEAD'])).toBe(firstHead)
  expect(getPrDelivery(db, 'group')).toMatchObject({ decision: 'on_review', implementation_outcome: 'succeeded' })
  expect(provenance).toHaveBeenCalledTimes(crash === 'process' ? 1 : 2)
  expect(db.prepare('SELECT SUM(provenance_recorded) AS n FROM definition_delivery_settlements WHERE run_id=?').get(child.loopRunId)).toEqual({ n: 2 })
  expect(onFinished).toHaveBeenCalledWith(child.loopRunId, 'success', { ticketCompletionStatus: 'on_review' })
  expect(readDefinitionRun(db, 'source')).toEqual(sourceRow)
  if (crash === 'historical') for (const repo of repos) {
    const record = readIsolatedSettlementRecords(db, 'p', repo.repositoryId).find(item => item.snapshot.run.runId === child.loopRunId)!
    expect(record.snapshot.reconstructedFrom).toBe('durable-branch-records')
    expect(record.result?.run).toMatchObject({ automaticRelease: false, settlementIgnoredPaths: null })
    expect(record.result?.safeToRelease).toBe(false)
  }
  expect(readFileSync(path.join(runtime, 'agent-workflow', 'run.sqlite'))).toEqual(sourceBytes)
}, 180_000)
