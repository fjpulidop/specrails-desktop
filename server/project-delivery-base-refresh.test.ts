import { describe, expect, it } from 'vitest'
import { resolverRoute } from './project-delivery-base-refresh'

describe('base refresh resolver route', () => {
  it('runs the conflict resolver on the delivery run\'s own provider and model', () => {
    expect(resolverRoute({ provider: 'claude', model: 'haiku' })).toEqual({ provider: 'claude', model: 'haiku' })
  })
  it('falls back to the provider default for an unknown model and to the machine default for an unknown provider', () => {
    expect(resolverRoute({ provider: 'claude', model: 'per-role' }).provider).toBe('claude')
    expect(resolverRoute({ provider: 'claude', model: 'per-role' }).model).not.toBe('per-role')
    expect(resolverRoute({ provider: 'agent-runtime', model: 'per-role' }).model).not.toBe('per-role')
  })
})
