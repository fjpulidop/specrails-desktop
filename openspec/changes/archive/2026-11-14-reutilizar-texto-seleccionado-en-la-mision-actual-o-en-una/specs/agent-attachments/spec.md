# Spec Delta

## MODIFIED Requirements

### Requirement: Attachment fold into the turn

`AgentChatManager.sendMessage` SHALL resolve the attachment ids to extracted text blocks and fold them into the prompt (before the pinned-project prefix), mirroring the Explore/chat fold, and SHALL append the attachment system note when attachments are present. Extraction failure SHALL degrade to a text-only turn rather than failing the send. For a fork without its own provider session, resolution SHALL also include deduplicated attachment IDs from inherited messages except those marked cancelled or interrupted. These inherited IDs SHALL NOT be attached to the new user message merely because they seed the session.

#### Scenario: Text blocks appear in the prompt
- **WHEN** a turn carries attachment ids that extract to text
- **THEN** the extracted text is folded into the prompt under an "Attached Resources" section

#### Scenario: Extraction failure degrades gracefully
- **WHEN** attachment extraction throws
- **THEN** the turn proceeds as a text-only turn and no error is surfaced to the user

#### Scenario: Fork starts an independent provider session
- **WHEN** a fork sends its first turn with copied historical attachments and no provider session
- **THEN** eligible inherited file contents are resolved from the fork's storage alongside current attachment IDs and its bounded history
- **AND** inherited interrupted/cancelled messages do not contribute files or history to that prompt
- **AND** inherited file IDs are not added to the new user message's attachment list

#### Scenario: Fork resumes its own session
- **WHEN** a later turn resumes the fork's provider session without new attachments
- **THEN** inherited attachments are not resolved again solely because they appear in copied history
