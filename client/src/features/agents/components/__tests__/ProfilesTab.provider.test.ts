import { describe, expect, it } from 'vitest'
import { buildNewProfile } from '../ProfilesTab'

describe('buildNewProfile', () => {
  it('creates a provider-bound Kimi profile with K3 and Kimi baseline roles', () => {
    const profile = buildNewProfile('kimi-default', 'kimi', {
      models: [
        { value: 'k3', label: 'Kimi K3' },
        { value: 'kimi-for-coding', label: 'Kimi for Coding' },
      ],
      defaultModel: 'k3',
      baselineAgents: ['sr-architect', 'sr-developer', 'sr-reviewer'],
    })

    expect(profile.provider).toBe('kimi')
    expect(profile.orchestrator.model).toBe('k3')
    expect(profile.agents).toEqual([
      { id: 'sr-architect', model: 'k3', required: true },
      { id: 'sr-developer', model: 'k3', required: true },
      { id: 'sr-reviewer', model: 'k3', required: true },
    ])
    expect(JSON.stringify(profile)).not.toContain('sonnet')
  })
})
