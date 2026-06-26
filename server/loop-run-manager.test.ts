import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, getJob, type DbInstance } from './db'
import { LoopRunManager, type LoopExecutors } from './loop-run-manager'
import { getLoopRun } from './loop-runs-store'
import { fixLoopGraph } from './loop-templates'
import type { LoopGraph } from './loop-graph'
import type { WsMessage } from './types'

// Start → AI → Shell → Decider →(continue) AI / (stop) End
function loopGraph(maxIterations = 10): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Implement {{spec.title}}' } },
      { id: 'sh', type: 'shell', position: { x: 0, y: 2 }, data: { command: 'npm test' } },
      { id: 'd', type: 'decider', position: { x: 0, y: 3 }, data: { goal: 'tests pass' } },
      { id: 'e', type: 'end', position: { x: 1, y: 3 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'ai' },
      { id: 'e2', source: 'ai', target: 'sh' },
      { id: 'e3', source: 'sh', target: 'd' },
      { id: 'e4', source: 'd', target: 'ai' }, // continue
      { id: 'e5', source: 'd', target: 'e' }, // stop
    ],
    config: { maxIterations, timeoutMinutes: 30 },
  }
}

let db: DbInstance
let broadcasts: WsMessage[]

function makeExecutors(over: Partial<LoopExecutors> = {}): LoopExecutors {
  return {
    runAiStep: vi.fn(async () => ({ text: 'did work', sessionId: 's1', cost: 0.01, tokens: 100, provider: 'claude', model: 'sonnet' })),
    runShell: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 5 })),
    runDecider: vi.fn(async () => ({ continue: false, reasoning: 'done', parsed: true, cost: 0.001, tokens: 20, provider: 'claude', model: 'sonnet' })),
    ...over,
  }
}

function manager(executors: LoopExecutors): LoopRunManager {
  // Fixed clock so the timeout never fires during a unit test.
  return new LoopRunManager(db, (m) => broadcasts.push(m), executors, () => 1000)
}

function baseReq() {
  return {
    loopId: 'loop-1',
    loopName: 'Ship & Verify',
    graph: loopGraph(),
    projectId: 'p1',
    cwd: '/repo',
    railIndex: 1,
    ticketId: 42,
    spec: { title: 'Feature X', description: 'desc' },
    provider: 'claude',
    model: 'sonnet',
  }
}

beforeEach(() => {
  db = initDb(':memory:')
  broadcasts = []
})

describe('LoopRunManager', () => {
  it('runs to success when the Decider stops, recording loop invocations', async () => {
    let calls = 0
    const ex = makeExecutors({
      runDecider: vi.fn(async () => {
        calls += 1
        return calls >= 2
          ? { continue: false, reasoning: 'green', parsed: true, cost: 0.001, tokens: 10 }
          : { continue: true, reasoning: '1 failing', parsed: true, cost: 0.001, tokens: 10 }
      }),
    })
    const res = await manager(ex).run(baseReq())
    expect(res.outcome).toBe('success')
    expect(res.iterations).toBe(2)
    expect(ex.runAiStep).toHaveBeenCalledTimes(2) // one AI step before each decider
    const run = getLoopRun(db, res.runId)!
    expect(run.status).toBe('completed')
    expect(run.final_outcome).toBe('success')
    expect(run.iteration_count).toBe(2)
    // ai_invocations: 2 AI steps + 2 deciders, all surface='loop' linked to the run
    const inv = db.prepare(`SELECT COUNT(*) AS n FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).get(res.runId) as { n: number }
    expect(inv.n).toBe(4)
  })

  it('routes the Decider by edge.branch, not the successor-node-type heuristic', async () => {
    // d's 'stop' branch points to a NON-end cleanup step (cleanup → end), and d
    // has NO direct edge to an End. The legacy heuristic (stop = first 'end'
    // successor) would find none and settle immediately WITHOUT running cleanup.
    // Branch routing must instead follow the 'stop' edge and run cleanup.
    const graph: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'work' } },
        { id: 'd', type: 'decider', position: { x: 0, y: 2 }, data: { goal: 'done' } },
        { id: 'cleanup', type: 'ai-step', position: { x: 1, y: 2 }, data: { prompt: 'cleanup' } },
        { id: 'e', type: 'end', position: { x: 2, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'd' },
        { id: 'e-cont', source: 'd', target: 'ai', branch: 'continue' },
        { id: 'e-stop', source: 'd', target: 'cleanup', branch: 'stop' },
        { id: 'e-clean', source: 'cleanup', target: 'e' },
      ],
      config: { maxIterations: 10, timeoutMinutes: 30 },
    }
    const ex = makeExecutors() // decider stops on first call
    const res = await manager(ex).run({ ...baseReq(), graph })
    expect(res.outcome).toBe('success')
    // 2 AI steps = the main 'ai' + the 'cleanup' reached only via the stop branch.
    expect(ex.runAiStep).toHaveBeenCalledTimes(2)
  })

  it('resolves {{const:*}} in AI prompts + Decider goals (built-ins always; custom from request)', async () => {
    const graph: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'finish with {{const:VERIFICATION_PASS}}' } },
        { id: 'd', type: 'decider', position: { x: 0, y: 2 }, data: { goal: 'prefix {{const:TICKET_PREFIX}}' } },
        { id: 'e', type: 'end', position: { x: 1, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'd' },
        { id: 'e3', source: 'd', target: 'ai', branch: 'continue' },
        { id: 'e4', source: 'd', target: 'e', branch: 'stop' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }
    let deciderGoal = ''
    const ex = makeExecutors({
      // Decider goal arrives folded into the user prompt; capture + stop.
      runDecider: vi.fn(async ({ userPrompt }: { userPrompt: string }) => {
        deciderGoal = userPrompt
        return { continue: false, reasoning: 'done', parsed: true }
      }),
    })
    await manager(ex).run({ ...baseReq(), graph, constants: { TICKET_PREFIX: 'PROJ-' } })
    const aiPrompt = (ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt
    expect(aiPrompt).toContain('finish with VERIFICATION: PASS') // built-in, not in request
    expect(deciderGoal).toContain('prefix PROJ-') // custom, from request
  })

  it('interpolates {{spec.title}} into the AI step prompt', async () => {
    const ex = makeExecutors()
    await manager(ex).run(baseReq())
    const firstCall = (ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstCall.prompt).toContain('Implement Feature X')
  })

  it('stops at maxIterations when the Decider never stops', async () => {
    const ex = makeExecutors({
      runDecider: vi.fn(async () => ({ continue: true, reasoning: 'keep going', parsed: true })),
    })
    const req = { ...baseReq(), graph: loopGraph(3) }
    const res = await manager(ex).run(req)
    expect(res.outcome).toBe('max-iterations')
    expect(res.iterations).toBe(3)
    expect(getLoopRun(db, res.runId)!.final_outcome).toBe('max-iterations')
  })

  it('stops with outcome max-cost once the accumulated cost crosses the cap', async () => {
    const graph = loopGraph(100) // high iteration cap → cost is the binding limit
    graph.config.maxCostUsd = 0.05
    const ex = makeExecutors({
      runAiStep: vi.fn(async () => ({ text: 'x', cost: 0.02, provider: 'claude', model: 'sonnet' })),
      runDecider: vi.fn(async () => ({ continue: true, reasoning: 'keep', parsed: true, cost: 0 })),
    })
    const res = await manager(ex).run({ ...baseReq(), graph })
    expect(res.outcome).toBe('max-cost')
    expect(getLoopRun(db, res.runId)!.final_outcome).toBe('max-cost')
    // Stopped between steps after the total first crossed the cap (overshoot ≤ 1 step).
    expect(res.totalCostUsd).toBeGreaterThanOrEqual(0.05)
  })

  it('fail-open: an unpriced step (null cost) never trips the cap — falls through to maxIterations', async () => {
    const graph = loopGraph(2)
    graph.config.maxCostUsd = 0.001 // tiny cap that WOULD trip if cost were counted
    const ex = makeExecutors({
      runAiStep: vi.fn(async () => ({ text: 'x', provider: 'codex', model: 'unknown' })), // no cost
      runDecider: vi.fn(async () => ({ continue: true, reasoning: 'k', parsed: true })), // no cost
    })
    const res = await manager(ex).run({ ...baseReq(), graph })
    expect(res.outcome).toBe('max-iterations') // unknown cost ⇒ cap can't enforce, never false-fires
  })

  it('no cost cap (undefined) never stops on cost', async () => {
    let calls = 0
    const ex = makeExecutors({
      runAiStep: vi.fn(async () => ({ text: 'x', cost: 5, provider: 'claude', model: 'sonnet' })),
      runDecider: vi.fn(async () => { calls += 1; return { continue: calls < 2, reasoning: 'r', parsed: true, cost: 1 } }),
    })
    const res = await manager(ex).run(baseReq()) // baseReq graph has no maxCostUsd
    expect(res.outcome).toBe('success') // huge cost, but no cap → runs to the Decider's stop
  })

  it('settles as stopped when cancelled mid-run', async () => {
    let mgr: LoopRunManager
    const ex = makeExecutors({
      // Cancel during the first AI step; the next node-boundary check settles 'stopped'.
      // The run id is already on the synchronously-emitted run_started broadcast.
      runAiStep: vi.fn(async () => {
        const started = broadcasts.find((m) => m.type === 'loop.run_started') as { loopRunId: string }
        mgr.cancel(started.loopRunId)
        return { text: 'x' }
      }),
    })
    mgr = manager(ex)
    const res = await mgr.run(baseReq())
    expect(res.outcome).toBe('stopped')
  })

  it('broadcasts run_started, run_progress and run_completed', async () => {
    await manager(makeExecutors()).run(baseReq())
    const types = broadcasts.map((m) => m.type)
    expect(types).toContain('loop.run_started')
    expect(types).toContain('loop.run_progress')
    expect(types).toContain('loop.run_completed')
    const completed = broadcasts.find((m) => m.type === 'loop.run_completed') as { status: string; ticketIds: number[] }
    expect(completed.status).toBe('success')
    expect(completed.ticketIds).toEqual([42])
  })

  it('fix-loop: a failing verify routes to the fix step then re-verifies until the decider stops', async () => {
    const graph = fixLoopGraph(['{{cmd:implement}}'], 'all green')
    let aiCalls = 0
    let deciderCalls = 0
    const ex = makeExecutors({
      runAiStep: vi.fn(async () => { aiCalls += 1; return { text: 'ok', provider: 'claude', model: 'sonnet' } }),
      runDecider: vi.fn(async () => {
        deciderCalls += 1
        // Fail once (continue → fix → re-verify), then pass (stop).
        return { continue: deciderCalls < 2, reasoning: 'r', parsed: true, provider: 'claude', model: 'sonnet' }
      }),
    })
    const res = await manager(ex).run({ ...baseReq(), graph })
    expect(res.outcome).toBe('success')
    expect(deciderCalls).toBe(2) // verify-fail then verify-pass
    // implement (once) + verify + fix + verify = 4 AI steps; the fix step ran.
    expect(aiCalls).toBe(4)
  })

  it('marks the run failed when it reaches an End node flagged failure', async () => {
    const g: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'e', type: 'end', position: { x: 0, y: 1 }, data: { outcome: 'failure' } },
      ],
      edges: [{ id: 'e1', source: 's', target: 'e' }],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }
    const res = await manager(makeExecutors()).run({ ...baseReq(), graph: g })
    expect(res.outcome).toBe('failed')
  })

  it('backs the run with a job, streams parsed events + log lines, and finalizes the job', async () => {
    const g: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'do {{spec.title}}' } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }
    // The executor forwards a RAW provider JSONL line (→ parsed `event`) and a
    // non-JSON line (→ `log` fallback), exactly like the real spawn glue.
    const ex = makeExecutors({
      runAiStep: vi.fn(async ({ onRawLine }) => {
        onRawLine?.('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}')
        onRawLine?.('plain non-json line')
        return { text: 'hi', sessionId: 's1', cost: 0.02, tokens: 50, provider: 'claude', model: 'sonnet' }
      }),
    })
    const res = await manager(ex).run({ ...baseReq(), graph: g })

    // Job row exists and is settled completed (success).
    const job = getJob(db, res.runId)
    expect(job).toBeTruthy()
    expect(job?.status).toBe('completed')
    expect(job?.command).toContain('loop:')

    // Raw JSONL surfaced as a parsed `event` (drives JobStatusPanel activity);
    // non-JSON surfaced as a `log`.
    const evt = broadcasts.find((m) => m.type === 'event' && (m as { event_type: string }).event_type === 'assistant') as { event_type: string; jobId: string } | undefined
    expect(evt?.event_type).toBe('assistant')
    expect(evt?.jobId).toBe(res.runId)
    expect(broadcasts.some((m) => m.type === 'log' && (m as { line: string }).line === 'plain non-json line')).toBe(true)
    // Each executed node emits a structured `loop_step` boundary event (segmentation).
    const stepEvt = broadcasts.find((m) => m.type === 'event' && (m as { event_type: string }).event_type === 'loop_step') as { payload: string } | undefined
    expect(stepEvt).toBeTruthy()
    expect(JSON.parse(stepEvt!.payload).kind).toBe('ai-step')

    // Job finalized so an open JobDetail re-fetches + stops the live stream.
    const fin = broadcasts.find((m) => m.type === 'job.finalized') as { jobId: string; status: string } | undefined
    expect(fin?.jobId).toBe(res.runId)
    expect(fin?.status).toBe('completed')
  })
})
