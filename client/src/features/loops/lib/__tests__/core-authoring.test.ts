import { describe, expect, it } from 'vitest'
import { coreNodeData, effectiveOutcomes, parameterDefault } from '../core-authoring'
import type { WorkflowPieceDescriptor } from '../loops-api'
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
