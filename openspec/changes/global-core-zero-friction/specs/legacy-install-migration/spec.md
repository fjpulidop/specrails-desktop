# legacy-install-migration

## ADDED Requirements

### Requirement: Legacy projects are detected and migrated at startup

At server startup, the app SHALL identify registered projects that are non-relocated (two-part activation gate) AND have a repo-resident core install (`<repo>/.specrails/specrails-version` present), and SHALL migrate each to the relocated workspace automatically, in the background, serialized per project, without user prompting. Migration SHALL be gated by the kill switch `SPECRAILS_LEGACY_MIGRATION` (default on; `false` disables).

#### Scenario: Legacy project migrates on upgrade
- **WHEN** the app starts with a registered legacy project
- **THEN** a relocated workspace is assembled and the project resolves as relocated on subsequent spawns

#### Scenario: Kill switch preserves legacy behavior
- **WHEN** `SPECRAILS_LEGACY_MIGRATION=false`
- **THEN** no migration or repo cleanup runs and legacy projects keep their byte-identical legacy path

### Requirement: Per-project state moves from repo to workspace

Migration SHALL move (not copy) app/core-owned per-project state from `<repo>/.specrails/` to the workspace: `profiles/`, `local-tickets.json`, `backlog-config.json`, `state/`, `file-summaries/`, `plugins/`, and `agent-memory/`. Moved state MUST remain functionally identical (same tickets, same profiles, same plugin state) after migration.

#### Scenario: Tickets survive migration
- **WHEN** a legacy project with 12 tickets in `<repo>/.specrails/local-tickets.json` migrates
- **THEN** all 12 tickets are readable from the workspace store and the board renders them unchanged

### Requirement: Repo cleanup is manifest-driven and never touches user files

Repo cleanup SHALL delete only paths that exactly match a manifest computed from the bundled framework's file listing (framework-owned `sr-*` agents, `specrails`/`opsx` command directories, framework skills/rules, instruction-file copies the installer owns) plus app-owned `.specrails/` leftovers, UNION narrow historical patterns covering files older core versions installed that no longer exist in the current listing (`<providerDir>/agents/sr-*.md`, `<providerDir>/commands/{sr,specrails,opsx}/`, framework-owned skills/rules dir names). Patterns MUST follow framework naming conventions only, so user files can never match. The following MUST never be deleted or modified: `openspec/**`, `.claude/worktrees/**`, `custom-*.md` agent files, user-authored instruction files (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md` are left as-is even when the old installer appended to them), user settings files, and `.mcp.json` keys not owned by the app (surgical key-level removal only).

#### Scenario: User files planted among framework files survive
- **WHEN** a repo contains `.claude/agents/sr-architect.md` (framework) and `.claude/agents/custom-mine.md` (user)
- **THEN** cleanup deletes `sr-architect.md` and leaves `custom-mine.md` untouched

#### Scenario: openspec and worktrees are carve-outs
- **WHEN** cleanup runs on a repo with `openspec/` specs and `.claude/worktrees/` entries
- **THEN** neither path is touched

#### Scenario: Files from an older core version are cleaned
- **WHEN** a repo installed by core 4.x contains `.claude/commands/sr/` and an `sr-merge-resolver.md` agent absent from the current bundled listing
- **THEN** both are deleted via the historical patterns while adjacent user files survive

#### Scenario: mcp.json surgical cleanup
- **WHEN** the repo's `.mcp.json` contains an app-owned `serena` key and a user-added `myserver` key
- **THEN** only the app-owned key is removed and `myserver` remains valid JSON in place

### Requirement: Migration is journaled write-ahead and fail-open

Before executing any deletion, migration SHALL write a journal (`~/.specrails/projects/<slug>/migration-log.json`) listing every planned move/delete with its classification reason, then append execution outcomes. Any step failure SHALL abort the remaining cleanup for that project, leave the project fully functional (workspace wins via the activation gate once state moved), and surface a single non-blocking warning. Migration MUST be resumable: a later startup re-attempts only the un-executed journal entries.

#### Scenario: Crash mid-cleanup is auditable and resumable
- **WHEN** the app crashes after deleting half the manifest entries
- **THEN** the journal shows exactly which entries executed, and the next startup completes only the remainder

#### Scenario: Failure never blocks the project
- **WHEN** a delete fails with a permission error
- **THEN** the project remains usable, cleanup for that project stops, and a warning (not a modal) is surfaced once
