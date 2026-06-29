## ADDED Requirements

### Requirement: Built-in factory loops

The app SHALL ship built-in "factory" loops for `implement`, `batch`, and `ultracode`. They SHALL appear in the Loops gallery alongside user loops, marked read-only (locked), and SHALL NOT be editable in place. A "Fork to edit" action SHALL clone a factory loop into a new editable user draft, leaving the original unchanged.

#### Scenario: Factory loops are listed and locked

- **WHEN** the Loops gallery is opened
- **THEN** the `implement`, `batch`, and `ultracode` factory loops SHALL be listed as read-only (locked)
- **AND** they SHALL NOT expose Edit / Delete / Publish actions

#### Scenario: Forking a factory loop

- **WHEN** the user invokes "Fork to edit" on a factory loop
- **THEN** a new editable user loop SHALL be created as a clone of the factory loop's graph in `Draft` state
- **AND** the original factory loop SHALL remain unchanged

### Requirement: Catalog commands for batch and ultracode

The loop command catalog SHALL expose `{{cmd:batch}}` (the native specrails-core `batch-implement` slash command, resolved per provider like `{{cmd:implement}}`) and `{{cmd:ultracode}}` (a native/raw autonomous command — NOT a slash command).

#### Scenario: batch expands to the native batch-implement command

- **WHEN** `{{cmd:batch}}` is expanded for the claude provider with rail tickets 1 and 2
- **THEN** the result SHALL be the native `batch-implement` invocation over those tickets (`/specrails:batch-implement #1 #2 --yes`)
- **AND** for codex it SHALL use the `$batch-implement` skill form

#### Scenario: ultracode expands to the raw autonomous prompt

- **WHEN** `{{cmd:ultracode}}` is expanded
- **THEN** it SHALL produce the raw autonomous prompt (the same shape the existing ultracode path builds), NOT a `/specrails:` slash command

### Requirement: Command-declared ticket scope

Each catalog command SHALL declare a ticket scope of `all` (all the rail's tickets handled in ONE run) or `per-ticket` (one run per ticket). `implement` and `batch` SHALL be `all`; `ultracode` SHALL be `per-ticket`. The launch path SHALL read the command's scope to decide how many runs to spawn and which ticket token to inject.

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
