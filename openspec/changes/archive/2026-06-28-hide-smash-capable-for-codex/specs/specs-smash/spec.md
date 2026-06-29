## MODIFIED Requirements

### Requirement: SMASH action visibility gate

The system SHALL render the SMASH action affordance in `TicketDetailModal` only when ALL of the following are true: (a) the ticket's `status` is not `'draft'`, (b) the ticket's `description` contains a `## Contract Layer` block (matching the separator used by the contract-refine feature), (c) the ticket has `parent_epic_id === null` (children cannot themselves be SMASHed), (d) the hub-wide kill switch `SPECRAILS_SMASH` is not disabled, and (e) the project's provider is NOT `'codex'`.

When any of (a)–(e) is false, the SMASH button MUST be hidden entirely (not rendered greyed-out). When the button would be hidden specifically because of (b) (no Contract Layer), the UI MAY surface an inert tooltip or helper text guiding the user to generate a Contract Layer first.

**Note:** Condition (e) is a new addition in this change. Conditions (a)–(d) and all non-provider scenarios are unchanged from the prior version of this requirement.

#### Scenario: Draft ticket with Contract Layer
- **WHEN** user opens `TicketDetailModal` for a ticket with `status === 'draft'` and a `## Contract Layer` block
- **THEN** the SMASH button is not rendered

#### Scenario: Committed ticket without Contract Layer
- **WHEN** user opens `TicketDetailModal` for a ticket with `status === 'todo'` and no `## Contract Layer` block
- **THEN** the SMASH button is not rendered

#### Scenario: Committed ticket with Contract Layer, Claude project
- **WHEN** user opens `TicketDetailModal` for a ticket with `status === 'todo'` and a `## Contract Layer` block, no parent, kill switch off, and the project's provider is `'claude'`
- **THEN** the SMASH button is rendered in the secondary actions row alongside Refresh Contract

#### Scenario: Child ticket
- **WHEN** user opens `TicketDetailModal` for a ticket with `parent_epic_id !== null`
- **THEN** the SMASH button is not rendered, regardless of the ticket's Contract Layer presence

#### Scenario: Kill switch disabled
- **WHEN** the server is started with `SPECRAILS_SMASH=0` and a ticket meeting all other gate conditions is opened
- **THEN** the SMASH button is not rendered
