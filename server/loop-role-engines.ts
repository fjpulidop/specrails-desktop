// Per-project engines for the loop-side AI roles (hybrid-role-engines).
//
// The pipeline roles architect/developer/reviewer already live in the project's
// `agent-runtime.json` (Settings ▸ Specrails Agents ▸ runtime) and Core runs
// them on whatever provider each role names — cloud or local, mixed freely.
// What kept a hybrid setup from working was the rail: a selected engine became
// a `runtimeProviderOverride` that flattened all three roles, and the loop's
// own AI steps (verify/fix, the Loop Decider) always inherited that engine.
//
// This module owns the two LOOP roles and the `roles` engine sentinel:
//   - `verifier` — every non-core ai-step of the factory loop (verify, fix,
//     freestyle-less prose steps) and the provider a custom loop's ai-steps run on.
//   - `decider`  — the Loop Decider (a cheap/fast model is the natural pick).
// A rail whose engine is `roles` launches WITHOUT a provider override (Core
// keeps the per-role settings) and resolves the loop steps from this file.
//
// Storage: `<workspace>/.specrails/loop-role-engines.json`, next to
// `agent-runtime.json`; absent ⇒ every loop role inherits the project's primary.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getAdapter, hasAdapter, isLocalAdapterId, reasoningEffortsForModel } from './providers'
import { isValidModelForProvider, type SpecProvider } from './spec-models'
import { resolveProjectExecution } from './workspace-resolution'
import { validateRequestedProvider } from './provider-selection'
import type { ReasoningEffort } from './providers/types'

/** The rail engine value meaning "per-role engines, no flattening override". */
export const ROLES_ENGINE = 'roles'
export const LOOP_ROLES = ['verifier', 'decider'] as const
export type LoopRole = (typeof LOOP_ROLES)[number]
export interface RoleEngine { provider: string; model?: string; effort?: string }
export type LoopRoleEngines = Partial<Record<LoopRole, RoleEngine>>
export interface ResolvedRoleEngine { provider: string; model: string; effort?: ReasoningEffort }

type RoleEngineProject = { slug: string; path: string } & Parameters<typeof validateRequestedProvider>[0]

export class LoopRoleEnginesError extends Error {}

export function loopRoleEnginesPath(project: { slug: string; path: string }): string {
  return path.join(resolveProjectExecution(project).specrailsDir, 'loop-role-engines.json')
}

export function loadLoopRoleEngines(project: { slug: string; path: string }): LoopRoleEngines {
  const file = loopRoleEnginesPath(project)
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const out: LoopRoleEngines = {}
    for (const role of LOOP_ROLES) {
      const entry = raw[role]
      if (entry && typeof entry === 'object' && typeof (entry as RoleEngine).provider === 'string') {
        const { provider, model, effort } = entry as RoleEngine
        out[role] = { provider, ...(typeof model === 'string' && model ? { model } : {}), ...(typeof effort === 'string' && effort ? { effort } : {}) }
      }
    }
    return out
  } catch { return {} }
}

/** Validates against the project's DETECTED providers; an unknown role or provider is rejected, a stale model is rejected. */
export function validateLoopRoleEngines(value: unknown, project: RoleEngineProject): LoopRoleEngines {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LoopRoleEnginesError('Loop role engines must be an object')
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!(LOOP_ROLES as readonly string[]).includes(key)) throw new LoopRoleEnginesError(`Unknown loop role "${key}"`)
  const out: LoopRoleEngines = {}
  for (const role of LOOP_ROLES) {
    const entry = raw[role]
    if (entry === undefined || entry === null) continue
    if (typeof entry !== 'object' || Array.isArray(entry)) throw new LoopRoleEnginesError(`Loop role "${role}" must be an object`)
    const { provider, model, effort, ...rest } = entry as Record<string, unknown>
    if (Object.keys(rest).length) throw new LoopRoleEnginesError(`Loop role "${role}" has unknown fields: ${Object.keys(rest).join(', ')}`)
    if (typeof provider !== 'string' || !provider.trim()) throw new LoopRoleEnginesError(`Loop role "${role}" needs a provider`)
    const check = validateRequestedProvider(project, provider)
    if (!check.ok) throw new LoopRoleEnginesError(`Loop role "${role}": ${check.error}`)
    const engine: RoleEngine = { provider: check.provider }
    if (model !== undefined && model !== null && model !== '') {
      if (typeof model !== 'string' || model.length > 256 || /[\r\n\0]/.test(model)) throw new LoopRoleEnginesError(`Loop role "${role}" has an invalid model`)
      if (!isValidModelForProvider(model, check.provider as SpecProvider)) throw new LoopRoleEnginesError(`Loop role "${role}": model "${model}" is not valid for provider "${check.provider}"`)
      engine.model = model
    }
    if (effort !== undefined && effort !== null && effort !== '') {
      if (typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort)) throw new LoopRoleEnginesError(`Loop role "${role}" has an invalid effort`)
      engine.effort = effort
    }
    out[role] = engine
  }
  return out
}

export function saveLoopRoleEngines(project: RoleEngineProject, value: LoopRoleEngines): void {
  const file = loopRoleEnginesPath(project)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

/**
 * The engine a loop role runs on for THIS launch: the stored role engine when
 * its provider is still detected, else the fallback (the rail's primary path).
 * Model falls back to the adapter default; effort is dropped when the adapter
 * cannot honour it (local engines without the opt-in) or the model rejects it.
 */
export function resolveLoopRoleEngine(project: RoleEngineProject, role: LoopRole, fallback: ResolvedRoleEngine, stored: LoopRoleEngines = loadLoopRoleEngines(project)): ResolvedRoleEngine {
  const entry = stored[role]
  if (!entry) return fallback
  const check = validateRequestedProvider(project, entry.provider)
  if (!check.ok || !hasAdapter(check.provider)) return fallback
  const adapter = getAdapter(check.provider)
  const model = entry.model && isValidModelForProvider(entry.model, check.provider as SpecProvider) ? entry.model : adapter.defaultModel()
  const effortAllowed = !(isLocalAdapterId(check.provider) && !adapter.capabilities.supportsReasoningEffort)
  const allowed = effortAllowed ? (reasoningEffortsForModel(adapter, model) as readonly string[]) : []
  const effort = entry.effort && allowed.includes(entry.effort) ? entry.effort as ReasoningEffort : undefined
  return { provider: check.provider, model, ...(effort ? { effort } : {}) }
}
