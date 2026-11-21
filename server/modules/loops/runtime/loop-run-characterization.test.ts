/**
 * Characterization tests for LoopRunManager's run orchestration: they pin the
 * exact persisted event stream (order, seq, payloads), broadcasts, accounting
 * rows and terminal settlement of representative runs, plus traversal routing
 * branches the behavioural suites do not reach. They guard structural
 * refactors of the engine — any change in these snapshots is a behaviour
 * change and must be deliberate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { initDb, getJobEvents, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopExecutors, type LoopRunRequest, type LoopBudgetBreach, type AiStepResult } from './loop-run-manager'
import type { DefinitionRuntimeResult } from './loop-definition-run'
import type { LoopGraph, LoopNode } from './loop-graph'
import type { WsMessage } from '../../../types'
import { MAX_LIMIT_PAUSES } from './loop-run-pauses'

let db: DbInstance
let broadcasts: WsMessage[]
beforeEach(() => { db = initDb(':memory:'); broadcasts = [] })
afterEach(() => db.close())

const at = (id: string, type: LoopNode['type'], data?: LoopNode['data']): LoopNode => ({ id, type, position: { x: 0, y: 0 }, ...(data ? { data } : {}) })
const edge = (source: string, target: string, branch?: 'continue' | 'stop') => ({ id: `${source}-${target}`, source, target, ...(branch ? { branch } : {}) })

function verifyLoop(maxIterations = 4): LoopGraph {
  return {
    nodes: [at('s', 'start'), at('ai', 'ai-step', { prompt: 'Implement {{spec.title}}', label: 'Build' }), at('sh', 'shell', { command: 'npm test' }), at('d', 'decider', { goal: 'tests pass' }), at('e', 'end')],
    edges: [edge('s', 'ai'), edge('ai', 'sh'), edge('sh', 'd'), edge('d', 'ai', 'continue'), edge('d', 'e', 'stop')],
    config: { maxIterations, timeoutMinutes: 30 },
  }
}

function linear(...body: LoopNode[]): LoopGraph {
  const nodes = [at('s', 'start'), ...body, at('e', 'end')]
  return { nodes, edges: nodes.slice(1).map((node, i) => edge(nodes[i].id, node.id)), config: { maxIterations: 3, timeoutMinutes: 30 } }
}

function executors(over: Partial<LoopExecutors> = {}): LoopExecutors {
  return {
    runAiStep: vi.fn(async () => ({ text: 'did work', sessionId: 's1', cost: 0.01, tokens: 100, tokensIn: 60, tokensOut: 40, numTurns: 2, durationMs: 50, provider: 'claude', model: 'sonnet' })),
    runShell: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 5 })),
    runDecider: vi.fn(async () => ({ continue: false, reasoning: 'done', parsed: true, cost: 0.001, tokens: 20, durationMs: 7, provider: 'claude', model: 'sonnet' })),
    ...over,
  }
}

function request(runId: string, graph: LoopGraph, over: Partial<LoopRunRequest> = {}): LoopRunRequest {
  return { runId, loopId: 'loop-1', loopName: 'Characterize', graph, projectId: 'p1', cwd: '/repo', railIndex: 0, ticketId: 7,
    spec: { title: 'Feature X', description: 'desc' }, provider: 'claude', model: 'sonnet', ...over }
}

function manager(ex: LoopExecutors, options: ConstructorParameters<typeof LoopRunManager>[4] = {}, now: () => number = () => 1000): LoopRunManager {
  return new LoopRunManager(db, (m) => broadcasts.push(m), ex, now, options)
}

/** Everything a run leaves behind, with only generated ids/wall-clock values scrubbed. */
function trace(runId: string) {
  const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value), (key, v) =>
    key === 'invocationId' || (key === 'timestamp' && typeof v === 'string' && !v.startsWith('1970-')) ? '<scrubbed>' : v)
  const events = getJobEvents(db, runId).map((e) => {
    let payload: unknown = e.payload
    try { payload = JSON.parse(e.payload) } catch { /* raw */ }
    return { seq: e.seq, type: e.event_type, source: e.source, payload }
  })
  const invocations = db.prepare(`SELECT provider, surface, surface_ref_id, ticket_id, status, started_at, finished_at, total_cost_usd, total_cost_usd_estimated, tokens_in, tokens_out,
    tokens_cache_read, tokens_cache_create, num_turns, session_id, duration_ms, duration_api_ms, model FROM ai_invocations WHERE loop_run_id = ? ORDER BY rowid`).all(runId)
  const row = (table: string) => {
    const value = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(runId) as Record<string, unknown> | undefined
    if (value) for (const key of Object.keys(value)) if (/(^|_)(created|updated)_at$/.test(key)) delete value[key]
    return value
  }
  const run = row('loop_runs')
  const job = row('jobs')
  const staged = (db.prepare('SELECT COUNT(*) AS n FROM loop_step_recovery WHERE run_id = ?').get(runId) as { n: number }).n
  return scrub({ events, broadcasts, invocations, run, job, staged })
}

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve))
  if (!cond()) throw new Error(`timed out waiting for ${label}`)
}

describe('LoopRunManager characterization: full run traces', () => {
  it('repair pass after a failed verification, then success', async () => {
    const ex = executors({
      runShell: vi.fn().mockResolvedValueOnce({ stdout: '', stderr: 'assertion failed', exitCode: 1, durationMs: 4 })
        .mockResolvedValue({ stdout: 'all checks passed', stderr: '', exitCode: 0, durationMs: 6 }),
    })
    const result = await manager(ex).run(request('trace-repair', verifyLoop()))
    expect(result).toMatchSnapshot('result')
    expect(trace('trace-repair')).toMatchSnapshot('trace')
  })

  it('idle stall retried once by resuming the session', async () => {
    const graph: LoopGraph = { ...linear(at('ai', 'ai-step', { prompt: 'work' })), config: { maxIterations: 3, timeoutMinutes: 0, aiStepTimeoutMinutes: 0 } }
    const runAiStep = vi.fn<LoopExecutors['runAiStep']>()
      .mockResolvedValueOnce({ text: '', sessionId: 'sess-stall', failed: true, stalled: true, errorText: 'AI step stalled', provider: 'claude', model: 'sonnet', durationMs: 5 })
      .mockResolvedValue({ text: 'recovered', sessionId: 'sess-stall', cost: 0.02, tokens: 10, provider: 'claude', model: 'sonnet', durationMs: 9 })
    const result = await manager(executors({ runAiStep }), { idleTimeoutMs: 120_000 }).run(request('trace-stall', graph))
    expect(runAiStep.mock.calls.map((call) => call[0].sessionId)).toEqual([undefined, 'sess-stall'])
    expect(result).toMatchSnapshot('result')
    expect(trace('trace-stall')).toMatchSnapshot('trace')
  })

  it('second idle stall settles the run stalled', async () => {
    const graph: LoopGraph = { ...linear(at('ai', 'ai-step', { prompt: 'work' })), config: { maxIterations: 3, timeoutMinutes: 0, aiStepTimeoutMinutes: 0 } }
    const runAiStep = vi.fn(async () => ({ text: 'partial', sessionId: 'sess-stall', failed: true, stalled: true, errorText: 'AI step stalled', provider: 'claude', model: 'sonnet', durationMs: 5 }))
    const result = await manager(executors({ runAiStep }), { idleTimeoutMs: 60_000 }).run(request('trace-stall-twice', graph))
    expect(result).toMatchSnapshot('result')
    expect(trace('trace-stall-twice')).toMatchSnapshot('trace')
  })

  it('a resumed zero-work step is retried once in a fresh session', async () => {
    const graph = linear(at('a1', 'ai-step', { prompt: 'red' }), at('a2', 'ai-step', { prompt: 'green' }))
    const runAiStep = vi.fn<LoopExecutors['runAiStep']>()
      .mockResolvedValueOnce({ text: 'red done', sessionId: 's1', cost: 0.01, tokens: 5, numTurns: 1, provider: 'claude', model: 'sonnet' })
      .mockResolvedValueOnce({ text: '', sessionId: 's1', numTurns: 0, tokensIn: 0, tokensOut: 0, provider: 'claude', model: 'sonnet' })
      .mockResolvedValue({ text: 'green done', sessionId: 's2', cost: 0.01, tokens: 5, numTurns: 1, provider: 'claude', model: 'sonnet' })
    const result = await manager(executors({ runAiStep })).run(request('trace-resume-miss', graph))
    expect(runAiStep.mock.calls.map((call) => call[0].sessionId)).toEqual([undefined, 's1', undefined])
    expect(result).toMatchSnapshot('result')
    expect(trace('trace-resume-miss')).toMatchSnapshot('trace')
  })

  it('LOOP_BLOCKED pauses for a human decision and resumes the same step with it', async () => {
    const runAiStep = vi.fn<LoopExecutors['runAiStep']>()
      .mockResolvedValueOnce({ text: 'LOOP_BLOCKED: Which database?', sessionId: 's1', provider: 'claude', model: 'sonnet' })
      .mockResolvedValue({ text: 'implemented with postgres', sessionId: 's1', provider: 'claude', model: 'sonnet' })
    const m = manager(executors({ runAiStep }))
    const running = m.run(request('trace-blocked', linear(at('ai', 'ai-step', { prompt: 'work' }))))
    await waitFor(() => m.isPaused('trace-blocked'), 'pause')
    expect(m.pausedReason('trace-blocked')).toBe('Which database?')
    expect(m.sendInteractiveTurn('trace-blocked', 'Use postgres')).toBe(true)
    const result = await running
    expect(String(runAiStep.mock.calls[1][0].prompt)).toContain('Human decision: Use postgres')
    expect(result).toMatchSnapshot('result')
    expect(trace('trace-blocked')).toMatchSnapshot('trace')
  })

  it('budget pause between AI steps, then resume', async () => {
    let current: LoopBudgetBreach | null = null
    const breach: LoopBudgetBreach = { error: 'daily_budget_exceeded', scope: 'project', budgetUsd: 10, spentUsd: 12, resetsAt: '2026-10-22T00:00:00.000Z', detail: 'Spent $12.00 of $10.00.', action: 'Raise it.' }
    const runAiStep = vi.fn(async () => { current = breach; return { text: 'did work', sessionId: 's1', cost: 0.01, tokens: 100, provider: 'claude', model: 'sonnet' } })
    const m = manager(executors({ runAiStep }), { dailyBudget: () => current })
    const running = m.run(request('trace-budget', linear(at('a1', 'ai-step', { prompt: 'one' }), at('a2', 'ai-step', { prompt: 'two' }))))
    await waitFor(() => m.budgetPause('trace-budget') !== null, 'budget pause')
    current = null
    expect(m.resumeBudgetPause('trace-budget')).toEqual({ status: 'resumed' })
    const result = await running
    expect(result).toMatchSnapshot('result')
    expect(trace('trace-budget')).toMatchSnapshot('trace')
  })

  it('provider limit pauses the run at the limit and stops after repeated refusals', async () => {
    const limit = "You've hit your session limit · resets 3am (Europe/Madrid)"
    const runAiStep = vi.fn(async () => ({ text: limit, sessionId: 'sess-lim', provider: 'claude', model: 'opus', resultIsError: true, failed: true, errorText: `provider returned an error result — ${limit}`, durationMs: 500 }))
    const m = manager(executors({ runAiStep }))
    const running = m.run(request('trace-limit', verifyLoop()))
    for (let pause = 0; pause < MAX_LIMIT_PAUSES; pause++) {
      for (let i = 0; i < 400 && !m.limitPause('trace-limit'); i++) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(m.resolveLimitPause('trace-limit', { action: 'resume' })).toBe(true)
    }
    const result = await running
    expect(result).toMatchSnapshot('result')
    expect(trace('trace-limit')).toMatchSnapshot('trace')
  })

  it('phase recovery: a single verification retry and an artifact-only repair before revalidation', async () => {
    const graph = linear(
      at('prep', 'ai-step', { prompt: 'Prepare openspec/changes/feature-x/', stopOnFailure: true }),
      at('val', 'shell', { command: 'openspec validate {{run.changeId}}', stopOnFailure: true, failureRecovery: { target: 'prep', maxRetries: 1, artifactOnly: true } }),
      at('impl', 'ai-step', { prompt: 'Implement', stopOnFailure: true, requireVerificationPass: true, failureRecovery: { target: 'impl', maxRetries: 1 } }),
    )
    const runAiStep = vi.fn<LoopExecutors['runAiStep']>()
      .mockResolvedValueOnce({ text: 'created openspec/changes/feature-x/proposal.md', sessionId: 's1', provider: 'claude', model: 'sonnet' })
      .mockResolvedValueOnce({ text: 'repaired artifacts', sessionId: 's1', provider: 'claude', model: 'sonnet' })
      .mockResolvedValueOnce({ text: 'implemented, tests still red', sessionId: 's1', provider: 'claude', model: 'sonnet' })
      .mockResolvedValue({ text: 'fixed\nVERIFICATION: PASS', sessionId: 's1', provider: 'claude', model: 'sonnet' })
    const runShell = vi.fn<LoopExecutors['runShell']>()
      .mockResolvedValueOnce({ stdout: '', stderr: 'missing requirement', exitCode: 1, durationMs: 3 })
      .mockResolvedValue({ stdout: 'valid', stderr: '', exitCode: 0, durationMs: 3 })
    const result = await manager(executors({ runAiStep, runShell })).run(request('trace-phase', graph))
    expect(String(runAiStep.mock.calls[1][0].prompt)).toContain('Repair ONLY the OpenSpec artifacts at openspec/changes/feature-x/')
    expect(result).toMatchSnapshot('result')
    expect(trace('trace-phase')).toMatchSnapshot('trace')
  })

  it('a traversal exception closes the open step as failed and settles failed', async () => {
    const runShell = vi.fn(async () => { throw new Error('spawn exploded') })
    const result = await manager(executors({ runShell })).run(request('trace-throw', verifyLoop()))
    expect(result).toMatchSnapshot('result')
    expect(trace('trace-throw')).toMatchSnapshot('trace')
  })

  it('shell guards: missing run variable and an already archived change', async () => {
    const missing = await manager(executors()).run(request('trace-missing-var', linear(at('ar', 'shell', { command: 'openspec archive {{run.changeId}} -y', requireRunVars: ['changeId'] }))))
    expect(missing.outcome).toBe('failed')
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-char-'))
    try {
      fs.mkdirSync(path.join(cwd, 'openspec', 'changes', 'archive', '2026-01-01-feature-x'), { recursive: true })
      const runShell = vi.fn(executors().runShell)
      const archived = await manager(executors({ runShell })).run(request('trace-archived', linear(at('ar', 'shell', { command: 'openspec archive {{run.changeId}} -y' })),
        { cwd, spec: { title: 'Feature X', description: 'd', openspecChangeName: 'feature-x' } }))
      expect(archived.outcome).toBe('success')
      expect(runShell).not.toHaveBeenCalled()
    } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
    expect(trace('trace-missing-var')).toMatchSnapshot('missing-var')
    expect(trace('trace-archived')).toMatchSnapshot('archived')
  })

  it('Core definition run: events, spawn registration and settlement', async () => {
    const graph: LoopGraph = { nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 } },
      { id: 'a', type: 'core', position: { x: 0, y: 100 }, data: { kind: 'prompt', params: { text: 'Read', access: 'read', engine: { provider: 'claude' } } } },
      { id: 'end', type: 'core', position: { x: 0, y: 200 }, data: { kind: 'end', params: { outcome: 'success' } } }],
    edges: [{ id: 's', source: 'start', target: 'a' }, { id: 'e', source: 'a', target: 'end', label: 'next' }], config: { maxIterations: 3, timeoutMinutes: 0 } }
    const ended: string[] = []
    const child = Object.assign(new EventEmitter(), { pid: 0 }) as unknown as import('node:child_process').ChildProcess
    const runDefinition = vi.fn(async (input: Parameters<NonNullable<LoopExecutors['runDefinition']>>[0]): Promise<DefinitionRuntimeResult> => {
      input.onSpawn?.(child)
      input.onLine('core says hello')
      input.onLine('core warns', 'stderr', { attemptId: 'attempt-1' })
      return { text: 'done', runtimeStatus: 'succeeded', completion: { ok: true, verified: true, reasons: [] }, durationMs: 42 }
    })
    const m = manager({ ...executors(), runDefinition }, { onDefinitionInvocationEnd: (_runId, _tickets, status) => ended.push(status) })
    const result = await m.run(request('trace-definition', graph))
    expect(ended).toEqual(['succeeded'])
    expect(m.listProcessRoots()).toEqual([])
    expect(result).toMatchSnapshot('result')
    expect(trace('trace-definition')).toMatchSnapshot('trace')
  })
})

describe('LoopRunManager characterization: traversal routing', () => {
  it('a condition node with several successors fails the run instead of skipping branches', async () => {
    const graph: LoopGraph = {
      nodes: [at('s', 'start'), at('c', 'condition'), at('a', 'ai-step', { prompt: 'a' }), at('b', 'ai-step', { prompt: 'b' }), at('e', 'end')],
      edges: [edge('s', 'c'), edge('c', 'a'), edge('c', 'b'), edge('a', 'e'), edge('b', 'e')],
      config: { maxIterations: 3, timeoutMinutes: 30 },
    }
    const ex = executors()
    expect((await manager(ex).run(request('cond-multi', graph))).outcome).toBe('failed')
    expect(ex.runAiStep).not.toHaveBeenCalled()
    expect(getJobEvents(db, 'cond-multi').some((e) => e.payload.includes('Condition branching is unsupported'))).toBe(true)
  })

  it('a single-successor condition and unknown node kinds pass straight through', async () => {
    const ex = executors()
    const graph = linear(at('c', 'condition'), at('n', 'note' as LoopNode['type']), at('a', 'ai-step', { prompt: 'a' }))
    expect((await manager(ex).run(request('cond-single', graph))).outcome).toBe('success')
    expect(ex.runAiStep).toHaveBeenCalledTimes(1)
  })

  it('a decider reached with no iterations left settles max-iterations without running', async () => {
    const ex = executors()
    const graph = { ...linear(at('d', 'decider', { goal: 'g' })), config: { maxIterations: 0, timeoutMinutes: 30 } }
    expect((await manager(ex).run(request('dec-zero', graph))).outcome).toBe('max-iterations')
    expect(ex.runDecider).not.toHaveBeenCalled()
  })

  it('a decider continue edge into an End fails; a stop with no exit succeeds', async () => {
    const continueToEnd: LoopGraph = { nodes: [at('s', 'start'), at('d', 'decider', { goal: 'g' }), at('e', 'end')], edges: [edge('s', 'd'), edge('d', 'e', 'continue')], config: { maxIterations: 3, timeoutMinutes: 30 } }
    const cont = executors({ runDecider: vi.fn(async () => ({ continue: true, reasoning: 'more', parsed: true, provider: 'claude', model: 'sonnet' })) })
    expect((await manager(cont).run(request('dec-cont-end', continueToEnd))).outcome).toBe('failed')
    const stopNowhere: LoopGraph = { nodes: [at('s', 'start'), at('d', 'decider', { goal: 'g' }), at('e', 'end')], edges: [edge('s', 'd'), edge('d', 'e', 'continue')], config: { maxIterations: 3, timeoutMinutes: 30 } }
    stopNowhere.edges = [edge('s', 'd')]
    expect((await manager(executors()).run(request('dec-stop-none', stopNowhere))).outcome).toBe('success')
  })

  it('a blocked decider stops when the person stops the paused run', async () => {
    const ex = executors({ runDecider: vi.fn(async () => ({ continue: false, blocked: true, reasoning: 'Which scope?', parsed: true, provider: 'claude', model: 'sonnet' })) })
    const m = manager(ex)
    const running = m.run(request('dec-blocked', verifyLoop()))
    await waitFor(() => m.isPaused('dec-blocked'), 'pause')
    m.cancel('dec-blocked')
    expect((await running).outcome).toBe('stopped')
    expect(trace('dec-blocked')).toMatchSnapshot('trace')
  })

  it('a blocked decider with no continue successor resumes at the first step', async () => {
    const graph: LoopGraph = { nodes: [at('s', 'start'), at('d', 'decider', { goal: 'g' }), at('e', 'end')], edges: [edge('s', 'd'), edge('d', 'e', 'stop')], config: { maxIterations: 3, timeoutMinutes: 30 } }
    const runDecider = vi.fn<LoopExecutors['runDecider']>()
      .mockResolvedValueOnce({ continue: false, blocked: true, reasoning: 'Which scope?', parsed: true, provider: 'claude', model: 'sonnet' })
      .mockResolvedValue({ continue: false, reasoning: 'done', parsed: true, provider: 'claude', model: 'sonnet' })
    const m = manager(executors({ runDecider }))
    const running = m.run(request('dec-blocked-first', graph))
    await waitFor(() => m.isPaused('dec-blocked-first'), 'pause')
    expect(m.sendInteractiveTurn('dec-blocked-first', 'all of it')).toBe(true)
    expect((await running).outcome).toBe('success')
    expect(runDecider).toHaveBeenCalledTimes(2)
    expect(runDecider.mock.calls[1][0].userPrompt).toContain('Human decision: all of it')
  })

  it('a LOOP_BLOCKED step stops when the paused run is cancelled', async () => {
    const ex = executors({ runAiStep: vi.fn(async (): Promise<AiStepResult> => ({ text: 'LOOP_BLOCKED: Need a key', provider: 'claude', model: 'sonnet' })) })
    const m = manager(ex)
    const running = m.run(request('ai-blocked-stop', linear(at('ai', 'ai-step', { prompt: 'w' }))))
    await waitFor(() => m.isPaused('ai-blocked-stop'), 'pause')
    m.cancel('ai-blocked-stop')
    expect((await running).outcome).toBe('stopped')
    expect(trace('ai-blocked-stop')).toMatchSnapshot('trace')
  })

  it('the whole-run deadline and the cost cap stop before the next step', async () => {
    let clock = 1000
    const slow = executors({ runAiStep: vi.fn(async () => { clock += 31 * 60_000; return { text: 'slow', provider: 'claude', model: 'sonnet' } }) })
    expect((await manager(slow, {}, () => clock).run(request('deadline', verifyLoop()))).outcome).toBe('failed')
    expect(slow.runShell).not.toHaveBeenCalled()
    const pricey = executors({ runAiStep: vi.fn(async () => ({ text: 'spent', cost: 5, tokens: 1, provider: 'claude', model: 'sonnet' })) })
    const capped = { ...verifyLoop(), config: { ...verifyLoop().config, maxCostUsd: 1 } }
    expect((await manager(pricey).run(request('cost-cap', capped))).outcome).toBe('max-cost')
    expect(pricey.runShell).not.toHaveBeenCalled()
  })

  it('a dangling edge to an unknown node fails the run', async () => {
    const graph: LoopGraph = { nodes: [at('s', 'start'), at('e', 'end')], edges: [edge('s', 'ghost')], config: { maxIterations: 3, timeoutMinutes: 30 } }
    expect((await manager(executors()).run(request('dangling', graph))).outcome).toBe('failed')
  })

  it('a Core definition spawned after cancellation is torn down at once', async () => {
    const graph: LoopGraph = { nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 } },
      { id: 'a', type: 'core', position: { x: 0, y: 100 }, data: { kind: 'prompt', params: { text: 'Read', access: 'read', engine: { provider: 'claude' } } } },
      { id: 'end', type: 'core', position: { x: 0, y: 200 }, data: { kind: 'end', params: { outcome: 'success' } } }],
    edges: [{ id: 's', source: 'start', target: 'a' }, { id: 'e', source: 'a', target: 'end', label: 'next' }], config: { maxIterations: 3, timeoutMinutes: 0 } }
    let m!: LoopRunManager
    const child = Object.assign(new EventEmitter(), { pid: 0 }) as unknown as import('node:child_process').ChildProcess
    const runDefinition = vi.fn(async (input: Parameters<NonNullable<LoopExecutors['runDefinition']>>[0]): Promise<DefinitionRuntimeResult> => {
      m.cancel('def-cancel')
      input.onSpawn?.(child)
      return { text: '', runtimeStatus: 'cancelled', durationMs: 1 }
    })
    m = manager({ ...executors(), runDefinition })
    expect((await m.run(request('def-cancel', graph))).outcome).toBe('stopped')
  })
})
