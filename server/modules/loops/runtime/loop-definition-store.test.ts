import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createJob, getJob, initDb, type DbInstance } from '../../../db'
import { applyMigrations } from '../../../db/migrations'
import type { LoopRunRequest } from './loop-run-manager'
import { createLoopRun, getLoopRun, listPendingLoopTerminalRecoveries, markDefinitionRestart, readDefinitionRun, reconcileOrphanLoopRuns, recordDefinitionCheckpoint, saveDefinitionRun } from './loop-runs-store'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())
function launch(id = 'run'): LoopRunRequest {
  createLoopRun(db, { id, projectId: 'project', loopId: 'workflow', iterationLimit: 4, startedAt: '2026-09-26T10:00:00Z' })
  createJob(db, { id, command: 'loop: workflow', owner: 'loop', started_at: '2026-09-26T10:00:00Z' })
  return { runId: id, projectId: 'project', loopId: 'workflow', cwd: '/repo', provider: 'fixture', model: 'fixture',
    graph: { nodes: [{ id: 'done', type: 'core', position: { x: 0, y: 0 }, data: { kind: 'end', params: { outcome: 'success' } } }], edges: [], config: { maxIterations: 4, timeoutMinutes: 0 } } }
}
describe('frozen definition launch storage', () => {
  it('appends migration 64 without assigning an engine or request to historical runs', () => {
    launch('legacy'); applyMigrations(db)
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 64 })
    expect(getLoopRun(db, 'legacy')).toMatchObject({ engine_version: null, run_request_json: null, fork_of: null })
    expect(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=64').get()).toEqual({ n: 1 })
  })
  it('freezes JSON launch inputs and augments only previously missing preparation fields', () => {
    const request = launch()
    saveDefinitionRun(db, 'run', { request }); request.model = 'edited'
    expect(readDefinitionRun(db, 'run')?.request.model).toBe('fixture')
    saveDefinitionRun(db, 'run', { definitionHash: 'a'.repeat(64), contextPath: '/backlog/run/desktop-context.json', workflowId: 'workflow' })
    saveDefinitionRun(db, 'run', { definitionHash: 'a'.repeat(64) })
    expect(() => saveDefinitionRun(db, 'run', { request })).toThrow('cannot change')
    expect(() => saveDefinitionRun(db, 'run', { definitionHash: 'b'.repeat(64) })).toThrow('cannot change')
    expect(() => saveDefinitionRun(db, 'run', { runtimeIdentity: { invalid: () => {} } })).toThrow('only JSON')
    expect(readDefinitionRun(db, 'run')?.metadata.definitionHash).toBe('a'.repeat(64))
  })
  it('keeps monotonic Core cursors and preserves the job and ownership during restart', () => {
    saveDefinitionRun(db, 'run', { request: launch() })
    const job = getJob(db, 'run')
    recordDefinitionCheckpoint(db, 'run', { revision: 12, eventCursor: 9, status: 'paused', pendingInterrupts: [{ id: 'human' }] })
    recordDefinitionCheckpoint(db, 'run', { revision: 11, eventCursor: 8, status: 'running' })
    expect(getLoopRun(db, 'run')).toMatchObject({ core_revision: 12, core_event_cursor: 9 })
    markDefinitionRestart(db, 'run', { revision: 12, eventCursor: 9, status: 'paused' })
    expect(getLoopRun(db, 'run')).toMatchObject({ status: 'paused', restart_reason: 'restart', final_outcome: null, finished_at: null })
    expect(getJob(db, 'run')).toEqual(job)
    expect(listPendingLoopTerminalRecoveries(db)).toHaveLength(0)
  })
  it('retains resumable v2 runs while preserving terminal recovery for legacy and missing checkpoints', () => {
    launch('legacy')
    for (const id of ['paused', 'write', 'missing']) saveDefinitionRun(db, id, { request: launch(id) })
    reconcileOrphanLoopRuns(db, '2026-09-26T11:00:00Z', undefined, new Map([
      ['paused', { status: 'paused', revision: 2 }], ['write', { status: 'interrupted', recoverableSteps: [{ attemptId: 'write-1' }] }], ['missing', null],
    ]))
    expect(getLoopRun(db, 'paused')?.status).toBe('paused'); expect(getLoopRun(db, 'write')?.status).toBe('paused')
    expect(getJob(db, 'paused')?.status).toBe('running')
    expect(getLoopRun(db, 'legacy')?.final_outcome).toBe('failed'); expect(getLoopRun(db, 'missing')?.final_outcome).toBe('failed')
    expect(listPendingLoopTerminalRecoveries(db).map(row => row.run_id).sort()).toEqual(['legacy', 'missing'])
  })
})
