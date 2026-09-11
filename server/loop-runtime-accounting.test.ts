import { afterEach, expect, it, vi } from 'vitest'
import { initDb, getJob, type DbInstance } from './db'
import { LoopRunManager } from './loop-run-manager'
import type { LoopGraph } from './loop-graph'
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
