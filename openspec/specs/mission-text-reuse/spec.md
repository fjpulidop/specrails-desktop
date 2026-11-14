# mission-text-reuse Specification

## Purpose
Let users reuse committed mission conversation text in its source mission or prepare a separate mission with explicitly bounded context.

## Requirements

### Requirement: Selection actions target committed transcript text

The mission transcript SHALL offer Start a separate mission and Add to mission for a nonempty text selection wholly contained in committed messages of one transcript. A multi-message selection SHALL use the final message containing selected text as its fork boundary.

#### Scenario: Select across committed messages
- **WHEN** a selection covers text in multiple committed messages in one pane
- **THEN** the selection menu offers both actions and the last actually selected message becomes the boundary

#### Scenario: Endpoint touches the next message
- **WHEN** the range ends at offset zero of the next message
- **THEN** that next message is excluded from the boundary

#### Scenario: Unavailable selection
- **WHEN** selected text includes another pane, queued input or an uncommitted live tail
- **THEN** no mission selection action is offered for that range

### Requirement: Selection menu supports pointer and keyboard operation

The menu SHALL open after pointer selection, on right-click over a valid selection, and through ContextMenu or Shift+F10. It SHALL support arrow and Home/End navigation, Escape dismissal with focus restoration, and dismissal on outside pointer interaction, Tab, transcript scroll or resize.

#### Scenario: Keyboard operation
- **WHEN** the user presses Shift+F10 with a valid selection
- **THEN** the first menu action receives focus, arrows navigate actions, and Escape closes the menu and restores prior focus

### Requirement: Add selection to the captured source mission

Add to mission SHALL send the selected text through the captured source mission's normal send/queue path without consuming its composer draft. The menu SHALL prevent concurrent submissions and reuse its admission identity on a rejected-send retry. Sending SHALL be disabled for archived missions or while providers are unavailable.

#### Scenario: Focus changes after selection
- **WHEN** the user selects text, focus changes to another mission, and Add to mission is activated
- **THEN** the captured source send action receives the selection once and the original composer draft is retained

#### Scenario: Retry an uncertain send
- **WHEN** a send returns unaccepted and the user retries from the retained menu
- **THEN** the same selected text and admission identity are reused

#### Scenario: Archived source
- **WHEN** archived history is selected
- **THEN** separate-mission actions remain available and Add to mission is disabled

### Requirement: Prepare an unsent mission in an additional pane

Both separate-mission choices SHALL retain source provider, model, project pin, tier and effort settings. Success SHALL store only selected text as the new editable composer draft, open an additional split pane and focus its composer, without sending. Existing panes, source draft and source reading position SHALL be retained.

#### Scenario: Prepare from scratch
- **WHEN** From scratch is chosen for a valid source message
- **THEN** a mission with no inherited history or files is created through the existing conversation API, with selected text prepared for editing and later submission

#### Scenario: Preserve existing work
- **WHEN** either separate-mission action succeeds while other panes and a source draft exist
- **THEN** the new pane is appended, existing pane identities remain mounted and the source draft is unchanged

#### Scenario: Source message no longer exists
- **WHEN** the client cannot find the selected boundary message while preparing From scratch
- **THEN** it creates no new mission

### Requirement: Fork snapshots are inclusive and independent

A fork SHALL copy committed history through the named source message inclusive, retaining roles, text, timestamps, attachment references, context references, recorded card decisions and delivery status. It SHALL assign new message IDs and store source provenance, without sharing provider sessions, Core turn ownership or input admissions.

#### Scenario: Bound the snapshot
- **WHEN** a fork is created through a source assistant message with later messages and pending inputs
- **THEN** only history through that assistant message is copied, settings and provenance are retained, and no provider turn is started

#### Scenario: Interrupted history does not replay
- **WHEN** inherited history contains interrupted or cancelled messages
- **THEN** their recorded status is retained without creating replayable input admissions

### Requirement: Fork attachments are copied to independent storage

A fork SHALL copy only attachment IDs referenced by its included history, deduplicating references and preserving their conversation-scoped IDs. Copied files SHALL remain readable after source deletion. Copying SHALL reject unsafe identifiers, unsafe stored paths, source-as-target and existing destination attachment storage.

#### Scenario: Exclude unrelated uploads
- **WHEN** included messages reference one file and the source has later-message and unsent-draft uploads
- **THEN** only the referenced file is copied and remains readable after the source is deleted

#### Scenario: Refuse unsafe or occupied destinations
- **WHEN** a copy uses unsafe identifiers or stored paths, the source as target, or existing target attachment storage
- **THEN** the operation fails without overwriting existing files

### Requirement: Snapshot creation reports failure without a partial mission

The branch endpoint SHALL accept empty or fork mode and a source-owned boundary message, returning 201 with the created conversation without sending input. It SHALL return 400 for malformed requests, 404 for missing/trashed sources or missing/foreign boundary messages, and 409 with BRANCH_SNAPSHOT_FAILED on copy failure, rolling back the new mission and cleaning destination files.

#### Scenario: Copy failure
- **WHEN** an attachment is missing or history persistence fails
- **THEN** the endpoint returns 409, no new mission is retained or announced, and source history and files remain intact

#### Scenario: Invalid source boundary
- **WHEN** the boundary belongs to another conversation
- **THEN** the endpoint returns 404 and creates no mission

#### Scenario: Archived source remains branchable
- **WHEN** a valid archived source is used
- **THEN** snapshot creation remains available without altering its archive state

### Requirement: Failed fork preparation preserves user work

The client SHALL retain the selection menu and source draft when fork preparation fails, and SHALL create neither a draft nor a pane for a failed result. An unavailable snapshot endpoint SHALL display the shared endpoint-version error and SHALL NOT fall back to creating an empty mission.

#### Scenario: Older running server
- **WHEN** Fork receives an endpointUnavailable response
- **THEN** the version error is shown, the source draft and selection remain available, and no empty mission fallback is attempted

### Requirement: Inherited history cannot launch new actions

A fork SHALL display its source title, using an untitled fallback. Inherited assistant/system rows SHALL render in disabled fieldsets, inherited option shortcuts SHALL not submit replies, and inherited proposals and deliveries SHALL be excluded from the fork's active run strip.

#### Scenario: Inherited options and cards
- **WHEN** a fork displays an inherited assistant action card and options
- **THEN** the card is disabled, option shortcuts cannot send, and inherited work is not pinned as active work in the new mission
