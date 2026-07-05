## Why

`resolveIntegrationBranch()` (`server/integration-branch.ts`) resolves the integration branch to a bare local name (e.g. `main`, via `origin/HEAD` or the per-project setting), and `launchIsolatedRail()` (`server/rail-isolated-launch.ts:276`) passes that bare name straight to `createWorktree()` as `baseRef`, which runs `git worktree add -b <branch> <path> <baseRef>`. Git resolves a bare name to the **local** ref (`refs/heads/main`), never the remote-tracking one — and nowhere in the launch path does a `git fetch` ever run. If the user's local branch is behind `origin/<branch>` (they haven't pulled), every new rail/loop worktree silently branches off a stale commit, producing diffs and draft PRs built on outdated code and setting up avoidable merge conflicts downstream. This is local backlog ticket #2.

## What Changes

- Add a `fetchOrigin()` helper in `server/integration-branch.ts` that runs `git fetch origin` against the project's repo, non-blocking on failure (no network / no remote / auth error), with a short per-repo TTL cache so a burst of near-simultaneous launches against the same repo (a "Launch all" fan-out) shares one real `git fetch` process instead of firing one per rail.
- Resolve the worktree's `baseRef` as the **remote-tracking ref** `origin/<branch>` (not the bare local name) whenever the branch source is `repo-default` or `project-setting` AND the fetch succeeded AND that remote branch actually exists after the fetch. Falls back to today's bare local ref — logged and broadcast as a non-blocking degradation — when the fetch fails, no `origin` remote exists, or the remote branch isn't found.
- Wire this into the single launch path both rail-launch surfaces already share: `POST /:railIndex/launch` → `launchIsolatedRail()` (`server/rail-isolated-launch.ts`), inside the existing `withRepoLock(baseRepo, …)` critical section, before `createWorktree()` is called.
- The `explicit` branch-resolution source (rare, launch-time override) is left completely untouched — no `origin/` prefix, no existence check, no behavior change.
- No new API surface, no new toggle/UI: the fetch is always-on and transparent, matching the ticket's explicit out-of-scope constraint.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `rail-parallel-isolation`: the "Per-ticket worktree allocation" requirement changes from "rooted at the resolved integration branch" (a bare local ref, possibly stale) to "rooted at a freshly-fetched remote-tracking ref when available, falling back to the local ref on fetch failure" — plus a new sub-requirement on the fetch-before-worktree-creation behavior itself (dedup, graceful degradation, batch behavior).

## Impact

- **Affected code**: `server/integration-branch.ts` (new `fetchOrigin`, new `resolveWorktreeBaseRef` composition helper), `server/rail-isolated-launch.ts` (~line 236-276, invoke fetch + use the resolved remote-aware `baseRef`), `server/worktree-manager.ts` (no logic change — `createWorktree` already accepts any string `baseRef`).
- **Affected call sites**: both rail-launch surfaces that go through `launchIsolatedRail()` — the single-rail `POST /:railIndex/launch` route (`server/rails-router.ts:515`), which is itself fanned out N-times-in-parallel by BOTH "Launch all" surfaces (the dashboard's client-side `Promise.allSettled` loop in `DashboardPage.tsx`, and the MCP `specrails_rails` tool's `launch_all` server-side loop in `server/mcp/tools/rails.ts`). Neither "batch" surface is a single server-side transaction — there is no shared code path across the N HTTP requests other than the target route itself — which is why the fetch-dedup must live inside the launch path (time-windowed cache keyed by repo path), not behind a new batch API.
- **No changes** to `worktree-manager.ts`'s `createWorktree()` signature or behavior, to the `explicit` resolution branch, to any client/UI code, or to the loop-launch shared-cwd fallback path (`launchLoopRun` in `rails-router.ts`, which never creates a worktree and is therefore out of scope).
- **Tests**: `server/integration-branch.test.ts` gets new coverage for `fetchOrigin` (success, failure, dedup/TTL) and the new base-ref composition helper; `server/rail-isolated-launch.test.ts` gets an existing assertion updated (`baseRef` changes from the bare branch name to `origin/<branch>` once fetch succeeds in the test's fake git) plus new fetch-failure-fallback and explicit-untouched coverage.
