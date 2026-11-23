import { afterEach, expect, it, vi } from 'vitest'
import { initDb, getJob, type DbInstance } from './db'
import { LoopRunManager } from './modules/loops/runtime/loop-run-manager'
import type { LoopGraph } from './modules/loops/runtime/loop-graph'
const databases: DbInstance[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))
const graph: LoopGraph = {
  nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }, { id: 'run', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Implement the selected work' } }, { id: 'end', type: 'end', position: { x: 0, y: 2 } }],
  edges: [{ id: 's-r', source: 'start', target: 'run' }, { id: 'r-e', source: 'run', target: 'end' }], config: { maxIterations: 1, timeoutMinutes: 1 },
}
it.each(['claude', 'kimi'])('keeps unknown runtime costs nullable regardless of outer %s provider', async provider => {
  const db = initDb(':memory:'); databases.push(db)
  const manager = new LoopRunManager(db, () => {}, { runAiStep: vi.fn(async () => ({ text: 'done', provider: 'agent-runtime', model: 'per-role', tokensIn: 123, tokensOut: 17, estimated: true })), runDecider: vi.fn(), runShell: vi.fn() })
  const result = await manager.run({ projectId: 'project', loopId: 'runtime', graph, cwd: process.cwd(), provider, model: 'default' })
  expect(result.outcome).toBe('success')
  expect(result.totalCostUsd).toBeNull()
  expect(getJob(db, result.runId)).toMatchObject({ total_cost_usd: null, tokens_in: 123, tokens_out: 17 })
  expect(db.prepare('SELECT provider,total_cost_usd,tokens_in FROM ai_invocations WHERE loop_run_id=?').all(result.runId)).toEqual([{ provider: 'agent-runtime', total_cost_usd: null, tokens_in: 123 }])
})
it('uses known role-provider billing even when the outer CLI lacks telemetry', async () => {
  const db = initDb(':memory:'); databases.push(db)
  const manager = new LoopRunManager(db, () => {}, { runAiStep: vi.fn(async () => ({ text: 'done', provider: 'agent-runtime', cost: 0.12, tokensIn: 10, tokensOut: 2 })), runDecider: vi.fn(), runShell: vi.fn() })
  const result = await manager.run({ projectId: 'project', loopId: 'runtime', graph, cwd: process.cwd(), provider: 'kimi', model: 'default' })
  expect(result.totalCostUsd).toBe(0.12)
  expect(getJob(db, result.runId)).toMatchObject({ total_cost_usd: 0.12, tokens_in: 10, tokens_out: 2 })
})

// ─── Core v1 attribution to the real engine (per phase) ──────────────────────
const workflow = (runId: string, seq: number, type: string, stepId: string, attemptId: string, usage?: Record<string, number | null>) =>
  JSON.stringify({ type: 'workflow-event', event: { id: `${runId}:${seq}`, sequence: seq, runId, type, stepId, attemptId, ...(usage ? { usage } : {}) } })
const roleContext = (runId: string, seq: number, attemptId: string, payload: Record<string, unknown>) =>
  JSON.stringify({ type: 'runtime-efficiency-event', schemaVersion: 1, eventId: `${runId}:${seq}`, runId, attemptId, kind: 'role-context', payload })

it('records one Core v1 row per phase with the real provider and model, totals unchanged', async () => {
  const db = initDb(':memory:'); databases.push(db)
  const runId = 'run-attributed'
  const manager = new LoopRunManager(db, () => {}, { runAiStep: vi.fn(async ({ onRawLine }) => {
    // Historical shape (no per-call usage) for the architect; per-call usage for the developer.
    onRawLine?.(workflow(runId, 1, 'step_started', 'architect', 'a1'))
    onRawLine?.(roleContext(runId, 2, 'a1', { provider: 'claude', model: 'claude-opus-4-1', durationMs: 1000 }))
    onRawLine?.(workflow(runId, 3, 'step_succeeded', 'architect', 'a1', { costUsd: 0.3, inputTokens: 100, outputTokens: 10 }))
    onRawLine?.(workflow(runId, 4, 'step_started', 'developer', 'a2'))
    onRawLine?.(roleContext(runId, 5, 'a2', { provider: 'codex', model: 'gpt-6.1-sol', durationMs: 3000, usage: { costUsd: 0.5, inputTokens: 200, outputTokens: 20 } }))
    onRawLine?.(workflow(runId, 6, 'step_succeeded', 'developer', 'a2', { costUsd: 0.5, inputTokens: 200, outputTokens: 20 }))
    onRawLine?.(JSON.stringify({ type: 'runtime-result', runId, status: 'succeeded', invocationUsage: { costUsd: 0.8, inputTokens: 300, outputTokens: 30 } }))
    return { text: 'done', provider: 'agent-runtime', model: 'per-role', cost: 0.8, tokensIn: 300, tokensOut: 30, tokens: 330, estimated: false, durationMs: 4000 }
  }), runDecider: vi.fn(), runShell: vi.fn() })
  const result = await manager.run({ runId, projectId: 'project', loopId: 'runtime', graph, cwd: process.cwd(), provider: 'claude', model: 'default' })
  expect(result.totalCostUsd).toBeCloseTo(0.8, 10)
  const rows = db.prepare('SELECT id, provider, model, surface_ref_id, total_cost_usd, tokens_in, tokens_out, duration_ms FROM ai_invocations WHERE loop_run_id = ? ORDER BY provider').all(runId) as Array<Record<string, unknown>>
  expect(rows).toEqual([
    expect.objectContaining({ provider: 'claude', model: 'claude-opus-4-1', surface_ref_id: `loop:${runId}:architect`, tokens_in: 100, tokens_out: 10, duration_ms: 1000 }),
    expect.objectContaining({ provider: 'codex', model: 'gpt-6.1-sol', surface_ref_id: `loop:${runId}:developer`, tokens_in: 200, tokens_out: 20, duration_ms: 3000 }),
  ])
  expect(rows.every(row => String(row.id).startsWith('core-v1:'))).toBe(true)
  expect((rows[0].total_cost_usd as number) + (rows[1].total_cost_usd as number)).toBeCloseTo(0.8, 10)
  // The job keeps the runtime semantics (no cache / turn figures from Core v1).
  expect(getJob(db, result.runId)).toMatchObject({ tokens_in: 300, tokens_out: 30, tokens_cache_read: null, num_turns: null })
  expect(getJob(db, result.runId)!.total_cost_usd).toBeCloseTo(0.8, 10)
})

it('keeps the single agent-runtime row when the phases do not reconcile with the total', async () => {
  const db = initDb(':memory:'); databases.push(db)
  const runId = 'run-mismatch'
  const manager = new LoopRunManager(db, () => {}, { runAiStep: vi.fn(async ({ onRawLine }) => {
    onRawLine?.(roleContext(runId, 1, 'a1', { provider: 'claude', model: 'opus' }))
    onRawLine?.(workflow(runId, 2, 'step_succeeded', 'architect', 'a1', { costUsd: 2, inputTokens: 100, outputTokens: 10 }))
    return { text: 'done', provider: 'agent-runtime', model: 'per-role', cost: 1, tokensIn: 100, tokensOut: 10, estimated: false }
  }), runDecider: vi.fn(), runShell: vi.fn() })
  await manager.run({ runId, projectId: 'project', loopId: 'runtime', graph, cwd: process.cwd(), provider: 'claude', model: 'default' })
  expect(db.prepare('SELECT provider, model, total_cost_usd FROM ai_invocations WHERE loop_run_id = ?').all(runId))
    .toEqual([{ provider: 'agent-runtime', model: 'per-role', total_cost_usd: 1 }])
})

it('writes no ledger row for the deterministic completion check (no provider call)', async () => {
  const db = initDb(':memory:'); databases.push(db)
  const manager = new LoopRunManager(db, () => {}, { runAiStep: vi.fn(async () => ({ text: 'VERIFICATION: PASS', provider: 'agent-runtime', model: 'deterministic-verification', cost: 0, tokensIn: 0, tokensOut: 0, tokens: 0, estimated: false, durationMs: 0 })), runDecider: vi.fn(), runShell: vi.fn() })
  const result = await manager.run({ projectId: 'project', loopId: 'runtime', graph, cwd: process.cwd(), provider: 'claude', model: 'default' })
  expect(result.outcome).toBe('success')
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_invocations WHERE loop_run_id = ?').get(result.runId)).toEqual({ n: 0 })
  expect(db.prepare('SELECT COUNT(*) AS n FROM loop_step_recovery').get()).toEqual({ n: 0 })
})
