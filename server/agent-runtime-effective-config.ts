import { getAdapter } from './providers'
import type { RuntimeConfig, RuntimeProviderOverride } from './agent-runtime-settings'

/** A pure admission resolver; only deliberate launch intent overrides a project role. */
export function resolveEffectiveRuntimeConfig(input: RuntimeConfig, options: {
  repositoryIds: string[]
  source: 'project-role' | 'default'
  providerOverride?: RuntimeProviderOverride
}) {
  const config = structuredClone(input)
  const override = options.providerOverride
  if (override) {
    const provider = config.providers.find(entry => entry.id === override.provider)
    if (!provider) throw new Error(`Selected runtime provider is not configured: ${override.provider}`)
    for (const role of ['architect', 'developer', 'reviewer'] as const) {
      const current = config.agents[role]
      const changedProvider = current.provider !== provider.id
      const changedModel = override.model !== undefined && override.model !== current.model
      config.agents[role] = {
        ...current, provider: provider.id,
        model: override.model ?? (changedProvider ? undefined : current.model),
        effort: override.effort ?? (changedProvider || changedModel ? undefined : current.effort),
        escalation: changedProvider || changedModel ? undefined : current.escalation,
      }
    }
  }
  for (const agent of Object.values(config.agents)) {
    const provider = config.providers.find(entry => entry.id === agent.provider)
    if (!agent.model && provider?.kind === 'cli') agent.model = getAdapter(provider.cli).defaultModel()
  }
  config.verification = config.verification.filter(check => options.repositoryIds.includes(check.repositoryId))
  return { config, origins: { architect: override ? 'explicit-launch-override' : options.source, developer: override ? 'explicit-launch-override' : options.source, reviewer: override ? 'explicit-launch-override' : options.source } }
}
