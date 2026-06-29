# Design — parallel-implementation-worktrees

## Context

The rail/loop engine already exists and already runs per-ticket loop runs **concurrently**: `rails-router`'s launch handler does

```
for (const ticketId of rail.ticketIds) launchLoopRun(newId(), [ticketId], spec)   // not awaited → concurrent
```

and every run spawns its AI CLI from the **same** `loopExec.cwd` (the workspace when relocated, else the repo). So the concurrency is real but **unsafe** — N agents editing one working tree. `specrails-core`'s implement pipeline already uses git worktrees *within* a feature (developer agents → merge → reviewer), and `batch-implement` already computes dependency waves but runs them sequentially. The building blocks (worktrees, dependency awareness, the Contract-Layer "file touch list") exist; the gap is **parallel execution across specs with a safe integration step**, owned by the desktop engine.

This change adds isolation + merge-back to that existing concurrency. It is engine-level and provider-agnostic: it only changes which `cwd` / `SPECRAILS_REPO_DIR` a run spawns with, and adds git plumbing around the fan-out. The `ProviderAdapter` contract is untouched.

## Goals / Non-goals

**Goals**
- Let a rail implement N specs **truly in parallel**, each in its own git worktree, then integrate them back into the repo green.
- Be **ambitious**: isolate *every* repo-mutating loop by default (not an opt-in for one mode), and *handle* overlapping edits via an AI merge-resolver rather than bailing to sequential.
- Keep integration **correct**: re-verify the combined tree after each merge; never silently drop a branch's work.
- Stay **reversible** (one kill-switch) and **byte-identical** for the single-writer cases (N=1, `scope: all`, standalone, read-only loops).

**Non-goals**
- No worktree for single-writer runs in v1 (the "review before merge" benefit of worktree-per-single-run is a separate future feature).
- No dependency *planning* pass that predicts file sets by static analysis — we use the Contract-Layer touch-list when present, otherwise we let conflicts surface and resolve them.
- No change to `specrails-core`; no new node types; no change to the loop graph model.
- No cross-rail parallelism coordination — isolation is per rail launch.

## The hard truth that shapes everything: shared files are unavoidable

"Independent" specs still touch shared files. The canonical case, straight from the test project's own specs:

```
pacman    → src/features/pacman/**     (disjoint)  +  src/games/registry.ts: + "pacman: …"     ← SHARED
asteroids → src/features/asteroids/**  (disjoint)  +  src/games/registry.ts: + "asteroids: …"  ← SHARED
```

Disjoint feature logic, one shared registry line each. So:

- We **cannot** gate parallelism on "fully disjoint" — almost nothing is fully disjoint.
- The conflicts that arise are overwhelmingly **trivial add-add** (two new lines at the same insertion point). A bounded AI resolver handles these reliably.
- Therefore the **merge-resolver is load-bearing**, and a **post-merge re-verification** is mandatory (two specs may each pass alone yet assume incompatible shared state).

## Decision 1 — The isolation gate (`mutatesRepo` + N>1 per-ticket)

Isolation is applied when ALL hold:

1. `isLoopsEnabled()` and the global kill-switch is not set.
2. The rail launch is **per-ticket scope** with **> 1 ticket** (the only case with concurrent writers; `scope: all` is one run, single-ticket is one run).
3. The chosen loop **mutates the repo**.

`mutatesRepo(loop)` is **default true** — ambitious. A loop is non-mutating only when its template carries `readOnly: true` (PR watchers, read-only audits/investigations that never Write/Edit and run no writing shell). Custom user loops default to mutating (safe). This is deliberately conservative-toward-isolation: a false "mutating" only costs a worktree; a false "read-only" would corrupt the shared tree.

> Rationale for the gate rather than "always worktree": a single writer (N=1, scope=all, standalone) has nothing to collide with, so a worktree adds setup cost + a merge step for zero safety gain in v1. The gate keeps the blast radius on exactly the case that needs it.

## Decision 2 — Worktree layout, per execution mode

One branch + worktree per ticket run: branch `sr/<slug>/ticket-<id>`, created off the repo's current `HEAD`.

**Legacy (non-relocated)** — simple:
```
git worktree add <worktrees>/ticket-<id>  sr/<slug>/ticket-<id>
spawn loop run with cwd = <worktrees>/ticket-<id>
```

**Relocated** — the thorny case. The spawn cwd must be a *workspace* (with `.specrails`, framework symlinks, `.mcp.json`) and git must run on a real repo reached via `SPECRAILS_REPO_DIR`. So each parallel run gets BOTH a repo worktree AND its own workspace overlay pointing at it:
```
worktree:  ~/.specrails/projects/<slug>/worktrees/ticket-<id>/        (git worktree of the real repo)
overlay:   ~/.specrails/projects/<slug>/run-workspaces/<run-id>/      (workspace clone: framework symlinks from framework/current,
                                                                       agent-memory as a real dir, ./project → the worktree)
spawn:     cwd = overlay,  SPECRAILS_REPO_DIR = the worktree
```
The overlay reuses `workspace-manager`'s existing assembly (the same symlink-from-`framework/current` logic) — it is a per-run instance of the workspace, not a copy of the framework. Provenance/git calls (the Code-explorer "touched by AI" attribution) point at the worktree, not the overlay, mirroring the existing repoDir split.

`worktrees/` and `run-workspaces/` are under `$HOME`, never in the repo. Worktrees share the repo's `.git`/object-store (the established `.claude/worktrees/**` carve-out).

## Decision 3 — Merge-back: sequential, mutex'd, validated

After the fan-out settles (all runs reached a terminal outcome), the **merge-manager** integrates branches one at a time, holding a per-repo mutex (git ref updates must not race):

```
order = branches sorted by Contract-Layer touch-list overlap ASC   (else by ticket id)
for branch in order, where the run succeeded:
   git merge --no-ff branch  into base
   if conflict:
       run {{cmd:resolve-merge}}  (AI, conflict hunks only, MERGE_SAFE guardrail)
       if still conflicted        → abort merge, mark ticket needs-review, leave branch
   re-verify INTEGRATED tree (run the loop's verification command on base)
   if red:
       rebase branch on the new base + run one "fix pass" of its loop, then retry once
       if still red               → mark ticket needs-review, leave branch
   else: keep the merge, git worktree remove + overlay teardown
```

Failed/aborted runs are never merged (their branch is kept for inspection, or discarded if empty). The base repo is only ever advanced by clean, re-verified merges — so a partial failure leaves the repo green with the successful tickets integrated and the rest flagged.

**Why sequential, not a parallel octopus merge?** Re-verification must run on a settled tree, and conflict resolution needs a stable "theirs". Sequential keeps each integration individually validated and attributable. Wall-clock cost is the merge+verify chain, not the implementation (which already ran in parallel) — the expensive part stays parallel.

**Ordering by touch-list** (Decision 5) minimises the number of conflicting merges; it is an optimisation, never a gate.

## Decision 4 — The AI merge-resolver (`{{cmd:resolve-merge}}` + `{{const:MERGE_SAFE}}`)

The resolver is the load-bearing primitive of the ambitious approach. Contract:

- Input: ONLY the conflicted files/hunks (with conflict markers) and a one-line description of the two branches. NOT the whole spec, NOT free rein over the repo.
- `{{const:MERGE_SAFE}}` (read-only built-in) carries the guardrail: *preserve BOTH sides for additive conflicts; never delete either branch's code to "resolve"; do not introduce new behaviour; if the correct resolution is not obvious, leave it conflicted and report `RESOLVE: needs-review`.*
- Provider-aware like other commands: claude/codex/gemini get the native invocation; a prompt fallback otherwise. It is NOT claude-only.
- Bounded: one focused turn; on no clean resolution it must escalate, never guess.
- The merge-manager treats a non-clean resolver result as `needs-review` — the resolver can only ever *propose*; the re-verification (Decision 3) is what actually accepts the result.

This makes add-add registry/barrel/`package.json` conflicts (the 90% case) cheap and safe, while genuine semantic conflicts fall to the human rather than to a hallucinated merge.

## Decision 5 — Merge ordering from the Contract Layer (best-effort)

When the spec's Contract Layer is populated it lists a **file touch list**. The merge-manager uses it to order merges by ascending pairwise overlap (merge the least-overlapping branches first, so the most-conflicting one rebases onto the most-complete base last). When touch-lists are absent or unreliable, order by ticket id. This is purely an optimisation of *how many* conflicts the resolver sees; correctness does not depend on it. (We do NOT use touch-lists to *gate* parallelism — per the ambitious decision, everything parallelises and conflicts are resolved, not avoided.)

## Decision 6 — Lifecycle, crash-safety, cleanup

- A `rail_worktrees` ledger row per (rail launch, ticket) records `branch`, `worktree_path`, `overlay_path`, `run_id`, and `merge_state` (`building | built | merging | merged | needs-review | failed`). This lets a restarted server reconcile orphaned worktrees and lets the UI render state.
- Concurrency cap on simultaneous worktrees (default e.g. 6) — excess tickets queue, exactly like the existing run concurrency.
- Teardown: `git worktree remove --force` + overlay rm on merge/empty; a startup sweep removes stale worktrees whose ledger row is terminal; stop/cancel tears down in-flight worktrees.
- The base-repo mutex is process-local (single server owns the repo) and only held during a single merge+verify step, so the fan-out is never blocked by it.

## Decision 7 — Kill-switch + safety defaults

`SPECRAILS_RAIL_WORKTREES=0` (or unset-default-on with a documented off value, mirroring the other loop flags) disables isolation globally → every run uses today's shared `loopExec.cwd`. With isolation off the merge-manager never runs. This is the single reversal point and the emergency rollback.

## Risks / trade-offs

- **Resolver quality is now critical.** Mitigation: conflict-hunks-only input, `MERGE_SAFE` anti-delete guardrail, re-verify gate, and escalate-not-guess. The resolver can never advance the base on its own.
- **Relocated overlay cost.** N overlays per launch (framework symlinks are cheap; the cost is dir setup + the worktree checkout). Mitigation: concurrency cap, aggressive teardown, and reuse of `workspace-manager` assembly. Must be measured.
- **`.git` contention.** Worktrees share the object-store; concurrent commits are fine, but ref updates during merge-back are serialised by the mutex.
- **Combined-state breakage.** Two specs pass alone, break together. Mitigation: integrated re-verification after every merge is the explicit safety net; the rebase-and-fix pass gives one automatic recovery before `needs-review`.
- **Disk.** N worktrees = N repo checkouts. Mitigation: cap + teardown; document the disk expectation.

## Migration / rollout

Additive DB migration (`rail_worktrees`). Default behaviour for existing flows (N=1 / scope=all / standalone / read-only) is unchanged. Ship behind the kill-switch on; first validate on the test project with the game specs (the canonical shared-`registry.ts` conflict) before wider use.

## Open questions (to resolve during implementation, not blockers)

- Exact concurrency-cap default for worktrees vs the existing run cap.
- Whether the integrated re-verification re-uses the loop's own verify step or a rail-level "run the project test command once".
- Whether `needs-review` branches surface as a PR/affordance or just a flagged ticket + named branch in v1 (lean: flagged ticket + branch).
