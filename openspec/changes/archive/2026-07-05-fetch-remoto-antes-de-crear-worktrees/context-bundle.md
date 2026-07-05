# Context Bundle: Fetch remoto antes de crear worktrees de rail/loop

## Exact Changes

### Task 1.1 / 1.2 — Add `fetchOrigin` + TTL cache to `server/integration-branch.ts`

Current file header/imports (lines 1-19):

```ts
/**
 * Resolve a project's designated INTEGRATION BRANCH — the branch that
 * repo-mutating loops branch their worktrees from and target their draft PRs at.
 * ...
 */
import type { GitRunner } from './worktree-manager'

export type IntegrationBranchSource = 'explicit' | 'project-setting' | 'repo-default' | 'head-fallback'

export interface ResolvedIntegrationBranch {
  branch: string
  source: IntegrationBranchSource
}
```

Add, immediately after `ResolvedIntegrationBranch` (before `ResolveIntegrationBranchInput`):

```ts
export interface FetchResult {
  ok: boolean
  error?: string
}

/** How long a fetch outcome (success OR failure) is reused for the same repo
 *  before a fresh `git fetch origin` is attempted again. Exists so a burst of
 *  near-simultaneous launches against the SAME repo — e.g. a "Launch all"
 *  batch, which is N independent HTTP requests with no shared server-side
 *  transaction (see design.md Decision 2) — performs one real fetch instead of
 *  one per rail. */
export const FETCH_ORIGIN_TTL_MS = 15_000

const fetchCache = new Map<string, { at: number; result: Promise<FetchResult> }>()

/** Test-only: clear the fetch dedup cache so tests never leak state across
 *  cases (mirrors `__resetRepoLocks` in repo-lock.ts). */
export function __resetFetchOriginCache(): void {
  fetchCache.clear()
}

/**
 * `git fetch origin` against `repoDir` — updates ONLY `refs/remotes/origin/*`,
 * never the checked-out local branch or working tree (Git itself refuses to
 * touch either via a plain fetch). Never throws: any non-zero exit or runner
 * rejection resolves to `{ ok: false, error }` so callers can degrade
 * gracefully instead of failing the launch.
 *
 * De-duped per `repoDir` for `FETCH_ORIGIN_TTL_MS`: a call within the window
 * of the last attempt (success OR failure) for the same repo reuses that
 * outcome instead of spawning a new `git fetch` process. `now` is injectable
 * so tests can control TTL expiry without real timers.
 */
export async function fetchOrigin(
  git: GitRunner,
  repoDir: string,
  now: () => number = Date.now,
): Promise<FetchResult> {
  const cached = fetchCache.get(repoDir)
  const nowMs = now()
  if (cached && nowMs - cached.at < FETCH_ORIGIN_TTL_MS) return cached.result

  const result = (async (): Promise<FetchResult> => {
    try {
      const r = await git.run(['fetch', 'origin'], repoDir)
      if (r.code === 0) return { ok: true }
      return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `exit ${r.code}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })()
  fetchCache.set(repoDir, { at: nowMs, result })
  return result
}
```

**Note on cache correctness under concurrency**: the cache is set synchronously (before the `await`), keyed on the SAME `repoDir` string every launch already passes (`ctx.project.path`, see `rail-isolated-launch.ts:148`) — so two calls issued back-to-back for the same repo (the realistic "Launch all" shape, serialized behind `withRepoLock` — see Decision 2 in design.md for why TTL, not just in-flight, dedup is required) both read the same `Map` entry and share the one `result` promise.

### Task 2.1 — Add `resolveWorktreeBaseRef` to `server/integration-branch.ts`

Add after `resolveIntegrationBranch` (end of file, after line 90):

```ts
export interface WorktreeBaseRefResolution {
  baseRef: string
  usedRemote: boolean
  warning?: string
}

/**
 * Decide the actual `baseRef` a worktree should branch from, given the
 * already-resolved integration branch and whether `fetchOrigin` succeeded.
 *
 * `explicit` is a launch-time override the caller chose on purpose — it is
 * NEVER remote-prefixed and NEVER existence-checked (see proposal.md Out of
 * Scope). Every other source (`repo-default`, `project-setting`,
 * `head-fallback`) uses the fetched remote-tracking ref `origin/<branch>`
 * ONLY when the fetch succeeded AND that remote branch actually exists —
 * guards a `project-setting` branch that was never pushed, which would
 * otherwise turn a working local-only setup into a broken `git worktree add`.
 * Any failure of either check falls back to today's bare local branch name,
 * with a human-readable `warning` the caller can log/broadcast.
 */
export async function resolveWorktreeBaseRef(
  git: GitRunner,
  input: { repoDir: string; integration: ResolvedIntegrationBranch; fetchOk: boolean },
): Promise<WorktreeBaseRefResolution> {
  const { repoDir, integration, fetchOk } = input
  if (integration.source === 'explicit') {
    return { baseRef: integration.branch, usedRemote: false }
  }
  if (!fetchOk) {
    return { baseRef: integration.branch, usedRemote: false, warning: 'git fetch origin failed; using local ref' }
  }
  const exists = await git.run(
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${integration.branch}`],
    repoDir,
  )
  if (exists.code === 0) {
    return { baseRef: `origin/${integration.branch}`, usedRemote: true }
  }
  return {
    baseRef: integration.branch,
    usedRemote: false,
    warning: `origin/${integration.branch} not found; using local ref`,
  }
}
```

### Task 3.1 / 3.2 / 3.3 — Wire into `server/rail-isolated-launch.ts`

**Import line** (currently line 34):

Before:
```ts
import { resolveIntegrationBranch, type ResolvedIntegrationBranch } from './integration-branch'
```

After:
```ts
import { resolveIntegrationBranch, fetchOrigin, resolveWorktreeBaseRef, type ResolvedIntegrationBranch } from './integration-branch'
```

**Inside `withRepoLock`, the integration-branch resolution block** (currently lines 232-239):

Before:
```ts
  await withRepoLock(baseRepo, async () => {
  // Resolve the project's designated integration branch ONCE, and branch every
  // ticket's worktree off it (not the ambient HEAD). Empty setting → auto-resolve
  // (repo default → HEAD fallback). See server/integration-branch.ts.
  integration = await resolveIntegrationBranch(git, {
    repoDir: baseRepo,
    projectSetting: getProjectSettings(ctx.db).integrationBranch,
  })
```

After:
```ts
  await withRepoLock(baseRepo, async () => {
  // Bring the repo's remote-tracking refs up to date BEFORE resolving the
  // integration branch or allocating any worktree — otherwise `git worktree
  // add -b <branch> <path> <bare-name>` resolves against whatever (possibly
  // stale) commit the user's LOCAL branch happens to be at. `fetchOrigin` only
  // ever touches `refs/remotes/origin/*`; it never mutates the checked-out
  // branch/working tree. De-duped per repo for a short TTL so a "Launch all"
  // batch (N independent launch requests for the same repo, serialized by
  // this same withRepoLock) performs one real fetch, not one per rail. A
  // failed fetch (no network / no remote / auth error) never blocks the
  // launch — resolveWorktreeBaseRef below degrades to the local ref.
  const fetchResult = await fetchOrigin(git, baseRepo)

  // Resolve the project's designated integration branch ONCE, and branch every
  // ticket's worktree off it (not the ambient HEAD). Empty setting → auto-resolve
  // (repo default → HEAD fallback). See server/integration-branch.ts.
  integration = await resolveIntegrationBranch(git, {
    repoDir: baseRepo,
    projectSetting: getProjectSettings(ctx.db).integrationBranch,
  })

  // Prefer the freshly-fetched remote-tracking ref (origin/<branch>) over the
  // bare local name for repo-default/project-setting sources — see
  // resolveWorktreeBaseRef for the exact fallback policy. `explicit` is left
  // completely untouched (rare, launch-time-chosen override).
  const worktreeBaseRef = await resolveWorktreeBaseRef(git, {
    repoDir: baseRepo, integration, fetchOk: fetchResult.ok,
  })
  if (worktreeBaseRef.warning) {
    console.warn(`[rail-isolated] ${worktreeBaseRef.warning} (repo ${baseRepo})`)
    try {
      ctx.broadcast({ type: 'rail.fetch_degraded', projectId: ctx.project.id, railIndex, warning: worktreeBaseRef.warning })
    } catch { /* non-fatal, mirrors notifyOverlayDegraded's broadcast guard below */ }
  }
```

**The `create(...)` call inside the `for (const unit of units)` loop** (currently line 276):

Before:
```ts
      const handle = await create(git, { repoDir: baseRepo, worktreesRoot, slug, ticketId: unit.ticketId, baseRef: integration.branch, branch: unitBranchName(unit.ticketId) })
```

After:
```ts
      const handle = await create(git, { repoDir: baseRepo, worktreesRoot, slug, ticketId: unit.ticketId, baseRef: worktreeBaseRef.baseRef, branch: unitBranchName(unit.ticketId) })
```

Everything else in `launchIsolatedRail` (branch naming, overlay, provenance snapshot, ledger creation, the fan-out/merge-back below `withRepoLock`) is **untouched**.

---

## Relevant Existing Code Patterns

### The degraded-but-non-blocking broadcast pattern already in this exact file

`rail-isolated-launch.ts` already has this precedent (lines 213-218) for the overlay — the new `rail.fetch_degraded` broadcast should read like a sibling of it, not a novel pattern:

```ts
const notifyOverlayDegraded = (ticketId: number, warnings: string[]): void => {
  console.error(`[rail-isolated] worktree overlay degraded (ticket ${ticketId}): ${warnings.join('; ')}`)
  try {
    ctx.broadcast({ type: 'rail.overlay_degraded', projectId: ctx.project.id, railIndex, ticketId, warnings })
  } catch { /* non-fatal */ }
}
```

The fetch-degraded warning uses `console.warn` (not `console.error`) since a stale-but-workable fallback is a lesser severity than a missing framework surface — but the broadcast shape/try-catch guard is copied verbatim in spirit.

### `GitRunner` / `GitResult` shapes (from `server/worktree-manager.ts`, lines 18-27)

```ts
export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export interface GitRunner {
  run(args: string[], cwd: string): Promise<GitResult>
}
```

`fetchOrigin` and `resolveWorktreeBaseRef` both take this same injected `git: GitRunner` — no new abstraction, reuse the existing one already imported by `integration-branch.ts` as `import type { GitRunner } from './worktree-manager'`.

### `createWorktree`'s existing `baseRef` handling (`server/worktree-manager.ts`, lines 95-98, 119-122) — confirms NO change needed there

```ts
export async function createWorktree(git: GitRunner, input: CreateWorktreeInput): Promise<WorktreeHandle> {
  const branch = input.branch ?? worktreeBranch(input.slug, input.ticketId)
  const wt = worktreePath(input.worktreesRoot, input.ticketId)
  const base = input.baseRef ?? 'HEAD'
  ...
  const args = hasBranch
    ? ['worktree', 'add', wt, branch]
    : ['worktree', 'add', '-b', branch, wt, base]
```

`base` is used as an opaque string — `origin/develop` flows through exactly like `develop` does today. This is why `worktree-manager.ts` needs **zero code changes**; it is purely a consumer of whatever string `baseRef` it's handed.

### `resolveIntegrationBranch`'s existing test file conventions (`server/integration-branch.test.ts`)

The existing `fakeGit` helper (lines 10-26) only special-cases `symbolic-ref` and `rev-parse --abbrev-ref`; every other args array (which will now include `['fetch', 'origin']` and `['rev-parse', '--verify', '--quiet', ...]`) falls through to `return { code: 0, stdout: '', stderr: '' }` — i.e. **the existing fake already answers "fetch succeeds" and "remote branch exists" by default** for any test that doesn't override it. New tests for `fetchOrigin`/`resolveWorktreeBaseRef` should extend this same `fakeGit` pattern (add an `args[0] === 'fetch'` branch, and an `args[0] === 'rev-parse' && args.includes('--verify')` branch) rather than inventing a new mock shape.

### `server/rail-isolated-launch.test.ts`'s existing fake-git convention (relevant to Task 3.4/3.5)

From the existing test file (lines 71-84):

```ts
it('branches worktrees off the resolved integration branch (repo default)', async () => {
  const { ctx } = fakeCtx()
  const create = vi.fn(async (_g, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
  const git = {
    run: async (args: string[]) =>
      args[0] === 'symbolic-ref'
        ? { code: 0, stdout: 'refs/remotes/origin/develop\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
  }
  const io: IsolatedLaunchIO = { git, create, remove: vi.fn(async () => {}) }

  await launchIsolatedRail(input([1], ctx), io)

  expect(create).toHaveBeenCalledWith(git, expect.objectContaining({ ticketId: 1, baseRef: 'develop' }))
})
```

This `git` fake's catch-all `{ code: 0, ... }` branch means, after this change, BOTH the `fetch` call and the `rev-parse --verify` existence check will succeed too — so `baseRef` in the assertion becomes `'origin/develop'`, not `'develop'` (Task 3.4). This is the **one existing assertion in the whole codebase that this change is expected to intentionally flip** — everywhere else, "no behavior change" holds.

---

## Invariants to Preserve

1. `fetchOrigin` NEVER throws — every failure path (non-zero exit, runner rejection) resolves to `{ ok: false, error }`.
2. `git fetch origin` is the ONLY new git subcommand introduced by this change that touches the network; `rev-parse --verify --quiet refs/remotes/origin/<branch>` is local-only (reads a ref, no network).
3. `resolveIntegrationBranch`'s own return shape and all 6 of its existing tests (`server/integration-branch.test.ts`) stay byte-identical — this change adds new exports alongside it, it does not modify it.
4. `source === 'explicit'` NEVER gets an `origin/` prefix and NEVER pays the `rev-parse --verify` existence-check cost (assert the git call count reflects this — zero extra calls for the explicit path beyond the fetch itself, per Task 2.2c).
5. A failed fetch (any reason) NEVER throws out of `launchIsolatedRail` and NEVER prevents worktree allocation — the launch proceeds with the bare local branch name exactly as it did before this change.
6. The fetch (success or failure) happens ONCE per `launchIsolatedRail` call, not once per unit/ticket — it sits above the `for (const unit of units)` loop, inside `withRepoLock`, exactly like the existing `resolveIntegrationBranch` and `listLocalBranches` calls it sits beside.
7. Two `launchIsolatedRail` calls for the SAME `ctx.project.path` within `FETCH_ORIGIN_TTL_MS` of each other share ONE underlying `git.run(['fetch', 'origin'], ...)` invocation — this is the load-bearing assertion for the "one fetch per batch" acceptance criterion (see design.md Decision 2 for why this is checked at this level rather than via a dedicated batch-API test — there is no such API).
8. `createWorktree` / `server/worktree-manager.ts` receive NO code changes — `baseRef` remains an opaque string parameter.
9. `launchLoopRun` (`server/rails-router.ts:536-592`, the shared-cwd non-isolated fallback) is untouched — it has no `createWorktree` call and therefore no `baseRef`/fetch concern at all.
10. No new HTTP request/response field, no new query param, no client/UI change. The only new observable surface is the `rail.fetch_degraded` WS broadcast (project-scoped, following the existing `rail.overlay_degraded` shape convention) — purely additive, no existing message type is altered.
