## MODIFIED Requirements

### Requirement: Built-in factory loops

The app SHALL ship built-in "factory" loops for `implement`, `freestyle`, and `SDD Quick (OpenSpec)`. They SHALL appear in the Loops gallery alongside user loops, marked read-only (locked), and SHALL NOT be editable in place. A "Fork to edit" action SHALL clone a factory loop into a new editable user draft, leaving the original unchanged.

The `SDD Quick (OpenSpec)` factory loop SHALL have a stable factory id and SHALL map to rail loop execution. Existing OpenSpec lifecycle factory ids SHALL remain resolvable for compatibility.

The removed Batch factory loop SHALL NOT be listed. Its persisted id `factory:batch` SHALL remain resolvable and SHALL resolve to the `implement` factory loop, so saved rails and launches keep working.

#### Scenario: Factory loops are listed and locked

- **WHEN** the Loops gallery is opened
- **THEN** the `implement`, `freestyle`, and `SDD Quick (OpenSpec)` factory loops SHALL be listed as read-only (locked)
- **AND** no Batch factory loop SHALL be listed
- **AND** they SHALL NOT expose Edit / Delete / Publish actions

#### Scenario: Forking a factory loop

- **WHEN** the user invokes "Fork to edit" on a factory loop
- **THEN** a new editable user loop SHALL be created as a clone of the factory loop's graph in `Draft` state
- **AND** the original factory loop SHALL remain unchanged

#### Scenario: OpenSpec factory compatibility is preserved

- **WHEN** a client launches an existing OpenSpec lifecycle factory id
- **THEN** the id SHALL continue to resolve to a valid OpenSpec lifecycle graph
- **AND** new recommendations SHALL prefer the `SDD Quick (OpenSpec)` product name

#### Scenario: A saved Batch id runs as Implement

- **WHEN** a rail or launch names `factory:batch`
- **THEN** it SHALL resolve to the `implement` factory loop and run one aggregate Implement run

### Requirement: Catalog commands for batch and freestyle

The loop command catalog SHALL expose `{{cmd:freestyle}}` (a native/raw autonomous command — NOT a slash command). It SHALL NOT list a `batch` command. `{{cmd:batch}}` in a saved loop SHALL remain a hidden alias that expands exactly like `{{cmd:implement}}` for every provider; no provider SHALL receive a `batch-implement` invocation, and multi-ticket `implement` SHALL never be rewritten to `batch-implement`.

#### Scenario: batch is a hidden alias of implement

- **WHEN** `{{cmd:batch}}` is expanded for the claude provider with rail tickets 1 and 2
- **THEN** the result SHALL be `/specrails:implement #1 #2 --yes`
- **AND** for codex it SHALL be `$implement #1 #2 --yes`
- **AND** the builder command palette SHALL NOT list `batch`

#### Scenario: freestyle expands to the raw autonomous prompt

- **WHEN** `{{cmd:freestyle}}` is expanded
- **THEN** it SHALL produce the raw autonomous prompt (the same shape the existing freestyle path builds), NOT a `/specrails:` slash command

### Requirement: Command-declared ticket scope

Each catalog command SHALL declare a ticket scope of `all` (all the rail's tickets handled in ONE run) or `per-ticket` (one run per ticket). `implement` (and its hidden `batch` alias) SHALL be `all`; `freestyle` SHALL be `per-ticket`. The launch path SHALL read the command's scope to decide how many runs to spawn and which ticket token to inject.

#### Scenario: An all-scope command runs once over every ticket

- **WHEN** a loop whose command is scope `all` is launched on a rail holding 3 tickets
- **THEN** exactly ONE run SHALL be launched
- **AND** the command SHALL receive all 3 ticket ids

#### Scenario: A per-ticket command runs once per ticket

- **WHEN** a loop whose command is scope `per-ticket` is launched on a rail holding 3 tickets
- **THEN** THREE runs SHALL be launched, one per ticket
- **AND** each run's command SHALL receive only its own ticket id
