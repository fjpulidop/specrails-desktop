## ADDED Requirements

### Requirement: Kimi discovery and setup
Desktop SHALL discover an externally installed Kimi Code CLI with a bounded
version probe, offer official install/login remediation, and allow Kimi to be
added as a project provider without bundling Kimi or managing a server.
Desktop SHALL NOT spend quota to claim conclusive authentication readiness
when Kimi exposes no non-billing auth diagnostic.

#### Scenario: Kimi is available
- **WHEN** `kimi` is executable and its bounded probe succeeds
- **THEN** setup and Add Project show Kimi as available

#### Scenario: Kimi is missing
- **WHEN** a project requests Kimi but the executable is absent
- **THEN** setup blocks Kimi activation with official installation guidance

#### Scenario: Authentication cannot be proven by setup
- **WHEN** `kimi --version` succeeds but no prompt has been sent
- **THEN** Desktop reports executable/version availability, recommends
  `kimi login`, and does not claim that OAuth/model access was verified

### Requirement: Kimi adapter contract
Desktop SHALL register a Kimi provider adapter that builds official headless arguments, parses stream JSON tolerantly, resumes known sessions, reports tools/errors/text/session metadata, and advertises only verified capabilities.

#### Scenario: New prompt
- **WHEN** Desktop invokes a Kimi action without a session ID
- **THEN** the spawned command uses prompt mode, stream JSON, the selected model, and no Kimi Server subcommand

#### Scenario: Headless skill activation
- **WHEN** a Desktop action invokes an installed SpecRails/OpenSpec Kimi skill
- **THEN** Desktop resolves the direct-child `SKILL.md` at the execution
  artifact root, expands its arguments, and passes a materialized
  `kimi-skill-loaded` prompt to `kimi -p` rather than forwarding the
  interactive `/skill:` text

#### Scenario: Missing or unsafe headless skill
- **WHEN** the requested Kimi skill is absent or its identifier could escape
  the project skills root
- **THEN** Desktop rejects the action before spawning Kimi and reports an
  actionable Core update or validation error

#### Scenario: Fresh skill requires a session identifier
- **WHEN** an installed Kimi skill references `${KIMI_SESSION_ID}` but the
  print-mode session has not yet emitted a resume hint
- **THEN** Desktop rejects the fresh invocation rather than injecting an empty
  or fabricated session identifier

#### Scenario: Resume prompt
- **WHEN** Desktop invokes a Kimi action with a known Kimi session ID
- **THEN** the adapter includes Kimi's native session argument and retains the same provider/model

#### Scenario: Unknown stream event
- **WHEN** Kimi emits a valid JSON object whose type is not recognized
- **THEN** the parser preserves it as an `other` event without crashing the invocation

#### Scenario: Desktop owns stable Kimi v1
- **WHEN** Desktop builds the environment for a managed Kimi child
- **THEN** it removes inherited K3 effort when inapplicable and removes
  `KIMI_CODE_EXPERIMENTAL_FLAG` so user-global v2 opt-in cannot silently alter
  the qualified v1 JSONL/permission contract

### Requirement: Kimi models and reasoning effort
Desktop SHALL expose official Kimi model IDs and SHALL offer low/high/max effort for K3 while preserving exact model identifiers in conversations, jobs, profiles, reruns, and analytics.

#### Scenario: K3 selection
- **WHEN** a user selects K3 with max effort
- **THEN** the Kimi invocation receives the K3 model and corresponding supported effort configuration

#### Scenario: Non-K3 selection
- **WHEN** a Kimi conversation, job, profile, or rerun selects
  `kimi-for-coding`, `kimi-for-coding-highspeed`, or a custom alias
- **THEN** low/high/max is not offered or accepted and any persisted K3 effort
  is cleared before spawn

#### Scenario: Unknown provider model
- **WHEN** a model lookup is performed for an unregistered provider
- **THEN** Desktop does not silently return Claude models

### Requirement: Provider selection surfaces
Every Desktop provider surface SHALL derive Kimi dynamically from the provider
registry when Kimi advertises
that surface's required capability. Unsupported safety-sensitive surfaces
SHALL omit/disable Kimi and reject a direct request server-side. Primary and
multi-provider semantics SHALL be preserved.

#### Scenario: Create a mixed project
- **WHEN** a user creates or re-registers a project with Claude and Kimi selected
- **THEN** both providers are installed and the first selected provider remains the project primary

#### Scenario: Kimi-only project
- **WHEN** a project is created with only Kimi
- **THEN** all provider labels, selectors, navigation sections, and defaults resolve to Kimi rather than Claude

### Requirement: Chat and session lifecycle
Project Chat, Agent Chat, and Explore SHALL support Kimi text/tool streaming, successful session persistence, resume, process cancellation, errors, and concurrent conversation isolation.

#### Scenario: Successful first turn
- **WHEN** a Kimi chat turn emits text, tool calls, and a resume hint
- **THEN** Desktop streams the content, records the tools, and persists the returned session ID

#### Scenario: Cancel before resume hint
- **WHEN** the user cancels a first Kimi turn before a session hint is emitted
- **THEN** Desktop records an aborted invocation and does not fabricate a resumable session

### Requirement: Agentic spec work and structured-action safety
Desktop SHALL support Kimi for Explore conversations/proposals and agentic
Quick Launcher commands, including `/opsx:ff`, under its documented autonomous prompt-mode
posture. Quick Spec, AI Edit, Contract Refine, SMASH, Re-SMASH, file summaries,
construction-story AI, and Agent Studio generation/smoke-test/refine SHALL
fail closed for Kimi until its headless transport can enforce the required
no-tools/read-only boundary. AI auto-title SHALL use the deterministic fallback
without spawning Kimi.

#### Scenario: Kimi Explore proposal
- **WHEN** a user selects Kimi for Explore and requests a proposal
- **THEN** Desktop streams the agentic Kimi turn, persists a successful resume
  hint, and discloses that prompt mode may use tools autonomously

#### Scenario: Kimi Quick Launcher
- **WHEN** a user selects an agentic Quick Launcher command such as `/opsx:ff`
- **THEN** Desktop materializes the corresponding installed Kimi skill and
  launches the resulting prompt through `kimi -p`

#### Scenario: Direct Kimi Quick Spec or AI Edit
- **WHEN** a client requests Quick Spec or AI Edit with Kimi
- **THEN** Desktop rejects the action before spawning Kimi or mutating a spec

#### Scenario: Direct Kimi Contract Refine or SMASH request
- **WHEN** a client bypasses the hidden UI and requests Contract Refine or SMASH with Kimi
- **THEN** Desktop rejects the action before spawning Kimi or mutating any spec

#### Scenario: Kimi Re-SMASH
- **WHEN** a Kimi-backed parent spec is opened
- **THEN** Re-SMASH is unavailable and no existing child is deleted

#### Scenario: Kimi auto-title
- **WHEN** a Kimi-backed surface needs a title
- **THEN** Desktop uses its deterministic fallback and records no Kimi
  auto-title invocation

#### Scenario: Kimi Code Explorer AI transform
- **WHEN** a client requests a file summary or construction-story explanation
  with Kimi
- **THEN** Desktop rejects before spawn while retaining deterministic
  provenance, stats, log, and previously stored text

### Requirement: Attachments and images
Desktop SHALL pass textual attachments to Kimi and SHALL make supported image attachments available through validated absolute file references that Kimi can read with `ReadMediaFile`.

#### Scenario: Image prompt
- **WHEN** a supported image is attached to a Kimi action
- **THEN** the prompt contains a safe file reference and instructions to inspect it with Kimi's media tool

#### Scenario: Unsafe path
- **WHEN** an attachment resolves outside the permitted project/upload roots
- **THEN** Desktop rejects it before spawning Kimi

### Requirement: Rails, loops, batch, and retry
Kimi SHALL be selectable for implement rails, batch, Freestyle, retry, rerun,
worktree isolation, PR delivery, and custom loops without a Loop Decider,
using the Kimi skills generated by the compatible Core framework.

#### Scenario: Complete Kimi rail
- **WHEN** a Kimi implement rail runs
- **THEN** the workflow skill is materialized before the orchestrator spawn,
  architect/developer/reviewer role skills are injected into their external
  Kimi subprocesses, verification gates run, and delivery follows the same
  queue/worktree/PR state machine

#### Scenario: Kimi rerun
- **WHEN** a completed or failed Kimi job is rerun
- **THEN** provider, model, effort, profile, ticket, and origin metadata are retained

#### Scenario: Kimi loop with Decider
- **WHEN** a Kimi rail selects a loop whose graph contains a Loop Decider
- **THEN** Desktop rejects the run before any loop step spawns

#### Scenario: Kimi loop without Decider
- **WHEN** a Kimi rail selects a valid graph containing AI and shell steps but
  no Decider
- **THEN** Desktop executes the loop with the normal bounded queue/worktree
  lifecycle

### Requirement: Project Builder capability boundary
Desktop SHALL allow Kimi as a target provider in a committed Project Builder
project and SHALL allow Kimi to launch already committed milestone tickets
through the normal Batch rail. Day-0 blueprint and later detailed milestone
generation SHALL reject Kimi before spawn because they are pure structured
output.

#### Scenario: Kimi target project
- **WHEN** an approved blueprint is committed with Kimi in its target provider
  set
- **THEN** Core materializes `.kimi-code` and the registered project can launch
  its committed milestone tickets on Kimi

#### Scenario: Kimi blueprint or milestone generation
- **WHEN** a client requests day-0 blueprint or M2+ detailed milestone
  generation with Kimi
- **THEN** Desktop rejects the generation turn before spawning Kimi and before
  writing blueprint, milestone, ticket, filesystem, or registry state

### Requirement: Profiles and custom roles
Desktop SHALL create, read, validate, and execute provider-scoped Kimi profiles
and manually-authored custom roles without requiring `.claude/agents` or
Claude model aliases. AI generation, smoke-test, and refine SHALL be
unavailable for Kimi while it lacks a safe tool boundary.

#### Scenario: Kimi custom role
- **WHEN** a profile routes a task to a Kimi `custom-*` role
- **THEN** Desktop resolves `.kimi-code/skills/<role>/SKILL.md` as a direct,
  CLI-discoverable skill and invokes it with the profile's exact Kimi model

#### Scenario: Mixed-provider profile
- **WHEN** a project contains Claude and Kimi
- **THEN** profile editing presents valid models and role projections for the
  selected execution provider and identically named Claude/Kimi profiles do
  not collide

#### Scenario: Kimi Agent Studio automation request
- **WHEN** a client requests Kimi role generation, smoke-test, or AI refine
- **THEN** Desktop rejects the request before spawning Kimi while preserving manual role editing

### Requirement: MCP, Serena, and integrations
Desktop SHALL configure SpecRails-managed MCP and Serena integrations for Kimi through additive `.kimi-code/mcp.json` updates, and integration UI SHALL use provider capabilities instead of a Claude-only gate.

#### Scenario: Add Desktop MCP to Kimi
- **WHEN** the Desktop MCP integration is enabled for Kimi
- **THEN** its server entry is merged without deleting or exposing existing Kimi MCP configuration

#### Scenario: Serena on Kimi
- **WHEN** Serena is installed for a Kimi project
- **THEN** Desktop verifies the Kimi MCP entry and reports provider-specific health

#### Scenario: Mixed-provider integration state
- **WHEN** Claude and Kimi install the same managed integration in one project
- **THEN** health, repair, removal, and job snapshots remain scoped to the
  effective provider and removing one does not remove the other's ownership

### Requirement: Truthful Kimi telemetry
Desktop SHALL record Kimi invocation success, failure, abort, duration, provider, model, session metadata, and any reported tokens, while representing native USD cost as unavailable.

#### Scenario: Kimi result without cost
- **WHEN** a successful Kimi invocation reports no authoritative USD cost
- **THEN** analytics store a null/unavailable cost rather than zero reported cost

#### Scenario: Stream replay or duplicate line
- **WHEN** duplicate Kimi terminal metadata is observed
- **THEN** Desktop records exactly one invocation result

### Requirement: Core compatibility and relocation
Desktop SHALL require a Core version that renders Kimi, materialize `.kimi-code` in standalone and relocated workspaces, and preserve source-repo orientation and other provider overlays.

#### Scenario: Compatible Core
- **WHEN** Kimi is enabled with a compatible bundled Core
- **THEN** framework materialization produces usable Kimi skills and OpenSpec paths in the execution workspace

#### Scenario: Old Core
- **WHEN** Kimi is requested but bundled Core lacks the Kimi provider
- **THEN** setup refuses the partial installation and offers an actionable Core update

### Requirement: Cross-platform CLI-only lifecycle
Desktop SHALL launch and cancel native and npm-installed Kimi executables on macOS, Linux, and Windows using the existing safe spawn helpers and SHALL NOT start `kimi server`, register services, or store credentials.

#### Scenario: Windows npm shim
- **WHEN** Kimi resolves to a Windows command shim
- **THEN** Desktop launches the headless prompt without corrupting Unicode, multiline prompts, or environment paths

#### Scenario: Oversized native Windows prompt
- **WHEN** a native Kimi executable would exceed Desktop's 30,000 UTF-16
  command-line budget
- **THEN** Desktop rejects the invocation before spawn with guidance to use the
  standard npm shim instead of truncating or compacting the workflow

#### Scenario: Application shutdown
- **WHEN** Desktop exits with active Kimi invocations
- **THEN** it terminates their process trees without affecting unrelated Kimi sessions or services
