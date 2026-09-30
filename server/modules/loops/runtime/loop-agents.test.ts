import { describe, expect, it } from 'vitest'
import { defaultLoopAgents } from './loop-agents'
import { coreFactoryGraph } from './loop-core-factory'
import { compileLoopToDefinition } from './loop-definition'
import { loopTemplatesForCapabilities } from './loop-templates'
import { classifyLoopEffect } from './loop-effect'

describe('loop-owned agent recipes', () => {
  it('expands Implement into independent operations and retains real verification routing', () => {
    const graph = coreFactoryGraph('implement', true)
    expect(graph.nodes.filter(node => node.data?.kind === 'implementation')).toHaveLength(0)
    expect(graph.nodes.filter(node => node.data?.kind === 'implementation-step').map(node => node.id)).toEqual(['architect', 'developer', 'fixer', 'verify', 'reviewer', 'archive'])
    const compiled = compileLoopToDefinition(graph, { provider: 'codex', constants: {} })
    expect(compiled.nodes.verify.ends).toMatchObject({ next: 'reviewer', incomplete: 'developer', rejected: 'fixer' })
    expect(compiled.nodes.reviewer.ends).toMatchObject({ next: 'archive', rejected: 'fixer' })
    expect(compiled.delivery.requiresVerified).toBe(true)
    expect(classifyLoopEffect(graph)).toBe('mutating')
  })
  it('owns the same defaults across projects and clones mutable definitions', () => {
    const first = defaultLoopAgents(), second = defaultLoopAgents()
    first.rolePrompts!.developer = 'Changed only this recipe'
    first.agents.developer.provider = 'codex'
    expect(second.rolePrompts!.developer).not.toBe(first.rolePrompts!.developer)
    expect(second.agents.developer.provider).toBe('inherit')
  })
  it('binds prompt engines from the recipe instead of the launch project', () => {
    const graph = coreFactoryGraph('freestyle', true)
    graph.config.agents!.agents.developer = { provider: 'codex', model: 'loop-model' }
    const compile = (provider: string) => compileLoopToDefinition(graph, { provider, model: 'project-model', constants: {} })
    expect(compile('claude').nodes.implement.params.engine).toEqual({ provider: 'codex', model: 'loop-model' })
    expect(compile('kimi').nodes.implement.params.engine).toEqual(compile('claude').nodes.implement.params.engine)
  })
  it('does not inherit launch model or effort when the loop uses the same provider', () => {
    const graph = coreFactoryGraph('quick-sdd', true)
    graph.config.agents!.agents.developer.provider = 'claude'
    graph.config.agents!.rolePrompts!.developer = 'A loop-owned task definition with literal {{braces}}'
    const compiled = compileLoopToDefinition(graph, { provider: 'claude', model: 'project-only', effort: 'high', constants: {} })
    expect(compiled.nodes.apply.params.engine).toEqual({ provider: 'claude' })
    expect(compiled.nodes.apply.params.nativeCommand).toMatchObject({ args: expect.stringContaining('A loop-owned task definition with literal {{{{braces}}') })
  })
})

it('all modern starter recipes own agents and ship exposes independent operations', () => {
  const templates = loopTemplatesForCapabilities({ engineV2: 1, workflowDefinitions: 1, implementationSteps: 1 })
  const ship = templates.find(template => template.id === 'ship-and-green')!
  expect(ship.graph.nodes.filter(node => node.data?.kind === 'implementation-step')).toHaveLength(6)
  expect(ship.graph.nodes.some(node => node.data?.kind === 'implementation')).toBe(false)
  for (const template of templates.filter(template => template.graph.nodes.some(node => node.type === 'core'))) {
    expect(template.graph.config.agents).toBeDefined()
    expect(() => compileLoopToDefinition(template.graph, { provider: 'claude', constants: {} })).not.toThrow()
  }
})

it('refuses new independent operations that would fall back to project agents', () => {
  const graph = coreFactoryGraph('implement', true)
  delete graph.config.agents
  expect(() => compileLoopToDefinition(graph, { provider: 'claude', constants: {} })).toThrow('loop-owned agents')
})

it('inherits the mission engine unless a step explicitly selects another provider', () => {
  const graph = coreFactoryGraph('quick-sdd', true)
  const launch = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', constants: {} }
  expect(compileLoopToDefinition(graph, launch).nodes.apply.params.engine).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' })
  graph.config.agents!.agents.developer = { provider: 'claude' }
  expect(compileLoopToDefinition(graph, launch).nodes.apply.params.engine).toEqual({ provider: 'claude' })
})
