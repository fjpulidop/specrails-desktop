import { expect, it, describe } from 'vitest'
import { resolveEffectiveRuntimeConfig } from './agent-runtime-effective-config'
import type { RuntimeConfig } from './agent-runtime-settings'
const config: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }, { id: 'codex', kind: 'cli', cli: 'codex' }], agents: {
  architect: { provider: 'claude', model: 'architect', effort: 'medium' }, developer: { provider: 'codex', model: 'developer', effort: 'low', escalation: { model: 'rescue', effort: 'high' } }, reviewer: { provider: 'claude', model: 'reviewer' },
}, verification: [{ repositoryId: 'front', key: 'test', label: 'Test', command: 'npm', args: ['test'], cwd: 'app', env: { CI: 'true' }, timeoutMs: 42, policy: { reuse: 'never' } }, { repositoryId: 'back', command: 'npm', args: ['test'] }] }
it('preserves mixed project roles and check fields without modifying input', () => {
  const before = structuredClone(config)
  const result = resolveEffectiveRuntimeConfig(config, { repositoryIds: ['front'], source: 'project-role' })
  expect(result.config.agents).toEqual(config.agents)
  expect(result.config.verification).toEqual([config.verification[0]])
  expect(config).toEqual(before)
  expect(result.origins.developer).toBe('project-role')
})
it('applies the selected launch provider to all roles and clears incompatible settings', () => {
  const result = resolveEffectiveRuntimeConfig(config, { repositoryIds: ['front'], source: 'project-role', providerOverride: { provider: 'claude', model: 'chosen' } })
  expect(result.config.agents.developer).toEqual({ provider: 'claude', model: 'chosen', effort: undefined, escalation: undefined })
  expect(result.config.agents.architect).toEqual({ provider: 'claude', model: 'chosen', effort: undefined, escalation: undefined })
  expect(result.config.agents.reviewer).toEqual({ provider: 'claude', model: 'chosen', effort: undefined, escalation: undefined })
  expect(Object.values(result.origins)).toEqual(['explicit-launch-override', 'explicit-launch-override', 'explicit-launch-override'])
  expect(result.origins.developer).toBe('explicit-launch-override')
  expect(() => resolveEffectiveRuntimeConfig(config, { repositoryIds: [], source: 'default', providerOverride: { provider: 'missing' } })).toThrow('not configured')
})


it('uses provider-local defaults when only the launch provider is selected', () => {
  const result = resolveEffectiveRuntimeConfig(config, { repositoryIds: ['front'], source: 'project-role', providerOverride: { provider: 'codex' } })
  expect(Object.values(result.config.agents).every(agent => agent.provider === 'codex')).toBe(true)
  expect(result.config.agents.architect.model).not.toBe('architect')
  expect(result.config.agents.reviewer.model).not.toBe('reviewer')
  expect(result.config.agents.architect.effort).toBeUndefined()
  expect(result.config.agents.developer).toEqual(config.agents.developer)
})

describe('fillDefaultRoleModels', () => {
  it('gives a local role the connection default so the compatibility check does not reject "provider default"', async () => {
    const { fillDefaultRoleModels } = await import('./agent-runtime-effective-config')
    const { syncLocalAdapters } = await import('../../../providers/local-adapter-registry')
    const { unregisterAdapter } = await import('../../../providers/registry')
    syncLocalAdapters([{ id: 'localbox', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'qwen' }])
    try {
      const config = fillDefaultRoleModels({
        providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }, { id: 'localbox', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' }],
        agents: { architect: { provider: 'localbox' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude', model: 'haiku' } },
      } as never)
      expect(config.agents.architect.model).toBe('qwen')
      expect(config.agents.developer.model).toBeTruthy()
      expect(config.agents.reviewer.model).toBe('haiku')
    } finally { unregisterAdapter('localbox') }
  })
})
