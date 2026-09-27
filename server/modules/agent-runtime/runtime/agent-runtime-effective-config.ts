import { getAdapter, hasAdapter, isLocalAdapterId } from '../../../providers'
import type { RuntimeConfig, RuntimeProviderOverride } from './agent-runtime-settings'

/** The loop decision role uses the selected review engine, but has no OpenSpec
 * workflow obligation. Native implementation's reviewer keeps its own policy. */
export function workflowRoleDefaults(config: RuntimeConfig): NonNullable<RuntimeConfig['roles']> {
  return { 'loop-decider': { ...config.agents.reviewer, access: 'read', artifacts: 'none' } }
}

/** Explicit launch-owned roles, used when a converted workflow has a different
 * decision engine from the project's reviewer. Validate the complete selection
 * before applying it; project settings and caller descriptors remain untouched. */
export function bindWorkflowRoleSelections(config: RuntimeConfig, definition: unknown,
  selections: RuntimeConfig['roles']): Record<string, string> {
  if (!selections || !Object.keys(selections).length) return {}
  const declared = (definition as { roles?: unknown } | undefined)?.roles
  const names = Object.keys(selections)
  if (!Array.isArray(declared) || names.some(id => !declared.includes(id) ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(id) ||
    ['architect', 'developer', 'reviewer', 'fixer', 'constructor', 'prototype'].includes(id))) {
    throw new Error('Workflow role selections must name declared custom roles')
  }
  config.roles = { ...config.roles, ...structuredClone(selections) }
  fillDefaultRoleModels(config)
  return Object.fromEntries(names.map(id => [id, 'explicit-workflow-selection']))
}

/** Bind only roles referenced by the frozen definition; preserve explicit
 * project assignments and never persist generated defaults into project files. */
export function bindWorkflowRoleDefaults(config: RuntimeConfig, definition: unknown): Record<string, string> {
  const roles = (definition as { roles?: unknown } | undefined)?.roles
  if (!Array.isArray(roles) || !roles.includes('loop-decider')) return {}
  const existing = config.roles?.['loop-decider']
  if (existing) {
    if (existing.access !== 'read' || existing.artifacts !== 'none' || existing.openspecSkill) throw new Error('loop-decider requires read access, no artifact writes and no OpenSpec skill')
    return { 'loop-decider': 'project-role' }
  }
  config.roles = { ...config.roles, ...workflowRoleDefaults(config) }
  return { 'loop-decider': 'inherited-reviewer-engine' }
}

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
    for (const role of ['architect', 'developer', 'reviewer', 'fixer'] as const) {
      const current = role === 'fixer' ? config.fixer : config.agents[role]
      if (!current) continue
      const changedProvider = current.provider !== provider.id
      const changedModel = override.model !== undefined && override.model !== current.model
      const next = {
        ...current, provider: provider.id,
        model: override.model ?? (changedProvider ? undefined : current.model),
        effort: override.effort ?? (changedProvider || changedModel ? undefined : current.effort),
        escalation: changedProvider || changedModel ? undefined : current.escalation,
      }
      if (role === 'fixer') config.fixer = next; else config.agents[role] = next
    }
  }
  if (override && config.roles) for (const [id, current] of Object.entries(config.roles)) {
    const changed = current.provider !== override.provider || (override.model !== undefined && override.model !== current.model)
    config.roles[id] = { ...current, provider: override.provider, model: override.model ?? (current.provider !== override.provider ? undefined : current.model), effort: override.effort ?? (changed ? undefined : current.effort), escalation: changed ? undefined : current.escalation }
  }
  fillDefaultRoleModels(config)
  config.verification = config.verification.filter(check => options.repositoryIds.includes(check.repositoryId))
  return { config, origins: { architect: override ? 'explicit-launch-override' : options.source, developer: override ? 'explicit-launch-override' : options.source, reviewer: override ? 'explicit-launch-override' : options.source } }
}

/**
 * Every role gets a concrete model: CLI roles the adapter default, local
 * (OpenAI-compatible) roles the connection's default (stored `defaultModel`,
 * else the first discovered model). Core requires a model on API providers, so
 * this runs before launch AND before the compatibility check — otherwise
 * picking a local engine with "provider default" failed the check with
 * "Role architect requires a model for its API provider".
 */
export function fillDefaultRoleModels<T extends Pick<RuntimeConfig, 'agents' | 'providers'> & { fixer?: RuntimeConfig['fixer']; roles?: RuntimeConfig['roles'] }>(config: T, options: { localOnly?: boolean } = {}): T {
  for (const agent of [...Object.values(config.agents), ...Object.values(config.roles ?? {}), ...(config.fixer ? [config.fixer] : [])]) {
    const provider = config.providers.find(entry => entry.id === agent.provider)
    if (!agent.model && provider?.kind === 'cli' && !options.localOnly) agent.model = getAdapter(provider.cli).defaultModel()
    if (!agent.model && provider?.kind === 'openai-compatible' && hasAdapter(provider.id) && isLocalAdapterId(provider.id)) agent.model = getAdapter(provider.id).defaultModel()
  }
  return config
}
