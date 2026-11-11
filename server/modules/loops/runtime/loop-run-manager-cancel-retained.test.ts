// Stop on a Core run this process does not drive (paused, or recovered after a
// restart): the manager hands it to the composition's full cancellation, which
// records it in Core AND settles it here. Only telling Core left the run
// "paused" forever over a run Core had already cancelled.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, initDb, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopExecutors, type LoopRunRequest } from './loop-run-manager'
import { createLoopRun, saveDefinitionRun } from './loop-runs-store'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())

function retained(id: string): void {
  createLoopRun(db, { id, projectId: 'project', loopId: 'workflow', iterationLimit: 4, startedAt: '2026-11-11T10:00:00Z' })
  createJob(db, { id, command: 'loop: workflow', owner: 'loop', started_at: '2026-11-11T10:00:00Z' })
  const request: LoopRunRequest = { runId: id, projectId: 'project', loopId: 'workflow', cwd: '/repo', provider: 'fixture', model: 'fixture',
    graph: { nodes: [{ id: 'done', type: 'core', position: { x: 0, y: 0 }, data: { kind: 'end', params: { outcome: 'success' } } }], edges: [], config: { maxIterations: 4, timeoutMinutes: 0 } } }
  saveDefinitionRun(db, id, { request, contextPath: '/runtime/context.json' })
  db.prepare("UPDATE loop_runs SET status='paused' WHERE id=?").run(id)
}

describe('LoopRunManager.cancel on a retained Core run', () => {
  it('hands a run no traversal of this process drives to the full cancellation', () => {
    retained('run')
    const cancelRetained = vi.fn()
    const cancelDefinition = vi.fn(async () => {})
    const manager = new LoopRunManager(db, () => {}, { cancelDefinition } as unknown as LoopExecutors, undefined, { cancelRetained })
    manager.cancel('run')
    expect(cancelRetained).toHaveBeenCalledWith('run')
    expect(cancelDefinition).not.toHaveBeenCalled()
  })

  it('without the composition hook, still tells Core', () => {
    retained('run')
    const cancelDefinition = vi.fn(async () => {})
    const manager = new LoopRunManager(db, () => {}, { cancelDefinition } as unknown as LoopExecutors)
    manager.cancel('run')
    expect(cancelDefinition).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run', contextPath: '/runtime/context.json' }))
  })
})
