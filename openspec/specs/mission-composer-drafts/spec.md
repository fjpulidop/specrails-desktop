# mission-composer-drafts Specification

## Purpose
TBD - created by archiving change mission-composer-clear-on-send. Update Purpose after archive.
## Requirements
### Requirement: The draft store is the single source of truth for the composer

The mission composer SHALL render the unsent draft held in the session draft store for its current draft key, and SHALL converge on that store whenever it changes. The visible value MUST NOT depend on a particular composer instance remaining mounted, so any mutation of a draft — clearing, migrating to a materialized mission, or restoring after a rejected send — SHALL be reflected by whichever composer is on screen for that key.

#### Scenario: A draft mutated while a different instance is mounted still converges

- **WHEN** a composer's draft is cleared or replaced in the store while the composer instance that initiated that mutation is no longer mounted
- **THEN** the composer currently mounted for that draft key MUST show the store's value
- **AND** it MUST NOT continue displaying a value it seeded at mount time

#### Scenario: Two surfaces showing the same draft agree

- **WHEN** more than one composer is mounted for the same draft key
- **THEN** all of them MUST show the same text, inline references and attachment chips
- **AND** a mutation from any of them MUST be visible in the others

### Requirement: Submitting a mission turn empties the composer immediately

Submitting an accepted mission turn SHALL clear the composer's text, inline references and attachment chips at submit time, before the outcome of the send is known. The composer MUST NOT keep the submitted text visible while the turn is being delivered.

#### Scenario: The box empties when the user bubble appears

- **WHEN** the user submits a mission turn
- **THEN** the composer MUST be empty as soon as the submitted message is rendered in the transcript or parked as a queued message
- **AND** it MUST NOT wait for the server to accept the turn before emptying

#### Scenario: First message of a new mission

- **WHEN** the user submits the first message from the empty compose screen, which materializes the mission and swaps the mounted composer
- **THEN** the composer shown after materialization MUST be empty
- **AND** the submitted text MUST NOT reappear in it at any point

#### Scenario: Submitted work is not double-counted

- **WHEN** the composer is emptied at submit time
- **THEN** the turn SHALL still carry the exact text, inline references and attachments that were present at submit
- **AND** clearing the composer MUST NOT alter what is delivered

### Requirement: A rejected send restores the submitted work intact

When a send is rejected — a transport failure, a mission that is not editable in this window, or a payload the client refuses — the composer SHALL restore the exact submitted payload: its text, its inline reference positions, its attachment chips, and the stable submission identity that makes a retry idempotent. Rejected work MUST NOT be silently discarded.

#### Scenario: Network failure returns the prompt

- **WHEN** a submitted turn fails to reach the server
- **THEN** the composer MUST show the submitted text again with its inline references at their original positions and its attachment chips present
- **AND** the user MUST be told the send failed

#### Scenario: Retrying a restored payload is still delivered once

- **WHEN** the user re-submits a payload that was restored after a rejection
- **THEN** the retry SHALL reuse the submission identity assigned to the original attempt
- **AND** a turn that was in fact accepted by the server MUST NOT be delivered twice

#### Scenario: A frozen mission does not consume the draft

- **WHEN** a send is refused because the mission is being edited in another window
- **THEN** the composer MUST retain the user's text and attachments

### Requirement: Clearing and restoring never overwrite newer work

Clearing after submit and restoring after rejection SHALL apply only to a draft slot that still holds the submitted payload. If the user typed a new draft, edited the references or attachments, or moved to another mission while the send was in flight, that newer state SHALL be preserved.

#### Scenario: Typing during an in-flight send

- **WHEN** the user starts typing the next prompt before the previous send settles
- **THEN** the newly typed draft MUST survive both the clear and any restore
- **AND** the previous payload MUST NOT be written over it

#### Scenario: Switching missions during an in-flight send

- **WHEN** the user switches to a different mission while a send is in flight
- **THEN** the target mission's own unsent draft MUST remain untouched
- **AND** the outcome of the in-flight send MUST NOT clear or populate it

### Requirement: Draft survival across unmounting is preserved

An unsent draft SHALL continue to survive the composer unmounting — Mission⇄Board switching, closing the panel, or a mission moving to a detached window — and SHALL be restored with its text, inline reference positions and attachment chips when a composer for that key mounts again.

#### Scenario: Mode switch keeps an unsent prompt

- **WHEN** the user types without sending and the composer unmounts
- **THEN** a composer mounted afterwards for the same draft key MUST show that prompt unchanged

#### Scenario: Materialization moves the draft to the new mission

- **WHEN** the empty compose screen materializes into a real mission
- **THEN** any unsent draft that was not submitted MUST become that mission's draft
- **AND** the empty compose screen MUST NOT keep a copy of it

### Requirement: The clearing contract is verified against the real mission surfaces

Automated coverage for the composer's clear-on-send behaviour SHALL exercise the surfaces users actually see — the Agent-Mode empty compose screen through materialization into the docked composer, and the floating panel — rather than a composer mounted in isolation, so that a change to how those surfaces mount the composer cannot leave the contract asserted but unmet.

#### Scenario: Coverage starts from the empty compose screen

- **WHEN** the clear-on-send behaviour is tested
- **THEN** at least one case MUST begin with no active mission, submit the first message, and assert the composer visible afterwards is empty

#### Scenario: Coverage spans both surfaces

- **WHEN** the clear-on-send behaviour is tested
- **THEN** both the Agent-Mode surface and the floating panel MUST be covered

