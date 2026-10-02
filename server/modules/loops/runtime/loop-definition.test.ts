import { describe, expect, it } from 'vitest'
import { compileLoopToDefinition } from './loop-definition'
import { configurableImplementGraph } from './loop-implement-recipe'
import { coreFactoryGraph } from './loop-core-factory'
import { assertDefinitionGraph, isDefinitionGraph, isDefinitionReviewerPath, validateLoopGraph, type LoopGraph } from './loop-graph'

it('validates a custom evidence reviewer against an exact role-turn instance path', () => {
  const graph = fixture()
  graph.nodes[1].data = { kind: 'component', params: { ref: 'review' } }
  const review = fixture(); review.nodes[1].data = { kind: 'role-turn', params: { roleId: 'auditor', prompt: 'Review' } }
  graph.components = { review }
  expect(isDefinitionReviewerPath(graph, 'work/work')).toBe(true)
  expect(isDefinitionReviewerPath(graph, 'review/work')).toBe(false)
  expect(isDefinitionReviewerPath(graph, 'work/finish')).toBe(false)
  expect(isDefinitionReviewerPath(graph, '../work')).toBe(false)
  graph.config.reviewerStepId = 'work/finish'
  expect(validateLoopGraph(graph)).toMatchObject({ valid: false })
})

const launch = {
  id: 'factory:quick',
  title: 'Quick workflow',
  constants: { RULE: 'Verified work' },
  provider: 'claude',
  model: 'chosen-model',
}
function fixture(): LoopGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 } },
      {
        id: 'work',
        type: 'core',
        position: { x: 0, y: 1 },
        data: {
          kind: 'prompt',
          params: {
            text: '{{const:RULE}}: {{spec.title}} / {{run.changeId}}',
            access: 'write',
            sessionContinuity: 'run',
          },
        },
      },
      { id: 'finish', type: 'end', position: { x: 0, y: 2 }, data: { outcome: 'success' } },
    ],
    edges: [
      { id: 'enter', source: 'start', target: 'work' },
      { id: 'success', source: 'work', target: 'finish', label: 'next' },
      { id: 'failure', source: 'work', target: 'finish', label: 'failed' },
    ],
    config: { maxIterations: 3, timeoutMinutes: 2, maxCostUsd: 0.5, maxTokens: 1000 },
  }
}

describe('Core workflow authoring contract', () => {
  it('renders launch data inside command templates without applying implementation instructions to Freestyle', () => {
    const graph = coreFactoryGraph('freestyle', true)
    const definition = compileLoopToDefinition(graph, { ...launch, constants: { GUARDRAILS: 'Keep tests intact' },
      spec: { title: 'Pieza fantasma', description: 'Render {{run.changeId}} and {{cmd:verify}} literally', acceptanceCriteria: ['Ghost predicts landing'] } })
    expect(definition.nodes.implement.params.text).toContain('Title: Pieza fantasma')
    expect(definition.nodes.implement.params.text).toContain('Render {{{{run.changeId}} and {{{{cmd:verify}} literally')
    expect(definition.nodes.implement.params.text).not.toMatch(/\{\{spec\./)
    expect(definition.nodes.implement.params.text).not.toContain('openspec-apply-change')
    expect(definition.nodes.fix.params.text).not.toContain('openspec-apply-change')
    graph.nodes.find(node => node.id === 'fix')!.data!.params!.text = '{{cmd:test}}'
    expect(compileLoopToDefinition(graph, { ...launch, constants: { GUARDRAILS: 'Keep tests intact' } }).nodes.fix.params.text).toContain('Keep tests intact')
    graph.config.agents!.rolePrompts!.developer = 'Custom free agent'
    expect(compileLoopToDefinition(graph, launch).nodes.implement.params.text).toContain('Custom free agent')
  })

  it('compiles scoped assignments without AI bindings and rejects a catalog that lacks them', () => {
    const graph = fixture()
    graph.nodes[1].data = { kind: 'assign', params: { set: { failed: false }, increment: { iteration: 1 } } }
    const before = JSON.stringify(graph)
    expect(validateLoopGraph(graph, [{ kind: 'assign', outcomes: ['next', 'failed'] }]).valid).toBe(true)
    expect(validateLoopGraph(graph, [{ kind: 'prompt', outcomes: ['next', 'failed'] }]).valid).toBe(false)
    const definition = compileLoopToDefinition(graph, launch)
    expect(definition.nodes.work).toMatchObject({ kind: 'assign', params: { set: { failed: false }, increment: { iteration: 1 } } })
    expect(definition.roles).toEqual([])
    expect(definition.delivery.requiresVerified).toBe(false)
    expect(JSON.stringify(graph)).toBe(before)
  })

  it('accepts a structural Core graph and validates labeled edges against the catalog', () => {
    const graph = fixture()
    expect(isDefinitionGraph(graph)).toBe(true)
    expect(validateLoopGraph(graph, [{ kind: 'prompt', outcomes: ['next', 'failed'] }]).valid).toBe(true)
    expect(validateLoopGraph(graph, [{ kind: 'prompt', outcomes: ['next'] }]).errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_BRANCH', edgeId: 'failure' }),
    )
    graph.edges[2].label = 'next'
    expect(validateLoopGraph(graph).valid).toBe(false)
  })

  it('rejects mixed execution and reserved identifiers before compilation', () => {
    const graph = fixture()
    graph.nodes.push({ id: 'legacy', type: 'shell', position: { x: 0, y: 0 } })
    expect(() => assertDefinitionGraph(graph)).toThrow('cannot mix')
    expect(validateLoopGraph(graph).errors.some((error) => error.code === 'MIXED_ENGINES')).toBe(true)
    graph.nodes.pop()
    graph.nodes[1].id = 'next'
    expect(validateLoopGraph(graph).errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_NODE', nodeId: 'next' }),
    )
  })

  it('compiles frozen launch data once and leaves canonical identity to Core', () => {
    const graph = fixture(),
      before = JSON.stringify(graph)
    const definition = compileLoopToDefinition(graph, { ...launch, spec: { title: 'Fix {{cmd:verify}}' } })
    expect(definition.version).toBeUndefined()
    expect(definition.id).toBe('factory-quick')
    expect(definition.entry).toBe('work')
    expect(definition.nodes.start).toBeUndefined()
    expect(definition.nodes.work.params.text).toBe('Verified work: Fix {{{{cmd:verify}} / {{run.changeId}}')
    expect(definition.nodes.work.params.engine).toEqual({ provider: 'claude', model: 'chosen-model' })
    expect(definition.nodes.finish.params.requiresVerified).toBe(true)
    expect(definition.budget).toEqual({ maxCostUsd: 0.5, maxTokens: 1000, maxDurationMs: 120_000 })
    expect(compileLoopToDefinition(graph, { ...launch, spec: { title: 'Fix {{cmd:verify}}' } })).toEqual(
      definition,
    )
    expect(JSON.stringify(graph)).toBe(before)
  })

  it('preserves a node-selected engine and renders native commands for that provider', () => {
    const graph = fixture()
    graph.nodes[1].data!.params = {
      text: '{{cmd:implement}}',
      access: 'write',
      engine: { provider: 'codex', model: 'node-model' },
    }
    const node = compileLoopToDefinition(graph, { ...launch, spec: { id: 8 } }).nodes.work
    expect(node.params.nativeCommand).toEqual({ id: 'implement', args: '#8 --yes' })
    expect(node.params.text).toBeUndefined()
    expect(node.params.engine).toEqual({ provider: 'codex', model: 'node-model' })
  })

  it('derives verification requirements from custom role access, including components', () => {
    const graph = fixture()
    graph.nodes[1].data = {
      kind: 'role-turn',
      params: { roleId: 'security-reviewer', prompt: 'Review', sessionContinuity: 'run' },
    }
    const definition = compileLoopToDefinition(graph, {
      ...launch,
      roles: { 'security-reviewer': { access: 'read' } },
    })
    expect(definition.roles).toEqual(['security-reviewer'])
    expect(definition.delivery.requiresVerified).toBe(false)
    graph.components = { repair: fixture() }
    expect(compileLoopToDefinition(graph, launch).delivery.requiresVerified).toBe(true)
  })

  it('bounds a cycle while preserving all outcome routes', () => {
    const graph = fixture()
    graph.edges[2].target = 'work'
    const definition = compileLoopToDefinition(graph, launch)
    expect(definition.maxTransitions).toBe(6)
    expect(definition.nodes.work.ends).toEqual({ next: 'finish', failed: 'work' })
    graph.edges.push({ id: 'back-to-start', source: 'work', target: 'start', label: 'blocked' })
    expect(() => compileLoopToDefinition(graph, launch)).toThrow('visual Start')
  })
})

it('preserves reusable component inputs and custom local exits', () => {
  const graph = fixture()
  const child = fixture()
  child.inputs = ['changeId']
  child.outputs = ['approved', 'failed']
  child.nodes[2].data = { outcome: 'success', exit: 'approved', reason: 'Reviewed' }
  graph.components = { review: child }
  const component = compileLoopToDefinition(graph, launch).components!.review
  expect(component.inputs).toEqual(['changeId'])
  expect(component.outputs).toEqual(['approved', 'failed'])
  expect(component.nodes.finish.params).toMatchObject({
    outcome: 'success',
    exit: 'approved',
    reason: 'Reviewed',
  })
})

it('includes component visits in the global limit and permits an explicit bound', () => {
  const graph = fixture()
  graph.nodes[1].data = { kind: 'component', params: { ref: 'worker' } }
  graph.components = { worker: fixture() }
  expect(compileLoopToDefinition(graph, launch).maxTransitions).toBe(6)
  graph.config.maxTransitions = 50
  expect(compileLoopToDefinition(graph, launch).maxTransitions).toBe(50)
})
it('uses Core ceiling for opaque composition instead of guessing its internal size', () => {
  const graph = fixture()
  graph.nodes[1].data = { kind: 'implementation', params: {} }
  expect(compileLoopToDefinition(graph, launch).maxTransitions).toBe(10000)
})

it('does not transfer a rail model or effort to a different node-selected provider', () => {
  const graph = fixture()
  graph.nodes[1].data!.params = { text: 'Review', access: 'read', engine: { provider: 'local' } }
  expect(compileLoopToDefinition(graph, { ...launch, effort: 'high' }).nodes.work.params.engine).toEqual({ provider: 'local' })
})


it('requires applied evidence for every frozen addendum before Implement can archive', () => {
  const graph = configurableImplementGraph()
  const original = structuredClone(graph)
  const definition = compileLoopToDefinition(graph, { ...launch, id: 'factory:implement', addendaIds: ['a-first', 'a-second'], briefing: 'Frozen delta' })
  const schema = definition.nodes.reviewer.params.structuredOutput as { required: string[]; properties: { addenda: { required: string[]; properties: Record<string, { properties: { id: { const: string }; verdict: { enum: string[] } } }> } } }
  expect(schema.required).toContain('addenda')
  expect(schema.properties.addenda.required).toEqual(['a0', 'a1'])
  expect(schema.properties.addenda.properties.a0.properties.id.const).toBe('a-first')
  expect(schema.properties.addenda.properties.a1.properties.id.const).toBe('a-second')
  expect(schema.properties.addenda.properties.a0.properties.verdict.enum).toEqual(['applied', 'partial', 'blocked'])
  expect(definition.nodes['review-policy'].params.expr).toContain('$outputs.reviewer.structured.approved == true')
  for (const slot of ['a0', 'a1']) {
    expect(definition.nodes['addenda-review-0'].params.expr).toContain(`$outputs.reviewer.structured.addenda.${slot}.verdict == "applied"`)
    expect(definition.nodes['addenda-review-0'].params.expr).toContain(`$outputs.reviewer.structured.addenda.${slot}.files.length > 0`)
    expect(definition.nodes['addenda-review-0'].params.expr).toContain(`$outputs.reviewer.structured.addenda.${slot}.tests.length > 0`)
  }
  expect(definition.nodes.reviewer.ends.next).toBe('addenda-review-0')
  expect(definition.nodes['addenda-review-0'].ends).toEqual({ true: 'review-policy', false: 'correction-context' })
  expect(definition.nodes['review-policy'].ends).toEqual({ true: 'approve', false: 'correction-context' })
  expect(definition.nodes.archive.params.requiresVerified).toBe(true)
  expect(definition.nodes.architect.params.prompt).toContain('Frozen delta')
  expect(graph).toEqual(original)
  expect(compileLoopToDefinition(graph, { ...launch, id: 'factory:implement' }).nodes.reviewer.params.structuredOutput).not.toHaveProperty('properties.addenda')
})
