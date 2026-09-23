## Why

specrails-hub ships four themes today (Dracula, Aurora Light, Obsidian Dark, Matrix), all using DEFAULT_THEME = 'dracula' — a palette designed for a generic dark IDE. The project now has a canonical brand identity expressed in `design_handoff_specrails_web/`: a deep navy-indigo canvas with a saturated cyan primary (`hsl(187 100% 41%)`), soft violet secondary, and legible off-white foreground. The current default theme creates a visual disconnect between the specrails-hub UI and the specrails brand. Adding a first-party 'specrails' theme and making it the new default closes that gap.

## What Changes

- **`client/src/features/settings/lib/themes.ts`** — define `SPECRAILS_PALETTE` const; append `'specrails'` to `THEME_IDS`; add a `SPECRAILS` `ThemeDescriptor` entry in the `THEMES` registry (xterm, chart, status, previewSwatches); change `DEFAULT_THEME` from `'dracula'` to `'specrails'`.
- **`client/src/globals.css`** — add `[data-theme="specrails"] { ... }` block redefining every `--color-*` semantic token for the new palette. No existing token block is touched.
- **`server/hub-router.ts`** — add `'specrails'` to `THEME_ID_ALLOWLIST` so `PATCH /api/hub/theme` accepts the new value.

No other files need changes. The theme system is additive by design: components already use semantic tokens only; the anti-FOUC script in `client/index.html` reads `localStorage` and applies `data-theme` before React hydrates; the Settings page renders theme cards from `THEMES` dynamically.

## Capabilities

### New Capabilities
- `specrails-theme`: the specrails brand palette surfaced as a first-class hub theme — deep navy-indigo background, cyan primary, violet secondary, and semantic tokens matching the design handoff.

### Modified Capabilities
- `hub-theme-system`: `DEFAULT_THEME` changes from `'dracula'` to `'specrails'`; `THEME_IDS` gains a fifth member; `THEME_ID_ALLOWLIST` on the server gains `'specrails'`. Existing themes are byte-identical.

## Impact

**3 files touched in specrails-hub (purely additive, no deletions):**

- `client/src/features/settings/lib/themes.ts` — palette const + descriptor + THEME_IDS + DEFAULT_THEME change
- `client/src/globals.css` — one new CSS block, ~35 lines
- `server/hub-router.ts` — one string added to a Set literal

**API contract delta:** `GET /api/hub/theme` may now return `"specrails"`; `PATCH /api/hub/theme` now accepts `"specrails"`. The new theme id is additive — existing clients that do not recognize it will fall back to their last-known local value. No breaking change.

**Migration note:** Users who have never explicitly set a theme (hub_settings row absent) will see the new default on first launch after the update. Users with an explicit `'dracula'` persisted preference are unaffected (stored value still valid).
