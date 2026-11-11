## Why

After a mission creates a pull request nothing watches it: a red CI or a conflict with the base branch waits for the person to notice, diagnose and push a fix by hand. Specrails already knows how to implement, verify and continue a PR branch; it can offer to keep the PR green on its own.

## What Changes

- An optional mission card after Create PR: **"Watch and fix the CI of PR #N"** with **Start** and **Not now**. It never starts by itself, rings no bell and adds no attention dot; "Not now" is persisted per delivery generation.
- A new built-in loop `factory:pr-ci` (Desktop data, executed by Core): wait for the PR's CI, fix failing checks, resolve merge conflicts by merging the base into the PR branch, verify locally and push to the same PR until it is green. 100% autonomous: no approval, question, gate or blocked-sentinel prompt; a blocker ends the run with a clear reason.
- Host adapters for Core's new `host-task` machine interrupt (paired Core change `pr-ci-loop`, capability `hostTasks`, contract 5.11): a generic dispatcher in `agent-runtime` (persisted dispatches, restart re-dispatch, cancellation) and the PR handlers `pr.update-base`, `pr.sync`, `pr.checks`, `pr.rerun-failed` in `delivery`.
- Launch route `POST /rails/:railIndex/pr-ci` over the existing PR continuation (new generation on the PR branch, previous one superseded, atomic rollback), with the delivery's frozen engine/model/profile; `POST /rails/pr-ci-offer/dismiss`; `GET /rails/pr-ci-availability`.
- A secondary **Fix CI** action on the mission PR card and the dashboard rail strip; plain-language run strip steps ("Waiting for CI", "Resolving conflicts with the base branch", "Pushing the fix to the PR").
- Never force-push or rebase; only a candidate with a valid local verification is pushed; Specrails never publishes the draft, merges or closes the PR; CI logs are bounded, redacted, untrusted evidence.
- Flags: `SPECRAILS_PR_CI_LOOP` (server, default on), `VITE_FEATURE_PR_CI_CARD` (client, default on). A Core without `hostTasks` hides the feature.

## Capabilities

### New Capabilities
- `pr-ci-loop`: the optional CI offer, the autonomous `factory:pr-ci` loop, its host-task adapters, launch route and mission/dashboard surfaces.

### Modified Capabilities
(none — the continuation, settlement and PR-card requirements are reused unchanged)

## Impact

Server: `server/modules/agent-runtime/runtime/host-task-dispatcher.ts` (new), `agent-runtime-bridge.ts` (`--host-result`), `agent-runtime-controls.ts`; `server/modules/loops/runtime/loop-pr-ci-recipe.ts` (new), `loop-factory.ts`, `loop-graph.ts` (`host-task` in `CORE_NODE_KINDS`), `loop-definition-run.ts`, `loop-run-manager.ts`, `loop-definition.ts`, `loop-effect.ts`, `loop-definition-recovery.ts`; `server/modules/delivery/runtime/pr-ci/*` (new), `rails-router.ts`, `rail-isolated-launch.ts`, `domain/decision-policy.ts`; `server/worktree-manager.ts` (merge commits, base OpenSpec changes); `server/project-registry.ts`, `server/project-router-loop-runs.ts` (restart re-dispatch); migration 88 (`host_task_dispatches`); vendored workflow schema. Client: `AgentPrCiOfferCard`, `AgentConversationView`, `AgentChatContext`, `AgentRunStrip`, `AgentPrDecisionCard`, `RailPrDecisionStrip`, `features/delivery/lib/pr-ci.ts`, i18n ×8. Paired Core change `pr-ci-loop` (specrails-core 5.11).
