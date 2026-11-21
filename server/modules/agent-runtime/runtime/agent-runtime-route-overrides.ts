/**
 * Core `routeOverrides` on the Desktop side: the request Desktop sends with
 * `runtime resume --route-overrides`, the overrides Core ACCEPTED for a run
 * (recorded from its durable `routes_overridden` events next to the frozen
 * context, never inside the frozen, integrity-checked files) and the routes a
 * run's roles are on now (frozen configuration + accepted overrides, in order).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface RouteSelection { provider: string; model?: string; effort?: string; maxTurns?: number }
export interface DefinitionRouteOverride {
  schemaVersion: 1
  requestId: string
  reason?: string
  fromProvider?: string
  routes: Record<string, { provider: string; model?: string; effort?: string }>
  providers?: Array<{ id: string; kind: 'cli'; cli: 'claude' | 'codex' | 'gemini' | 'kimi' }>
}

const ACCEPTED = 'accepted.jsonl'
const acceptedFile = (contextPath: string): string => join(dirname(contextPath), 'route-overrides', ACCEPTED)

function parse(value: unknown): DefinitionRouteOverride | null {
  const raw = value as Partial<DefinitionRouteOverride> | null
  if (!raw || raw.schemaVersion !== 1 || typeof raw.requestId !== 'string' || !raw.routes || typeof raw.routes !== 'object') return null
  const routes: DefinitionRouteOverride['routes'] = {}
  for (const [role, route] of Object.entries(raw.routes)) {
    if (!route || typeof route.provider !== 'string') return null
    routes[role] = { provider: route.provider, ...(typeof route.model === 'string' ? { model: route.model } : {}), ...(typeof route.effort === 'string' ? { effort: route.effort } : {}) }
  }
  return { schemaVersion: 1, requestId: raw.requestId, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}), ...(typeof raw.fromProvider === 'string' ? { fromProvider: raw.fromProvider } : {}), routes,
    ...(Array.isArray(raw.providers) ? { providers: raw.providers } : {}) }
}

/** Overrides Core accepted for this run, oldest first (one per request id). */
export function acceptedRouteOverrides(contextPath: string): DefinitionRouteOverride[] {
  const file = acceptedFile(contextPath)
  if (!existsSync(file)) return []
  const seen = new Set<string>(), result: DefinitionRouteOverride[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let parsed: DefinitionRouteOverride | null = null
    try { parsed = parse(JSON.parse(line)) } catch { parsed = null }
    if (!parsed || seen.has(parsed.requestId)) continue
    seen.add(parsed.requestId); result.push(parsed)
  }
  return result
}

/** Record a `routes_overridden` workflow event (Core's acceptance) once. */
export function recordAcceptedRouteOverride(contextPath: string, event: unknown): void {
  const parsed = parse(event)
  if (!parsed || acceptedRouteOverrides(contextPath).some(item => item.requestId === parsed.requestId)) return
  mkdirSync(dirname(acceptedFile(contextPath)), { recursive: true, mode: 0o700 })
  appendFileSync(acceptedFile(contextPath), JSON.stringify(parsed) + '\n', { mode: 0o600 })
}

/** Role → route in the frozen configuration (agents, fixer, custom roles); only the roles the definition runs when it names them. */
export function frozenRoleRoutes(contextPath: string): Record<string, RouteSelection> {
  const directory = dirname(contextPath)
  const frozen = JSON.parse(readFileSync(join(directory, 'desktop-runtime-config.json'), 'utf8')) as { agents?: Record<string, RouteSelection>; fixer?: RouteSelection; roles?: Record<string, RouteSelection> }
  let used: Set<string> | undefined
  try {
    const roles = (JSON.parse(readFileSync(join(directory, 'desktop-workflow-definition.json'), 'utf8')) as { roles?: unknown }).roles
    if (Array.isArray(roles)) used = new Set(roles.filter((role): role is string => typeof role === 'string'))
  } catch { used = undefined }
  if (used?.has('developer')) used.add('fixer')
  const pick = (route: RouteSelection): RouteSelection => ({ provider: route.provider, ...(route.model ? { model: route.model } : {}), ...(route.effort ? { effort: route.effort } : {}), ...(route.maxTurns !== undefined ? { maxTurns: route.maxTurns } : {}) })
  const routes: Record<string, RouteSelection> = {}
  for (const [role, route] of [...Object.entries(frozen.agents ?? {}), ...(frozen.fixer ? [['fixer', frozen.fixer] as const] : []), ...Object.entries(frozen.roles ?? {})]) {
    if (!route || typeof route.provider !== 'string') continue
    if (used && !used.has(role)) continue
    routes[role] = pick(route)
  }
  return routes
}

/** The routes after the overrides, in order. A moved role keeps only its turn ceiling. */
export function applyRouteOverrides(frozen: Record<string, RouteSelection>, overrides: readonly DefinitionRouteOverride[]): Record<string, RouteSelection> {
  const routes = structuredClone(frozen)
  for (const override of overrides) for (const [role, route] of Object.entries(override.routes)) {
    routes[role] = { ...route, ...(routes[role]?.maxTurns !== undefined ? { maxTurns: routes[role]!.maxTurns } : {}) }
  }
  return routes
}

/** The routes a run's roles are on now. */
export function currentRoleRoutes(contextPath: string): Record<string, RouteSelection> {
  return applyRouteOverrides(frozenRoleRoutes(contextPath), acceptedRouteOverrides(contextPath))
}
