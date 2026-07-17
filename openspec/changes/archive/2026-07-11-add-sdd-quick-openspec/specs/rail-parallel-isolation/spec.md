## MODIFIED Requirements

### Requirement: Per-run worktree overlay (framework surface)

Every isolated run SHALL spawn with `cwd` set directly to the worktree, with `SPECRAILS_REPO_DIR` pointing at that worktree (writes/git land there, never the live repo). Because `git worktree add` materializes only tracked files, the engine SHALL merge-overlay the project's framework surface (provider commands, sr-* agents, skills, rules, settings, `.mcp.json`, the instruction file) INTO the worktree at allocation, sourced from the project's effective artifact root — the workspace for a relocated project, the repo's own untracked on-disk entries for a legacy project — via symlinks (dir links where a dir is wholly absent, per-entry where partially present; junction-then-copy fallback on Windows), NEVER overwriting content the checkout brought. `agent-memory` SHALL be linked so all runs share agent memory (shared-cwd semantics). For a relocated project the workspace artifact indirection env (`SPECRAILS_TICKETS_PATH`, `SPECRAILS_BACKLOG_CONFIG_PATH`, `SPECRAILS_PROFILES_DIR`, `SPECRAILS_STATE_DIR`) SHALL point at the workspace. Overlay-owned paths SHALL be excluded from worktree commits so they never reach the ticket branch/PR; overlay failures SHALL degrade (log + `rail.overlay_degraded` event) without aborting the rail. Git/provenance operations SHALL target the worktree.

#### Scenario: Private agent artifacts never reach PR branches
- **WHEN** an isolated rail worktree is created or reused
- **THEN** the worktree-local Git excludes SHALL ignore provider `agent-memory` directories and their `explanations` subdirectories
- **AND** Specrails' final worktree commit SHALL also exclude those paths with Git pathspec excludes
- **AND** `.claude/agent-memory`, `.codex/agent-memory`, `.gemini/agent-memory`, and their `explanations` contents SHALL NOT be staged by Specrails for PR branches
