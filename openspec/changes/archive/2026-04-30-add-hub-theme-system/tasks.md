## 1. Foundation: token rename

- [x] 1.1 Author `scripts/rename-theme-tokens.mjs` codemod implementing the D1 mapping with word-boundary regex over `client/src/**/*.{ts,tsx,css}`
- [x] 1.2 Run codemod; commit the mechanical rename in isolation for review clarity
- [x] 1.3 Update `client/src/globals.css` `@theme inline` block to declare semantic tokens (`--color-accent-primary`, `--color-accent-info`, `--color-accent-success`, `--color-accent-secondary`, `--color-accent-warning`, `--color-accent-danger`, `--color-accent-highlight`, `--color-surface`, `--color-background-deep`) with the same Dracula HSL values they had before — visually identical
- [x] 1.4 Drop `--color-dracula-comment` declarations and migrate any leftover usage to `muted-foreground`
- [x] 1.5 Verify zero remaining `dracula-*` references: `grep -rn "dracula-" client/src --include="*.ts" --include="*.tsx" --include="*.css"` returns empty
- [x] 1.6 Run `npm run typecheck` and `npm test` — confirm all green with mechanical rename only (no behavioral change yet)

## 2. Theme registry and context

- [x] 2.1 Create `client/src/features/settings/lib/themes.ts` exporting `ThemeId = 'dracula' | 'aurora-light' | 'obsidian-dark'`, a `ThemeDescriptor` interface (cssVars, xterm, chart, syntax, displayName, tagline, previewSwatches), and a `THEMES: Record<ThemeId, ThemeDescriptor>` registry with the Dracula descriptor first (mirrors current values)
- [x] 2.2 Add `aurora-light` descriptor: warm-neutral background, indigo primary, light-friendly accents; tune for WCAG AA on body copy
- [x] 2.3 Add `obsidian-dark` descriptor: near-black blue-tinted background, distinct from Dracula; tune accent palette
- [x] 2.4 Create `client/src/features/settings/context/ThemeContext.tsx` exposing `ThemeProvider` and `useTheme()`; provider applies `data-theme` to `document.documentElement`, mirrors to localStorage, fetches server value on mount, reconciles on mismatch
- [x] 2.5 Mount `ThemeProvider` above `HubProvider` in `client/src/App.tsx`
- [x] 2.6 Unit-test `ThemeContext`: setting theme writes localStorage + document attribute + PATCH; reconcile-from-server overwrites stale cache; invalid input falls back to default
- [x] 2.7 Unit-test `themes.ts`: every descriptor has all required fields; allow-list matches `ThemeId`

## 3. CSS theme override blocks

- [x] 3.1 In `client/src/globals.css`, add `[data-theme="aurora-light"] { ... }` block redefining every CSS var with light-theme values
- [x] 3.2 Add `[data-theme="obsidian-dark"] { ... }` block with dark-theme values
- [x] 3.3 Confirm no shadcn semantic variable is left undefined in either override block
- [x] 3.4 Manual visual sanity pass on dashboard, settings, agents, terminal panel, analytics under each theme

## 4. Server: persistence and endpoints

- [x] 4.1 Add migration in `server/hub-db.ts` that seeds `INSERT OR IGNORE INTO hub_settings (key, value) VALUES ('ui_theme', 'dracula')`
- [x] 4.2 Add `GET /api/hub/theme` route in `server/hub-router.ts` returning `{ theme: <persisted-value> }`
- [x] 4.3 Add `PATCH /api/hub/theme` route validating the body against the allow-list (`['dracula', 'aurora-light', 'obsidian-dark']`); persist to `hub_settings`; return 400 on invalid input
- [x] 4.4 Unit-test the endpoints via `server/hub-router.test.ts` (or matching test file): GET default, PATCH happy path, PATCH invalid value, persistence across restarts simulated by reopening the SQLite handle

## 5. Anti-FOUC boot script

- [x] 5.1 Add inline blocking script to `client/index.html` head that reads `localStorage.getItem('specrails-hub:ui-theme')`, validates against the allow-list, and sets `document.documentElement.dataset.theme` (default `dracula`)
- [x] 5.2 Wrap the read in try/catch to handle Tauri/edge-case throws
- [x] 5.3 Verify in `vite build` that the inline script survives in `dist/index.html` and is positioned before the `<script type="module">` Vite bundle tag
- [x] 5.4 Test (vitest with jsdom) that the script applies the cached theme correctly given various localStorage states

## 6. Settings UI: Appearance section

- [x] 6.1 Create `client/src/features/settings/components/AppearanceSection.tsx` rendering three theme cards using preview swatches from `themes.ts`
- [x] 6.2 Each card shows: name, tagline, swatch row (background + 4–5 accent chips), and a selected-state indicator (ring + check icon)
- [x] 6.3 Click handler: optimistic UI update (apply `data-theme` immediately) → call `setTheme()` from `useTheme()` → on PATCH failure revert UI and show inline error toast
- [x] 6.4 Wire `AppearanceSection` into `client/src/features/settings/pages/GlobalSettingsPage.tsx` as a new tab/section
- [x] 6.5 Component tests: renders three cards, marks active correctly, click triggers context update, server failure reverts selection
- [x] 6.6 Make cards keyboard-accessible (Tab to focus, Enter/Space to select), with visible focus ring

## 7. Bridge to non-CSS surfaces

- [x] 7.1 Refactor `client/src/lib/dracula-colors.ts` → `client/src/features/settings/lib/theme-palette.ts`; export `getActivePalette(themeId)` and update `__tests__/dracula-colors.test.ts` → `theme-palette.test.ts`
- [x] 7.2 In `client/src/features/terminals/context/TerminalsContext.tsx`, subscribe to `useTheme()`; on theme change call `term.options.theme = THEMES[id].xterm` for every active session — preserve scrollback and marks
- [x] 7.3 Test that switching theme does not recreate xterm instances (object identity preserved) and updates the palette
- [x] 7.4 Update `client/src/components/analytics/*` Recharts components to read palette from `useTheme()` (memoized per theme change); replace any hardcoded color literals
- [x] 7.5 Update `client/src/features/jobs/components/LogViewer.tsx` syntax highlighting to use the active theme's `syntax` map
- [x] 7.6 Update `client/src/demo-mode/tour/tour.css` to reference CSS vars instead of hardcoded Dracula values

## 8. Documentation

- [x] 8.1 Add a "Theme system" subsection under Architecture in `CLAUDE.md` covering: token semantics, where to add a new theme (`themes.ts` + `globals.css` + xterm/chart/syntax mappings), and the FOUC boot pattern
- [x] 8.2 Add a "Conventions" line: components MUST use semantic tokens (`accent-primary` etc.); brand-named tokens are forbidden

## 9. Cleanup and verification

- [x] 9.1 Delete `scripts/rename-theme-tokens.mjs` codemod (its purpose is fulfilled and committed in history)
- [x] 9.2 Run full local CI mirror: `npm run typecheck && npm test && npm run test:coverage && (cd client && npm run test:coverage)` — all thresholds must pass
- [x] 9.3 Manual smoke: launch hub, switch each theme via Settings, open a terminal in each theme, view analytics page in each theme, view a log file in each theme — confirm no visual regressions or unstyled surfaces
- [x] 9.4 Verify project switching does not change the theme
- [x] 9.5 Verify reload preserves the chosen theme without flash on each theme
- [x] 9.6 Verify Tauri packaged build inherits the inline FOUC script (smoke test on macOS desktop build if convenient)

## 10. Release prep

- [x] 10.1 Compose a `feat:` commit describing the theme system; release-please will pick up as a minor bump
- [x] 10.2 Open PR; ensure CI passes coverage gates
- [x] 10.3 After merge, archive this OpenSpec change via `/opsx:archive`
