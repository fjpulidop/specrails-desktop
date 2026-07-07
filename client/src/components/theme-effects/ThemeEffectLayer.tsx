import type { ComponentType } from 'react'
import { useActiveTheme } from '../../context/ThemeContext'
import type { ThemeId } from '../../lib/themes'
import { MatrixRain } from './MatrixRain'
import { LightsaberTrail } from './LightsaberTrail'

/**
 * Theme-effects registry + dispatcher.
 *
 * Each theme MAY ship a purely decorative effect component (e.g. the
 * matrix-rain canvas). The registry below is the single source of truth for
 * which themes have an effect; theme-specific code is contained inside the
 * effect component itself, never in app-wide components.
 *
 * Adding a theme effect:
 *   1. Create a new component under `theme-effects/` that renders the
 *      effect unconditionally — no theme-id branching inside the component.
 *   2. Add an entry to `THEME_EFFECTS` keyed by the theme id (the unquoted
 *      property-key form keeps the regression-guard grep clean).
 *   3. If the effect needs CSS plumbing (e.g. stacking context, panel
 *      transparency), scope those rules to `[data-theme="<id>"]` in
 *      `client/src/globals.css`. The rest of the app stays untouched.
 */
const THEME_EFFECTS: Partial<Record<ThemeId, ComponentType>> = {
  matrix: MatrixRain,
  'star-wars': LightsaberTrail,
}

export function ThemeEffectLayer() {
  const theme = useActiveTheme()
  const Effect = THEME_EFFECTS[theme.id]
  return Effect ? <Effect /> : null
}
