## Context

The hub theme system (`openspec/specs/hub-theme-system/spec.md`) defines an OCP-aligned extension protocol: add a new theme by (a) appending to `THEME_IDS`, (b) adding a `ThemeDescriptor` to `THEMES`, (c) adding a `[data-theme="<id>"]` CSS block, and (d) adding the id to the server allow-list. No component code changes. This design follows that protocol exactly.

The brand palette comes from `design_handoff_specrails_web/README.md` and `SpecRails Redesign.html`: deep navy-indigo background, saturated cyan as the primary action color, soft violet secondary, and an off-white foreground optimized for long reading sessions.

## Goals / Non-Goals

**Goals:**
1. Add 'specrails' as a selectable theme with correctly-mapped semantic tokens for every surface (CSS, xterm, Recharts, syntax highlighting, sonner toasts).
2. Make 'specrails' the new `DEFAULT_THEME` so fresh installs open on brand.
3. Server allow-list accepts 'specrails' on `PATCH /api/hub/theme`.
4. Zero regressions on existing themes.

**Non-Goals:**
- Retroactively migrating existing user preferences. Users who explicitly set a theme keep it.
- Changing any component code, hooks, or routes.
- Adding any non-theme feature (the existing theme switch UI already handles the new card automatically).

## Decisions

### D1 — Token values for non-specified semantics

The feature description provides thirteen semantic tokens. The remaining tokens (shadcn primitives: `--color-primary`, `--color-secondary`, `--color-muted`, `--color-accent`, `--color-input`, `--color-ring`, `--color-popover`, `--color-card-foreground`, etc.; decorative tokens: `--color-scrollbar-*`, `--color-prose-*`, `--color-toast-shadow`, `--glass-card-opacity`) must be derived consistently. Decision: derive them from the provided palette anchors using the same derivation patterns established by Obsidian Dark (the closest existing dark theme in hue character). Specifically:

- `--color-primary` maps to `--accent-primary` (`hsl(187 100% 41%)`): used by shadcn ring, focus, and Radix primary color.
- `--color-ring` also maps to `--accent-primary`.
- `--color-card`, `--color-secondary`, `--color-muted`, `--color-accent`, `--color-input` all use the provided `--card` token (`hsl(238 30% 9%)`): they are "elevated surface" variants.
- `--color-card-foreground`, `--color-popover-foreground` use `--foreground` (`hsl(240 20% 94%)`).
- `--color-popover` uses `--background` (`hsl(240 35% 4%)`).
- `--color-primary-foreground` and `--color-destructive-foreground` use `--background` (dark text on bright accent and destructive).
- `--color-secondary-foreground` and `--color-muted-foreground` use `--muted-foreground` (`hsl(240 12% 58%)`).
- `--color-accent-foreground` uses `--foreground`.
- `--color-destructive` maps to `--accent-destructive` (`hsl(12 78% 52%)`).
- Decorative tokens (scrollbar, prose, toast) computed as HSL-shifted variants of background/card using the same opacity ratios as Obsidian Dark (the two themes share similar lightness profiles).

**Why this approach:** Consistency with existing derivation patterns means the Tailwind utilities already used throughout the component tree (`bg-card`, `text-muted-foreground`, `border-border`, `ring-ring`) produce visually coherent results on the new theme without any component-side tuning. Obsidian Dark is the nearest dark-theme analogue in terms of saturation and hue range.

### D2 — xterm palette derivation

xterm requires 16 ANSI colors + cursor + selection. Decision: adopt the same structural mapping used by Dracula and Obsidian Dark:
- `background` / `foreground` / `cursor` / `cursorAccent` from the four anchor tokens.
- `selectionBackground`: background elevated by ~18% lightness in the blue-indigo band.
- ANSI black / bright-black: background + card values.
- ANSI red / green / yellow / cyan / white: map to destructive / success / warning / info / foreground accents.
- ANSI blue: `--accent-highlight` (indigo-adjacent, `hsl(248 70% 63%)`).
- ANSI magenta: `--accent-secondary` (`hsl(280 38% 57%)`).
- Bright variants: each ANSI color lightened by 10–15 lightness points.

**Why this approach:** A structurally consistent palette ensures colored diff output, git status coloring, and log levels read naturally in the terminal panel against the theme's background. Ad-hoc picking would require iterative visual tuning with no systematic basis.

### D3 — chart palette ordering

Recharts series colors are drawn in declaration order. Decision: `[accent-primary, accent-info, accent-success, accent-secondary, accent-warning]` — matching Obsidian Dark's ordering pattern (primary-info-success-secondary-warning), which separates warm/cool hues across the five series without adjacency clash.

### D4 — DEFAULT_THEME change strategy

Changing `DEFAULT_THEME` is a forward-only change: it affects only users who have never persisted a theme (no `hub_settings.ui_theme` row). The anti-FOUC script in `client/index.html` reads `localStorage['specrails-hub:ui-theme']` first, then falls back to the server-stored default. Existing users with any stored preference are unaffected. Decision: change unconditionally in the same commit as the theme addition. No migration script needed.

## Affected Files

| File | Layer | Change type |
|------|-------|-------------|
| `client/src/features/settings/lib/themes.ts` | frontend | SPECRAILS_PALETTE const + ThemeDescriptor + THEME_IDS + DEFAULT_THEME |
| `client/src/globals.css` | frontend | New `[data-theme="specrails"]` CSS block (~35 lines) |
| `server/hub-router.ts` | backend | Add `'specrails'` to THEME_ID_ALLOWLIST Set |

## Implementation Detail

### `client/src/features/settings/lib/themes.ts`

**Step 1 — Update THEME_IDS and DEFAULT_THEME:**

```ts
export const THEME_IDS = ['dracula', 'aurora-light', 'obsidian-dark', 'matrix', 'specrails'] as const
export const DEFAULT_THEME: ThemeId = 'specrails'
```

**Step 2 — Define SPECRAILS_PALETTE const (before the THEMES registry):**

```ts
const SPECRAILS_PALETTE = {
  bg:          'hsl(240 35% 4%)',
  card:        'hsl(238 30% 9%)',
  bgDeep:      'hsl(240 38% 2%)',
  fg:          'hsl(240 20% 94%)',
  muted:       'hsl(240 12% 58%)',
  primary:     'hsl(187 100% 41%)',   // cyan
  secondary:   'hsl(280 38% 57%)',    // violet
  success:     'hsl(152 80% 44%)',    // emerald
  info:        'hsl(191 97% 50%)',    // electric cyan
  warning:     'hsl(42 90% 56%)',     // amber
  highlight:   'hsl(248 70% 63%)',    // indigo
  destructive: 'hsl(12 78% 52%)',     // tomato-red
} as const
```

**Step 3 — Add SPECRAILS ThemeDescriptor object:**

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
    background: SPECRAILS_PALETTE.bg,
    foreground: SPECRAILS_PALETTE.fg,
    cursor: SPECRAILS_PALETTE.primary,
    cursorAccent: SPECRAILS_PALETTE.bg,
    selectionBackground: 'hsl(240 30% 22%)',
    black: 'hsl(240 35% 8%)',
    red: SPECRAILS_PALETTE.destructive,
    green: SPECRAILS_PALETTE.success,
    yellow: SPECRAILS_PALETTE.warning,
    blue: SPECRAILS_PALETTE.highlight,
    magenta: SPECRAILS_PALETTE.secondary,
    cyan: SPECRAILS_PALETTE.primary,
    white: SPECRAILS_PALETTE.fg,
    brightBlack: SPECRAILS_PALETTE.muted,
    brightRed:     'hsl(12 78% 66%)',
    brightGreen:   'hsl(152 80% 58%)',
    brightYellow:  'hsl(42 90% 70%)',
    brightBlue:    'hsl(248 70% 76%)',
    brightMagenta: 'hsl(280 38% 70%)',
    brightCyan:    'hsl(191 97% 65%)',
    brightWhite:   'hsl(240 20% 100%)',
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

**Step 4 — Register in THEMES map:**

```ts
export const THEMES: Record<ThemeId, ThemeDescriptor> = {
  'dracula':       DRACULA,
  'aurora-light':  AURORA_LIGHT,
  'obsidian-dark': OBSIDIAN_DARK,
  'matrix':        MATRIX,
  'specrails':     SPECRAILS,
}
```

### `client/src/globals.css`

Add the following block immediately after the `[data-theme="obsidian-dark"]` closing brace (line ~208) and before the `@layer base` block. The block redefines every token that the `@theme` block establishes as a Dracula default:

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

### `server/hub-router.ts`

Locate the `THEME_ID_ALLOWLIST` Set literal at line ~30:

```ts
// Before:
const THEME_ID_ALLOWLIST = new Set<string>(['dracula', 'aurora-light', 'obsidian-dark', 'matrix'])

// After:
const THEME_ID_ALLOWLIST = new Set<string>(['dracula', 'aurora-light', 'obsidian-dark', 'matrix', 'specrails'])
```

## Risks & Considerations

1. **`DEFAULT_THEME` change affects new installs.** Any user who has never set a theme will see 'specrails' on next launch. This is intentional. Documented in proposal.md; no rollback mechanism is needed beyond reverting the `DEFAULT_THEME` line if required.

2. **Regression guard on `dracula-*` brand tokens.** The existing CI grep (`grep -r 'dracula-'`) must not match the new theme block. The SPECRAILS_PALETTE const uses generic key names (not `dracula-*`), so this passes cleanly.

3. **TypeScript strict mode — `ThemeId` union.** Adding `'specrails'` to `THEME_IDS as const` extends the `ThemeId` union. Any `switch` on `ThemeId` that has a default fallback compiles fine. There are no exhaustive `switch`es on `ThemeId` in the codebase (verified: all theme consumers call `getTheme(id)` and use the descriptor).

4. **Anti-FOUC script in `client/index.html`.** The inline script reads `localStorage['specrails-hub:ui-theme']` first, then fetches from the server. It does not validate the value against `THEME_IDS` — it applies whatever is stored. A user with no stored value will receive `'specrails'` from the server default path. No change to the script is needed.

5. **xterm `hsl()` syntax compatibility.** xterm.js `ITheme` accepts CSS color strings. All existing themes use `hsl(h s% l%)` space-separated (CSS Level 4 syntax). The new theme follows the same convention, so this is safe.
