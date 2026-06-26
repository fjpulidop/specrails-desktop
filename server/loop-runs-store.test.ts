import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import {
  createLoopRun,
  updateLoopRunCounters,
  finishLoopRun,
  getLoopRun,
  listLoopRuns,
  countRunningForLoop,
  reconcileOrphanLoopRuns,
} from './loop-runs-store'

let db: DbInstance

beforeEach(() => {
  db = initDb(':memory:')
})

function create(id: string, over: Partial<Parameters<typeof createLoopRun>[1]> = {}) {
  return createLoopRun(db, {
    id,
    projectId: 'p1',
    loopId: 'loop-1',
    loopName: 'Ship & Verify',
    railIndex: 1,
    ticketId: 42,
    provider: 'claude',
    model: 'sonnet',
    reasoningEffort: 'high',
    iterationLimit: 10,
    startedAt: '2026-06-24T10:00:00.000Z',
    ...over,
  })
}

describe('loop-runs-store', () => {
  it('creates a running loop run', () => {
    const run = create('r1')
    expect(run.status).toBe('running')
    expect(run.final_outcome).toBeNull()
    expect(run.iteration_count).toBe(0)
    expect(run.iteration_limit).toBe(10)
    expect(run.ticket_id).toBe(42)
    expect(run.reasoning_effort).toBe('high')
  })

  it('updates counters absolutely', () => {
    create('r1')
    updateLoopRunCounters(db, 'r1', { iterationCount: 3, totalCostUsd: 0.42, totalTokens: 1200 })
    const run = getLoopRun(db, 'r1')!
    expect(run.iteration_count).toBe(3)
    expect(run.total_cost_usd).toBeCloseTo(0.42)
    expect(run.total_tokens).toBe(1200)
    expect(run.total_duration_ms).toBe(0) // untouched
  })

  it('updateLoopRunCounters is a no-op with no fields', () => {
    create('r1')
    updateLoopRunCounters(db, 'r1', {})
    expect(getLoopRun(db, 'r1')!.iteration_count).toBe(0)
  })

  it('finishes a run with an outcome + final counters', () => {
    create('r1')
    const finished = finishLoopRun(db, 'r1', {
      outcome: 'success',
      finishedAt: '2026-06-24T10:05:00.000Z',
      counters: { iterationCount: 4, totalCostUsd: 1.5 },
    })!
    expect(finished.status).toBe('completed')
    expect(finished.final_outcome).toBe('success')
    expect(finished.finished_at).toBe('2026-06-24T10:05:00.000Z')
    expect(finished.iteration_count).toBe(4)
  })

  it('lists runs most-recent first', () => {
    create('r1', { startedAt: '2026-06-24T10:00:00.000Z' })
    create('r2', { startedAt: '2026-06-24T11:00:00.000Z' })
    expect(listLoopRuns(db, 'p1').map((r) => r.id)).toEqual(['r2', 'r1'])
  })

  it('counts only currently-running rows for a loop (the global guard)', () => {
    create('r1', { loopId: 'loop-A' })
    create('r2', { loopId: 'loop-A' })
    create('r3', { loopId: 'loop-B' })
    expect(countRunningForLoop(db, 'loop-A')).toBe(2)
    finishLoopRun(db, 'r1', { outcome: 'success', finishedAt: '2026-06-24T10:05:00.000Z' })
    expect(countRunningForLoop(db, 'loop-A')).toBe(1)
    expect(countRunningForLoop(db, 'loop-B')).toBe(1)
    expect(countRunningForLoop(db, 'loop-Z')).toBe(0)
  })

  it('reconciles orphan running runs to terminal (unwedges edit/publish after a restart)', () => {
    create('r1', { loopId: 'loop-A' }) // orphan running
    create('r2', { loopId: 'loop-A' }) // orphan running
    finishLoopRun(db, 'r2', { outcome: 'success', finishedAt: '2026-06-24T10:05:00.000Z' }) // already terminal
    expect(countRunningForLoop(db, 'loop-A')).toBe(1) // only r1 still running

    const n = reconcileOrphanLoopRuns(db, '2026-06-24T12:00:00.000Z')
    expect(n).toBe(1) // only the still-running r1 reconciled
    expect(countRunningForLoop(db, 'loop-A')).toBe(0)
    const r1 = getLoopRun(db, 'r1')!
    expect(r1.status).toBe('completed')
    expect(r1.final_outcome).toBe('failed')
    expect(r1.finished_at).toBe('2026-06-24T12:00:00.000Z')
    // A second pass is a no-op (nothing left running).
    expect(reconcileOrphanLoopRuns(db, '2026-06-24T13:00:00.000Z')).toBe(0)
  })
})
