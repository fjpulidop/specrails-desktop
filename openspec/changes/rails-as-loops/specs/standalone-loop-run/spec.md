## ADDED Requirements

### Requirement: Ticket-need auto-detection

The system SHALL determine whether a loop "needs a ticket" by inspecting its graph: a loop needs a ticket iff it references `{{spec.*}}` tokens or a ticket-scoped `{{cmd:*}}` command. This determination SHALL drive where the loop is launchable — no manual scope field is required.

#### Scenario: A loop referencing spec tokens needs a ticket

- **WHEN** a loop's graph references `{{spec.id}}`, `{{spec.ids}}`, or a ticket-scoped command
- **THEN** the loop SHALL be classified as ticket-needing

#### Scenario: A loop with no spec/ticket references is ticket-less

- **WHEN** a loop's graph references no `{{spec.*}}` token and no ticket-scoped command (e.g. a CI-watch or repo-wide lint loop)
- **THEN** the loop SHALL be classified as ticket-less

### Requirement: Run a ticket-less loop from the Loops page

A ticket-less loop SHALL be launchable directly from the Loops page via a "Run" action that opens a modal collecting the run options (a required target **project**; the provider — defaulting to the project's primary and hidden when the project has a single provider; and reasoning effort when the provider supports it) and an **Execute** button. No ticket is required. On Execute the run SHALL launch against the chosen project (with `railIndex = null` / no ticket) and SHALL appear as a job in THAT project's Jobs history with a live log, exactly like any other loop run — its cost recorded via `ai_invocations` (`surface='loop'`, with `loop_run_id`) in that project. A cross-run/cross-project per-loop analytics rollup is OUT OF SCOPE for this change.

#### Scenario: Running a ticket-less loop standalone

- **WHEN** the user invokes "Run" on a ticket-less published loop, picks a target project in the modal, and presses Execute
- **THEN** a loop run SHALL launch against that project without requiring a ticket
- **AND** it SHALL appear in that project's Jobs history as a job with a live log
- **AND** its AI cost SHALL be recorded in that project (`ai_invocations` `surface='loop'`)

#### Scenario: Ticket-less loops are not forced onto a rail

- **WHEN** a user wants to run a ticket-less loop
- **THEN** they SHALL NOT be required to drag a ticket onto a rail to launch it

### Requirement: Launch surface matches ticket-need

A ticket-needing loop SHALL be selectable on a rail (and require ≥1 ticket); a ticket-less loop SHALL expose the Loops-page "Run" action. The rail Loop picker SHALL list ticket-needing loops; the standalone "Run" SHALL be available for ticket-less loops.

#### Scenario: Ticket-needing loop requires a ticket on the rail

- **WHEN** a ticket-needing loop is selected on a rail with zero tickets
- **THEN** launch SHALL be blocked until at least one ticket is added

#### Scenario: Ticket-less loop offers standalone Run

- **WHEN** a ticket-less loop is shown in the Loops gallery
- **THEN** it SHALL expose a "Run" action that launches without a rail or ticket
