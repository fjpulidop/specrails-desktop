import { describe, expect, it } from 'vitest'
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

describe('host blockers', () => {
  const paired = { engineV2: 1, workflowDefinitions: 1, workflowAgentSteps: 1, hostBlockers: 1, setupCommands: 1 }
  const compile = (graph: ReturnType<typeof configurableImplementGraph>) => compileLoopToDefinition(graph, { id: 'implement', title: 'Implement', provider: 'claude', constants: {}, roles: graph.config.agents!.roles, repositoryCount: 1, changeId: 'example' })
  it('opts both verify nodes into host blockers and routes blocked to a dedicated end with the structured blocker', () => {
    const graph = configurableImplementGraph(paired)
    const definition = compile(graph)
    for (const id of ['verify', 'verify-archive']) {
      expect(definition.nodes[id].params).toMatchObject({ commands: 'configured', additionalCommandsFrom: 'architect', setup: 'configured', hostBlockers: true })
      expect(definition.nodes[id].ends).toMatchObject({ blocked: id === 'verify' ? 'host-blocked' : 'host-blocked-archive' })
    }
    expect(definition.nodes['host-blocked'].params).toMatchObject({ outcome: 'failure', blockerFrom: 'verify', reason: expect.stringContaining('Host blocker ({{outputs.verify.blocker.kind}}): {{outputs.verify.blocker.reason}} Required action: {{outputs.verify.blocker.requiredAction}}') })
    expect(definition.nodes['host-blocked-archive'].params).toMatchObject({ blockerFrom: 'verify-archive' })
    expect(definition.nodes['fixer-blocked'].params).toMatchObject({ outcome: 'failure', blockerFrom: 'fixer', reason: expect.stringContaining('Fixer reported a host blocker ({{outputs.fixer.structured.blocker.kind}})') })
    expect(factoryLoopsForCapabilities(paired).find(loop => loop.id === 'factory:implement')!.graph.nodes.some(node => node.id === 'host-blocked')).toBe(true)
  })
  it('routes a fixer-declared blocker to fixer-blocked before the progress check, on every Core generation', () => {
    for (const capabilities of [paired, { engineV2: 1, workflowDefinitions: 1, workflowAgentSteps: 1 }]) {
      const definition = compile(configurableImplementGraph(capabilities))
      expect(definition.nodes.fixer.ends.next).toBe('correction-blocker')
      expect(definition.nodes['correction-blocker'].params.expr).toBe('exists($outputs.fixer.structured.blocker) && $outputs.fixer.structured.blocker != null')
      expect(definition.nodes['correction-blocker'].ends).toEqual({ true: 'fixer-blocked', false: 'correction-progress' })
      expect(definition.nodes['correction-progress'].ends).toEqual({ true: 'tasks', false: 'correction-stalled' })
      const schema = definition.nodes.fixer.params.structuredOutput as { required: string[]; properties: { blocker: { properties: { kind: { enum: string[] } }; required: string[] } } }
      expect(schema.required).toEqual(['summary', 'incomplete'])
      expect(schema.properties.blocker.properties.kind.enum).toEqual(['network', 'credential', 'environment-variable', 'toolchain', 'setup', 'environment', 'scope'])
      expect(schema.properties.blocker.required).toEqual(['kind', 'requiredAction'])
      expect(definition.nodes.developer.params.structuredOutput).toMatchObject({ properties: { blocker: expect.any(Object) } })
    }
    for (const id of ['developer', 'fixer']) expect(compile(configurableImplementGraph(paired)).nodes[id].params.verificationProposalsFrom).toBe('architect')
  })
  it('compiles the pre-blocker shape when the installed Core does not advertise hostBlockers', () => {
    const definition = compile(configurableImplementGraph({ engineV2: 1, workflowDefinitions: 1, workflowAgentSteps: 1 }))
    for (const id of ['verify', 'verify-archive']) {
      expect(definition.nodes[id].params).toEqual({ commands: 'configured', additionalCommandsFrom: 'architect' })
      expect(definition.nodes[id].ends).not.toHaveProperty('blocked')
    }
    for (const id of ['developer', 'fixer']) expect(definition.nodes[id].params).not.toHaveProperty('verificationProposalsFrom')
    expect(definition.nodes).not.toHaveProperty('host-blocked')
    expect(definition.nodes['fixer-blocked'].params).not.toHaveProperty('blockerFrom')
    expect(compile(configurableImplementGraph())).toEqual(definition)
  })
})
