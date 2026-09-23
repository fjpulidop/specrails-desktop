## Task Breakdown

Three sequential tasks cover the entire implementation. All are purely additive — no existing code is deleted or mutated beyond extending the two data structures and changing one constant.

---

## 1. [frontend] Extend theme registry in `client/src/features/settings/lib/themes.ts`

**Files involved:**
- `client/src/features/settings/lib/themes.ts`

**What to do:**

1.1 — Append `'specrails'` to `THEME_IDS`:
```ts
export const THEME_IDS = ['dracula', 'aurora-light', 'obsidian-dark', 'matrix', 'specrails'] as const
```

1.2 — Change `DEFAULT_THEME`:
```ts
export const DEFAULT_THEME: ThemeId = 'specrails'
```

1.3 — Add `SPECRAILS_PALETTE` const immediately after the `MATRIX` block and before the `THEMES` registry (follow the `// ─── <Name> ──` comment separator pattern used by all other palettes):

```ts
// ─── SpecRails ─────────────────────────────────────────────────────────────

const SPECRAILS_PALETTE = {
  bg:          'hsl(240 35% 4%)',
  card:        'hsl(238 30% 9%)',
  bgDeep:      'hsl(240 38% 2%)',
  fg:          'hsl(240 20% 94%)',
  muted:       'hsl(240 12% 58%)',
  primary:     'hsl(187 100% 41%)',
  secondary:   'hsl(280 38% 57%)',
  success:     'hsl(152 80% 44%)',
  info:        'hsl(191 97% 50%)',
  warning:     'hsl(42 90% 56%)',
  highlight:   'hsl(248 70% 63%)',
  destructive: 'hsl(12 78% 52%)',
} as const
```

1.4 — Add `SPECRAILS` ThemeDescriptor const immediately after the palette:

```ts
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
```

1.5 — Register 'specrails' in the `THEMES` map:
```ts
export const THEMES: Record<ThemeId, ThemeDescriptor> = {
  'dracula':       DRACULA,
  'aurora-light':  AURORA_LIGHT,
  'obsidian-dark': OBSIDIAN_DARK,
  'matrix':        MATRIX,
  'specrails':     SPECRAILS,
}
```

**Acceptance criteria:**
- `THEME_IDS` has exactly 5 members; TypeScript `ThemeId` union includes `'specrails'`.
- `DEFAULT_THEME === 'specrails'` at runtime.
- `getTheme('specrails')` returns the descriptor without throwing.
- `SPECRAILS.xterm` has all 22 fields of `XtermTheme` (TypeScript will enforce this at build time).
- `SPECRAILS.chart.length === 5`.
- `cd client && npx tsc --noEmit` passes with no new errors.

**Dependencies:** None (first task).

---

## 2. [frontend] Add `[data-theme="specrails"]` block to `client/src/globals.css`

**Files involved:**
- `client/src/globals.css`

**What to do:**

Insert the following CSS block immediately after the closing brace of `[data-theme="obsidian-dark"]` (currently ending around line 208) and before `@layer base`. Follow the same comment-header pattern used by all existing theme blocks.

```css
/* ─── SpecRails (brand theme — deep navy-indigo, saturated cyan) ─── */
[data-theme="specrails"] {
  --color-background:             hsl(240 35% 4%);    /* deep navy-indigo */
  --color-foreground:             hsl(240 20% 94%);
  --color-card:                   hsl(238 30% 9%);
  --color-card-foreground:        hsl(240 20% 94%);
  --color-popover:                hsl(240 35% 4%);
  --color-popover-foreground:     hsl(240 20% 94%);
  --color-primary:                hsl(187 100% 41%);  /* saturated cyan */
  --color-primary-foreground:     hsl(240 35% 4%);
  --color-secondary:              hsl(238 26% 13%);
  --color-secondary-foreground:   hsl(240 20% 94%);
  --color-muted:                  hsl(238 26% 13%);
  --color-muted-foreground:       hsl(240 12% 58%);
  --color-accent:                 hsl(238 26% 13%);
  --color-accent-foreground:      hsl(240 20% 94%);
  --color-destructive:            hsl(12 78% 52%);
  --color-destructive-foreground: hsl(240 35% 4%);
  --color-border:                 hsl(240 20% 100% / 0.08);
  --color-input:                  hsl(238 26% 13%);
  --color-ring:                   hsl(187 100% 41%);

  --color-accent-primary:    hsl(187 100% 41%);  /* cyan */
  --color-accent-info:       hsl(191 97% 50%);   /* electric cyan */
  --color-accent-success:    hsl(152 80% 44%);   /* emerald */
  --color-accent-secondary:  hsl(280 38% 57%);   /* violet */
  --color-accent-warning:    hsl(42 90% 56%);    /* amber */
  --color-accent-highlight:  hsl(248 70% 63%);   /* indigo */
  --color-surface:           hsl(238 30% 9%);
  --color-background-deep:   hsl(240 38% 2%);

  --color-scrollbar-thumb:       hsl(240 20% 50% / 0.35);
  --color-scrollbar-thumb-hover: hsl(240 20% 60% / 0.55);
  --color-prose-table-stripe:    hsl(238 30% 9% / 0.5);
  --color-prose-table-header:    hsl(238 30% 9% / 0.8);
  --color-toast-shadow:          hsl(240 38% 1% / 0.65);
  --glass-card-opacity:          28%;
}
```

**Acceptance criteria:**
- The block defines all tokens listed in the `@theme` default block (lines 33–74 of globals.css): every `--color-*` and `--glass-card-opacity` token.
- No existing `[data-theme="..."]` block is modified.
- `grep -r 'dracula-' client/src/` returns zero matches (regression guard passes).
- `cd client && npm run build` completes without CSS errors.
- Manually toggling `document.documentElement.dataset.theme = 'specrails'` in the browser DevTools applies the navy-indigo background and cyan accents visually.

**Dependencies:** Task 1 (THEME_IDS must include 'specrails' before the Settings UI can render the new card, though CSS works independently).

---

## 3. [backend] Add 'specrails' to `THEME_ID_ALLOWLIST` in `server/hub-router.ts`

**Files involved:**
- `server/hub-router.ts`

**What to do:**

Locate the `THEME_ID_ALLOWLIST` Set at approximately line 30:

```ts
// Current:
const THEME_ID_ALLOWLIST = new Set<string>(['dracula', 'aurora-light', 'obsidian-dark', 'matrix'])

// Change to:
const THEME_ID_ALLOWLIST = new Set<string>(['dracula', 'aurora-light', 'obsidian-dark', 'matrix', 'specrails'])
```

No other changes to this file are required. The comment above the Set already reads: "Theme allow-list. Mirror of THEME_IDS in `client/src/features/settings/lib/themes.ts`" — no comment update needed since the intent is already described generically.

**Acceptance criteria:**
- `PATCH /api/hub/theme` with `{ "theme": "specrails" }` returns HTTP 200 and stores the value.
- `PATCH /api/hub/theme` with `{ "theme": "bogus" }` still returns HTTP 400.
- `GET /api/hub/theme` after the PATCH returns `{ "theme": "specrails" }`.
- `npm run typecheck` passes.
- `npm test` passes (existing hub-router tests exercise the allowlist; no new test file is required for this one-line change, but confirm the existing `PATCH /theme` 400 test still passes).

**Dependencies:** None (server-side change is independent of CSS/TS changes and can land in any order).
