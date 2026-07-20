## MODIFIED Requirements

### Requirement: Explore turns spawn from an app-managed cwd by default

Every Explore conversation turn (chat conversations with `kind='explore'`) SHALL spawn `claude` with `cwd` selected by the conversation's `contextScope.mcp` flag. When `contextScope.mcp` is `true` the spawn cwd MUST be resolved through the relocate-artifacts gate: the project WORKSPACE for a relocated project (where `.mcp.json` and `.specrails/` live after relocation), `<project.path>` for a legacy project. Otherwise it MUST be `~/.specrails/projects/<slug>/explore-cwd/`. The app-managed cwd MUST contain an app-owned `CLAUDE.md` and a symlink `./project` (junction on Windows) pointing at the project's absolute path. The user's `<project>/CLAUDE.md` MUST NOT be modified, moved, deleted, or referenced by the spawn cwd in any way. An Explore turn MUST NOT spawn with a cwd that resolves the ticket-store instruction (`.specrails/local-tickets.json`) into a relocated project's repo. If a spawn-per-turn or persistent-stdin resume for a relocated Explore conversation that was routed to its workspace fails with the exact provider diagnostic `No conversation found with session ID`, the app MUST retry that turn at most once as a fresh invocation from the workspace, MUST NOT retry it from the repo, MUST invalidate the known-bad stored session id, and MUST preserve continuity using bounded persisted conversation context rather than an unbounded transcript. No other failure SHALL activate this compatibility retry; persistent-stdin recovery MUST replace only the stale child and otherwise retain the transport's lifecycle semantics. A workspace-routed Contract Refine resume that encounters the same exact diagnostic MUST retry at most once as a fresh workspace invocation with tools disabled and the target ticket context seeded into its prompt; it MUST NOT retry from the repo. The conversation's stored `contextScope.mcp` MUST be set at creation time exclusively from the Add Spec modal's `Project MCPs` toggle (or the active preset). The app MUST NOT consult any project-level setting when initialising or interpreting `contextScope.mcp`. Legacy conversations whose `context_scope` is `null` or missing the `mcp` field MUST be treated as `mcp: false` (spawn from app-managed cwd). `SPECRAILS_EXPLORE_LEGACY_CWD=1` MUST keep forcing `<project.path>` for every Explore spawn regardless of `contextScope.mcp` or relocation state.

#### Scenario: contextScope.mcp false uses app-managed cwd

- **WHEN** an Explore turn fires and the conversation's `contextScope.mcp` is `false`
- **THEN** `claude` is spawned with `cwd` equal to `~/.specrails/projects/<slug>/explore-cwd/`
- **AND** that directory contains an app-owned `CLAUDE.md` file
- **AND** that directory contains a `project` entry that resolves to the project's absolute path

#### Scenario: contextScope.mcp true uses project cwd on a legacy project

- **WHEN** an Explore turn fires for a non-relocated project and the conversation's `contextScope.mcp` is `true`
- **THEN** `claude` is spawned with `cwd` equal to `<project.path>`
- **AND** the app-managed `explore-cwd/` directory is not used for that turn

#### Scenario: contextScope.mcp true uses the workspace on a relocated project

- **WHEN** an Explore turn fires for a relocated project (registry entry present AND workspace populated) and the conversation's `contextScope.mcp` is `true`
- **THEN** `claude` is spawned with `cwd` equal to the project's workspace directory
- **AND** the cwd-relative ticket store resolves to `<workspace>/.specrails/local-tickets.json`, never `<project.path>/.specrails/local-tickets.json`

#### Scenario: Pre-existing relocated Explore session is recovered without returning to the repo

- **GIVEN** an MCP-enabled Explore conversation whose Claude session was created under the pre-relocation repo cwd
- **WHEN** its spawn-per-turn `--resume` from the relocated workspace fails with `No conversation found with session ID`
- **THEN** the app retries the current turn exactly once as a fresh invocation from the workspace and without `--resume`
- **AND** the retry cwd is never `<project.path>`
- **AND** the fresh prompt carries a bounded excerpt of persisted conversation context plus the current user turn
- **AND** a different provider error, or failure of the fresh retry, does not trigger another compatibility retry
- **AND** persistent-stdin resumes use the same one-time recovery by replacing only the stale child and otherwise retain their existing transport and lifecycle behaviour

#### Scenario: Contract Refine recovers an unavailable pre-existing Explore session

- **GIVEN** Contract Refine targets a ticket from a relocated Explore conversation whose prior Claude session is unavailable from the workspace
- **WHEN** its `--resume` attempt fails with `No conversation found with session ID`
- **THEN** it retries exactly once as a fresh invocation from the workspace, never from `<project.path>`
- **AND** the fresh invocation does not use `--resume`, keeps tools disabled, and is seeded with the target ticket context
- **AND** a different provider error, or failure of the fresh retry, does not trigger another compatibility retry

#### Scenario: Project CLAUDE.md is never touched

- **WHEN** an Explore conversation is created, run, resumed, minimized, restored, or closed
- **THEN** the file `<project.path>/CLAUDE.md` is not modified, moved, or deleted by the app
- **AND** the app-managed `explore-cwd/CLAUDE.md` is a separate file with app-owned content

#### Scenario: Legacy null scope defaults to app-managed cwd

- **GIVEN** an Explore conversation row whose stored `context_scope` is `null` or lacks the `mcp` field
- **WHEN** a turn fires for that conversation
- **THEN** `claude` is spawned with `cwd` equal to `~/.specrails/projects/<slug>/explore-cwd/`
