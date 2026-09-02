import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { initDb, createJob, getJob, getJobEvents, type DbInstance } from './db'
import { LoopRunManager, recoverOrphanLoopStepAccounting, truncate, type LoopExecutors, type InteractiveAiStepPlan, type InteractivePlanInput } from './loop-run-manager'
import { createLoopRun, getLoopRun, stageLoopStepRecovery } from './loop-runs-store'
import { fixLoopGraph } from './loop-templates'
import { getAdapter } from './providers'
import type { LoopGraph } from './loop-graph'
import type { WsMessage } from './types'

describe('truncate (Decider history shrink)', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('short output', 600)).toBe('short output')
  })

  it('keeps BOTH ends so a trailing verdict survives (the Decider reads it)', () => {
    const body = 'A'.repeat(2000)
    const out = truncate(`${body}\nVERIFICATION: PASS`, 600)
    expect(out.length).toBeLessThan(700)
    expect(out).toContain('VERIFICATION: PASS') // trailing verdict preserved
    expect(out.startsWith('A')).toBe(true) // opening context preserved
    expect(out).toContain('…')
  })
})

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

// Two AI steps per pass → Decider. `continueTo` controls the loop-back target:
// 'a1' = re-run the whole body (iterate-per-item), 'a2' = re-run only the last step.
function twoStepGraph(continueTo: 'a1' | 'a2'): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'a1', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'red' } },
      { id: 'a2', type: 'ai-step', position: { x: 0, y: 2 }, data: { prompt: 'green' } },
      { id: 'd', type: 'decider', position: { x: 0, y: 3 }, data: { goal: 'g' } },
      { id: 'e', type: 'end', position: { x: 1, y: 3 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'a2' },
      { id: 'e3', source: 'a2', target: 'd' },
      { id: 'e4', source: 'd', target: continueTo, branch: 'continue' },
      { id: 'e5', source: 'd', target: 'e', branch: 'stop' },
    ],
    config: { maxIterations: 5, timeoutMinutes: 30 },
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

describe('LoopRunManager fail-fast (provider down / out of quota)', () => {
  it('aborts after AI_FAILFAST_THRESHOLD consecutive hard-failures instead of grinding to the cap', async () => {
    // Provider is genuinely down: every AI step hard-fails with no output AND the
    // Decider (same provider) can't produce a verdict either (parsed=false) — the
    // real codex-out-of-quota shape.
    const runAiStep = vi.fn(async () => ({ text: '', failed: true, errorText: "You've hit your usage limit", provider: 'codex', model: 'gpt-5.5' }))
    const runDecider = vi.fn(async () => ({ continue: true, reasoning: '(could not parse decision; continuing)', parsed: false }))
    const ex = makeExecutors({ runAiStep, runDecider })
    const res = await manager(ex).run({ ...baseReq(), graph: loopGraph(20) })
    expect(res.outcome).toBe('failed')
    // loopGraph has ONE ai-step per pass → abort on the 2nd consecutive failure,
    // NOT 20 iterations of grinding.
    expect((ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    const run = getLoopRun(db, res.runId)!
    expect(run.final_outcome).toBe('failed')
  })

  it('does NOT fail-fast when the Decider (same provider) keeps succeeding — the provider is alive', async () => {
    // ai-steps fail every pass, but the Decider produces a parseable verdict each
    // time → provider is demonstrably up → the streak resets → no false abort.
    const runAiStep = vi.fn(async () => ({ text: '', failed: true, errorText: 'transient blip', provider: 'claude', model: 'sonnet' }))
    const runDecider = vi.fn(async () => ({ continue: true, reasoning: 'not met', parsed: true }))
    const ex = makeExecutors({ runAiStep, runDecider })
    const res = await manager(ex).run({ ...baseReq(), graph: loopGraph(3) })
    // Runs to the iteration cap (the safety net), NOT a 'provider down' abort —
    // it ran well past the 2-failure fail-fast threshold without aborting.
    expect(res.outcome).toBe('max-iterations')
    expect((ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(2)
  })

  it('does NOT abort when a step fails once then recovers (counter resets)', async () => {
    let n = 0
    const runAiStep = vi.fn(async () => {
      n += 1
      return n === 1
        ? { text: '', failed: true, errorText: 'transient blip', provider: 'claude', model: 'sonnet' }
        : { text: 'did work', sessionId: 's1', provider: 'claude', model: 'sonnet' }
    })
    let d = 0
    const runDecider = vi.fn(async () => (++d >= 2
      ? { continue: false, reasoning: 'green', parsed: true }
      : { continue: true, reasoning: 'more', parsed: true }))
    const res = await manager(makeExecutors({ runAiStep, runDecider })).run({ ...baseReq(), graph: loopGraph(20) })
    expect(res.outcome).toBe('success')
  })

  it('does NOT count a failed step that still produced output (partial progress)', async () => {
    // Hard-fail BUT with text → not a dead spawn; never trips the fail-fast.
    const runAiStep = vi.fn(async () => ({ text: 'partial output', failed: true, errorText: 'exited 1', provider: 'claude', model: 'sonnet' }))
    const runDecider = vi.fn(async () => ({ continue: false, reasoning: 'stop', parsed: true }))
    const res = await manager(makeExecutors({ runAiStep, runDecider })).run({ ...baseReq(), graph: loopGraph(20) })
    expect(res.outcome).toBe('success')
  })
})

describe('LoopRunManager honest cost (unpriced step → lower bound)', () => {
  it('marks the total `≥` and warns when a cost-bearing step ends unpriced (claude timeout)', async () => {
    // A claude AI step killed by timeout: it streamed work (tokens) but the child
    // died before the terminal `result` event, so cost is undefined and the step
    // bills $0. The decider then stops with a real cost.
    const runAiStep = vi.fn(async () => ({ text: 'partial work', failed: true, errorText: 'claude timed out', tokens: 1200, provider: 'claude', model: 'sonnet' }))
    const runDecider = vi.fn(async () => ({ continue: false, reasoning: 'done', parsed: true, cost: 0.001, tokens: 20, provider: 'claude', model: 'sonnet' }))
    const res = await manager(makeExecutors({ runAiStep, runDecider })).run(baseReq())

    // Per-occurrence honesty warning surfaced in the run log.
    expect(broadcasts.some((m) => m.type === 'log' && /Step cost unknown/.test((m as { line: string }).line))).toBe(true)
    // Final total rendered as a lower bound (only the decider's $0.001 is priced).
    expect(broadcasts.some((m) => m.type === 'log' && /Loop finished:.*≥ \$0\.0010/.test((m as { line: string }).line))).toBe(true)
    expect(res.totalCostUsd).toBeCloseTo(0.001, 5)
  })

  it('does NOT flag the total when every cost-bearing step reports a price', async () => {
    const res = await manager(makeExecutors()).run(baseReq())
    expect(broadcasts.some((m) => m.type === 'log' && /Step cost unknown/.test((m as { line: string }).line))).toBe(false)
    expect(broadcasts.some((m) => m.type === 'log' && /Loop finished:.*≥/.test((m as { line: string }).line))).toBe(false)
  })

  it('keeps Kimi usage null and disables an unverifiable maxCostUsd guard', async () => {
    const graph: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'work' } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30, maxCostUsd: 0.0001 },
    }
    const ex = makeExecutors({
      runAiStep: vi.fn(async () => ({
        text: 'completed work',
        provider: 'kimi',
        model: 'k3',
        durationMs: 17,
      })),
    })
    const res = await manager(ex).run({
      ...baseReq(),
      graph,
      provider: 'kimi',
      model: 'k3',
    })

    expect(res.outcome).toBe('success')
    expect(res.totalCostUsd).toBeNull()
    expect(getJob(db, res.runId)).toMatchObject({
      total_cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cache_read: null,
      tokens_cache_create: null,
      num_turns: null,
      duration_ms: 17,
    })
    const finalized = broadcasts.find((message) => message.type === 'job.finalized')
    expect(finalized).toMatchObject({
      type: 'job.finalized',
      totals: {
        total_cost_usd: null,
        tokens_in: null,
        tokens_out: null,
      },
    })
    const lines = broadcasts
      .filter((message) => message.type === 'log')
      .map((message) => (message as { line: string }).line)
    expect(lines.some((line) => /usage totals will remain unavailable/i.test(line))).toBe(true)
    expect(lines.some((line) => /maxCostUsd guard is disabled/i.test(line))).toBe(true)
    expect(lines.some((line) => /Loop finished:.*usage\/cost unavailable/i.test(line))).toBe(true)
    expect(lines.some((line) => /Loop finished:.*\$0\.0000/i.test(line))).toBe(false)
  })

  it('rejects a Kimi Decider before persisting or invoking any executor', async () => {
    const ex = makeExecutors()
    await expect(manager(ex).run({
      ...baseReq(),
      runId: 'kimi-decider-rejected',
      provider: 'kimi',
      model: 'k3',
    })).rejects.toThrow('provider_tool_policy_unsupported:kimi:read-only')

    expect(getLoopRun(db, 'kimi-decider-rejected')).toBeUndefined()
    expect(getJob(db, 'kimi-decider-rejected')).toBeUndefined()
    expect(ex.runAiStep).not.toHaveBeenCalled()
    expect(ex.runDecider).not.toHaveBeenCalled()
  })
})

describe('LoopRunManager session bounding (provider-agnostic)', () => {
  // Mock that records the sessionId each AI step was called with and hands back a
  // fresh one (so a resume would carry it forward).
  function trackingExecutors() {
    let n = 0
    const runAiStep = vi.fn(async () => ({ text: 'x', sessionId: `sess-${++n}`, cost: 0, tokens: 1, provider: 'claude', model: 'sonnet' }))
    let d = 0
    const runDecider = vi.fn(async () => (++d >= 2
      ? { continue: false, reasoning: 'done', parsed: true, cost: 0, tokens: 1 }
      : { continue: true, reasoning: 'more', parsed: true, cost: 0, tokens: 1 }))
    return makeExecutors({ runAiStep, runDecider })
  }
  const sessionArg = (ex: LoopExecutors, i: number) =>
    ((ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls[i][0] as { sessionId?: string }).sessionId

  it('iterate-loops (continue → first step) start each pass FRESH but resume within the pass', async () => {
    const ex = trackingExecutors()
    await manager(ex).run({ ...baseReq(), graph: twoStepGraph('a1') })
    // pass 1: a1 fresh, a2 resumes a1 → pass 2: a1 FRESH again (session dropped at loop-back), a2 resumes
    expect((ex.runAiStep as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(4)
    expect(sessionArg(ex, 0)).toBeUndefined() // a1, pass 1 — fresh
    expect(sessionArg(ex, 1)).toBeDefined()   // a2, pass 1 — resumes within the pass
    expect(sessionArg(ex, 2)).toBeUndefined() // a1, pass 2 — RESET: fresh, re-reads the code
    expect(sessionArg(ex, 3)).toBeDefined()   // a2, pass 2 — resumes within the pass
  })

  it('a freshSession step does NOT inherit the previous step\'s provider conversation', async () => {
    // Revision's mutator → reviewer boundary: the gate must judge the candidate
    // on disk, not continue the conversation of the agent that wrote it.
    const graph = twoStepGraph('a1')
    const a2 = graph.nodes.find((n) => n.id === 'a2')!
    a2.data = { ...a2.data, freshSession: true }
    const ex = trackingExecutors()
    await manager(ex).run({ ...baseReq(), graph })
    expect(sessionArg(ex, 0)).toBeUndefined() // a1 — fresh (start of pass)
    expect(sessionArg(ex, 1)).toBeUndefined() // a2 — freshSession, NOT resumed
  })

  it('still hands a freshSession step its fully rendered prompt and prior-step history', async () => {
    const graph = twoStepGraph('a1')
    const a2 = graph.nodes.find((n) => n.id === 'a2')!
    a2.data = { ...a2.data, freshSession: true }
    const ex = trackingExecutors()
    await manager(ex).run({ ...baseReq(), graph })
    const prompt = ((ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls[1][0] as { prompt: string }).prompt
    // The briefing travels in the prompt precisely because the session does not.
    expect(prompt).toContain('green')
    expect(prompt).toContain('Context from previous iterations')
  })

  it('leaves a step without the flag resuming exactly as before', async () => {
    const ex = trackingExecutors()
    await manager(ex).run({ ...baseReq(), graph: twoStepGraph('a1') })
    expect(sessionArg(ex, 1)).toBeDefined()
  })

  it('appends cross-iteration history only when fresh or right after a Decider continue', async () => {
    const ex = trackingExecutors()
    await manager(ex).run({ ...baseReq(), graph: twoStepGraph('a2') })
    const prompt = (i: number) => ((ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls[i][0] as { prompt: string }).prompt
    const HIST = 'Context from previous iterations'
    // a2 in pass 1 is a mid-body RESUMED step → its session already has a1's output → no redundant history
    expect(prompt(1)).not.toContain(HIST)
    // a2 right after the Decider 'continue' must see the verdict it acts on → history included
    expect(prompt(2)).toContain(HIST)
  })

  it('non-iterate loops (continue → last step) keep resuming across iterations', async () => {
    const ex = trackingExecutors()
    await manager(ex).run({ ...baseReq(), graph: twoStepGraph('a2') })
    // pass 1: a1 fresh, a2 resumes → continue routes to a2 (not the first step) → no reset
    expect((ex.runAiStep as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3)
    expect(sessionArg(ex, 0)).toBeUndefined() // a1 — fresh start
    expect(sessionArg(ex, 1)).toBeDefined()   // a2 — resumes
    expect(sessionArg(ex, 2)).toBeDefined()   // a2 again — still resuming (session NOT dropped)
  })
})

describe('LoopRunManager ai_invocations accounting (BUG-ANALYTICS-03/04/07/32)', () => {
  // Single AI step → End, so exactly ONE loop ai_invocations row is written and
  // its column values are unambiguous to assert.
  function singleStepGraph(): LoopGraph {
    return {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'work' } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }
  }

  function shellOnlyGraph(): LoopGraph {
    return {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'sh', type: 'shell', position: { x: 0, y: 1 }, data: { command: 'npm test' } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'sh' },
        { id: 'e2', source: 'sh', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }
  }

  it('keeps executor duration for shell-only runs in both the loop and backing job', async () => {
    const res = await manager(makeExecutors({
      runShell: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 13 })),
    })).run({ ...baseReq(), graph: shellOnlyGraph() })

    expect(getLoopRun(db, res.runId)?.total_duration_ms).toBe(13)
    expect(getJob(db, res.runId)?.duration_ms).toBe(13)
  })

  it('keeps shell duration when terminal AI aggregates are rebuilt', async () => {
    const res = await manager(makeExecutors({
      runAiStep: vi.fn(async () => ({
        text: 'worked', provider: 'claude', model: 'sonnet', durationMs: 11,
      })),
      runShell: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 13 })),
      runDecider: vi.fn(async () => ({
        continue: false, reasoning: 'done', parsed: true,
        provider: 'claude', model: 'sonnet', durationMs: 17,
      })),
    })).run(baseReq())

    expect(getLoopRun(db, res.runId)?.total_duration_ms).toBe(41)
    expect(getJob(db, res.runId)?.duration_ms).toBe(41)
  })

  it('BUG-04: persists the per-direction token breakdown (incl. cache) to its matching column, not folded into tokens_out', async () => {
    // Mirrors a cache-hit claude step: in/out small, cache large. Folding into a
    // single tokens_out scalar would drop the cache volume entirely.
    const ex = makeExecutors({
      runAiStep: vi.fn(async () => ({
        text: 'x', cost: 0.05, provider: 'claude', model: 'sonnet',
        tokens: 24500, tokensIn: 1500, tokensOut: 1000, tokensCacheRead: 20000, tokensCacheCreate: 2000,
      })),
    })
    const res = await manager(ex).run({ ...baseReq(), graph: singleStepGraph() })
    expect(res.outcome).toBe('success')
    const row = db.prepare(
      `SELECT tokens_in, tokens_out, tokens_cache_read, tokens_cache_create FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`
    ).get(res.runId) as { tokens_in: number; tokens_out: number; tokens_cache_read: number; tokens_cache_create: number }
    expect(row.tokens_in).toBe(1500)
    expect(row.tokens_out).toBe(1000)
    expect(row.tokens_cache_read).toBe(20000)
    expect(row.tokens_cache_create).toBe(2000)
  })

  it('preserves a provider scalar token total when no direction breakdown exists', async () => {
    const res = await manager(makeExecutors({
      runAiStep: vi.fn(async () => ({
        text: 'x', provider: 'claude', model: 'sonnet', tokens: 123,
      })),
    })).run({ ...baseReq(), graph: singleStepGraph() })

    const invocation = db.prepare(`
      SELECT tokens_in, tokens_out FROM ai_invocations
       WHERE surface = 'loop' AND loop_run_id = ?
    `).get(res.runId) as { tokens_in: number | null; tokens_out: number | null }
    expect(invocation).toMatchObject({ tokens_in: null, tokens_out: 123 })
    expect(getLoopRun(db, res.runId)?.total_tokens).toBe(123)
    expect(getJob(db, res.runId)).toMatchObject({ tokens_in: 0, tokens_out: 123 })
  })

  it('LOW-8: threads num_turns / session_id / duration_ms / duration_api_ms from the executor result to the loop row', async () => {
    const ex = makeExecutors({
      runAiStep: vi.fn(async () => ({
        text: 'x', cost: 0.05, provider: 'claude', model: 'sonnet',
        sessionId: 'sess-low8', numTurns: 7, durationMs: 4200, durationApiMs: 3100,
      })),
    })
    const res = await manager(ex).run({ ...baseReq(), graph: singleStepGraph() })
    expect(res.outcome).toBe('success')
    const row = db.prepare(
      `SELECT num_turns, session_id, duration_ms, duration_api_ms FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`
    ).get(res.runId) as { num_turns: number; session_id: string; duration_ms: number; duration_api_ms: number }
    expect(row.num_turns).toBe(7)
    expect(row.session_id).toBe('sess-low8')
    expect(row.duration_ms).toBe(4200)
    expect(row.duration_api_ms).toBe(3100)
  })

  it('BUG-03 (⊛ codex): a hard-failed AI step is recorded status=failed, not success', async () => {
    // A codex step that exits non-zero (quota/usage-limit) but still produces text
    // so it does NOT trip the fail-fast — the row must still be flagged failed.
    const ex = makeExecutors({
      runAiStep: vi.fn(async () => ({ text: 'partial', failed: true, errorText: "You've hit your usage limit", provider: 'codex', model: 'gpt-5.5', cost: 0.02, estimated: true })),
    })
    const res = await manager(ex).run({ ...baseReq(), graph: singleStepGraph(), provider: 'codex', model: 'gpt-5.5' })
    const row = db.prepare(
      `SELECT status, provider, total_cost_usd_estimated FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`
    ).get(res.runId) as { status: string; provider: string; total_cost_usd_estimated: number }
    expect(row.status).toBe('failed')
    expect(row.provider).toBe('codex')
    expect(row.total_cost_usd_estimated).toBe(1) // estimated cost preserved alongside the failed status
  })

  it('BUG-03: a successful AI step stays status=success (claude-only path unchanged)', async () => {
    const res = await manager(makeExecutors()).run({ ...baseReq(), graph: singleStepGraph() })
    const row = db.prepare(`SELECT status FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).get(res.runId) as { status: string }
    expect(row.status).toBe('success')
  })

  it('BUG-03: an unparseable Decider verdict (dec.parsed=false) is recorded status=failed', async () => {
    // ai-step succeeds (so no fail-fast), Decider can't parse but is treated as
    // continue → loop runs to the iteration cap; every decider row is failed.
    const ex = makeExecutors({
      runAiStep: vi.fn(async () => ({ text: 'ok', provider: 'claude', model: 'sonnet' })),
      runDecider: vi.fn(async () => ({ continue: true, reasoning: '(could not parse)', parsed: false, provider: 'claude', model: 'sonnet' })),
    })
    const res = await manager(ex).run({ ...baseReq(), graph: loopGraph(2) })
    const rows = db.prepare(`SELECT status FROM ai_invocations WHERE surface='loop' AND surface_ref_id LIKE '%:decider' AND loop_run_id=?`).all(res.runId) as { status: string }[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.status === 'failed')).toBe(true)
  })

  it('BUG-03: a parseable Decider verdict stays status=success', async () => {
    const res = await manager(makeExecutors()).run(baseReq())
    const rows = db.prepare(`SELECT status FROM ai_invocations WHERE surface='loop' AND surface_ref_id LIKE '%:decider' AND loop_run_id=?`).all(res.runId) as { status: string }[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.status === 'success')).toBe(true)
  })

  it('BUG-07: broadcasts spending.invalidated after each recorded invocation', async () => {
    const res = await manager(makeExecutors()).run(baseReq())
    const invalidations = broadcasts.filter((m) => m.type === 'spending.invalidated') as { type: string; projectId: string }[]
    // baseReq's default decider STOPS on the first call → 1 AI step + 1 decider =
    // 2 ai_invocations rows = exactly 2 spending.invalidated broadcasts. There must
    // be one broadcast per recorded row (and none on a claude-only project today
    // were emitted before this fix).
    const rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).get(res.runId) as { n: number }).n
    expect(invalidations.length).toBe(rowCount)
    expect(invalidations.length).toBe(2)
    expect(invalidations.every((m) => m.projectId === 'p1')).toBe(true)
  })

  it('BUG-07: a broadcast failure never breaks traversal', async () => {
    let calls = 0
    // Throw on every spending.invalidated broadcast; the run must still settle.
    const throwingBroadcast = (m: WsMessage) => {
      broadcasts.push(m)
      if (m.type === 'spending.invalidated') { calls += 1; throw new Error('ws down') }
    }
    const mgr = new LoopRunManager(db, throwingBroadcast, makeExecutors(), () => 1000)
    const res = await mgr.run({ ...baseReq(), graph: singleStepGraph() })
    expect(res.outcome).toBe('success')
    expect(calls).toBeGreaterThan(0) // the throwing path was exercised
  })

  it('BUG-32: started_at is the turn-START instant and finished_at the finish, not both at finish', async () => {
    // Advancing clock: each this.now() call returns a later ms. The step start is
    // captured before the await, the finish after → started_at < finished_at.
    let t = 1000
    const tickingNow = () => { t += 1000; return t }
    const ex = makeExecutors({
      // Burn a clock tick inside the step so its finish is strictly after its start.
      runAiStep: vi.fn(async () => ({ text: 'x', cost: 0.01, tokens: 10, tokensIn: 4, tokensOut: 6, provider: 'claude', model: 'sonnet' })),
    })
    const mgr = new LoopRunManager(db, (m) => broadcasts.push(m), ex, tickingNow)
    const res = await mgr.run({ ...baseReq(), graph: singleStepGraph() })
    const row = db.prepare(`SELECT started_at, finished_at FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).get(res.runId) as { started_at: string; finished_at: string }
    expect(row.started_at).toBeTruthy()
    expect(row.finished_at).toBeTruthy()
    // The row's started_at must be EARLIER than its finished_at (the bug stamped
    // both at the finish instant).
    expect(new Date(row.started_at).getTime()).toBeLessThan(new Date(row.finished_at).getTime())
  })
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

  it('adds unattended continuation context for on_review implement commands', async () => {
    const graph: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: '{{cmd:implement}}' } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }

    const ex = makeExecutors()
    await manager(ex).run({
      ...baseReq(),
      graph,
      spec: { ...baseReq().spec, id: 98, status: 'on_review' },
    })

    const prompt = (ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt
    expect(prompt).toContain('/specrails:implement #98 --yes')
    expect(prompt).toContain('Specrails rail continuation context')
    expect(prompt).toContain('do NOT pause')
    expect(prompt).toContain('review follow-ups on the current PR/worktree')
  })

  it('does not add review continuation context to new implement work', async () => {
    const graph: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: '{{cmd:implement}}' } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }

    const ex = makeExecutors()
    await manager(ex).run({
      ...baseReq(),
      graph,
      spec: { ...baseReq().spec, id: 98, status: 'todo' },
    })

    const prompt = (ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt
    expect(prompt).toContain('/specrails:implement #98 --yes')
    expect(prompt).not.toContain('Specrails rail continuation context')
  })

  it('does not add review continuation context to ordinary on_review prompts', async () => {
    const ex = makeExecutors()
    await manager(ex).run({
      ...baseReq(),
      spec: { ...baseReq().spec, id: 98, status: 'on_review' },
    })

    const prompt = (ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt
    expect(prompt).toContain('Implement Feature X')
    expect(prompt).not.toContain('Specrails rail continuation context')
  })

  it('adds unattended continuation context for literal on_review implement commands', async () => {
    const graph: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: '/specrails:implement #98 --yes' } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }

    const ex = makeExecutors()
    await manager(ex).run({
      ...baseReq(),
      graph,
      spec: { ...baseReq().spec, status: 'on_review' },
    })

    const prompt = (ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt
    expect(prompt).toContain('/specrails:implement #98 --yes')
    expect(prompt).toContain('Specrails rail continuation context')
  })

  it('pauses when an unattended AI step asks the human how to proceed, then resumes with the decision', async () => {
    const graph: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'implement', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: '{{cmd:implement}}' } },
        { id: 'verify', type: 'ai-step', position: { x: 0, y: 2 }, data: { prompt: '{{cmd:verify}}' } },
        { id: 'e', type: 'end', position: { x: 0, y: 3 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'implement' },
        { id: 'e2', source: 'implement', target: 'verify' },
        { id: 'e3', source: 'verify', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }
    const runAiStep = vi.fn(async () => {
      if (runAiStep.mock.calls.length === 1) {
        return {
          text: [
            'Before running the full pipeline, this is not a fresh feature to build.',
            '**How would you like to proceed?**',
            '1. Treat this as review follow-ups.',
            '2. Sync first.',
            "I haven't launched any agents yet, so no code has changed.",
            'openspec/changes/key-terms-matching-review-followups/',
          ].join('\n'),
          provider: 'claude',
          model: 'sonnet',
        }
      }
      return { text: 'continued after human decision', provider: 'claude', model: 'sonnet' }
    })
    const m = manager(makeExecutors({ runAiStep }))
    const runPromise = m.run({ ...baseReq(), runId: 'run-human-decision', graph })

    await waitFor(() => getLoopRun(db, 'run-human-decision')?.status === 'paused', 'loop pause')
    expect(runAiStep).toHaveBeenCalledTimes(1)
    expect(getLoopRun(db, 'run-human-decision')!.final_outcome).toBeNull()
    expect(broadcasts.some((msg) => msg.type === 'loop.run_paused')).toBe(true)
    expect(broadcasts.some((msg) => msg.type === 'log' && ((msg as { line?: string }).line ?? '').includes('Loop paused'))).toBe(true)
    expect(broadcasts.some((msg) => msg.type === 'log' && ((msg as { line?: string }).line ?? '').includes('Captured OpenSpec change id'))).toBe(false)

    expect(m.sendInteractiveTurn('run-human-decision', 'Use option 2 and implement only the delta.')).toBe(true)
    const res = await runPromise
    expect(res.outcome).toBe('success')
    expect(runAiStep).toHaveBeenCalledTimes(3)
    expect(getLoopRun(db, res.runId)!.final_outcome).toBe('success')
    expect((runAiStep as ReturnType<typeof vi.fn>).mock.calls[1][0].prompt).toContain('Use option 2')
  })

  it('pauses when an AI step emits LOOP_BLOCKED', async () => {
    const graph: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: '{{cmd:fix}}' } },
        { id: 'verify', type: 'ai-step', position: { x: 0, y: 2 }, data: { prompt: '{{cmd:verify}}' } },
        { id: 'e', type: 'end', position: { x: 0, y: 3 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'verify' },
        { id: 'e3', source: 'verify', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }
    const runAiStep = vi.fn(async () => (
      runAiStep.mock.calls.length === 1
        ? { text: 'LOOP_BLOCKED: Which review feedback should be applied?', provider: 'claude', model: 'sonnet' }
        : { text: 'applied selected feedback', provider: 'claude', model: 'sonnet' }
    ))

    const m = manager(makeExecutors({ runAiStep }))
    const runPromise = m.run({ ...baseReq(), runId: 'run-loop-blocked', graph })

    await waitFor(() => getLoopRun(db, 'run-loop-blocked')?.status === 'paused', 'loop pause')
    expect(runAiStep).toHaveBeenCalledTimes(1)
    expect(m.sendInteractiveTurn('run-loop-blocked', 'Apply feedback A.')).toBe(true)
    const res = await runPromise
    expect(res.outcome).toBe('success')
    expect(runAiStep).toHaveBeenCalledTimes(3)
    expect(broadcasts.some((m) => m.type === 'log' && ((m as { line?: string }).line ?? '').includes('Which review feedback should be applied?'))).toBe(true)
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

  it('legacy pin: a planner returning null falls through to the one-shot runAiStep (kill-switch shape)', async () => {
    // SPECRAILS_INTERACTIVE_JOBS=false (or a non-capable provider) makes the
    // production planner return null — the engine must then behave byte-identically
    // to the pre-interactive path: one-shot runAiStep with the legacy input shape,
    // no session registered, job row NOT flagged interactive.
    const planNull = vi.fn(() => null)
    const ex = makeExecutors({ planInteractiveAiStep: planNull })
    const mgr = manager(ex)
    const res = await mgr.run({ ...baseReq(), runId: 'run-legacy-pin' })
    expect(res.outcome).toBe('success')
    expect(planNull).toHaveBeenCalled()
    // One-shot path used, with the exact legacy argument shape.
    const call = (ex.runAiStep as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>
    expect(call.prompt).toContain('Implement Feature X')
    expect(call.provider).toBe('claude')
    expect(call.cwd).toBe('/repo')
    expect(typeof call.onRawLine).toBe('function')
    // No interactive residue.
    expect(mgr.isInteractiveJob('run-legacy-pin')).toBe(false)
    expect(mgr.sendInteractiveTurn('run-legacy-pin', 'hi')).toBe(false)
    const job = getJob(db, 'run-legacy-pin') as unknown as { interactive: number | null }
    expect(job.interactive ?? 0).toBe(0)
  })

  it('executors WITHOUT planInteractiveAiStep run the one-shot path (older fakes untouched)', async () => {
    const ex = makeExecutors() // no planInteractiveAiStep at all
    const res = await manager(ex).run(baseReq())
    expect(res.outcome).toBe('success')
    expect(ex.runAiStep).toHaveBeenCalled()
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

// ─── Interactive ai-steps (S2: all jobs interactive by default, loop path) ────
//
// The fake planner returns a REAL InteractiveAiStepPlan whose `spawn` yields a
// scripted fake child — so these tests exercise the genuine InteractiveJobSession
// (auto settle-mode, queue/extend, fold, abort) driven by the genuine engine,
// with only the process boundary faked (mirrors interactive-job-session.test.ts).

const tick = () => new Promise((r) => setImmediate(r))

async function waitFor(cond: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await tick()
  if (!cond()) throw new Error(`timed out waiting for ${label}`)
}

interface FakeChild extends EventEmitter {
  stdout: Readable
  stderr: Readable
  stdin: { write: (s: string) => boolean; destroyed: boolean }
  stdinWrites: string[]
  pid: number
  killed: boolean
  kill: (sig?: string) => boolean
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  const writes: string[] = []
  const stdin = new EventEmitter() as FakeChild['stdin'] & EventEmitter
  stdin.write = (s: string) => { writes.push(s); return true }
  stdin.destroyed = false
  child.stdin = stdin
  child.stdinWrites = writes
  child.pid = 4242
  child.killed = false
  child.kill = () => {
    child.killed = true
    queueMicrotask(() => child.emit('close', 0))
    return true
  }
  return child
}

function resultFrame(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    total_cost_usd: 0.05,
    num_turns: 3,
    model: 'claude-opus-4-8',
    session_id: 'sess-1',
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
    ...over,
  }) + '\n'
}

function assistantFrame(text = 'hello world'): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'
}

/** Executors whose planner upgrades every ai-step to a real interactive session
 *  over a fresh scripted fake child. Deciders/shell stay one-shot fakes. */
function interactiveExecutors(opts: { stepTimeoutMs?: number; over?: Partial<LoopExecutors> } = {}) {
  const children: FakeChild[] = []
  const planInputs: InteractivePlanInput[] = []
  const planInteractiveAiStep = vi.fn((input: InteractivePlanInput): InteractiveAiStepPlan => {
    planInputs.push(input)
    const child = makeFakeChild()
    children.push(child)
    return {
      adapter: getAdapter('claude'),
      spec: { binary: 'claude', args: ['-p', '--input-format', 'stream-json'], cwd: input.cwd },
      stepTimeoutMs: opts.stepTimeoutMs ?? 15 * 60_000,
      spawn: (() => child) as InteractiveAiStepPlan['spawn'],
      killTree: ((_pid, _signal, callback) => {
        child.killed = true
        callback?.()
        child.emit('close', 0)
      }) as NonNullable<InteractiveAiStepPlan['killTree']>,
    }
  })
  return {
    executors: makeExecutors({ planInteractiveAiStep, ...(opts.over ?? {}) }),
    children,
    planInputs,
    planInteractiveAiStep,
  }
}

function singleInteractiveGraph(aiStepTimeoutMinutes?: number): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Implement {{spec.title}}' } },
      { id: 'e', type: 'end', position: { x: 0, y: 2 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'ai' },
      { id: 'e2', source: 'ai', target: 'e' },
    ],
    config: { maxIterations: 5, timeoutMinutes: 30, ...(aiStepTimeoutMinutes != null ? { aiStepTimeoutMinutes } : {}) },
  }
}

describe('LoopRunManager interactive ai-steps', () => {
  it('happy path: session spawned, first frame = rendered prompt, interactive row, quiescence advances', async () => {
    const { executors, children, planInputs } = interactiveExecutors()
    const mgr = manager(executors)
    const p = mgr.run({ ...baseReq(), runId: 'run-int-1', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')

    // First stdin frame IS the step's rendered prompt ({{spec.*}} resolved).
    expect(children[0].stdinWrites.length).toBe(1)
    expect(children[0].stdinWrites[0]).toContain('Implement Feature X')
    expect(children[0].stdinWrites[0]).toContain('"role":"user"')
    // The planner received the engine's spawn context.
    expect(planInputs[0]).toMatchObject({ provider: 'claude', model: 'sonnet', cwd: '/repo' })
    expect(planInputs[0].sessionId).toBeUndefined()
    // The run's backing job row is flagged interactive while the step runs.
    const job = getJob(db, 'run-int-1') as unknown as {
      interactive: number | null; provider: string | null; owner: string
    }
    expect(job).toMatchObject({ interactive: 1, provider: 'claude', owner: 'loop' })
    expect(mgr.isInteractiveJob('run-int-1')).toBe(true)

    // Step-session availability flip (S3): a `job.interactive` broadcast marks
    // the resident session as accepting turns the moment it spawns.
    const stepOn = broadcasts.find((m) => m.type === 'job.interactive') as
      { jobId: string; acceptingTurns: boolean; settleMode: string; projectId: string } | undefined
    expect(stepOn).toBeDefined()
    expect(stepOn!.jobId).toBe('run-int-1')
    expect(stepOn!.acceptingTurns).toBe(true)
    expect(stepOn!.settleMode).toBe('auto')
    expect(stepOn!.projectId).toBe('p1')

    // Session-streamed provider events reach the SAME job stream the one-shot
    // path feeds: `event` with jobId + `log` with processId (part D).
    children[0].stdout.push(assistantFrame())
    await waitFor(() => broadcasts.some((m) => m.type === 'event' && (m as { event_type: string }).event_type === 'assistant'), 'assistant event')
    const evt = broadcasts.find((m) => m.type === 'event' && (m as { event_type: string }).event_type === 'assistant') as { jobId: string }
    expect(evt.jobId).toBe('run-int-1')
    expect(broadcasts.some((m) => m.type === 'log' && (m as { line: string; processId?: string }).line === 'hello world' && (m as { processId?: string }).processId === 'run-int-1')).toBe(true)

    // Turn result with nothing queued → quiescent → session settles → loop advances.
    children[0].stdout.push(resultFrame({ result: 'step complete' }))
    const res = await p
    expect(res.outcome).toBe('success')
    expect(mgr.isInteractiveJob('run-int-1')).toBe(false)

    // Exactly ONE ai_invocations row for the step, carrying the session's
    // accumulated REAL totals (no engine/session double-record).
    const rows = db.prepare(`SELECT * FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).all(res.runId) as Array<Record<string, unknown>>
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('success')
    expect(rows[0].tokens_in).toBe(100)
    expect(rows[0].tokens_out).toBe(200)
    expect(rows[0].tokens_cache_read).toBe(10)
    expect(rows[0].tokens_cache_create).toBe(5)
    expect(rows[0].total_cost_usd).toBeCloseTo(0.05)
    expect(rows[0].num_turns).toBe(3)
    expect(rows[0].session_id).toBe('sess-1')
    expect(rows[0].model).toBe('claude-opus-4-8')

    // Persisted events share ONE monotonic seq space across engine + session
    // writers (no collisions → GET /jobs/:id replays in order — part D).
    const events = getJobEvents(db, res.runId)
    const seqs = events.map((e) => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(events.some((e) => e.event_type === 'loop_step')).toBe(true) // engine-written
    expect(events.some((e) => e.event_type === 'assistant')).toBe(true) // session-written
    expect(events.some((e) => e.event_type === 'result')).toBe(true)

    // Run-level job.finalized still fires once, at run settle.
    const fin = broadcasts.filter((m) => m.type === 'job.finalized')
    expect(fin.length).toBe(1)
    expect((fin[0] as { status: string }).status).toBe('completed')

    // …and the settle side of the availability flip: the last `job.interactive`
    // marks the session gone (between steps / run over → composer waits).
    const flips = broadcasts.filter((m) => m.type === 'job.interactive') as Array<{ acceptingTurns: boolean }>
    expect(flips.length).toBe(2)
    expect(flips[flips.length - 1].acceptingTurns).toBe(false)
  })

  it('a mid-step user turn queues, extends the session, and accumulates onto the SINGLE step row', async () => {
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    const p = mgr.run({ ...baseReq(), runId: 'run-int-2', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')

    // Steer while turn 1 streams — accepted + queued.
    expect(mgr.sendInteractiveTurn('run-int-2', 'also update the docs')).toBe(true)
    const userMsg = broadcasts.filter((m) => m.type === 'job.turn_user').pop() as { queued: boolean; jobId: string }
    expect(userMsg.queued).toBe(true)
    expect(userMsg.jobId).toBe('run-int-2')

    // Turn 1 result → pending exists → the queued turn feeds; session does NOT settle.
    children[0].stdout.push(resultFrame())
    await waitFor(() => children[0].stdinWrites.length === 2, 'queued turn fed')
    expect(children[0].stdinWrites[1]).toContain('also update the docs')
    expect(children[0].killed).toBe(false)
    expect(mgr.isInteractiveJob('run-int-2')).toBe(true)

    // Turn 2 result, quiescent → settles → loop advances to End.
    children[0].stdout.push(resultFrame({ total_cost_usd: 0.1, num_turns: 6, result: 'docs updated' }))
    const res = await p
    expect(res.outcome).toBe('success')

    // ONE row for the step with BOTH turns' accumulated usage (tokens sum,
    // cost/turns as cumulative deltas — the session's HIGH-2 semantics).
    const rows = db.prepare(`SELECT * FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).all(res.runId) as Array<Record<string, unknown>>
    expect(rows.length).toBe(1)
    expect(rows[0].tokens_in).toBe(200)
    expect(rows[0].total_cost_usd).toBeCloseTo(0.1)
    expect(rows[0].num_turns).toBe(6)
  })

  it('finalizeInteractive settles the ACTIVE step now and the loop advances with what it produced', async () => {
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    const p = mgr.run({ ...baseReq(), runId: 'run-int-3', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')

    // Turn 1 completes, a second turn starts (so the finalize lands mid-stream).
    children[0].stdout.push(resultFrame({ result: 'first turn done' }))
    // Auto-settle races the next send — queue the next turn BEFORE the result is
    // processed so the session extends instead of settling.
    expect(mgr.sendInteractiveTurn('run-int-3', 'keep going')).toBe(true)
    await waitFor(() => children[0].stdinWrites.length === 2, 'turn 2 fed')

    // Human clicks Finalize mid-turn-2 → settle-now ('finalized', not crashed).
    expect(mgr.finalizeInteractive('run-int-3')).toBe(true)
    const res = await p
    expect(res.outcome).toBe('success') // step not failed → advances to End
    expect(mgr.finalizeInteractive('run-int-3')).toBe(false) // session gone
    expect(mgr.finalizeInteractive('run-unknown')).toBe(false)
    const row = db.prepare(`SELECT status FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).get(res.runId) as { status: string }
    expect(row.status).toBe('success')
  })

  it('iteration loops: one session per step, mid-pass resume, fresh at the iterate loop-back', async () => {
    // continue → a1 (the FIRST body step) = iterate-per-item loop: the engine
    // drops the resumed session at the loop-back, so pass 2's a1 plans FRESH.
    const { executors, children, planInputs } = interactiveExecutors({
      over: {
        runDecider: (() => {
          let d = 0
          return vi.fn(async () => (++d >= 2
            ? { continue: false, reasoning: 'done', parsed: true }
            : { continue: true, reasoning: 'more', parsed: true }))
        })(),
      },
    })
    const mgr = manager(executors)
    const p = mgr.run({ ...baseReq(), runId: 'run-int-4', graph: twoStepGraph('a1') })

    // pass 1: a1 fresh → a2 resumes → decider(continue) → pass 2: a1 FRESH → a2 resumes → decider(stop)
    for (let i = 0; i < 4; i++) {
      await waitFor(() => children.length === i + 1, `step ${i + 1} session`)
      children[i].stdout.push(resultFrame({ result: `step ${i + 1} ok` }))
    }
    const res = await p
    expect(res.outcome).toBe('success')
    expect(planInputs.length).toBe(4)
    expect(planInputs[0].sessionId).toBeUndefined()   // a1 pass 1 — fresh
    expect(planInputs[1].sessionId).toBe('sess-1')    // a2 pass 1 — resumes within the pass
    expect(planInputs[2].sessionId).toBeUndefined()   // a1 pass 2 — RESET at loop-back
    expect(planInputs[3].sessionId).toBe('sess-1')    // a2 pass 2 — resumes again
    // One ai_invocations row PER step (4 steps + 2 deciders).
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).get(res.runId) as { n: number }).n
    expect(n).toBe(6)
  })

  it('step timeout aborts the session (fold → crashed), records the step failed, never leaks the child', async () => {
    const { executors, children } = interactiveExecutors({ stepTimeoutMs: 40 })
    const mgr = manager(executors)
    const p = mgr.run({ ...baseReq(), runId: 'run-int-5', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')
    // The child streams work but never yields a `result` — the step timeout is
    // the sole watchdog and must bound the WHOLE step.
    children[0].stdout.push(assistantFrame('grinding'))

    const res = await p // resolves via the 40ms abort
    expect(res.outcome).toBe('success') // single-step graph still reaches End (step failed, run not)
    expect(children[0].killed).toBe(true)
    expect(mgr.isInteractiveJob('run-int-5')).toBe(false)
    // The timeout note reached the transcript.
    expect(broadcasts.some((m) => m.type === 'log' && /AI step timed out/.test((m as { line: string }).line))).toBe(true)
    // The step row is failed — and the folded in-flight turn's usage is kept.
    const row = db.prepare(`SELECT status, tokens_in FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).get(res.runId) as { status: string; tokens_in: number | null }
    expect(row.status).toBe('failed')
  })

  it('cancel mid-step aborts the session and settles the run stopped', async () => {
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    const p = mgr.run({ ...baseReq(), runId: 'run-int-6', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')
    mgr.cancel('run-int-6')
    const res = await p
    expect(res.outcome).toBe('stopped')
    expect(children[0].killed).toBe(true)
    expect(mgr.isInteractiveJob('run-int-6')).toBe(false)
    expect(getLoopRun(db, res.runId)!.final_outcome).toBe('stopped')
  })

  it('shutdown() checkpoints resident step accounting before disposal', async () => {
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    // Deliberately NOT awaited — shutdown records the interrupted step, while
    // startup later reconciles the run/job terminal rows.
    void mgr.run({ ...baseReq(), runId: 'run-int-7', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')
    mgr.shutdown()
    expect(children[0].killed).toBe(true)
    expect(mgr.isInteractiveJob('run-int-7')).toBe(false)
    await tick()
    const rows = db.prepare(`SELECT status FROM ai_invocations WHERE surface='loop'`).all() as Array<{ status: string }>
    expect(rows).toEqual([{ status: 'failed' }])
    expect(db.prepare(`SELECT 1 FROM loop_step_recovery WHERE run_id = 'run-int-7'`).get()).toBeUndefined()
  })

  it('sendInteractiveTurn routes only to the ACTIVE step session (false between/after steps)', async () => {
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    expect(mgr.sendInteractiveTurn('run-int-8', 'too early')).toBe(false)
    const p = mgr.run({ ...baseReq(), runId: 'run-int-8', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')
    expect(mgr.sendInteractiveTurn('run-int-8', 'mid-step')).toBe(true)
    children[0].stdout.push(resultFrame())
    await waitFor(() => children[0].stdinWrites.length === 2, 'queued turn fed')
    children[0].stdout.push(resultFrame({ total_cost_usd: 0.1, num_turns: 6 }))
    await p
    expect(mgr.sendInteractiveTurn('run-int-8', 'too late')).toBe(false)
  })

  it('structured events: loop_step_end lands AFTER the session\'s final persisted frames (seq pin)', async () => {
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    const p = mgr.run({ ...baseReq(), runId: 'run-int-ev', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')
    children[0].stdout.push(assistantFrame('working on it'))
    await waitFor(() => broadcasts.some((m) => m.type === 'event' && (m as { event_type: string }).event_type === 'assistant'), 'assistant event')
    children[0].stdout.push(resultFrame({ result: 'step complete' }))
    const res = await p
    expect(res.outcome).toBe('success')

    const events = getJobEvents(db, res.runId)
    const ends = events.filter((e) => e.event_type === 'loop_step_end')
    expect(ends.length).toBe(1)
    // The end event's seq is GREATER than every session-persisted frame's —
    // the shared allocator keeps replay order: step output first, then its end.
    const sessionFrames = events.filter((e) => e.event_type === 'assistant' || e.event_type === 'result')
    expect(sessionFrames.length).toBeGreaterThan(0)
    for (const frame of sessionFrames) expect(ends[0].seq).toBeGreaterThan(frame.seq)
    expect(JSON.parse(ends[0].payload)).toMatchObject({ index: 1, nodeId: 'ai', status: 'ok', exitCode: null })
  })

  it('structured events: a timed-out interactive step ends status=failed', async () => {
    const { executors, children } = interactiveExecutors({ stepTimeoutMs: 40 })
    const mgr = manager(executors)
    const p = mgr.run({ ...baseReq(), runId: 'run-int-ev-to', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')
    children[0].stdout.push(assistantFrame('grinding')) // never yields a result → 40ms abort
    const res = await p
    const ends = getJobEvents(db, res.runId).filter((e) => e.event_type === 'loop_step_end').map((e) => JSON.parse(e.payload) as { nodeId: string; status: string })
    expect(ends.length).toBe(1)
    expect(ends[0]).toMatchObject({ nodeId: 'ai', status: 'failed' })
  })

  it('structured events: cancel mid-step still closes the aborted step with a failed end', async () => {
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    const p = mgr.run({ ...baseReq(), runId: 'run-int-ev-cancel', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')
    mgr.cancel('run-int-ev-cancel')
    const res = await p
    expect(res.outcome).toBe('stopped')
    const ends = getJobEvents(db, res.runId).filter((e) => e.event_type === 'loop_step_end').map((e) => JSON.parse(e.payload) as { nodeId: string; status: string })
    expect(ends.length).toBe(1)
    expect(ends[0]).toMatchObject({ nodeId: 'ai', status: 'failed' })
  })

  it('structured events: shutdown mid-step leaves the step WITHOUT an end event (missing-end = interrupted)', async () => {
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    // Deliberately NOT awaited — dispose never settles the step's promise.
    void mgr.run({ ...baseReq(), runId: 'run-int-ev-shut', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')
    mgr.shutdown()
    await tick()
    const events = getJobEvents(db, 'run-int-ev-shut')
    expect(events.some((e) => e.event_type === 'loop_step')).toBe(true) // the step opened…
    expect(events.some((e) => e.event_type === 'loop_step_end')).toBe(false) // …and was never closed
  })

  it('isolated-rail pin: the worktree cwd/repoDir reach the planner + the step timeout is threaded', async () => {
    const { executors, children, planInputs } = interactiveExecutors()
    const mgr = manager(executors)
    const p = mgr.run({
      ...baseReq(),
      runId: 'run-int-9',
      cwd: '/wt/ticket-42',
      repoDir: '/wt/ticket-42', // rail-isolated-launch passes worktree for BOTH
      graph: singleInteractiveGraph(2), // aiStepTimeoutMinutes: 2
      isolation: { branch: 'sr/t-42', worktreePath: '/wt/ticket-42' },
    })
    await waitFor(() => children.length === 1, 'session spawn')
    expect(planInputs[0]).toMatchObject({
      cwd: '/wt/ticket-42',
      repoDir: '/wt/ticket-42',
      aiStepTimeoutMs: 2 * 60_000,
    })
    children[0].stdout.push(resultFrame({ result: 'done' }))
    const res = await p
    expect(res.outcome).toBe('success')
  })
})

// ─── Zero-work ai-steps (run 01f41203: synthetic "Unknown command" frame) ─────
// The claude CLI answers an unresolvable command with a SYNTHETIC success
// result frame (num_turns 0, cost 0, no assistant events, result = 'Unknown
// command: …') — no model ever ran. A step whose settle is zero-work is FAILED
// and routes exactly like a crashed step (fail-fast counting included), so the
// factory loop can never "succeed" without implementing.

/** The EXACT synthetic frame shape captured from the live run. */
function syntheticUnknownCommandFrame(command = '/specrails:implement'): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 0,
    total_cost_usd: 0,
    duration_api_ms: 0,
    result: `Unknown command: ${command}`,
  }) + '\n'
}

// Start → a1 → a2 → End: two consecutive ai-steps, no decider — the minimal
// graph where a first-step failure (crashed OR zero-work) trips the fail-fast
// threshold on the second and settles the RUN failed.
function twoAiStepGraph(): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'a1', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: '{{cmd:implement}}' } },
      { id: 'a2', type: 'ai-step', position: { x: 0, y: 2 }, data: { prompt: 'verify' } },
      { id: 'e', type: 'end', position: { x: 0, y: 3 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'a2' },
      { id: 'e3', source: 'a2', target: 'e' },
    ],
    config: { maxIterations: 5, timeoutMinutes: 30 },
  }
}

describe('LoopRunManager zero-work ai-steps', () => {
  function endPayloads(runId: string): Array<{ nodeId: string; status: string }> {
    return getJobEvents(db, runId)
      .filter((e) => e.event_type === 'loop_step_end')
      .map((e) => JSON.parse(e.payload) as { nodeId: string; status: string })
  }

  it("interactive step: the synthetic frame fails the step — loop_step_end status='failed', row failed, text visible", async () => {
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    const p = mgr.run({ ...baseReq(), runId: 'run-zw-1', graph: singleInteractiveGraph() })
    await waitFor(() => children.length === 1, 'session spawn')
    children[0].stdout.push(syntheticUnknownCommandFrame('/specrails:implement'))
    const res = await p

    // The step ended FAILED (was 'ok' before the fix — the factory loop then
    // "succeeded" via verify/fix without implementing).
    const ends = endPayloads(res.runId)
    expect(ends.length).toBe(1)
    expect(ends[0]).toMatchObject({ nodeId: 'ai', status: 'failed' })
    // One zero-work step alone does not abort the run — the graph routes on,
    // exactly like a crashed step today (single-step graph reaches End).
    expect(res.outcome).toBe('success')

    // The step's ai_invocations row is failed.
    const row = db.prepare(`SELECT status, total_cost_usd, num_turns FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).get(res.runId) as { status: string; total_cost_usd: number; num_turns: number }
    expect(row.status).toBe('failed')
    expect(row.num_turns).toBe(0)

    // The 'Unknown command' text lands VISIBLY as a stderr-style line INSIDE
    // the step's segment (before its loop_step_end — Template/Command flat-log
    // lines are gone, so this is the only visible trace of the reason).
    const events = getJobEvents(db, res.runId)
    const note = events.find(
      (e) => e.event_type === 'log' && ((JSON.parse(e.payload) as { line?: string }).line ?? '').includes('Unknown command: /specrails:implement'),
    )
    expect(note).toBeTruthy()
    const end = events.find((e) => e.event_type === 'loop_step_end')!
    expect(note!.seq).toBeLessThan(end.seq)
    // …and it reached the live stream as a stderr log broadcast.
    expect(broadcasts.some((m) => m.type === 'log' && (m as { source?: string }).source === 'stderr' && ((m as { line?: string }).line ?? '').includes('Unknown command'))).toBe(true)
  })

  it('routing pin: a zero-work FIRST step fails the run the SAME way a crashed first step does', async () => {
    // Run A — crashed steps (child dies without a result): today's policy is
    // continue + fail-fast, aborting the run on the 2nd consecutive failure.
    const crashed = interactiveExecutors()
    const pA = manager(crashed.executors).run({ ...baseReq(), runId: 'run-zw-crash', graph: twoAiStepGraph() })
    await waitFor(() => crashed.children.length === 1, 'crashed a1 spawn')
    crashed.children[0].emit('close', 1)
    await waitFor(() => crashed.children.length === 2, 'crashed a2 spawn')
    crashed.children[1].emit('close', 1)
    const resA = await pA

    // Run B — zero-work steps (the synthetic frame): must take the SAME path.
    const zw = interactiveExecutors()
    const pB = manager(zw.executors).run({ ...baseReq(), runId: 'run-zw-pin', graph: twoAiStepGraph() })
    await waitFor(() => zw.children.length === 1, 'zw a1 spawn')
    zw.children[0].stdout.push(syntheticUnknownCommandFrame())
    await waitFor(() => zw.children.length === 2, 'zw a2 spawn')
    zw.children[1].stdout.push(syntheticUnknownCommandFrame())
    const resB = await pB

    // Identical routing: both runs abort 'failed' via the fail-fast threshold
    // after exactly two ai-steps, with identical per-step end statuses.
    // durationMs is wall-clock noise (0 vs 1 ms flake) — normalize it out.
    const stripDuration = (ends: Array<{ nodeId: string; status: string }>) =>
      ends.map(({ durationMs: _d, ...rest }: { nodeId: string; status: string; durationMs?: number }) => rest)
    expect(resA.outcome).toBe('failed')
    expect(resB.outcome).toBe(resA.outcome)
    expect(zw.children.length).toBe(crashed.children.length)
    expect(stripDuration(endPayloads(resB.runId))).toEqual(stripDuration(endPayloads(resA.runId)))
    expect(getLoopRun(db, resB.runId)!.final_outcome).toBe(getLoopRun(db, resA.runId)!.final_outcome)
  })

  it('one-shot path: an all-zero result (no turns, no tokens, no text) is detected by the engine and fails the step', async () => {
    // The one-shot claude spawn of the same bug: the synthetic frame yields
    // num_turns 0 / zero usage / native cost 0 and NO assistant text-deltas.
    const g: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: '{{cmd:implement}}' } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }
    const runAiStep = vi.fn(async () => ({
      text: '',
      cost: 0,
      tokens: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      tokensCacheCreate: 0,
      numTurns: 0,
      provider: 'claude',
      model: 'sonnet',
    }))
    const res = await manager(makeExecutors({ runAiStep })).run({ ...baseReq(), graph: g })

    const ends = endPayloads(res.runId)
    expect(ends[0]).toMatchObject({ nodeId: 'ai', status: 'failed' })
    const row = db.prepare(`SELECT status FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).get(res.runId) as { status: string }
    expect(row.status).toBe('failed')
    // The engine surfaces its own zero-work note (no session exists to do it).
    const note = getJobEvents(db, res.runId).find(
      (e) => e.event_type === 'log' && ((JSON.parse(e.payload) as { line?: string }).line ?? '').includes('Zero work performed'),
    )
    expect(note).toBeTruthy()
  })

  it('one-shot path: a productive step (assistant text streamed) is NOT flagged zero-work', async () => {
    // The default fixture reports text but no numeric fields at all — the
    // engine must treat streamed assistant text as work, never failing it.
    const res = await manager(makeExecutors()).run(baseReq())
    expect(res.outcome).toBe('success')
    const aiEnd = endPayloads(res.runId).find((e) => e.nodeId === 'ai')!
    expect(aiEnd.status).toBe('ok')
    const row = db.prepare(`SELECT status FROM ai_invocations WHERE surface='loop' AND loop_run_id=? AND surface_ref_id NOT LIKE '%decider'`).get(res.runId) as { status: string }
    expect(row.status).toBe('success')
  })
})

describe('LoopRunManager crash-consistent accounting', () => {
  it('replays the Decider iteration count from its durable step checkpoint', () => {
    createLoopRun(db, {
      id: 'iteration-replay', projectId: 'p1', loopId: 'loop-1',
      iterationLimit: 5, startedAt: '2026-07-10T00:00:00.000Z',
    })
    createJob(db, {
      id: 'iteration-replay', command: 'loop: iteration',
      started_at: '2026-07-10T00:00:00.000Z', owner: 'loop',
    })
    stageLoopStepRecovery(db, {
      version: 1,
      runId: 'iteration-replay',
      stepKey: 'decider:1:d',
      invocationId: 'iteration-replay-invocation',
      projectId: 'p1',
      provider: 'claude',
      model: 'sonnet',
      surfaceRefId: 'loop:iteration-replay:decider',
      ticketIds: [42],
      startedAt: '2026-07-10T00:00:00.000Z',
      baseline: {
        tokensIn: 0, tokensOut: 0, tokensCacheRead: 0,
        tokensCacheCreate: 0, totalCostUsd: 0, numTurns: 0,
      },
      completedEventSeq: -1,
      providerCostBaseline: 0,
      providerTurnsBaseline: 0,
      loopDurationBaseline: 0,
      completedDurationMs: 0,
      iterationCount: 3,
      settledResult: {
        cost: 0.02, tokens: 12, tokensIn: 7, tokensOut: 5,
        durationMs: 9, numTurns: 1, provider: 'claude', model: 'sonnet',
      },
    })

    expect(recoverOrphanLoopStepAccounting(db, '2026-07-10T00:00:01.000Z', 'iteration-replay')).toBe(1)
    expect(getLoopRun(db, 'iteration-replay')).toMatchObject({
      iteration_count: 3,
      total_cost_usd: 0.02,
      total_tokens: 12,
      total_duration_ms: 9,
    })
  })

  it('preserves unavailable Kimi telemetry while recovering an orphan step', () => {
    createLoopRun(db, {
      id: 'kimi-orphan', projectId: 'p1', loopId: 'loop-1',
      iterationLimit: 5, startedAt: '2026-07-10T00:00:00.000Z',
    })
    createJob(db, {
      id: 'kimi-orphan', command: 'loop: kimi',
      started_at: '2026-07-10T00:00:00.000Z', owner: 'loop',
      provider: 'kimi',
    })
    stageLoopStepRecovery(db, {
      version: 1,
      runId: 'kimi-orphan',
      stepKey: 'ai:1:kimi',
      invocationId: 'kimi-orphan-invocation',
      projectId: 'p1',
      provider: 'kimi',
      model: 'k3',
      surfaceRefId: 'loop:kimi-orphan:ai',
      ticketIds: [42],
      startedAt: '2026-07-10T00:00:00.000Z',
      baseline: {
        tokensIn: 0, tokensOut: 0, tokensCacheRead: 0,
        tokensCacheCreate: 0, totalCostUsd: 0, numTurns: 0,
      },
      completedEventSeq: -1,
      providerCostBaseline: 0,
      providerTurnsBaseline: 0,
      loopDurationBaseline: 0,
      completedDurationMs: 0,
    })

    expect(recoverOrphanLoopStepAccounting(
      db,
      '2026-07-10T00:00:01.000Z',
      'kimi-orphan',
    )).toBe(1)
    expect(db.prepare(`
      SELECT provider, total_cost_usd, tokens_in, tokens_out,
             tokens_cache_read, tokens_cache_create, num_turns
        FROM ai_invocations WHERE loop_run_id = 'kimi-orphan'
    `).get()).toEqual({
      provider: 'kimi',
      total_cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cache_read: null,
      tokens_cache_create: null,
      num_turns: null,
    })
  })

  it('rolls back ticket/rail ownership and the loop row when backing-job admission fails', async () => {
    db.exec(`
      CREATE TRIGGER reject_loop_backing_job
      BEFORE INSERT ON jobs
      WHEN NEW.id = 'atomic-launch-failure'
      BEGIN SELECT RAISE(ABORT, 'backing job admission failed'); END;
    `)

    await expect(manager(makeExecutors()).run({
      ...baseReq(), runId: 'atomic-launch-failure', graph: singleInteractiveGraph(),
    })).rejects.toThrow('backing job admission failed')

    expect(getLoopRun(db, 'atomic-launch-failure')).toBeUndefined()
    expect(getJob(db, 'atomic-launch-failure')).toBeUndefined()
    expect(db.prepare(`SELECT 1 FROM ticket_outcome_ownership WHERE owner_id = ?`).get('atomic-launch-failure'))
      .toBeUndefined()
    expect(db.prepare(`SELECT 1 FROM rail_ticket_ownership WHERE owner_id = ?`).get('atomic-launch-failure'))
      .toBeUndefined()
  })

  it('treats every websocket broadcast as advisory to the durable run', async () => {
    const mgr = new LoopRunManager(
      db,
      () => { throw new Error('websocket disconnected') },
      makeExecutors(),
      () => 1_000,
    )

    const res = await mgr.run({ ...baseReq(), runId: 'broadcast-failure' })

    expect(res.outcome).toBe('success')
    expect(getLoopRun(db, res.runId)).toMatchObject({ status: 'completed', final_outcome: 'success' })
    expect(getJob(db, res.runId)).toMatchObject({ status: 'completed', causal_ownership: 1 })
  })

  it('recovers only completed-turn delta from a hard crash checkpoint', async () => {
    let wallMs = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
      wallMs += 25
      return wallMs
    })
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    try {
      void mgr.run({ ...baseReq(), runId: 'hard-completed', graph: singleInteractiveGraph() })
      await waitFor(() => children.length === 1, 'interactive spawn')
      expect(mgr.sendInteractiveTurn('hard-completed', 'second turn')).toBe(true)
      children[0].stdout.push(assistantFrame('first turn work'))
      children[0].stdout.push(resultFrame())
      await waitFor(() => children[0].stdinWrites.length === 2, 'second turn write')
      children[0].stderr.push('second turn is active\n')
      await tick()

      const checkpoint = JSON.parse((db.prepare(`
        SELECT payload FROM loop_step_recovery WHERE run_id = 'hard-completed'
      `).get() as { payload: string }).payload) as {
        completedDurationMs: number
        activeTurnStartedAtMs: number
        lastActivityAtMs: number
      }
      const expectedDuration = checkpoint.completedDurationMs
        + checkpoint.lastActivityAtMs - checkpoint.activeTurnStartedAtMs

      expect(recoverOrphanLoopStepAccounting(db, '2026-07-10T00:00:00.000Z', 'hard-completed')).toBe(1)
      const rows = db.prepare(`
        SELECT tokens_in, tokens_out, total_cost_usd, num_turns, duration_ms
          FROM ai_invocations WHERE loop_run_id = 'hard-completed'
      `).all() as Array<Record<string, number>>
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ tokens_in: 100, tokens_out: 200, total_cost_usd: 0.05, num_turns: 3 })
      expect(rows[0].duration_ms).toBe(expectedDuration)
      expect(getLoopRun(db, 'hard-completed')?.total_duration_ms).toBe(rows[0].duration_ms)
      expect(getJob(db, 'hard-completed')?.duration_ms).toBe(rows[0].duration_ms)
      expect(recoverOrphanLoopStepAccounting(db, '2026-07-10T00:00:01.000Z', 'hard-completed')).toBe(0)
    } finally {
      mgr.shutdown()
      dateNow.mockRestore()
    }
  })

  it('fail-stops the interactive step when the jobs+frontier transaction rolls back', async () => {
    db.exec(`
      CREATE TRIGGER reject_completed_turn_frontier
      BEFORE UPDATE ON loop_step_recovery
      WHEN json_extract(NEW.payload, '$.completedEventSeq')
             > json_extract(OLD.payload, '$.completedEventSeq')
      BEGIN SELECT RAISE(ABORT, 'simulated frontier checkpoint failure'); END;
    `)
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    const run = mgr.run({
      ...baseReq(), runId: 'frontier-fail-stop', graph: singleInteractiveGraph(),
    })
    await waitFor(() => children.length === 1, 'interactive spawn')
    expect(mgr.sendInteractiveTurn('frontier-fail-stop', 'must not run')).toBe(true)

    children[0].stdout.push(resultFrame())
    await tick()
    await tick()
    // Defensive cleanup for the pre-fix behavior so the promise cannot hang:
    // it swallowed the checkpoint error and fed the queued second prompt.
    if (children[0].stdinWrites.length > 1) {
      children[0].stdout.push(resultFrame({ total_cost_usd: 0.1, num_turns: 6 }))
    }
    const res = await run

    expect(res.outcome).toBe('success')
    expect(children[0].stdinWrites).toHaveLength(1)
    expect(broadcasts.some((message) => message.type === 'job.turn_done')).toBe(false)
    expect(db.prepare(`
      SELECT tokens_in, tokens_out, total_cost_usd, num_turns, status
        FROM ai_invocations WHERE loop_run_id = 'frontier-fail-stop'
    `).get()).toMatchObject({
      tokens_in: 100,
      tokens_out: 200,
      total_cost_usd: 0.05,
      num_turns: 3,
      status: 'failed',
    })
    expect(getJob(db, 'frontier-fail-stop')).toMatchObject({
      tokens_in: 100,
      tokens_out: 200,
      total_cost_usd: 0.05,
      num_turns: 3,
    })
    expect(db.prepare(`SELECT 1 FROM loop_step_recovery WHERE run_id = 'frontier-fail-stop'`).get())
      .toBeUndefined()
  })

  it('fail-stops on raw event persistence failure without losing streamed usage', async () => {
    db.exec(`
      CREATE TRIGGER reject_loop_assistant_event
      BEFORE INSERT ON events
      WHEN NEW.job_id = 'raw-persist-fail' AND NEW.event_type = 'assistant'
      BEGIN SELECT RAISE(ABORT, 'simulated raw event write failure'); END;
    `)
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    const run = mgr.run({
      ...baseReq(), runId: 'raw-persist-fail', graph: singleInteractiveGraph(),
    })
    await waitFor(() => children.length === 1, 'interactive spawn')
    children[0].stdout.push(JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 50, output_tokens: 25 },
        content: [{ type: 'text', text: 'partial durable work' }],
      },
    }) + '\n')

    const res = await run

    expect(res.outcome).toBe('success')
    expect(children[0].stdinWrites).toHaveLength(1)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE job_id = 'raw-persist-fail' AND event_type = 'assistant'`).get())
      .toEqual({ n: 0 })
    expect(db.prepare(`
      SELECT status, tokens_in, tokens_out
        FROM ai_invocations WHERE loop_run_id = 'raw-persist-fail'
    `).get()).toMatchObject({ status: 'failed', tokens_in: 50, tokens_out: 25 })
    expect(getJob(db, 'raw-persist-fail')).toMatchObject({ tokens_in: 50, tokens_out: 25 })
  })

  it('recovers raw in-flight usage when no result checkpoint committed', async () => {
    let wallMs = 2_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
      wallMs += 20
      return wallMs
    })
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    try {
      void mgr.run({ ...baseReq(), runId: 'hard-inflight', graph: singleInteractiveGraph() })
      await waitFor(() => children.length === 1, 'interactive spawn')
      children[0].stdout.push(JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          usage: { input_tokens: 50, output_tokens: 25, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
          content: [{ type: 'text', text: 'partial work' }],
        },
      }) + '\n')
      await tick()
      const checkpoint = JSON.parse((db.prepare(`
        SELECT payload FROM loop_step_recovery WHERE run_id = 'hard-inflight'
      `).get() as { payload: string }).payload) as {
        activeTurnStartedAtMs: number
        lastActivityAtMs: number
      }
      const observedDuration = checkpoint.lastActivityAtMs - checkpoint.activeTurnStartedAtMs
      const boundedFinishedAtMs = checkpoint.activeTurnStartedAtMs + Math.max(1, Math.floor(observedDuration / 2))
      const expectedDuration = boundedFinishedAtMs - checkpoint.activeTurnStartedAtMs

      expect(recoverOrphanLoopStepAccounting(
        db,
        new Date(boundedFinishedAtMs).toISOString(),
        'hard-inflight',
      )).toBe(1)
      const row = db.prepare(`
        SELECT status, tokens_in, tokens_out, duration_ms
          FROM ai_invocations WHERE loop_run_id = 'hard-inflight'
      `).get() as { status: string; tokens_in: number; tokens_out: number; duration_ms: number }
      expect(row).toMatchObject({
        status: 'failed', tokens_in: 50, tokens_out: 25, duration_ms: expectedDuration,
      })
      expect(expectedDuration).toBeGreaterThan(0)
      expect(expectedDuration).toBeLessThan(observedDuration)
    } finally {
      mgr.shutdown()
      dateNow.mockRestore()
    }
  })

  it('rolls invocation back with checkpoint failure, then replays once', async () => {
    db.exec(`
      CREATE TRIGGER reject_loop_step_checkpoint_delete
      BEFORE DELETE ON loop_step_recovery
      BEGIN SELECT RAISE(ABORT, 'checkpoint delete failed'); END;
    `)
    const res = await manager(makeExecutors()).run({
      ...baseReq(), runId: 'checkpoint-rollback', graph: singleInteractiveGraph(),
    })
    expect(res.outcome).toBe('failed')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_invocations WHERE loop_run_id = 'checkpoint-rollback'`).get())
      .toMatchObject({ n: 0 })
    expect(db.prepare(`SELECT 1 FROM loop_step_recovery WHERE run_id = 'checkpoint-rollback'`).get()).toBeDefined()

    db.exec(`DROP TRIGGER reject_loop_step_checkpoint_delete`)
    expect(recoverOrphanLoopStepAccounting(db, '2026-07-10T00:00:00.000Z', 'checkpoint-rollback')).toBe(1)
    expect(recoverOrphanLoopStepAccounting(db, '2026-07-10T00:00:01.000Z', 'checkpoint-rollback')).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_invocations WHERE loop_run_id = 'checkpoint-rollback'`).get())
      .toMatchObject({ n: 1 })
  })

  it('preserves AI plus shell duration when a later checkpoint is replayed', async () => {
    db.exec(`
      CREATE TRIGGER reject_decider_checkpoint_delete
      BEFORE DELETE ON loop_step_recovery
      WHEN OLD.step_key LIKE 'decider:%'
      BEGIN SELECT RAISE(ABORT, 'decider checkpoint delete failed'); END;
    `)
    const res = await manager(makeExecutors({
      runAiStep: vi.fn(async () => ({
        text: 'worked', provider: 'claude', model: 'sonnet', durationMs: 11,
      })),
      runShell: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 13 })),
      runDecider: vi.fn(async () => ({
        continue: false, reasoning: 'done', parsed: true,
        provider: 'claude', model: 'sonnet', durationMs: 17,
      })),
    })).run({ ...baseReq(), runId: 'duration-replay' })

    expect(res.outcome).toBe('failed')
    expect(db.prepare(`SELECT 1 FROM loop_step_recovery WHERE run_id = ?`).get(res.runId)).toBeDefined()
    // While recovery is pending, finishLoopRunAndJob preserves the durable AI
    // baseline instead of publishing guessed aggregate columns.
    expect(getJob(db, res.runId)?.duration_ms).toBe(11)

    db.exec(`DROP TRIGGER reject_decider_checkpoint_delete`)
    expect(recoverOrphanLoopStepAccounting(db, '2026-07-10T00:00:00.000Z', res.runId)).toBe(1)
    expect(getLoopRun(db, res.runId)?.total_duration_ms).toBe(41)
    expect(getJob(db, res.runId)?.duration_ms).toBe(41)
  })

  it('resyncs traversal locals after inline raw recovery before terminal finish', async () => {
    const shellThenAi: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'sh', type: 'shell', position: { x: 0, y: 1 }, data: { command: 'prepare' } },
        { id: 'ai', type: 'ai-step', position: { x: 0, y: 2 }, data: { prompt: 'work' } },
        { id: 'e', type: 'end', position: { x: 0, y: 3 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'sh' },
        { id: 'e2', source: 'sh', target: 'ai' },
        { id: 'e3', source: 'ai', target: 'e' },
      ],
      config: { maxIterations: 3, timeoutMinutes: 30 },
    }
    const runAiStep = vi.fn(async (input: Parameters<LoopExecutors['runAiStep']>[0]) => {
      input.onRawLine?.(resultFrame({ duration_ms: 17 }))
      throw new Error('executor crashed after durable result')
    })

    const res = await manager(makeExecutors({
      runShell: vi.fn(async () => ({ stdout: 'ready', stderr: '', exitCode: 0, durationMs: 13 })),
      runAiStep,
    })).run({ ...baseReq(), runId: 'inline-resync', graph: shellThenAi })

    expect(res.outcome).toBe('failed')
    expect(getLoopRun(db, res.runId)).toMatchObject({
      total_cost_usd: 0.05,
      total_tokens: 300,
      total_duration_ms: 30,
    })
    expect(getJob(db, res.runId)).toMatchObject({
      total_cost_usd: 0.05,
      tokens_in: 100,
      tokens_out: 200,
      duration_ms: 30,
    })
    expect(db.prepare(`SELECT duration_ms FROM ai_invocations WHERE loop_run_id = ?`).get(res.runId))
      .toEqual({ duration_ms: 17 })
  })

  it('splits scope=all usage across every ticket with exact aggregate totals', async () => {
    const runAiStep = vi.fn(async () => ({
      text: 'done', cost: 0.8, tokens: 152,
      tokensIn: 101, tokensOut: 51, tokensCacheRead: 9, tokensCacheCreate: 3,
      numTurns: 3, durationMs: 21, provider: 'claude', model: 'sonnet',
    }))
    const res = await manager(makeExecutors({ runAiStep })).run({
      ...baseReq(), runId: 'scope-all', graph: singleInteractiveGraph(),
      spec: { ...baseReq().spec, ticketIds: [42, 43] },
    })
    const rows = db.prepare(`
      SELECT ticket_id, total_cost_usd, tokens_in, tokens_out, num_turns
        FROM ai_invocations WHERE loop_run_id = ? ORDER BY ticket_id
    `).all(res.runId) as Array<{ ticket_id: number; total_cost_usd: number; tokens_in: number; tokens_out: number; num_turns: number }>
    expect(rows.map((row) => row.ticket_id)).toEqual([42, 43])
    expect(rows.reduce((sum, row) => sum + row.total_cost_usd, 0)).toBeCloseTo(0.8)
    expect(rows.reduce((sum, row) => sum + row.tokens_in, 0)).toBe(101)
    expect(rows.reduce((sum, row) => sum + row.tokens_out, 0)).toBe(51)
    expect(rows.reduce((sum, row) => sum + row.num_turns, 0)).toBe(3)
    const completed = broadcasts.find((msg) => msg.type === 'loop.run_completed') as { ticketIds: number[] }
    expect(completed.ticketIds).toEqual([42, 43])
  })

  it('shutdown during the first interactive node never spawns the next node', async () => {
    const { executors, children } = interactiveExecutors()
    const mgr = manager(executors)
    const graph = twoStepGraph('a1')
    void mgr.run({ ...baseReq(), runId: 'shutdown-no-respawn', graph })
    await waitFor(() => children.length === 1, 'first interactive spawn')
    mgr.shutdown()
    await tick()
    await tick()
    expect(children).toHaveLength(1)
    expect(getLoopRun(db, 'shutdown-no-respawn')).toMatchObject({ status: 'running' })
  })
})

// ─── Structured run events: loop_graph / loop_step / loop_step_end ───────────
// The premium loop-step log explorer's server contract: a per-run graph
// snapshot first, an enriched loop_step before each step, a loop_step_end at
// each step's tail — all persisted on the run's job row + broadcast.

describe('LoopRunManager structured run events', () => {
  /** Payloads of one persisted event type, in seq order. */
  function payloads(runId: string, eventType: string): Array<Record<string, unknown>> {
    return getJobEvents(db, runId)
      .filter((e) => e.event_type === eventType)
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
  }

  it('emits loop_graph ONCE at run start — before the first loop_step, with the verbatim graph snapshot', async () => {
    const req = baseReq()
    const res = await manager(makeExecutors()).run(req)

    const events = getJobEvents(db, res.runId)
    const graphEvents = events.filter((e) => e.event_type === 'loop_graph')
    expect(graphEvents.length).toBe(1)
    // Exact payload: the run's graph VERBATIM (snapshot survives later loop
    // edits/deletes) + the run identity/config the client renders from.
    expect(JSON.parse(graphEvents[0].payload)).toEqual({
      graph: req.graph,
      loopId: 'loop-1',
      loopName: 'Ship & Verify',
      provider: 'claude',
      model: 'sonnet',
      iterationLimit: 10,
    })
    // Ordering: snapshot precedes the first step in the persisted seq order.
    const firstStep = events.find((e) => e.event_type === 'loop_step')!
    expect(graphEvents[0].seq).toBeLessThan(firstStep.seq)
    // The broadcast mirror also fired exactly once.
    const bc = broadcasts.filter((m) => m.type === 'event' && (m as { event_type: string }).event_type === 'loop_graph')
    expect(bc.length).toBe(1)
  })

  it('loop_step carries nodeId + 1-based iteration, incrementing across iterations (decider included)', async () => {
    let d = 0
    const ex = makeExecutors({
      runDecider: vi.fn(async () => (++d >= 2
        ? { continue: false, reasoning: 'done', parsed: true }
        : { continue: true, reasoning: 'more', parsed: true })),
    })
    const res = await manager(ex).run(baseReq())
    expect(res.iterations).toBe(2)

    const steps = payloads(res.runId, 'loop_step')
    // pass 1: ai → shell → decider (continue) / pass 2: ai → shell → decider (stop)
    expect(steps.map((s) => [s.kind, s.nodeId, s.iteration])).toEqual([
      ['ai-step', 'ai', 1],
      ['shell', 'sh', 1],
      ['decider', 'd', 1],
      ['ai-step', 'ai', 2],
      ['shell', 'sh', 2],
      ['decider', 'd', 2],
    ])
    // index is a run-wide monotonic ordinal; title is always present.
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6])
    expect(steps.every((s) => typeof s.title === 'string' && (s.title as string).length > 0)).toBe(true)
    // The decider end events carry the routed verdicts: continue then stop.
    const deciderEnds = payloads(res.runId, 'loop_step_end').filter((e) => e.nodeId === 'd')
    expect(deciderEnds.map((e) => e.decision)).toEqual(['continue', 'stop'])
  })

  it('emits loop_step_end per kind: ai-step (null exitCode), shell (real exitCode), decider (decision)', async () => {
    const ex = makeExecutors({
      // Non-zero shell exit → the step end must carry the REAL code and flag failed.
      runShell: vi.fn(async () => ({ stdout: 'boom', stderr: '', exitCode: 2, durationMs: 7 })),
    })
    const res = await manager(ex).run(baseReq())

    const events = getJobEvents(db, res.runId)
    const ends = payloads(res.runId, 'loop_step_end')
    expect(ends.length).toBe(3) // ai + shell + decider, one end each
    // ai-step: ok, no exit code exposed, no decision.
    expect(ends[0]).toMatchObject({ index: 1, nodeId: 'ai', status: 'ok', exitCode: null })
    expect(ends[0].decision).toBeUndefined()
    // shell: executor-reported duration + real exit code; non-zero ⇒ failed.
    expect(ends[1]).toMatchObject({ index: 2, nodeId: 'sh', status: 'failed', exitCode: 2, durationMs: 7 })
    // decider: verdict included; parseable ⇒ ok.
    expect(ends[2]).toMatchObject({ index: 3, nodeId: 'd', status: 'ok', exitCode: null, decision: 'stop' })
    // Tail ordering: the shell end sits after the step's last output line (`(exit 2)`).
    const exitLog = events.find((e) => e.event_type === 'log' && ((JSON.parse(e.payload) as { line?: string }).line ?? '').startsWith('(exit'))!
    const shellEnd = events.filter((e) => e.event_type === 'loop_step_end')[1]
    expect(shellEnd.seq).toBeGreaterThan(exitLog.seq)
    // durationMs is always a number (wall-clock fallback when the executor omits it).
    expect(ends.every((e) => typeof e.durationMs === 'number')).toBe(true)
  })

  it('a hard-failed AI step ends status=failed', async () => {
    const ex = makeExecutors({
      runAiStep: vi.fn(async () => ({ text: 'partial', failed: true, errorText: 'exited 1', provider: 'claude', model: 'sonnet' })),
    })
    const res = await manager(ex).run(baseReq())
    const ends = payloads(res.runId, 'loop_step_end')
    expect(ends[0]).toMatchObject({ index: 1, nodeId: 'ai', status: 'failed', exitCode: null })
  })

  it('an unparseable Decider verdict ends status=failed but still carries the routed decision', async () => {
    const ex = makeExecutors({
      runDecider: vi.fn(async () => ({ continue: true, reasoning: '(could not parse)', parsed: false, provider: 'claude', model: 'sonnet' })),
    })
    const res = await manager(ex).run({ ...baseReq(), graph: loopGraph(1) })
    const deciderEnds = payloads(res.runId, 'loop_step_end').filter((e) => e.nodeId === 'd')
    expect(deciderEnds.length).toBe(1)
    expect(deciderEnds[0]).toMatchObject({ status: 'failed', decision: 'continue' })
  })

  it('a shell step refused for a missing run-variable ends failed with null exitCode (never spawned)', async () => {
    const graph: LoopGraph = {
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 } },
        { id: 'arch', type: 'shell', position: { x: 0, y: 1 }, data: { command: 'openspec archive {{run.changeId}} -y', requireRunVars: ['changeId'] } },
        { id: 'e', type: 'end', position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: 'e1', source: 's', target: 'arch' },
        { id: 'e2', source: 'arch', target: 'e' },
      ],
      config: { maxIterations: 5, timeoutMinutes: 30 },
    }
    const res = await manager(makeExecutors()).run({ ...baseReq(), graph })
    expect(res.outcome).toBe('failed')
    const ends = payloads(res.runId, 'loop_step_end')
    expect(ends.length).toBe(1)
    expect(ends[0]).toMatchObject({ nodeId: 'arch', status: 'failed', exitCode: null })
  })

  // ── loop_step detail fields (template/command) + log-hygiene ───────────────
  // The old `Template: …` / `Command: …` flat-log lines were noise once the
  // step explorer landed — the info now rides the loop_step payload instead,
  // so the step body opens directly on real output.

  it('ai-step loop_step carries template (authored) + command (rendered); no Template:/Command: log lines', async () => {
    const res = await manager(makeExecutors()).run(baseReq())

    const steps = payloads(res.runId, 'loop_step')
    const ai = steps.find((s) => s.kind === 'ai-step')!
    // Authored template verbatim; command = the rendered prompt ({{spec.title}} resolved).
    expect(ai.template).toBe('Implement {{spec.title}}')
    expect(ai.command).toBe('Implement Feature X')
    // shell/decider steps carry NO detail fields (their real signal — `$ cmd`,
    // `Goal: …` — stays in the flat log).
    const sh = steps.find((s) => s.kind === 'shell')!
    const dec = steps.find((s) => s.kind === 'decider')!
    expect(sh.template).toBeUndefined()
    expect(sh.command).toBeUndefined()
    expect(dec.template).toBeUndefined()
    expect(dec.command).toBeUndefined()

    // The noise lines are GONE from the persisted log stream for ALL steps…
    const logLines = getJobEvents(db, res.runId)
      .filter((e) => e.event_type === 'log')
      .map((e) => (JSON.parse(e.payload) as { line?: string }).line ?? '')
    expect(logLines.some((l) => l.startsWith('Template:'))).toBe(false)
    expect(logLines.some((l) => l.startsWith('Command:'))).toBe(false)
    // …while the REAL per-kind signal lines survive.
    expect(logLines.some((l) => l.startsWith('$ npm test'))).toBe(true)
    expect(logLines.some((l) => l.startsWith('Goal: tests pass'))).toBe(true)
  })

  it('a plain free-text prompt (rendering changed nothing) emits command only — template omitted', async () => {
    const graph = loopGraph(1)
    graph.nodes[1].data = { prompt: 'just do the work' }
    const res = await manager(makeExecutors()).run({ ...baseReq(), graph })

    const ai = payloads(res.runId, 'loop_step').find((s) => s.kind === 'ai-step')!
    expect(ai.command).toBe('just do the work')
    expect(ai.template).toBeUndefined() // would just duplicate command
  })

  it('caps the detail fields with an ellipsis (template ~1000, command ~2000) — payloads persist per event', async () => {
    const graph = loopGraph(1)
    graph.nodes[1].data = { prompt: 'X'.repeat(3000) + ' {{spec.title}}' }
    const res = await manager(makeExecutors()).run({ ...baseReq(), graph })

    const ai = payloads(res.runId, 'loop_step').find((s) => s.kind === 'ai-step')!
    expect((ai.template as string).length).toBe(1001)
    expect((ai.template as string).endsWith('…')).toBe(true)
    expect((ai.command as string).length).toBe(2001)
    expect((ai.command as string).endsWith('…')).toBe(true)
  })
})

describe('LoopRunManager blocked + non-convergence guards', () => {
  it('Decider "blocked" pauses until a human decision, then continues', async () => {
    const runDecider = vi.fn(async () => (
      runDecider.mock.calls.length === 1
        ? {
            continue: false, blocked: true, reasoning: 'needs a human scope call on Supabase', parsed: true,
            cost: 0.001, tokens: 20, provider: 'claude', model: 'sonnet',
          }
        : {
            continue: false, blocked: false, reasoning: 'done after human scope call', parsed: true,
            cost: 0.001, tokens: 20, provider: 'claude', model: 'sonnet',
          }
    ))
    const ex = makeExecutors({ runDecider })
    const m = manager(ex)
    const runPromise = m.run({ ...baseReq(), runId: 'run-decider-paused', graph: loopGraph(20) })
    await waitFor(() => getLoopRun(db, 'run-decider-paused')?.status === 'paused', 'loop pause')
    expect(getLoopRun(db, 'run-decider-paused')!.final_outcome).toBeNull()
    expect(m.sendInteractiveTurn('run-decider-paused', 'Use Supabase for this scope.')).toBe(true)
    const res = await runPromise
    expect(res.outcome).toBe('success')
    expect(getLoopRun(db, res.runId)!.final_outcome).toBe('success')
    // The blocking reason reached the run log.
    expect(broadcasts.some((m) => m.type === 'log' && ((m as { line?: string }).line ?? '').includes('needs a human scope call'))).toBe(true)
    expect(runDecider).toHaveBeenCalledTimes(2)
  })

  it('aborts "stalled" when repoStateHash is unchanged across consecutive continue verdicts', async () => {
    // Decider always says continue (never done); the tree never changes.
    const runDecider = vi.fn(async () => ({
      continue: true, blocked: false, reasoning: 'not done', parsed: true,
      cost: 0.001, tokens: 20, provider: 'claude', model: 'sonnet',
    }))
    const repoStateHash = vi.fn(() => 'IDENTICAL')
    const ex = makeExecutors({ runDecider, repoStateHash })
    const res = await manager(ex).run({ ...baseReq(), graph: loopGraph(20) })
    expect(res.outcome).toBe('stalled')
    expect(getLoopRun(db, res.runId)!.final_outcome).toBe('stalled')
    // Stopped WELL before the 20-iteration cap (baseline hash + 2 no-change = 3 deciders).
    expect(runDecider.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('does NOT stall when the tree keeps changing (hash differs each iteration)', async () => {
    let n = 0
    // Continue a few times then stop, with a DIFFERENT hash each pass → progress.
    const runDecider = vi.fn(async () => (++n >= 3
      ? { continue: false, blocked: false, reasoning: 'done', parsed: true, cost: 0.001, tokens: 20, provider: 'claude', model: 'sonnet' }
      : { continue: true, blocked: false, reasoning: 'more', parsed: true, cost: 0.001, tokens: 20, provider: 'claude', model: 'sonnet' }))
    const repoStateHash = vi.fn(() => `hash-${n}`)
    const ex = makeExecutors({ runDecider, repoStateHash })
    const res = await manager(ex).run({ ...baseReq(), graph: loopGraph(20) })
    expect(res.outcome).toBe('success')
  })

  it('never stalls when repoStateHash returns null (guard disabled, not a false match)', async () => {
    let n = 0
    const runDecider = vi.fn(async () => (++n >= 4
      ? { continue: false, blocked: false, reasoning: 'done', parsed: true, cost: 0.001, tokens: 20, provider: 'claude', model: 'sonnet' }
      : { continue: true, blocked: false, reasoning: 'more', parsed: true, cost: 0.001, tokens: 20, provider: 'claude', model: 'sonnet' }))
    const repoStateHash = vi.fn(() => null)
    const ex = makeExecutors({ runDecider, repoStateHash })
    const res = await manager(ex).run({ ...baseReq(), graph: loopGraph(20) })
    expect(res.outcome).toBe('success') // null never matches null → no false stall
  })
})
