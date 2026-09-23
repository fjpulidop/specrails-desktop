// Per-project memory of the last AI engine the user picked (Add Spec, rails,
// terminal). Decision: selectors start at the project's primary provider and
// then remember the user's last explicit choice per project. Single-provider
// projects never call this (there is no choice to remember).
//
// Mirrors the localStorage pattern used elsewhere in the app
// (e.g. specrails-desktop:terminal-panel:<projectId>).

import type { ProviderId } from './provider-capabilities'

const KEY_PREFIX = 'specrails-desktop:last-engine:'

function key(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`
}

/**
 * Resolve the engine a selector should start on for a project: the last engine
 * the user chose (when still installed) else `fallback` (the project primary).
 */
export function getLastEngine(
  projectId: string | null | undefined,
  installed: readonly string[],
  fallback: ProviderId,
): ProviderId {
  if (!projectId) return fallback
  try {
    const stored = window.localStorage.getItem(key(projectId))
    if (stored && installed.includes(stored)) return stored as ProviderId
  } catch {
    /* localStorage unavailable (SSR / privacy mode) — fall back */
  }
  return fallback
}

/** Persist the user's engine choice for a project. */
export function setLastEngine(projectId: string | null | undefined, provider: ProviderId): void {
  if (!projectId) return
  try {
    window.localStorage.setItem(key(projectId), provider)
  } catch {
    /* non-fatal */
  }
}
