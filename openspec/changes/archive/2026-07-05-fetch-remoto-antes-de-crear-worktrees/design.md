## Context

`server/integration-branch.ts` resolves the integration branch as a bare local name (`resolveIntegrationBranch()`, precedence `explicit` → `project-setting` → `repo-default` (via `refs/remotes/origin/HEAD`) → `head-fallback`). `server/rail-isolated-launch.ts` (`launchIsolatedRail`, the single shared entry point for ALL worktree-isolated rail/loop launches) calls it once per launch inside `withRepoLock(baseRepo, …)` (lines 232-326), then passes `integration.branch` straight to `createWorktree()` (`server/worktree-manager.ts`) as `baseRef`, which shells out to `git worktree add -b <branch> <path> <baseRef>` (line 122). Git resolves a bare name against **local** refs (`refs/heads/<branch>`), and there is currently zero `git fetch` anywhere in this path — confirmed by grep across `rail-isolated-launch.ts`, `integration-branch.ts`, `worktree-manager.ts`, and `rails-router.ts`. If the user hasn't pulled, every isolated worktree branches off however far behind their local branch happens to be, with no signal to the user that this happened.

Both "batch" launch surfaces described in `CLAUDE.md` — the dashboard's "Launch all" button (`client/src/pages/DashboardPage.tsx`, client-side `Promise.allSettled` over N `POST /:railIndex/launch` calls) and the MCP `specrails_rails(launch_all)` tool (`server/mcp/tools/rails.ts`, server-side loop over the SAME N HTTP calls) — are confirmed to be thin fan-outs over the identical single-rail HTTP route (`server/rails-router.ts:314`, `POST /:railIndex/launch`). Neither is a real batch transaction on the server: there is exactly one call site of `launchIsolatedRail` in the whole codebase (`rails-router.ts:515`), invoked once per HTTP request. This matters directly for the "one fetch per batch" acceptance criterion — see Decision 2.

`launchLoopRun` (the shared-cwd fallback closure defined inline in `rails-router.ts:536-592`, used when isolation doesn't apply or fails) never creates a worktree and is therefore untouched by this change.

## Goals / Non-Goals

**Goals:**
- Every worktree created via `launchIsolatedRail` branches off the up-to-date remote commit (`origin/<branch>`) whenever that's resolvable, instead of a possibly-stale local branch ref.
- A fetch failure of any kind degrades gracefully to today's exact behavior — never blocks or fails a launch.
- A burst of near-simultaneous launches against the same repo (a "Launch all" batch) performs at most one real `git fetch origin` process, not one per rail.
- Zero behavior change for the `explicit` branch-resolution source, for `launchLoopRun`'s shared-cwd fallback, and for `createWorktree`'s own signature/logic.
- Zero new API surface, no toggle, no UI change — the fetch is unconditionally on and invisible except for the (already-established) log/broadcast degradation pattern.

**Non-Goals:**
- Fast-forwarding, rebasing, or otherwise mutating the user's checked-out local branch — Git itself refuses this for a checked-out branch, and it's explicitly out of scope per the ticket.
- Changing `resolveIntegrationBranch`'s precedence rules or its `explicit` path.
- A real server-side batch-launch endpoint. The dedup is achieved by caching inside the launch path (Decision 2), not by adding new API surface — the ticket implicitly discourages new UI/API (no toggle).
- Shallow/partial clone handling (explicitly out of scope in the ticket).
- Any change to `launchLoopRun` (the non-isolated shared-cwd loop path) — it never touches worktrees.

## Decisions

### Decision 1 — `fetchOrigin` lives in `integration-branch.ts`, is a separate function from `resolveIntegrationBranch`

`fetchOrigin(git: GitRunner, repoDir: string, opts?): Promise<FetchResult>` (`FetchResult = { ok: boolean; error?: string }`) is added to `server/integration-branch.ts` — same file, same injectable-`GitRunner` pattern as `repoDefaultBranch`/`currentBranch`, so it's unit-testable without a real repo exactly like its neighbors. It runs `git.run(['fetch', 'origin'], repoDir)` and maps a non-zero exit to `{ ok: false, error: <stderr or stdout, trimmed, first line> }`.

It is kept as its own function (not folded into `resolveIntegrationBranch`) because: (a) the Contract Layer drafted for this ticket names it as a standalone function with a fixed signature, (b) `resolveIntegrationBranch`'s existing 6 unit tests all assert its exact return shape (`{ branch, source }`) with no fetch side-effect — folding fetch in would force every existing test to mock a `fetch` git call it doesn't care about, and (c) separating "did the network operation succeed" from "which branch name did we resolve" keeps each function's test matrix small and orthogonal (existing `resolveIntegrationBranch` tests stay green, untouched).

A second, small composition function, `resolveWorktreeBaseRef(git, { repoDir, integration, fetchOk }): Promise<{ baseRef: string; usedRemote: boolean; warning?: string }>`, is added alongside it. It encodes the actual policy: for `source === 'explicit'` → return `{ baseRef: integration.branch, usedRemote: false }` unchanged, no remote check at all. For `repo-default`/`project-setting`/`head-fallback` → when `fetchOk` and `origin/<branch>` exists (`git rev-parse --verify --quiet refs/remotes/origin/<branch>`), return `{ baseRef: `origin/${integration.branch}`, usedRemote: true }`; otherwise return `{ baseRef: integration.branch, usedRemote: false, warning: <reason> }`. This keeps `rail-isolated-launch.ts`'s job to three calls (`fetchOrigin`, `resolveIntegrationBranch`, `resolveWorktreeBaseRef`) instead of inlining branch-existence-check logic into the launch orchestration file.

**Alternative considered**: prefixing `origin/` unconditionally whenever fetch succeeds, with no remote-existence check. Rejected — `project-setting` is a free-text field a user can set to a local-only branch that was never pushed; blindly prefixing would turn a working local-only setup into a broken `git worktree add` call (`origin/<branch>` wouldn't resolve). The existence check is one cheap `rev-parse` and removes that whole failure class.

### Decision 2 — batch dedup is a short TTL cache keyed by repo path, not a new batch API

Because both "Launch all" surfaces are N independent HTTP requests with no shared server-side transaction (see Context), the only place that can see "these N launches are the same batch" is the launch path itself, observing that N calls for the *same repo* arrive close together in time. `fetchOrigin` therefore keeps a module-level cache: `Map<string, { at: number; promise: Promise<FetchResult> }>` keyed by the resolved repo path. A call within `FETCH_ORIGIN_TTL_MS` (default 15000ms — comfortably covers a `MAX_RAILS = 12`-rail batch queued behind `withRepoLock`, where each prior rail's full allocation, not just its fetch, must finish before the next one's `fetchOrigin` call is even reached) of the last completed attempt for that repo reuses the cached `FetchResult` (success or failure) instead of spawning a new `git fetch` process. The cache is injectable/resettable via a test-only export (mirroring `__resetRepoLocks` in `repo-lock.ts`) so tests don't leak state across cases.

Caching **failures** too (not just successes) is deliberate: a batch launched with no network would otherwise pay N sequential fetch timeouts (each `withRepoLock` turn re-attempting and re-failing) instead of failing once and reusing that failure for the rest of the batch.

**Why not piggyback `withRepoLock` itself for dedup?** `withRepoLock` only *serializes* access to a key — it doesn't cache the result of `fn`. By the time rail 2's turn in the queue arrives, rail 1's entire critical section (fetch **and** worktree creation) has already completed, so a purely in-flight (no-TTL) dedup would provide zero benefit for anything but two truly concurrent calls — which `withRepoLock` already prevents from existing. A time-windowed cache is required to get real dedup across a serialized queue of near-simultaneous requests.

**Alternative considered**: adding a genuine `POST /rails/launch-all` server endpoint that fetches once, then loops. Rejected for this change — it's a much larger surface change (new route, new client wiring, new MCP tool semantics) for a ticket whose explicit scope is "fix the stale-worktree bug," and the existing MCP `launch_all` / dashboard `Promise.allSettled` fan-outs already work correctly aside from this one issue; a TTL cache fixes the acceptance criterion transparently without touching either fan-out's code.

**Trade-off accepted**: a TTL means a launch 15s+ after the last one for the same repo re-fetches (correct, desired) but two launches that are part of the same logical "batch" yet happen to straddle the TTL boundary (e.g. rail 1 is unusually slow to allocate) would trigger a second real fetch. This is harmless — it only means marginally fresher `origin` state, never staler — and is documented here rather than engineered away, since engineering it away requires the batch API rejected above.

### Decision 3 — degradation surfaces via console log + WS broadcast, not a response-shape change

`launchIsolatedRail` currently returns `Promise<string[]>` (run ids) and this change does not alter that signature — extending it to carry a "fetch degraded" flag would ripple into `rails-router.ts`'s response body and the MCP tool's result-shaping logic, which is a bigger blast radius than this fix warrants. Instead, a fetch/remote-branch fallback logs via `console.warn` (mirroring `notifyOverlayDegraded`'s `console.error` pattern in the same file) and broadcasts a new project-scoped WS event, `rail.fetch_degraded` (`{ type, projectId, railIndex, warning }`), following the exact precedent already established by `rail.overlay_degraded` in the same function for the exact same "never abort, always make visible" reasoning. No new client component consumes it in this change (out of scope — this is a backend-only ticket); a future UI surface can subscribe to the event without any further backend change.

### Decision 4 — where the fetch call sits relative to `resolveIntegrationBranch`

`fetchOrigin` runs first, inside the same `withRepoLock` block, immediately before `resolveIntegrationBranch` is called (both currently at `rail-isolated-launch.ts:236`). Fetching first means `repoDefaultBranch()`'s read of `refs/remotes/origin/HEAD` — which fetch can itself update if the remote's default branch changed — sees the freshest possible state, and the subsequent `resolveWorktreeBaseRef` existence check (`origin/<branch>`) is checking against refs that were just updated in the same critical section.

## Risks / Trade-offs

- **[Risk]** A slow/hanging `git fetch` (bad network, slow remote) adds latency to every launch, serialized behind `withRepoLock`, potentially stalling an entire "Launch all" batch queue. → **Mitigation**: `git fetch` inherits no explicit timeout today from `GitRunner`'s `execFile` wrapper; this change does not add one (out of scope — no existing git call in this path has a timeout either, e.g. `git worktree add` itself can also hang). Documented as a pre-existing characteristic of the injectable `GitRunner`, not newly introduced. Flagged as an Open Question below for the reviewer to weigh in on.
- **[Risk]** The TTL cache could theoretically serve a stale (failed) fetch for up to 15s if the user's network genuinely recovers mid-window. → **Mitigation**: worst case is one extra launch falls back to the local ref instead of getting the remote one — never a hard failure, and the very next launch after the TTL expires gets a fresh attempt.
- **[Risk]** Existing test `server/rail-isolated-launch.test.ts` ("branches worktrees off the resolved integration branch (repo default)") currently asserts `baseRef: 'develop'` with a fake `GitRunner` that returns `{code: 0}` for every call — after this change that same fake would make `fetchOrigin` succeed too, so the assertion must become `baseRef: 'origin/develop'` (and the fake needs to also answer the `rev-parse --verify` existence check with `code: 0`). → **Mitigation**: called out explicitly as a task so the developer agent doesn't get a false "regression" reading on an intentionally-changed assertion.
- **[Trade-off]** No dedicated timeout/circuit-breaker for repeated fetch failures across many launches over a long session (only the 15s TTL within one burst). → Accepted: out of scope: same class of concern as the un-timed `git worktree add` calls already in this file.

## Compatibility Notes

No CLI flags, command names, agent names, `{{...}}` placeholders, or `openspec/config.yaml` keys are touched by this change (this repo has no `bin/specrails-core.mjs` / `templates/` surface — that boilerplate belongs to the sibling `specrails-core` repo, confirmed absent here). Surface-level classification:

- **Additive (non-breaking)**: new exports `fetchOrigin`, `resolveWorktreeBaseRef`, `FetchResult`, `WorktreeBaseRefResolution`, `FETCH_ORIGIN_TTL_MS`, `__resetFetchOriginCache` in `server/integration-branch.ts`; new WS event type `rail.fetch_degraded` (no existing message type is altered or removed).
- **Unchanged signatures**: `resolveIntegrationBranch()` and `createWorktree()` keep their exact existing parameter/return shapes — only the runtime *value* one caller (`launchIsolatedRail`) passes for `baseRef` changes.
- **Category 4 — Behavioral Change (ADVISORY)**: worktrees for `repo-default`/`project-setting`-sourced launches now branch off `origin/<branch>` instead of the local `<branch>` whenever a fetch succeeds and that remote branch exists. This is the deliberate fix this change ships; flagged here per the mandatory compatibility-check framework rather than treated as a silent behavior change. No migration action needed — any consumer keyed off "which commit did the worktree branch from" (none identified in this codebase) would see fresher commits, never a regression in git history shape (branch name, worktree location, and PR-flow mechanics are all unaffected).

## Open Questions

- Should `git fetch origin` get an explicit timeout (e.g. via `execFile`'s `timeout` option) as part of this change, given it's the first network-touching git call in this launch path (everything before it was local-only)? Recommendation: yes, a conservative timeout (e.g. 10s) is cheap insurance and directly serves this ticket's own "no network" acceptance scenario, but it's flagged here rather than silently added since it slightly extends scope beyond the ticket's literal ask — reviewer/developer discretion.
- Exact `FETCH_ORIGIN_TTL_MS` value (15000ms proposed) is a judgment call, not derived from a hard constraint — fine to adjust during implementation if test/CI timing suggests otherwise.
