## MODIFIED Requirements

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
