// Per-invocation provider selection.
//
// Provider availability is a MACHINE property (see provider-detection.ts): every
// project offers every detected, non-vetoed provider. These helpers resolve and
// validate per-invocation engine requests against that detected set, with the
// project row's `provider`/`providers` columns as the legacy fallback when no
// detection snapshot exists yet (startup, unit tests).
//
// The detected set is injected via `setDetectedProvidersSupplier` so this module
// stays synchronous and unit-testable with no detection singleton import cycle.
//
// Invariant: when the effective list has length 1 every helper collapses to the
// single provider, so single-provider machines behave exactly as before.
//
// Spec: openspec/changes/global-core-zero-friction/specs/provider-auto-detection/spec.md

import type { CliProvider, ProjectRow } from './desktop-db'

type ProviderFields = Pick<ProjectRow, 'provider' | 'providers'>

/** Fixed preference order for primary derivation when the stored primary is gone. */
export const PROVIDER_PREFERENCE_ORDER: readonly CliProvider[] = ['claude', 'codex', 'gemini', 'kimi']

let _detectedSupplier: (() => string[] | null) | null = null

/**
 * Wire the app-level detection singleton in (done once at startup in index.ts).
 * A supplier returning null (no snapshot yet) falls back to project-row data.
 */
export function setDetectedProvidersSupplier(fn: (() => string[] | null) | null): void {
  _detectedSupplier = fn
}

function detectedProviders(): CliProvider[] | null {
  if (!_detectedSupplier) return null
  const list = _detectedSupplier()
  if (!Array.isArray(list) || list.length === 0) return null
  return list as CliProvider[]
}

/**
 * The effective provider list for a project: the detected set when available,
 * else the row's `providers`, else the primary. Never empty.
 */
export function installedProviders(project: Partial<ProviderFields>): CliProvider[] {
  const detected = detectedProviders()
  if (detected) return detected
  if (Array.isArray(project.providers) && project.providers.length > 0) return project.providers
  return [project.provider ?? 'claude']
}

/** True when `id` is one of the providers effectively available. */
export function isProviderEnabled(
  project: Partial<ProviderFields>,
  id: string | null | undefined,
): id is CliProvider {
  if (!id) return false
  return installedProviders(project).includes(id as CliProvider)
}

/** True when the project offers a choice of engines (more than one available). */
export function isMultiProvider(project: Partial<ProviderFields>): boolean {
  return installedProviders(project).length > 1
}

/**
 * Primary derivation (spec: "Primary provider is derived with stability"):
 * the stored primary while it is still available; otherwise claude if
 * available; otherwise the first available provider in the fixed preference
 * order; otherwise the stored primary (legacy, no detection snapshot).
 */
export function derivePrimaryProvider(project: Partial<ProviderFields>): CliProvider {
  const available = installedProviders(project)
  const stored = project.provider
  if (stored && available.includes(stored)) return stored
  for (const p of PROVIDER_PREFERENCE_ORDER) {
    if (available.includes(p)) return p
  }
  return stored ?? available[0]
}

/**
 * Resolve the effective provider for a per-invocation request.
 * Returns the requested provider when it is available; otherwise falls back to
 * the derived primary. Never throws — callers that want strict validation
 * should use `validateRequestedProvider` first.
 */
export function resolveProvider(project: Partial<ProviderFields>, requested?: string | null): CliProvider {
  if (isProviderEnabled(project, requested)) return requested
  const primary = derivePrimaryProvider(project)
  if (typeof requested === 'string' && requested !== '') {
    // A stored engine reference (rail ai_engine, conversation provider) naming
    // a provider that is no longer detected — substitute, never block.
    console.warn(`[provider-selection] provider '${requested}' unavailable; falling back to '${primary}'`)
  }
  return primary
}

/**
 * Strict validation for route handlers. Returns the resolved provider when the
 * request is acceptable, or an `error` string when an explicit, non-empty
 * provider was requested that is not currently available. Omitting the
 * provider (undefined/null/empty) is always acceptable and resolves to primary.
 */
export function validateRequestedProvider(
  project: Partial<ProviderFields>,
  requested: unknown,
): { ok: true; provider: CliProvider } | { ok: false; error: string } {
  const installed = installedProviders(project)
  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, provider: derivePrimaryProvider(project) }
  }
  if (typeof requested !== 'string') {
    return { ok: false, error: 'provider must be a string' }
  }
  if (!isProviderEnabled(project, requested)) {
    return {
      ok: false,
      error: `provider '${requested}' is not installed for this project (installed: ${installed.join(', ')})`,
    }
  }
  return { ok: true, provider: requested }
}
