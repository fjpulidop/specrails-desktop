## ADDED Requirements

### Requirement: Active missions accept corrections at safe action boundaries
The system SHALL accept user follow-ups while a mission is active, queue them by default, and upon per-message Steer deliver them through native Claude/Codex input or the next available Specrails MCP boundary for other transports without terminating an already-running action.

#### Scenario: Correction before a tool starts
- **WHEN** a new user message is pending in an MCP-delivery invocation before an authenticated mission tool is dispatched
- **THEN** the requested action MUST NOT execute
- **AND** the agent MUST receive the correction and an explicit instruction to reconsider the action.

#### Scenario: Correction during an action
- **WHEN** a message arrives in an MCP-delivery invocation while an MCP handler is already running
- **THEN** the handler's outcome MUST be preserved
- **AND** the response MUST include the user update when ready.

#### Scenario: No safe action boundary
- **WHEN** the invocation ends with undelivered follow-ups
- **THEN** the manager SHALL continue with those inputs in FIFO order through the normal conversation continuation
- **AND** the UI MUST NOT claim that the message was delivered earlier.

#### Scenario: Agent is waiting for a rail or job
- **WHEN** a new input arrives while the owning mission is using specrails_watch
- **THEN** only the watch SHALL finish immediately with reason user_update
- **AND** the observed operation MUST remain running and its accumulated evidence MUST be preserved.

### Requirement: Steering is authenticated and protects against stale parallel actions
The system MUST bind steering to the exact live capability and database of the originating mission and require acknowledgement of delivered MCP revisions before subsequent actions. Native delivery SHALL use the provider receipt and MUST NOT inject another copy through the MCP broker.

#### Scenario: Parallel tool requests share an outdated plan
- **WHEN** one tool request receives a correction and other previously planned requests arrive
- **THEN** the other actions MUST remain blocked until the agent acknowledges the delivered revision.

#### Scenario: A newer message arrives before acknowledgement
- **WHEN** the agent acknowledges an earlier revision while a newer update exists
- **THEN** the acknowledgement MUST NOT release the newer revision's gate.

#### Scenario: Unrelated or revoked caller
- **WHEN** a tool call is external, belongs to another capability or database, or has been cancelled
- **THEN** it MUST NOT consume the mission's input or gain permission from that input.

### Requirement: Accepted input is durable and delivered once
The system SHALL preserve pending text, attachment IDs and scoped references, use stable correlation IDs and never automatically replay pending input after Stop or restart.

#### Scenario: Connection recovery
- **WHEN** the client reconnects during a running mission
- **THEN** an authoritative snapshot SHALL restore pending input and the active assistant segment without duplicates.

#### Scenario: Stop or restart before delivery
- **WHEN** a pending input has not reached the agent before Stop or process restart
- **THEN** its content MUST remain available with an undelivered status
- **AND** it MUST NOT launch work automatically.

#### Scenario: Duplicate submission or delivery
- **WHEN** HTTP retries or duplicate events carry an already-known input ID
- **THEN** the input MUST NOT be executed or rendered twice.

### Requirement: Transcript and composer represent live delivery honestly
The UI SHALL retain the chronology of assistant segments and user updates and distinguish pending delivery from delivery without claiming that an instruction was applied.

#### Scenario: Correction arrives after partial output
- **WHEN** an update is delivered after some assistant text has streamed
- **THEN** that assistant segment SHALL appear before the new user message
- **AND** later assistant output SHALL appear after it while tool activity and busy state remain intact.

#### Scenario: User types while the agent runs
- **WHEN** the composer contains a draft during an active mission
- **THEN** both Send and Stop SHALL remain available
- **AND** sending SHALL preserve attachments and repository references.

#### Scenario: Pending edit races delivery
- **WHEN** a message is delivered while the user edits it
- **THEN** the delivered text MUST remain immutable
- **AND** the user's unsaved edit SHALL remain recoverable as a draft.

### Requirement: Native provider input is accepted without waiting for Specrails tools
Claude and Codex mission transports SHALL expose input to the running provider and confirm delivery using its native protocol, retaining the original project, model and permissions.

#### Scenario: User sends while a native tool runs
- **WHEN** the user selects Steer for a pending message in an active Claude or Codex mission
- **THEN** the message SHALL be sent through the native input channel without requiring another Specrails tool call
- **AND** the running tool MUST NOT be terminated merely to deliver the update.

#### Scenario: Receipt and output arrive together
- **WHEN** native acknowledgement and subsequent output arrive in the same stream chunk
- **THEN** the transcript checkpoint and user message SHALL precede that subsequent output.

#### Scenario: Native write loses its acknowledgement
- **WHEN** an input was written but native receipt or local receipt persistence fails, including during Stop
- **THEN** it SHALL be preserved with unconfirmed delivery status
- **AND** neither a newer user message nor continuation/restart SHALL cause its automatic replay.

#### Scenario: Native turn closed before submission
- **WHEN** the provider confirms that an input was never accepted because its turn closed
- **THEN** ordinary FIFO continuation MAY deliver that pending input once.

### Requirement: Pending messages expose explicit delivery and editing controls
The mission transcript SHALL show Steer, delete and a menu with Edit for each queued input. Steer SHALL submit without interrupting the model. Unpromoted messages SHALL wait for normal continuation.

#### Scenario: User steers a selected message
- **WHEN** a user selects Steer on one pending message
- **THEN** only that message SHALL enter active delivery
- **AND** other pending inputs SHALL retain their queue order.

#### Scenario: Delete and delayed HTTP retry
- **WHEN** the user deletes an input before delivery owns it and the original POST is retried
- **THEN** the input SHALL remain removed, SHALL NOT create a transcript bubble and SHALL NOT execute.

#### Scenario: Pending edit preserves resources
- **WHEN** the user chooses Edit from the message menu and changes its text
- **THEN** its attachments and scoped references SHALL be retained
- **AND** an edit, delete or repeated promotion racing a claimed delivery SHALL NOT alter the provider input.

### Requirement: Message receipts distinguish transport acceptance from reading
Mission messages SHALL show one gray check for sent, two gray checks for received and two green checks for confirmed reading. Each icon SHALL expose a localized tooltip and accessible label. Reading SHALL NOT imply that the requested work is complete.

#### Scenario: Codex accepts a correction
- **WHEN** turn/steer acknowledges the active-turn input
- **THEN** the receipt SHALL indicate received
- **AND** later output alone SHALL NOT mark that correction read
- **AND** an explicit authenticated acknowledgement of the delivered queueId SHALL mark it read.

#### Scenario: Agent confirms reading
- **WHEN** the agent explicitly acknowledges delivered native input IDs or the exact delivered MCP revision
- **THEN** the corresponding input SHALL become read
- **AND** pending inputs or inputs from another invocation SHALL remain unchanged.

#### Scenario: Initial model input
- **WHEN** the provider accepts the initial prompt
- **THEN** its receipt SHALL indicate received
- **AND** reading SHALL require an explicit acknowledgement of its Mission input ID
- **AND** model output and synthetic provider notices alone SHALL NOT imply reading.

#### Scenario: Reload or delayed status
- **WHEN** the conversation reloads or a delayed event reports an earlier receipt
- **THEN** the highest persisted or observed receipt SHALL be retained
- **AND** legacy delivered inputs SHALL default to received, never inferred read.
