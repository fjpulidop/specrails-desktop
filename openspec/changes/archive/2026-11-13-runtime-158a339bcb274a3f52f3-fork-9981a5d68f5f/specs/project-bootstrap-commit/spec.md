# Spec Delta

## ADDED Requirements

### Requirement: Placeholder mission conversation on first commit
A successful Builder commit SHALL create exactly one empty mission conversation pinned to the newly created project, after the project is registered. The conversation MUST contain no AI turns, MUST NOT spend model tokens, and MUST use the project's primary provider with the default tier.

#### Scenario: First commit opens a conversation
- **WHEN** a blueprint commit succeeds for a new project
- **THEN** exactly one mission conversation pinned to that project exists
- **AND** it has no messages
- **AND** `blueprint.commit_done` carries its id as `missionConversationId`
- **AND** an `agent_conversation_created` event is broadcast

#### Scenario: Not pinned elsewhere
- **WHEN** the placeholder is created
- **THEN** no conversation is created for Home or any other project

### Requirement: Placeholder is created once per project
The commit SHALL NOT create a placeholder when any mission conversation, including a soft-deleted one, is already pinned to the project.

#### Scenario: Later commit for the same project
- **WHEN** a later commit runs for a project that already has a placeholder
- **THEN** no additional conversation is created
- **AND** the `placeholder` progress step reports it was skipped

#### Scenario: Deleted placeholder is not resurrected
- **WHEN** the user deleted the placeholder and another commit runs for that project
- **THEN** no conversation is created

### Requirement: Placeholder failures never fail the commit
A failure creating the placeholder SHALL be reported as a `warning` on the `placeholder` progress step and MUST NOT prevent `blueprint.commit_done`. A failed commit SHALL leave no conversation pinned to its project.

#### Scenario: Creation throws
- **WHEN** placeholder creation throws after the project is registered
- **THEN** the project remains created, a `placeholder` warning is emitted and `blueprint.commit_done` is broadcast

#### Scenario: Commit fails before registration
- **WHEN** any step before project registration fails
- **THEN** `blueprint.commit_failed` is broadcast and no conversation is created
