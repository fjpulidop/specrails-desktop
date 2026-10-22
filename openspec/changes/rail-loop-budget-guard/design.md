## Context

The queue enforces two budgets through `enforceDailyBudgets` (execution module):

- **Project budget:** `queue_state.config.daily_budget_usd`, compared with this project's `ai_invocations` spend since local midnight.
- **App-wide budget:** `desktop_daily_budget_usd`, compared with completed `jobs` cost since UTC midnight, summed across project contexts.

Enforcement runs on terminal job exits and pauses queues. Loop launches bypass the queue entirely.

## Decisions

1. **One predicate, two uses.** `evaluateDailyBudgets` is a read-only check that shares `isDailyBudgetExceeded` with the enforcer. The project budget is reported first. The app-wide snapshot was extracted to `ProjectRegistry._desktopDailyBudgetSnapshot()`, and both the queue and the gate use it. The gate therefore reads exactly the state the queue enforces.
2. **Bind at composition.** `createDailyBudgetGate({ db, projectId, desktop })` is built per project in the registry. It is exposed as `ProjectContext.dailyBudgetRejection` and passed to `LoopRunManager` as `options.dailyBudget`. Routers and the loop module need no new cross-module imports: the loop module declares the structural `LoopBudgetBreach`.
3. **Single route gate.** Every launch door (dashboard, Launch all, mission card, relaunch, MCP, mobile, milestone chain) reaches the rails launch route. The check sits right after process admission and before relaunch slot restoration, worktree allocation, queue enqueue or `LoopRunManager.run`. The legacy queue path (Loops off) is gated as well, so "spawn nothing" holds for every rail launch.
4. **Reuse the paused lifecycle.** The budget pause uses the in-process `_pausedHumanDecisions` slot, with a `budget` marker, `pauseLoopRun(..., 'budget_paused')` and the existing `loop.run_paused`/`loop.run_resumed` events. A new terminal outcome would have added a parallel lifecycle, so this change adds none. `resumeLoopRun` clears `restart_reason`. On a server restart, existing startup reconciliation applies: a definition run becomes a `restart` pause, and a legacy run is failed.
5. **Resume doors.** `LoopRunManager.resumeBudgetPause` re-checks the budget. While the budget is still exhausted, the run stays paused and the caller gets the same 409 body. The loop-run resume route and the job turn route (`/jobs/:id/messages`, any text) both delegate to it. The resume route also gates ordinary Core resumes, because continuing a workflow spends money.
6. **Core workflows.** Core schedules all graph steps inside one retained process. Core semantics: SIGTERM means `cancelled` (terminal), and SIGKILL needs lease expiry plus `--recover`. So Desktop cannot pause between Core steps without a Core pause verb. The gate applies at launch, at resume, and before each re-invocation after a question or approval (`beforeContinuation` port in `runDefinitionLoop`). Desktop holds the answer while the run is budget-paused.
7. **Fail-open.** If the budget is unreadable (closed DB), the gate admits the launch with a warning. This mirrors the queue's best-effort enforcement.
8. **Deadline.** A budget pause can last until the next day, so the pause duration is added to the legacy run's wall-clock deadline.

## Risks / Trade-offs

- **App-wide spend lags behind.** App-wide spend counts only completed jobs (the queue's figure). A long single loop does not raise it until the loop completes. The project budget counts per-step invocations and trips mid-run.
- **Gate coverage.** The legacy QueueManager rail path is now rejected rather than enqueued behind a paused queue.
