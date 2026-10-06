import { expect, it } from 'vitest'
import { configurableImplementGraph } from './loop-implement-recipe'
import { factoryLoopsForCapabilities } from './loop-factory'
import { compileLoopToDefinition } from './loop-definition'

it('defines agent roles, schemas, decisions and approval as editable loop data without Core phases', () => {
  const graph = configurableImplementGraph()
  const turns = graph.nodes.filter(node => node.data?.kind === 'role-turn')
  expect(turns.map(node => node.data!.params!.roleId)).toEqual(['plan', 'build', 'assess', 'correct'])
  expect(turns.every(node => !('phase' in node.data!.params!))).toBe(true)
  expect(graph.nodes.some(node => ['implementation', 'implementation-step'].includes(String(node.data?.kind)))).toBe(false)
  expect(graph.config.journal).toBe('ledger-only')
  expect(graph.config.ticketScope).toBe('all')
  expect(graph.config.reviewerStepId).toBe('reviewer')
  expect(graph.nodes.find(node => node.id === 'approve')!.data!.params).toMatchObject({ bindCandidate: true, enabled: false })
  const definition = compileLoopToDefinition(graph, { id: 'implement', title: 'Implement', provider: 'claude', constants: {}, roles: graph.config.agents!.roles, repositoryCount: 1, changeId: 'example' })
  expect(definition.roles.sort()).toEqual(['assess', 'build', 'correct', 'plan'])
  expect(definition.nodes.archive.params).toMatchObject({ requiresVerified: true })
})
it('uses configurable recipes only when Core advertises the generic capabilities', () => {
  const old = factoryLoopsForCapabilities({ engineV2: 1, workflowDefinitions: 1, implementationSteps: 1 }).find(loop => loop.id === 'factory:implement')!
  expect(old.graph.nodes.some(node => node.data?.kind === 'implementation-step')).toBe(true)
  const latest = factoryLoopsForCapabilities({ engineV2: 1, workflowDefinitions: 1, workflowAgentSteps: 1 }).find(loop => loop.id === 'factory:implement')!
  expect(latest.graph.nodes.some(node => node.data?.kind === 'role-turn')).toBe(true)
  // Declared recipe roles follow the engine's built-in definitions until the user edits them.
  expect(latest.graph.config.agents!.roles!.build.prompt).toBe('inherit:developer')
})
