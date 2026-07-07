# Implementation Tasks

> The developer agent runs these in order. Each "## N." block is
> a single TDD cycle: write the failing test, run it to confirm
> it fails, write production code, run again to confirm it
> passes. Do NOT skip the failing-test step.

## 1. Current ids replace legacy ids in the theme registry and palette contract
- [x] 1.1 Write failing assertions in `client/src/lib/__tests__/themes.test.ts` and `client/src/lib/__tests__/theme-palette.test.ts` that `THEME_IDS` contains `code-rain` and `galaxy`, excludes the legacy ids, exposes `LEGACY_THEME_ID_MAP`, keeps the Galaxy palette/CSS values synchronized with the previous visual values, and keeps Code Rain descriptors valid. Run the targeted client tests; the new assertions MUST fail.
- [x] 1.2 Implement the minimum production changes in `client/src/lib/themes.ts`, `client/src/lib/theme-palette.ts` if needed, and `client/src/globals.css` to rename ids, descriptor constants, display names, taglines, CSS selectors, glow variable names, and theme-specific comments while preserving color values. Run the targeted client tests; ALL targeted tests MUST pass.
- [x] 1.3 Run `rg -n "Star Wars|Jedi|Sith|lightsaber|Lightsaber|\\[data-theme=\\\"star-wars\\\"\\]|--starwars-glow|THEMES\\['star-wars'\\]" client/src client/index.html server` and fix any matches that are part of this ticket's theme terminology, preserving required legacy-id string literals only inside migration maps/tests. Re-run the targeted tests.

## 2. Theme effects and view-local background checks use current generic names
- [x] 2.1 Write failing tests in `client/src/components/theme-effects` tests if present, `client/src/pages/__tests__/DashboardPage.test.tsx`, and `client/src/components/agent-chat/__tests__/AgentModeSurface.test.tsx` that the global blade trail and view-local starfield mount only for `galaxy`, and that the terminal-rain effect mounts only for `code-rain`. Run the targeted tests; the new assertions MUST fail.
- [x] 2.2 Rename `client/src/components/theme-effects/LightsaberTrail.tsx` to `BladeTrail.tsx`, rename `MatrixRain.tsx` to `CodeRainEffect.tsx`, update exported component names, comments, imports, and `ThemeEffectLayer.tsx` registry keys, and update `DashboardPage.tsx` / `AgentModeSurface.tsx` theme checks to `galaxy`. Run the targeted tests; ALL targeted tests MUST pass.
- [x] 2.3 Refactor only stale generic terminology in files touched by this task and verify no theme-facing import uses the old component filenames. Run the targeted tests again.

## 3. Boot-time and React-time client migration preserves existing preferences
- [x] 3.1 Add failing tests in `client/src/lib/__tests__/themes.test.ts` and `client/src/context/__tests__/ThemeContext.test.tsx` proving that a stored `star-wars` value migrates to `galaxy`, a stored `matrix` value migrates to `code-rain`, `localStorage` is rewritten to the new id, and the boot HTML allow-list/splash variables recognize only current ids. Run the targeted tests; the new assertions MUST fail.
- [x] 3.2 Update `client/index.html` with the inline legacy map, current allow-list, and current splash selectors; update `client/src/context/ThemeContext.tsx` to normalize legacy ids from `data-theme`, localStorage, and server responses before applying/persisting. Run the targeted tests; ALL targeted tests MUST pass.
- [x] 3.3 Confirm first-paint paths cannot briefly apply the default theme for migrated values by reviewing the boot script order and rerunning the targeted tests.

## 4. Server and MCP theme settings enforce current ids with read-side migration
- [x] 4.1 Add failing tests in `server/desktop-router.test.ts` for `GET /theme` migrating stored `star-wars` to `galaxy` and stored `matrix` to `code-rain` with DB write-back, PATCH accepting `galaxy`/`code-rain`, and PATCH rejecting legacy ids. Add or update MCP app-settings tests if an existing test harness covers `specrails_settings`. Run the targeted server tests; the new assertions MUST fail.
- [x] 4.2 Update `server/desktop-router.ts` with the current allow-list and legacy read-side migration, and update `server/mcp/tools/app-settings.ts` so writable themes are current ids only. Run the targeted server tests; ALL targeted tests MUST pass.
- [x] 4.3 Re-run a search for stale server allow-list values and fix any drift between the desktop route and MCP settings tool. Re-run targeted server tests.

## 5. Localized settings/setup copy and theme-facing terminology are sanitized
- [x] 5.1 Write or update localization/key-parity checks, or add focused assertions in existing theme tests, that settings theme tagline keys use `code-rain` and `galaxy` and do not expose old branded theme names in theme picker copy. Run the relevant tests; the new assertions MUST fail.
- [x] 5.2 Update `client/src/locales/*/settings.json`, `client/src/locales/*/setup.json`, and `client/src/locales/*/agent.json` only where the strings are theme-facing branded copy or keys that must follow the renamed ids. Use generic copy for the special agent empty-state title or remove the theme-specific branch if that branch no longer fits the current ids. Run the relevant tests; ALL targeted tests MUST pass.
- [x] 5.3 Run `rg -n "Star Wars|Jedi|Sith|lightsaber|Lightsaber|theme-card-matrix|theme-card-star-wars|emptyTitleMatrix|\\\"star-wars\\\"|\\\"matrix\\\"" client/src client/index.html server` and classify remaining matches: required legacy map/test literals may stay; theme-facing copy, selectors, component identifiers, and allow-lists must be gone. Re-run the relevant tests.

## 6. Validation gate
- [x] 6.1 Run the full project test suite (`npm run test:all`); all pass.
- [x] 6.2 Run the project typecheck/build gate (`npm run typecheck && npm run build`); succeeds.
- [x] 6.3 Run `openspec validate add-galaxy-theme-with-blade-trail-and-glow-accents --strict`; succeeds.
- [x] 6.4 No `console.log`, debug prints, or commented-out code in the diff.
