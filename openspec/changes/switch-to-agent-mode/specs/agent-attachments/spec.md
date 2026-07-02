## ADDED Requirements

### Requirement: Agent composer attachment parity

The agent composer SHALL reach attachment parity with the Explore Add-Spec composer by adopting `RichAttachmentEditor`: file-pick, drag-drop, image-paste, @-mention pills, and backspace-to-remove. Attachments SHALL be uploaded before send and passed as an id list on the send call (pre-upload then ids). Attachments SHALL work for Home (null-project) conversations because storage is keyed by conversation id, not project.

#### Scenario: File attaches and rides the next send
- **WHEN** the user drops a supported file into the agent composer and sends a message
- **THEN** the file is uploaded, its id is included in the send payload, and it appears as a pill

#### Scenario: Attachments work without an active project
- **WHEN** a Home conversation (no pinned project) attaches a file
- **THEN** the upload succeeds against the conversation-keyed endpoint

#### Scenario: Removing a pill deletes the attachment
- **WHEN** the user backspaces a pill
- **THEN** the attachment is removed and a DELETE is issued to the agent attachment endpoint

### Requirement: Agent attachment endpoints and storage

The server SHALL expose `POST/GET/GET :attachmentId/DELETE /api/agent/conversations/:id/attachments`, gated by the agent-chat feature flag, mirroring the ticket attachment endpoints (multer single `file`, 25 MB cap, MIME allowlist). Files SHALL be stored under a distinct root `~/.specrails/agent/<conversationId>/attachments/` with path-traversal guards on the conversation id. Deleting a conversation SHALL remove its attachment directory.

#### Scenario: Upload returns the stored attachment
- **WHEN** a valid file is POSTed to a known conversation
- **THEN** the response is `201` with the attachment metadata and the file is stored under the agent root

#### Scenario: Oversized or wrong-type rejected
- **WHEN** a file exceeds 25 MB or has an unsupported MIME type
- **THEN** the endpoint responds `400` and stores nothing

#### Scenario: Traversal in conversation id rejected
- **WHEN** the conversation id contains path-traversal segments
- **THEN** the request is rejected and no path escapes the agent root

#### Scenario: Cleanup on conversation delete
- **WHEN** a conversation is deleted
- **THEN** its `~/.specrails/agent/<id>/` directory is removed

#### Scenario: Routes disabled when feature off
- **WHEN** `SPECRAILS_AGENT_CHAT` is false
- **THEN** the attachment routes respond `404`

### Requirement: Attachment persistence per turn

The `agent_messages` table SHALL persist the attachment id list for a user turn in a nullable `attachment_ids` JSON column (added by migration). Absent/null SHALL denote a text-only turn. On loading a conversation, the persisted ids SHALL be surfaced so the client can rehydrate pills.

#### Scenario: Historical turn re-renders attachments
- **WHEN** a conversation with an attachment-bearing turn is reloaded
- **THEN** the persisted attachment ids are returned and the pills re-render

#### Scenario: Text-only turn stores null
- **WHEN** a message is sent with no attachments
- **THEN** `attachment_ids` is null for that row

### Requirement: Attachment fold into the turn

`AgentChatManager.sendMessage` SHALL resolve the attachment ids to extracted text blocks and fold them into the prompt (before the pinned-project prefix), mirroring the Explore/chat fold, and SHALL append the attachment system note when attachments are present. Extraction failure SHALL degrade to a text-only turn rather than failing the send.

#### Scenario: Text blocks appear in the prompt
- **WHEN** a turn carries attachment ids that extract to text
- **THEN** the extracted text is folded into the prompt under an "Attached Resources" section

#### Scenario: Extraction failure degrades gracefully
- **WHEN** attachment extraction throws
- **THEN** the turn proceeds as a text-only turn and no error is surfaced to the user

### Requirement: Native image input

Providers SHALL declare `supportsImageInput` in their capabilities, and the composer SHALL gate the image affordance on that capability (never on provider id). For providers with a native image flag (codex `--image`, verified), image attachments SHALL be passed as absolute image paths via a `SpawnOptions.imagePaths` field threaded into the adapter's argv. Claude SHALL continue to receive images as `@<abs-path>` prompt refs. Gemini SHALL default `supportsImageInput` false until live-verified, disabling the image affordance for gemini conversations while text-extractable attachments remain enabled for all providers.

#### Scenario: Codex receives native image flags
- **WHEN** a codex turn carries image attachments
- **THEN** the spawn argv includes `--image <abs-path>` for each image

#### Scenario: Claude receives @path refs
- **WHEN** a claude turn carries image attachments
- **THEN** the images are referenced as `@<abs-path>` in the prompt and no `--image` flag is added

#### Scenario: Image affordance gated by capability
- **WHEN** the active provider has `supportsImageInput === false`
- **THEN** the composer hides the image attach affordance while still allowing text-extractable files

### Requirement: Agent turn metering

Agent turns SHALL be metered in `ai_invocations` with `surface='agent'` when the conversation is pinned to a project (so a project database exists). Unpinned Home turns SHALL be skipped (no `project_id`). A metered turn SHALL broadcast `spending.invalidated` for that project, and metering failure SHALL never break the turn.

#### Scenario: Pinned turn is metered
- **WHEN** a turn on a project-pinned conversation completes
- **THEN** one `ai_invocations` row with `surface='agent'` is written to that project's database and `spending.invalidated` is broadcast

#### Scenario: Home turn is not metered
- **WHEN** a turn on a null-pinned conversation completes
- **THEN** no `ai_invocations` row is written and no error occurs
