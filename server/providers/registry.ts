// In-process registry of ProviderAdapter instances. CLI adapter modules call
// `register(this)` on module load; local (OpenAI-compatible) adapters are
// registered/unregistered DYNAMICALLY by `syncLocalAdapters` when connections
// load or save. Managers look up by id via `getAdapter`.
//
// Spec: openspec/specs/multi-provider-architecture/spec.md
//   - "Provider registry exposes lookup by id"

import { type ProviderAdapter, type ProviderId, UnknownProviderError } from './types'

export type AdapterKind = 'cli' | 'local'

const _registry = new Map<ProviderId, ProviderAdapter>()
const _kinds = new Map<ProviderId, AdapterKind>()

/** Register an adapter. `kind` defaults to `'cli'` (module-load registrations);
 *  local adapters pass `'local'` so they can later be unregistered. */
export function register(adapter: ProviderAdapter, kind: AdapterKind = 'cli'): void {
  _registry.set(adapter.id, adapter)
  _kinds.set(adapter.id, kind)
}

/**
 * Remove a LOCAL adapter. CLI adapters (claude/codex/gemini/kimi — anything
 * registered without `kind: 'local'`) are never removed: returns false and
 * leaves them registered.
 */
export function unregisterAdapter(id: ProviderId): boolean {
  if (_kinds.get(id) !== 'local') return false
  _registry.delete(id)
  _kinds.delete(id)
  return true
}

export function getAdapter(id: ProviderId): ProviderAdapter {
  const adapter = _registry.get(id)
  if (!adapter) {
    throw new UnknownProviderError(id, Array.from(_registry.keys()))
  }
  return adapter
}

export function hasAdapter(id: ProviderId): boolean {
  return _registry.has(id)
}

/** Kind of a registered adapter, or null when unknown. */
export function adapterKind(id: ProviderId): AdapterKind | null {
  return _kinds.get(id) ?? null
}

/** True when `id` names a registered LOCAL (OpenAI-compatible) adapter. */
export function isLocalAdapterId(id: ProviderId | null | undefined): boolean {
  return !!id && _kinds.get(id) === 'local'
}

/** CLI adapters first (registration order), then local adapters. */
export function listAdapters(): readonly ProviderAdapter[] {
  const all = Array.from(_registry.values())
  return [
    ...all.filter((a) => _kinds.get(a.id) !== 'local'),
    ...all.filter((a) => _kinds.get(a.id) === 'local'),
  ]
}

/**
 * Reset the registry. Test-only — production code MUST NOT call this.
 * Exported separately so production paths cannot mistakenly import it.
 */
export function _clearForTests(): void {
  _registry.clear()
  _kinds.clear()
}
