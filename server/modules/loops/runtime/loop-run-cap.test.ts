import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopExecutors, type LoopRunRequest } from './loop-run-manager'
import { getLoopRun, readLoopRunCap } from './loop-runs-store'
import type { LoopGraph } from './loop-graph'
import type { WsMessage } from '../../../types'

// CD5: the per-run soft cap ("pause and ask at $X") parks a run on the same
// resumable budget_paused pause; the person answers with Continue or Raise.

let db: DbInstance
let broadcasts: WsMessage[]
beforeEach(() => { db = initDb(':memory:'); broadcasts = [] })
afterEach(() => db.close())

function graph(): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'a1', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'first' } },
      { id: 'a2', type: 'ai-step', position: { x: 0, y: 2 }, data: { prompt: 'second' } },
      { id: 'a3', type: 'ai-step', position: { x: 0, y: 3 }, data: { prompt: 'third' } },
      { id: 'e', type: 'end', position: { x: 0, y: 4 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'a1' }, { id: 'e2', source: 'a1', target: 'a2' },
      { id: 'e3', source: 'a2', target: 'a3' }, { id: 'e4', source: 'a3', target: 'e' },
    ],
    config: { maxIterations: 5, timeoutMinutes: 30 },
  }
}

const executors = (): LoopExecutors => ({
  runAiStep: vi.fn(async () => ({ text: 'work', sessionId: 's', cost: 1.5, tokens: 100, provider: 'claude', model: 'sonnet' })),
  runShell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 })),
  runDecider: vi.fn(async () => ({ continue: false, reasoning: 'done', parsed: true, cost: 0, tokens: 0, provider: 'claude', model: 'sonnet' })),
})

const request = (runId: string, extra: Partial<LoopRunRequest> = {}): LoopRunRequest => ({
  runId, loopId: 'loop-1', loopName: 'Ship', graph: graph(), projectId: 'p1', cwd: '/repo', railIndex: 0, ticketId: 7,
  spec: { title: 'Feature', description: 'desc' }, provider: 'claude', model: 'sonnet', ...extra,
})

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve))
  if (!cond()) throw new Error(`timed out waiting for ${label}`)
}

describe('per-run soft cap', () => {
  it('runs unchanged without a cap', async () => {
    const ex = executors()
    const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000)
    expect((await m.run(request('none'))).outcome).toBe('success')
    expect(ex.runAiStep).toHaveBeenCalledTimes(3)
    expect(broadcasts.some((msg) => msg.type === 'loop.run_paused')).toBe(false)
  })

  it('pauses before a turn whose expected cost would cross the cap, and Continue waives it for this run', async () => {
    const ex = executors()
    const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, { runCapDefault: () => 2 })
    const running = m.run(request('cap-ignore'))
    // $1.50 spent; the next turn is expected to cost $1.50 like the first, which would make $3.00 > $2.00.
    await waitFor(() => m.budgetPause('cap-ignore') !== null, 'run-cap pause')
    expect(ex.runAiStep).toHaveBeenCalledTimes(1)
    expect(getLoopRun(db, 'cap-ignore')).toMatchObject({ status: 'paused', restart_reason: 'budget_paused' })
    expect(m.budgetPause('cap-ignore')).toMatchObject({ period: 'run', budgetUsd: 2, spentUsd: 1.5, nextTurnUsd: 1.5, resetsAt: null,
      detail: 'This run has spent $1.50 of its $2.00 per-run cap, and its next turn is expected to cost about $1.50 (its largest turn so far), which would take it to $3.00.',
      action: 'Continue without the cap, or raise the per-run cap to at least $3.00, and the run resumes from the next step.' })
    expect(broadcasts.find((msg) => msg.type === 'loop.run_paused')).toMatchObject({ pauseKind: 'budget_paused', budget: { period: 'run', budgetUsd: 2, spentUsd: 1.5, resetsAt: null } })
    // No choice: the cap stands and the run stays paused.
    expect(m.resumeBudgetPause('cap-ignore')).toMatchObject({ status: 'over_budget', rejection: { period: 'run' } })
    expect(m.sendInteractiveTurn('cap-ignore', 'go')).toBe(false)
    expect(ex.runAiStep).toHaveBeenCalledTimes(1)

    expect(m.resumeBudgetPause('cap-ignore', { ignore: true })).toEqual({ status: 'resumed' })
    expect((await running).outcome).toBe('success')
    expect(ex.runAiStep).toHaveBeenCalledTimes(3)
    expect(readLoopRunCap(db, 'cap-ignore')).toBe(0)
  })

  it('reports the overshoot of a turn that cost more than the cap had left, and Raise must cover the next turn', async () => {
    const ex = executors()
    const m = new LoopRunManager(db, () => {}, ex, () => 1000, { runCapDefault: () => 1 })
    const running = m.run(request('cap-raise'))
    await waitFor(() => m.budgetPause('cap-raise') !== null, 'first pause') // the first turn alone cost $1.50
    expect(ex.runAiStep).toHaveBeenCalledTimes(1)
    expect(m.budgetPause('cap-raise')).toMatchObject({ spentUsd: 1.5, budgetUsd: 1, overshootUsd: 0.5,
      detail: "This run's cost $1.50 is $0.50 over its per-run cap of $1.00: its last turn cost $1.50, more than the cap had left." })
    // $2.00 would not cover the next $1.50 turn: still paused, saying what would.
    expect(m.resumeBudgetPause('cap-raise', { raiseTo: 2 })).toMatchObject({ status: 'over_budget', rejection: { nextTurnUsd: 1.5, action: expect.stringContaining('at least $3.00') } })
    expect(m.resumeBudgetPause('cap-raise', { raiseTo: 3 })).toEqual({ status: 'resumed' }) // 1.5 + 1.5 fits $3.00
    await waitFor(() => ex.runAiStep.mock.calls.length === 2 && m.budgetPause('cap-raise') !== null, 'second pause') // 3.0 >= 3
    expect(readLoopRunCap(db, 'cap-raise')).toBe(3)
    expect(m.budgetPause('cap-raise')).toMatchObject({ spentUsd: 3, budgetUsd: 3 })
    expect(m.budgetPause('cap-raise')?.overshootUsd).toBeUndefined()
    expect(m.resumeBudgetPause('cap-raise', { raiseTo: 4 })).toMatchObject({ status: 'over_budget' })
    expect(m.resumeBudgetPause('cap-raise', { raiseTo: 10 })).toEqual({ status: 'resumed' })
    expect((await running).outcome).toBe('success')
    expect(ex.runAiStep).toHaveBeenCalledTimes(3)
  })

  it('a launch override beats the default; 0 waives it', async () => {
    const exWaived = executors()
    const waived = new LoopRunManager(db, () => {}, exWaived, () => 1000, { runCapDefault: () => 1 })
    expect((await waived.run(request('waived', { runCapUsd: 0 }))).outcome).toBe('success')
    expect(exWaived.runAiStep).toHaveBeenCalledTimes(3)

    const ex = executors()
    const m = new LoopRunManager(db, () => {}, ex, () => 1000, { runCapDefault: () => 100 })
    const running = m.run(request('tighter', { runCapUsd: 1 }))
    await waitFor(() => m.budgetPause('tighter') !== null, 'override pause')
    expect(readLoopRunCap(db, 'tighter')).toBe(1)
    m.cancel('tighter')
    expect((await running).outcome).toBe('stopped')
  })

  it('the daily/weekly/monthly gate still wins over the run cap', async () => {
    const ex = executors()
    const gate = { error: 'daily_budget_exceeded' as const, scope: 'project' as const, period: 'week' as const, budgetUsd: 5, spentUsd: 6, resetsAt: '2026-10-26T00:00:00.000Z', detail: 'weekly', action: 'raise' }
    const m = new LoopRunManager(db, () => {}, ex, () => 1000, { dailyBudget: () => gate, runCapDefault: () => 1 })
    const running = m.run(request('gate-first'))
    await waitFor(() => m.budgetPause('gate-first') !== null, 'weekly pause')
    expect(m.budgetPause('gate-first')).toMatchObject({ period: 'week' })
    m.cancel('gate-first')
    await running
  })
})
