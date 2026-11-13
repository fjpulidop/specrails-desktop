import { describe, expect, it } from 'vitest'
import { configurableImplementGraph, PLAN_REPAIR_LIMIT } from './loop-implement-recipe'
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
it('ends on a deterministic OpenSpec archive rejection instead of cycling verify → review → archive', () => {
  const graph = configurableImplementGraph()
  const edge = (source: string, label: string) => graph.edges.find(item => item.source === source && item.label === label)?.target
  expect(edge('archive', 'failed')).toBe('archive-retry')
  const retry = graph.nodes.find(node => node.id === 'archive-retry')!
  expect(retry.data!.params!.expr).toBe('exists($outputs.archive.reason) && ($outputs.archive.reason == "unverified" || $outputs.archive.reason == "candidate_changed") && $vars.archiveRetries < 2')
  expect([edge('archive-retry', 'true'), edge('archive-retry', 'false')]).toEqual(['count-archive-retry', 'archive-failed'])
  expect(edge('count-archive-retry', 'next')).toBe('verify')
  expect(graph.nodes.find(node => node.id === 'count-archive-retry')!.data!.params).toEqual({ increment: { archiveRetries: 1 } })
  expect(graph.nodes.find(node => node.id === 'initialize-corrections')!.data!.params!.set).toMatchObject({ archiveRetries: 0 })
  expect(graph.nodes.find(node => node.id === 'archive-failed')!.data).toMatchObject({ outcome: 'failure', reason: expect.stringContaining('could not archive change {{run.changeId}}') })
  const definition = compileLoopToDefinition(graph, { id: 'implement', title: 'Implement', provider: 'claude', constants: {}, roles: graph.config.agents!.roles, repositoryCount: 1, changeId: 'example' })
  expect(definition.nodes['archive-failed']).toMatchObject({ kind: 'end' })
})
it('bounds plan repairs after a failed OpenSpec validation instead of re-planning until the iteration budget runs out', () => {
  const graph = configurableImplementGraph()
  const edge = (source: string, label: string) => graph.edges.find(item => item.source === source && item.label === label)?.target
  const params = (id: string) => graph.nodes.find(node => node.id === id)!.data!.params
  expect(graph.edges.find(item => item.source === 'start')!.target).toBe('initialize-plan')
  expect(params('initialize-plan')).toEqual({ set: { planRepairs: 0, planRepairLimit: PLAN_REPAIR_LIMIT } })
  expect(edge('initialize-plan', 'next')).toBe('architect')
  expect(edge('validate', 'fail')).toBe('plan-repair-budget')
  // A plan the artifact contract refuses at freeze shares the same repair budget.
  expect(edge('freeze', 'fail')).toBe('plan-repair-budget')
  expect(params('plan-repair-budget')!.expr).toBe('$vars.planRepairs < $vars.planRepairLimit')
  expect([edge('plan-repair-budget', 'true'), edge('plan-repair-budget', 'false')]).toEqual(['count-plan-repair', 'plan-invalid'])
  expect(params('count-plan-repair')).toEqual({ increment: { planRepairs: 1 } })
  expect(edge('count-plan-repair', 'next')).toBe('architect')
  expect(graph.nodes.find(node => node.id === 'plan-invalid')!.data).toMatchObject({ outcome: 'failure', reason: expect.stringContaining('## Purpose') })
  // The architect learns that main specs are read-only and how to avoid a legacy one.
  expect(String(params('architect')!.prompt)).toContain('put these requirements in a delta for a new capability')
  const definition = compileLoopToDefinition(graph, { id: 'implement', title: 'Implement', provider: 'claude', constants: {}, roles: graph.config.agents!.roles, repositoryCount: 1, changeId: 'example' })
  expect(definition.nodes['plan-invalid']).toMatchObject({ kind: 'end' })
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
  it('routes a fixer-declared blocker to its kind check before the progress check, on every Core generation', () => {
    for (const capabilities of [paired, { engineV2: 1, workflowDefinitions: 1, workflowAgentSteps: 1 }]) {
      const definition = compile(configurableImplementGraph(capabilities))
      expect(definition.nodes.fixer.ends.next).toBe('correction-blocker')
      expect(definition.nodes['correction-blocker'].params.expr).toBe('exists($outputs.fixer.structured.blocker) && $outputs.fixer.structured.blocker != null')
      expect(definition.nodes['correction-blocker'].ends).toEqual({ true: 'fixer-blocker-kind', false: 'correction-progress' })
      expect(definition.nodes['correction-progress'].ends).toEqual({ true: 'tasks', false: 'correction-stalled' })
      const schema = definition.nodes.fixer.params.structuredOutput as { required: string[]; properties: { blocker: { properties: { kind: { enum: string[] } }; required: string[] } } }
      expect(schema.required).toEqual(['summary', 'incomplete'])
      expect(schema.properties.blocker.properties.kind.enum).toEqual(['network', 'credential', 'environment-variable', 'toolchain', 'setup', 'environment', 'scope'])
      expect(schema.properties.blocker.required).toEqual(['kind', 'requiredAction'])
      expect(definition.nodes.developer.params.structuredOutput).toMatchObject({ properties: { blocker: expect.any(Object) } })
    }
    for (const id of ['developer', 'fixer']) expect(compile(configurableImplementGraph(paired)).nodes[id].params.verificationProposalsFrom).toBe('architect')
  })
  it('bounds the developer loop: incomplete tasks retry only with progress and budget', () => {
    for (const capabilities of [paired, { engineV2: 1, workflowDefinitions: 1, workflowAgentSteps: 1 }]) {
      const definition = compile(configurableImplementGraph(capabilities))
      expect(definition.nodes.developer.ends.next).toBe('developer-blocker')
      expect(definition.nodes.developer.params.prompt).toContain('return the structured blocker')
      expect(definition.nodes['developer-blocker'].ends).toEqual({ true: 'developer-blocker-kind', false: 'tasks' })
      // Incomplete tasks never route straight back to the developer.
      expect(definition.nodes.tasks.ends).toMatchObject({ pass: 'verify', fail: 'implementation-budget' })
      expect(definition.nodes['initialize-corrections'].params).toMatchObject({ set: { implementationAttempts: 0, implementationLimit: 3 } })
      expect(definition.nodes['implementation-budget'].ends).toEqual({ true: 'implementation-progress', false: 'implementation-exhausted' })
      expect(definition.nodes['implementation-progress'].params.expr).toBe('!exists($vars.lastImplementationHash) || $outputs.developer.candidateHash != $vars.lastImplementationHash')
      expect(definition.nodes['implementation-progress'].ends).toEqual({ true: 'begin-implementation', false: 'implementation-stalled' })
      expect(definition.nodes['begin-implementation'].params).toMatchObject({ increment: { implementationAttempts: 1 }, set: { lastImplementationHash: '{{outputs.developer.candidateHash}}' } })
      expect(definition.nodes['begin-implementation'].ends).toMatchObject({ next: 'developer' })
      for (const end of ['implementation-stalled', 'implementation-exhausted']) expect(definition.nodes[end].params).toMatchObject({ outcome: 'failure', reason: expect.stringContaining('{{outputs.developer.structured.incomplete}}') })
      expect(definition.nodes['developer-blocked'].params).toMatchObject({ outcome: 'failure', reason: expect.stringContaining('{{outputs.developer.structured.blocker.requiredAction}}') })
    }
    expect(compile(configurableImplementGraph(paired)).nodes['developer-blocked'].params).toMatchObject({ blockerFrom: 'developer' })
  })
  it('ends on a blocker only when it needs the person or the host confirms it', () => {
    for (const capabilities of [paired, { engineV2: 1, workflowDefinitions: 1, workflowAgentSteps: 1 }]) {
      const nodes = compile(configurableImplementGraph(capabilities)).nodes
      expect(nodes.developer.params.prompt).toContain('A failing test, a test you cannot make pass, or unexpected browser or tool behaviour is NOT a host blocker')
      // Credentials, network and variables still end the run at once.
      expect(nodes['developer-blocker-kind'].params.expr).toBe('$outputs.developer.structured.blocker.kind == "credential" || $outputs.developer.structured.blocker.kind == "network" || $outputs.developer.structured.blocker.kind == "environment-variable"')
      // Anything else runs the host's own verification: failures go to the fixer, passes to the reviewer.
      expect(nodes['developer-blocker-kind'].ends).toEqual({ true: 'developer-blocked', false: 'verify' })
      expect(nodes.verify.ends).toMatchObject({ pass: 'reviewer', fail: 'correction-context' })
      // The fixer follows the same rule: a stale or unreproduced blocker cannot end the run unchecked.
      expect(nodes['correction-blocker'].ends).toEqual({ true: 'fixer-blocker-kind', false: 'correction-progress' })
      expect(nodes['fixer-blocker-kind'].params.expr).toBe('$outputs.fixer.structured.blocker.kind == "credential" || $outputs.fixer.structured.blocker.kind == "network" || $outputs.fixer.structured.blocker.kind == "environment-variable"')
      expect(nodes['fixer-blocker-kind'].ends).toEqual({ true: 'fixer-blocked', false: 'verify' })
      for (const role of ['developer', 'fixer']) expect(nodes[role].params.prompt).toContain('Report only a blocker you reproduced in this turn')
      expect(nodes.fixer.params.prompt).not.toContain('the host ends the run with your required action')
    }
    // A host precondition the verification hits still ends as a host blocker.
    expect(compile(configurableImplementGraph(paired)).nodes.verify.ends).toMatchObject({ blocked: 'host-blocked' })
  })
  it('tells the architect that tasks never edit frozen artifacts and gates are not invented', () => {
    const prompt = compile(configurableImplementGraph(paired)).nodes.architect.params.prompt as string
    expect(prompt).toContain('never write a task that edits or records evidence in them')
    expect(prompt).toContain('Do not invent prerequisites or gates the workflow does not run')
    expect(prompt).toContain('is a question with low confidence, not a task or a gate')
  })
  it('verifies the unchanged code before the developer when Core summarizes verification', () => {
    const withSummary = compile(configurableImplementGraph({ ...paired, verificationSummary: 1 })).nodes
    expect(withSummary['initialize-corrections'].ends).toMatchObject({ next: 'baseline' })
    expect(withSummary.baseline).toMatchObject({ kind: 'verify', params: { commands: 'configured', setup: 'configured', hostBlockers: true } })
    // Failures only inform the roles; a broken setup or host precondition ends before any AI spend.
    expect(withSummary.baseline.ends).toEqual({ pass: 'developer', fail: 'developer', failed: 'developer', blocked: 'host-blocked-baseline' })
    expect(withSummary['host-blocked-baseline'].params).toMatchObject({ outcome: 'failure', blockerFrom: 'baseline' })
    for (const role of ['developer', 'fixer', 'reviewer']) expect(withSummary[role].params.prompt).toContain('{{outputs.baseline.summary}}')
    // Without the summary (or host blockers) the shape is unchanged.
    const without = compile(configurableImplementGraph(paired)).nodes
    expect(without).not.toHaveProperty('baseline')
    expect(without['initialize-corrections'].ends).toMatchObject({ next: 'developer' })
    for (const role of ['developer', 'fixer', 'reviewer']) expect(without[role].params.prompt).not.toContain('outputs.baseline')
  })
  it('ties acceptance criteria to the verification that proves them', () => {
    const nodes = compile(configurableImplementGraph(paired)).nodes
    expect(nodes.architect.params.prompt).toContain('Tie every acceptance criterion to the check that proves it')
    expect(nodes.architect.params.prompt).toContain('never plan to record that evidence by hand')
    expect(nodes.reviewer.params.prompt).toContain('name the missing verification command in issues')
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
    expect(definition.nodes['developer-blocked'].params).not.toHaveProperty('blockerFrom')
    expect(compile(configurableImplementGraph())).toEqual(definition)
  })
})
