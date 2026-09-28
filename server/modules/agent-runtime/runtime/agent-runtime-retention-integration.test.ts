import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createJob, initDb, type DbInstance } from '../../../db'
import { createLoopRun, claimDefinitionExecution, readDefinitionExecutionClaim } from '../../loops/runtime/loop-runs-store'
import { AgentRuntimeControls } from './agent-runtime-controls'
import { readRuntimeExpiration } from './agent-runtime-retention-records'
import type { ProjectContext } from '../../../project-registry'
vi.mock('../../../workspace-resolution', () => ({ resolveProjectExecution: (project: { path: string }) => ({ specrailsDir: path.join(project.path, '.specrails') }), resolveLoopBaseEnv: () => ({}) }))
let root: string, directory: string, db: DbInstance, controls: AgentRuntimeControls
const status = vi.fn(), execute = vi.fn(), kill = vi.fn()
const terminal = () => ({ runId: 'run', engineVersion: 2, status: 'succeeded', nextStep: null, lease: null, pendingInterrupts: [], recoverableSteps: [], steps: { work: { status: 'succeeded' } } })
beforeEach(() => {
  vi.clearAllMocks(); root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retention host ')))
  directory = path.join(root, '.specrails/pipeline/run'); fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'desktop-context.json'), JSON.stringify({ runId: 'run', backlogRoot: root, artifactRoot: root, repositories: [{ id: 'repo', name: 'Repo', path: root }] }))
  fs.writeFileSync(path.join(directory, 'desktop-runtime-host.json'), JSON.stringify({ schemaVersion: 1, cwd: root, env: {} }))
  fs.writeFileSync(path.join(directory, 'agent-runtime-request.json'), '{}')
  fs.writeFileSync(path.join(directory, 'evidence'), 'original evidence')
  db = initDb(':memory:')
  createJob(db, { id: 'run', command: 'loop:fixture', started_at: '2000-01-01T00:00:00Z', owner: 'loop' })
  createLoopRun(db, { id: 'run', projectId: 'project', loopId: 'fixture', iterationLimit: 1, startedAt: '2000-01-01T00:00:00Z' })
  db.prepare("UPDATE jobs SET status='completed' WHERE id='run'").run()
  db.prepare("UPDATE loop_runs SET status='completed',final_outcome='success',finished_at='2000-01-02 00:00:00' WHERE id='run'").run()
  status.mockResolvedValue(terminal())
  const context = { project: { id: 'project', path: root }, db } as Pick<ProjectContext, 'project' | 'db'>
  controls = new AgentRuntimeControls(context, { status, execute, kill })
})
afterEach(() => { controls.shutdown(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
it('defaults to indefinite retention without inspecting or mutating Core', async () => {
  expect(controls.retentionPolicy()).toEqual({ days: null })
  expect(await controls.collectRetention({})).toMatchObject({ dryRun: true, runs: [{ state: 'protected', reasons: ['disabled'] }] })
  expect(status).not.toHaveBeenCalled(); expect(fs.existsSync(directory)).toBe(true)
})
it('previews then expires settled history while preserving job accounting and explicit history state', async () => {
  controls.configureRetention({ days: 30 })
  expect(await controls.collectRetention({})).toMatchObject({ runs: [{ state: 'eligible' }] })
  expect(fs.existsSync(directory)).toBe(true); expect(readRuntimeExpiration(db, 'run')).toBeNull()
  expect(await controls.collectRetention({ dryRun: false })).toMatchObject({ runs: [{ state: 'expired' }], errors: [] })
  expect(fs.existsSync(directory)).toBe(false)
  expect(db.prepare('SELECT status FROM jobs WHERE id=?').get('run')).toEqual({ status: 'completed' })
  expect(await controls.summary('run')).toMatchObject({ status: 'expired', historical: true, canResume: false, canCancel: false })
  expect(await controls.list()).toEqual([expect.objectContaining({ runId: 'run', status: 'expired' })])
  await expect(controls.resume('run', {})).rejects.toMatchObject({ statusCode: 410, code: 'runtime_history_expired' })
  expect(execute).not.toHaveBeenCalled()
  expect(claimDefinitionExecution(db, 'run', { owner: 'resume', repositoryMounts: [root] })).toMatchObject({ ok: false, reason: 'expired' })
})
it.each([
  [{ lease: { active: true } }, 'active'], [{ lease: undefined }, 'active'],
  [{ pendingInterrupts: [{ id: 'human' }] }, 'human_pending'], [{ pendingInterrupts: undefined }, 'human_pending'],
  [{ recoverableSteps: [{ attemptId: 'write' }] }, 'interrupted_writes'], [{ recoverableSteps: undefined }, 'interrupted_writes'],
] as const)('protects unresolved Core authority %j', async (fields, reason) => {
  controls.configureRetention({ days: 1 }); status.mockResolvedValue({ ...terminal(), ...fields })
  expect(await controls.collectRetention({ dryRun: false })).toMatchObject({ runs: [{ state: 'protected', reasons: expect.arrayContaining([reason]) }] })
  expect(fs.readFileSync(path.join(directory, 'evidence'), 'utf8')).toBe('original evidence')
})
it('holds the execution reservation through inspection and rejects a concurrent resume', async () => {
  controls.configureRetention({ days: 30 })
  let finish!: (state: ReturnType<typeof terminal>) => void
  status.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const collecting = controls.collectRetention({ dryRun: false })
  await vi.waitFor(() => expect(readDefinitionExecutionClaim(db, 'run')?.owner).toMatch(/^retention:/))
  await expect(controls.resume('run', {})).rejects.toMatchObject({ statusCode: 409, code: 'runtime_retention_busy' })
  finish(terminal())
  expect(await collecting).toMatchObject({ runs: [{ state: 'expired' }] })
  expect(readDefinitionExecutionClaim(db, 'run')).toBeUndefined(); expect(execute).not.toHaveBeenCalled()
})
it('restores journal bytes and releases admission if expiration cannot commit', async () => {
  controls.configureRetention({ days: 30 })
  db.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON runtime_retention_records BEGIN SELECT RAISE(ABORT, 'cannot commit'); END")
  expect(await controls.collectRetention({ dryRun: false })).toMatchObject({ runs: [{ state: 'error', error: 'cannot commit' }] })
  expect(fs.readFileSync(path.join(directory, 'evidence'), 'utf8')).toBe('original evidence')
  expect(readRuntimeExpiration(db, 'run')).toBeNull(); expect(readDefinitionExecutionClaim(db, 'run')).toBeUndefined()
})
it('does not steal an existing execution reservation or invoke Core under it', async () => {
  controls.configureRetention({ days: 1 })
  const claim = claimDefinitionExecution(db, 'run', { owner: 'active-process', repositoryMounts: [root] })
  if (!claim.ok) throw Error('Fixture could not reserve')
  try { expect(await controls.collectRetention({ dryRun: false })).toMatchObject({ runs: [{ state: 'busy' }] }); expect(status).not.toHaveBeenCalled() }
  finally { claim.release() }
  expect(fs.existsSync(directory)).toBe(true)
})
it('rejects destructive shortcuts and malformed policies', async () => {
  expect(() => controls.configureRetention({ days: 0 })).toThrow('Retention days')
  await expect(controls.collectRetention({ force: true })).rejects.toMatchObject({ statusCode: 400 })
  expect(controls.retentionPolicy()).toEqual({ days: null })
})
