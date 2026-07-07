# Implementation Tasks

> The developer agent runs these in order. Each "## N." block is
> a single TDD cycle: write the failing test, run it to confirm
> it fails, write production code, run again to confirm it
> passes. Do NOT skip the failing-test step.

## 1. Anti-FOUC allow-list recognizes Star Wars
- [x] 1.1 Write a failing test in `client/src/lib/__tests__/themes.test.ts` that reads `client/index.html`, extracts the anti-FOUC `allowed` array, and asserts it includes every current `THEME_IDS` entry, including `star-wars`. Run `cd client && npx vitest run src/lib/__tests__/themes.test.ts`; the new test MUST fail because `star-wars` is missing from the HTML allow-list.
- [x] 1.2 Implement the minimum production code in `client/index.html` by adding `'star-wars'` to the anti-FOUC `allowed` array. Keep the existing boot flow and fallback behavior unchanged. Run `cd client && npx vitest run src/lib/__tests__/themes.test.ts`; ALL tests MUST pass.
- [x] 1.3 Refactor if needed without changing behavior. Run `cd client && npx vitest run src/lib/__tests__/themes.test.ts`; all tests still pass.

## 2. Splash screen has Star Wars pre-React palette variables
- [x] 2.1 Write a failing test in `client/src/lib/__tests__/themes.test.ts` that reads `client/index.html` and asserts an `html[data-theme="star-wars"]` block exists with `--splash-bg: hsl(220 20% 4%)`, `--splash-fg: hsl(210 30% 94%)`, `--splash-primary: hsl(212 100% 62%)`, `--splash-secondary: hsl(210 12% 65%)`, and `--splash-muted: hsl(215 15% 60%)`. Run `cd client && npx vitest run src/lib/__tests__/themes.test.ts`; the new test MUST fail because the splash block is missing.
- [x] 2.2 Implement the minimum production code in `client/index.html` by adding the Star Wars splash CSS block next to the existing theme-specific splash blocks. Run `cd client && npx vitest run src/lib/__tests__/themes.test.ts`; ALL tests MUST pass.
- [x] 2.3 Refactor if needed without changing behavior. Run `cd client && npx vitest run src/lib/__tests__/themes.test.ts`; all tests still pass.

## 3. Validation gate
- [x] 3.1 Run the focused client theme test (`cd client && npx vitest run src/lib/__tests__/themes.test.ts`); all pass.
- [x] 3.2 Run the full client test suite (`npm run test:client`); all pass.
- [x] 3.3 Run the project build (`npm run build`); succeeds.
- [x] 3.4 No `console.log`, debug prints, or commented-out code in the diff.
