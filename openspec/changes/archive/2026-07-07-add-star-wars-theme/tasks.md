## 1. Theme registry — palette + descriptor

- [x] 1.1 Add `'star-wars'` to `THEME_IDS` in `client/src/lib/themes.ts` (append after `'specrails'`, keep `DEFAULT_THEME` unchanged at `'specrails'`).
  **Layer:** client
  **Files:** Modify: `client/src/lib/themes.ts`
  **Acceptance:** `THEME_IDS` includes `'star-wars'`; `isThemeId('star-wars')` returns `true`.

- [x] 1.2 Define `STAR_WARS_PALETTE` (a literal const object, mirroring the shape of `MATRIX_PALETTE`/`SPECRAILS_PALETTE`) with: `bg` (deep-space near-black, blue-tinted, hue ≈224°), `card`, `bgDeep`, `fg` (cool near-white), `muted`, `primary`/`info` sharing one Jedi-blue hue (≈212°, L≥55%), `secondary` (violet — Mace Windu homage, hue ≈280°), `success` (Force-green, hue ≈140°), `warning` (blaster-orange, hue ≈28°), `highlight` (droid-gold, hue ≈45°), `destructive` (Sith-red, hue ≈355°). See `design.md` Decision D1 for exact rationale and hue spacing; use it as the concrete value reference.
  **Layer:** client
  **Files:** Modify: `client/src/lib/themes.ts`
  **Acceptance:** every accent hue is ≥15° apart from its neighbors when plotted on the hue wheel (matches the existing "distinct accent slots" test pattern for `matrix`).

- [x] 1.3 Define `STAR_WARS: ThemeDescriptor` using `STAR_WARS_PALETTE`: `displayName: 'Star Wars'`, a one-line `tagline`, `scheme: 'dark'`, `previewSwatches` (background/foreground + 4 accents), a full 20-key `xterm` palette (background/foreground/cursor/cursorAccent/selectionBackground + 8 ANSI + 8 bright variants — follow the exact key-by-key mapping pattern `MATRIX`/`SPECRAILS` use, e.g. `red: destructive`, `green: success`, `blue`/`cyan: primary`, `magenta: secondary`, `yellow: warning`), a 5-entry unique `chart` palette (`[primary, success, warning, secondary, destructive]` or similar — verify no duplicate values), and a `status` map (`completed: primary`, `failed: destructive`, `canceled: warning`, `running: info`, `queued: muted`).
  **Layer:** client
  **Files:** Modify: `client/src/lib/themes.ts`
  **Acceptance:** matches the `ThemeDescriptor` interface exactly (compiles under `tsc --noEmit`); `chart` has 5 unique entries; `xterm` has all 20 keys populated.

- [x] 1.4 Add `'star-wars': STAR_WARS` to the `THEMES` registry map in `client/src/lib/themes.ts`.
  **Layer:** client
  **Files:** Modify: `client/src/lib/themes.ts`
  **Acceptance:** `THEMES['star-wars']` returns the `STAR_WARS` descriptor; `getTheme('star-wars')` works.

## 2. CSS tokens, focus-glow, and border-glow

- [x] 2.1 Add a `[data-theme="star-wars"] { ... }` block to `client/src/globals.css` (placed after the `[data-theme="specrails"]` block, before the "Global bevel for native `<select>`" comment), redefining every token declared in the base `@theme` block using `STAR_WARS_PALETTE`'s values: `--color-background`, `--color-foreground`, `--color-card`, `--color-card-foreground`, `--color-popover`, `--color-popover-foreground`, `--color-primary`, `--color-primary-foreground`, `--color-secondary`, `--color-secondary-foreground`, `--color-muted`, `--color-muted-foreground`, `--color-accent`, `--color-accent-foreground`, `--color-destructive`, `--color-destructive-foreground`, `--color-border`, `--color-input`, `--color-ring`, `--color-accent-primary`, `--color-accent-info`, `--color-accent-success`, `--color-accent-secondary`, `--color-accent-warning`, `--color-accent-highlight`, `--color-surface`, `--color-background-deep`, `--color-scrollbar-thumb`, `--color-scrollbar-thumb-hover`, `--color-prose-table-stripe`, `--color-prose-table-header`, `--color-toast-shadow`, `--glass-card-opacity`. Values MUST be the exact same HSL literals used in `STAR_WARS_PALETTE` (task 1.2) so the JS registry and CSS block never drift.
  **Layer:** client
  **Files:** Modify: `client/src/globals.css`
  **Acceptance:** `grep -c "star-wars" client/src/globals.css` shows the new block; every `--color-*` name from the base `@theme` block (line 42-83) appears inside the new block; visually distinct from `obsidian-dark`/`specrails`/`matrix` when toggled in the running app.

- [x] 2.2 Add `--starwars-glow: drop-shadow(0 0 10px <jedi-blue> / 0.45);` inside the new `[data-theme="star-wars"]` block, then extend the existing `@media (prefers-reduced-motion: no-preference) { ... }` rule (the one currently scoping `[data-theme="matrix"] button:focus-visible, ...`) with a parallel set of selectors: `[data-theme="star-wars"] button:focus-visible, [data-theme="star-wars"] a:focus-visible, [data-theme="star-wars"] [role="button"]:focus-visible, [data-theme="star-wars"] [role="radio"]:focus-visible { filter: var(--starwars-glow); }` (either append to the existing rule block or add a sibling rule inside the same `@media` block — either is acceptable as long as both matrix and star-wars stay independently scoped).
  **Layer:** client
  **Files:** Modify: `client/src/globals.css`
  **Acceptance:** focusing a button/link/radio under `star-wars` (motion allowed) shows the blue glow filter; under `prefers-reduced-motion: reduce` it does not; `matrix`'s glow rule is untouched.

- [x] 2.3 Add a thin glowing border treatment scoped to `[data-theme="star-wars"]`, targeting the two zero-new-markup hooks identified in `design.md` Decision D3: (a) `[data-theme="star-wars"] a[aria-current="page"]` (react-router's active-link attribute, already set by every `<NavLink>` in the app, e.g. `ProjectRightSidebar.tsx`) and (b) `[data-theme="star-wars"] .border-accent-primary` (the existing "active/selected" utility class already applied conditionally by ~19 components). Both selectors should get a `box-shadow` built from the `color-mix(...)` idiom already used by the `glow-primary`/`glow-secondary` `@utility` rules (e.g. `box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent-primary) 55%, transparent), 0 0 12px color-mix(in srgb, var(--color-accent-primary) 30%, transparent);`), gated behind the same `@media (prefers-reduced-motion: no-preference)` block as task 2.2 (a static 1px outline with no glow may still render under reduced motion if desired, but the glow/shadow portion must be motion-gated).
  **Layer:** client
  **Files:** Modify: `client/src/globals.css`
  **Acceptance:** an active nav item and a selected card (any surface using `border-accent-primary`, e.g. the Theme picker's own selected card) render a visible thin glowing border only under `star-wars`; no other theme's nav/border styling changes (byte-identical CSS output for the other five `[data-theme]` blocks).

## 3. LightsaberTrail decorative effect

- [x] 3.1 Create `client/src/components/theme-effects/LightsaberTrail.tsx`: a new canvas-based cursor-trail component mirroring `MatrixRain.tsx`'s exact lifecycle contract (see `design.md` Decision D2 for the full rendering approach). Structure: a ring buffer of recent pointer positions (`{x, y, t}`, capped ~24 samples, ~200ms TTL), a `requestAnimationFrame` loop that strokes a tapered, glowing polyline through the buffer (`ctx.shadowBlur`, `ctx.shadowColor`, decreasing `lineWidth`/`globalAlpha` from head to tail, `lineCap: 'round'`), a hardcoded blue/white blade gradient (component MUST NOT branch on theme id or read `data-theme` — it is unconditionally "the lightsaber effect", dispatched only by the registry). Bail out of the whole `useEffect` (no canvas draw, no RAF) when `window.matchMedia('(prefers-reduced-motion: reduce)').matches`. Register `resize`, `pointermove`, `mouseleave` (clear the live position so the trail fades naturally), and `visibilitychange` (cancel/resume the RAF loop) listeners, cleaning all of them up on unmount — same shape as `MatrixRain`'s effect cleanup.
  **Layer:** client
  **Files:** Create: `client/src/components/theme-effects/LightsaberTrail.tsx`
  **Acceptance:** renders a `<canvas aria-hidden className="fixed inset-0 pointer-events-none" style={{ zIndex: -1 }} />`; moving the pointer draws a thin glowing trail that fades within ~200ms; setting `prefers-reduced-motion: reduce` (jsdom `matchMedia` mock) results in no `requestAnimationFrame` call; hiding `document` (`visibilitychange` + `document.hidden = true`) cancels the animation frame.

- [x] 3.2 Register `'star-wars': LightsaberTrail` in the `THEME_EFFECTS` map in `client/src/components/theme-effects/ThemeEffectLayer.tsx` (alongside the existing `matrix: MatrixRain` entry), importing `LightsaberTrail` from the new file.
  **Layer:** client
  **Files:** Modify: `client/src/components/theme-effects/ThemeEffectLayer.tsx`
  **Acceptance:** `THEME_EFFECTS['star-wars'] === LightsaberTrail`; under the `star-wars` theme `ThemeEffectLayer` renders `<LightsaberTrail />`; under any of the other four non-matrix themes it renders `null`.

## 4. Server-side allow-list

- [x] 4.1 Add `'star-wars'` to the `THEME_ID_ALLOWLIST` `Set` in `server/desktop-router.ts` (line ~71, the `// Theme allow-list. Mirror of THEME_IDS ...` comment block).
  **Layer:** server
  **Files:** Modify: `server/desktop-router.ts`
  **Acceptance:** `PATCH /api/theme` with `{ "theme": "star-wars" }` persists successfully and `GET /api/theme` returns it; an invalid value still 400s.

## 5. Locale parity for the new tagline

- [x] 5.1 Add a `"star-wars"` key to the `appearance.taglines` object in all 8 locale files, matching the existing 5-key pattern (one short, on-brand tagline per language): `client/src/locales/en/settings.json`, `client/src/locales/es/settings.json`, `client/src/locales/fr/settings.json`, `client/src/locales/de/settings.json`, `client/src/locales/pt/settings.json`, `client/src/locales/it/settings.json`, `client/src/locales/zh/settings.json`, `client/src/locales/ja/settings.json`.
  **Layer:** client (i18n)
  **Files:** Modify: `client/src/locales/en/settings.json`, `client/src/locales/es/settings.json`, `client/src/locales/fr/settings.json`, `client/src/locales/de/settings.json`, `client/src/locales/pt/settings.json`, `client/src/locales/it/settings.json`, `client/src/locales/zh/settings.json`, `client/src/locales/ja/settings.json`
  **Acceptance:** the locale-parity test (`client/src/lib/__tests__/locale-parity.test.ts`) passes — every locale's `settings.json` mirrors English's `appearance.taglines` key set exactly.

## 6. Test updates

- [x] 6.1 Update `client/src/lib/__tests__/themes.test.ts`'s hardcoded fixtures to include `star-wars`: the `THEME_IDS allow-list contains the ... documented built-in themes` exact-array assertion, the `aurora-light has scheme=light, others=dark` assertion (add `star-wars` to the dark-scheme list), and the `each dark theme background is distinct from the others` `darks` array (add `'star-wars'`).
  **Layer:** tests
  **Files:** Modify: `client/src/lib/__tests__/themes.test.ts`
  **Acceptance:** `npx vitest run client/src/lib/__tests__/themes.test.ts` passes with `star-wars` included in every generic (`it.each(THEME_IDS)`) assertion and the updated fixed-array assertions.

- [x] 6.2 Add a `describe('star-wars theme', ...)` block to `client/src/lib/__tests__/themes.test.ts` (or a new sibling test file) asserting the theme-specific invariants from `design.md`/the delta spec: `accent-primary`, `ring`-equivalent, and `accent-info` share the same hue; `destructive` sits in the red hue band (340°–10°) and is distinct from `accent-highlight`'s gold band; `chart` palette spans at least 3 distinct hue families; foreground/background contrast meets WCAG AA (≥4.5:1) for body copy (reuse the existing `hslToLuminance`/`contrastRatio` helpers already defined in this test file for the `matrix` suite).
  **Layer:** tests
  **Files:** Modify: `client/src/lib/__tests__/themes.test.ts`
  **Acceptance:** all new assertions pass; contrast ratio ≥ 4.5.

- [x] 6.3 Add `client/src/components/theme-effects/__tests__/ThemeEffectLayer.test.tsx` (new file — none exists today): mock `useActiveTheme` from `../../../context/ThemeContext` to return each theme id in turn and assert `ThemeEffectLayer` renders `LightsaberTrail` only for `star-wars`, `MatrixRain` only for `matrix`, and `null` for every other theme id.
  **Layer:** tests
  **Files:** Create: `client/src/components/theme-effects/__tests__/ThemeEffectLayer.test.tsx`
  **Acceptance:** test passes for all 6 theme ids.

- [x] 6.4 Add `client/src/components/theme-effects/__tests__/LightsaberTrail.test.tsx` (new file): a lightweight smoke test — (a) mounts/unmounts without throwing, (b) with `window.matchMedia` mocked to report `prefers-reduced-motion: reduce`, asserts no `requestAnimationFrame` call occurs, (c) asserts the rendered `<canvas>` has `pointer-events: none` and the fixed/inset-0 class, (d) simulates `document.hidden = true` + a `visibilitychange` dispatch and asserts `cancelAnimationFrame` is invoked. Follow whatever `jsdom` canvas/`matchMedia` mocking convention the vitest setup already provides (check `client/vitest-setup.ts` / `client/vitest.config.ts` for an existing `HTMLCanvasElement.prototype.getContext` stub before adding a new one).
  **Layer:** tests
  **Files:** Create: `client/src/components/theme-effects/__tests__/LightsaberTrail.test.tsx`
  **Acceptance:** all assertions pass under `cd client && npx vitest run`.

- [x] 6.5 Add/extend a `server/desktop-router.test.ts` case verifying `PATCH /api/theme` accepts `star-wars` (mirroring the existing `'persists the matrix theme'` test) and that the `it.each([...])('accepts %s', ...)` parametrized list (if present) includes it.
  **Layer:** tests
  **Files:** Modify: `server/desktop-router.test.ts`
  **Acceptance:** `npx vitest run server/desktop-router.test.ts` passes, including a case sending `{ theme: 'star-wars' }`.

## 7. Verification

- [x] 7.1 Run the full coverage-gated suite per this repo's mandatory policy and fix any regressions: `npm run typecheck`, `npm test`, `npm run test:coverage`, `cd client && npm run test:coverage`.
  **Layer:** verification
  **Files:** (none — verification only)
  **Acceptance:** all four commands pass; coverage thresholds (70% global, 80% server, 80%/70% client) are not regressed.

- [x] 7.2 Manual smoke check in the running dev app (`npm run dev`): select `Star Wars` in Settings ▸ Appearance, confirm the lightsaber cursor trail renders behind panels (never intercepts clicks), confirm keyboard-focusing a button/link shows the blue glow, confirm the active nav item and a selected card render the glowing border, and confirm toggling OS-level reduced-motion (or the browser devtools emulation) removes both the cursor trail and the focus/border glow.
  **Layer:** verification
  **Files:** (none — manual QA only)
  **Acceptance:** all five visual behaviors confirmed; no console errors; no other theme's appearance changed.
