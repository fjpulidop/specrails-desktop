## MODIFIED Requirements

### Requirement: Repo cleanup is manifest-driven and never touches user files

Repo cleanup SHALL delete only paths that exactly match a manifest computed from the bundled framework's file listing (`specrails`/`opsx` command directories, framework skills, instruction-file copies the installer owns) plus app-owned `.specrails/` leftovers, UNION narrow historical patterns covering files older core versions installed that no longer exist in the current listing (`<providerDir>/agents/sr-*.md`, `<providerDir>/commands/{sr,specrails,opsx}/`, `skills/(rails/)?sr-*`, framework-owned skills/rules dir names). Patterns MUST follow framework naming conventions only, so user files can never match. The following MUST never be deleted or modified: `openspec/**`, `.claude/worktrees/**`, `custom-*.md` agent files, user-authored instruction files (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md` are left as-is even when the old installer appended to them), user settings files, and `.mcp.json` keys not owned by the app (surgical key-level removal only).

#### Scenario: User files planted among framework files survive
- **WHEN** a repo contains `.claude/agents/sr-architect.md` (installed by an older core) and `.claude/agents/custom-mine.md` (user)
- **THEN** cleanup deletes `sr-architect.md` through the historical pattern and leaves `custom-mine.md` untouched

#### Scenario: openspec and worktrees are carve-outs
- **WHEN** cleanup runs on a repo with `openspec/` specs and `.claude/worktrees/` entries
- **THEN** neither path is touched

#### Scenario: Files from an older core version are cleaned
- **WHEN** a repo installed by core 4.x contains `.claude/commands/sr/` and an `sr-merge-resolver.md` agent absent from the current bundled listing
- **THEN** both are deleted via the historical patterns while adjacent user files survive

#### Scenario: mcp.json surgical cleanup
- **WHEN** the repo's `.mcp.json` contains an app-owned `serena` key and a user-added `myserver` key
- **THEN** only the app-owned key is removed and `myserver` remains valid JSON in place
