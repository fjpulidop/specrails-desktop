import { readFileSync, mkdtempSync, writeFileSync, readFileSync as read, lstatSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileLoopToDefinition } from './loop-definition'
import { canonicalFactoryLoopId, factoryLoopMode, factoryLoopsForCapabilities, FLOW_SPEC_LOOP_ID, getFactoryLoop, supportsFlowSpec } from './loop-factory'
import { FLOW_SUMMARY_FILE, FLOW_SUMMARY_LIMIT_BYTES, flowSpecGraph } from './loop-flow-spec-recipe'
import { CORE_NODE_KINDS, validateLoopGraph } from './loop-graph'
import { builtinLoopDefaults, EDITABLE_BUILTIN_LOOP_IDS } from './builtin-loops'
import { writeFlowSummary } from './loop-executors'

const V2 = { engineV2: 1, workflowDefinitions: 1 }
const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'core-flow-spec.json'), 'utf8')) as {
  entry: string; journal: string; change: string; roles: string[]
  nodes: Record<string, { kind: string; params: Record<string, unknown>; ends: Record<string, string> }>
}

describe('factory:flow-spec gating', () => {
  it('is listed only when Core advertises deriveChange with the workflow engine', () => {
    expect(factoryLoopsForCapabilities(undefined).map(loop => loop.id)).not.toContain(FLOW_SPEC_LOOP_ID)
    expect(factoryLoopsForCapabilities(V2).map(loop => loop.id)).not.toContain(FLOW_SPEC_LOOP_ID)
    expect(factoryLoopsForCapabilities({ deriveChange: 1 }).map(loop => loop.id)).not.toContain(FLOW_SPEC_LOOP_ID)
    const listed = factoryLoopsForCapabilities({ ...V2, deriveChange: 1 }).find(loop => loop.id === FLOW_SPEC_LOOP_ID)
    expect(listed).toMatchObject({ mode: 'loop', launchable: false, requiredCoreCapability: 'deriveChange' })
    expect(getFactoryLoop(FLOW_SPEC_LOOP_ID, V2)).toBeUndefined()
    expect(getFactoryLoop(FLOW_SPEC_LOOP_ID, { ...V2, deriveChange: 1 })?.id).toBe(FLOW_SPEC_LOOP_ID)
    expect(supportsFlowSpec({ ...V2, deriveChange: 2 })).toBe(false)
  })

  it('maps to loop mode and canonicalizes without capabilities (the router validates first)', () => {
    expect(factoryLoopMode(FLOW_SPEC_LOOP_ID)).toBe('loop')
    expect(canonicalFactoryLoopId(FLOW_SPEC_LOOP_ID)).toBe(FLOW_SPEC_LOOP_ID)
    expect(canonicalFactoryLoopId('factory:batch')).toBe('factory:implement')
  })

  it('is not an editable built-in (never seeded into the loop library)', () => {
    expect(EDITABLE_BUILTIN_LOOP_IDS).not.toContain(FLOW_SPEC_LOOP_ID)
    expect(builtinLoopDefaults({ ...V2, deriveChange: 1 }, true).map(loop => loop.id)).not.toContain(FLOW_SPEC_LOOP_ID)
  })

  it('knows derive-change as a Core node kind', () => {
    expect(CORE_NODE_KINDS).toContain('derive-change')
    expect(validateLoopGraph(flowSpecGraph()).valid).toBe(true)
  })
})

describe('flow-spec definition', () => {
  const definition = compileLoopToDefinition(flowSpecGraph(), { id: FLOW_SPEC_LOOP_ID, title: 'Flow → Spec', constants: {}, provider: 'claude', roles: { reviewer: { access: 'read' } } })

  it('matches the Core reference fixture shape (entry, roles, kinds, routing)', () => {
    expect(definition).toMatchObject({ id: 'factory-flow-spec', entry: fixture.entry, journal: fixture.journal, change: fixture.change, delivery: { requiresVerified: true } })
    expect(definition.roles).toEqual([...fixture.roles].sort())
    expect(Object.keys(definition.nodes).sort()).toEqual(Object.keys(fixture.nodes).sort())
    for (const [id, node] of Object.entries(fixture.nodes)) {
      expect(definition.nodes[id]!.kind, id).toBe(node.kind)
      expect(definition.nodes[id]!.ends, id).toEqual(node.ends)
    }
  })

  it('keeps the closed params of the Core pieces', () => {
    for (const id of ['derive', 'check', 'archive', 'verify', 'repair-guard', 'repair-count', 'init', 'review-policy']) {
      expect(definition.nodes[id]!.params, id).toEqual(fixture.nodes[id]!.params)
    }
    expect(definition.nodes.derive!.params).toEqual({ change: '{{run.changeId}}', summaryPath: FLOW_SUMMARY_FILE })
    expect(definition.nodes.review!.params).toMatchObject({ roleId: 'reviewer' })
    expect(String(definition.nodes.review!.params.prompt)).toContain('unexplainedFiles')
  })
})

describe('writeFlowSummary', () => {
  it('writes once, 0600, bounded to the Core limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-summary-'))
    writeFlowSummary(dir, 'é'.repeat(FLOW_SUMMARY_LIMIT_BYTES))
    const file = join(dir, FLOW_SUMMARY_FILE)
    expect(Buffer.byteLength(read(file, 'utf8'))).toBeLessThanOrEqual(FLOW_SUMMARY_LIMIT_BYTES)
    expect(read(file, 'utf8')).not.toContain('�')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    writeFlowSummary(dir, 'second')
    expect(read(file, 'utf8').startsWith('é')).toBe(true)
    expect(lstatSync(file).isFile()).toBe(true)
  })

  it('never writes through an existing path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-summary-'))
    writeFileSync(join(dir, FLOW_SUMMARY_FILE), 'kept')
    writeFlowSummary(dir, 'new')
    expect(read(join(dir, FLOW_SUMMARY_FILE), 'utf8')).toBe('kept')
  })
})
