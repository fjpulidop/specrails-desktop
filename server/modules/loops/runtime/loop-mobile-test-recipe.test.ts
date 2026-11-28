import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileLoopToDefinition } from './loop-definition'
import { factoryLoopsForCapabilities, getFactoryLoop } from './loop-factory'
import { effectivePieceOutcomes, validateLoopGraph } from './loop-graph'
import { MOBILE_TEST_ENDS, MOBILE_TEST_HOST_TASKS, MOBILE_TEST_LOOP_ID, mobileTestGraph } from './loop-mobile-test-recipe'

const CAPS = { engineV2: 1, workflowDefinitions: 1, hostTasks: 1 }
const graph = mobileTestGraph()
const core = graph.nodes.filter((node) => node.type === 'core')

describe('factory:mobile-test', () => {
  it('is listed (not launchable by hand) only when Core runs host tasks', () => {
    expect(factoryLoopsForCapabilities({ engineV2: 1, workflowDefinitions: 1 }).some((loop) => loop.id === MOBILE_TEST_LOOP_ID)).toBe(false)
    expect(getFactoryLoop(MOBILE_TEST_LOOP_ID, CAPS)).toMatchObject({ name: 'Test in Mobile Device', mode: 'loop', launchable: false, requiredCoreCapability: 'hostTasks' })
  })

  it('is a valid graph of host tasks only: no AI turn, no question, no approval', () => {
    expect(validateLoopGraph(graph)).toMatchObject({ valid: true })
    expect(core.map((node) => node.data?.kind)).toEqual(['host-task', 'host-task'])
    expect(core.map((node) => (node.data?.params as { task: string }).task)).toEqual([...MOBILE_TEST_HOST_TASKS])
  })

  it('wires every outcome, including the implicit failed, to an existing end', () => {
    const ids = new Set(graph.nodes.map((node) => node.id))
    for (const node of core) {
      const labels = graph.edges.filter((edge) => edge.source === node.id).map((edge) => edge.label).sort()
      expect(labels, node.id).toEqual([...effectivePieceOutcomes({ kind: 'host-task', outcomes: ['failed'] }, node.data!.params ?? {})].sort())
      for (const edge of graph.edges.filter((edge) => edge.source === node.id)) expect(ids.has(edge.target), edge.target).toBe(true)
    }
    for (const end of Object.values(MOBILE_TEST_ENDS)) expect(ids.has(end), end).toBe(true)
  })

  it('reports the build reason and the delivery reason in its ends, and needs no verification to succeed', () => {
    const end = (id: string) => graph.nodes.find((node) => node.id === id)!.data as { outcome: string; reason: string; requiresVerified?: boolean }
    expect(end(MOBILE_TEST_ENDS.launched)).toMatchObject({ outcome: 'success', requiresVerified: false })
    expect(end(MOBILE_TEST_ENDS.buildFailed).reason).toContain('{{outputs.build.result.detail}}')
    expect(end(MOBILE_TEST_ENDS.unavailable).reason).toContain('{{outputs.deliver.result.detail}}')
    const definition = compileLoopToDefinition(graph, { id: MOBILE_TEST_LOOP_ID, title: 'Test in Mobile Device', constants: {}, provider: 'claude', roles: {} })
    expect(JSON.stringify(definition)).toContain('mobile.build')
  })
})

const coreRoot = process.env.SPECRAILS_CORE_SOURCE_DIR
const coreCli = coreRoot ? path.join(coreRoot, 'dist/agent-runtime/cli.js') : ''
const coreHostTasks = !!coreRoot && existsSync(coreCli)

describe.skipIf(!coreHostTasks)('factory:mobile-test against the real Core catalog', () => {
  it('validates structurally in Core', () => {
    const definition = compileLoopToDefinition(graph, { id: MOBILE_TEST_LOOP_ID, title: 'Test in Mobile Device', constants: {}, provider: 'claude', roles: {} })
    const validated = spawnSync(process.execPath, [coreCli, 'workflows', 'validate', '--stdin', '--structural'], { input: JSON.stringify(definition), encoding: 'utf8' })
    expect(validated.status, validated.stdout + validated.stderr).toBe(0)
  })
})
