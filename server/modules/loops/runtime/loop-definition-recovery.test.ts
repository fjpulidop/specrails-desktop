import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initDb, type DbInstance } from '../../../db'
import { createLoopRun, saveDefinitionRun } from './loop-runs-store'
import { probeDefinitionRun, probeDefinitionRuns, toDefinitionStates } from './loop-definition-recovery'
import type { LoopRunRequest } from './loop-run-manager'
import { runAgentRuntimeControl } from '../../agent-runtime/runtime/agent-runtime-bridge'

const retained = vi.hoisted(() => ({ cli: '' }))
vi.mock('../../agent-runtime/runtime/agent-runtime-package', () => ({ resolveRetainedAgentRuntime: () => retained.cli }))
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
let db: DbInstance, directory: string, contextPath: string
const status = () => ({ type: 'runtime-status', engineVersion: 2, revision: 7, eventCursor: 12, completion: null,
  state: { runId: 'run', status: 'paused', lease: null, recoverableSteps: [], pendingInterrupts: [{ id: 'q1', nodePath: 'ask', kind: 'question' }] } })
beforeEach(() => {
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'definition-probe-')))
  db = initDb(':memory:')
  const pipeline = path.join(directory, '.specrails/pipeline/run'); mkdirSync(pipeline, { recursive: true })
  contextPath = path.join(pipeline, 'desktop-context.json')
  writeFileSync(contextPath, JSON.stringify({ runId: 'run', backlogRoot: directory, artifactRoot: directory, repositories: [{ id: 'repo', path: directory }] }))
  writeFileSync(path.join(pipeline, 'desktop-runtime-host.json'), JSON.stringify({ schemaVersion: 1, cwd: directory, env: { SPECRAILS_GIT_AUTO: 'false', SPECRAILS_REPO_DIR: directory } }))
  createLoopRun(db, { id: 'run', projectId: 'p1', loopId: 'loop', iterationLimit: 4, startedAt: new Date().toISOString() })
  saveDefinitionRun(db, 'run', { contextPath, request: { runId: 'run', projectId: 'p1', loopId: 'loop', cwd: directory, graph: { nodes: [], edges: [], config: { maxIterations: 4, timeoutMinutes: 0 } }, provider: 'claude', model: 'test' } as LoopRunRequest })
  retained.cli = path.join(directory, 'runtime.cjs')
})
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
function respond(value: unknown) {
  writeFileSync(retained.cli, `require('node:assert/strict').deepEqual(process.argv.slice(2),['status','--context',${JSON.stringify(contextPath)},'--compact']);require('node:assert/strict').equal(process.env.SPECRAILS_GIT_AUTO,'false');process.stdout.write(${JSON.stringify(JSON.stringify(value))})`)
}
const ctx = () => ({ db, cwd: directory, env: { ...process.env, SPECRAILS_GIT_AUTO: 'true' } })

it('probes only retained status with frozen host and preserves the durable cursor', async () => {
  respond(status())
  const prior = db.prepare('SELECT * FROM loop_runs').all()
  const result = await probeDefinitionRun(ctx(), 'run')
  expect(result).toMatchObject({ status: 'paused', resumable: true, lease: null, coreRevision: 7, eventCursor: 12, pendingInterrupts: [{ id: 'q1' }] })
  expect(db.prepare('SELECT * FROM loop_runs').all()).toEqual(prior)
})

it('takes active lease and exact recoverable attempt identity from Core', async () => {
  const lease = { owner: 'other', epoch: 2, expiresAt: Date.now() + 60_000, active: true }
  respond({ ...status(), state: { ...status().state, status: 'running', lease, recoverableSteps: [{ attemptId: 'physical-7', nodePath: 'work', scopeId: 'root' }] } })
  expect(await probeDefinitionRun(ctx(), 'run')).toMatchObject({ resumable: false, lease, recoverableSteps: [{ attemptId: 'physical-7', nodePath: 'work', scopeId: 'root' }] })
})

it('preserves unavailable and completed work for explicit settlement instead of marking it failed', async () => {
  respond({ ...status(), state: { ...status().state, runId: 'foreign' } })
  const unavailable = await probeDefinitionRun(ctx(), 'run')
  expect(unavailable).toMatchObject({ status: 'unavailable', resumable: false })
  expect(toDefinitionStates(new Map([['run', unavailable]])).get('run')).toMatchObject({ status: 'interrupted', coreStatus: 'unavailable' })
  respond({ ...status(), completion: { ok: true, verified: true, reasons: [] }, state: { ...status().state, status: 'succeeded', pendingInterrupts: [] } })
  const completed = await probeDefinitionRun(ctx(), 'run')
  expect(completed).toMatchObject({ status: 'succeeded', resumable: false, completion: { ok: true } })
  expect(toDefinitionStates(new Map([['run', completed]])).get('run')).toMatchObject({ status: 'interrupted', coreStatus: 'succeeded', completion: { ok: true } })
})

it('fails closed for corrupt output and missing runs and deduplicates batch probes', async () => {
  writeFileSync(retained.cli, 'process.stdout.write("not-json")')
  expect(await probeDefinitionRun(ctx(), 'run')).toMatchObject({ status: 'unavailable' })
  respond(status())
  const results = await probeDefinitionRuns(ctx(), ['run', 'run', 'missing'])
  expect(results.size).toBe(2)
  expect(results.get('run')?.status).toBe('paused')
  expect(results.get('missing')?.status).toBe('unavailable')
})

const pairedCore = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
it.skipIf(!pairedCore || !existsSync(path.join(pairedCore, 'dist/agent-runtime/cli.js')))('reads an actual paused Core definition through the shared status contract', async () => {
  retained.cli = path.join(pairedCore!, 'dist/agent-runtime/cli.js')
  expect(spawnSync('git', ['init', '-q', directory]).status).toBe(0)
  writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: 'run', backlogRoot: directory, artifactRoot: directory, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: directory }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 'case', title: 'Probe', description: 'Provider-free continuation' }] }))
  const fixture = path.join(pairedCore!, 'src/agent-runtime/engine/__fixtures__/acceptance')
  const result = spawnSync(process.execPath, [retained.cli, 'run', '--context', contextPath, '--config', path.join(fixture, 'runtime-config.json'), '--definition', path.join(fixture, 'question-flow.json')], { encoding: 'utf8', timeout: 30_000 })
  expect(result.status, result.stderr + result.stdout).toBe(2)
  expect(await probeDefinitionRun(ctx(), 'run')).toMatchObject({ engineVersion: 2, status: 'paused', resumable: true, lease: null, pendingInterrupts: [{ nodePath: 'ask', kind: 'question' }] })
  const runtimeDirectory = path.dirname(contextPath)
  writeFileSync(path.join(runtimeDirectory, 'desktop-runtime-config.json'), readFileSync(path.join(fixture, 'runtime-config.json')))
  writeFileSync(path.join(runtimeDirectory, 'desktop-workflow-definition.json'), readFileSync(path.join(fixture, 'question-flow.json')))
  // Package resolution is the injected seam; control verbs still execute the
  // actual paired CLI, including its frozen request and checkpoint validation.
  writeFileSync(path.join(runtimeDirectory, 'desktop-runtime-package.json'), JSON.stringify({ cli: retained.cli }))
  const sourceBytes = readFileSync(path.join(runtimeDirectory, 'agent-workflow/run.sqlite'))
  const controls = { runId: 'run', contextPath, cwd: directory, env: process.env }
  const fork = await runAgentRuntimeControl({ ...controls, kind: 'fork', childRunId: 'child', fromNodePath: 'ask' })
  expect(fork).toMatchObject({ kind: 'fork', runId: 'child', forkOf: 'run', fromNodePath: 'ask' })
  expect(readFileSync(path.join(runtimeDirectory, 'agent-workflow/run.sqlite'))).toEqual(sourceBytes)
  expect(JSON.parse(readFileSync(fork.contextPath, 'utf8')).runId).toBe('child')
  const receipt = await runAgentRuntimeControl({ ...controls, kind: 'cancel', requestId: 'cancel-probe' })
  expect(receipt).toMatchObject({ kind: 'cancel', requestId: 'cancel-probe', accepted: { requestId: 'cancel-probe' } })
  expect((await runAgentRuntimeControl({ ...controls, kind: 'cancel', requestId: 'cancel-probe' })).accepted).toEqual(receipt.accepted)
  expect(await probeDefinitionRun(ctx(), 'run')).toMatchObject({ status: 'cancelled', resumable: false, lease: null })
})
