import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createJob, initDb, type DbInstance } from '../../../db'
import { createLoopRun, claimDefinitionExecution, readDefinitionExecutionClaim } from '../../loops/runtime/loop-runs-store'
import { AgentRuntimeControls } from './agent-runtime-controls'
import { readRuntimeExpiration } from './agent-runtime-retention-records'
import { runtimeJournalQuarantine } from './agent-runtime-retention-quarantine'
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

function addRun(runId: string, finishedAt: string, outcome = 'success') {
  const run = path.join(root, '.specrails/pipeline', runId); fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'desktop-context.json'), JSON.stringify({ runId, backlogRoot: root, artifactRoot: root, repositories: [{ id: 'repo', name: 'Repo', path: root }] }))
  fs.writeFileSync(path.join(run, 'desktop-runtime-host.json'), JSON.stringify({ schemaVersion: 1, cwd: root, env: {} }))
  fs.writeFileSync(path.join(run, 'agent-runtime-request.json'), '{}')
  createJob(db, { id: runId, command: 'loop:fixture', started_at: '2000-01-01T00:00:00Z', owner: 'loop' })
  createLoopRun(db, { id: runId, projectId: 'project', loopId: 'fixture', iterationLimit: 1, startedAt: '2000-01-01T00:00:00Z' })
  db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(runId)
  db.prepare("UPDATE loop_runs SET status='completed',final_outcome=?,finished_at=? WHERE id=?").run(outcome, finishedAt, runId)
  return run
}
const runStatus = (overrides: Record<string, unknown> = {}) => (file: string) => Promise.resolve({ ...terminal(), runId: path.basename(path.dirname(file)), ...overrides })
const delivery = (decision: string, token: string | null = null, runIds = ['run']) =>
  db.prepare("INSERT INTO rail_pr_deliveries(id,rail_index,rail_key,ticket_ids,base_branch,decision,run_ids,operation_token) VALUES (?,0,'rail','[]','main',?,?,?)").run(`delivery-${decision}-${token}`, decision, JSON.stringify(runIds), token)
const fork = (source: string, child: string, adopted: 0 | 1) =>
  db.prepare("INSERT INTO definition_fork_operations(project_id,source_run_id,request_id,child_run_id,request_json,adopted) VALUES ('project',?,?,?,'{}',?)").run(source, `request-${child}`, child, adopted)

describe('host delivery, lineage and restart ownership', () => {
  it.each(['building', 'on_review', 'pr_draft', 'pr_ready', 'pr_failed', 'implementation_failed'])('protects history while delivery is %s', async decision => {
    controls.configureRetention({ days: 1 }); delivery(decision)
    expect(await controls.collectRetention({ dryRun: false })).toMatchObject({ runs: [{ state: 'protected', reasons: expect.arrayContaining(['delivery_pending']) }] })
    expect(fs.existsSync(directory)).toBe(true)
  })
  it('protects a delivery whose terminal decision still owns an in-flight operation', async () => {
    controls.configureRetention({ days: 1 }); delivery('merged', 'operation')
    expect(await controls.collectRetention({ dryRun: false })).toMatchObject({ runs: [{ state: 'protected', reasons: ['delivery_pending'] }] })
  })
  it('expires a discarded failed run as discarded history and keeps merged successful runs settled', async () => {
    controls.configureRetention({ days: 1 })
    db.prepare("UPDATE loop_runs SET final_outcome='failure' WHERE id='run'").run(); delivery('discarded')
    status.mockResolvedValue({ ...terminal(), status: 'failed' })
    expect(await controls.collectRetention({ dryRun: false })).toMatchObject({ runs: [{ state: 'expired' }] })
    expect(readRuntimeExpiration(db, 'run')).toMatchObject({ disposition: 'discarded', previousStatus: 'failed' })
  })
  it('keeps a failed run without a discard decision as recoverable history', async () => {
    controls.configureRetention({ days: 1 })
    db.prepare("UPDATE loop_runs SET final_outcome='failure' WHERE id='run'").run()
    status.mockResolvedValue({ ...terminal(), status: 'failed' })
    expect(await controls.collectRetention({ dryRun: false })).toMatchObject({ runs: [{ state: 'protected', reasons: ['recoverable'] }] })
  })
  it('protects a parent while an unexpired fork child exists and expires the child first', async () => {
    controls.configureRetention({ days: 1 }); status.mockImplementation(runStatus())
    const child = addRun('child', new Date().toISOString()); fork('run', 'child', 0)
    expect(await controls.collectRetention({ dryRun: false })).toMatchObject({ runs: expect.arrayContaining([
      expect.objectContaining({ runId: 'child', state: 'protected', reasons: ['within_retention'] }),
      // The lineage fence refuses the reservation before Core is inspected;
      // fork_pending evidence is a second, independent guard.
      expect.objectContaining({ runId: 'run', state: 'busy' })]) })
    expect(fs.existsSync(directory)).toBe(true)
    db.prepare("UPDATE loop_runs SET finished_at='2000-01-03 00:00:00' WHERE id='child'").run()
    const report = await controls.collectRetention({ dryRun: false })
    expect(report.runs.map(run => [run.runId, run.state])).toEqual([['child', 'expired'], ['run', 'expired']])
    expect(fs.existsSync(child)).toBe(false); expect(fs.existsSync(directory)).toBe(false)
  })
  it('does not reserve a parent whose adopted successor still owns its lineage', async () => {
    controls.configureRetention({ days: 1 }); status.mockImplementation(runStatus())
    addRun('child', new Date().toISOString()); fork('run', 'child', 1)
    const report = await controls.collectRetention({ dryRun: false })
    expect(report.runs).toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'run', state: 'busy' })]))
    expect(fs.existsSync(directory)).toBe(true)
  })
  it('restores an interrupted unexpired quarantine when the project controller restarts', async () => {
    await runtimeJournalQuarantine(db, path.dirname(directory), { runId: 'run', expiredAt: '2026-09-28T00:00:00Z', disposition: 'settled', previousStatus: 'succeeded', summary: {} }).quarantine()
    expect(fs.existsSync(directory)).toBe(false)
    const restarted = new AgentRuntimeControls({ project: { id: 'project', path: root }, db } as Pick<ProjectContext, 'project' | 'db'>, { status, execute, kill })
    try { expect(fs.readFileSync(path.join(directory, 'evidence'), 'utf8')).toBe('original evidence') } finally { restarted.shutdown() }
  })
  it('finishes an expired quarantine on restart but leaves one owned by another live claim', async () => {
    const store = runtimeJournalQuarantine(db, path.dirname(directory), { runId: 'run', expiredAt: '2026-09-28T00:00:00Z', disposition: 'settled', previousStatus: 'succeeded', summary: {} })
    const { token } = await store.quarantine(); await store.expire(token)
    const quarantine = path.join(path.dirname(directory), '.retention', token)
    // A live collector in another process owns the run: no heuristic takes over.
    db.prepare("INSERT INTO definition_execution_claims(run_id,owner,repository_mounts_json) VALUES ('run','retention:other','[]')").run()
    new AgentRuntimeControls({ project: { id: 'project', path: root }, db } as Pick<ProjectContext, 'project' | 'db'>, { status, execute, kill }).shutdown()
    expect(fs.existsSync(quarantine)).toBe(true)
    db.prepare("DELETE FROM definition_execution_claims WHERE run_id='run'").run()
    new AgentRuntimeControls({ project: { id: 'project', path: root }, db } as Pick<ProjectContext, 'project' | 'db'>, { status, execute, kill }).shutdown()
    expect(fs.existsSync(quarantine)).toBe(false); expect(readRuntimeExpiration(db, 'run')).toMatchObject({ quarantineToken: token })
  })
})
