## MODIFIED Requirements

### Requirement: Per-ticket worktree allocation

When the isolation gate applies, the engine SHALL create one git worktree per ticket on a conventional branch `<type>/<ref>-<kebab-title>` (where `<ref>` is the ticket's Jira key when Jira-linked — the authoritative `jira_links` row prevailing over the ticket's `jira_key` field — else the local ticket number, and `<type>` derives from the documented labels-then-title heuristic: fix / chore / docs / feat), rooted at the resolved integration branch, and SHALL spawn that ticket's loop run against the worktree. Branch names SHALL pass `isValidBranchName`, SHALL never equal the integration branch, SHALL collision-suffix `-2`, `-3`… (bounded) against existing foreign branches while resuming a branch a prior rail run allocated for the same ticket, and SHALL fall back to the legacy `sr/<slug>/ticket-<id>` on exhaustion. Worktrees SHALL be created under `$HOME` (never inside the repository) and SHALL share the repository's `.git`/object-store.

Before allocating any worktree, the engine SHALL attempt to bring the repo's remote-tracking refs up to date (see the "Fetch origin before worktree allocation" requirement below). When the resolved integration branch's source is `repo-default` or `project-setting` AND the fetch succeeded AND the corresponding remote-tracking branch (`origin/<branch>`) exists, the worktree's base ref SHALL be that remote-tracking ref — never the bare local branch name — so the worktree always starts from the up-to-date remote commit rather than whatever (possibly stale) commit the user's local branch happens to be at. When the branch source is `explicit`, or the fetch failed, or no matching remote-tracking branch exists, the worktree's base ref SHALL be the bare branch name exactly as resolved today (legacy-identical fallback).

#### Scenario: One branch + worktree per ticket

- **WHEN** isolation applies to a rail with tickets #1 ("Add dark mode") and #2 (Jira-linked as `SKILLS-9`, "Fix crash")
- **THEN** the engine SHALL create branches `feat/1-add-dark-mode` and `fix/SKILLS-9-fix-crash`, each with its own worktree, each rooted at the resolved integration branch at launch time

#### Scenario: Worktrees live outside the repo

- **WHEN** worktrees are created
- **THEN** they SHALL be located under the per-project `$HOME` area and SHALL NOT appear inside the user's repository working tree

#### Scenario: Repo-default branch roots off the fetched remote ref

- **WHEN** the integration branch resolves via `repo-default` (or `project-setting`) to `main`, and `git fetch origin` succeeds, and `origin/main` exists
- **THEN** every ticket's worktree in that launch SHALL be created with `origin/main` as its base ref, not the local `main`

#### Scenario: Explicit branch source is never remote-prefixed

- **WHEN** the integration branch resolves via `explicit` to some branch name
- **THEN** the worktree's base ref SHALL be that bare name exactly as resolved, with no fetch-driven prefixing or remote-existence check applied to it

## ADDED Requirements

### Requirement: Fetch origin before worktree allocation

Before resolving the base ref for a rail or loop launch's worktree allocation, the engine SHALL attempt a `git fetch origin` against the project's repository. This fetch SHALL only ever update the repo's remote-tracking refs (`refs/remotes/origin/*`) — it SHALL NOT fast-forward, check out, or otherwise mutate the user's currently checked-out local branch or working tree. The fetch SHALL run inside the same per-repo `withRepoLock` critical section that already guards integration-branch resolution and worktree allocation, and SHALL apply identically to every launch surface that funnels through the shared isolated-launch path (rail launches in `implement`/`batch-implement` mode and loop launches — both factory and custom loops), since all of them create worktrees through the same code path.

A failed fetch (no network, no configured `origin` remote, authentication failure, or any other non-zero exit) SHALL NOT block or fail the launch: the launch SHALL proceed using the pre-existing local-ref-based resolution, and the degradation SHALL be logged and surfaced (server log plus a project-scoped WebSocket event), following the same non-blocking degradation pattern already used elsewhere in this capability (e.g. worktree-overlay degradation).

When multiple rail launches for the same repository are issued in a short window — in particular a "Launch all" batch, whether driven by the dashboard's client-side fan-out or the MCP `launch_all` tool's server-side fan-out, both of which invoke the single-rail launch path once per rail with no shared server-side batch transaction — the engine SHALL perform at most one real `git fetch origin` process for that repository within the batch's time window; subsequent launches within the window SHALL reuse the same (successful or failed) fetch outcome instead of spawning a redundant `git fetch` process each.

#### Scenario: Fetch succeeds — worktree roots off the remote ref

- **WHEN** a rail launch triggers worktree allocation and `git fetch origin` exits zero
- **THEN** the engine SHALL resolve the worktree's base ref using the freshly-fetched `origin/<branch>` (for `repo-default`/`project-setting` sources)

#### Scenario: No network — launch still proceeds

- **WHEN** `git fetch origin` fails because the machine has no network connectivity
- **THEN** the launch SHALL proceed using the local branch ref as the worktree's base, and a warning SHALL be logged and broadcast, and the launch SHALL NOT be blocked or fail because of the fetch failure

#### Scenario: No configured remote — launch still proceeds

- **WHEN** the repository has no `origin` remote configured and `git fetch origin` fails for that reason
- **THEN** the launch SHALL proceed using the local branch ref as the worktree's base, exactly as it did before this change, with a warning logged and broadcast

#### Scenario: Authentication failure — launch still proceeds

- **WHEN** `git fetch origin` fails due to an authentication/authorization error against the remote
- **THEN** the launch SHALL proceed using the local branch ref as the worktree's base, with a warning logged and broadcast

#### Scenario: The user's checked-out branch and working tree are never touched

- **WHEN** `git fetch origin` runs as part of any launch, regardless of outcome
- **THEN** the repository's currently checked-out local branch and working tree SHALL remain byte-identical to their state before the fetch — only `refs/remotes/origin/*` may change

#### Scenario: Launch-all batch performs exactly one fetch

- **WHEN** the user (or an MCP client) triggers "Launch all" for a project with several eligible rails on the same repository, and the resulting per-rail launch requests arrive within the same short time window
- **THEN** the engine SHALL execute exactly one `git fetch origin` process for that repository across the whole batch, and every rail in the batch SHALL resolve its base ref using that single fetch's outcome

#### Scenario: Loop launches share the same fetch-before-worktree behavior

- **WHEN** a rail launch is a custom loop (not `implement`/`batch-implement`) that qualifies for worktree isolation
- **THEN** it SHALL go through the identical fetch-before-worktree-allocation behavior, with no difference in fetch, fallback, or dedup semantics versus an `implement`/`batch-implement` rail launch
