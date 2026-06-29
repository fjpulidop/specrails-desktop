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

When the isolation gate applies, the engine SHALL create one git worktree per ticket on branch `sr/<slug>/ticket-<id>` rooted at the repository's current HEAD, and SHALL spawn that ticket's loop run against the worktree. Worktrees SHALL be created under `$HOME` (never inside the repository) and SHALL share the repository's `.git`/object-store.

#### Scenario: One branch + worktree per ticket

- **WHEN** isolation applies to a rail with tickets #1 and #2
- **THEN** the engine SHALL create branches `sr/<slug>/ticket-1` and `sr/<slug>/ticket-2`, each with its own worktree, each rooted at the repo HEAD at launch time

#### Scenario: Worktrees live outside the repo

- **WHEN** worktrees are created
- **THEN** they SHALL be located under the per-project `$HOME` area and SHALL NOT appear inside the user's repository working tree

### Requirement: Relocated worktree + workspace overlay

For a relocated project, each isolated run SHALL spawn from a per-run **workspace overlay** whose `./project` symlink and `SPECRAILS_REPO_DIR` point at that ticket's worktree, with the framework subtrees symlinked from `framework/current` and `agent-memory` as a real per-run directory. For a legacy (non-relocated) project, the run SHALL spawn with `cwd` set directly to the worktree. In both modes, git/provenance operations SHALL target the worktree, not the overlay.

#### Scenario: Relocated run uses an overlay pointing at its worktree

- **WHEN** an isolated run is launched for a relocated project
- **THEN** its spawn `cwd` SHALL be a per-run workspace overlay AND `SPECRAILS_REPO_DIR` SHALL point at that run's worktree

#### Scenario: Legacy run spawns in the worktree

- **WHEN** an isolated run is launched for a non-relocated project
- **THEN** its spawn `cwd` SHALL be the worktree directory

#### Scenario: Provenance targets the worktree

- **WHEN** an isolated relocated run records file provenance or runs git
- **THEN** those operations SHALL target the worktree (the real repo), never the workspace overlay

### Requirement: Worktree concurrency cap and teardown

The number of simultaneous worktrees per rail launch SHALL be bounded by a configured cap; tickets beyond the cap SHALL queue. Each worktree and its overlay SHALL be removed when its branch reaches a terminal merge state (merged or empty), when the rail is stopped or cancelled, and a startup sweep SHALL remove worktrees/overlays whose ledger row is terminal. Worktrees SHALL never be orphaned across a server restart.

#### Scenario: Excess tickets queue

- **WHEN** a rail has more tickets than the worktree concurrency cap
- **THEN** the engine SHALL run up to the cap concurrently and queue the rest

#### Scenario: Merged worktree is cleaned up

- **WHEN** a ticket's branch is merged into the base
- **THEN** the engine SHALL remove that ticket's worktree and overlay

#### Scenario: Stop tears down in-flight worktrees

- **WHEN** the user stops the rail mid-fan-out
- **THEN** the engine SHALL tear down the in-flight worktrees and overlays

#### Scenario: Startup sweep clears stale worktrees

- **WHEN** the server starts and finds ledger rows in a non-terminal state from a prior dead process
- **THEN** it SHALL mark them failed and remove their worktrees and overlays

