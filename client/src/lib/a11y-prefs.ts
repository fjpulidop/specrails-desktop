import { useSyncExternalStore } from 'react'

// App-level accessibility and personalisation preferences (Settings ▸ Appearance ▸
// Accessibility). Per machine, like the effects prefs: they describe the viewer, not
// a project. Two settings:
//  - density: the app-wide default row/card density (a saved board view still wins).
//  - motion:  'system' follows the OS, 'reduce' / 'full' override it.
// They are mirrored onto <html> as `data-density` / `data-motion` so CSS can react
// without any component forking (see globals.css), and read in JS through
// `useReducedMotion` (hooks/useReducedMotion.ts).

export type DensityPref = 'comfortable' | 'compact'
export type MotionPref = 'system' | 'reduce' | 'full'

export interface A11yPrefs {
  density: DensityPref
  motion: MotionPref
}

export const A11Y_PREFS_KEY = 'specrails-desktop:a11y'
export const A11Y_PREFS_EVENT = 'specrails:a11y-changed'
export const DEFAULT_A11Y_PREFS: A11yPrefs = { density: 'comfortable', motion: 'system' }

export function isDensityPref(v: unknown): v is DensityPref {
  return v === 'comfortable' || v === 'compact'
}
export function isMotionPref(v: unknown): v is MotionPref {
  return v === 'system' || v === 'reduce' || v === 'full'
}

let cached: A11yPrefs | null = null

function read(): A11yPrefs {
  try {
    const raw = localStorage.getItem(A11Y_PREFS_KEY)
    if (!raw) return DEFAULT_A11Y_PREFS
    const p = JSON.parse(raw) as Partial<A11yPrefs>
    return {
      density: isDensityPref(p.density) ? p.density : DEFAULT_A11Y_PREFS.density,
      motion: isMotionPref(p.motion) ? p.motion : DEFAULT_A11Y_PREFS.motion,
    }
  } catch {
    return DEFAULT_A11Y_PREFS
  }
}

export function getA11yPrefs(): A11yPrefs {
  if (!cached) cached = read()
  return cached
}

export function setA11yPrefs(patch: Partial<A11yPrefs>): A11yPrefs {
  const next = { ...getA11yPrefs(), ...patch }
  cached = next
  try { localStorage.setItem(A11Y_PREFS_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  applyA11yPrefs(next)
  try { window.dispatchEvent(new CustomEvent(A11Y_PREFS_EVENT)) } catch { /* non-DOM */ }
  return next
}

/** Test seam: forget the in-memory snapshot (re-reads storage next time). */
export function resetA11yPrefsCache(): void {
  cached = null
}

/** Mirror the preferences onto the root element (CSS hooks). */
export function applyA11yPrefs(prefs: A11yPrefs = getA11yPrefs()): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute('data-density', prefs.density)
  if (prefs.motion === 'system') root.removeAttribute('data-motion')
  else root.setAttribute('data-motion', prefs.motion)
}

function subscribe(onChange: () => void): () => void {
  const handler = () => { cached = null; applyA11yPrefs(); onChange() }
  window.addEventListener(A11Y_PREFS_EVENT, handler)
  window.addEventListener('storage', handler)
  return () => {
    window.removeEventListener(A11Y_PREFS_EVENT, handler)
    window.removeEventListener('storage', handler)
  }
}

export function useA11yPrefs(): A11yPrefs {
  return useSyncExternalStore(subscribe, getA11yPrefs, () => DEFAULT_A11Y_PREFS)
}

/** Is the OS asking for reduced motion? */
export function osPrefersReducedMotion(): boolean {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** Non-React read of the effective reduced-motion decision (override, else OS). */
export function prefersReducedMotion(): boolean {
  const { motion } = getA11yPrefs()
  if (motion === 'reduce') return true
  if (motion === 'full') return false
  return osPrefersReducedMotion()
}
