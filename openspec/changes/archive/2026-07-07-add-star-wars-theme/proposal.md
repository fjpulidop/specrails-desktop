## Why

Specrails Desktop ships five selectable themes (`dracula`, `aurora-light`, `obsidian-dark`, `matrix`, `specrails`), each following an established OCP-friendly registry pattern (`client/src/lib/themes.ts` + a `[data-theme="..."]` block in `client/src/globals.css`). `matrix` already proved that a themed, motion-aware decorative canvas effect (`MatrixRain`) is a differentiator users notice and enjoy. There is no equally playful, high-craft dark theme built around a different visual language — a thin glowing "blade" accent instead of falling glyphs. Adding a sixth theme, `star-wars`, extends the existing pattern with a distinct palette (Jedi-blue/Sith-red/gold/Force-green) and a new decorative effect (`LightsaberTrail`) without touching any consuming component, per the module's documented OCP contract.

## What Changes

- Add a sixth theme id `star-wars` to `THEME_IDS` in `client/src/lib/themes.ts`, with a full `ThemeDescriptor` (xterm palette, 5-color chart palette, job-status colors, preview swatches) following the exact shape of the `MATRIX`/`SPECRAILS` entries.
- Add a `[data-theme="star-wars"]` block to `client/src/globals.css` redefining every `--color-*` token declared in the base `@theme` block, mirroring the `matrix`/`specrails` blocks.
- Add a `--starwars-glow` CSS custom property plus a `@media (prefers-reduced-motion: no-preference)`-gated `:focus-visible` drop-shadow rule on interactive elements (`button`, `a`, `[role="button"]`, `[role="radio"]`), mirroring the existing `--matrix-glow` rule.
- Add a thin glowing border treatment for active/primary-bordered surfaces (active nav item, active card outline) scoped to `[data-theme="star-wars"]`, reusing the `color-mix(...)` + `box-shadow` idiom of the `glow-primary`/`glow-secondary` utilities.
- Add a new decorative component `client/src/components/theme-effects/LightsaberTrail.tsx`: a canvas-based cursor-trail effect (thin glowing blade-line, not a glyph rain), following `MatrixRain.tsx`'s exact contract (fixed full-viewport `pointer-events:none` canvas at `z-index:-1`, no internal theme-id branching, respects `prefers-reduced-motion`, pauses its rAF loop while `document.hidden`).
- Register `'star-wars': LightsaberTrail` in `ThemeEffectLayer.tsx`'s `THEME_EFFECTS` map, alongside the existing `matrix: MatrixRain` entry.
- Extend the server-side `THEME_ID_ALLOWLIST` in `server/desktop-router.ts` to accept `'star-wars'` (keeps the client/server allow-lists synchronized, as documented).
- Add a `star-wars` tagline translation key to the `appearance.taglines` block in all 8 locale files (`client/src/locales/<lang>/settings.json`), matching the existing per-theme tagline entries (functionally optional — `ThemePickerGrid` already falls back to `t.tagline` — but kept for locale-parity consistency with the other five themes and this project's "every user-visible string goes through `t()` in all locales" convention).
- Update `client/src/lib/__tests__/themes.test.ts` fixed-array/fixed-list assertions (`THEME_IDS` exact-equality check, the dark-themes list, the `scheme` list) to include `star-wars`.
- No changes to `ThemePickerGrid.tsx`, `ThemeContext.tsx`, or `theme-palette.ts` — both already read the registry generically (confirmed by reading the current source).

## Capabilities

### New Capabilities

(none — this change extends the existing `desktop-theme-system` capability; no new capability directory is introduced)

### Modified Capabilities

- `desktop-theme-system`: the theme catalog requirement currently documents "exactly four built-in themes" (a pre-existing drift — `specrails` shipped as a fifth theme without updating this requirement's prose). This change corrects the catalog requirement to reflect six themes (the four originally documented, plus `specrails` and the new `star-wars`), and adds new requirements/scenarios for: the `star-wars` palette definition, its non-CSS-surface propagation (xterm/chart/status), the `LightsaberTrail` decorative effect's motion-awareness and OCP isolation, and the blade-glow focus/border treatment's motion-awareness.

## Impact

- **Affected files**: `client/src/lib/themes.ts`, `client/src/globals.css`, `client/src/components/theme-effects/LightsaberTrail.tsx` (new), `client/src/components/theme-effects/ThemeEffectLayer.tsx`, `server/desktop-router.ts`, `client/src/lib/__tests__/themes.test.ts`, all 8 `client/src/locales/<lang>/settings.json` files.
- **No API contract changes**: `GET/PATCH /api/theme` behavior is unchanged — only the accepted value set grows by one string.
- **No new dependencies.**
- **No migration needed**: `ui_theme` is a free-text `desktop_settings` value validated against the allow-list; adding a new allowed value requires no schema change.
- **Out of scope** (per ticket): a user-facing toggle between Jedi-blue/Sith-red as competing primary accents, sound effects, an animated intro/crawl sequence, a custom cursor icon, and translating the new theme into `docs/guide/*/settings/1-themes.md` (fast-follow).
