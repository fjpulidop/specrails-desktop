# framework-auto-update

## ADDED Requirements

### Requirement: Framework current swaps automatically at startup

When a newer framework version is available (bundled with the app, or fetched via the core-update channel), the app SHALL at startup materialize it into `~/.specrails/framework/<version>/` and atomically swap the `current` symlink without user interaction. The swap SHALL run under the registry lock so in-flight resolutions complete first. In-flight rails/jobs SHALL keep the version they resolved at spawn. Auto-swap SHALL be gated by the kill switch `SPECRAILS_FRAMEWORK_AUTOSWAP` (default on; `false` restores the manual-only flow). The existing `framework.updated` app-level broadcast SHALL be retained.

#### Scenario: App update carries new core
- **WHEN** the desktop app updates to a build bundling framework 5.1.0 while `current` points at 5.0.0
- **THEN** the next startup materializes 5.1.0, swaps `current`, and every symlinked workspace surface reads 5.1.0 with no per-project action

#### Scenario: In-flight rail unaffected
- **WHEN** a rail spawned against 5.0.0 is running during the swap
- **THEN** that rail completes on 5.0.0

#### Scenario: Kill switch
- **WHEN** `SPECRAILS_FRAMEWORK_AUTOSWAP=false`
- **THEN** no automatic swap occurs and the manual "check now" affordance still works

### Requirement: Post-swap re-seed refreshes copied workspace files

After a swap, the app SHALL run an idempotent re-seed pass over every relocated workspace refreshing files that are copies rather than symlinks: instruction files (re-rendered with the project name), Windows copy-fallback subtrees (re-copied from the new version), and Kimi per-child skill links (re-linked). The pass SHALL also run for any workspace whose recorded framework version differs from `current` (catching machines offline during a swap). `.mcp.json` MUST NOT be wholesale re-copied — only app/framework-owned keys are surgically updated, preserving plugin- and user-owned keys.

#### Scenario: Instruction file copy is refreshed
- **WHEN** the framework updates its instruction template and the swap completes
- **THEN** each workspace's `CLAUDE.md`/`AGENTS.md` is regenerated from the new template, still carrying that project's name

#### Scenario: Windows copy-fallback catches up
- **WHEN** a Windows workspace uses copy-fallback and the swap completes
- **THEN** its copied `commands|skills|rules` trees match the new version's content

#### Scenario: Plugin MCP keys survive re-seed
- **WHEN** a workspace's `.mcp.json` contains a plugin-owned `serena` key and a user key
- **THEN** re-seed updates only framework-owned entries and both other keys are byte-preserved

#### Scenario: Missed swap is repaired later
- **WHEN** a workspace's recorded framework version is 4.12.0 while `current` is 5.0.0
- **THEN** the next startup re-seeds that workspace even though no swap happened in this session

### Requirement: Prior versions are retained for rollback

The auto-update flow MUST NOT delete previously materialized `framework/<version>/` directories. Rolling back SHALL be possible by pointing `current` at a prior version and re-running the re-seed pass.

#### Scenario: Rollback by re-pointing current
- **WHEN** `current` is re-pointed at the previous version and re-seed runs
- **THEN** all workspaces (symlinked and copied surfaces) read the previous version's content
