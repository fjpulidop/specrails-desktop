# Implementation Tasks

> The developer agent runs these in order. Each "## N." block is
> a single TDD cycle: write the failing test, run it to confirm
> it fails, write production code, run again to confirm it
> passes. Do NOT skip the failing-test step.

## 1. Star Wars palette no longer collides with SpecRails
- [x] 1.1 Write a failing test in `client/src/lib/__tests__/themes.test.ts` that asserts the Star Wars background is desaturated neutral near-black (`hsl(220 20% 4%)` target band), the Star Wars secondary accent is a low-saturation steel-gray/silver hue around 210 degrees, and neither value collides with the SpecRails background/secondary hue families. Run `cd client && npx vitest run src/lib/__tests__/themes.test.ts`; the new test MUST fail on the current `hsl(224 45% 5%)` background and `hsl(280 65% 64%)` secondary.
- [x] 1.2 Implement the minimum production code in `client/src/lib/themes.ts` by updating only `STAR_WARS_PALETTE` and derived Star Wars descriptor literals for xterm, chart, and status colors. Run `cd client && npx vitest run src/lib/__tests__/themes.test.ts`; ALL tests MUST pass.
- [x] 1.3 Refactor if needed without changing behavior. Run `cd client && npx vitest run src/lib/__tests__/themes.test.ts`; all tests still pass.

## 2. CSS Star Wars block stays synchronized with the revised palette
- [x] 2.1 Write or extend a failing test in `client/src/lib/__tests__/themes.test.ts` (or the nearest existing theme-token test if one exists) that protects Star Wars JS/CSS synchronization for the revised background, card/surface/background-deep elevation values, primary/info/ring, secondary, and `--starwars-glow`. Run the focused test; it MUST fail against the current CSS block if the CSS still contains the old navy/violet literals.
- [x] 2.2 Implement the minimum production code in `client/src/globals.css` by updating only the `[data-theme="star-wars"]` block so every Star Wars `--color-*` token and `--starwars-glow` match the revised palette intent. Run the focused test; ALL tests MUST pass.
- [x] 2.3 Refactor if needed without changing behavior. Run the focused test again; all tests still pass.

## 3. Guard the palette-only scope
- [x] 3.1 Confirm the diff does not touch `client/src/components/theme-effects/LightsaberTrail.tsx`, `client/src/components/theme-effects/ThemeEffectLayer.tsx`, `THEME_IDS`, server theme validation, locale files, or any non-Star-Wars theme block. Run `git diff --name-only` and verify only the planned source/test/OpenSpec files are present for this follow-up, aside from unrelated pre-existing worktree changes.
- [x] 3.2 Run `git diff -- client/src/lib/themes.ts client/src/globals.css` and confirm all changes are confined to `STAR_WARS_PALETTE`, the Star Wars descriptor values derived from it, and `[data-theme="star-wars"]`.

## 4. Validation gate
- [x] 4.1 Run the focused theme test: `cd client && npx vitest run src/lib/__tests__/themes.test.ts`; all pass.
- [x] 4.2 Run the client build: `cd client && npm run build`; succeeds.
- [x] 4.3 No `console.log`, debug prints, commented-out code, or unrelated palette churn in the diff.
