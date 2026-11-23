/**
 * provider-quota: continue a Core definition run paused at a provider's usage
 * limit on ANOTHER provider (Core `routeOverrides`). The roles that ran on the
 * limited provider (or one sharing its quota) move together, for the rest of
 * THIS run: the refused step re-runs there with a fresh session, the worktree
 * is kept and the project's settings stay as they are unless the person asks
 * to remember the routes.
 *
 * Pure pieces (offer, validation, request, log line) plus the project-bound
 * adapter the composition root wires (`createLoopProviderSwitch`).
 */
import { sharesQuota } from '../../provider-quota/domain'
import { quotaResumeAt } from '../../provider-quota/runtime/quota-reports'
import { installedProviders } from '../../../provider-selection'
import { getAdapter, hasAdapter } from '../../../providers/registry'
import { defaultReasoningEffortForModel, isModelAvailableForAdapter, reasoningEffortsForModel } from '../../../providers/runtime'
import { getProviderDefault, type SpecProvider } from '../../specs/runtime/spec-models'
import { loadAgentRuntimeConfig, saveAgentRuntimeConfig, type RuntimeConfig, type RuntimeConfigProject } from '../../agent-runtime/runtime/agent-runtime-settings'
import type { DefinitionRouteOverride, RouteSelection } from '../../agent-runtime/runtime/agent-runtime-route-overrides'
import type { LoopLimitPause, LoopProviderSwitch, ProviderSwitchChoice, ProviderSwitchTarget } from './loop-run-contract'

const CLI = new Set(['claude', 'codex', 'gemini', 'kimi'])
const ROLE_ORDER = ['developer', 'fixer', 'architect', 'reviewer']

/** Roles whose current route spends the limited provider's quota, in a stable order. */
export function rolesOnProvider(routes: Record<string, RouteSelection>, provider: string): string[] {
  return Object.keys(routes).filter(role => sharesQuota(routes[role]!.provider, provider))
    .sort((a, b) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b))
}

/** The project's route for a role (agents, fixer or a custom role), if it has one. */
function projectRoute(config: RuntimeConfig | null, role: string): RouteSelection | undefined {
  if (!config) return undefined
  if (role === 'fixer') return config.fixer
  return (config.agents as Record<string, RouteSelection>)[role] ?? config.roles?.[role]
}

/**
 * Where a run limited on `fromProvider` may continue: the project's usable providers other
 * than it and those sharing its quota, skipping any the quota store knows is refusing too.
 * The model/effort start at what the project uses for those roles on that provider, else
 * the provider's defaults.
 */
export function switchTargetsFor(input: { installed: readonly string[]; fromProvider: string; roles: readonly string[]; config: RuntimeConfig | null; refusing?: (provider: string) => boolean }): ProviderSwitchTarget[] {
  return input.installed.filter(id => !sharesQuota(id, input.fromProvider) && hasAdapter(id) && !input.refusing?.(id)).map(id => {
    const adapter = getAdapter(id)
    const configured = input.roles.map(role => projectRoute(input.config, role)).find(route => route?.provider === id)
    const model = configured?.model && isModelAvailableForAdapter(adapter, configured.model) ? configured.model : getProviderDefault(id as SpecProvider) || adapter.defaultModel()
    const efforts = reasoningEffortsForModel(adapter, model) as readonly string[]
    const effort = configured?.effort && efforts.includes(configured.effort) ? configured.effort : defaultReasoningEffortForModel(adapter, model) ?? null
    return { provider: id, model, effort }
  })
}

export type SwitchValidation = { ok: true; choice: ProviderSwitchChoice } | { ok: false; status: number; error: string; detail: string }

/** Server-side check of the person's choice against the paused run's offer and the provider catalogs. */
export function validateSwitchChoice(limit: LoopLimitPause, body: { provider?: unknown; model?: unknown; effort?: unknown; remember?: unknown }): SwitchValidation {
  const fail = (status: number, error: string, detail: string): SwitchValidation => ({ ok: false, status, error, detail })
  if (typeof body.provider !== 'string' || !body.provider) return fail(400, 'invalid_provider', 'Choose a provider')
  const provider = body.provider
  if (sharesQuota(limit.providerId, provider)) return fail(409, 'shares_quota', `${provider} uses the same usage limit`)
  if (!limit.switchable) return fail(409, 'switch_unavailable', 'This run cannot change provider mid-run')
  if (limit.switchTargets && !limit.switchTargets.some(target => target.provider === provider)) return fail(400, 'invalid_provider', `${provider} is not available for this run`)
  if (!hasAdapter(provider)) return fail(400, 'invalid_provider', 'Unknown provider')
  if (quotaResumeAt(provider) !== null) return fail(409, 'provider_limited', `${provider} is refusing requests on its own usage limit`)
  const adapter = getAdapter(provider)
  const offered = limit.switchTargets?.find(target => target.provider === provider)
  const model = body.model === undefined ? offered?.model ?? adapter.defaultModel() : body.model
  if (typeof model !== 'string' || !isModelAvailableForAdapter(adapter, model)) return fail(400, 'invalid_model', `${String(model)} is not a ${provider} model`)
  const efforts = reasoningEffortsForModel(adapter, model) as readonly string[]
  if (body.effort !== undefined && body.effort !== null && (typeof body.effort !== 'string' || !efforts.includes(body.effort))) return fail(400, 'invalid_effort', `${String(body.effort)} is not a reasoning effort of ${model}`)
  if (body.remember !== undefined && typeof body.remember !== 'boolean') return fail(400, 'invalid_remember', 'remember must be a boolean')
  const effort = typeof body.effort === 'string' ? body.effort : undefined
  return { ok: true, choice: { provider, model, ...(effort ? { effort } : {}), ...(body.remember === true ? { remember: true } : {}) } }
}

/** The Core request moving `roles` to the chosen route (a CLI connection the frozen config may lack rides along). */
export function routeOverrideRequest(input: { runId: string; sequence: number; fromProvider: string; roles: readonly string[]; choice: ProviderSwitchChoice }): DefinitionRouteOverride {
  const route = { provider: input.choice.provider, model: input.choice.model, ...(input.choice.effort ? { effort: input.choice.effort } : {}) }
  return { schemaVersion: 1, requestId: `desktop-switch:${input.runId.slice(0, 80)}:${input.sequence}`, reason: 'provider-limit', fromProvider: input.fromProvider,
    routes: Object.fromEntries(input.roles.map(role => [role, route])),
    ...(CLI.has(input.choice.provider) ? { providers: [{ id: input.choice.provider, kind: 'cli' as const, cli: input.choice.provider as 'claude' | 'codex' | 'gemini' | 'kimi' }] } : {}) }
}

const SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', kimi: 'Kimi' }
/** The provider's name as the app shows it (the card's `providerLabel`); a local engine by its connection label. */
const label = (provider: string): string => { if (SHORT[provider]) return SHORT[provider]; try { return hasAdapter(provider) ? getAdapter(provider).displayName : provider } catch { return provider } }

/** The run log / attempt history line: "Switched to Claude/haiku (low) after Codex's usage limit". */
export function switchedLine(fromProvider: string, choice: ProviderSwitchChoice): string {
  return `Switched to ${label(choice.provider)}/${choice.model}${choice.effort ? ` (${choice.effort})` : ''} after ${label(fromProvider)}'s usage limit`
}

/** Store the moved routes as the project's agent runtime role routes. Custom roles the project does not configure are left alone. */
export function rememberRoutes(config: RuntimeConfig, routes: Record<string, { provider: string; model: string; effort?: string }>): RuntimeConfig {
  const next = structuredClone(config)
  const moved = (previous: RouteSelection | undefined, route: { provider: string; model: string; effort?: string }) => ({
    provider: route.provider, model: route.model, ...(route.effort ? { effort: route.effort } : {}), ...(previous?.maxTurns !== undefined ? { maxTurns: previous.maxTurns } : {}) })
  for (const [role, route] of Object.entries(routes)) {
    if (role === 'fixer') next.fixer = moved(next.fixer, route)
    else if (role in next.agents) (next.agents as Record<string, RouteSelection>)[role] = moved((next.agents as Record<string, RouteSelection>)[role], route)
    else if (next.roles?.[role]) next.roles[role] = { ...next.roles[role], ...moved(next.roles[role], route) } as NonNullable<RuntimeConfig['roles']>[string]
  }
  return next
}

/** The project adapter bound at composition. */
export function createLoopProviderSwitch(project: RuntimeConfigProject & { providers?: string[] }): LoopProviderSwitch {
  const config = (): RuntimeConfig | null => { try { return loadAgentRuntimeConfig(project) } catch { return null } }
  return {
    targets: ({ fromProvider, roles }) => switchTargetsFor({ installed: installedProviders(project as never), fromProvider, roles, config: config(), refusing: provider => quotaResumeAt(provider) !== null }),
    remember: routes => {
      const current = loadAgentRuntimeConfig(project)
      if (!current) throw new Error('The project has no agent runtime configuration to update')
      saveAgentRuntimeConfig(project, rememberRoutes(current, routes))
    },
  }
}
