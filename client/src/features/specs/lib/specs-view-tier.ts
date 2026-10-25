import { getA11yPrefs } from '../../../lib/a11y-prefs'

export type SpecsViewTier = 'row' | 'postit'

export const DEFAULT_SPECS_VIEW_TIER: SpecsViewTier = 'postit'

const KEY = (projectId: string) => `specrails-desktop:specs-view-tier:${projectId}`

export function isSpecsViewTier(v: unknown): v is SpecsViewTier {
  return v === 'row' || v === 'postit'
}
const isTier = isSpecsViewTier

/** The app-wide Density setting as a board tier: compact rows, comfortable post-its. */
export function defaultSpecsViewTier(): SpecsViewTier {
  return getA11yPrefs().density === 'compact' ? 'row' : DEFAULT_SPECS_VIEW_TIER
}

/** The tier this project (or one of its saved views) chose explicitly, if any. */
export function hasStoredSpecsViewTier(projectId: string | null): boolean {
  if (!projectId) return false
  try { return isTier(localStorage.getItem(KEY(projectId))) } catch { return false }
}

/** A project's own choice (or its applied saved view) wins; otherwise the app Density default. */
export function loadSpecsViewTier(projectId: string | null): SpecsViewTier {
  if (!projectId) return defaultSpecsViewTier()
  try {
    const v = localStorage.getItem(KEY(projectId))
    if (isTier(v)) return v
  } catch {
    /* private mode / quota */
  }
  return defaultSpecsViewTier()
}

export function saveSpecsViewTier(projectId: string | null, tier: SpecsViewTier): void {
  if (!projectId) return
  try {
    localStorage.setItem(KEY(projectId), tier)
  } catch {
    /* private mode / quota */
  }
}

/** Fired after a project's own tier was dropped, so an open board follows the app Density again. */
export const SPECS_VIEW_TIER_RESET_EVENT = 'specrails:specs-view-tier-reset'

/** Forget a project's own tier: the board goes back to the app Density default. */
export function clearSpecsViewTier(projectId: string | null): void {
  if (!projectId) return
  try { localStorage.removeItem(KEY(projectId)) } catch { /* private mode / quota */ }
  try { window.dispatchEvent(new CustomEvent(SPECS_VIEW_TIER_RESET_EVENT, { detail: { projectId } })) } catch { /* non-DOM */ }
}
