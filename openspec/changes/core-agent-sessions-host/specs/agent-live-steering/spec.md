## ADDED Requirements

### Requirement: Native input reaches a Core session outside an open turn
For missions running on Core sessions, the system SHALL deliver user input to the existing Core session both during a turn and while only background sub-agents are running, preserving all existing receipt, queue and no-replay guarantees.

#### Scenario: Message while only background agents run
- **WHEN** the user sends a message to a conversation in the `background` phase
- **THEN** it MUST be sent to the same Core session as a new user turn
- **AND** its receipt MUST map Core input receipts onto the existing sent and received states
- **AND** live background sub-agents MUST NOT be terminated to deliver it

#### Scenario: Steer during a continuation turn
- **WHEN** the user steers a pending message while an agent-initiated continuation turn is open
- **THEN** the message MUST be delivered to the Core session as for a user turn

#### Scenario: Process retired before delivery
- **WHEN** a pending input was not accepted before its Core session was retired or its host was lost
- **THEN** it MUST keep an undelivered or unconfirmed status
- **AND** it MUST NOT be replayed automatically on the next session process
