/**
 * provider-quota: continue a SETTLED Core definition run (it failed or stopped
 * because a provider refused on its usage limit) on another provider. The
 * paused-run switch (loop-provider-switch) answers a limit pause in place; a
 * settled run is never re-opened, so its next attempt is a fork that starts
 * with the moved routes (Core `forkRouteOverrides`; an older Core with only
 * `routeOverrides` moves them on the fork's first resume).
 *
 * Pure pieces (which provider refused, the offer) plus the run-bound offer the
 * HTTP routes use. The offer, its validation, the request and the log line are
 * the pause switch's own (`switchTargetsFor`, `validateSwitchChoice`,
 * `routeOverrideRequest`, `switchedLine`).
 */
import { classifyProviderLimit } from '../../../provider-limit'
import { getJobEvents } from '../../../db'
import type { DbInstance } from '../../../db'
import { logLinesFromEvents, type FailureDiagnosis } from '../../recovery'
import { readFailureAnalysis } from '../../recovery/adapters/sqlite'
import { quotaResumeAt } from '../../provider-quota/runtime/quota-reports'
import { currentRoleRoutes, type RouteSelection } from '../../agent-runtime/runtime/agent-runtime-route-overrides'
import type { RouteOverrideSupport } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { getLoopRun, readDefinitionRun, readDefinitionSuccessor } from './loop-runs-store'
import { rolesOnProvider } from './loop-provider-switch'
import type { LoopLimitPause, LoopProviderSwitch, ProviderSwitchTarget } from './loop-run-contract'
export type { ProviderSwitchChoice } from './loop-run-contract'

/** A settled run's way to continue on another provider (`GET /loop-runs/:id/attempts` → `providerSwitch`). */
export interface SettledProviderSwitch {
  /** The provider that refused on its usage limit. */
  providerId: string
  /** The roles whose route spends that provider's quota: they move together. */
  roles: string[]
  /** Where the next attempt may continue, with the model/effort each starts on. */
  targets: ProviderSwitchTarget[]
  /** How the retained Core moves the routes: on the fork itself, or on the fork's first resume. */
  via: 'fork' | 'resume'
}

const PROVIDER_WORD = /\b(claude|codex|gemini|kimi)\b/i
/** Core's typed refusal ("codex usage limit reached (…)") names the CLI first. */
const NAMED_REFUSAL = /\b(claude|codex|gemini|kimi) usage limit reached\b/i
/** Only the last lines of the log are read: the provider's own refusal is always at the end. */
const TAIL_LINES = 80

/** The refusal lines of a log tail: a provider's limit sentence on a line that names the provider (never a spec that talks about limits). */
function refusalLines(lines: readonly string[]): string[] {
  return lines.slice(-TAIL_LINES).filter(line => PROVIDER_WORD.test(line) && classifyProviderLimit(line) !== null)
}

/**
 * The provider whose usage limit stopped a settled run, or null when nothing says it was a limit.
 * Evidence, strongest first: the diagnosis (`provider_limit`, its named provider), the run's own
 * failure records (a refusal line naming the CLI, in the detail or the log tail), the AI analysis
 * (`provider_limit` category). The provider is the one named, else the one the quota store knows
 * is refusing, else the provider of the failing step's role, else the only provider the roles use.
 */
export function settledLimitProvider(input: {
  diagnosis: Pick<FailureDiagnosis, 'kind' | 'detail' | 'phase' | 'provider'> | null
  analysisCategory?: string | null
  logLines?: readonly string[]
  routes: Readonly<Record<string, RouteSelection>>
  refusing?: (provider: string) => boolean
}): string | null {
  const { diagnosis, routes } = input
  const detail = diagnosis?.detail ?? ''
  const refusals = [...(detail && classifyProviderLimit(detail) ? [detail] : []), ...refusalLines(input.logLines ?? [])]
  const limited = diagnosis?.kind === 'provider_limit' || refusals.length > 0 || input.analysisCategory === 'provider_limit'
  if (!limited) return null
  const used = [...new Set(Object.values(routes).map(route => route.provider))]
  if (diagnosis?.kind === 'provider_limit' && diagnosis.provider && used.includes(diagnosis.provider)) return diagnosis.provider
  for (const line of [...refusals].reverse()) {
    const named = (NAMED_REFUSAL.exec(line)?.[1] ?? PROVIDER_WORD.exec(line)?.[1])?.toLowerCase()
    if (named && used.includes(named)) return named
  }
  const refusing = used.find(provider => input.refusing?.(provider))
  if (refusing) return refusing
  const phaseRoute = diagnosis?.phase ? routes[diagnosis.phase] : undefined
  if (phaseRoute) return phaseRoute.provider
  return used.length === 1 ? used[0]! : null
}

/** The pause-shaped record the pause switch's validation reads (the same rules apply to a settled run). */
export function settledSwitchLimit(offer: SettledProviderSwitch): LoopLimitPause {
  return { providerId: offer.providerId, resumeAt: null, autoResume: false, message: '', pausedAt: new Date(0).toISOString(), switchable: true, switchRoles: offer.roles, switchTargets: offer.targets }
}

export interface SettledSwitchDeps {
  db: DbInstance
  /** The project's provider switch (targets, remember). */
  providerSwitch: Pick<LoopProviderSwitch, 'targets'>
  /** Whether the run's retained Core moves routes on resume and on fork. */
  support(input: { runId: string; contextPath: string }): Promise<RouteOverrideSupport>
  diagnosis: FailureDiagnosis | null
}

/**
 * The switch a settled run offers, or null: not a settled definition run nothing continued yet,
 * no sign of a usage limit, no role on the limited provider, no other provider to go to, or a
 * retained Core that cannot move routes.
 */
export async function settledProviderSwitch(runId: string, deps: SettledSwitchDeps): Promise<SettledProviderSwitch | null> {
  const run = getLoopRun(deps.db, runId)
  if (!run || run.engine_version !== 2 || run.status !== 'completed' || run.final_outcome === 'success' || readDefinitionSuccessor(deps.db, runId)) return null
  const contextPath = readDefinitionRun(deps.db, runId)?.metadata.contextPath
  if (!contextPath) return null
  let routes: Record<string, RouteSelection>
  try { routes = currentRoleRoutes(contextPath) } catch { return null }
  let analysisCategory: string | null = null
  try { analysisCategory = readFailureAnalysis(deps.db, runId)?.analysis.category ?? null } catch { analysisCategory = null }
  let logLines: string[] = []
  try { logLines = logLinesFromEvents(getJobEvents(deps.db, runId).slice(-400)) } catch { logLines = [] }
  const providerId = settledLimitProvider({ diagnosis: deps.diagnosis, analysisCategory, logLines, routes, refusing: provider => quotaResumeAt(provider) !== null })
  if (!providerId) return null
  const roles = rolesOnProvider(routes, providerId)
  if (!roles.length) return null
  const targets = deps.providerSwitch.targets({ fromProvider: providerId, roles })
  if (!targets.length) return null
  const support = await deps.support({ runId, contextPath }).catch(() => ({ resume: false, fork: false }))
  if (!support.fork && !support.resume) return null
  return { providerId, roles, targets, via: support.fork ? 'fork' : 'resume' }
}
