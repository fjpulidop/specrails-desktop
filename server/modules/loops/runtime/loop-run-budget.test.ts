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

  // Core cooperative pause (`pauseRuns`): a budget crossed by a role's spend
  // pauses the RUNNING invocation; Core exits 2 with state.pause and no interrupt.
  const at = '2026-10-21T12:00:00.000Z'
  const spend = (sequence: number, costUsd: number) => ({ type: 'runtime-efficiency-event', eventId: `d1:${sequence}`, runId: 'd1', sequence, timestamp: at, kind: 'role-context', attemptId: 'attempt-a', nodePath: 'a',
    payload: { invocationId: `physical-${sequence}`, provider: 'claude', model: 'sonnet', status: 'succeeded', startedAt: at, finishedAt: '2026-10-21T12:00:01.000Z', durationMs: 1000, usage: { inputTokens: 5, outputTokens: 2, costUsd } } })
  const prepared = { contextPath: '/frozen/context.json', runtimeDirectory: '/frozen', configPath: '/frozen/config.json', definitionPath: '/frozen/definition.json', definitionHash: 'a'.repeat(64), definition: {}, context: {} }
  const budgetPaused: DefinitionRuntimeResult = { text: '', runtimeStatus: 'paused', pendingInterrupts: [], pause: { requestId: 'desktop-budget-pause:d1:1', reason: 'budget', at } }

  function midRunCore(opts: { pauseUnsupported?: boolean; onPause?: () => void } = {}) {
    let releasePause!: () => void
    const pauseRequested = new Promise<void>(resolve => { releasePause = resolve })
    const pauseDefinition = vi.fn(async (_input: { runId: string; contextPath: string; requestId: string; reason: string }) => {
      if (opts.pauseUnsupported) throw new Error('engine_unsupported: Retained Core does not support cooperative pause')
      opts.onPause?.()
      releasePause()
      return { outcome: 'requested' }
    })
    const runDefinition = vi.fn(async (input: Parameters<NonNullable<LoopExecutors['runDefinition']>>[0]) => {
      if (input.resume) return succeeded
      input.onPrepared?.(prepared)
      input.onRuntimeEvent(spend(1, 3))
      if (opts.pauseUnsupported) return succeeded
      await pauseRequested // Core finishes its current step, then honours the pause.
      return budgetPaused
    })
    return { runDefinition, pauseDefinition }
  }

  it('pauses a RUNNING Core run with reason budget, parks budget_paused, and resumes Core once the budget allows it', async () => {
    let current: LoopBudgetBreach | null = null
    const { runDefinition, pauseDefinition } = midRunCore()
    const ex: LoopExecutors = { runDefinition, pauseDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
    current = breach()
    const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, { dailyBudget: () => current })
    const running = m.run(definitionRequest())
    await vi.waitFor(() => expect(m.budgetPause('d1')).not.toBeNull())
    expect(pauseDefinition).toHaveBeenCalledTimes(1)
    expect(pauseDefinition.mock.calls[0][0]).toEqual({ runId: 'd1', contextPath: '/frozen/context.json', requestId: 'desktop-budget-pause:d1:1', reason: 'budget' })
    expect(getLoopRun(db, 'd1')).toMatchObject({ status: 'paused', restart_reason: 'budget_paused' })
    expect(broadcasts.some(msg => msg.type === 'loop.run_paused' && (msg as { pauseKind?: string }).pauseKind === 'budget_paused')).toBe(true)
    expect(m.resumeBudgetPause('d1')).toMatchObject({ status: 'over_budget' })
    current = null
    expect(m.resumeBudgetPause('d1')).toEqual({ status: 'resumed' })
    expect((await running).outcome).toBe('success')
    expect(runDefinition).toHaveBeenCalledTimes(2)
    expect(runDefinition.mock.calls[1][0]).toMatchObject({ resume: true })
    expect(runDefinition.mock.calls[1][0].answer).toBeUndefined()
  })

  it('resumes Core at once when the budget was raised before Core honoured the pause', async () => {
    let current: LoopBudgetBreach | null = breach()
    const { runDefinition, pauseDefinition } = midRunCore({ onPause: () => { current = null } })
    const ex: LoopExecutors = { runDefinition, pauseDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
    const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, { dailyBudget: () => current })
    expect((await m.run(definitionRequest())).outcome).toBe('success')
    expect(pauseDefinition).toHaveBeenCalledTimes(1)
    expect(runDefinition).toHaveBeenCalledTimes(2)
    expect(broadcasts.some(msg => msg.type === 'loop.run_paused')).toBe(false)
  })

  it('settles stopped when the run is cancelled while paused mid-run on the budget', async () => {
    const { runDefinition, pauseDefinition } = midRunCore()
    const ex: LoopExecutors = { runDefinition, pauseDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
    const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, { dailyBudget: () => breach() })
    const running = m.run(definitionRequest())
    await vi.waitFor(() => expect(m.budgetPause('d1')).not.toBeNull())
    m.cancel('d1')
    expect((await running).outcome).toBe('stopped')
    expect(runDefinition).toHaveBeenCalledTimes(1)
  })

  it('falls back to the between-invocation guard when the retained Core lacks pauseRuns', async () => {
    const { runDefinition, pauseDefinition } = midRunCore({ pauseUnsupported: true })
    const ex: LoopExecutors = { runDefinition, pauseDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
    const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, { dailyBudget: () => breach() })
    expect((await m.run(definitionRequest())).outcome).toBe('success')
    expect(pauseDefinition).toHaveBeenCalledTimes(1)
    expect(getJobEvents(db, 'd1').some(event => event.payload.includes('cannot pause mid-run'))).toBe(true)
  })

  it('never requests a pause while the budget allows the spend', async () => {
    const { runDefinition, pauseDefinition } = midRunCore({ pauseUnsupported: true })
    const ex: LoopExecutors = { runDefinition, pauseDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
    const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, { dailyBudget: () => null })
    expect((await m.run(definitionRequest())).outcome).toBe('success')
    expect(pauseDefinition).not.toHaveBeenCalled()
  })

  it('runDefinitionLoop resumes a host budget pause without an answer, and refuses an unhandled pause', async () => {
    const invoke = vi.fn(async (input: { resume?: boolean }) => input.resume ? succeeded : budgetPaused)
    const ports = { invoke, isCancelled: () => false, remainingMs: () => undefined, onLine: () => {}, onRuntimeEvent: () => {}, onSpawn: () => {},
      onInvocationEnd: () => {}, awaitHumanDecision: async () => ({ action: 'stop' as const }) }
    const awaitHostPause = vi.fn(async () => 'continue' as const)
    expect((await runDefinitionLoop(definitionRequest(), 'd1', { ...ports, awaitHostPause })).runtimeStatus).toBe('succeeded')
    expect(awaitHostPause).toHaveBeenCalledWith(budgetPaused.pause)
    expect(invoke.mock.calls[1][0]).toMatchObject({ resume: true })
    expect((await runDefinitionLoop(definitionRequest(), 'd1', { ...ports, awaitHostPause: async () => 'stop' })).runtimeStatus).toBe('cancelled')
    await expect(runDefinitionLoop(definitionRequest(), 'd1', ports)).rejects.toThrow('without an addressable interrupt')
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

  // The 2026-11-19 gpt-6-astra run: a $1.96 plan turn, then a $2.30 developer turn started
  // before the pause requested at the plan's end reached Core: $4.89 against a $2.00 cap.
  describe('per-run cap ahead of the next turn', () => {
    const step = (sequence: number, nodePath: string) => ({ type: 'workflow-event', event: { id: `d1:${sequence}`, runId: 'd1', sequence, type: 'step_started', nodePath, scopeId: 'root', visit: 1, attempt: 1, attemptId: `attempt-${nodePath}`, timestamp: at } })
    const turn = (sequence: number, nodePath: string, costUsd: number) => ({ ...spend(sequence, costUsd), attemptId: `attempt-${nodePath}`, nodePath, payload: { ...spend(sequence, costUsd).payload, invocationId: `physical-${nodePath}` } })
    const graphEvent = { type: 'runtime-graph', engineVersion: 2, runId: 'd1', nodes: [{ path: 'architect', kind: 'role-turn' }, { path: 'checks', kind: 'verify' }, { path: 'developer', kind: 'role-turn' }, { path: 'reviewer', kind: 'role-turn' }] }

    function core(costs: { architect: number; developer: number }) {
      const order: string[] = []
      const pauseDefinition = vi.fn(async () => { order.push('pause-requested'); return { outcome: 'requested' } })
      const runDefinition = vi.fn(async (input: Parameters<NonNullable<LoopExecutors['runDefinition']>>[0]) => {
        if (input.resume) return succeeded
        input.onPrepared?.(prepared)
        input.onRuntimeEvent(graphEvent)
        input.onRuntimeEvent(step(1, 'architect'))
        input.onRuntimeEvent(turn(2, 'architect', costs.architect))
        input.onRuntimeEvent(step(3, 'checks'))
        order.push('developer-started')
        input.onRuntimeEvent(step(4, 'developer'))
        await new Promise(resolve => setImmediate(resolve))
        input.onRuntimeEvent(turn(5, 'developer', costs.developer))
        order.push('developer-finished')
        // Core honours a pause requested before it admits the next node.
        return order.includes('pause-requested') ? budgetPaused : succeeded
      })
      return { runDefinition, pauseDefinition, order }
    }

    it('arms the pause while the turn runs when the next one could not fit, and keeps the run paused before it', async () => {
      const { runDefinition, pauseDefinition, order } = core({ architect: 0.8, developer: 0.9 })
      const ex: LoopExecutors = { runDefinition, pauseDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
      const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, {})
      const running = m.run({ ...definitionRequest(), runCapUsd: 2 })
      await vi.waitFor(() => expect(m.budgetPause('d1')).not.toBeNull())
      // $0.80 spent and a $0.80 turn running: it and the next could pass $2.00, so the request went in during the developer turn.
      expect(order.indexOf('pause-requested')).toBeGreaterThan(order.indexOf('developer-started'))
      expect(order.indexOf('pause-requested')).toBeLessThan(order.indexOf('developer-finished'))
      expect(pauseDefinition).toHaveBeenCalledTimes(1)
      // $1.70 spent; the reviewer is expected to cost $0.90 (the largest turn): $2.60 > $2.00, so it does not start.
      expect(m.budgetPause('d1')).toMatchObject({ period: 'run', budgetUsd: 2, spentUsd: expect.closeTo(1.7, 6), nextTurnUsd: 0.9 })
      expect(m.budgetPause('d1')?.detail).toBe('This run has spent $1.70 of its $2.00 per-run cap, and its next turn is expected to cost about $0.90 (its largest turn so far), which would take it to $2.60.')
      const log = getJobEvents(db, 'd1').map(event => event.payload).join('\n')
      expect(log).toContain('Per-run cap: this turn and the next could take the run past its $2.00 cap.')
      expect(log).not.toContain('Daily budget reached mid-run')
      expect(m.resumeBudgetPause('d1', { raiseTo: 3 })).toEqual({ status: 'resumed' })
      expect((await running).outcome).toBe('success')
    })

    it('resumes at once when the turn came in cheaper than feared and the next one fits', async () => {
      const { runDefinition, pauseDefinition } = core({ architect: 0.8, developer: 0.1 })
      const ex: LoopExecutors = { runDefinition, pauseDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
      const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, {})
      // $0.90 spent; the next turn at $0.80 makes $1.70, within $2.00.
      expect((await m.run({ ...definitionRequest(), runCapUsd: 2 })).outcome).toBe('success')
      expect(pauseDefinition).toHaveBeenCalledTimes(1)
      expect(runDefinition).toHaveBeenCalledTimes(2)
      expect(broadcasts.some(msg => msg.type === 'loop.run_paused')).toBe(false)
      expect(getJobEvents(db, 'd1').some(event => event.payload.includes('The budget allows the next step'))).toBe(true)
    })

    it('never arms a pause when the next turns fit the cap', async () => {
      const { runDefinition, pauseDefinition } = core({ architect: 0.3, developer: 0.3 })
      const ex: LoopExecutors = { runDefinition, pauseDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
      const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, {})
      expect((await m.run({ ...definitionRequest(), runCapUsd: 2 })).outcome).toBe('success')
      expect(pauseDefinition).not.toHaveBeenCalled()
    })
  })
})

// The 2026-11-19 i18n-fr run: a restart script's process-tree kill sent SIGTERM to its Core
// process; Core cancelled the run and Desktop recorded the person's "stopped", with no reason.
describe('a Core run stopped by a signal Specrails did not send', () => {
  const at = '2026-11-19T01:41:23.000Z'
  const request = (): LoopRunRequest => ({ runId: 'sig', loopId: 'test-loop', projectId: 'p1', cwd: '/repo', provider: 'claude', model: 'haiku', graph: { nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 } },
    { id: 'a', type: 'core', position: { x: 0, y: 100 }, data: { kind: 'prompt', params: { text: 'Read', access: 'read', engine: { provider: 'claude' } } } },
    { id: 'end', type: 'core', position: { x: 0, y: 200 }, data: { kind: 'end', params: { outcome: 'success' } } }],
  edges: [{ id: 's', source: 'start', target: 'a' }, { id: 'e', source: 'a', target: 'end', label: 'next' }], config: { maxIterations: 3, timeoutMinutes: 0 } } })
  const cancelledBySignal = vi.fn(async (input: Parameters<NonNullable<LoopExecutors['runDefinition']>>[0]) => {
    input.onRuntimeEvent({ type: 'workflow-event', event: { id: 'sig:1', runId: 'sig', sequence: 1, type: 'step_started', nodePath: 'reviewer', scopeId: 'root', visit: 2, attempt: 1, attemptId: 'attempt-r', timestamp: at } })
    return { text: '', runtimeStatus: 'cancelled' as const, failed: true, errorText: 'Process termination requested (SIGTERM)' }
  })

  it('records why, keeps it continuable from its step, and is not a stop the person chose', async () => {
    const ex: LoopExecutors = { runDefinition: cancelledBySignal, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
    const m = new LoopRunManager(db, (msg) => broadcasts.push(msg), ex, () => 1000, {})
    expect((await m.run(request())).outcome).toBe('failed')
    const row = getLoopRun(db, 'sig')!
    expect(row.final_outcome).toBe('failed')
    const diagnosis = JSON.parse(row.failure_diagnosis!)
    expect(diagnosis).toMatchObject({ kind: 'crash', confidence: 'high', phase: 'reviewer', resumablePhase: 'reviewer' })
    expect(diagnosis.detail).toBe("The run's Core process received SIGTERM, a stop Specrails did not request: something outside the app (a script, a terminal or the system) ended it during the reviewer step. The work so far is kept; Continue resumes from that step.")
    const { autoContinueVerdict, parseStoredDiagnosis } = await import('../../recovery')
    expect(autoContinueVerdict({ enabled: true, outcome: 'failed', diagnosis: parseStoredDiagnosis(row.failure_diagnosis), chainAlreadyContinued: false })).toEqual({ continue: false, reason: 'not_auto_fixable' })
  })

  it('still settles the person\'s own Stop as stopped', async () => {
    let release!: () => void
    const runDefinition = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve }); return { text: '', runtimeStatus: 'cancelled' as const, failed: true, errorText: 'Process termination requested (SIGTERM)' } })
    const ex: LoopExecutors = { runDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
    const m = new LoopRunManager(db, () => {}, ex, () => 1000, {})
    const running = m.run(request())
    await vi.waitFor(() => expect(runDefinition).toHaveBeenCalled())
    m.cancel('sig')
    release()
    expect((await running).outcome).toBe('stopped')
    expect(getLoopRun(db, 'sig')!.failure_diagnosis).toBeNull()
  })
})

// GET loop-runs/:id served the paused checkpoint (with the answered question) until Core's first event.
describe('a resumed Core run', () => {
  it('shows as running with no pending question as soon as Desktop resumes it', async () => {
    const { recordDefinitionCheckpoint } = await import('./loop-runs-store')
    const prepared = { contextPath: '/frozen/context.json', runtimeDirectory: '/frozen', configPath: '/frozen/config.json', definitionPath: '/frozen/definition.json', definitionHash: 'a'.repeat(64), definition: {}, context: {} }
    const question = { id: 'q1', kind: 'question', nodePath: 'ask', value: { prompt: 'Which?' } }
    let seenOnResume: unknown
    const runDefinition = vi.fn(async (input: Parameters<NonNullable<LoopExecutors['runDefinition']>>[0]) => {
      if (!input.resume) {
        input.onPrepared?.(prepared)
        recordDefinitionCheckpoint(db, 'q-run', { revision: 3, eventCursor: 2, status: 'paused', pendingInterrupts: [question] })
        return { text: '', runtimeStatus: 'paused' as const, pendingInterrupts: [{ id: 'q1', nodePath: 'ask', kind: 'question' as const }] }
      }
      seenOnResume = JSON.parse(getLoopRun(db, 'q-run')!.runtime_status_json!)
      return { text: 'done', runtimeStatus: 'succeeded' as const, completion: { ok: true, verified: true, reasons: [] } }
    })
    const m = new LoopRunManager(db, () => {}, { runDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }, () => 1000, {})
    const running = m.run({ runId: 'q-run', loopId: 'test-loop', projectId: 'p1', cwd: '/repo', provider: 'claude', model: 'sonnet', graph: { nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 } },
      { id: 'a', type: 'core', position: { x: 0, y: 100 }, data: { kind: 'prompt', params: { text: 'Read', access: 'read', engine: { provider: 'claude' } } } }],
    edges: [{ id: 's', source: 'start', target: 'a' }], config: { maxIterations: 3, timeoutMinutes: 0 } } })
    await vi.waitFor(() => expect(m.isPaused('q-run')).toBe(true))
    expect(JSON.parse(getLoopRun(db, 'q-run')!.runtime_status_json!)).toMatchObject({ status: 'paused', pendingInterrupts: [question] })
    expect(m.sendInteractiveTurn('q-run', 'Answer', { interruptId: 'q1' })).toBe(true)
    expect((await running).outcome).toBe('success')
    expect(seenOnResume).toEqual({ revision: 3, eventCursor: 2, status: 'running', pendingInterrupts: [] })
  })
})
