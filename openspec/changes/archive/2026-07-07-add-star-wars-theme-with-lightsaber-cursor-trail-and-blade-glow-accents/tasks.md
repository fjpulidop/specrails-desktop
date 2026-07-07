# Implementation Tasks

> The developer agent runs these in order. Each "## N." block is
> a single TDD cycle: write the failing test, run it to confirm
> it fails, write production code, run again to confirm it
> passes. Do NOT skip the failing-test step.

## 1. Add the Starfield canvas lifecycle
- [x] 1.1 Write a failing test in `client/src/components/theme-effects/__tests__/Starfield.test.tsx` that asserts Starfield renders a full-surface `pointer-events-none` canvas, starts drawing when reduced motion is not requested, does not start RAF when reduced motion is requested, and cancels/resumes RAF on `visibilitychange`. Run `npm --prefix client test -- Starfield`; the new test MUST fail.
- [x] 1.2 Implement the minimum production code in `client/src/components/theme-effects/Starfield.tsx` to make the test pass. Run `npm --prefix client test -- Starfield`; ALL targeted tests MUST pass.
- [x] 1.3 Refactor if needed without changing behavior. Run `npm --prefix client test -- Starfield`; all targeted tests still pass.

## 2. Mount Starfield only in Mission Control for Star Wars
- [x] 2.1 Write a failing test in `client/src/components/agent-chat/__tests__/AgentModeSurface.test.tsx` that mocks `Starfield` and `useActiveTheme`, asserting the Starfield is mounted when the active theme id is `star-wars`, not mounted for another theme, and the outer root exposes a narrow hook such as `data-agent-mode-surface`. Run `npm --prefix client test -- AgentModeSurface`; the new test MUST fail.
- [x] 2.2 Implement the minimum production code in `client/src/components/agent-chat/AgentModeSurface.tsx` to gate and mount `Starfield` behind existing content, preserving current empty/active composer behavior. Run `npm --prefix client test -- AgentModeSurface`; ALL targeted tests MUST pass.
- [x] 2.3 Refactor if needed without changing behavior. Run `npm --prefix client test -- AgentModeSurface`; all targeted tests still pass.

## 3. Mount Starfield only in the Specs Board dashboard for Star Wars
- [x] 3.1 Write a failing test in `client/src/pages/__tests__/DashboardPage.test.tsx` or a focused new dashboard test that mocks `Starfield` and `useActiveTheme`, asserting the Starfield is mounted under `star-wars` and absent under another theme. Run the relevant dashboard test command; the new test MUST fail.
- [x] 3.2 Implement the minimum production code in `client/src/pages/DashboardPage.tsx` to gate and mount `Starfield` behind the dashboard split content without changing drag/drop, splitter, modal, or rail behavior. Run the relevant dashboard test command; ALL targeted tests MUST pass.
- [x] 3.3 Refactor if needed without changing behavior. Run the relevant dashboard test command; all targeted tests still pass.

## 4. Reveal the existing LightsaberTrail behind Mission Control using scoped Star Wars CSS
- [x] 4.1 Write a failing regression test in `client/src/lib/__tests__/theme-palette.test.ts` or an appropriate CSS regression test that asserts `globals.css` contains Star Wars-scoped transparency selectors for the Agent Mode surface and Matrix-parity translucent panel collapse selectors, without a broad `[data-theme="star-wars"] .bg-background` override. Run the targeted test command; the new test MUST fail.
- [x] 4.2 Implement the minimum CSS in `client/src/globals.css`: mirror the bounded Matrix translucent-background selectors for `[data-theme="star-wars"]`, and add a narrow `[data-theme="star-wars"] [data-agent-mode-surface]` transparency rule. Run the targeted test command; ALL targeted tests MUST pass.
- [x] 4.3 Refactor if needed without changing behavior. Run the targeted test command; all targeted tests still pass.

## 5. Validation gate
- [x] 5.1 Run the full client test suite (`npm --prefix client test`); all pass.
- [x] 5.2 Run the project build (`npm --prefix client run build`); succeeds.
- [x] 5.3 No `console.log`, debug prints, broad theme-id branching outside the two view gates, or commented-out code in the diff.
