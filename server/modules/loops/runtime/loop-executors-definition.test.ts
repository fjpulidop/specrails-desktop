import { beforeEach, expect, it, vi } from 'vitest'
import { configurableImplementGraph } from './loop-implement-recipe'
import { createLoopExecutors } from './loop-executors'
import type { LoopRunRequest } from './loop-run-manager'
import { runAgentRuntimeInvocation, readFrozenRuntimeHost } from '../../agent-runtime/runtime/agent-runtime-bridge'

vi.mock('../../../core-execution', () => ({ prepareCoreExecution: () => ({ contextPath: '/frozen/context.json', env: {} }), checkCoreCompletion: vi.fn() }))
vi.mock('../../agent-runtime/runtime/agent-runtime-bridge', () => ({
  runAgentRuntimeInvocation: vi.fn(), runAgentRuntimeControl: vi.fn(), runtimeChangeName: () => 'frozen-change',
  readFrozenRuntimeHost: vi.fn(() => ({ cwd: '/original', env: {} })),
}))
beforeEach(() => { vi.clearAllMocks(); vi.mocked(runAgentRuntimeInvocation).mockResolvedValue({ text: '', failed: false, runtimeStatus: 'paused' }) })
const request = (deciderEngine?: LoopRunRequest['deciderEngine']): LoopRunRequest => ({
  loopId: 'saved', projectId: 'project', cwd: '/original', provider: 'claude', model: 'rail-model', effort: 'high', deciderEngine,
  graph: { nodes: [], edges: [], config: { maxIterations: 3, timeoutMinutes: 0, legacyDeciderRole: 'legacy-loop-decider' } },
})
const callbacks = { onLine: vi.fn(), onRuntimeEvent: vi.fn(), onSpawn: vi.fn() }
it.each([undefined, { provider: 'codex', model: 'decision-model', effort: 'low' as const }])('freezes the actual legacy decision selection %j through the bridge port', async selection => {
  await createLoopExecutors({ env: {} }).runDefinition!({ ...callbacks, request: request(selection), runId: 'run' })
  expect(vi.mocked(runAgentRuntimeInvocation).mock.calls[0][0]).toMatchObject({
    workflowRoleBindings: { 'legacy-loop-decider': { ...(selection ?? { provider: 'claude', model: 'rail-model', effort: 'high' }), access: 'read', artifacts: 'none' } },
  })
})
it('does not introduce a decision selection on ordinary Core graphs', async () => {
  const input = request(); delete input.graph.config.legacyDeciderRole
  await createLoopExecutors({ env: {} }).runDefinition!({ ...callbacks, request: input, runId: 'run' })
  expect(vi.mocked(runAgentRuntimeInvocation).mock.calls[0][0]).not.toHaveProperty('workflowRoleBindings')
})
it('resumes using frozen runtime state without replacing the original role choice', async () => {
  await createLoopExecutors({ env: {} }).runDefinition!({ ...callbacks, request: request({ provider: 'codex', model: 'changed-selection' }), runId: 'run', resume: true, contextPath: '/frozen/context.json' })
  expect(readFrozenRuntimeHost).toHaveBeenCalledWith('/frozen/context.json', {}, 'run')
  const call = vi.mocked(runAgentRuntimeInvocation).mock.calls[0][0]
  expect(call).toMatchObject({ resume: true, cwd: '/original' })
  expect(call).not.toHaveProperty('workflowRoleBindings')
  expect(call).not.toHaveProperty('prepareDefinition')
})


it('freezes a fresh delta target and briefs every Implement role without mutating the spec', async () => {
  const input = request()
  input.loopId = 'factory:implement'
  input.graph = configurableImplementGraph()
  input.spec = { title: 'Already delivered', description: 'Original requirements', openspecChangeName: 'original-change' }
  input.addenda = { ids: ['a1'], briefing: '[a1] Add idempotency' }
  input.constants = { REVISION_REQUEST: 'Keep the current PR branch' }
  const original = structuredClone(input)
  await createLoopExecutors({ env: {} }).runDefinition!({ ...callbacks, request: input, runId: 'delta-run' })
  const call = vi.mocked(runAgentRuntimeInvocation).mock.calls[0][0]
  expect(call.change).toMatch(/^spec-addenda-/)
  expect(call.change).not.toBe('original-change')
  const definition = call.prepareDefinition!(input.graph.config.agents!)
  for (const role of ['architect', 'developer', 'reviewer', 'fixer']) {
    expect(definition.nodes[role].params.prompt).toContain('For delivered work, plan and implement ONLY')
    expect(definition.nodes[role].params.prompt).toContain('For work not yet implemented, implement the full spec')
    expect(definition.nodes[role].params.prompt).toContain('[a1] Add idempotency')
    expect(definition.nodes[role].params.prompt).toContain('Keep the current PR branch')
    expect(definition.nodes[role].params.prompt).toContain(`openspec/changes/${call.change}/`)
  }
  expect(input).toEqual(original)
})
