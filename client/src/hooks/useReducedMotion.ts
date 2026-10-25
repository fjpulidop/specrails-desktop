import { useSyncExternalStore } from 'react'
import { osPrefersReducedMotion, useA11yPrefs, type MotionPref } from '../lib/a11y-prefs'

const OS_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeOs(onChange: () => void): () => void {
  let mq: MediaQueryList | undefined
  try { mq = window.matchMedia?.(OS_QUERY) } catch { /* no matchMedia */ }
  mq?.addEventListener?.('change', onChange)
  return () => mq?.removeEventListener?.('change', onChange)
}

/** Resolve the override against the OS value. */
export function resolveReducedMotion(pref: MotionPref, os: boolean): boolean {
  return pref === 'reduce' ? true : pref === 'full' ? false : os
}

/**
 * The one reduced-motion decision for the app: the Settings override (system /
 * reduce / full) combined with the OS preference. Use this instead of
 * `motion/react`'s `useReducedMotion` (OS only) or `matchMedia` directly.
 */
export function useReducedMotion(): boolean {
  const { motion } = useA11yPrefs()
  const os = useSyncExternalStore(subscribeOs, osPrefersReducedMotion, () => false)
  return resolveReducedMotion(motion, os)
}
