import { useSyncExternalStore } from 'react'

// App-level visual-effects preferences (Settings ▸ Effects). Per machine —
// they describe the viewer, not a project — so they live in localStorage
// like the OS-notification prefs, with a tiny external store so every
// mounted surface re-renders the moment a switch flips.

export interface EffectsPrefs {
  /** The Builder's orbiting halo around the agent composer while a turn is
   *  thinking / writing (fade in on start, fade out on settle). */
  agentThinkingHalo: boolean
}

export const EFFECTS_PREFS_KEY = 'specrails-desktop:effects'
export const EFFECTS_PREFS_EVENT = 'specrails:effects-changed'

export const DEFAULT_EFFECTS_PREFS: EffectsPrefs = { agentThinkingHalo: true }

let cached: EffectsPrefs | null = null

function read(): EffectsPrefs {
  try {
    const raw = localStorage.getItem(EFFECTS_PREFS_KEY)
    if (!raw) return DEFAULT_EFFECTS_PREFS
    const parsed = JSON.parse(raw) as Partial<EffectsPrefs>
    return { ...DEFAULT_EFFECTS_PREFS, ...(typeof parsed.agentThinkingHalo === 'boolean' ? { agentThinkingHalo: parsed.agentThinkingHalo } : {}) }
  } catch {
    return DEFAULT_EFFECTS_PREFS
  }
}

export function getEffectsPrefs(): EffectsPrefs {
  if (!cached) cached = read()
  return cached
}

export function setEffectsPrefs(patch: Partial<EffectsPrefs>): EffectsPrefs {
  const next = { ...getEffectsPrefs(), ...patch }
  cached = next
  try { localStorage.setItem(EFFECTS_PREFS_KEY, JSON.stringify(next)) } catch { /* private mode etc. */ }
  try { window.dispatchEvent(new CustomEvent(EFFECTS_PREFS_EVENT)) } catch { /* non-DOM */ }
  return next
}

/** Test seam: forget the in-memory snapshot (re-reads storage next time). */
export function resetEffectsPrefsCache(): void {
  cached = null
}

function subscribe(onChange: () => void): () => void {
  const handler = () => { cached = null; onChange() }
  window.addEventListener(EFFECTS_PREFS_EVENT, handler)
  window.addEventListener('storage', handler)
  return () => {
    window.removeEventListener(EFFECTS_PREFS_EVENT, handler)
    window.removeEventListener('storage', handler)
  }
}

export function useEffectsPrefs(): EffectsPrefs {
  return useSyncExternalStore(subscribe, getEffectsPrefs, () => DEFAULT_EFFECTS_PREFS)
}
