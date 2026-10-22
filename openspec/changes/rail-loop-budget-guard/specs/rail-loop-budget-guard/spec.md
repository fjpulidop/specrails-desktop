## ADDED Requirements

### Requirement: Rail and loop launches honor the daily budget

Every cost-incurring rail or loop launch SHALL consult the same project and app-wide daily budget state that the QueueManager auto-pause enforces, before it spawns anything. When a budget is exhausted, the launch SHALL be refused with HTTP 409 and a body `{ error: 'daily_budget_exceeded', scope, budgetUsd, spentUsd, resetsAt, detail, action }`. A refused launch SHALL NOT allocate worktrees, enqueue jobs, create loop runs or start an executor.

#### Scenario: Launch over budget is refused
- **WHEN** the project or app-wide daily spend has reached its configured budget and a rail launch, relaunch or standalone loop run is requested from any door (dashboard, Launch all, mission card, MCP, mobile, milestone chain)
- **THEN** the route returns 409 `daily_budget_exceeded` with the scope, budget, spend and reset time, and no run, job or worktree is created

#### Scenario: No budget configured
- **WHEN** no daily budget is set, or the spend is below it
- **THEN** launches behave exactly as before

#### Scenario: Unreadable budget state
- **WHEN** the budget state cannot be read
- **THEN** the launch is admitted (fail-open) and the failure is logged

### Requirement: Running loops pause on the daily budget between AI steps

A loop run whose budget becomes exhausted SHALL finish its current step and then pause before the next AI-bearing step. It SHALL use the existing paused lifecycle with `restart_reason = 'budget_paused'`. It SHALL emit `loop.run_paused` with `pauseKind: 'budget_paused'` and the budget amounts. For Core workflows, the boundary is the re-invocation of Core after a human decision.

#### Scenario: Budget exhausted mid-run
- **WHEN** an AI step completes and the daily budget is now exhausted
- **THEN** the run is `paused` with `restart_reason = 'budget_paused'`, no further AI step starts, and the job reports `loopPauseKind: 'budget_paused'` with the budget

#### Scenario: Resume after raising the budget
- **WHEN** the budget is raised or cleared and the run is resumed via `POST /loop-runs/:id/resume` or a turn on its job
- **THEN** the run continues from the next step and `restart_reason` is cleared

#### Scenario: Resume while still over budget
- **WHEN** a `budget_paused` run is resumed while the budget is still exhausted
- **THEN** the request returns 409 `daily_budget_exceeded` and the run stays paused

#### Scenario: Stop while budget-paused
- **WHEN** a `budget_paused` run is stopped
- **THEN** it settles with outcome `stopped` without running another step

### Requirement: Budget refusals and pauses are visible in the UI

The client SHALL show daily budget refusals and `budget_paused` runs with localized amounts and remedy text in all supported locales.

#### Scenario: Launch all with rails over budget
- **WHEN** Launch all receives `daily_budget_exceeded` for some rails
- **THEN** the summary counts them as over the daily budget, not as failures, and the rails stay idle

#### Scenario: Paused mission run
- **WHEN** a mission run is `budget_paused`
- **THEN** its card shows the localized budget pause and a Resume button that calls the loop-run resume route, surfacing a still-exceeded refusal as a toast
