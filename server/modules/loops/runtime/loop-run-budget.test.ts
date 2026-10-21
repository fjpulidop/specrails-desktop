import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, getJobEvents, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopBudgetBreach, type LoopExecutors, type LoopRunRequest } from './loop-run-manager'
import { getLoopRun } from './loop-runs-store'
import { runDefinitionLoop, type DefinitionRuntimeResult } from './loop-definition-run'
import type { LoopGraph } from './loop-graph'
import type { WsMessage } from '../../../types'

// rail-loop-budget-guard: the daily budget is checked BETWEEN AI steps; an
// exhausted budget parks the run as a resumable `budget_paused` pause.

let db: DbInstance
let broadcasts: WsMessage[]
beforeEach(() => { db = initDb(':memory:'); broadcasts = [] })
afterEach(() => db.close())

const breach = (spentUsd = 12.5): LoopBudgetBreach => ({
  error: 'daily_budget_exceeded', scope: 'project', budgetUsd: 10, spentUsd,
  resetsAt: '2026-10-22T00:00:00.000Z', detail: `Today's spend $${spentUsd.toFixed(2)} has reached the project daily budget of $10.00.`, action: 'Raise it.',
})

function threeStepGraph(timeoutMinutes = 30): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'a1', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'first' } },
      { id: 'sh', type: 'shell', position: { x: 0, y: 2 }, data: { command: 'npm test' } },
      { id: 'a2', type: 'ai-step', position: { x: 0, y: 3 }, data: { prompt: 'second' } },
      { id: 'e', type: 'end', position: { x: 0, y: 4 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'sh' },
      { id: 'e3', source: 'sh', target: 'a2' },
      { id: 'e4', source: 'a2', target: 'e' },
    ],
    config: { maxIterations: 5, timeoutMinutes },
  }
}

function executors(): LoopExecutors {
  return {
    runAiStep: vi.fn(async () => ({ text: 'did work', sessionId: 's1', cost: 0.01, tokens: 100, provider: 'claude', model: 'sonnet' })),
    runShell: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 5 })),
    runDecider: vi.fn(async () => ({ continue: false, reasoning: 'done', parsed: true, cost: 0.001, tokens: 20, provider: 'claude', model: 'sonnet' })),
  }
}

function request(runId: string, graph = threeStepGraph()): LoopRunRequest {
  return { runId, loopId: 'loop-1', loopName: 'Ship', graph, projectId: 'p1', cwd: '/repo', railIndex: 0, ticketId: 7,
    spec: { title: 'Feature', description: 'desc' }, provider: 'claude', model: 'sonnet' }
}

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve))
  if (!cond()) throw new Error(`timed out waiting for ${label}`)
}

describe('LoopRunManager daily budget between AI steps (legacy traversal)', () => {
  it('runs unchanged when the budget is within limits or no gate is bound', async () => {
    const gate = vi.fn(() => null)
    const ex = executors()
    const withGate = new LoopRunManager(db, (m) => broadcasts.push(m), ex, () => 1000, { dailyBudget: gate })
    expect((await withGate.run(request('within'))).outcome).toBe('success')
    expect(ex.runAiStep).toHaveBeenCalledTimes(2)
    // Consulted only before the second AI step: the launch gate covers the first.
    expect(gate).toHaveBeenCalledTimes(1)
    const without = new LoopRunManager(db, () => {}, executors(), () => 1000)
    expect((await without.run(request('no-gate'))).outcome).toBe('success')
    expect(broadcasts.some((m) => m.type === 'loop.run_paused')).toBe(false)
  })

  it('treats an unreadable budget as within limits (fail-open)', async () => {
    const ex = executors()
    const m = new LoopRunManager(db, () => {}, ex, () => 1000, { dailyBudget: () => { throw new Error('db closed') } })
    expect((await m.run(request('fail-open'))).outcome).toBe('success')
    expect(ex.runAiStep).toHaveBeenCalledTimes(2)
  })

  it('finishes the current step, pauses as budget_paused, refuses resume while over budget, and continues once raised', async () => {
    let current: LoopBudgetBreach | null = breach()
    const ex = executors()
    const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, { dailyBudget: () => current })
    const running = m.run(request('budget-run'))

    await waitFor(() => getLoopRun(db, 'budget-run')?.status === 'paused', 'budget pause')
    expect(ex.runAiStep).toHaveBeenCalledTimes(1)
    expect(ex.runShell).toHaveBeenCalledTimes(1)
    expect(getLoopRun(db, 'budget-run')).toMatchObject({ status: 'paused', restart_reason: 'budget_paused', final_outcome: null })
    expect(m.isPaused('budget-run')).toBe(true)
    expect(m.budgetPause('budget-run')).toMatchObject({ scope: 'project', budgetUsd: 10, spentUsd: 12.5 })
    expect(broadcasts.find((msg) => msg.type === 'loop.run_paused')).toMatchObject({
      loopRunId: 'budget-run', railIndex: 0, ticketIds: [7], pauseKind: 'budget_paused',
      budget: { scope: 'project', budgetUsd: 10, spentUsd: 12.5, resetsAt: '2026-10-22T00:00:00.000Z' },
    })
    expect(getJobEvents(db, 'budget-run').some((e) => e.event_type === 'log' && e.payload.includes('budget_paused'))).toBe(true)

    current = breach(13)
    expect(m.resumeBudgetPause('budget-run')).toEqual({ status: 'over_budget', rejection: breach(13) })
    expect(m.sendInteractiveTurn('budget-run', 'go')).toBe(false)
    expect(m.budgetPause('budget-run')?.spentUsd).toBe(13)
    expect(ex.runAiStep).toHaveBeenCalledTimes(1)

    current = null // the person raised the budget
    expect(m.resumeBudgetPause('budget-run')).toEqual({ status: 'resumed' })
    const result = await running
    expect(result.outcome).toBe('success')
    expect(ex.runAiStep).toHaveBeenCalledTimes(2)
    expect(getLoopRun(db, 'budget-run')).toMatchObject({ status: 'completed', final_outcome: 'success', restart_reason: null })
    expect(m.budgetPause('budget-run')).toBeNull()
    expect(broadcasts.some((msg) => msg.type === 'loop.run_resumed' && msg.loopRunId === 'budget-run')).toBe(true)
    expect(m.resumeBudgetPause('budget-run')).toEqual({ status: 'not_budget_paused' })
  })

  it('resumes through the turn door once the budget allows it', async () => {
    let current: LoopBudgetBreach | null = breach()
    const ex = executors()
    const m = new LoopRunManager(db, () => {}, ex, () => 1000, { dailyBudget: () => current })
    const running = m.run(request('turn-door'))
    await waitFor(() => m.budgetPause('turn-door') !== null, 'budget pause')
    current = null
    expect(m.sendInteractiveTurn('turn-door', 'continue')).toBe(true)
    expect((await running).outcome).toBe('success')
  })

  it('settles stopped when the run is cancelled while budget_paused, without another AI step', async () => {
    const ex = executors()
    const m = new LoopRunManager(db, () => {}, ex, () => 1000, { dailyBudget: () => breach() })
    const running = m.run(request('budget-stop'))
    await waitFor(() => m.budgetPause('budget-stop') !== null, 'budget pause')
    m.cancel('budget-stop')
    expect((await running).outcome).toBe('stopped')
    expect(ex.runAiStep).toHaveBeenCalledTimes(1)
    expect(getLoopRun(db, 'budget-stop')).toMatchObject({ status: 'completed', final_outcome: 'stopped' })
  })

  it('does not let a long budget pause consume the run deadline', async () => {
    let clock = 1000
    let current: LoopBudgetBreach | null = breach()
    const ex = executors()
    const m = new LoopRunManager(db, () => {}, ex, () => clock, { dailyBudget: () => current })
    const running = m.run(request('deadline', threeStepGraph(1)))
    await waitFor(() => m.budgetPause('deadline') !== null, 'budget pause')
    clock += 10 * 60_000 // ten minutes paused, far beyond the one-minute run deadline
    current = null
    m.resumeBudgetPause('deadline')
    expect((await running).outcome).toBe('success')
    expect(ex.runAiStep).toHaveBeenCalledTimes(2)
  })
})

describe('Core definitions: budget gate before re-invoking with a human decision', () => {
  function definitionRequest(): LoopRunRequest {
    return { runId: 'd1', loopId: 'test-loop', projectId: 'p1', cwd: '/repo', provider: 'claude', model: 'sonnet', graph: { nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 } },
      { id: 'a', type: 'core', position: { x: 0, y: 100 }, data: { kind: 'prompt', params: { text: 'Read', access: 'read', engine: { provider: 'claude' } } } },
      { id: 'end', type: 'core', position: { x: 0, y: 200 }, data: { kind: 'end', params: { outcome: 'success' } } }],
    edges: [{ id: 's', source: 'start', target: 'a' }, { id: 'e', source: 'a', target: 'end', label: 'next' }], config: { maxIterations: 3, timeoutMinutes: 0 } } }
  }
  const succeeded: DefinitionRuntimeResult = { text: 'done', runtimeStatus: 'succeeded', completion: { ok: true, verified: true, reasons: [] } }
  const paused: DefinitionRuntimeResult = { text: '', runtimeStatus: 'paused', pendingInterrupts: [{ id: 'q1', nodePath: 'a/ask', kind: 'question' }] }

  it('holds the answer on a budget_paused pause and delivers it to Core once the budget allows it', async () => {
    let current: LoopBudgetBreach | null = null
    const runDefinition = vi.fn(async (input: { resume?: boolean }) => (input.resume ? succeeded : paused))
    const ex: LoopExecutors = { runDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
    const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, { dailyBudget: () => current })
    const running = m.run(definitionRequest())
    await vi.waitFor(() => expect(m.isPaused('d1')).toBe(true))
    current = breach()
    expect(m.sendInteractiveTurn('d1', 'Answer', { interruptId: 'q1' })).toBe(true)
    await vi.waitFor(() => expect(m.budgetPause('d1')).not.toBeNull())
    expect(runDefinition).toHaveBeenCalledTimes(1)
    expect(getLoopRun(db, 'd1')).toMatchObject({ status: 'paused', restart_reason: 'budget_paused' })
    current = null
    expect(m.resumeBudgetPause('d1')).toEqual({ status: 'resumed' })
    expect((await running).outcome).toBe('success')
    expect(runDefinition).toHaveBeenCalledTimes(2)
    expect(runDefinition.mock.calls[1][0]).toMatchObject({ resume: true, answer: 'Answer', interruptId: 'q1' })
  })

  it('runDefinitionLoop settles cancelled when the host gate stops before the continuation', async () => {
    const invoke = vi.fn(async () => paused)
    const result = await runDefinitionLoop(definitionRequest(), 'd1', {
      invoke, isCancelled: () => false, remainingMs: () => undefined, onLine: () => {}, onRuntimeEvent: () => {}, onSpawn: () => {},
      onInvocationEnd: () => {}, awaitHumanDecision: async () => ({ action: 'resume', text: 'a' }),
      beforeContinuation: async () => 'stop',
    })
    expect(result.runtimeStatus).toBe('cancelled')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
