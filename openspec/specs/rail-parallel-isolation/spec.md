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

#### Scenario: One branch + worktree per ticket

- **WHEN** isolation applies to a rail with tickets #1 ("Add dark mode") and #2 (Jira-linked as `SKILLS-9`, "Fix crash")
- **THEN** the engine SHALL create branches `feat/1-add-dark-mode` and `fix/SKILLS-9-fix-crash`, each with its own worktree, each rooted at the resolved integration branch at launch time

#### Scenario: Worktrees live outside the repo

- **WHEN** worktrees are created
- **THEN** they SHALL be located under the per-project `$HOME` area and SHALL NOT appear inside the user's repository working tree

### Requirement: Per-run worktree overlay (framework surface)

Every isolated run SHALL spawn with `cwd` set directly to the worktree, with `SPECRAILS_REPO_DIR` pointing at that worktree (writes/git land there, never the live repo). Because `git worktree add` materializes only tracked files, the engine SHALL merge-overlay the project's framework surface (provider commands, sr-* agents, skills, rules, settings, `.mcp.json`, the instruction file) INTO the worktree at allocation, sourced from the project's effective artifact root — the workspace for a relocated project, the repo's own untracked on-disk entries for a legacy project — via symlinks (dir links where a dir is wholly absent, per-entry where partially present; junction-then-copy fallback on Windows), NEVER overwriting content the checkout brought. `agent-memory` SHALL be linked so all runs share agent memory (shared-cwd semantics). For a relocated project the workspace artifact indirection env (`SPECRAILS_TICKETS_PATH`, `SPECRAILS_BACKLOG_CONFIG_PATH`, `SPECRAILS_PROFILES_DIR`, `SPECRAILS_STATE_DIR`) SHALL point at the workspace. Overlay-owned paths SHALL be excluded from worktree commits so they never reach the ticket branch/PR; overlay failures SHALL degrade (log + `rail.overlay_degraded` event) without aborting the rail. Git/provenance operations SHALL target the worktree.

#### Scenario: Relocated run gets the framework surface in its worktree

- **WHEN** an isolated run is launched for a relocated project
- **THEN** its spawn `cwd` SHALL be the worktree AND the workspace's provider commands/agents/skills/rules SHALL resolve inside the worktree via overlay links AND `SPECRAILS_REPO_DIR` SHALL point at that run's worktree AND the tickets/backlog/profiles env SHALL point at the workspace

#### Scenario: Legacy run spawns in the worktree

- **WHEN** an isolated run is launched for a non-relocated project
- **THEN** its spawn `cwd` SHALL be the worktree directory AND the repo's untracked on-disk provider-dir entries SHALL be overlaid without touching tracked checkout content

#### Scenario: Overlay scaffolding never lands on the branch

- **WHEN** an isolated run's work is committed to its branch
- **THEN** overlay-owned paths (links, copies, the overlay manifest) SHALL be excluded from the commit

#### Scenario: Overlay failure degrades instead of aborting

- **WHEN** the overlay cannot materialize one or more entries
- **THEN** the run SHALL still spawn AND the failure SHALL be surfaced via a `rail.overlay_degraded` event

#### Scenario: Provenance targets the worktree

- **WHEN** an isolated relocated run records file provenance or runs git
- **THEN** those operations SHALL target the worktree (the real repo), never the workspace

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

