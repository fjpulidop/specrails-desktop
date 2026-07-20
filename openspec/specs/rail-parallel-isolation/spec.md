# rail-parallel-isolation Specification

## Purpose
TBD - created by archiving change parallel-implementation-worktrees. Update Purpose after archive.
## Requirements
### Requirement: Repo-mutation classification

Every loop SHALL be classified as repo-mutating or read-only. A loop SHALL be treated as **repo-mutating by default**; it is read-only ONLY when its template explicitly declares `readOnly: true`. Custom (user-authored) loops SHALL always be treated as repo-mutating. The classification SHALL be a pure function of the loop definition.

#### Scenario: Unmarked loop is treated as mutating

- **WHEN** a loop has no `readOnly` flag (or `readOnly: false`)
- **THEN** the engine SHALL classify it as repo-mutating

#### Scenario: Read-only built-in opts out

- **WHEN** a built-in loop declares `readOnly: true` and contains no step that writes the repo
- **THEN** the engine SHALL classify it as read-only

#### Scenario: Custom loops default to mutating

- **WHEN** a custom user loop is classified
- **THEN** the engine SHALL treat it as repo-mutating regardless of its steps

### Requirement: Isolation gate

The engine SHALL execute a rail launch's loop runs in isolated git worktrees ONLY WHEN all of the following hold: Loops are enabled, the worktree kill-switch is not set, the launch is per-ticket scope, the rail has more than one ticket, and the loop is repo-mutating. In every other case the launch SHALL use the existing single shared spawn `cwd` (today's behaviour) and the merge-back SHALL NOT run.

#### Scenario: Multi-ticket mutating per-ticket rail is isolated

- **WHEN** a per-ticket rail with two or more tickets launches a repo-mutating loop and the kill-switch is off
- **THEN** each ticket's loop run SHALL execute in its own git worktree on a dedicated branch

#### Scenario: Single-ticket rail is not isolated

- **WHEN** a rail with exactly one ticket launches any loop
- **THEN** the run SHALL use the shared spawn `cwd` and no worktree SHALL be created

#### Scenario: scope=all is not isolated

- **WHEN** a rail launches in `all` scope (one run over all tickets)
- **THEN** the run SHALL use the shared spawn `cwd` and no worktree SHALL be created

#### Scenario: Read-only loop is not isolated

- **WHEN** a multi-ticket per-ticket rail launches a loop classified read-only
- **THEN** the runs SHALL use the shared spawn `cwd` and no worktree SHALL be created

#### Scenario: Kill-switch forces legacy behaviour

- **WHEN** the worktree kill-switch is set
- **THEN** every loop run SHALL use the shared spawn `cwd` regardless of scope, ticket count, or mutation, and the merge-back SHALL NOT run

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

### Requirement: Per-run worktree overlay (framework surface)

Every isolated run SHALL spawn with `cwd` set directly to the worktree, with `SPECRAILS_REPO_DIR` pointing at that worktree (writes/git land there, never the live repo). Because `git worktree add` materializes only tracked files, the engine SHALL merge-overlay the project's framework surface (provider commands, sr-* agents, skills, rules, settings, `.mcp.json`, the instruction file) INTO the worktree at allocation, sourced from ORDERED source roots: the project's effective artifact root first — the workspace for a relocated project, the repo for a legacy project — and, for a relocated project, the repo's own untracked on-disk entries as a FALLBACK root (so repo-resident carve-outs such as OpenSpec's `/opsx:*` command dirs and `openspec-*` skills reach the worktree exactly as they do for legacy projects). Merging SHALL be via symlinks (whole-entry links where only one root contributes, REAL directories with per-child links where multiple roots contribute children to the same directory, per-entry where the checkout is partially present; junction-then-copy fallback on Windows), with earlier roots winning per entry and checkout content NEVER overwritten. `agent-memory` SHALL be linked so all runs share agent memory (shared-cwd semantics). For a relocated project the workspace artifact indirection env (`SPECRAILS_TICKETS_PATH`, `SPECRAILS_BACKLOG_CONFIG_PATH`, `SPECRAILS_PROFILES_DIR`, `SPECRAILS_STATE_DIR`) SHALL point at the workspace. Overlay-owned paths SHALL be excluded from worktree commits so they never reach the ticket branch/PR; cleanup-evidence authentication SHALL accept a match against any configured source root; overlay failures SHALL degrade (log + `rail.overlay_degraded` event) without aborting the rail. Git/provenance operations SHALL target the worktree.

#### Scenario: Relocated run gets the framework surface in its worktree

- **WHEN** an isolated run is launched for a relocated project
- **THEN** its spawn `cwd` SHALL be the worktree AND the workspace's provider commands/agents/skills/rules SHALL resolve inside the worktree via overlay links AND `SPECRAILS_REPO_DIR` SHALL point at that run's worktree AND the tickets/backlog/profiles env SHALL point at the workspace

#### Scenario: Relocated run gets repo-resident untracked provider entries

- **WHEN** an isolated run is launched for a relocated project whose repo carries untracked provider-dir entries absent from the workspace (e.g. `.claude/commands/opsx/*.md` installed by OpenSpec)
- **THEN** those entries SHALL resolve inside the worktree via overlay links sourced from the repo
- **AND** entries present in the workspace SHALL keep sourcing from the workspace (the workspace root wins per entry)
- **AND** a directory to which both roots contribute children (e.g. `commands/` with workspace `specrails/` and repo `opsx/`) SHALL be materialized as a real directory containing per-child links to each contributing root

#### Scenario: Resumed worktree upgrades a prior whole-dir link

- **WHEN** the overlay re-runs on a worktree whose prior pass created a whole-dir link for an entry that a fallback root now also contributes children to
- **THEN** the overlay SHALL replace its own prior link with a real directory of per-child links covering both roots
- **AND** a symlink the overlay did not create SHALL never be replaced

#### Scenario: Legacy run spawns in the worktree

- **WHEN** an isolated run is launched for a non-relocated project
- **THEN** its spawn `cwd` SHALL be the worktree directory AND the repo's untracked on-disk provider-dir entries SHALL be overlaid without touching tracked checkout content

#### Scenario: Overlay scaffolding never lands on the branch

- **WHEN** an isolated run's work is committed to its branch
- **THEN** overlay-owned paths (links, copies, the overlay manifest) SHALL be excluded from the commit, including per-child links inside a merged real directory

#### Scenario: Overlay failure degrades instead of aborting

- **WHEN** the overlay cannot materialize one or more entries
- **THEN** the run SHALL still spawn AND the failure SHALL be surfaced via a `rail.overlay_degraded` event

#### Scenario: Provenance targets the worktree

- **WHEN** an isolated relocated run records file provenance or runs git
- **THEN** those operations SHALL target the worktree (the real repo), never the workspace

#### Scenario: Private agent artifacts never reach PR branches

- **WHEN** an isolated rail worktree is created or reused
- **THEN** the worktree-local Git excludes SHALL ignore provider `agent-memory` directories and their `explanations` subdirectories
- **AND** Specrails' final worktree commit SHALL also exclude those paths with Git pathspec excludes
- **AND** `.claude/agent-memory`, `.codex/agent-memory`, `.gemini/agent-memory`, and their `explanations` contents SHALL NOT be staged by Specrails for PR branches

### Requirement: Worktree concurrency cap and teardown

The number of simultaneous worktrees per rail launch SHALL be bounded by a configured cap; tickets beyond the cap SHALL queue. Each worktree SHALL be removed when its branch reaches a terminal merge state (merged or empty), when the rail is stopped or cancelled, and a startup sweep SHALL remove worktrees whose ledger row is terminal (overlay artifacts live inside the worktree, so worktree removal covers them; symlinks are removed as entries, never followed). Worktrees SHALL never be orphaned across a server restart.

#### Scenario: Excess tickets queue

- **WHEN** a rail has more tickets than the worktree concurrency cap
- **THEN** the engine SHALL run up to the cap concurrently and queue the rest

#### Scenario: Merged worktree is cleaned up

- **WHEN** a ticket's branch is merged into the base
- **THEN** the engine SHALL remove that ticket's worktree (including its overlay artifacts)

#### Scenario: Stop tears down in-flight worktrees

- **WHEN** the user stops the rail mid-fan-out
- **THEN** the engine SHALL tear down the in-flight worktrees and overlays

#### Scenario: Startup sweep clears stale worktrees

- **WHEN** the server starts and finds ledger rows in a non-terminal state from a prior dead process
- **THEN** it SHALL mark them failed and remove their worktrees and overlays

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

### Requirement: Isolated settlement preserves execution truth

Each isolated unit SHALL settle into separate implementation and delivery results. The implementation result SHALL be derived only from the loop engine's terminal outcome; commit cleanliness, ref verification, and push SHALL govern delivery only. The aggregate SHALL retain every allocated unit, including unexpected rejected promises, and SHALL fail closed without deleting uncertain work.

#### Scenario: Ref moves after a successful run

- **WHEN** a continuation loop succeeds but the worktree HEAD no longer matches the expected PR branch ref at settlement
- **THEN** the unit's implementation SHALL remain successful
- **AND** delivery SHALL be blocked with `branch_verification_failed`
- **AND** no push SHALL occur
- **AND** the worktree/commit SHALL remain recoverable

#### Scenario: Settlement promise rejects unexpectedly

- **WHEN** one unit rejects during post-run settlement
- **THEN** the aggregate SHALL retain an explicit result for that unit
- **AND** SHALL classify its known loop outcome independently from the settlement error
- **AND** SHALL not silently omit the unit from counts or cleanup

#### Scenario: Clean successful partial batch

- **WHEN** one unit succeeds with a verified deliverable branch and another loop unit fails without dirty uncommitted work
- **THEN** the aggregate MAY offer an explicitly partial delivery containing only the successful unit
- **AND** it SHALL preserve the failed unit's logs and outcome

### Requirement: Isolated launch admission is generation-safe

The per-repository allocation lock SHALL revalidate the expected active delivery generation before creating or reusing any worktree. Ticket/worktree ownership SHALL NOT be overwritten by a concurrent launch that did not win admission.

#### Scenario: Stale pre-lock guard

- **WHEN** a request passed its outer guard but another launch created the active generation before it acquired the repository lock
- **THEN** the stale request SHALL fail with a conflict before allocating, claiming, or spawning

### Requirement: Startup worktree reconciliation is non-destructive and serialized

Startup worktree reconciliation SHALL finish under the repository lock before new isolated launches are admitted. It SHALL use delivery/run generation ownership and SHALL preserve a worktree associated with a successful or uncertain unfinished settlement.

#### Scenario: Successful stale run owns dirty worktree

- **WHEN** a stale worktree belongs to a run whose durable engine outcome is success but settlement is incomplete
- **THEN** reconciliation SHALL mark it needs-review and preserve it
- **AND** SHALL not force-remove it

#### Scenario: New launch waits for sweep

- **WHEN** project startup is still reconciling an older worktree path
- **THEN** a new launch SHALL not reuse that path until reconciliation has completed

### Requirement: Explicit PR target resolves before allocation

When a launch carries an explicit target PR, the isolated launch SHALL resolve and verify that target under the same serialized allocation section as branch/worktree allocation, producing one continuation target applied to every ticket in the launch. Validation failure SHALL reject the launch before any delivery generation is created or worktree allocated; it SHALL NOT fall back to a fresh integration-branch allocation. The existing admission guards (`pr_decision_pending`, `tickets_in_flight`, generation safety) SHALL run before target resolution and keep their current semantics.

#### Scenario: Explicit target materializes the PR head as the worktree branch

- **WHEN** a launch with a valid explicit target reaches allocation
- **THEN** the worktree SHALL be created on the PR's head branch pinned to the observed `headRefOid`
- **AND** a multi-ticket launch SHALL collapse to one atomic batch run in that single checkout, exactly as automatic continuations do

#### Scenario: Undecided delivery still blocks an explicit-target relaunch

- **WHEN** the rail slot has an active non-terminal delivery and a new launch names an explicit target PR
- **THEN** the launch SHALL fail 409 `pr_decision_pending` without resolving the target

#### Scenario: Target validation failure allocates nothing

- **WHEN** explicit-target validation fails for any reason
- **THEN** no branch, worktree, overlay, or delivery row SHALL exist afterwards for that launch attempt
