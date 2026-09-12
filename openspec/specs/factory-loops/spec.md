# factory-loops Specification

## Purpose
TBD - created by archiving change rails-as-loops. Update Purpose after archive.
## Requirements
### Requirement: Built-in factory loops

The app SHALL ship built-in "factory" loops for `implement`, `batch`, `freestyle`, and `SDD Quick (OpenSpec)`. They SHALL appear in the Loops gallery alongside user loops, marked read-only (locked), and SHALL NOT be editable in place. A "Fork to edit" action SHALL clone a factory loop into a new editable user draft, leaving the original unchanged.

The `SDD Quick (OpenSpec)` factory loop SHALL have a stable factory id and SHALL map to rail loop execution. Existing OpenSpec lifecycle factory ids SHALL remain resolvable for compatibility.

#### Scenario: Factory loops are listed and locked

- **WHEN** the Loops gallery is opened
- **THEN** the `implement`, `batch`, `freestyle`, and `SDD Quick (OpenSpec)` factory loops SHALL be listed as read-only (locked)
- **AND** they SHALL NOT expose Edit / Delete / Publish actions

#### Scenario: Forking a factory loop

- **WHEN** the user invokes "Fork to edit" on a factory loop
- **THEN** a new editable user loop SHALL be created as a clone of the factory loop's graph in `Draft` state
- **AND** the original factory loop SHALL remain unchanged

#### Scenario: OpenSpec factory compatibility is preserved

- **WHEN** a client launches an existing OpenSpec lifecycle factory id
- **THEN** the id SHALL continue to resolve to a valid OpenSpec lifecycle graph
- **AND** new recommendations SHALL prefer the `SDD Quick (OpenSpec)` product name

### Requirement: Catalog commands for batch and freestyle

The loop command catalog SHALL expose `{{cmd:batch}}` (the native specrails-core `batch-implement` slash command, resolved per provider like `{{cmd:implement}}`) and `{{cmd:freestyle}}` (a native/raw autonomous command — NOT a slash command).

#### Scenario: batch expands to the native batch-implement command

- **WHEN** `{{cmd:batch}}` is expanded for the claude provider with rail tickets 1 and 2
- **THEN** the result SHALL be the native `batch-implement` invocation over those tickets (`/specrails:batch-implement #1 #2 --yes`)
- **AND** for codex it SHALL use the `$batch-implement` skill form

#### Scenario: freestyle expands to the raw autonomous prompt

- **WHEN** `{{cmd:freestyle}}` is expanded
- **THEN** it SHALL produce the raw autonomous prompt (the same shape the existing freestyle path builds), NOT a `/specrails:` slash command

### Requirement: Command-declared ticket scope

Each catalog command SHALL declare a ticket scope of `all` (all the rail's tickets handled in ONE run) or `per-ticket` (one run per ticket). `implement` and `batch` SHALL be `all`; `freestyle` SHALL be `per-ticket`. The launch path SHALL read the command's scope to decide how many runs to spawn and which ticket token to inject.

#### Scenario: An all-scope command runs once over every ticket

- **WHEN** a loop whose command is scope `all` is launched on a rail holding 3 tickets
- **THEN** exactly ONE run SHALL be launched
- **AND** the command SHALL receive all 3 ticket ids

#### Scenario: A per-ticket command runs once per ticket

- **WHEN** a loop whose command is scope `per-ticket` is launched on a rail holding 3 tickets
- **THEN** THREE runs SHALL be launched, one per ticket
- **AND** each run's command SHALL receive only its own ticket id

### Requirement: All-tickets token

A `{{spec.ids}}` token SHALL resolve to all of the rail's ticket ids joined as `#<id> #<id> …`. The existing `{{spec.id}}` token SHALL continue to resolve to a single ticket id.

#### Scenario: spec.ids resolves to every rail ticket

- **WHEN** `{{spec.ids}}` is interpolated for a rail holding tickets 1, 2, and 3
- **THEN** it SHALL resolve to `#1 #2 #3`

#### Scenario: spec.id resolves to a single ticket

- **WHEN** `{{spec.id}}` is interpolated for a run scoped to ticket 5
- **THEN** it SHALL resolve to `5`

### Requirement: Implementation verification distinguishes baseline from delivery

The shared implementation verification command SHALL require evidence that the requested feature and its acceptance criteria are implemented, in addition to applicable project checks passing. It SHALL inspect the actual source and active spec or OpenSpec artifacts across every selected repository, detect the repository's tooling, and run required verification commands in the foreground before producing its final verdict.

#### Scenario: Clean baseline without requested implementation
- **WHEN** all baseline tests, lint, type-check, or build commands pass but the requested feature is absent
- **THEN** verification SHALL report `VERIFICATION: FAIL` with the missing implementation reason
- **AND** the loop goal SHALL remain unsatisfied

#### Scenario: One repository still lacks required behavior
- **WHEN** a shared spec requires Front and Back changes and either repository or their shared contract remains incomplete
- **THEN** verification SHALL report FAIL even if the other repository's checks pass

#### Scenario: Requested feature already exists
- **WHEN** the requested feature is already fully implemented and its acceptance criteria and required checks are verified
- **THEN** verification SHALL be permitted to report PASS on that evidence
- **AND** it SHALL NOT require an artificial code diff solely to prove work occurred

### Requirement: Refinement repairs the gap identified by verification

The shared refinement command SHALL distinguish missing or incomplete implementation from failing checks, regardless of the previous verdict's label. It SHALL authorize completing the missing parts of the same requested spec, including required pipeline or OpenSpec phases, preserve valid existing work, and require a subsequent verification pass. It SHALL reserve `LOOP_BLOCKED` for a specific unresolved decision requiring human input.

#### Scenario: FAIL reports no implementation despite green checks
- **WHEN** verification reports FAIL because no requested implementation exists although all baseline checks pass
- **THEN** refinement SHALL continue implementing the missing requested feature
- **AND** it SHALL NOT restrict its work to already-failing test or build commands

#### Scenario: Existing implementation fails a project gate
- **WHEN** verification identifies a concrete failed check in an otherwise existing implementation
- **THEN** refinement SHALL repair that failure with changes scoped to the spec
- **AND** verification SHALL run again on the repaired candidate

#### Scenario: Decider evaluates evidence rather than assuming PASS
- **WHEN** a factory or OpenSpec lifecycle decider evaluates a candidate
- **THEN** its goal SHALL require the latest applicable verification to report PASS and required implementation scope to be complete
- **AND** its goal text SHALL NOT assert that verification already passed

