import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopExecutors } from './loop-run-manager'
import { createLoopRun } from './loop-runs-store'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())
const executors = (): LoopExecutors => ({ runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() })

describe('LoopRunManager.listProcessRoots', () => {
  it('lists live run children labelled by rail, loop and ticket, falling back to the run id', () => {
    createLoopRun(db, { id: 'r1', projectId: 'p1', loopId: 'implement', loopName: 'Implement', railIndex: 1, ticketId: 42, iterationLimit: 3, startedAt: '2026-11-18T00:00:00Z' })
    createLoopRun(db, { id: 'r2', projectId: 'p1', loopId: 'review', iterationLimit: 3, startedAt: '2026-11-18T00:00:00Z' })
    const manager = new LoopRunManager(db, () => {}, executors())
    const internals = manager as unknown as { _activeChild: Map<string, { pid?: number }>; _interactiveSteps: Map<string, { processPid(): number | null }> }
    internals._activeChild.set('r1', { pid: 501 })
    internals._activeChild.set('r2', { pid: undefined })
    internals._interactiveSteps.set('r2', { processPid: () => 502 })
    internals._interactiveSteps.set('ghost', { processPid: () => null })
    internals._activeChild.set('unknown', { pid: 503 })
    expect(manager.listProcessRoots()).toEqual([
      { runId: 'r1', pid: 501, label: 'Rail 2 · Implement · #42' },
      { runId: 'unknown', pid: 503, label: 'unknown' },
      { runId: 'r2', pid: 502, label: 'review' },
    ])
  })
})
