import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { factoryLoopsForCapabilities, getFactoryLoop } from './loop-factory'
import { compileLoopToDefinition } from './loop-definition'
import { isDefinitionGraph, validateLoopGraph } from './loop-graph'
import { FREESTYLE_TEMPLATE_ID, LOOP_TEMPLATES, QUICK_SDD_TEMPLATE_ID, loopTemplatesForCapabilities } from './loop-templates'
import { classifyLoopEffect } from './loop-effect'

const capabilities = { engineV2: 1, workflowDefinitions: 1 }
const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT ?? path.resolve(process.cwd(), '../specrails-core')
const cli = path.join(core, 'dist/agent-runtime/cli.js')
describe('Core factory definitions', () => {
  it('selects eight Core starters without changing legacy catalog identities', () => {
    const former = [QUICK_SDD_TEMPLATE_ID, FREESTYLE_TEMPLATE_ID]
    const ids = [...LOOP_TEMPLATES.map(template => template.id), ...former]
    // Older Core: every entry (starters and the two former built-ins) is a legacy graph.
    for (const legacy of [loopTemplatesForCapabilities({}), loopTemplatesForCapabilities({ engineV2: 1 })]) {
      expect(legacy.map(template => template.id)).toEqual(ids)
      expect(legacy.slice(0, LOOP_TEMPLATES.length)).toEqual(LOOP_TEMPLATES)
      expect(legacy.some(template => isDefinitionGraph(template.graph))).toBe(false)
    }
    const templates = loopTemplatesForCapabilities(capabilities)
    expect(templates.map(template => template.id)).toEqual(ids)
    const definitions = templates.filter(template => isDefinitionGraph(template.graph) && !former.includes(template.id))
    expect(definitions).toHaveLength(8)
    // The former built-ins are Core definitions too, compiled by the same recipe.
    for (const id of former) expect(isDefinitionGraph(templates.find(template => template.id === id)!.graph), id).toBe(true)
    for (const template of definitions) {
      expect(validateLoopGraph(template.graph), template.id).toMatchObject({ valid: true })
      const definition = compileLoopToDefinition(template.graph, { id: template.id, title: template.name, provider: 'claude', constants: {}, repositoryCount: 1 })
      const readOnly = ['ci-watch', 'deploy-check'].includes(template.id)
      expect(classifyLoopEffect(template.graph), template.id).toBe(readOnly ? 'read-only' : 'mutating')
      expect(definition.delivery.requiresVerified, template.id).toBe(!readOnly)
      if (!readOnly) expect(Object.values(definition.nodes).some(node => node.kind === 'verify')).toBe(true)
    }
  })

  it.skipIf(!existsSync(cli))('validates all eight starter templates with the actual paired Core', () => {
    for (const template of loopTemplatesForCapabilities(capabilities).filter(template => isDefinitionGraph(template.graph))) {
      const definition = compileLoopToDefinition(template.graph, { id: template.id, title: template.name, provider: 'claude', constants: {}, repositoryCount: 1 })
      const stdout = execFileSync(process.env.SPECRAILS_CORE_NODE ?? process.execPath, [cli, 'workflows', 'validate', '--stdin', '--structural'], { input: JSON.stringify(definition), encoding: 'utf8' })
      expect(JSON.parse(stdout), template.id).toMatchObject({ type: 'runtime-definition-validated', ok: true })
    }
  })
  it('keeps stable factory aliases and explicitly selects the advertised engine', () => {
    expect(factoryLoopsForCapabilities({}).every(factory => !isDefinitionGraph(factory.graph))).toBe(true)
    expect(factoryLoopsForCapabilities({ engineV2: 1 }).every(factory => !isDefinitionGraph(factory.graph))).toBe(true)
    expect(factoryLoopsForCapabilities(capabilities).every(factory => isDefinitionGraph(factory.graph))).toBe(true)
    expect(getFactoryLoop('factory:batch', capabilities)?.graph).toEqual(getFactoryLoop('factory:implement', capabilities)?.graph)
    // Retired built-ins resolve to nothing: they are gallery templates now.
    for (const id of ['factory:revision', 'factory:openspec', 'factory:sdd-quick-openspec', 'factory:freestyle']) expect(getFactoryLoop(id, capabilities), id).toBeUndefined()
  })
  it('compiles every factory with global verified delivery and a bounded graph', () => {
    for (const factory of factoryLoopsForCapabilities(capabilities)) {
      expect(validateLoopGraph(factory.graph), factory.id).toMatchObject({ valid: true })
      const definition = compileLoopToDefinition(factory.graph, { id: factory.id, title: factory.name, provider: 'claude', constants: {}, repositoryCount: 2 })
      expect(definition.delivery.requiresVerified).toBe(true)
      expect(definition.maxTransitions).toBeGreaterThan(0)
      if (factory.id === 'factory:implement') {
        // One aggregate implementation over every rail ticket — no map/join.
        expect(Object.values(definition.nodes).some((node) => (node as { kind?: string }).kind === 'map')).toBe(false)
      }
    }
  })
  it.skipIf(!existsSync(cli))('passes the actual paired Core validator for every published factory shape', () => {
    for (const factory of factoryLoopsForCapabilities(capabilities)) {
      const definition = compileLoopToDefinition(factory.graph, { id: factory.id, title: factory.name, provider: 'claude', constants: {}, repositoryCount: 2 })
      const stdout = execFileSync(process.env.SPECRAILS_CORE_NODE ?? process.execPath, [cli, 'workflows', 'validate', '--stdin', '--structural'], { input: JSON.stringify(definition), encoding: 'utf8', env: { ...process.env, OPENSPEC_TELEMETRY: '0' } })
      expect(JSON.parse(stdout.trim().split('\n').at(-1)!), factory.id).toMatchObject({ type: 'runtime-definition-validated', ok: true })
    }
  })
})
