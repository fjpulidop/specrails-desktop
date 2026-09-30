import { loopAgentRoles, nodeAgentRoles } from '../core-authoring'
import { describe, expect, it } from 'vitest'
import { coreNodeData, effectiveOutcomes, parameterDefault, reviewerNodePaths } from '../core-authoring'
import type { LoopGraph, WorkflowPieceDescriptor } from '../loops-api'
const prompt: WorkflowPieceDescriptor = {
  kind: 'prompt',
  paramsSchema: {
    type: 'object',
    required: ['engine', 'access'],
    properties: { engine: { type: 'object' }, access: { enum: ['read', 'write'] } },
  },
  outcomes: ['next', 'pass', 'fail', 'blocked', 'failed'],
  effect: 'derived',
  requiresAI: true,
}
describe('Core authoring catalog', () => {
  it('selects exact role-turn instances through reused components and maps without following recursive cycles', () => {
    const graph: LoopGraph = { nodes: ['left', 'right'].map(id => ({ id, type: 'core', position: { x: 0, y: 0 }, data: { kind: 'map', params: { body: 'review' } } })), edges: [], config: { maxIterations: 2, timeoutMinutes: 0 }, components: {
      review: { nodes: [{ id: 'audit', type: 'core', position: { x: 0, y: 0 }, data: { kind: 'role-turn', params: { roleId: 'auditor' } } }, { id: 'cycle', type: 'core', position: { x: 0, y: 0 }, data: { kind: 'component', params: { ref: 'review' } } }], edges: [], config: { maxIterations: 2, timeoutMinutes: 0 } },
    } }
    expect(reviewerNodePaths(graph)).toEqual(['left/audit', 'right/audit'])
  })
  it('derives effective typed handles from the published outcome union', () => {
    expect(effectiveOutcomes(prompt, {})).toEqual(['next', 'failed'])
    expect(effectiveOutcomes(prompt, { sentinel: 'verification' })).toEqual(['pass', 'fail', 'failed'])
    expect(effectiveOutcomes(prompt, { sentinel: 'blocked' })).toEqual(['next', 'blocked', 'failed'])
    expect(effectiveOutcomes(undefined, {})).toEqual([])
  })
  it('starts an explicit read-only prompt without filling optional policies', () => {
    expect(coreNodeData(prompt)).toMatchObject({
      kind: 'core',
      coreKind: 'prompt',
      params: { access: 'read', engine: { provider: 'claude' }, text: '' },
    })
    expect(parameterDefault({ type: 'object', properties: { timeoutMs: { type: 'integer' } } })).toEqual({})
  })
})

it('discovers roles in referenced nested bodies without including unused definitions or recursing forever', () => {
  const node = (id: string, kind: string, params: Record<string, unknown>) => ({ id, type: 'core' as const, position: { x: 0, y: 0 }, data: { kind, params } })
  const config = { maxIterations: 1, timeoutMinutes: 0 }
  const graph: LoopGraph = { config, edges: [], nodes: [node('nested', 'map', { body: 'used' })], components: {
    used: { config, edges: [], nodes: [node('audit', 'role-turn', { roleId: 'auditor' }), node('inspect', 'prompt', { access: 'read' }), node('cycle', 'component', { ref: 'used' })] },
    unused: { config, edges: [], nodes: [node('old', 'implementation', {})] },
  } }
  expect(loopAgentRoles(graph)).toEqual(['auditor', 'reviewer'])
  expect(nodeAgentRoles('check', 'implementation-step', { phase: 'verify' })).toEqual([])
  expect(nodeAgentRoles('write', 'implementation-step', { phase: 'developer' })).toEqual(['developer'])
  expect(nodeAgentRoles('legacy', 'implementation', {})).toEqual(['architect', 'developer', 'reviewer', 'fixer'])
})
