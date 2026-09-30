## ADDED Requirements

### Requirement: Desktop owns implementation composition
Desktop SHALL publish independently configurable architecture, development, verification, review, correction and archive operations. Core SHALL execute one selected operation without scheduling another phase.

#### Scenario: Correction routing
- **WHEN** verification fails or review rejects the candidate
- **THEN** the Desktop-authored edges select the correction step and subsequent verification

### Requirement: Loop owns agent definitions
Published loops SHALL own agent engine assignments, editable definitions and workflow policy, shared across projects and copied on duplication.

#### Scenario: Project isolation
- **WHEN** two projects with different historical agent settings launch the same published loop
- **THEN** the same loop agent definitions and selections are admitted, with each project's own verification commands and execution scope

#### Scenario: Independent duplicate
- **WHEN** a user duplicates a loop and edits its developer definition
- **THEN** the original loop and its running executions retain their previous definitions

### Requirement: Durable independent operations
Operation state and evidence SHALL retain durable commit, cancellation, candidate validation and recovery semantics.

#### Scenario: Restart between phases
- **WHEN** the host restarts after development completes
- **THEN** resume uses committed state and frozen definitions without repeating completed work or inheriting newly edited agents

### Requirement: Safe configuration migration
The UI SHALL move agent configuration from project settings into loop editing. Historical files and edited loops MUST NOT be destructively overwritten. Import SHALL be explicit.

#### Scenario: Distinct historical project settings
- **WHEN** existing projects contain different role assignments
- **THEN** neither project silently changes the global builtin, and the settings remain available to import into a custom loop

### Requirement: Compatibility gated publication
Expanded workflows SHALL require an advertised Core operation capability and validate before launch. Retained runs SHALL use their retained package.

#### Scenario: Older Core
- **WHEN** an expanded workflow is launched with a Core that lacks its operation
- **THEN** admission fails before allocating execution effects with an actionable compatibility error


### Requirement: Agent steps are workflow-defined
New agent steps SHALL configure arbitrary loop-owned roles, instructions, access,
artifact permissions, OpenSpec bindings and output schemas without choosing a
Core implementation phase. The Implement recipe SHALL consist of these generic
steps and explicit validation, decision, correction and approval nodes.

#### Scenario: New role without Core changes
- **WHEN** a user adds an accessibility review step with its own role and output schema
- **THEN** Core executes its frozen configuration without a new phase preset

#### Scenario: Preserved implementation safeguards
- **WHEN** planned artifacts change, tasks remain incomplete, or a reviewed/approved candidate changes before archive
- **THEN** host checks reject the stale evidence and the loop's edges choose recovery

### Requirement: Builder specs accumulate on the integration branch
The production milestone chain SHALL integrate each successful spec through the
guarded local delivery decision before allocating the next spec's worktree.
Unconfirmed integration SHALL pause the chain without replaying implementation.

#### Scenario: Sequential construction
- **WHEN** three dependent specs finish in sequence
- **THEN** each new worktree includes all previously integrated specs

#### Scenario: Interrupted or failed integration
- **WHEN** integration fails or the host restarts while it is pending
- **THEN** the current delivery remains attached and recovery retries integration before advancing
