import { expect, it } from 'vitest'
import { convertLegacyLoop, LEGACY_DECIDER_ROLE } from './loop-compat'
import { compileLoopToDefinition } from './loop-definition'
import { validateLoopGraph, type LoopGraph } from './loop-graph'
import { FACTORY_LOOPS } from './loop-factory'
import { LEGACY_LOOP_TEMPLATES } from './loop-templates'
const graph = (): LoopGraph => ({
  nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 } },
    { id: 'work', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Verify', requireVerificationPass: true } },
    { id: 'decide', type: 'decider', position: { x: 0, y: 2 }, data: { goal: 'Meet every requirement' } },
    { id: 'done', type: 'end', position: { x: 0, y: 3 } }],
  edges: [{ id: 'start-work', source: 'start', target: 'work' }, { id: 'work-decide', source: 'work', target: 'decide' },
    { id: 'continue', source: 'decide', target: 'work', branch: 'continue' }, { id: 'stop', source: 'decide', target: 'done', branch: 'stop' }],
  config: { maxIterations: 3, timeoutMinutes: 0, aiStepTimeoutMinutes: 0 },
})
it('preserves execution IDs, frozen input and declared decision binding in a valid Core draft', () => {
  const source = graph(), original = structuredClone(source), result = convertLegacyLoop(source)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) throw Error('conversion failed')
  expect(source).toEqual(original)
  expect(validateLoopGraph(result.graph).valid).toBe(true)
  expect(result.nodeIds).toMatchObject({ work: 'work', decide: 'decide' })
  expect(result.graph.config.legacyDeciderRole).toBe(LEGACY_DECIDER_ROLE)
  const definition = compileLoopToDefinition(result.graph, { provider: 'claude', model: 'rail-model', constants: {} })
  expect(definition.nodes.work.params).toMatchObject({ engine: { provider: 'claude', model: 'rail-model' }, timeoutMs: 0, sentinel: 'verification' })
  expect(definition.nodes.decide.params).toMatchObject({ roleId: LEGACY_DECIDER_ROLE, continueWhen: '$vars.compatPassFailed == true' })
  expect(definition.delivery.requiresVerified).toBe(true)
})
it('remaps unsafe/reserved identifiers deterministically without collisions', () => {
  const source = graph()
  source.nodes[1].id = 'next'; source.edges[0].target = 'next'; source.edges[1].source = 'next'; source.edges[2].target = 'next'
  const first = convertLegacyLoop(source), second = convertLegacyLoop(source)
  expect(first).toEqual(second)
  expect(first.ok).toBe(true)
  if (first.ok) { expect(first.nodeIds.next).not.toBe('next'); expect(new Set(first.graph.nodes.map(node => node.id)).size).toBe(first.graph.nodes.length) }
})
it('requires an explicit repository for an unbound shell and retains the command once supplied', () => {
  const source = graph(); source.nodes[1].type = 'shell'; source.nodes[1].data = { command: 'npm test' }
  expect(convertLegacyLoop(source)).toMatchObject({ ok: false, issues: [{ code: 'repository_binding_required', nodeId: 'work' }] })
  const result = convertLegacyLoop(source, { repositoryId: 'actual-repo' })
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.graph.nodes.find(node => node.id === 'work')?.data?.params).toMatchObject({ repositoryId: 'actual-repo', commandLine: 'npm test', timeoutMs: 600_000 })
})
it('never routes a back edge through variable initialization or the visual Start node', () => {
  const source = graph(); source.edges[2].target = 'start'
  const result = convertLegacyLoop(source)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (result.ok) {
    expect(result.graph.edges.some(edge => edge.target === 'start')).toBe(false)
    expect(() => compileLoopToDefinition(result.graph, { provider: 'claude', constants: {} })).not.toThrow()
  }
})
it('rejects an excessive requested bound without mutating or truncating it', () => {
  const source = graph(); source.config.maxIterations = 100_000
  expect(convertLegacyLoop(source)).toMatchObject({ ok: false, issues: [{ code: 'transition_limit' }] })
  expect(source.config.maxIterations).toBe(100_000)
})
it.each([...FACTORY_LOOPS, ...LEGACY_LOOP_TEMPLATES].map(item => [item.id, item.graph] as const))('projects the saved factory/template shape %s through the existing definition compiler', (_id, source) => {
  const result = convertLegacyLoop(source, { repositoryId: 'repo' })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (result.ok) expect(() => compileLoopToDefinition(result.graph, { provider: 'claude', constants: {}, repositoryCount: 2, spec: { ticketIds: [1, 2] } })).not.toThrow()
})
