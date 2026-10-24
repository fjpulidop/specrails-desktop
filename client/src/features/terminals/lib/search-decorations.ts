import type { XtermTheme } from '../../settings/lib/themes'

/**
 * xterm's addon-search only accepts `#RRGGBB` decoration colours, while the
 * theme palettes in `settings/lib/themes.ts` are authored as `hsl(...)` (or
 * hex). Normalise any of those to `#rrggbb`; unparseable input yields null.
 */
export function toHexColor(value: string): string | null {
  const v = value.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    return `#${h.toLowerCase()}`
  }
  const hsl = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(v)
  if (!hsl) return null
  const h = ((Number(hsl[1]) % 360) + 360) % 360
  const s = Math.min(100, Number(hsl[2])) / 100
  const l = Math.min(100, Number(hsl[3])) / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const byte = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${byte(f(0))}${byte(f(8))}${byte(f(4))}`
}

// Dracula defaults, used only when the active palette cannot be parsed.
const FALLBACK_MATCH = '#bd93f9'
const FALLBACK_ACTIVE = '#ff79c6'

/** Search-highlight decorations derived from the active theme's xterm palette. */
export function searchDecorations(xterm: Pick<XtermTheme, 'blue' | 'magenta'> | null | undefined) {
  const match = (xterm && toHexColor(xterm.blue)) || FALLBACK_MATCH
  const active = (xterm && toHexColor(xterm.magenta)) || FALLBACK_ACTIVE
  return {
    matchBackground: match,
    matchOverviewRuler: match,
    activeMatchBackground: active,
    activeMatchColorOverviewRuler: active,
  }
}
