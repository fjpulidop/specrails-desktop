import { afterEach, expect, it, vi } from 'vitest'
import { getJob, getJobEvents, initDb, type DbInstance } from './db'
import type { LoopGraph } from './loop-graph'
import { LoopRunManager, type AiStepResult, type LoopExecutors } from './loop-run-manager'
import type { WsMessage } from './types'

const databases: DbInstance[] = []
afterEach(() => {
  databases.splice(0).forEach(db => db.close())
  vi.restoreAllMocks()
})

const graph: LoopGraph = {
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 } },
    { id: 'implement', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Implement the selected work', operation: 'core-implementation', stopOnFailure: true } },
    { id: 'end', type: 'end', position: { x: 0, y: 2 } },
  ],
  edges: [{ id: 's-i', source: 'start', target: 'implement' }, { id: 'i-e', source: 'implement', target: 'end' }],
  config: { maxIterations: 1, timeoutMinutes: 1 },
}

async function runFailure(runAiStep: LoopExecutors['runAiStep']) {
  const db = initDb(':memory:')
  databases.push(db)
  const broadcasts: WsMessage[] = []
  const manager = new LoopRunManager(db, message => broadcasts.push(message), {
    runAiStep, runDecider: vi.fn(), runShell: vi.fn(),
  })
  const result = await manager.run({ projectId: 'project', loopId: 'runtime', graph, cwd: process.cwd(), provider: 'claude', model: 'default' })
  const events = getJobEvents(db, result.runId)
  const logs = events.filter(event => event.event_type === 'log').map(event => JSON.parse(event.payload).line as string)
  return { db, result, events, logs, broadcasts }
}

it.each([
  'Programmatic agent runtime is enabled but its Core CLI is unavailable.',
  'Provider local requires a model for the architect role.',
])('shows a returned startup failure inside its step: %s', async errorText => {
  const { db, result, events, logs, broadcasts } = await runFailure(vi.fn(async (): Promise<AiStepResult> => ({
    text: '', failed: true, errorText, provider: 'agent-runtime', model: 'per-role',
  })))
  expect(result.outcome).toBe('failed')
  expect(result.totalCostUsd).toBeNull()
  expect(broadcasts).toContainEqual(expect.objectContaining({ type: 'log', source: 'stderr', line: `✖ ${errorText}` }))
  const failureIndex = events.findIndex(event => event.event_type === 'log' && JSON.parse(event.payload).line === `✖ ${errorText}`)
  const endIndex = events.findIndex(event => event.event_type === 'loop_step_end')
  expect(failureIndex).toBeGreaterThan(-1)
  expect(endIndex).toBeGreaterThan(failureIndex)
  expect(JSON.parse(events[endIndex].payload)).toMatchObject({ status: 'failed' })
  const billingNote = logs.find(line => line.includes('Step cost unknown'))
  expect(billingNote).toContain('did not report a priced cost')
  expect(billingNote).not.toMatch(/timeout|crash|\$0/)
  expect(logs.find(line => line.includes('Loop finished:'))).toContain('usage/cost unavailable')
  expect(getJob(db, result.runId)).toMatchObject({ status: 'failed', total_cost_usd: null })
  expect(db.prepare('SELECT provider, status, total_cost_usd FROM ai_invocations WHERE loop_run_id = ?').all(result.runId))
    .toEqual([{ provider: 'agent-runtime', status: 'failed', total_cost_usd: null }])
  expect(db.prepare('SELECT COUNT(*) AS count FROM loop_step_recovery').get()).toEqual({ count: 0 })
})

it('retains exact reported usage when stopOnFailure halts before the next node', async () => {
  const { db, result, logs } = await runFailure(vi.fn(async () => ({
    text: 'Partial developer output', failed: true, errorText: 'Verification command exited with code 1',
    provider: 'agent-runtime', model: 'per-role', cost: 0.17, tokensIn: 12, tokensOut: 8,
  })))
  expect(result.outcome).toBe('failed')
  expect(result.totalCostUsd).toBe(0.17)
  expect(logs).toContain('✖ Verification command exited with code 1')
  expect(logs.some(line => line.includes('Step cost unknown'))).toBe(false)
  expect(getJob(db, result.runId)).toMatchObject({ total_cost_usd: 0.17, tokens_in: 12, tokens_out: 8 })
  expect(db.prepare('SELECT provider, total_cost_usd FROM ai_invocations WHERE loop_run_id = ?').all(result.runId))
    .toEqual([{ provider: 'agent-runtime', total_cost_usd: 0.17 }])
})

it('preserves a thrown configuration error in both the live and persisted step log', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const errorText = 'Invalid runtime configuration: verification must cover repository desktop'
  const { events, logs, broadcasts, result } = await runFailure(vi.fn(async () => { throw new Error(errorText) }))
  expect(result.outcome).toBe('failed')
  expect(logs).toContain(`error: ${errorText}`)
  expect(broadcasts).toContainEqual(expect.objectContaining({ type: 'log', source: 'stderr', line: `error: ${errorText}` }))
  const failureIndex = events.findIndex(event => event.event_type === 'log' && JSON.parse(event.payload).line === `error: ${errorText}`)
  expect(events.findIndex(event => event.event_type === 'loop_step_end')).toBeGreaterThan(failureIndex)
})
