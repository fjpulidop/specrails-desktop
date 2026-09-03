# desktop-mcp-tools Specification

## Purpose
TBD - created by archiving change add-desktop-mcp-server. Update Purpose after archive.
## Requirements
### Requirement: Domain-facade tool catalog covers the control surface
The MCP server SHALL expose the platform's control surface as a bounded set of domain tools (each with an `action` enum) rather than one tool per operation, covering projects, specs, rails, jobs, chat, agents/profiles, plugins, Jira, loops, code (read), setup, settings, analytics, webhooks, core-update, and OpenSpec changes.

#### Scenario: A domain tool exposes multiple actions
- **WHEN** an MCP client inspects a domain tool (e.g. the specs tool)
- **THEN** the tool advertises an `action` parameter enumerating its operations (e.g. list, get, create, update, delete, generate, contract_refine, smash)

#### Scenario: Catalog stays bounded
- **WHEN** an MCP client lists available tools
- **THEN** the catalog is on the order of ~20 tools (domain facades + meta + watch + project selection), not hundreds of flat tools

### Requirement: Read operations are exposed as resources
The MCP server SHALL expose read-only state as MCP resources addressable by URI (e.g. projects, a project's tickets, rails, jobs, analytics), in addition to being reachable via domain-tool read actions.

#### Scenario: Listing a project's tickets as a resource
- **WHEN** an MCP client reads the resource for a project's tickets
- **THEN** the server returns the current ticket list for that project

### Requirement: A guide meta tool teaches the platform
The MCP server SHALL provide a `guide` meta capability that returns a self-contained explanation of the platform's concepts, workflow, and invariants, so an external LLM can operate Specrails correctly without prior knowledge.

#### Scenario: Guide explains core concepts and invariants
- **WHEN** an MCP client invokes the guide capability
- **THEN** the response explains concepts (project, rail, spec/ticket, draft, profile, agent, provider, loop, plugin, job) and key invariants (e.g. priority may be null only for drafts; SMASH/Contract-Refine/profiles are Claude-only; provider must be one of the project's installed providers)

### Requirement: Search and describe meta tools support on-demand depth
The MCP server SHALL provide meta capabilities to search for the right tool/action and to describe a domain's detailed schema on demand, so clients can discover capabilities without preloading every schema.

#### Scenario: Searching for the right action
- **WHEN** an MCP client searches with a natural-language intent (e.g. "launch the pipeline for a ticket")
- **THEN** the server returns the relevant tool and action to use

### Requirement: Tools declare and enforce their danger tier
Every tool/action SHALL declare its tier (Read, Write, AI-spawn, Destructive) so the server can enforce the permission model consistently; cost-incurring and destructive actions SHALL be clearly marked.

#### Scenario: A cost-incurring action is marked AI-spawn
- **WHEN** an MCP client inspects an action that spawns an AI CLI (e.g. rail launch, quick spec generation)
- **THEN** the action is classified in the AI-spawn tier and is only callable when that tier is enabled

#### Scenario: A destructive action is marked Destructive
- **WHEN** an MCP client inspects an action that deletes data or kills processes (e.g. unregister project, purge jobs, stop rail)
- **THEN** the action is classified in the Destructive tier and is only callable when that tier is enabled

### Requirement: Project scoping for per-project tools
Per-project tools SHALL accept a project identifier, and the server SHALL support selecting an active project so subsequent calls may omit it.

#### Scenario: Selecting an active project
- **WHEN** an MCP client selects an active project and then calls a per-project tool without a project id
- **THEN** the tool operates on the selected active project

#### Scenario: Explicit project id overrides the active project
- **WHEN** an MCP client calls a per-project tool with an explicit project id
- **THEN** the tool operates on that project regardless of the active selection

### Requirement: v1 coverage boundary excludes high-risk execution vectors
The tool catalog SHALL NOT expose terminal shell execution, browser-capture, in-app file overwrite (`code_write_file`), the prerequisite remote-script installer, or the global Claude marketplace settings mutation in v1.

#### Scenario: Excluded operation is not in the catalog
- **WHEN** an MCP client lists available tools
- **THEN** no tool performs terminal shell execution, browser navigation/capture, source-file overwrite, the `uv` remote installer, or mutation of the user's global `~/.claude/settings.json`
