import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { createLoopExecutors } from './loop-executors'
import { flowSpecGraph, FLOW_SUMMARY_FILE } from './loop-flow-spec-recipe'
import type { LoopRunRequest } from './loop-run-manager'
import { prepareCoreExecution } from '../../../core-execution'
import { loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'
import { runAgentRuntimeInvocation } from '../../agent-runtime/runtime/agent-runtime-bridge'

const pipeline = mkdtempSync(join(tmpdir(), 'flow-pipeline-'))
vi.mock('../../../core-execution', () => ({ prepareCoreExecution: vi.fn(() => ({ contextPath: join(pipeline, 'desktop-context.json'), env: {} })), checkCoreCompletion: vi.fn() }))
vi.mock('../../agent-runtime/runtime/agent-runtime-loader', () => ({ loadCoreAgentRuntime: vi.fn() }))
vi.mock('../../agent-runtime/runtime/agent-runtime-bridge', () => ({
  runAgentRuntimeInvocation: vi.fn(), runAgentRuntimeControl: vi.fn(), runtimeChangeName: () => 'frozen-change', readFrozenRuntimeHost: vi.fn(),
}))
beforeEach(() => { vi.clearAllMocks(); vi.mocked(runAgentRuntimeInvocation).mockResolvedValue({ text: '', failed: false, runtimeStatus: 'succeeded' }) })

const BASE = 'b'.repeat(40)
const request: LoopRunRequest = {
  loopId: 'factory:flow-spec', projectId: 'project', cwd: '/wt', provider: 'claude', model: 'm', graph: flowSpecGraph(),
  flowDerivation: { baseSha: BASE, summary: '---\ntranscriptTurns: 2\n---\n# Intent conversation summary\n' },
}

it('freezes the Intent reservation commit as the Core change base and writes the summary', async () => {
  await createLoopExecutors({ env: {} }).runDefinition!({ onLine: vi.fn(), onRuntimeEvent: vi.fn(), onSpawn: vi.fn(), request, runId: 'run-1' })
  expect(vi.mocked(prepareCoreExecution).mock.calls[0]![0]).toMatchObject({ repositoryBaseSha: BASE })
  expect(readFileSync(join(pipeline, FLOW_SUMMARY_FILE), 'utf8')).toContain('transcriptTurns: 2')
})

it('refuses a derive-change graph on a Core without deriveChange', async () => {
  const executors = createLoopExecutors({ env: {} })
  vi.mocked(loadCoreAgentRuntime).mockResolvedValue({ api: { capabilities: { engineV2: 1, workflowDefinitions: 1 } } } as never)
  await expect(executors.assertDefinitionSupport!(flowSpecGraph())).rejects.toThrow(/engine_unsupported/)
  vi.mocked(loadCoreAgentRuntime).mockResolvedValue({ api: { capabilities: { engineV2: 1, workflowDefinitions: 1, deriveChange: 1 } } } as never)
  await expect(executors.assertDefinitionSupport!(flowSpecGraph())).resolves.toBeUndefined()
})

it('names the derived change after the Intent spec title, never addenda, with no delta briefing', async () => {
  const flowRequest: LoopRunRequest = {
    ...request,
    spec: { id: 8, title: 'Add more visual effects to ArkanoidEX', description: 'effects', status: 'in_progress' } as never,
    addenda: { ids: ['0337c497'], briefing: 'Include all effects, each toggleable from Options' } as never,
    ticketId: 8,
  }
  await createLoopExecutors({ env: {} }).runDefinition!({ onLine: vi.fn(), onRuntimeEvent: vi.fn(), onSpawn: vi.fn(), request: flowRequest, runId: 'run-2' })
  const invocation = vi.mocked(runAgentRuntimeInvocation).mock.calls[0]![0] as { change: string }
  expect(invocation.change).toBe('add-more-visual-effects-to-arkanoidex')
  expect(invocation.change).not.toMatch(/addenda/)
  const run = vi.mocked(prepareCoreExecution).mock.calls[0]![0] as { run: { spec?: { description?: string } } }
  expect(run.run.spec?.description ?? '').not.toContain('DELTA OPENSPEC TARGET')
})

it('hands the accepted scope to the spec and to every step: deriver context, reviewer and fixer prompts', async () => {
  const scope = '## Accepted scope (what the person asked for and decided during the Intent session)\n\n1. 2026-11-22 09:10 UTC — Person asked: "quiero las reglas de Switch"'
  const flowRequest: LoopRunRequest = {
    ...request,
    flowDerivation: { ...request.flowDerivation!, acceptedScope: scope },
    spec: { id: 11, title: 'Disposición horizontal', description: '### Constraints\n\n- No cambiar reglas ni lógica de juego', status: 'in_progress' } as never,
    ticketId: 11,
  }
  await createLoopExecutors({ env: {} }).runDefinition!({ onLine: vi.fn(), onRuntimeEvent: vi.fn(), onSpawn: vi.fn(), request: flowRequest, runId: 'run-3' })
  const run = vi.mocked(prepareCoreExecution).mock.calls[0]![0] as { run: { spec?: { description?: string } } }
  const description = run.run.spec?.description ?? ''
  // The scope follows the intent's constraint it supersedes.
  expect(description.indexOf('No cambiar reglas')).toBeLessThan(description.indexOf(scope))
  const invocation = vi.mocked(runAgentRuntimeInvocation).mock.calls[0]![0] as { prepareDefinition: (config: { roles: Record<string, unknown> }) => { nodes: Record<string, { params: Record<string, unknown> }> } }
  const definition = invocation.prepareDefinition({ roles: {} })
  for (const id of ['review', 'fix']) expect(String(definition.nodes[id]!.params.prompt), id).toContain(scope)
})

it('restores the conversation summary when a fork (Relaunch) resumes in a new pipeline directory', async () => {
  const { readFrozenRuntimeHost } = await import('../../agent-runtime/runtime/agent-runtime-bridge')
  vi.mocked(readFrozenRuntimeHost).mockReturnValue({ cwd: '/wt', env: {} } as never)
  const fork = mkdtempSync(join(tmpdir(), 'flow-fork-'))
  await createLoopExecutors({ env: {} }).runDefinition!({ onLine: vi.fn(), onRuntimeEvent: vi.fn(), onSpawn: vi.fn(), request, runId: 'fork-1', resume: true, contextPath: join(fork, 'desktop-context.json') } as never)
  expect(readFileSync(join(fork, FLOW_SUMMARY_FILE), 'utf8')).toBe(request.flowDerivation!.summary)
  // A run that is not Intent -> Spec gets no summary file.
  const other = mkdtempSync(join(tmpdir(), 'flow-fork-'))
  await createLoopExecutors({ env: {} }).runDefinition!({ onLine: vi.fn(), onRuntimeEvent: vi.fn(), onSpawn: vi.fn(), request: { ...request, flowDerivation: undefined }, runId: 'fork-2', resume: true, contextPath: join(other, 'desktop-context.json') } as never)
  expect(() => readFileSync(join(other, FLOW_SUMMARY_FILE), 'utf8')).toThrow()
})
