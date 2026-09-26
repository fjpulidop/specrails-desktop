import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { factoryLoopsForCapabilities, getFactoryLoop } from './loop-factory'
import { compileLoopToDefinition } from './loop-definition'
import { isDefinitionGraph, validateLoopGraph } from './loop-graph'

const capabilities = { engineV2: 1, workflowDefinitions: 1 }
const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT ?? path.resolve(process.cwd(), '../specrails-core')
const cli = path.join(core, 'dist/agent-runtime/cli.js')
describe('Core factory definitions', () => {
  it('keeps stable factory aliases and explicitly selects the advertised engine', () => {
    expect(factoryLoopsForCapabilities({}).every(factory => !isDefinitionGraph(factory.graph))).toBe(true)
    expect(factoryLoopsForCapabilities({ engineV2: 1 }).every(factory => !isDefinitionGraph(factory.graph))).toBe(true)
    expect(factoryLoopsForCapabilities(capabilities).every(factory => isDefinitionGraph(factory.graph))).toBe(true)
    expect(getFactoryLoop('factory:revision', capabilities)?.id).toBe('factory:sdd-quick-openspec')
    expect(getFactoryLoop('factory:openspec', capabilities)?.graph).toEqual(getFactoryLoop('factory:sdd-quick-openspec', capabilities)?.graph)
  })
  it('compiles every factory with global verified delivery and a bounded graph', () => {
    for (const factory of factoryLoopsForCapabilities(capabilities)) {
      expect(validateLoopGraph(factory.graph), factory.id).toMatchObject({ valid: true })
      const definition = compileLoopToDefinition(factory.graph, { id: factory.id, title: factory.name, provider: 'claude', constants: {}, repositoryCount: 2 })
      expect(definition.delivery.requiresVerified).toBe(true)
      expect(definition.maxTransitions).toBeGreaterThan(0)
      if (factory.id === 'factory:batch') {
        expect(definition.nodes.batch).toMatchObject({ kind: 'map', params: { over: 'tickets' } })
        expect(definition.nodes.join.ends.next).toBe('verify')
        expect(definition.nodes.verify.kind).toBe('verify')
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
