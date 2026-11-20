/** A loop run paused on a provider usage limit (server `LoopLimitPause`). */
import { API_ORIGIN } from '../../../lib/origin'

export interface LimitPause {
  providerId: string
  resumeAt: string | null
  autoResume: boolean
  message: string
  pausedAt: string
  switchable: boolean
  /** Core definition runs: the roles that move together when the run continues on another provider. */
  switchRoles?: string[]
  /** Core definition runs: where the run may continue (never the limited provider or one sharing its quota), with the starting model/effort. */
  switchTargets?: SwitchTarget[]
}

/** A provider a limit-paused Core run may continue on (server `ProviderSwitchTarget`). */
export interface SwitchTarget { provider: string; model: string; effort: string | null }

export function readLimitPause(raw: unknown): LimitPause | null {
  const value = raw as Partial<LimitPause> | null
  if (!value || typeof value !== 'object' || typeof value.providerId !== 'string' || typeof value.pausedAt !== 'string') return null
  return {
    providerId: value.providerId,
    resumeAt: typeof value.resumeAt === 'string' && Number.isFinite(Date.parse(value.resumeAt)) ? value.resumeAt : null,
    autoResume: value.autoResume === true,
    message: typeof value.message === 'string' ? value.message : '',
    pausedAt: value.pausedAt,
    switchable: value.switchable === true,
    ...(Array.isArray(value.switchRoles) ? { switchRoles: value.switchRoles.filter((role): role is string => typeof role === 'string') } : {}),
    ...(Array.isArray(value.switchTargets) ? { switchTargets: value.switchTargets
      .filter((target): target is SwitchTarget => !!target && typeof target.provider === 'string' && typeof target.model === 'string')
      .map((target) => ({ provider: target.provider, model: target.model, effort: typeof target.effort === 'string' ? target.effort : null })) } : {}),
  }
}

/**
 * A Core run that SETTLED on a provider's usage limit, and how its next attempt may continue on
 * another provider (`GET /loop-runs/:id/attempts` → `providerSwitch`). `roles` move together.
 */
export interface SettledProviderSwitch { providerId: string; roles: string[]; targets: SwitchTarget[] }

export function readSettledProviderSwitch(raw: unknown): SettledProviderSwitch | null {
  const value = raw as Partial<SettledProviderSwitch> | null
  if (!value || typeof value !== 'object' || typeof value.providerId !== 'string' || !Array.isArray(value.targets)) return null
  const pause = readLimitPause({ providerId: value.providerId, pausedAt: '', switchTargets: value.targets, switchRoles: value.roles })
  const targets = (pause?.switchTargets ?? []).filter((target) => target.provider !== value.providerId)
  return targets.length ? { providerId: value.providerId, roles: pause?.switchRoles ?? [], targets } : null
}

export type LimitAction = { action: 'resume' } | { action: 'auto'; enabled: boolean }
  | { action: 'switch'; provider: string; model?: string; effort?: string; remember?: boolean }

export async function answerLimitPause(projectId: string, runId: string, choice: LimitAction): Promise<{ ok: true; limit?: LimitPause | null } | { ok: false; detail: string }> {
  try {
    const response = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/loop-runs/${encodeURIComponent(runId)}/limit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(choice),
    })
    const body = await response.json().catch(() => null) as { limit?: unknown; error?: string; detail?: string } | null
    if (!response.ok) return { ok: false, detail: body?.detail ?? body?.error ?? `HTTP ${response.status}` }
    return { ok: true, ...(body && 'limit' in body ? { limit: readLimitPause(body.limit) } : {}) }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
