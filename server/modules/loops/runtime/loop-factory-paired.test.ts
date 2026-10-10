import { expect, it, vi } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { configurableImplementGraph } from './loop-implement-recipe'
import { compileLoopToDefinition } from './loop-definition'
import { core, coreCliMissing, execute, useFactoryPairing } from './__fixtures__/factory-pairing'

// Factory pairing: every built-in factory, legacy conversion and addendum
// admission through the real bridge and a built Core checkout. Correction and
// configurable Implement paths live in the sibling *-paired.test.ts files so
// CI can run them on separate runners.
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
// Retention copying has its own installed-package tests. Keep real negotiation,
// validation, freezing, process execution and result parsing in this pairing.
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async importOriginal => {
  const original = await importOriginal<typeof import('../../agent-runtime/runtime/agent-runtime-package')>()
  const selected = new Map<string, string>()
  return { ...original,
    retainAgentRuntime: (cli: string, contextPath: string) => { selected.set(contextPath, cli); return cli },
    resolveRetainedAgentRuntime: (contextPath: string) => {
      const cli = selected.get(contextPath)
      if (!cli) throw new Error('Fixture runtime was never retained')
      return cli
    },
  }
})
useFactoryPairing()

it.skipIf(coreCliMissing).each(['implement', 'quick-sdd', 'freestyle'])('executes the %s factory through the real bridge and Core with deterministic local executors', async mode => {
  const actual = await execute(mode)
  if (mode === 'implement') {
    const legacy = await execute(mode, true)
    expect(actual.calls.map(call => call.role)).toEqual(legacy.calls.map(call => call.role))
    expect(actual.calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer'])
  } else if (mode === 'quick-sdd') {
    expect(actual.calls.map(call => call.nativeCommand.id)).toEqual(['opsx:ff', 'opsx:apply'])
  } else {
    expect(actual.calls.map(call => call.role)).toEqual(['prompt', 'prompt', 'loop-decider'])
    expect(actual.calls[0].prompt).toContain('Title: Return two')
    expect(actual.calls[0].prompt).toContain('code.cjs returns two')
    expect(actual.calls[0].prompt).not.toContain('openspec-apply-change')
    expect(actual.calls[1].prompt).not.toContain('openspec-apply-change')
    const terminal = actual.events.filter(event => event.type === 'workflow-event' && event.event.nodePath === 'verify' && event.event.type === 'step_succeeded')
    expect(terminal).toHaveLength(2)
    expect(actual.calls.at(-1)?.access).toBe('read')
  }
}, 180_000)

it.skipIf(coreCliMissing).each(['quick-sdd', 'freestyle'])('resumes a blocked %s factory through the real bridge without replaying completed phases', async mode => {
  const actual = await execute(mode, false, false, mode === 'quick-sdd' ? 'opsx:apply' : 'prompt')
  if (mode === 'quick-sdd') {
    expect(actual.calls.map(call => call.nativeCommand.id)).toEqual(['opsx:ff', 'opsx:apply', 'opsx:apply'])
    expect(actual.calls.at(-1)?.nativeCommand.args).toContain('Return two')
  } else expect(actual.calls.map(call => call.role)).toEqual(['prompt', 'prompt', 'prompt', 'loop-decider'])
}, 180_000)

it.skipIf(coreCliMissing)('does not report Freestyle success when verified checks pass but the decider makes no progress', async () => {
  const actual = await execute('freestyle', false, true)
  expect(actual.result).toMatchObject({ failed: true, runtimeStatus: 'failed', completion: { ok: false } })
  expect(actual.calls.filter(call => call.role === 'loop-decider')).toHaveLength(3)
  const lifecycle = actual.events.filter(event => event.type === 'workflow-event').map(event => event.event)
  expect(lifecycle.some(event => event.type === 'workflow_succeeded')).toBe(false)
  expect(lifecycle.some(event => event.type === 'step_started' && event.nodePath === 'done')).toBe(false)
  expect(lifecycle.some(event => event.type === 'step_failed' && event.nodePath === 'decide')).toBe(true)
}, 180_000)

it.skipIf(coreCliMissing)('continues after a decider question without repeating its paused provider invocation', async () => {
  const actual = await execute('freestyle', false, false, 'loop-decider', 'selected-decider')
  expect(actual.calls.map(call => call.role)).toEqual(['prompt', 'prompt', 'loop-decider', 'prompt', 'loop-decider'])
  expect(actual.calls[3].prompt).toContain('Return two')
  expect(actual.calls.filter(call => call.role === 'loop-decider')).toHaveLength(2)
  expect(actual.calls.filter(call => call.role === 'loop-decider').map(call => call.model)).toEqual(['selected-decider', 'selected-decider'])
  expect(actual.calls.filter(call => call.role === 'prompt').every(call => call.model !== 'selected-decider')).toBe(true)
}, 180_000)

it.skipIf(coreCliMissing).each(['implement'])('executes the converted legacy %s factory with actual implementation evidence', async mode => {
  const actual = await execute(mode, false, false, undefined, undefined, true)
  for (const role of ['architect', 'developer', 'reviewer']) expect(actual.calls.filter(call => call.role === role)).toHaveLength(1)
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  // Compare with the original engine on the same factory: it must match exactly.
  const original = await execute(mode, true)
  expect(actual.calls.map(call => call.role)).toEqual(original.calls.map(call => call.role))
}, 180_000)

it.skipIf(!core)('admits Implement addendum gates and rejects missing, partial or unverified delta coverage', async () => {
  const { validateWorkflowDefinition } = await import(pathToFileURL(path.join(core!, 'dist/agent-runtime/engine/definition-validator.js')).href)
  const { validationPieceRegistry } = await import(pathToFileURL(path.join(core!, 'dist/agent-runtime/engine/pieces/index.js')).href)
  const { parseExpression } = await import(pathToFileURL(path.join(core!, 'dist/agent-runtime/engine/expressions.js')).href)
  const addendaIds = Array.from({ length: 50 }, (_, index) => `addendum-${index}`)
  const definition = compileLoopToDefinition(configurableImplementGraph(), { id: 'factory:implement', provider: 'claude', constants: {}, addendaIds })
  const admitted = validateWorkflowDefinition(definition, validationPieceRegistry(), {}, { structural: true })
  expect(admitted.ok, JSON.stringify(admitted.errors)).toBe(true)
  const gates = Object.values(definition.nodes).filter(node => node.kind === 'condition' && String(node.params.expr).includes('.addenda.'))
  expect(gates).toHaveLength(5)
  const reports = Object.fromEntries(addendaIds.map((id, index) => [`a${index}`, { id, verdict: 'applied', files: ['src/file.ts'], tests: ['unit test passed'] }]))
  const passes = () => gates.every(gate => parseExpression(gate.params.expr).evaluate({ $outputs: { reviewer: { structured: { addenda: reports } } } }))
  expect(passes()).toBe(true)
  reports.a49.verdict = 'partial'
  expect(passes()).toBe(false)
  reports.a49.verdict = 'blocked'
  expect(passes()).toBe(false)
  reports.a49.verdict = 'applied'
  reports.a49.tests = []
  expect(passes()).toBe(false)
  reports.a49.tests = ['unit test passed']; reports.a49.files = []
  expect(passes()).toBe(false)
  delete reports.a49
  expect(passes()).toBe(false)
})
