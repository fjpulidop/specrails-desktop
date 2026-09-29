import { describe, expect, it } from 'vitest'
import { defaultAgentRuntimeConfig, forCoreRuntime, validateAgentRuntimeConfig, validateRuntimeRolePrompts } from './agent-runtime-settings'
import { validateRoleCapabilities } from './agent-runtime-loader'

const base = () => defaultAgentRuntimeConfig({ path: '/project', provider: 'claude' })
describe('open runtime roles', () => {
  it('validates independent source/artifact policy and preserves custom instructions', () => {
    const config = { ...base(), roles: { auditor: { provider: 'claude', access: 'read' as const, artifacts: 'none' as const, prompt: 'Inspect actual security evidence.' }, planner: { provider: 'codex', access: 'read' as const, artifacts: 'all' as const, openspecSkill: 'openspec-ff-change' as const } }, rolePrompts: { auditor: 'Inspect all admitted obligations.' } }
    expect(validateAgentRuntimeConfig(config)).toEqual(config)
    expect(forCoreRuntime(config, { openRoles: 1 })).toEqual(config)
    expect(() => forCoreRuntime(config, {})).toThrow('Update the paired Core')
    expect(forCoreRuntime({ ...base(), roles: {} }, {})).not.toHaveProperty('roles')
    expect(() => validateRuntimeRolePrompts({ unknown: 'Global undeclared role' })).toThrow()
    expect(() => validateAgentRuntimeConfig({ ...config, rolePrompts: { undeclared: 'Not configured' } })).toThrow()
  })
  it('rejects reserved IDs, unknown providers and changed built-in policies', () => {
    const role = { provider: 'claude', access: 'read', artifacts: 'none' }
    for (const id of ['fixer', 'Bad Role', 'a'.repeat(65)]) expect(() => validateAgentRuntimeConfig({ ...base(), roles: { [id]: role } })).toThrow()
    expect(() => validateAgentRuntimeConfig({ ...base(), roles: { auditor: { ...role, provider: 'missing' } } })).toThrow('not configured')
    expect(() => validateAgentRuntimeConfig({ ...base(), roles: { reviewer: { ...role, access: 'write' } } })).toThrow('implicit assignment')
    expect(() => validateAgentRuntimeConfig({ ...base(), roles: { auditor: { ...role, prompt: '\0' } } })).toThrow()
    const config = base()
    expect(validateAgentRuntimeConfig({ ...config, roles: { reviewer: { ...config.agents.reviewer, access: 'read', artifacts: 'none', openspecSkill: 'openspec-verify-change' } } }).roles?.reviewer.access).toBe('read')
  })
  it('matches more than six capability rows to exact custom and built-in selections', () => {
    const config = { ...base(), roles: Object.fromEntries(['one', 'two', 'three', 'four'].map(id => [id, { provider: 'claude', model: id, access: 'read', artifacts: 'none' }])) }
    const roles = Object.entries({ ...config.agents, ...config.roles }).map(([role, selected]) => ({ role, tier: 'base', provider: selected.provider, model: selected.model ?? null, requestedEffort: null, transport: 'fixture', continuation: 'unknown', effortSupport: 'unknown', supportedEfforts: null, observedModel: false, observedEffort: false }))
    const result = { type: 'runtime-capabilities', schemaVersion: 1, roles }
    expect(validateRoleCapabilities(result, config).roles).toHaveLength(7)
    expect(() => validateRoleCapabilities({ ...result, roles: [...roles.slice(0, -1), roles[0]] }, config)).toThrow('malformed')
    expect(() => validateRoleCapabilities({ ...result, roles: roles.map((role, index) => index === 6 ? { ...role, provider: 'different' } : role) }, config)).toThrow('malformed')
  })
})
