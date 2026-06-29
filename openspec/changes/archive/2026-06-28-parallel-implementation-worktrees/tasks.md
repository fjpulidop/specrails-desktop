## 1. Isolation gate + loop classification — capability `rail-parallel-isolation`

- [ ] 1.1 Add `readOnly?: boolean` to the `LoopTemplate` interface (`server/loop-templates.ts`); mark the provably read-only built-ins (PR watchers, read-only audits/investigations) `readOnly: true`. All other templates + all custom loops default to mutating.
- [x] 1.2 Add a pure `mutatesRepo(graph, opts)` predicate (server) = `!readOnly` (custom loops → true). Unit-test the default-true behaviour.
- [x] 1.3 Add `isolationApplies(rail, loop)` = loops-enabled AND not kill-switched AND per-ticket scope AND `ticketIds.length > 1` AND `mutatesRepo`. Unit-test every branch (N=1, scope=all, read-only, kill-switch → false).
- [x] 1.4 Add the kill-switch `SPECRAILS_RAIL_WORKTREES` (default on; documented off value) read once at startup, mirroring the other loop flags.

## 2. Worktree + overlay lifecycle — capability `rail-parallel-isolation`

- [x] 2.1 New `server/worktree-manager.ts`: `createWorktree(repoDir, slug, ticketId) → { branch, worktreePath }` (`git worktree add` on `sr/<slug>/ticket-<id>` off HEAD); `removeWorktree(...)` (`git worktree remove --force` + branch cleanup when merged/empty); `listWorktrees(slug)`; injected git runner so it is testable without real git.
- [ ] 2.2 Relocated overlay: extend `workspace-manager`/`workspace-resolution` with a per-run overlay — assemble a workspace instance (framework symlinks from `framework/current`, `agent-memory` real dir, `./project` → the worktree) under `~/.specrails/projects/<slug>/run-workspaces/<run-id>/`; return `{ cwd: overlay, repoDir: worktree }`. Legacy mode returns `{ cwd: worktree, repoDir: worktree }`.
- [ ] 2.3 Concurrency cap on simultaneous worktrees (default config); excess tickets queue like existing run concurrency.
- [ ] 2.4 Teardown: remove worktree + overlay on terminal merge state; stop/cancel tears down in-flight; startup sweep removes stale worktrees whose ledger row is terminal.

## 3. Fan-out wiring — capability `rail-parallel-isolation`

- [x] 3.1 `rails-router` launch: when `isolationApplies`, allocate a worktree+overlay per ticket and pass the per-run `{ cwd, repoDir }` into `launchLoopRun` instead of the shared `loopExec`. When it does not apply, keep today's shared-`loopExec` path byte-identical.
- [x] 3.2 `loop-run-manager`: accept the per-run `cwd`/`repoDir` (already threaded as `req.cwd`/`req.repoDir`) — confirm the provenance/git split still points git at `repoDir` (the worktree), not the overlay.
- [x] 3.3 Record a `rail_worktrees` ledger row per (rail launch, ticket) at allocation; update `merge_state` through the lifecycle.

## 4. DB ledger — capability `rail-parallel-isolation`

- [x] 4.1 Additive migration: `rail_worktrees(rail_index, ticket_id, branch, worktree_path, overlay_path, run_id, merge_state, created_at)` in the per-project DB; CRUD helpers; `merge_state` ∈ `building|built|merging|merged|needs-review|failed`.
- [x] 4.2 Reconciliation on startup: terminal rows → ensure their worktrees/overlays are gone; non-terminal rows from a dead process → mark `failed` + sweep.

## 5. Merge-back state machine — capability `loop-merge-back`

- [x] 5.1 New `server/merge-manager.ts`: a sequential merge-back driver with an **injected git runner** + an injected "run verification" hook (mirrors `LoopExecutors`) so the state machine is unit-tested without real git. Holds a process-local per-repo mutex for the duration of one merge+verify step.
- [x] 5.2 Merge ordering: sort successful branches by ascending Contract-Layer touch-list overlap when touch-lists are present; else by ticket id. Pure, unit-tested.
- [x] 5.3 Per branch: `merge --no-ff` → on conflict invoke the resolver hook → re-verify integrated tree → on red rebase+one fix-pass+retry-once → else `needs-review`. Update the ledger `merge_state` at each transition.
- [x] 5.4 Never advance base except via a clean, re-verified merge. Failed/aborted runs are never merged. Unit-test: all-clean, one add-add conflict resolved, unresolvable → needs-review, integrated-red → rebase-fix → green, integrated-red → needs-review.
- [x] 5.5 Kick the merge-back from `rails-router` once the fan-out settles (all runs terminal); broadcast merge-progress WS events.

## 6. AI merge-resolver — capability `loop-merge-resolver`

- [x] 6.1 `loop-constants.ts`: add read-only built-in `{{const:MERGE_SAFE}}` (preserve both sides on additive conflict; never delete either branch's code; no new behaviour; escalate `RESOLVE: needs-review` when unsure). Confirm it is reserved (built-in ⇒ cannot be redefined).
- [x] 6.2 `loop-command-catalog.ts`: add provider-aware `{{cmd:resolve-merge}}` (claude/codex/gemini native + prompt fallback; NOT claude-only). Its expansion injects `{{const:MERGE_SAFE}}` and instructs conflict-markers-only editing.
- [x] 6.3 The merge-manager invokes the resolver with ONLY the conflicted hunks + a one-line branch description; a non-clean result (or `RESOLVE: needs-review`) is treated as needs-review (the resolver only proposes; re-verification accepts). Unit-test the bounded contract.

## 7. WS events + client surfacing — capability `loop-merge-back`

- [x] 7.1 Project-scoped WS events for fan-out + merge-back: `rail.worktree_progress` (built / merging / merged / needs-review per ticket). Reuse `boundBroadcast` (carries `projectId`).
- [x] 7.2 Rail header/launch: render per-ticket fan-out + merge-back state (e.g. "3/5 merged · 1 needs review"); link a `needs-review` ticket to its unmerged branch name.
- [x] 7.3 i18n: new `loops`/`dashboard` keys for the merge states across all 8 locales; key-parity test passes.

## 8. Tests + coverage

- [x] 8.1 Server unit tests: gate predicate, `mutatesRepo` default, worktree-manager (injected git), merge ordering, merge-manager state machine (all transitions), resolver command expansion + `MERGE_SAFE` presence/read-only, ledger CRUD + reconciliation.
- [x] 8.2 Keep server ≥80% lines/functions/statements (70% branches) and client ≥80% lines/statements (70% functions). Merge-manager + worktree-manager use injected runners so no real-git integration is needed for coverage.
- [x] 8.3 `npm run typecheck`, `npm test`, `npm run test:coverage`, `cd client && npm run test:coverage` all green.

## 9. Manual end-to-end validation (the canonical case)

- [ ] 9.1 On the test project, a rail with ≥2 game tickets (each touching its own `src/features/<game>/**` + the shared `src/games/registry.ts`) launched per-ticket on a quota'd provider: confirm N worktrees, parallel build, then sequential merge-back that resolves the `registry.ts` add-add conflict via the resolver and re-verifies green.
- [ ] 9.2 Force an unresolvable conflict → confirm `needs-review` + the branch is left unmerged + the base stays green with the other tickets integrated.
- [ ] 9.3 Kill-switch off → confirm byte-identical legacy shared-cwd behaviour.
