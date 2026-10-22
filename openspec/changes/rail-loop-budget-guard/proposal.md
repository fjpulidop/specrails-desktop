## Why

The daily budget auto-pause only stops QueueManager queues (`_pauseAllQueuesForDesktopBudget`). Rail launches go through the loop engine (`LoopRunManager`, isolated rail launches), and that path never checked the budget. With a budget set and already exhausted, Play, Launch all, mission cards, MCP and mobile launches still spawned paid AI work. A running loop also kept going after it crossed the budget. This is Phase 0 task 0.4 of the feedback-2026-10 program.

## What Changes

- **Launch gate.** Before anything is spawned, `POST /rails/:i/launch` and `/relaunch`, `POST /loop-runs` (standalone run) and `POST /loop-runs/:id/resume` read the same project and app-wide budget state the queue enforces. Over budget, they return `409 { error: 'daily_budget_exceeded', scope, budgetUsd, spentUsd, resetsAt, detail, action }`. MCP `launch`/`launch_all`, the mobile companion and milestone chains all forward to these routes, so they share the gate. MCP `launch_all` reports a `daily-budget-exceeded` skip.
- **Between-step pause.** `LoopRunManager` checks the budget before each AI-bearing node after the first (legacy traversal). For Core workflows it checks before it re-invokes Core with a human decision. Over budget, the run parks on the existing in-process pause: `loop_runs.status='paused'`, `restart_reason='budget_paused'`, and `loop.run_paused` with `pauseKind: 'budget_paused'` and budget amounts. Resume re-checks the budget. Stop settles the run as `stopped`. The pause does not consume the run deadline.
- **Client.** Rail Play, Launch all (new "over the daily budget" summary part), the mission launch card, mission relaunch and the review packet revision show localized amounts and the remedy. A `budget_paused` run shows a localized banner on the mission card, and its Resume button calls the resume route. Copy is in all 8 locales.

## Capabilities

### New Capabilities
- `rail-loop-budget-guard`: daily budget admission for rail and loop launches, and the resumable `budget_paused` pause between AI steps.

## Impact

- **Server:** `modules/execution` (`domain/daily-budget.ts`, `evaluateDailyBudgets`, `runtime/daily-budget-gate.ts`), `project-registry.ts` (shared app-wide snapshot, `ProjectContext.dailyBudgetRejection`), `rails-router.ts`, `project-router-loop-runs.ts`, `project-router-jobs.ts`, `loop-run-manager.ts`, `loop-definition-run.ts`, `loop-runs-store.ts` (`pauseLoopRun` reason), `types.ts`, `mcp/tools/rails.ts`.
- **Client:** `lib/daily-budget.ts`, `DashboardPage`, `AgentRailLaunchCard`, `AgentPrDecisionCard`, `useRunVitals`, `ReviewPacketPage`, and locales (common, dashboard, agent, packet ×8).
- No migration: `restart_reason` already exists. The WebSocket and job fields are additive.
