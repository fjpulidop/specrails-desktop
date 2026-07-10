import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, createJob, appendEvent, type DbInstance } from './db'
import {
  createLoopRun,
  updateLoopRunCounters,
  finishLoopRun,
  finishLoopRunAndJob,
  listPendingLoopTerminalRecoveries,
  pauseLoopRun,
  resumeLoopRun,
  getLoopRun,
  listActiveLoopRuns,
  listLoopRuns,
  countRunningForLoop,
  reconcileOrphanLoopRuns,
  getRunEventCounts,
  updateLoopStepEventCheckpoint,
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
  it('fails closed instead of advancing job usage without a step checkpoint', () => {
    expect(() => updateLoopStepEventCheckpoint(db, 'missing-run', 'ai:1', 4))
      .toThrow('Missing loop step checkpoint missing-run/ai:1')
  })

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

  it('pauses and resumes a run without making it terminal', () => {
    create('r1')
    const paused = pauseLoopRun(db, 'r1', { iterationCount: 2, totalCostUsd: 0.25 })!
    expect(paused.status).toBe('paused')
    expect(paused.final_outcome).toBeNull()
    expect(paused.finished_at).toBeNull()
    expect(paused.iteration_count).toBe(2)
    expect(listActiveLoopRuns(db, 'p1').map((r) => r.id)).toEqual(['r1'])

    const resumed = resumeLoopRun(db, 'r1')!
    expect(resumed.status).toBe('running')
    expect(resumed.final_outcome).toBeNull()
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
    create('r2', { loopId: 'loop-A' }) // orphan paused
    createJob(db, {
      id: 'r1', command: 'loop: A #42', started_at: '2026-06-24T10:00:00.000Z',
      provider: 'codex', owner: 'loop',
    })
    updateLoopRunCounters(db, 'r1', { totalDurationMs: 33 })
    db.prepare(`UPDATE jobs SET duration_ms = 11 WHERE id = 'r1'`).run()
    createJob(db, {
      id: 'r2', command: 'loop: A #42', started_at: '2026-06-24T10:00:00.000Z',
      provider: 'claude', owner: 'loop',
    })
    pauseLoopRun(db, 'r2')
    create('r3', { loopId: 'loop-A' })
    finishLoopRun(db, 'r3', { outcome: 'success', finishedAt: '2026-06-24T10:05:00.000Z' }) // already terminal
    expect(countRunningForLoop(db, 'loop-A')).toBe(2) // r1 running + r2 paused

    const n = reconcileOrphanLoopRuns(db, '2026-06-24T12:00:00.000Z')
    expect(n).toBe(2) // active r1/r2 reconciled
    expect(countRunningForLoop(db, 'loop-A')).toBe(0)
    const r1 = getLoopRun(db, 'r1')!
    expect(r1.status).toBe('completed')
    expect(r1.final_outcome).toBe('failed')
    expect(r1.finished_at).toBe('2026-06-24T12:00:00.000Z')
    const r2 = getLoopRun(db, 'r2')!
    expect(r2.status).toBe('completed')
    expect(r2.final_outcome).toBe('failed')
    expect(r2.finished_at).toBe('2026-06-24T12:00:00.000Z')
    expect(db.prepare('SELECT status, provider, owner, duration_ms FROM jobs WHERE id = ?').get('r1')).toMatchObject({
      status: 'failed', provider: 'codex', owner: 'loop', duration_ms: 33,
    })
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get('r2')).toMatchObject({ status: 'failed' })
    expect(db.prepare("SELECT COUNT(*) AS n FROM ai_invocations WHERE surface = 'job' AND surface_ref_id IN ('r1', 'r2')").get())
      .toMatchObject({ n: 0 })
    // A second pass is a no-op (nothing left running).
    expect(reconcileOrphanLoopRuns(db, '2026-06-24T13:00:00.000Z')).toBe(0)
  })

  it('atomically finalizes loop + backing job + exact terminal outbox', () => {
    create('atomic', {
      ticketIds: [42, 43], ticketCompletionStatus: 'on_review', causalOwnership: true,
    })
    createJob(db, {
      id: 'atomic', command: 'loop: atomic #42 #43',
      started_at: '2026-06-24T10:00:00.000Z', owner: 'loop', provider: 'claude',
    })
    db.exec(`
      CREATE TRIGGER reject_loop_terminal_intent
      BEFORE INSERT ON loop_terminal_recovery
      BEGIN SELECT RAISE(ABORT, 'intent failed'); END;
    `)
    const finish = () => finishLoopRunAndJob(db, 'atomic', {
      outcome: 'success', finishedAt: '2026-06-24T11:00:00.000Z',
      counters: { iterationCount: 1, totalCostUsd: 1, totalTokens: 30, totalDurationMs: 20 },
      job: {
        exitCode: 0, status: 'completed', totalCostUsd: 1,
        tokensIn: 10, tokensOut: 20, tokensCacheRead: 3, tokensCacheCreate: 2,
        durationMs: 20, numTurns: 2,
      },
    })
    expect(finish).toThrow(/intent failed/)
    expect(getLoopRun(db, 'atomic')).toMatchObject({ status: 'running', final_outcome: null })
    expect(db.prepare(`SELECT status FROM jobs WHERE id = 'atomic'`).get()).toMatchObject({ status: 'running' })

    db.exec(`DROP TRIGGER reject_loop_terminal_intent`)
    finish()
    expect(getLoopRun(db, 'atomic')).toMatchObject({ status: 'completed', final_outcome: 'success' })
    expect(db.prepare(`SELECT status, tokens_in, tokens_out FROM jobs WHERE id = 'atomic'`).get())
      .toMatchObject({ status: 'completed', tokens_in: 10, tokens_out: 20 })
    const pending = listPendingLoopTerminalRecoveries(db)
    expect(pending).toHaveLength(1)
    expect(JSON.parse(pending[0].payload)).toMatchObject({
      runId: 'atomic', ticketIds: [42, 43], railIndex: 1,
      outcome: 'success', ticketCompletionStatus: 'on_review', causalOwnership: true,
    })
  })

  describe('getRunEventCounts', () => {
    it('counts ACTIVITY steps (same source as the Job panel) + log lines', () => {
      createJob(db, { id: 'run-x', command: 'loop: x', started_at: '2026-06-24T10:00:00.000Z' })
      // assistant with 1 tool_use → 1 step
      appendEvent(db, 'run-x', 1, { event_type: 'assistant', source: 'stdout', payload: JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Edit' }] } }) })
      // assistant with 2 parallel tool_use → 2 steps
      appendEvent(db, 'run-x', 2, { event_type: 'assistant', source: 'stdout', payload: JSON.stringify({ message: { content: [{ type: 'tool_use' }, { type: 'tool_use' }] } }) })
      // bare tool_use → 1 step
      appendEvent(db, 'run-x', 3, { event_type: 'tool_use', source: 'stdout', payload: '{}' })
      // log lines
      appendEvent(db, 'run-x', 4, { event_type: 'log', source: 'stdout', payload: '{"line":"a"}' })
      appendEvent(db, 'run-x', 5, { event_type: 'log', source: 'stdout', payload: '{"line":"b"}' })
      // loop_step / result are NOT activity steps → ignored
      appendEvent(db, 'run-x', 6, { event_type: 'loop_step', source: 'stdout', payload: '{"index":1}' })
      appendEvent(db, 'run-x', 7, { event_type: 'result', source: 'stdout', payload: '{}' })
      expect(getRunEventCounts(db, 'run-x')).toEqual({ steps: 4, lines: 2 })
    })
    it('returns zeros for an unknown run', () => {
      expect(getRunEventCounts(db, 'nope')).toEqual({ steps: 0, lines: 0 })
    })
  })
})
