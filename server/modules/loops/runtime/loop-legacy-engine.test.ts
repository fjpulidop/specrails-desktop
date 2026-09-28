import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopExecutors, type LoopRunRequest } from './loop-run-manager'
import { getLoopRun } from './loop-runs-store'
import { createLoopExecutors } from './loop-executors'
import { loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'

vi.mock('../../agent-runtime/runtime/agent-runtime-loader', async original => ({
  ...await original<typeof import('../../agent-runtime/runtime/agent-runtime-loader')>(), loadCoreAgentRuntime: vi.fn(),
}))

let db: DbInstance
beforeEach(() => { db = initDb(':memory:'); vi.mocked(loadCoreAgentRuntime).mockReset() })
afterEach(() => db.close())
const legacy = (): LoopRunRequest => ({ runId: 'legacy-run', loopId: 'saved', projectId: 'p1', cwd: '/repo', provider: 'claude', model: 'sonnet', graph: {
  nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 } }, { id: 'ask', type: 'ai-step', position: { x: 0, y: 100 }, data: { prompt: 'Work' } }, { id: 'end', type: 'end', position: { x: 0, y: 200 }, data: { outcome: 'success' } }],
  edges: [{ id: 'a', source: 'start', target: 'ask' }, { id: 'b', source: 'ask', target: 'end' }], config: { maxIterations: 3, timeoutMinutes: 0 } } })
const core = (api: Record<string, unknown>) => vi.mocked(loadCoreAgentRuntime).mockResolvedValue({ api: { type: 'runtime-api', apiVersion: 1, ...api } } as never)

it('refuses a legacy traversal before persisting or calling a provider when Core lacks engine 1', async () => {
  const executors: LoopExecutors = { assertLegacyEngineSupport: vi.fn(async () => { throw new Error('legacy_engine_unavailable: Convert this loop to Core first.') }), runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
  const manager = new LoopRunManager(db, () => {}, executors)
  await expect(manager.run(legacy())).rejects.toThrow(/^legacy_engine_unavailable:/)
  await expect(manager.assertEngineSupport(legacy().graph)).rejects.toThrow(/^legacy_engine_unavailable:/)
  expect(executors.runAiStep).not.toHaveBeenCalled()
  expect(getLoopRun(db, 'legacy-run')).toBeUndefined()
  expect(db.prepare('SELECT COUNT(*) AS count FROM legacy_launch_events').get()).toEqual({ count: 0 })
})

it('derives legacy support from the advertised engines, defaulting for older Cores', async () => {
  const executors = createLoopExecutors({ env: {} })
  core({ engines: [2], capabilities: { engineV2: 1 } })
  await expect(executors.assertLegacyEngineSupport!()).rejects.toThrow(/^legacy_engine_unavailable:.*Convert this loop to Core/)
  for (const api of [{ engines: [1, 2] }, { capabilities: { engineV2: 1 } }, {}]) {
    core(api)
    await expect(executors.assertLegacyEngineSupport!()).resolves.toBeUndefined()
  }
  // Legacy traversal predates Core: a missing Core is not evidence that engine 1 is gone.
  vi.mocked(loadCoreAgentRuntime).mockRejectedValue(new Error('Programmatic agent runtime is unavailable'))
  await expect(executors.assertLegacyEngineSupport!()).resolves.toBeUndefined()
})
