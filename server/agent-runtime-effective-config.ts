import { getAdapter } from './providers'
import type { RuntimeConfig, RuntimeDeveloperOverride } from './agent-runtime-settings'

/** A pure admission resolver; only deliberate launch intent overrides a project role. */
export function resolveEffectiveRuntimeConfig(input: RuntimeConfig, options: {
  repositoryIds: string[]
  source: 'project-role' | 'default'
  developerOverride?: RuntimeDeveloperOverride
}) {
  const config = structuredClone(input)
  const override = options.developerOverride
  if (override) {
    const provider = config.providers.find(entry => entry.id === override.provider)
    if (!provider) throw new Error(`Selected runtime provider is not configured: ${override.provider}`)
    const current = config.agents.developer
    const changedProvider = current.provider !== provider.id
    config.agents.developer = {
      ...current, provider: provider.id,
      model: override.model ?? (changedProvider ? undefined : current.model),
      effort: override.effort ?? (changedProvider ? undefined : current.effort),
      escalation: changedProvider ? undefined : current.escalation,
    }
  }
  for (const agent of Object.values(config.agents)) {
    const provider = config.providers.find(entry => entry.id === agent.provider)
    if (!agent.model && provider?.kind === 'cli') agent.model = getAdapter(provider.cli).defaultModel()
  }
  config.verification = config.verification.filter(check => options.repositoryIds.includes(check.repositoryId))
  return { config, origins: { architect: options.source, developer: override ? 'explicit-launch-override' : options.source, reviewer: options.source } }
}
