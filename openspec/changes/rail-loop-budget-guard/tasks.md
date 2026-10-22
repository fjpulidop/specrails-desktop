## 1. Server

- [x] 1.1 Execution: `domain/daily-budget.ts` (breach, rejection body, reset boundary), `evaluateDailyBudgets`, `runtime/daily-budget-gate.ts`; core rules and manifest updated
- [x] 1.2 Registry: shared app-wide snapshot, `ProjectContext.dailyBudgetRejection`, `LoopRunManager` option
- [x] 1.3 Rails launch/relaunch gate; standalone `POST /loop-runs` gate; Core resume gate
- [x] 1.4 `LoopRunManager` `budget_paused` pause between AI steps (legacy) and before Core continuation; `resumeBudgetPause`; deadline shift
- [x] 1.5 Resume doors: loop-run resume route and job turn route; `GET /jobs/:id` exposes `loopPauseKind`/`loopPauseBudget`
- [x] 1.6 MCP `launch_all` maps the 409 to a `daily-budget-exceeded` skip; tool description updated

## 2. Client

- [x] 2.1 `lib/daily-budget.ts` localized copy; locales ×8 (common, dashboard, agent, packet)
- [x] 2.2 Rail Play and Launch all, mission launch card, mission relaunch, review packet revision
- [x] 2.3 `useRunVitals` budget pause; mission card banner and Resume via the loop-run resume route

## 3. Verification

- [x] 3.1 Server tests: execution budget, rails-router (loop, relaunch, legacy, no-budget), loop-runs routes, job turn route, MCP launch_all, LoopRunManager pause/resume/stop/deadline/Core continuation
- [x] 3.2 Client tests: daily-budget lib, launch card, Launch all, mission card, useRunVitals
- [x] 3.3 Typecheck, architecture audit and affected suites green; docs updated (tracking-cost, configuration, api-reference, execution README)
