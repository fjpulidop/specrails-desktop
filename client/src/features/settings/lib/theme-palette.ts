/**
 * Active-theme palette accessor.
 *
 * Components that render to non-CSS surfaces (Recharts, xterm) read their
 * palette from here. The active theme is read from `<html data-theme="...">`
 * — set by the anti-FOUC boot script in `client/index.html` before React
 * hydrates, and kept in sync by `ThemeContext`.
 *
 * Replaces the legacy `dracula-colors.ts` module which hard-coded the
 * Dracula palette as the only option.
 */

import { THEMES, DEFAULT_THEME, isThemeId, type ThemeId, type ThemeDescriptor } from './themes'

export function getActiveThemeId(): ThemeId {
  if (typeof document === 'undefined') return DEFAULT_THEME
  const attr = document.documentElement.dataset.theme
  return isThemeId(attr) ? attr : DEFAULT_THEME
}

export function getActiveTheme(): ThemeDescriptor {
  return THEMES[getActiveThemeId()]
}

/** Status → color map for the active theme. */
export function getStatusColors(): Record<string, string> {
  return { ...getActiveTheme().status }
}

/** Recharts series palette for the active theme. */
export function getChartPalette(): readonly string[] {
  return getActiveTheme().chart
}
