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
  flowDerivation: { baseSha: BASE, summary: '---\ntranscriptTurns: 2\n---\n# Flow conversation summary\n' },
}

it('freezes the Flow reservation commit as the Core change base and writes the summary', async () => {
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
