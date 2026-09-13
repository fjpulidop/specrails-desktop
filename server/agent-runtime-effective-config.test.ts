import { expect, it } from 'vitest'
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
it('applies deliberate overrides only to developer and clears incompatible provider settings', () => {
  const result = resolveEffectiveRuntimeConfig(config, { repositoryIds: ['front'], source: 'project-role', developerOverride: { provider: 'claude', model: 'chosen' } })
  expect(result.config.agents.developer).toEqual({ provider: 'claude', model: 'chosen', effort: undefined, escalation: undefined })
  expect(result.config.agents.architect).toEqual(config.agents.architect)
  expect(result.config.agents.reviewer).toEqual(config.agents.reviewer)
  expect(result.origins.developer).toBe('explicit-launch-override')
  expect(() => resolveEffectiveRuntimeConfig(config, { repositoryIds: [], source: 'default', developerOverride: { provider: 'missing' } })).toThrow('not configured')
})
