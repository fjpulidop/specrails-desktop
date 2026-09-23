/**
 * Theme registry — single source of truth for non-CSS rendering surfaces
 * (xterm terminals, Recharts charts, syntax highlighting, demo tour, and the
 * Settings preview cards).
 *
 * CSS-driven surfaces read tokens from `client/src/globals.css` directly via
 * `[data-theme="..."]` blocks. This module is for surfaces that cannot read
 * CSS variables and need explicit JS-side palettes.
 *
 * To add a new theme: append an entry to `THEMES`, add a matching
 * `[data-theme="<id>"]` block to `globals.css`, and extend `THEME_IDS`.
 * No component code changes required (OCP).
 */

export const THEME_IDS = ['dracula', 'aurora-light', 'obsidian-dark', 'code-rain', 'specrails', 'galaxy'] as const
export type ThemeId = (typeof THEME_IDS)[number]

export const LEGACY_THEME_ID_MAP: Record<string, ThemeId> = {
  'star-wars': 'galaxy',
  matrix: 'code-rain',
}

/**
 * Type guard usable client + server side. Server validates incoming PATCH
 * payloads against the same allow-list; we keep the source-of-truth list in
 * this client module and import a synchronized server-side copy in
 * `server/desktop-router.ts`.
 */
export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v)
}

export const DEFAULT_THEME: ThemeId = 'specrails'

/**
 * Full xterm.js theme. Mirrors `ITheme` from xterm — duplicated to avoid a
 * direct dependency in this module (themes.ts is consumed by tests and the
 * Settings UI which should not pull xterm in).
 */
export interface XtermTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** Status → color map used in Recharts and other dashboards. */
export interface StatusColors {
  completed: string
  failed: string
  canceled: string
  running: string
  queued: string
}

export interface ThemeDescriptor {
  id: ThemeId
  /** User-facing name shown on Settings card. */
  displayName: string
  /** One-line description shown under the name. */
  tagline: string
  /** Whether the theme has a light or dark base. Used for OS color-scheme hint. */
  scheme: 'light' | 'dark'
  /** Swatches displayed on the Settings preview card (background + accents). */
  previewSwatches: {
    background: string
    foreground: string
    accents: [string, string, string, string]
  }
  /** xterm.js terminal palette. */
  xterm: XtermTheme
  /** Recharts series palette (5 colors, no overlap with destructive). */
  chart: [string, string, string, string, string]
  /** Job-status → color map used in dashboards. */
  status: StatusColors
}

// ─── Dracula ────────────────────────────────────────────────────────────────

const DRACULA_PALETTE = {
  bg:      'hsl(231 15% 18%)',
  fg:      'hsl(60 30% 96%)',
  current: 'hsl(232 14% 31%)',
  comment: 'hsl(225 27% 51%)',
  purple:  'hsl(265 89% 78%)',
  cyan:    'hsl(191 97% 77%)',
  green:   'hsl(135 94% 65%)',
  pink:    'hsl(326 100% 74%)',
  orange:  'hsl(31 100% 71%)',
  red:     'hsl(0 100% 67%)',
  yellow:  'hsl(65 92% 76%)',
} as const

const DRACULA: ThemeDescriptor = {
  id: 'dracula',
  displayName: 'Dracula',
  tagline: 'The original — dark purple-tinted with vivid neon accents',
  scheme: 'dark',
  previewSwatches: {
    background: DRACULA_PALETTE.bg,
    foreground: DRACULA_PALETTE.fg,
    accents: [DRACULA_PALETTE.purple, DRACULA_PALETTE.pink, DRACULA_PALETTE.cyan, DRACULA_PALETTE.green],
  },
  xterm: {
    background: DRACULA_PALETTE.bg,
    foreground: DRACULA_PALETTE.fg,
    cursor: DRACULA_PALETTE.purple,
    cursorAccent: DRACULA_PALETTE.bg,
    selectionBackground: 'hsl(232 14% 36%)',
    black: 'hsl(232 14% 24%)',
    red: DRACULA_PALETTE.red,
    green: DRACULA_PALETTE.green,
    yellow: DRACULA_PALETTE.yellow,
    blue: DRACULA_PALETTE.purple,
    magenta: DRACULA_PALETTE.pink,
    cyan: DRACULA_PALETTE.cyan,
    white: DRACULA_PALETTE.fg,
    brightBlack: DRACULA_PALETTE.comment,
    brightRed: 'hsl(0 100% 78%)',
    brightGreen: 'hsl(135 94% 78%)',
    brightYellow: 'hsl(65 92% 86%)',
    brightBlue: 'hsl(265 89% 88%)',
    brightMagenta: 'hsl(326 100% 84%)',
    brightCyan: 'hsl(191 97% 87%)',
    brightWhite: 'hsl(60 30% 100%)',
  },
  chart: [DRACULA_PALETTE.purple, DRACULA_PALETTE.cyan, DRACULA_PALETTE.green, DRACULA_PALETTE.pink, DRACULA_PALETTE.orange],
  status: {
    completed: DRACULA_PALETTE.purple,
    failed:    DRACULA_PALETTE.pink,
    canceled:  DRACULA_PALETTE.orange,
    running:   DRACULA_PALETTE.cyan,
    queued:    DRACULA_PALETTE.comment,
  },
}

// ─── Aurora Light ──────────────────────────────────────────────────────────

const AURORA_PALETTE = {
  bg:        'hsl(220 25% 99%)',
  fg:        'hsl(230 28% 14%)',
  surface:   'hsl(220 22% 96%)',
  muted:     'hsl(225 14% 42%)',
  primary:   'hsl(255 75% 56%)',
  info:      'hsl(195 80% 42%)',
  success:   'hsl(150 65% 36%)',
  secondary: 'hsl(330 75% 52%)',
  warning:   'hsl(35 90% 48%)',
  destructive: 'hsl(0 72% 50%)',
  highlight: 'hsl(45 95% 48%)',
} as const

const AURORA_LIGHT: ThemeDescriptor = {
  id: 'aurora-light',
  displayName: 'Aurora Light',
  tagline: 'Premium light — Linear-inspired indigo on warm off-white',
  scheme: 'light',
  previewSwatches: {
    background: AURORA_PALETTE.bg,
    foreground: AURORA_PALETTE.fg,
    accents: [AURORA_PALETTE.primary, AURORA_PALETTE.secondary, AURORA_PALETTE.info, AURORA_PALETTE.success],
  },
  xterm: {
    background: AURORA_PALETTE.bg,
    foreground: AURORA_PALETTE.fg,
    cursor: AURORA_PALETTE.primary,
    cursorAccent: AURORA_PALETTE.bg,
    selectionBackground: 'hsl(255 75% 90%)',
    black: 'hsl(225 14% 18%)',
    red: AURORA_PALETTE.destructive,
    green: AURORA_PALETTE.success,
    yellow: AURORA_PALETTE.warning,
    blue: AURORA_PALETTE.primary,
    magenta: AURORA_PALETTE.secondary,
    cyan: AURORA_PALETTE.info,
    white: AURORA_PALETTE.fg,
    brightBlack: AURORA_PALETTE.muted,
    brightRed: 'hsl(0 72% 38%)',
    brightGreen: 'hsl(150 65% 26%)',
    brightYellow: 'hsl(35 90% 38%)',
    brightBlue: 'hsl(255 75% 42%)',
    brightMagenta: 'hsl(330 75% 38%)',
    brightCyan: 'hsl(195 80% 32%)',
    brightWhite: 'hsl(230 28% 8%)',
  },
  chart: [AURORA_PALETTE.primary, AURORA_PALETTE.info, AURORA_PALETTE.success, AURORA_PALETTE.secondary, AURORA_PALETTE.warning],
  status: {
    completed: AURORA_PALETTE.primary,
    failed:    AURORA_PALETTE.secondary,
    canceled:  AURORA_PALETTE.warning,
    running:   AURORA_PALETTE.info,
    queued:    AURORA_PALETTE.muted,
  },
}

// ─── Obsidian Dark ─────────────────────────────────────────────────────────

const OBSIDIAN_PALETTE = {
  bg:        'hsl(222 18% 8%)',
  fg:        'hsl(220 18% 92%)',
  surface:   'hsl(222 16% 12%)',
  muted:     'hsl(220 12% 60%)',
  primary:   'hsl(265 80% 72%)',
  info:      'hsl(192 90% 62%)',
  success:   'hsl(150 70% 55%)',
  secondary: 'hsl(330 80% 68%)',
  warning:   'hsl(35 95% 62%)',
  destructive: 'hsl(0 78% 62%)',
  highlight: 'hsl(50 95% 65%)',
} as const

const OBSIDIAN_DARK: ThemeDescriptor = {
  id: 'obsidian-dark',
  displayName: 'Obsidian Dark',
  tagline: 'Premium dark — near-black blue-tinted with electric accents',
  scheme: 'dark',
  previewSwatches: {
    background: OBSIDIAN_PALETTE.bg,
    foreground: OBSIDIAN_PALETTE.fg,
    accents: [OBSIDIAN_PALETTE.primary, OBSIDIAN_PALETTE.info, OBSIDIAN_PALETTE.secondary, OBSIDIAN_PALETTE.success],
  },
  xterm: {
    background: OBSIDIAN_PALETTE.bg,
    foreground: OBSIDIAN_PALETTE.fg,
    cursor: OBSIDIAN_PALETTE.primary,
    cursorAccent: OBSIDIAN_PALETTE.bg,
    selectionBackground: 'hsl(222 16% 22%)',
    black: 'hsl(222 16% 14%)',
    red: OBSIDIAN_PALETTE.destructive,
    green: OBSIDIAN_PALETTE.success,
    yellow: OBSIDIAN_PALETTE.warning,
    blue: OBSIDIAN_PALETTE.primary,
    magenta: OBSIDIAN_PALETTE.secondary,
    cyan: OBSIDIAN_PALETTE.info,
    white: OBSIDIAN_PALETTE.fg,
    brightBlack: OBSIDIAN_PALETTE.muted,
    brightRed: 'hsl(0 78% 78%)',
    brightGreen: 'hsl(150 70% 70%)',
    brightYellow: 'hsl(35 95% 78%)',
    brightBlue: 'hsl(265 80% 86%)',
    brightMagenta: 'hsl(330 80% 80%)',
    brightCyan: 'hsl(192 90% 78%)',
    brightWhite: 'hsl(220 18% 100%)',
  },
  chart: [OBSIDIAN_PALETTE.primary, OBSIDIAN_PALETTE.info, OBSIDIAN_PALETTE.success, OBSIDIAN_PALETTE.secondary, OBSIDIAN_PALETTE.warning],
  status: {
    completed: OBSIDIAN_PALETTE.primary,
    failed:    OBSIDIAN_PALETTE.secondary,
    canceled:  OBSIDIAN_PALETTE.warning,
    running:   OBSIDIAN_PALETTE.info,
    queued:    OBSIDIAN_PALETTE.muted,
  },
}

// ─── Code Rain ────────────────────────────────────────────────────────────────

const CODE_RAIN_PALETTE = {
  bg:        'hsl(154 30% 5%)',     // near-black, green-tinted (deep terminal)
  fg:        'hsl(150 100% 86%)',   // mint phosphor — soft, AAA contrast on bg
  surface:   'hsl(154 28% 9%)',     // raised panels
  muted:     'hsl(150 40% 55%)',    // medium-green secondary text
  // Accents — spread across hue families so the six semantic slots stay
  // visually distinct (see design.md). primary / secondary / success sit in
  // the green band but with ≥0.17 lightness deltas; info is teal; warning,
  // highlight and destructive are warm sentinels.
  primary:     'hsl(144 100% 50%)', // canonical phosphor green (#00FF66 family)
  info:        'hsl(174 56% 56%)',  // teal (#4FD1C5)
  success:     'hsl(145 100% 70%)', // bright mint-green (#5BFFA0)
  secondary:   'hsl(153 100% 33%)', // deep terminal green — pill backgrounds
  warning:     'hsl(35 100% 64%)',  // amber (#FFB347)
  highlight:   'hsl(51 100% 50%)',  // gold (#FFD700)
  destructive: 'hsl(351 100% 65%)', // rose (#FF4D6D — the red pill)
} as const

const CODE_RAIN: ThemeDescriptor = {
  id: 'code-rain',
  displayName: 'Code Rain',
  tagline: 'Phosphor terminal — soft mint on green-tinted near-black',
  scheme: 'dark',
  previewSwatches: {
    background: CODE_RAIN_PALETTE.bg,
    foreground: CODE_RAIN_PALETTE.fg,
    accents: [CODE_RAIN_PALETTE.primary, CODE_RAIN_PALETTE.info, CODE_RAIN_PALETTE.highlight, CODE_RAIN_PALETTE.destructive],
  },
  xterm: {
    background: CODE_RAIN_PALETTE.bg,
    foreground: CODE_RAIN_PALETTE.fg,
    cursor: CODE_RAIN_PALETTE.primary,
    cursorAccent: CODE_RAIN_PALETTE.bg,
    selectionBackground: 'hsl(154 40% 22%)',
    black: 'hsl(154 30% 10%)',
    red: CODE_RAIN_PALETTE.destructive,
    green: CODE_RAIN_PALETTE.primary,
    yellow: CODE_RAIN_PALETTE.warning,
    blue: CODE_RAIN_PALETTE.info,
    magenta: CODE_RAIN_PALETTE.highlight,
    cyan: CODE_RAIN_PALETTE.info,
    white: CODE_RAIN_PALETTE.fg,
    brightBlack: CODE_RAIN_PALETTE.muted,
    brightRed: 'hsl(351 100% 78%)',
    brightGreen: CODE_RAIN_PALETTE.success,
    brightYellow: 'hsl(35 100% 78%)',
    brightBlue: 'hsl(174 56% 72%)',
    brightMagenta: 'hsl(51 100% 70%)',
    brightCyan: 'hsl(174 56% 78%)',
    brightWhite: 'hsl(150 100% 96%)',
  },
  chart: [CODE_RAIN_PALETTE.primary, CODE_RAIN_PALETTE.info, CODE_RAIN_PALETTE.warning, CODE_RAIN_PALETTE.highlight, CODE_RAIN_PALETTE.destructive],
  status: {
    completed: CODE_RAIN_PALETTE.primary,
    failed:    CODE_RAIN_PALETTE.destructive,
    canceled:  CODE_RAIN_PALETTE.warning,
    running:   CODE_RAIN_PALETTE.info,
    queued:    CODE_RAIN_PALETTE.muted,
  },
}

// ─── SpecRails ─────────────────────────────────────────────────────────────

const SPECRAILS_PALETTE = {
  bg:          'hsl(240 33% 4%)',     // near-black #06060c
  card:        'hsl(240 30% 8%)',     // bg2 #0d0d1a
  bgDeep:      'hsl(240 40% 2%)',
  fg:          'hsl(240 20% 95%)',
  muted:       'hsl(240 13% 62%)',
  primary:     'hsl(187 100% 44%)',   // cyan #00C3D2
  secondary:   'hsl(280 45% 62%)',    // violet
  success:     'hsl(152 78% 48%)',    // emerald
  info:        'hsl(191 97% 55%)',    // electric cyan
  warning:     'hsl(42 92% 58%)',     // amber
  highlight:   'hsl(248 75% 67%)',    // indigo
  destructive: 'hsl(12 80% 55%)',     // tomato-red
} as const

const SPECRAILS: ThemeDescriptor = {
  id: 'specrails',
  displayName: 'SpecRails',
  tagline: 'Brand theme — deep navy-indigo with saturated cyan accents',
  scheme: 'dark',
  previewSwatches: {
    background: SPECRAILS_PALETTE.bg,
    foreground: SPECRAILS_PALETTE.fg,
    accents: [SPECRAILS_PALETTE.primary, SPECRAILS_PALETTE.highlight, SPECRAILS_PALETTE.secondary, SPECRAILS_PALETTE.success],
  },
  xterm: {
    background:          SPECRAILS_PALETTE.bg,
    foreground:          SPECRAILS_PALETTE.fg,
    cursor:              SPECRAILS_PALETTE.primary,
    cursorAccent:        SPECRAILS_PALETTE.bg,
    selectionBackground: 'hsl(240 30% 22%)',
    black:               'hsl(240 35% 8%)',
    red:                 SPECRAILS_PALETTE.destructive,
    green:               SPECRAILS_PALETTE.success,
    yellow:              SPECRAILS_PALETTE.warning,
    blue:                SPECRAILS_PALETTE.highlight,
    magenta:             SPECRAILS_PALETTE.secondary,
    cyan:                SPECRAILS_PALETTE.primary,
    white:               SPECRAILS_PALETTE.fg,
    brightBlack:         SPECRAILS_PALETTE.muted,
    brightRed:           'hsl(12 78% 66%)',
    brightGreen:         'hsl(152 80% 58%)',
    brightYellow:        'hsl(42 90% 70%)',
    brightBlue:          'hsl(248 70% 76%)',
    brightMagenta:       'hsl(280 38% 70%)',
    brightCyan:          'hsl(191 97% 65%)',
    brightWhite:         'hsl(240 20% 100%)',
  },
  chart: [SPECRAILS_PALETTE.primary, SPECRAILS_PALETTE.info, SPECRAILS_PALETTE.success, SPECRAILS_PALETTE.secondary, SPECRAILS_PALETTE.warning],
  status: {
    completed: SPECRAILS_PALETTE.primary,
    failed:    SPECRAILS_PALETTE.destructive,
    canceled:  SPECRAILS_PALETTE.warning,
    running:   SPECRAILS_PALETTE.info,
    queued:    SPECRAILS_PALETTE.muted,
  },
}

// ─── Galaxy ─────────────────────────────────────────────────────────────

const GALAXY_PALETTE = {
  bg:          'hsl(220 20% 4%)',     // neutral deep-space near-black
  card:        'hsl(220 18% 8%)',
  bgDeep:      'hsl(220 24% 2%)',
  fg:          'hsl(210 30% 94%)',    // cool near-white
  muted:       'hsl(215 15% 60%)',
  primary:     'hsl(212 100% 62%)',   // light-side blue — shared by primary/ring/info
  info:        'hsl(212 100% 62%)',   // same hue as primary (ticket-directed)
  secondary:   'hsl(210 12% 65%)',    // steel steel-gray/silver
  success:     'hsl(140 65% 50%)',    // core green
  warning:     'hsl(28 95% 56%)',     // pulse orange
  highlight:   'hsl(55 90% 56%)',     // signal gold
  destructive: 'hsl(355 92% 56%)',    // dark-side red
} as const

const GALAXY: ThemeDescriptor = {
  id: 'galaxy',
  displayName: 'Galaxy',
  tagline: 'Deep-space blue with a glowing blade trail',
  scheme: 'dark',
  previewSwatches: {
    background: GALAXY_PALETTE.bg,
    foreground: GALAXY_PALETTE.fg,
    accents: [GALAXY_PALETTE.primary, GALAXY_PALETTE.destructive, GALAXY_PALETTE.highlight, GALAXY_PALETTE.success],
  },
  xterm: {
    background:          GALAXY_PALETTE.bg,
    foreground:          GALAXY_PALETTE.fg,
    cursor:              GALAXY_PALETTE.primary,
    cursorAccent:        GALAXY_PALETTE.bg,
    selectionBackground: 'hsl(220 18% 18%)',
    black:               'hsl(220 18% 7%)',
    red:                 GALAXY_PALETTE.destructive,
    green:               GALAXY_PALETTE.success,
    yellow:              GALAXY_PALETTE.warning,
    blue:                GALAXY_PALETTE.primary,
    magenta:             GALAXY_PALETTE.secondary,
    cyan:                GALAXY_PALETTE.primary,
    white:               GALAXY_PALETTE.fg,
    brightBlack:         GALAXY_PALETTE.muted,
    brightRed:           'hsl(355 92% 68%)',
    brightGreen:         'hsl(140 65% 62%)',
    brightYellow:        'hsl(28 95% 68%)',
    brightBlue:          'hsl(212 100% 74%)',
    brightMagenta:       'hsl(210 12% 78%)',
    brightCyan:          'hsl(212 100% 74%)',
    brightWhite:         'hsl(210 30% 100%)',
  },
  chart: [GALAXY_PALETTE.primary, GALAXY_PALETTE.success, GALAXY_PALETTE.warning, GALAXY_PALETTE.secondary, GALAXY_PALETTE.destructive],
  status: {
    completed: GALAXY_PALETTE.primary,
    failed:    GALAXY_PALETTE.destructive,
    canceled:  GALAXY_PALETTE.warning,
    running:   GALAXY_PALETTE.info,
    queued:    GALAXY_PALETTE.muted,
  },
}

// ─── Public registry ───────────────────────────────────────────────────────

export const THEMES: Record<ThemeId, ThemeDescriptor> = {
  'dracula':       DRACULA,
  'aurora-light':  AURORA_LIGHT,
  'obsidian-dark': OBSIDIAN_DARK,
  'code-rain':        CODE_RAIN,
  'specrails':     SPECRAILS,
  'galaxy':     GALAXY,
}

export function getTheme(id: ThemeId): ThemeDescriptor {
  return THEMES[id]
}

/** localStorage key used by the anti-FOUC boot script and ThemeContext mirror. */
export const THEME_LOCAL_STORAGE_KEY = 'specrails-desktop:ui-theme'
