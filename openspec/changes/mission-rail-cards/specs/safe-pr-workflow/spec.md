## ADDED Requirements

### Requirement: The PR-decision card is the delivery phase of the run card
The mission PR-decision envelope SHALL carry optional run identity and runtime state (`runIds`, `railIndex`, `phase`, `runtime.failure`) so one card covers the whole run, and terminal failure states SHALL render their detail as text.

#### Scenario: Discarded shows the reason
- **WHEN** a delivery auto-closes as `discarded` because the launch failed
- **THEN** the card shows the stored `statusDetail` and status code instead of only "Discarded"

#### Scenario: Older clients ignore new fields
- **WHEN** a client without the run-card fields receives the envelope
- **THEN** it renders the delivery decision as before, because the `decision` vocabulary is unchanged
