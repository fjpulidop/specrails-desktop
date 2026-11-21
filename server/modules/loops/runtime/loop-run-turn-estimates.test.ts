import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getJobEvents, initDb, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopExecutors, type LoopRunRequest } from './loop-run-manager'
import type { DefinitionRuntimeResult } from './loop-definition-run'
import { retainedRunCapRejection } from './loop-budget-resume'
import { defaultTurnCostUsd, estimateNextStep, invalidateNodeCostHistory, nextAiNodes, readNodeCostHistory, readRunNodeTurns, turnGraphFromLoop, turnGraphFromRuntime } from './loop-run-turn-estimates'
import type { WsMessage } from '../../../types'

// The per-run cap is enforced before a step starts, against what that step is expected to
// cost. Two soak runs with a $0.40 cap reached $0.52 and $0.61: the pause looked ahead by the
// largest EARLIER turn of the run, and the first heavy step (a $0.49 Developer after a cheap
// Architect) had nothing earlier to predict it.

let db: DbInstance
let broadcasts: WsMessage[]
beforeEach(() => { db = initDb(':memory:'); broadcasts = []; invalidateNodeCostHistory(db) })
afterEach(() => db.close())

const runtimeGraph = (runId: string, order: string[]) => ({
  type: 'runtime-graph', engineVersion: 2, runId,
  nodes: [
    { path: 'architect', kind: 'role-turn', label: 'Architect' },
    { path: 'plan-ok', kind: 'condition', label: 'Planning confidence' },
    { path: 'developer', kind: 'role-turn', label: 'Developer' },
    { path: 'checks', kind: 'verify', label: 'Verify' },
    { path: 'reviewer', kind: 'role-turn', label: 'Reviewer' },
    { path: 'done', kind: 'end', label: 'done' },
  ].filter(node => order.includes(node.path) || !['architect', 'plan-ok'].includes(node.path)),
  edges: [
    { from: 'architect', label: 'next', to: 'plan-ok' }, { from: 'plan-ok', label: 'true', to: 'developer' }, { from: 'plan-ok', label: 'false', to: 'architect' },
    { from: 'developer', label: 'next', to: 'checks' }, { from: 'checks', label: 'pass', to: 'reviewer' }, { from: 'checks', label: 'fail', to: 'developer' },
    { from: 'reviewer', label: 'next', to: 'done' },
  ].filter(edge => order.includes(edge.from) || !['architect', 'plan-ok'].includes(edge.from)),
})

describe('the workflow graph the cap reads', () => {
  const graph = turnGraphFromRuntime(runtimeGraph('r', ['architect', 'plan-ok', 'developer', 'reviewer']))!
  it('finds the next AI steps through conditions and verification, stopping at an AI step', () => {
    // The plan can loop back to the architect, so no node lacks a way in: every AI node may come first.
    expect(nextAiNodes(graph, null).sort()).toEqual(['architect', 'developer', 'reviewer'])
    expect(nextAiNodes(graph, 'architect').sort()).toEqual(['architect', 'developer'])
    expect(nextAiNodes(graph, 'developer').sort()).toEqual(['developer', 'reviewer'])
    expect(nextAiNodes(graph, 'reviewer')).toEqual([])
  })
  it('is null for a graph Core described without edges (an older Core keeps the largest-turn projection)', () => {
    expect(turnGraphFromRuntime({ type: 'runtime-graph', nodes: [{ path: 'a', kind: 'role-turn' }] })).toBeNull()
  })
  it('reads a loop definition from its start node before Core describes it', () => {
    const loop = turnGraphFromLoop({ nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 } },
      { id: 'developer', type: 'core', position: { x: 0, y: 1 }, data: { kind: 'role-turn', label: 'Developer' } },
      { id: 'end', type: 'core', position: { x: 0, y: 2 }, data: { kind: 'end' } }],
    edges: [{ id: 'a', source: 'start', target: 'developer' }, { id: 'b', source: 'developer', target: 'end' }], config: { maxIterations: 1, timeoutMinutes: 0 } })!
    expect(nextAiNodes(loop, null)).toEqual(['developer'])
    expect(loop.nodes.get('developer')?.label).toBe('Developer')
  })
  it('prices a typical turn of the step\'s kind on its model from the rate card', () => {
    const sonnetDeveloper = defaultTurnCostUsd('claude', 'sonnet', { nodePath: 'developer', kind: 'role-turn', label: 'Developer' })!
    const sonnetReviewer = defaultTurnCostUsd('claude', 'sonnet', { nodePath: 'reviewer', kind: 'role-turn', label: 'Reviewer' })!
    const haikuDeveloper = defaultTurnCostUsd('claude', 'haiku', { nodePath: 'developer', kind: 'role-turn', label: 'Developer' })!
    expect(sonnetDeveloper).toBeGreaterThan(sonnetReviewer)
    expect(haikuDeveloper).toBeLessThan(sonnetDeveloper)
    expect(haikuDeveloper).toBeGreaterThan(0.05)
    expect(defaultTurnCostUsd('claude', 'no-such-model', { nodePath: 'developer', kind: 'role-turn', label: 'Developer' })).toBeNull()
    expect(estimateNextStep({ graph, turns: [], history: new Map(), route: () => ({ provider: 'claude', model: 'haiku' }) }, 'architect'))
      .toMatchObject({ nodePath: expect.stringMatching(/architect|developer/), basis: 'default', samples: 0 })
  })
})

// ─── A fake Core that runs the steps in order and honours a pause at the next node ─────────

const at = '2026-11-21T12:00:00.000Z'
const prepared = { contextPath: '/frozen/context.json', runtimeDirectory: '/frozen', configPath: '/frozen/config.json', definitionPath: '/frozen/definition.json', definitionHash: 'a'.repeat(64), definition: {}, context: {} }
const succeeded: DefinitionRuntimeResult = { text: 'done', runtimeStatus: 'succeeded', completion: { ok: true, verified: true, reasons: [] } }

function fakeCore(runId: string, steps: Array<[node: string, usd: number]>) {
  let sequence = 0, cursor = 0, pauseRequested = false
  const log: string[] = []
  const pauseDefinition = vi.fn(async () => { pauseRequested = true; log.push('pause-requested'); return { outcome: 'requested' } })
  const runDefinition = vi.fn(async (input: Parameters<NonNullable<LoopExecutors['runDefinition']>>[0]) => {
    if (!input.resume) { input.onPrepared?.(prepared); input.onRuntimeEvent(runtimeGraph(runId, steps.map(([node]) => node).concat('plan-ok'))) }
    pauseRequested = false // a resume consumes the requests that came before it
    while (cursor < steps.length) {
      if (pauseRequested) return { text: '', runtimeStatus: 'paused', pendingInterrupts: [], pause: { requestId: 'p', reason: 'budget', at } } as DefinitionRuntimeResult
      const [node, usd] = steps[cursor++]!
      log.push(`${node}-started`)
      input.onRuntimeEvent({ type: 'workflow-event', event: { id: `${runId}:${++sequence}`, runId, sequence, type: 'step_started', nodePath: node, scopeId: 'root', visit: 1, attempt: 1, attemptId: `${runId}-${node}-${cursor}`, timestamp: at } })
      await new Promise(resolve => setImmediate(resolve)) // the turn runs; the pause request lands meanwhile
      const seq = ++sequence
      input.onRuntimeEvent({ type: 'runtime-efficiency-event', eventId: `${runId}:${seq}`, runId, sequence: seq, timestamp: at, kind: 'role-context', attemptId: `${runId}-${node}-${cursor}`, nodePath: node,
        payload: { invocationId: `inv-${node}-${cursor}`, provider: 'claude', model: 'sonnet', status: 'succeeded', startedAt: at, finishedAt: at, durationMs: 1000, usage: { inputTokens: 5, outputTokens: 2, costUsd: usd } } })
    }
    return succeeded
  })
  return { runDefinition, pauseDefinition, log, started: () => log.filter(entry => entry.endsWith('-started')).map(entry => entry.replace('-started', '')) }
}

const request = (runId: string, extra: Partial<LoopRunRequest> = {}): LoopRunRequest => ({ runId, loopId: 'implement', projectId: 'p1', cwd: '/repo', provider: 'claude', model: 'sonnet', graph: { nodes: [
  { id: 'start', type: 'start', position: { x: 0, y: 0 } },
  { id: 'architect', type: 'core', position: { x: 0, y: 1 }, data: { kind: 'role-turn', label: 'Architect' } },
  { id: 'developer', type: 'core', position: { x: 0, y: 2 }, data: { kind: 'role-turn', label: 'Developer' } },
  { id: 'done', type: 'core', position: { x: 0, y: 3 }, data: { kind: 'end' } }],
edges: [{ id: 'a', source: 'start', target: 'architect' }, { id: 'b', source: 'architect', target: 'developer' }, { id: 'c', source: 'developer', target: 'done' }], config: { maxIterations: 3, timeoutMinutes: 0 } }, ...extra })

const manager = (core: ReturnType<typeof fakeCore>) =>
  new LoopRunManager(db, (msg) => broadcasts.push(msg), { runDefinition: core.runDefinition, pauseDefinition: core.pauseDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }, () => 1000, {})

/** Earlier runs of the project: what the steps usually cost. */
async function history(runs: number): Promise<void> {
  for (let i = 0; i < runs; i++) {
    const core = fakeCore(`past-${i}`, [['architect', 0.05], ['developer', 0.47 + i * 0.01], ['reviewer', 0.1]])
    expect((await manager(core).run(request(`past-${i}`))).outcome).toBe('success')
  }
  invalidateNodeCostHistory(db)
}

describe('per-run cap: the next step is estimated from what it usually costs', () => {
  it('pauses before the first heavy step instead of overshooting the cap with it', async () => {
    await history(3)
    expect(readRunNodeTurns(db, 'past-0').map(turn => [turn.nodePath, turn.usd])).toEqual([['architect', 0.05], ['developer', 0.47], ['reviewer', 0.1]])
    expect(readNodeCostHistory(db).get('developer\u0000claude\u0000sonnet')?.sort()).toEqual([0.47, 0.48, 0.49])

    const core = fakeCore('capped', [['architect', 0.05], ['developer', 0.49], ['reviewer', 0.1]])
    const m = manager(core)
    const running = m.run(request('capped', { runCapUsd: 0.4 }))
    await vi.waitFor(() => expect(m.budgetPause('capped')).not.toBeNull())
    // Before: the look-ahead was the largest earlier turn ($0.05), so Developer started and the run reached $0.54.
    expect(core.started()).toEqual(['architect'])
    expect(m.budgetPause('capped')).toMatchObject({ period: 'run', budgetUsd: 0.4, spentUsd: expect.closeTo(0.05, 6), remainingUsd: 0.35,
      nextStep: { nodePath: 'developer', label: 'Developer', usd: 0.48, basis: 'history', samples: 3 },
      detail: "The next step (Developer) usually costs about $0.48 (the median of its last 3 turns in this project), and $0.35 of this run's $0.40 per-run cap is left ($0.05 spent), so it has not started." })
    expect(broadcasts.find(msg => msg.type === 'loop.run_paused')).toMatchObject({ budget: { period: 'run', nextStep: { label: 'Developer' }, remainingUsd: 0.35 } })
    // The pause was asked while the Architect ran, so Core stopped before admitting Developer.
    expect(core.log.indexOf('pause-requested')).toBeLessThan(core.log.indexOf('architect-started') + 2)

    // A restart keeps the same answer for the retained run.
    expect(retainedRunCapRejection(db, 'capped', {})).toMatchObject({ nextStep: { label: 'Developer' }, remainingUsd: 0.35 })
    expect(retainedRunCapRejection(db, 'capped', { runCap: 'once' })).toBeNull()

    // "Run this step once": Developer runs; the cap stands again after it.
    expect(m.resumeBudgetPause('capped', { once: true })).toEqual({ status: 'resumed' })
    await vi.waitFor(() => expect(m.budgetPause('capped')).not.toBeNull())
    expect(core.started()).toEqual(['architect', 'developer'])
    expect(m.budgetPause('capped')).toMatchObject({ spentUsd: expect.closeTo(0.54, 6), overshootUsd: 0.14 })
    expect(m.resumeBudgetPause('capped', { ignore: true })).toEqual({ status: 'resumed' })
    expect((await running).outcome).toBe('success')
    expect(core.started()).toEqual(['architect', 'developer', 'reviewer'])
  })

  it('checks the workflow\'s first AI step before Core starts it', async () => {
    await history(2)
    const core = fakeCore('first', [['developer', 0.49], ['reviewer', 0.1]])
    const m = manager(core)
    const developerFirst = request('first', { runCapUsd: 0.4, graph: { ...request('x').graph, edges: [{ id: 'a', source: 'start', target: 'developer' }, { id: 'c', source: 'developer', target: 'done' }] } })
    const running = m.run(developerFirst)
    await vi.waitFor(() => expect(m.budgetPause('first')).not.toBeNull())
    expect(core.runDefinition).not.toHaveBeenCalled()
    expect(m.budgetPause('first')).toMatchObject({ spentUsd: 0, nextStep: { label: 'Developer', basis: 'history' }, nextTurnUsd: 0.48, action: expect.stringContaining('at least $0.48') })
    expect(m.resumeBudgetPause('first', { raiseTo: 1 })).toEqual({ status: 'resumed' })
    expect((await running).outcome).toBe('success')
    expect(core.started()).toEqual(['developer', 'reviewer'])
  })

  it('never pauses a run whose steps fit the cap', async () => {
    await history(2)
    const core = fakeCore('fits', [['architect', 0.05], ['developer', 0.49], ['reviewer', 0.1]])
    expect((await manager(core).run(request('fits', { runCapUsd: 1 }))).outcome).toBe('success')
    expect(core.pauseDefinition).not.toHaveBeenCalled()
    expect(broadcasts.some(msg => msg.type === 'loop.run_paused')).toBe(false)
  })

  it('without any history, a rate-card estimate of the step stands in', async () => {
    const core = fakeCore('fresh', [['architect', 0.02], ['developer', 0.6]])
    const m = manager(core)
    const running = m.run(request('fresh', { runCapUsd: 0.1 }))
    await vi.waitFor(() => expect(m.budgetPause('fresh')).not.toBeNull())
    expect(m.budgetPause('fresh')?.nextStep).toMatchObject({ basis: 'default', samples: 0 })
    expect(getJobEvents(db, 'fresh').some(event => event.payload.includes('rate-card estimate'))).toBe(true)
    m.cancel('fresh')
    expect((await running).outcome).toBe('stopped')
  })
})
