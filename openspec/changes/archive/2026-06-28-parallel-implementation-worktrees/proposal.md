## Why

Specrails is exceptional at **producing** specs but weak at **implementing many of them at once**. Today a rail with N tickets in per-ticket scope already fires N loop runs concurrently (`rails-router` launches each `launchLoopRun(...)` without `await`), but **they all share one spawn `cwd`** (the workspace / repo). Concurrent AI CLIs editing the same working tree race and corrupt each other — so in practice users run implementation **sequentially** (one ticket, then the next), and `batch-implement` likewise sequences internally. The result: building ten games (or ten features) takes ten times as long as building one, even though their code lives in disjoint directories.

The missing capability is not "run in parallel" — that already happens — it is **isolation + integration**: give each concurrent run its own git worktree so it can build safely, then **merge every branch back** into the repo with the work integrated and still green.

The honest hard part is the **merge**, not the worktree. "Independent" specs are a myth in practice: every game spec in the test project declares *"a single entry in `src/games/registry.ts` is the only non-feature change"* — so N parallel game specs each append one line to the **same** `registry.ts` and conflict by construction. Going ambitious (isolate **every** repo-mutating loop and parallelise maximally) therefore makes an **AI merge-resolver load-bearing**, not a fallback: most conflicts are trivial add-add (two new lines in a registry / barrel / `package.json`) that an agent resolves in seconds, and a post-merge **re-verification** of the integrated tree is the safety net that catches "each spec passed alone but the combination broke".

## What Changes

- **Worktree isolation for repo-mutating loops (default on).** When a rail launches a loop that mutates the repo in per-ticket scope with **more than one** ticket, each ticket's loop run executes in its **own git worktree** on a dedicated branch (`sr/<slug>/ticket-<id>`) instead of the shared repo/workspace. A loop is treated as repo-mutating unless explicitly flagged read-only (`readOnly: true`) — so the ambitious default is "isolate anything that could write," with a small opt-out for provably read-only loops (PR watchers, read-only audits). Single-ticket rails, `scope: all` (one run), and standalone Loops-page runs keep today's single-writer behaviour (no worktree).
- **Sequential, validated merge-back.** After the fan-out, the engine merges each successful branch into the base **one at a time under a repo mutex**: `merge` → on conflict invoke the AI merge-resolver → **re-verify the integrated tree** (run the loop's verification against the combined result) → on red or unresolvable conflict, rebase-and-fix the offending branch or mark its ticket `needs-review` and leave the branch unmerged for the human. Merge order is by Contract-Layer touch-list overlap (least-overlapping first) when available, else by ticket id.
- **AI merge-resolver — a new load-bearing primitive.** A provider-aware `{{cmd:resolve-merge}}` magic command plus a read-only `{{const:MERGE_SAFE}}` guardrail constant. The resolver is given ONLY the conflicted hunks and must preserve both sides for additive conflicts, never delete either side's code, and escalate to `needs-review` when unsure. It is bounded (one focused turn) and never edits beyond the conflict markers.
- **Relocated-aware worktree model.** For relocated projects (spawn `cwd` = `~/.specrails/projects/<slug>/workspace`, git on the real repo via `SPECRAILS_REPO_DIR`), each parallel run gets a **worktree of the real repo** under `~/.specrails/projects/<slug>/worktrees/ticket-<id>/` **plus a per-run workspace overlay** whose `./project` symlink and `SPECRAILS_REPO_DIR` point at that worktree (framework subtrees symlinked from `framework/current` as usual). Legacy (non-relocated) projects simply spawn with `cwd` = the worktree.
- **Lifecycle + cleanup.** A concurrency cap on simultaneous worktrees; `git worktree remove` (and overlay teardown) when a branch is merged or empty; crash/stop teardown so worktrees are never orphaned; WS progress events for fan-out and merge-back so the rail UI can show "3/5 merged, 1 needs review".
- **Global kill-switch.** A single env flag disables isolation entirely (every loop falls back to today's shared-cwd behaviour), so the feature is reversible in one setting.

Not breaking: default-off projects (single-ticket rails, `scope: all`, standalone runs, read-only loops) behave byte-identically. The change is provider-agnostic (engine-level — it only manipulates spawn `cwd` / `SPECRAILS_REPO_DIR` and git plumbing; the `ProviderAdapter` is untouched). `specrails-core` is not modified; worktrees share the repo's `.git`/object-store exactly like the existing `.claude/worktrees/**` carve-out.

## Capabilities

### New Capabilities
- `rail-parallel-isolation`: the gating predicate (`mutatesRepo` default-true + per-ticket scope + N>1), the worktree-per-run fan-out, the relocated worktree+overlay model, the concurrency cap, kill-switch, and teardown.
- `loop-merge-back`: the sequential-under-mutex merge of each branch into base, the integrated re-verification, the rebase-and-fix / `needs-review` escalation, the touch-list-driven merge ordering, and the merge-progress WS events.
- `loop-merge-resolver`: the provider-aware `{{cmd:resolve-merge}}` command, the read-only `{{const:MERGE_SAFE}}` guardrail, and the conflict-only resolution contract.

### Modified Capabilities
<!-- The rails-as-loops / loops-library capabilities are not yet archived into openspec/specs/, so this change expresses its additions as NEW capabilities rather than MODIFIED deltas against an unpublished base. -->

## Impact

- **Server (new)**: `worktree-manager.ts` (create/list/remove worktrees + per-run overlay for relocated), `merge-manager.ts` (the sequential validated merge-back state machine + repo mutex).
- **Server (modified)**: `rails-router.ts` (fan-out gating: decide isolate-vs-shared, allocate worktrees, kick the merge-back after the fan-out settles), `loop-run-manager.ts` (accept a per-run `cwd`/`repoDir` from the worktree instead of the shared `loopExec`), `workspace-resolution.ts` / `workspace-manager.ts` (per-run overlay), `loop-command-catalog.ts` (+`{{cmd:resolve-merge}}`), `loop-constants.ts` (+`MERGE_SAFE`), `loop-templates.ts` (`readOnly?` flag on `LoopTemplate`; mark the read-only built-ins).
- **Server (DB)**: a per-rail-launch worktree/merge ledger — a new table (e.g. `rail_worktrees(rail_index, ticket_id, branch, worktree_path, run_id, merge_state)`) so the engine can resume/clean up after a crash and the UI can render merge state. Additive migration.
- **Client (modified)**: rail header/launch shows per-ticket fan-out + merge-back progress (merged / needs-review / conflict); a "Parallel (isolated)" affordance is implicit (auto when N>1 + mutating loop). New WS events surfaced.
- **i18n**: new `loops`/`dashboard` keys for merge-back states (merged / resolving / needs-review) across all 8 locales; key-parity test must pass.
- **specrails-core**: ZERO coupling — worktrees use the repo's own `.git`; the carve-out contract (`.claude/worktrees/**` shares the object-store for merge-back) is honoured.
- **Coverage**: the gating predicate, merge ordering, merge-state machine transitions, and resolver-command expansion are pure/injectable and unit-tested to keep server ≥80%; merge-manager uses an injected git runner (like `LoopExecutors`) so the state machine is tested without real git.
