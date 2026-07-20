# explore-spec Specification

## Purpose
TBD - created by archiving change add-explore-spec-mode. Update Purpose after archive.
## Requirements
### Requirement: Two-mode segmented control in Add Spec
The `Add Spec` modal SHALL render a segmented control with exactly two modes — `Quick` and `Explore` — and SHALL NOT render the legacy `Explore codebase` checkbox. `Quick` MUST be selected by default. The user's mode choice MUST persist for the duration of the modal session and reset when the modal closes.

#### Scenario: Quick is the default
- **WHEN** the user opens the Add Spec modal
- **THEN** the `Quick` mode is selected
- **AND** the legacy `Explore codebase` checkbox is not present anywhere in the modal

#### Scenario: Switching mode preserves the typed idea
- **WHEN** the user types text in the composer and switches between `Quick` and `Explore`
- **THEN** the typed text is preserved
- **AND** the submit button label updates to reflect the selected mode (`Generate Spec` for Quick, `Continue` for Explore)

#### Scenario: Modal close resets mode
- **WHEN** the user closes the modal in Explore mode and reopens it
- **THEN** the modal opens in Quick mode again

### Requirement: Quick mode preserves existing fast-path behaviour
The `Quick` mode SHALL behave identically to the current default `Generate Spec` flow: the user's idea, any attachments, and the model selected in the Add Spec model picker are sent to `POST /api/projects/:projectId/tickets/generate-spec`, the modal closes, and a toast tracks generation progress until the new ticket appears.

#### Scenario: Quick submits to generate-spec
- **WHEN** the user types an idea in Quick mode and clicks `Generate Spec`
- **THEN** the modal closes
- **AND** a `POST /api/projects/<id>/tickets/generate-spec` is sent with `{ idea, attachmentIds, pendingSpecId, model }`
- **AND** a loading toast is shown until the ticket is generated

#### Scenario: Quick supports attachments
- **WHEN** the user attaches a file in Quick mode and submits
- **THEN** the attachment ids are included in the request payload
- **AND** the attachments are bound to the new ticket on success

#### Scenario: Quick forwards selected model
- **WHEN** the user picks a non-default model in the Add Spec picker and submits in Quick mode
- **THEN** the request body's `model` field equals the picker's selected value

### Requirement: Explore mode opens a full-screen overlay shell
Selecting `Explore` and submitting the initial idea SHALL replace the modal with a full-screen overlay using the same visual language as `AI Edit`: eyebrow `EXPLORE SPEC · interactive`, headline copy, two-column layout (conversation left, draft right), composer at the bottom with optional chip row, header back-arrow and close button.

#### Scenario: Initial idea becomes first user message
- **WHEN** the user types `dark mode toggle` in Explore mode and clicks `Continue`
- **THEN** the modal is replaced by the Explore Spec overlay
- **AND** `dark mode toggle` appears as the first user turn in the conversation history
- **AND** Claude's response begins streaming within 2 seconds of overlay mount

#### Scenario: Header chrome matches AI Edit
- **WHEN** the overlay is open
- **THEN** the header shows a back arrow on the left, `EXPLORE SPEC · interactive` eyebrow, and a close `✕` on the right
- **AND** the layout reserves space for macOS native traffic-light controls when running under Tauri on macOS

#### Scenario: Two-column layout
- **WHEN** the overlay is open with at least one assistant turn complete
- **THEN** the left column shows the conversation as a vertical scroll of user/assistant turn bubbles
- **AND** the right column shows the structured draft fields
- **AND** the composer is anchored at the bottom of the left column

### Requirement: Structured draft panel with editable fields
The right column SHALL render the live draft as discrete editable controls covering: `title` (text input), `priority` (select with `low | medium | high | critical`), `labels` (chip multi-add/remove), `description` (multi-line textarea), `acceptanceCriteria` (bulleted list with add/remove). Every field MUST be editable by the user at any moment. Field changes pushed by Claude MUST animate (200ms background flash) only on the modified field.

#### Scenario: Manual edit persists across Claude updates
- **WHEN** the user types `low` in the priority select while the latest Claude turn proposed `high`, and then sends another user message and Claude responds again with `priority: high` in its draft block
- **THEN** between user message N and Claude turn N+1 the user's `low` value remains visible
- **AND** after the user sends message N+1, Claude's next draft update may overwrite `priority` if it does so explicitly

#### Scenario: Claude update animates only changed fields
- **WHEN** Claude's turn produces a draft block changing `description` only
- **THEN** the description textarea bg flashes for 200ms
- **AND** other fields do not animate

#### Scenario: All fields independently editable
- **WHEN** the user clicks any field while the assistant is streaming
- **THEN** the field accepts input
- **AND** the streaming continues unaffected on the left

### Requirement: Fenced spec-draft block protocol
The app SHALL recognise a fenced code block tagged ` ```spec-draft ` in any assistant message produced during an Explore conversation and MUST parse the JSON payload, broadcast a `spec_draft.update` WebSocket event with the merged draft, and remove the block from the chat content delivered to clients.

#### Scenario: Valid block updates the draft and is stripped
- **WHEN** the assistant turn body contains a valid `spec-draft` block with `{ "title": "X", "ready": false }`
- **THEN** the chat content broadcast to the WS strips the entire fenced block
- **AND** a `spec_draft.update` message is broadcast to subscribers with the merged draft including `title: "X"` and `ready: false`

#### Scenario: Invalid JSON is ignored without crash
- **WHEN** the assistant turn contains a block with malformed JSON
- **THEN** the block is treated as plain text in the chat content
- **AND** no `spec_draft.update` event is emitted for that turn
- **AND** a server warning is logged with the conversation id

#### Scenario: Unknown fields are dropped
- **WHEN** the block contains `{ "title": "X", "foo": "bar", "priority": "weird" }`
- **THEN** `title: "X"` is merged into the draft
- **AND** the unknown `foo` field is dropped silently
- **AND** the invalid `priority` value is dropped silently and the prior priority is retained

#### Scenario: Empty strings are treated as no-op
- **WHEN** the block contains `{ "title": "", "description": "Updated text" }`
- **THEN** the draft `title` is unchanged
- **AND** the draft `description` is set to `"Updated text"`

#### Scenario: Arrays replace, not append
- **WHEN** the prior draft has `labels: ["ui"]` and the new block has `labels: ["ui", "theme"]`
- **THEN** the merged draft has `labels: ["ui", "theme"]`
- **AND** when a subsequent block has `labels: []` the merged draft has `labels: []`

### Requirement: Always-available Create Spec action
The overlay SHALL render a `Create Spec` action that is enabled the moment the draft has a non-empty `title`. The action MUST visually amplify (filled primary background plus a soft pulse animation) when the latest draft block reports `ready: true`. The action MUST be disabled when `title` is empty or only whitespace. There MUST be no auto-create behaviour.

#### Scenario: Disabled before title exists
- **WHEN** the draft has no title and Claude has not yet produced one
- **THEN** the `Create Spec` button is rendered disabled with a subtle hint that a title is required

#### Scenario: Available as soon as title appears
- **WHEN** Claude's first draft block sets a non-empty `title`
- **THEN** the button is enabled in its outline (non-amplified) appearance

#### Scenario: Amplified on ready true
- **WHEN** the latest assistant turn emits a draft block with `ready: true`
- **THEN** the button switches to filled primary background with a continuous soft pulse
- **AND** a small banner `✦ Draft ready` is shown above the button

#### Scenario: User commits at any time
- **WHEN** the user clicks the button while it is enabled
- **THEN** the current draft is committed via the from-draft endpoint and the overlay closes regardless of `ready` state

### Requirement: Commit endpoint for structured draft
The app SHALL expose `POST /api/projects/:projectId/tickets/from-draft` that accepts `{ title, description, labels, priority, acceptanceCriteria }`, validates the payload, inserts the ticket into the project's `local-tickets.json` directly without invoking any LLM generation, and returns the inserted ticket. The route MUST reject empty or whitespace-only `title` with HTTP 400.

#### Scenario: Successful commit returns the ticket
- **WHEN** the client posts a valid draft to `from-draft`
- **THEN** the server inserts a new ticket with the supplied fields
- **AND** responds 200 with the inserted ticket including its assigned numeric `id` and `source: "propose-spec"`

#### Scenario: Empty title rejected
- **WHEN** the client posts `{ title: "  ", description: "..." }`
- **THEN** the server responds 400 with an error message identifying the missing title
- **AND** no ticket is inserted

#### Scenario: Invalid priority normalised
- **WHEN** the payload contains `priority: "weird"` and other valid fields
- **THEN** the server defaults `priority` to `"medium"` and inserts the ticket
- **AND** the response reflects the normalised priority

#### Scenario: Labels and criteria default to empty
- **WHEN** the payload omits `labels` and `acceptanceCriteria`
- **THEN** the inserted ticket has `labels: []` and `acceptanceCriteria: []`

### Requirement: Slash command and system prompt for explore-spec
The app SHALL provide a slash command `/specrails:explore-spec` whose body instructs Claude to (1) act as an interactive thinking partner, (2) ask only the questions necessary to clarify scope, (3) maintain a structured draft via fenced ` ```spec-draft ` JSON blocks, (4) set `ready: true` in the block when the draft is in good enough shape to commit, and (5) never create a ticket itself. The command body MUST include at least two few-shot examples showing the fenced-block convention.

#### Scenario: Explore submit invokes the slash command
- **WHEN** the Explore overlay mounts with the user's initial idea
- **THEN** the chat is started with a prompt that begins with `/specrails:explore-spec` and includes the user's idea as the message body

#### Scenario: System prompt forbids self-creation
- **WHEN** Claude is operating under the `/specrails:explore-spec` prompt
- **THEN** the prompt explicitly tells the model that the app will commit the ticket and the model MUST NOT call any ticket-creation slash command or write to `local-tickets.json`

### Requirement: Conversation-scoped state with stateless lifecycle
The Explore overlay SHALL maintain conversation and draft state for the lifetime of a single overlay session. Closing the overlay (X, back-arrow, or Esc) SHALL discard the conversation and the draft. There MUST be no persistence across overlay sessions.

#### Scenario: Close discards everything
- **WHEN** the user closes the overlay after 4 turns
- **THEN** no records of the conversation or draft remain in client memory
- **AND** reopening Explore from the modal starts a fresh conversation with no prior context

#### Scenario: Confirm-discard guard on non-empty conversation
- **WHEN** the user attempts to close the overlay (X, back-arrow, or Esc) with at least one assistant turn beyond the initial user idea
- **THEN** a confirmation dialog appears with `Discard conversation?` and a destructive primary action
- **AND** dismissing the dialog returns to the overlay
- **AND** confirming closes the overlay and discards state

#### Scenario: No confirm on bare-initial overlay
- **WHEN** the user closes the overlay before Claude's first response
- **THEN** the overlay closes without a confirmation dialog

### Requirement: Draft pane suggested chips
The Explore overlay SHALL render up to three quick-reply chips above the composer when the latest assistant turn includes a `chips` array in its `spec-draft` block. Clicking a chip SHALL send its text as the next user message immediately. When no chips are provided by the latest turn, the chip row MUST NOT render any fallback chips.

#### Scenario: Chips render and submit
- **WHEN** the assistant turn emits `chips: ["Looks good — create", "Smaller scope"]`
- **THEN** two chips render above the composer
- **AND** clicking `Looks good — create` sends that string as the next user message

#### Scenario: No fallback chips
- **WHEN** the assistant turn omits the `chips` field
- **THEN** the chip row is not rendered

#### Scenario: Chips capped at three
- **WHEN** the assistant turn emits four chip strings
- **THEN** only the first three are rendered

### Requirement: Streaming defers draft updates to turn end
While an assistant turn is streaming the draft pane SHALL NOT update mid-stream. Draft updates MUST only apply once the assistant turn completes and the fenced block is parsed end-to-end. The pane MAY render a subtle "draft updating…" hint when the streaming text contains the start delimiter ` ```spec-draft `.

#### Scenario: No partial update mid-stream
- **WHEN** an assistant turn streams text that includes the start of a `spec-draft` block but the turn has not finished
- **THEN** the draft fields do not change
- **AND** an "updating…" hint may appear above the title field

#### Scenario: Update applies on turn complete
- **WHEN** the streaming turn completes with a fully formed `spec-draft` block
- **THEN** the draft updates and any changed fields animate
- **AND** the "updating…" hint disappears

### Requirement: Explore launch payload carries the selected model

The Explore launch handoff (the `onExploreLaunch` payload from the Add Spec modal to the parent that owns `ExploreSpecShell`) SHALL include the model selected in the Add Spec picker as `model: string`. The Explore conversation MUST be created with that model as its `model` field, and the model MUST remain fixed for every assistant turn in that conversation for the lifetime of the conversation.

#### Scenario: Payload includes model
- **WHEN** the user picks `opus` and clicks `Continue` in Explore mode
- **THEN** the `ExploreLaunchPayload` passed to `onExploreLaunch` includes `model: "opus"`

#### Scenario: Conversation seeded with chosen model
- **WHEN** the Explore conversation is created from the launch payload
- **THEN** the persisted conversation row's `model` equals the launch payload's `model`

#### Scenario: Subsequent turns reuse the seeded model
- **GIVEN** an Explore conversation seeded with `model: "haiku"`
- **WHEN** the user sends additional messages
- **THEN** every assistant turn is generated using `haiku`
- **AND** no UI surface changes the conversation's model mid-flow

### Requirement: ExploreSpec shell can be minimized to the dock

The ExploreSpec full-screen overlay SHALL expose a minimize control in its header, distinct from the existing back arrow and close (`×`) buttons. Activating the minimize control MUST hide the overlay without unmounting it, register a chip in the global minimized chats dock, and never trigger the discard-confirm dialog.

#### Scenario: Minimize hides overlay and adds chip
- **WHEN** the user clicks the minimize control on an ExploreSpec overlay with a non-empty composer
- **THEN** the overlay is hidden from the viewport
- **AND** a chip appears in the global minimized chats dock with the current draft title (or "Untitled spec" when empty) as its label
- **AND** no discard-confirm dialog is shown

#### Scenario: Restore from chip preserves all state
- **WHEN** the user clicks the chip for a previously minimized ExploreSpec session
- **THEN** the active project switches to the session's owning project (if different)
- **AND** the application navigates to the spec proposal entry route
- **AND** the overlay is shown with the same conversation history, draft fields, composer text, attachments, streaming state, and discard-confirm pending state as before minimize

#### Scenario: ExploreSpec shell hoisted out of ProposeSpecModal
- **WHEN** an ExploreSpec session is active and the user closes `ProposeSpecModal`
- **THEN** the ExploreSpec shell remains mounted (in the global minimized chats provider's hidden host)
- **AND** the session is added to the dock as a chip if it wasn't already visible there

### Requirement: ExploreSpec shell exposes a Save as Draft action

`ExploreSpecShell` SHALL render a `Save as Draft` action in its header (or equivalent persistent control surface), distinct from the back arrow, the minimize control, the close (`×`) button, and the existing `Create Spec` action. Activating the action MUST persist the current Explore session as a ticket with `status='draft'` and `origin_conversation_id` equal to the session's conversation id, and MUST close the shell without triggering the discard-confirm dialog. The action MUST be available whenever the conversation has at least one user-submitted turn.

#### Scenario: Save as Draft persists a draft ticket
- **WHEN** the user clicks `Save as Draft` on an Explore session whose conversation id is `C` and that has at least one user-submitted turn
- **THEN** a ticket is created with `status='draft'` and `origin_conversation_id = C`
- **AND** the shell closes
- **AND** no discard-confirm dialog is shown

#### Scenario: Save as Draft is disabled before the user has spoken
- **WHEN** the user opens an Explore session and has not yet submitted any turn
- **THEN** the `Save as Draft` action is disabled (or hidden)

#### Scenario: Save as Draft reuses the existing draft ticket on a resumed session
- **WHEN** the user opened the session via `Continue Explore` from an existing draft ticket `T`
- **AND** the user clicks `Save as Draft`
- **THEN** the existing ticket `T` is updated in place (its title may be regenerated only if previously empty; `origin_conversation_id` is preserved)
- **AND** no second draft ticket is created

### Requirement: Auto-title is generated when saving a draft without a title

When the server receives a save-as-draft request and no human-meaningful title has been produced for the conversation yet, it SHALL generate a non-empty title from the conversation transcript before persisting the ticket. The generated title MUST be a meaningful, single-line string suitable for display on the board card. The user MAY edit the title after saving via the existing ticket-edit affordances.

#### Scenario: Empty-title save produces a generated title
- **WHEN** the server receives a save-as-draft request whose payload has no title or an empty title
- **AND** the conversation has at least one user-submitted turn
- **THEN** the persisted ticket has a non-empty single-line title

#### Scenario: User-provided title is honoured verbatim
- **WHEN** the server receives a save-as-draft request whose payload contains a non-empty title
- **THEN** the persisted ticket's title equals the provided value

#### Scenario: Auto-title fallback when summarization fails
- **WHEN** the auto-title generator fails or times out
- **THEN** the server falls back to a deterministic title derived from the first user-submitted turn
- **AND** the request still succeeds with a non-empty title

### Requirement: Close-without-commit prompts the user with Save / Discard / Cancel

When the user attempts to close `ExploreSpecShell` (via Esc, the close `×` button, or any equivalent gesture) while the conversation has unsaved content and the session is NOT a no-op resume of an unchanged draft, the shell SHALL present a three-way prompt: `Save as Draft`, `Discard`, and `Cancel`. `Save as Draft` MUST be the default-focused action. `Discard` MUST retain the existing destructive-confirm semantics (the conversation is removed). `Cancel` MUST keep the shell open without persisting anything. The minimize control MUST NOT trigger this prompt.

#### Scenario: Close on a dirty session shows the three-way prompt
- **WHEN** the user closes the shell on a session with unsaved content
- **THEN** a prompt appears with `Save as Draft`, `Discard`, and `Cancel`
- **AND** `Save as Draft` is the default-focused action

#### Scenario: Save as Draft from the close prompt persists and closes
- **WHEN** the user activates `Save as Draft` from the close prompt
- **THEN** the session is persisted as a draft ticket
- **AND** the shell closes

#### Scenario: Discard from the close prompt removes the conversation
- **WHEN** the user activates `Discard` from the close prompt
- **THEN** the conversation is removed and the shell closes
- **AND** no draft ticket is created

#### Scenario: Cancel keeps the shell open
- **WHEN** the user activates `Cancel` from the close prompt
- **THEN** the shell remains open and the session is unchanged

#### Scenario: Minimize bypasses the prompt
- **WHEN** the user activates the minimize control on a dirty session
- **THEN** the existing minimize-to-toast behaviour fires
- **AND** the three-way close prompt is not shown

### Requirement: Continue Explore reopens the shell from a draft ticket

When `ExploreSpecShell` is opened with a `resumeConversationId` corresponding to a draft ticket (i.e., the conversation is the `origin_conversation_id` of a ticket with `status='draft'`), the shell SHALL hydrate the session with the persisted conversation history, draft fields, attachments, and streaming state. The ticket's `status` MUST remain `draft` while the resumed session is active. The Save as Draft action and the close-prompt flow defined above MUST apply to the resumed session.

#### Scenario: Resume hydrates conversation state
- **WHEN** the shell opens with a `resumeConversationId` that points to a draft ticket's `origin_conversation_id`
- **THEN** the conversation history, draft fields, attachments, and streaming state are restored from the server

#### Scenario: Status stays draft during resumed session
- **WHEN** the user is exploring inside a resumed draft session
- **THEN** the underlying ticket's `status` remains `draft`
- **AND** the ticket continues to render with the draft visual treatment on the board

#### Scenario: Save during resumed session updates the existing ticket
- **WHEN** the user activates `Save as Draft` (explicit button or close-prompt) on a resumed session
- **THEN** the existing draft ticket is updated in place
- **AND** no new ticket is created

### Requirement: Commit endpoint flips an existing draft ticket in place

When the user invokes the existing `Create Spec` action (which calls `POST /tickets/from-draft`) and the source is a draft ticket, the server SHALL update the existing ticket row instead of creating a new one. The transition MUST set `status` to the configured initial active status (e.g., `todo`), set a non-null `priority`, update title/description/spec body to the final values, and preserve `origin_conversation_id`. When the source is not a draft ticket (legacy callsite), the previous insert behaviour MUST be preserved.

#### Scenario: Commit transitions the draft ticket in place
- **WHEN** the user activates `Create Spec` on a session originating from draft ticket `T`
- **THEN** the row for `T` is updated with `status` set to the initial active status, a non-null `priority`, and the final title/description/spec content
- **AND** `T.origin_conversation_id` retains the conversation id it had while in draft
- **AND** no second ticket is created

#### Scenario: Legacy commit path still creates a new ticket
- **WHEN** the existing `from-draft` endpoint is called with a payload that does not reference a draft ticket
- **THEN** a new ticket is created with the previous (pre-change) behaviour

#### Scenario: Commit rejects when priority cannot be resolved
- **WHEN** a commit request from a draft ticket arrives with no `priority` and the draft has `priority IS NULL`
- **THEN** the server rejects the request with a 400-class error
- **AND** the ticket remains `status='draft'`

### Requirement: Explore turns spawn from an app-managed cwd by default

Every Explore conversation turn (chat conversations with `kind='explore'`) SHALL spawn `claude` with `cwd` selected by the conversation's `contextScope.mcp` flag. When `contextScope.mcp` is `true` the spawn cwd MUST be resolved through the relocate-artifacts gate: the project WORKSPACE for a relocated project (where `.mcp.json` and `.specrails/` live after relocation), `<project.path>` for a legacy project. Otherwise it MUST be `~/.specrails/projects/<slug>/explore-cwd/`. The app-managed cwd MUST contain an app-owned `CLAUDE.md` and a symlink `./project` (junction on Windows) pointing at the project's absolute path. The user's `<project>/CLAUDE.md` MUST NOT be modified, moved, deleted, or referenced by the spawn cwd in any way. An Explore turn MUST NOT spawn with a cwd that resolves the ticket-store instruction (`.specrails/local-tickets.json`) into a relocated project's repo. If a spawn-per-turn or persistent-stdin resume for a relocated Explore conversation that was routed to its workspace fails with the exact provider diagnostic `No conversation found with session ID`, the app MUST retry that turn at most once as a fresh invocation from the workspace, MUST NOT retry it from the repo, MUST invalidate the known-bad stored session id, and MUST preserve continuity using bounded persisted conversation context rather than an unbounded transcript. No other failure SHALL activate this compatibility retry; persistent-stdin recovery MUST replace only the stale child and otherwise retain the transport's lifecycle semantics. A workspace-routed Contract Refine resume that encounters the same exact diagnostic MUST retry at most once as a fresh workspace invocation with tools disabled and the target ticket context seeded into its prompt; it MUST NOT retry from the repo. The conversation's stored `contextScope.mcp` MUST be set at creation time exclusively from the Add Spec modal's `Project MCPs` toggle (or the active preset). The app MUST NOT consult any project-level setting when initialising or interpreting `contextScope.mcp`. Legacy conversations whose `context_scope` is `null` or missing the `mcp` field MUST be treated as `mcp: false` (spawn from app-managed cwd). `SPECRAILS_EXPLORE_LEGACY_CWD=1` MUST keep forcing `<project.path>` for every Explore spawn regardless of `contextScope.mcp` or relocation state.

#### Scenario: contextScope.mcp false uses app-managed cwd

- **WHEN** an Explore turn fires and the conversation's `contextScope.mcp` is `false`
- **THEN** `claude` is spawned with `cwd` equal to `~/.specrails/projects/<slug>/explore-cwd/`
- **AND** that directory contains an app-owned `CLAUDE.md` file
- **AND** that directory contains a `project` entry that resolves to the project's absolute path

#### Scenario: contextScope.mcp true uses project cwd on a legacy project

- **WHEN** an Explore turn fires for a non-relocated project and the conversation's `contextScope.mcp` is `true`
- **THEN** `claude` is spawned with `cwd` equal to `<project.path>`
- **AND** the app-managed `explore-cwd/` directory is not used for that turn

#### Scenario: contextScope.mcp true uses the workspace on a relocated project

- **WHEN** an Explore turn fires for a relocated project (registry entry present AND workspace populated) and the conversation's `contextScope.mcp` is `true`
- **THEN** `claude` is spawned with `cwd` equal to the project's workspace directory
- **AND** the cwd-relative ticket store resolves to `<workspace>/.specrails/local-tickets.json`, never `<project.path>/.specrails/local-tickets.json`

#### Scenario: Pre-existing relocated Explore session is recovered without returning to the repo

- **GIVEN** an MCP-enabled Explore conversation whose Claude session was created under the pre-relocation repo cwd
- **WHEN** its spawn-per-turn `--resume` from the relocated workspace fails with `No conversation found with session ID`
- **THEN** the app retries the current turn exactly once as a fresh invocation from the workspace and without `--resume`
- **AND** the retry cwd is never `<project.path>`
- **AND** the fresh prompt carries a bounded excerpt of persisted conversation context plus the current user turn
- **AND** a different provider error, or failure of the fresh retry, does not trigger another compatibility retry
- **AND** persistent-stdin resumes use the same one-time recovery by replacing only the stale child and otherwise retain their existing transport and lifecycle behaviour

#### Scenario: Contract Refine recovers an unavailable pre-existing Explore session

- **GIVEN** Contract Refine targets a ticket from a relocated Explore conversation whose prior Claude session is unavailable from the workspace
- **WHEN** its `--resume` attempt fails with `No conversation found with session ID`
- **THEN** it retries exactly once as a fresh invocation from the workspace, never from `<project.path>`
- **AND** the fresh invocation does not use `--resume`, keeps tools disabled, and is seeded with the target ticket context
- **AND** a different provider error, or failure of the fresh retry, does not trigger another compatibility retry

#### Scenario: Project CLAUDE.md is never touched

- **WHEN** an Explore conversation is created, run, resumed, minimized, restored, or closed
- **THEN** the file `<project.path>/CLAUDE.md` is not modified, moved, or deleted by the app
- **AND** the app-managed `explore-cwd/CLAUDE.md` is a separate file with app-owned content

#### Scenario: Legacy null scope defaults to app-managed cwd

- **GIVEN** an Explore conversation row whose stored `context_scope` is `null` or lacks the `mcp` field
- **WHEN** a turn fires for that conversation
- **THEN** `claude` is spawned with `cwd` equal to `~/.specrails/projects/<slug>/explore-cwd/`

### Requirement: Explore-cwd lifecycle is app-managed

The app SHALL ensure the per-project `explore-cwd/` directory exists, contains an up-to-date app-owned `CLAUDE.md`, and exposes a `./project` link to the project path before any Explore turn spawns from it. The directory MUST be created lazily on first use rather than eagerly at server start. When a project is removed via `ProjectRegistry.removeProject`, the directory MUST be removed recursively (the `./project` link MUST be unlinked, not followed). When the app version changes, the embedded `CLAUDE.md` content MUST be re-materialised on next use so the on-disk file matches the embedded template. The symlink MUST be recreated when the project's path has changed since last use.

#### Scenario: First Explore turn materialises the cwd

- **WHEN** a project sends its first ever Explore turn
- **THEN** `~/.specrails/projects/<slug>/explore-cwd/` is created
- **AND** `CLAUDE.md` is written from the embedded template
- **AND** `project` link is created pointing at `<project.path>`

#### Scenario: Project removal cleans up

- **WHEN** the project is removed from the app registry
- **THEN** `~/.specrails/projects/<slug>/explore-cwd/` no longer exists
- **AND** any active Explore spawn for that project is terminated

#### Scenario: App version bump refreshes the template

- **WHEN** the app starts after an upgrade and the next Explore turn fires
- **THEN** `explore-cwd/CLAUDE.md` is rewritten from the new embedded template
- **AND** the rewrite happens before the spawn

#### Scenario: Project path change triggers symlink recreation

- **WHEN** the registered project path differs from the symlink target on the next Explore turn
- **THEN** the existing `project` link is replaced with a fresh link to the current path
- **AND** the spawn proceeds with the corrected link in place

### Requirement: Explore system prompt is byte-stable across turns

The system prompt sent to `claude` for an Explore turn (i.e. when `options.lightweight === true`) MUST be byte-identical across two consecutive invocations of the same Explore conversation when neither the project name nor the attachment set has changed. The lightweight prompt builder MUST NOT inject timestamps, dynamic counts, job ids, recent-job summaries, cost figures, or any per-invocation data.

#### Scenario: Two consecutive lightweight prompt builds are byte-equal

- **WHEN** the lightweight system prompt is built twice in a row for the same project name with no attachments
- **THEN** the two strings are byte-for-byte equal

#### Scenario: Attachment-bearing turn appends a stable suffix

- **WHEN** the same prompt is built once with no attachments and once with attachments
- **THEN** the two strings differ only by appending the `USER_ATTACHMENT_SYSTEM_NOTE` suffix
- **AND** all other characters are unchanged

### Requirement: Explore turns kept warm via session resume

Each Explore turn after the first SHALL be respawned with `--resume <session_id>` where `<session_id>` is the value captured from the conversation's first `system` event. The app does not maintain a persistent claude child process across turns; instead, deterministic system prompt (per the byte-stability requirement) plus consistent `cwd` per turn keep the Anthropic prompt cache warm.

#### Scenario: Second turn uses --resume

- **GIVEN** an Explore conversation whose first turn captured `session_id=S`
- **WHEN** the user sends a second message
- **THEN** the spawned `claude` argv includes `--resume S`

#### Scenario: Resume is preserved across minimize and restore

- **GIVEN** an Explore conversation with `session_id=S` that was minimized and later restored
- **WHEN** the user sends the next message after restore
- **THEN** the spawned `claude` argv includes `--resume S`
- **AND** the conversation row's `session_id` value is unchanged

### Requirement: Idle-kill on minimize after 2 minutes

When an Explore conversation is minimized to the global toast dock, the app SHALL start a 2-minute idle timer. If the conversation is not unminimised and does not receive a new user message before the timer fires, any active or pending `claude` child process for that conversation MUST be terminated (SIGTERM, 1 second grace, then SIGKILL). The conversation row, its `session_id`, and its draft state MUST NOT be deleted by this idle-kill — the next sent message respawns with `--resume`. If a turn is currently streaming when minimize occurs, the timer MUST NOT start until that turn completes.

#### Scenario: Idle 2 minutes after minimize kills the spawn

- **GIVEN** an Explore conversation with no in-flight turn that the user has just minimized
- **WHEN** 2 minutes elapse without unminimise or a new message
- **THEN** any associated child process is terminated
- **AND** the conversation row's `session_id` is preserved

#### Scenario: Streaming defers the timer

- **GIVEN** an Explore conversation streaming a turn
- **WHEN** the user minimizes mid-stream
- **THEN** the idle timer does not start while streaming continues
- **AND** the timer starts only after the streaming turn completes

#### Scenario: Activity before timer fires cancels it

- **GIVEN** an idle-kill timer is running at 90 seconds
- **WHEN** the user unminimises or sends a new message
- **THEN** the timer is cancelled
- **AND** no SIGTERM is delivered

#### Scenario: Restore after idle-kill respawns with resume

- **GIVEN** an Explore conversation whose process was idle-killed
- **WHEN** the user restores the chip and sends a new message
- **THEN** a fresh `claude` is spawned with `--resume <session_id>`
- **AND** the conversation history shown to the user is unchanged

### Requirement: Crash recovery auto-respawns once

If a `claude` child process for an in-flight Explore turn exits before emitting a `result` event, the app SHALL respawn the same turn exactly once with the same prompt and `--resume <session_id>`. If the second attempt also exits without a `result` event, the app MUST emit a `chat_error` for that conversation with a recognisable `crashed` reason. A successful turn SHALL reset the per-conversation crash counter to zero. The auto-respawn MUST NOT fire if the user has explicitly interrupted the turn (Stop button) before the crash occurs.

#### Scenario: First crash transparently respawns

- **GIVEN** an Explore turn whose child process exits non-zero before `result`
- **WHEN** no user interrupt was issued
- **THEN** a second `claude` spawn is started for the same turn with `--resume`
- **AND** the user sees streaming continue without an error message

#### Scenario: Second crash surfaces an error

- **WHEN** the auto-respawned attempt also exits before `result`
- **THEN** a `chat_error` WS event is broadcast for the conversation with reason `crashed`
- **AND** no third spawn is attempted

#### Scenario: Successful turn resets the counter

- **GIVEN** a conversation whose crash counter is 1 from a previous transient crash
- **WHEN** the next turn completes successfully
- **THEN** the next-future crash will trigger a fresh single auto-respawn

#### Scenario: User interrupt skips auto-respawn

- **GIVEN** an in-flight turn that the user has cancelled via Stop
- **WHEN** the child process exits non-zero
- **THEN** no auto-respawn occurs
- **AND** no `chat_error crashed` event is emitted (the existing cancel pathway handles UX)

### Requirement: Concurrency cap of five Explore spawns per project

The app SHALL maintain at most five concurrent Explore `claude` child processes per project. When a sixth would be created, the app MUST first kill the oldest currently-idle (not actively streaming) Explore process for the project. If all five are streaming, the new turn MUST be queued; if the queued turn has waited more than 30 seconds, the app MUST emit a `chat_error` with reason `busy` and drop the queued spawn.

#### Scenario: Sixth spawn evicts the oldest idle process

- **GIVEN** five active Explore processes for a project, four streaming and one idle
- **WHEN** a sixth Explore turn is sent
- **THEN** the idle process is killed
- **AND** the new turn proceeds without queueing

#### Scenario: All-streaming queue and timeout

- **GIVEN** five Explore processes all currently streaming
- **WHEN** a sixth Explore turn is sent
- **THEN** the new turn is queued
- **AND** if no slot opens within 30 seconds the conversation receives a `chat_error` with reason `busy`

#### Scenario: Slot opens within timeout

- **GIVEN** a queued sixth turn at t=10 seconds
- **WHEN** any of the five streaming turns completes at t=15 seconds
- **THEN** the queued turn is dispatched immediately
- **AND** no `chat_error busy` is emitted

### Requirement: Explore overlay shows status pills until first text delta

The Explore overlay SHALL render a status pill area immediately when the user submits a turn, displaying a sequence of states derived from streamed events. The pills MUST disappear as soon as the first `text` delta of the assistant turn is received. Each individual pill MUST be visible for at least 150 milliseconds before being replaced, to avoid flicker. A skeleton bubble MUST be visible from the moment the user submits the message, before any WebSocket round-trip.

#### Scenario: Pill stages map to events

- **WHEN** the user submits an Explore turn
- **THEN** a pill labelled `Conectando…` appears within 16 ms of submission
- **AND** when the conversation receives a `system` event the pill changes to `Pensando…`
- **AND** when any `tool_use` event arrives during the same turn the pill changes to `Consultando código…`
- **AND** the pill area disappears as soon as the first `text` delta of the turn arrives

#### Scenario: Minimum 150 ms per pill prevents flicker

- **GIVEN** a turn whose `system` and first `text` events arrive within 50 ms of each other
- **WHEN** the pill `Pensando…` would normally show
- **THEN** the pill remains visible for at least 150 ms before being replaced or removed

#### Scenario: Skeleton appears at T+0

- **WHEN** the user clicks Send on the Explore composer
- **THEN** a skeleton assistant bubble is rendered before any server response
- **AND** the skeleton remains until either the first `text` delta or a terminal `chat_error` for that turn

### Requirement: Streaming text renders char-by-char on a smooth tick

The Explore overlay SHALL animate streamed assistant text into the DOM in a smooth char-by-char fashion driven by `requestAnimationFrame` or an equivalent ~60 fps tick, decoupled from the raw WebSocket batch cadence. Buffered characters MUST never be dropped: every character received in `chat_stream` deltas eventually appears in the rendered bubble. If the buffer grows beyond a configurable safety threshold (e.g. 4 KB), the renderer MAY flush the remaining buffer instantly to avoid falling far behind.

#### Scenario: Bursty deltas render smoothly

- **WHEN** the server emits a 500-character delta in a single `chat_stream` event
- **THEN** the rendered bubble grows character-by-character at a perceptible smooth rate
- **AND** every character of the delta eventually appears in the bubble

#### Scenario: Slow trickle still smooth

- **WHEN** the server emits ten single-character deltas spaced 30 ms apart
- **THEN** the rendered bubble shows characters appearing at the cadence the model produced them, without frame drops

#### Scenario: Safety flush on extreme backlog

- **GIVEN** a 100 KB delta arriving in a single event
- **WHEN** the buffer exceeds the safety threshold
- **THEN** the renderer flushes the remaining buffer to the DOM in one go
- **AND** no characters are lost

### Requirement: Rollback escape hatches preserve correctness

The change SHALL provide two independently-toggleable escape hatches:

1. An environment variable `SPECRAILS_EXPLORE_LEGACY_CWD=1` MUST cause every Explore spawn to use `<project.path>` as `cwd`, regardless of the per-project toggle, and MUST cause `ExploreCwdManager` to skip materialising the explore-cwd directory entirely.
2. A client-side build-time flag `VITE_FEATURE_EXPLORE_PREMIUM_UX=false` MUST disable the status pills, the skeleton, and the char-by-char renderer, falling back to the pre-change rendering of `chat_stream` deltas.

Both escape hatches MUST keep the Explore feature functionally usable and MUST NOT cause any data loss in conversations or drafts.

#### Scenario: Server escape hatch forces legacy cwd

- **GIVEN** the server is started with `SPECRAILS_EXPLORE_LEGACY_CWD=1`
- **WHEN** any Explore turn is sent
- **THEN** the spawn `cwd` is `<project.path>`
- **AND** `~/.specrails/projects/<slug>/explore-cwd/` is not created or modified

#### Scenario: Client escape hatch disables premium UX

- **GIVEN** the client is built with `VITE_FEATURE_EXPLORE_PREMIUM_UX=false`
- **WHEN** the user submits an Explore turn
- **THEN** no status pills are rendered
- **AND** no skeleton bubble is rendered
- **AND** streamed deltas render directly without char-by-char animation
- **AND** the conversation history and draft state are unaffected

### Requirement: Explore composer footer exposes a Review action

The Explore composer footer SHALL render a `Review →` action positioned between the `Send` button and the `Create Spec` button. The action MUST be visible only when the draft has a non-empty `title` (matching the existing enable-condition of `Create Spec`). Activating the action SHALL open the Review Changes overlay over the shell without unmounting the shell.

#### Scenario: Review button appears when title is non-empty

- **WHEN** the draft has a non-empty title
- **THEN** a `Review →` action is rendered in the composer footer
- **AND** clicking it opens the Review Changes overlay

#### Scenario: Review button is hidden when title is empty

- **WHEN** the draft has no title (or whitespace-only)
- **THEN** the `Review →` action is not rendered

#### Scenario: Shell stays mounted while Review is open

- **WHEN** the Review overlay is open
- **THEN** the underlying Explore shell remains mounted in the DOM
- **AND** closing the overlay returns the user to the exact conversation and draft state they had before opening it

### Requirement: Review Changes overlay renders the full draft against a baseline

The Review Changes overlay SHALL accept a `baseline` describing the prior state of the spec (default empty) and render each draft field with diff highlights against the baseline. The overlay MUST cover `title`, `description`, `labels`, `priority`, and `acceptanceCriteria`. The overlay MUST NOT mutate the underlying draft state.

#### Scenario: Empty baseline renders all fields as additions

- **WHEN** the overlay is opened on a new spec with no prior baseline
- **THEN** all proposed values for `title`, `description`, `labels`, and `acceptanceCriteria` are rendered as added content
- **AND** the `priority` is rendered as a single pill (no before/after arrow)

#### Scenario: Non-empty baseline renders mixed diffs

- **WHEN** the overlay is opened with a baseline that differs from the proposed draft
- **THEN** unchanged text segments are rendered with default styling
- **AND** added segments are visually highlighted (e.g., success-coloured background)
- **AND** removed segments are visually struck through (e.g., warning-coloured strikethrough)

#### Scenario: Overlay does not mutate the draft

- **WHEN** the overlay is open
- **THEN** closing it via `Back to edit` returns the draft to the same in-memory state it had before the overlay opened
- **AND** no `spec_draft.update` WS event is emitted by opening or closing the overlay

### Requirement: Text fields use word-level diff; arrays use set diff; priority uses before/after

`title` and `description` SHALL be diffed at the word level using the existing `diff` package (`diffWords`). `labels` and `acceptanceCriteria` SHALL use a set-based diff that classifies each item as `added`, `removed`, or `unchanged` and renders order-preserved `unchanged + added` followed by `removed` items. `priority` SHALL render a single pill when unchanged or only one side has a value, and a `from → to` pill pair when changed.

#### Scenario: Word-level diff on description

- **WHEN** the baseline description is `Users cannot change the OS theme.` and the proposed description is `Users cannot override the OS theme.`
- **THEN** the rendered description shows the unchanged words intact, `change` struck through, and `override` highlighted as added

#### Scenario: Set diff on labels

- **WHEN** the baseline labels are `["ui", "misc"]` and the proposed labels are `["ui", "theme", "settings"]`
- **THEN** `ui` is rendered as unchanged
- **AND** `theme` and `settings` are rendered as added
- **AND** `misc` is rendered as removed

#### Scenario: Set diff on acceptance criteria preserves proposed order

- **WHEN** the baseline criteria are `["A", "B"]` and the proposed criteria are `["B", "C", "A"]`
- **THEN** the rendered list shows `B`, `C`, `A` in that order as unchanged/added/unchanged
- **AND** no removed entries are rendered

#### Scenario: Priority renders before-and-after when changed

- **WHEN** the baseline priority is `medium` and the proposed priority is `high`
- **THEN** the priority is rendered as a `medium → high` pill pair

#### Scenario: Priority renders single pill when unchanged

- **WHEN** the baseline and proposed priorities are both `medium`
- **THEN** the priority is rendered as a single `medium` pill

### Requirement: Review overlay supports Back-to-edit and Create-Spec actions

The overlay SHALL render two footer actions: `[← Back to edit]` and `[Create Spec]`. `Back to edit` MUST close the overlay without committing. `Create Spec` MUST invoke the same commit handler used by the footer-level `Create Spec` button on the underlying shell; both entry points MUST produce identical results. The `Esc` key MUST be equivalent to `Back to edit`.

#### Scenario: Back to edit closes the overlay

- **WHEN** the user clicks `Back to edit`
- **THEN** the overlay closes
- **AND** the underlying Explore shell becomes interactive again with unchanged draft state
- **AND** no ticket is committed

#### Scenario: Create Spec from the overlay commits the draft

- **WHEN** the user clicks `Create Spec` from inside the overlay
- **THEN** the same commit path used by the footer `Create Spec` button is invoked
- **AND** the overlay closes on success

#### Scenario: Esc closes the overlay equivalent to Back to edit

- **WHEN** the user presses `Esc` while the overlay is open
- **THEN** the overlay closes without committing
- **AND** the draft state is preserved

### Requirement: Review overlay is gated by a build-time escape hatch

The Review-Changes feature SHALL be gated by a client build-time flag `VITE_FEATURE_EXPLORE_REVIEW`. The default value MUST be enabled. Setting `VITE_FEATURE_EXPLORE_REVIEW=false` MUST cause the `Review →` action to not render and MUST keep the rest of the Explore shell functional, including the unchanged `Create Spec` footer action.

#### Scenario: Default build enables Review

- **WHEN** the client is built without setting the flag
- **THEN** the `Review →` action is rendered when the draft has a title
- **AND** clicking it opens the overlay

#### Scenario: Flag set to false hides Review

- **WHEN** the client is built with `VITE_FEATURE_EXPLORE_REVIEW=false`
- **THEN** the `Review →` action is not rendered regardless of draft state
- **AND** the existing `Create Spec` footer action is unaffected and continues to commit when clicked

### Requirement: TicketDetailModal exposes a Continue Editing action

The `TicketDetailModal` SHALL render a `Continue Editing` action ONLY when the ticket's status is `draft`, `todo`, or `backlog`. The action MUST NOT render for tickets in `in_progress`, `done`, or `cancelled` status. Activating the action SHALL open the Explore Spec shell seeded with the ticket as the current draft and as the Review baseline.

#### Scenario: Continue Editing renders for editable statuses

- **WHEN** the modal is open for a ticket whose status is `todo`, `backlog`, or `draft`
- **THEN** a `Continue Editing` action is rendered

#### Scenario: Continue Editing is hidden for non-editable statuses

- **WHEN** the modal is open for a ticket whose status is `in_progress`, `done`, or `cancelled`
- **THEN** no `Continue Editing` action is rendered

#### Scenario: Continue Editing opens the seeded shell

- **WHEN** the user clicks `Continue Editing`
- **THEN** the Explore Spec shell mounts
- **AND** the shell's draft pane is pre-populated with the ticket's title, description, labels, priority, and any acceptance criteria parsed from the description body
- **AND** the Review overlay (when opened) uses the original ticket values as its baseline rather than an empty baseline

### Requirement: Explore Spec shell supports an edit-existing-ticket mode

The Explore Spec shell SHALL accept an `editTicket` payload describing an existing ticket. When the payload is present, the shell MUST start a fresh conversation (no resume), seed its draft from the payload, expose the ticket id and identifying chrome (e.g., header eyebrow `EDITING SPEC · {id}`), and commit via update-in-place rather than create.

#### Scenario: Fresh conversation on edit-mode mount

- **WHEN** the shell mounts with an `editTicket` payload
- **THEN** no `resumeConversationId` is used
- **AND** the user lands in an empty conversation pane ready for the first message

#### Scenario: Header reflects edit mode

- **WHEN** the shell mounts with an `editTicket` payload
- **THEN** the header eyebrow identifies the ticket being edited

#### Scenario: Draft pane reflects the seeded ticket

- **WHEN** the shell mounts with an `editTicket` payload
- **THEN** the draft pane shows the ticket's title, description, labels, priority, and parsed acceptance criteria
- **AND** the user can edit any field manually before sending the first message

### Requirement: Update-in-place commit path for edit mode

When the shell is in edit mode (`editTicket` set), activating `Create Spec` / `Update Spec` (from either the composer footer or the Review overlay) SHALL commit via `PATCH /api/projects/:projectId/tickets/:id` with the current draft fields. The PATCH request body MUST include `title`, `description`, `labels`, `priority`, and `acceptanceCriteria` when those fields exist on the draft. The request MUST NOT include a `status` field (status changes are not allowed via this path). The server response MUST return the updated ticket, which the shell uses to dispatch the same `onTicketCreated`/`ticket_updated` flow callers already rely on.

#### Scenario: Commit dispatches PATCH for edit mode

- **WHEN** the user activates the commit action while `editTicket` is set
- **THEN** the shell sends `PATCH /api/projects/:projectId/tickets/:id` with the current draft fields
- **AND** the request body includes `acceptanceCriteria` if the draft has any
- **AND** the request body omits `status`

#### Scenario: Commit dispatches POST /tickets/from-draft for new-spec mode

- **WHEN** the user activates the commit action while `editTicket` is unset
- **THEN** the shell sends `POST /api/projects/:projectId/tickets/from-draft` (the existing create path)

### Requirement: Review overlay receives the ticket as baseline in edit mode

When the Explore Spec shell is in edit mode, opening the Review overlay SHALL pass the original ticket values as the `baseline` prop and the current draft as the `proposed` prop. The Review overlay MUST therefore render real diffs (added/removed segments) rather than the empty-baseline preview.

#### Scenario: Word-level diff appears against the original ticket text

- **WHEN** the user has edited the description from `Users cannot change the OS theme.` to `Users cannot override the OS theme.` and opens Review
- **THEN** the overlay's description field shows `change` struck through and `override` highlighted as added
- **AND** unchanged words appear with default styling

#### Scenario: Set diff appears on labels and criteria

- **WHEN** the user has changed labels from `["ui", "misc"]` to `["ui", "theme"]` and opens Review
- **THEN** `ui` renders unchanged, `theme` renders added, `misc` renders removed in the overlay

### Requirement: Review overlay commit button label reflects mode

The Review overlay's commit button SHALL display `Update Spec` when the shell is in edit mode (`editTicket` set) and `Create Spec` otherwise. The button's `data-testid` MUST remain stable (`review-commit`) regardless of mode so tests and the underlying handler are unaffected.

#### Scenario: Edit mode shows Update Spec

- **WHEN** the Review overlay opens with an `editTicket` baseline
- **THEN** the commit button displays the label `Update Spec`

#### Scenario: Create mode shows Create Spec

- **WHEN** the Review overlay opens with no `editTicket`
- **THEN** the commit button displays the label `Create Spec`

### Requirement: PATCH /tickets/:id accepts acceptanceCriteria

The app SHALL extend `PATCH /api/projects/:projectId/tickets/:id` to accept an optional `acceptanceCriteria: string[]` field. When present, the server MUST fold the array into the ticket's description body under a `## Acceptance Criteria` heading, replacing any existing section with that exact heading. When the array is empty (`[]`), the server MUST remove any existing `## Acceptance Criteria` section. When the field is omitted, the description's acceptance criteria area MUST be left unchanged.

#### Scenario: Criteria array writes a new section

- **WHEN** a PATCH request includes `acceptanceCriteria: ["A", "B"]` and the existing description has no `## Acceptance Criteria` section
- **THEN** the persisted description ends with a `## Acceptance Criteria` section listing `- A` and `- B`

#### Scenario: Criteria array replaces an existing section

- **WHEN** a PATCH request includes `acceptanceCriteria: ["C"]` and the existing description has a `## Acceptance Criteria` section with `- A`
- **THEN** the persisted description's `## Acceptance Criteria` section lists `- C` only

#### Scenario: Empty array removes the section

- **WHEN** a PATCH request includes `acceptanceCriteria: []` and the existing description has a `## Acceptance Criteria` section
- **THEN** the persisted description no longer contains a `## Acceptance Criteria` heading

#### Scenario: Omitted field preserves the section

- **WHEN** a PATCH request omits `acceptanceCriteria` entirely
- **THEN** the persisted description retains any pre-existing `## Acceptance Criteria` section unchanged

### Requirement: Explore turns honor per-conversation context scope
Every Explore conversation SHALL carry a `contextScope: { specrails: boolean, openspec: boolean, full: boolean, mcp: boolean }` record set at launch (from the Add Spec modal) and persisted on the `chat_conversations` row. Each turn spawn MUST consult this record and:
- When `specrails=true`, prepend `<project>/.specrails/specs/**/*.md` content to the system prompt under a section labelled `## Specrails Specs` (capped at 30k tokens, truncated with `(truncated)` marker).
- When `openspec=true`, prepend `<project>/openspec/specs/**/spec.md` content under `## OpenSpec Specs` (same cap).
- When `full=true`, pass `--allowedTools Read,Grep,Glob` (Bash excluded by default). When `full=false`, pass `--disallowedTools Read,Grep,Glob,Bash`. The two flags MUST NOT both be passed; a falsy `full` selects disallow.
- When `specrails=true` or `openspec=true` AND `full=false`, the spawn MUST additionally allow Read on the specific spec directory paths via `--allowedTools` so the model can re-read the concatenated specs if it asks. The remaining file system remains blocked.

#### Scenario: Specs concat appears under labelled sections
- **WHEN** the first Explore turn fires with `contextScope: { specrails: true, openspec: true, full: false, mcp: false }`
- **THEN** the system prompt contains a `## Specrails Specs` section followed by spec contents
- **AND** the system prompt contains a `## OpenSpec Specs` section followed by openspec contents
- **AND** the spawn includes `--disallowedTools Read,Grep,Glob,Bash` for non-spec paths
- **AND** Read on the spec directories is permitted via `--allowedTools`

#### Scenario: Full ON opens read tools
- **WHEN** an Explore turn fires with `full=true`
- **THEN** the spawn includes `--allowedTools Read,Grep,Glob`
- **AND** Bash is not in the allowed list

#### Scenario: Full OFF closes read tools
- **WHEN** an Explore turn fires with `full=false` and both spec toggles OFF
- **THEN** the spawn includes `--disallowedTools Read,Grep,Glob,Bash`
- **AND** no allow-list is present for those tools

#### Scenario: 30k cap on spec concat
- **WHEN** the combined specrails spec content exceeds 30k tokens
- **THEN** the prompt section is truncated to fit
- **AND** ends with the literal marker `(truncated)`

### Requirement: Explore conversation persists its contextScope
The `chat_conversations` table SHALL gain a `context_scope` text column (JSON) for rows where `kind='explore'`. The column MUST be populated at conversation creation from the Add Spec modal payload and MUST NOT change for the lifetime of the conversation. Resumed conversations (via `--resume`) MUST re-read this stored scope on every turn.

#### Scenario: Scope persists across resume
- **GIVEN** an Explore conversation created with `context_scope = { specrails: true, openspec: false, full: false, mcp: true }`
- **WHEN** the conversation is minimized and later resumed via a new spawn with `--resume`
- **THEN** the resumed spawn reads the stored `context_scope` and applies the same flags

#### Scenario: Scope is immutable
- **WHEN** a user changes the toggles in a new Add Spec modal while an older Explore conversation is active
- **THEN** the older conversation's spawns continue to use its original scope

### Requirement: ExploreSpec composer exposes a Stop affordance while streaming

While an Explore Spec turn is streaming (`conversation.isStreaming === true`) **and** the conversation already has more than one message (i.e. at least one prior user turn has completed and a new user turn is being processed), the composer SHALL present a Stop control in the same DOM slot as the Send button. The very first (bootstrap) streaming turn of a conversation — when `conversation.messages.length <= 1` — SHALL NOT expose a Stop control, because cancelling the priming turn would leave the conversation in an unusable half-initialised state. Activating the Stop control SHALL cancel the in-flight assistant turn by calling `useChat.abortStream(conversationId)`, which `DELETE`s `/api/projects/:projectId/chat/conversations/:id/messages/stream`. The Stop control SHALL be enabled regardless of whether the composer textarea contains text, because the user MUST be able to interrupt without having to type a new message first. When `isStreaming` flips back to `false`, the composer SHALL revert to the Send affordance, preserving any text the user typed during the streaming interval.

#### Scenario: Stop button replaces Send while streaming

- **WHEN** the user submits an Explore Spec turn and the server begins streaming (`conversation.isStreaming` flips to `true`)
- **THEN** the composer's Send button SHALL be replaced in place by a Stop button styled with the destructive (red) variant
- **AND** the Stop button SHALL be enabled even if the composer textarea is empty

#### Scenario: Click on Stop cancels the in-flight turn

- **WHEN** the user clicks the Stop button while streaming
- **THEN** the client SHALL invoke `useChat.abortStream(conversation.id)`, which issues `DELETE /chat/conversations/:id/messages/stream`
- **AND** the server SHALL terminate the spawned `claude` child via the existing `ChatManager.abort` path
- **AND** any assistant output already rendered SHALL remain visible

#### Scenario: Stop is hidden during the bootstrap turn

- **WHEN** the user opens an Explore Spec shell and the slash-command bootstrap turn is streaming, with `conversation.messages.length <= 1`
- **THEN** the composer SHALL NOT render a Stop button
- **AND** the keybind `⌘⏎` / `Ctrl+⏎` SHALL NOT trigger `abortStream` during this window

#### Scenario: Send affordance restored after streaming ends

- **WHEN** `conversation.isStreaming` transitions from `true` back to `false` (either because the turn completed naturally or because the user pressed Stop)
- **THEN** the composer SHALL re-render the Send button in the same DOM slot
- **AND** any text the user typed into the composer during the streaming interval SHALL still be present

### Requirement: ⌘⏎ / Ctrl+⏎ triggers Stop while streaming

The `Cmd+Enter` (macOS) / `Ctrl+Enter` (other platforms) keybind inside the Explore Spec composer SHALL be context-sensitive: while `conversation.isStreaming === false`, it submits the composer text exactly as today; while `conversation.isStreaming === true`, it cancels the in-flight turn via the same `abortStream` call as the Stop button. The keybind hint displayed next to the action label SHALL remain visible in both states so the affordance is discoverable from muscle memory.

#### Scenario: ⌘⏎ submits while idle

- **WHEN** the user presses `Cmd+Enter` (or `Ctrl+Enter`) while `conversation.isStreaming` is `false` and the composer contains non-whitespace text
- **THEN** the composer SHALL submit the message exactly as today (existing behaviour, unchanged)

#### Scenario: ⌘⏎ aborts while streaming

- **WHEN** the user presses `Cmd+Enter` (or `Ctrl+Enter`) while `conversation.isStreaming` is `true`
- **THEN** the client SHALL invoke `useChat.abortStream(conversation.id)` instead of submitting any composer text
- **AND** any text currently in the composer SHALL be preserved (not consumed by the keybind)

### Requirement: App-wide kill switch for Contract Refine

The app SHALL honour an environment variable `SPECRAILS_EXPLORE_CONTRACT_REFINE`. When the variable is the literal string `0`, `false`, or `off` (case-insensitive), the refine step MUST be skipped for every project regardless of per-conversation scope. The kill switch suppresses both the post-commit auto-fire path and the manual retry endpoint.

#### Scenario: Kill switch disables refine across all projects
- **GIVEN** the server is started with `SPECRAILS_EXPLORE_CONTRACT_REFINE=0`
- **WHEN** any committed Explore conversation has `context_scope.contractRefine=true`
- **THEN** no refine spawn is scheduled
- **AND** the ticket description is left as the user committed it

#### Scenario: Kill switch disables retry endpoint
- **GIVEN** the server is started with `SPECRAILS_EXPLORE_CONTRACT_REFINE=off`
- **WHEN** the client POSTs `POST /api/projects/:projectId/tickets/:id/contract-refine` for a ticket with a valid `origin_conversation_id`
- **THEN** the server responds 409
- **AND** no spawn is scheduled

#### Scenario: Default-empty env behaves as enabled
- **WHEN** the server is started without `SPECRAILS_EXPLORE_CONTRACT_REFINE` set
- **THEN** the kill switch is treated as inactive
- **AND** per-conversation scope drives refine behaviour normally

### Requirement: Contract Refine runs as a post-commit Explore turn

When the app-wide kill switch is inactive, the app SHALL fire a Contract Refine turn after every successful Explore spec commit whose source conversation has `context_scope.contractRefine === true`. The refine MUST run asynchronously (the client's `Create Spec` request MUST return as fast as it does today). The refine MUST spawn `claude` through `ChatManager` reusing the parent Explore conversation's lifecycle (concurrency cap, idle-kill, crash auto-respawn, `--resume <session_id>`, cwd resolution from the conversation's `contextScope.mcp`). The refine MUST use the same model as the parent conversation. The post-commit path MUST NOT consult any project-level setting.

#### Scenario: Refine fires after new-ticket commit
- **WHEN** the user commits an Explore draft via `POST /tickets/from-draft` (legacy insert path)
- **AND** the committed conversation has `context_scope.contractRefine=true`
- **THEN** `ChatManager.runContractRefine(conversationId, ticketId)` is invoked after the HTTP response is sent
- **AND** the refine spawn uses `--resume <session_id>` of the parent Explore conversation

#### Scenario: Refine fires after draft flip-in-place commit
- **WHEN** the user commits a session whose source ticket is `status='draft'` (flip-in-place path)
- **AND** the committed conversation has `context_scope.contractRefine=true`
- **THEN** the refine fires against the flipped ticket id, not a new ticket id

#### Scenario: Refine reuses parent conversation model
- **GIVEN** an Explore conversation created with `model='haiku'`
- **WHEN** the refine fires for its commit
- **THEN** the spawned `claude` argv selects `haiku` (same as parent turns)

#### Scenario: Refine respects parent conversation cwd
- **GIVEN** an Explore conversation with `contextScope.mcp=false` (app-managed cwd)
- **WHEN** the refine fires
- **THEN** the spawn `cwd` is `~/.specrails/projects/<slug>/explore-cwd/`
- **AND** the spawn does NOT add `<project.path>` cwd

#### Scenario: Refine counts against per-project concurrency cap
- **GIVEN** five Explore turns currently streaming for a project (cap reached)
- **WHEN** a refine fires for a sixth turn
- **THEN** the refine queues using the existing Explore queue semantics
- **AND** the 30 s busy timeout applies identically

### Requirement: Contract Refine system prompt is structural and read-only

The refine turn SHALL be initiated by a marker user message `/specrails:contract-refine` and rely on a dedicated structural system prompt distinct from the main Explore prompt. The system prompt MUST forbid the model from modifying user-authored content, MUST instruct the model to emit exactly one fenced block tagged ` ```contract-layer ` containing a JSON object, and MUST forbid any tool calls regardless of the parent conversation's `contextScope.full`. The system prompt MUST be byte-stable across two refines of the same `(conversationId, ticketId, contract-prompt-version)` so retries hit the Anthropic prompt cache. The spawn argv MUST include `--disallowedTools Read,Grep,Glob,Bash` for the refine turn even when the parent conversation enabled them.

#### Scenario: Marker message starts the refine
- **WHEN** the refine fires
- **THEN** the user message sent into the conversation is exactly `/specrails:contract-refine`
- **AND** this message is NOT shown in the client's conversation history (filtered like the parent `/specrails:explore-spec` bootstrap)

#### Scenario: Refine spawn forbids tools
- **WHEN** the refine fires for a parent conversation that had `contextScope.full=true`
- **THEN** the spawn argv includes `--disallowedTools Read,Grep,Glob,Bash`
- **AND** does NOT include `--allowedTools Read,Grep,Glob`

#### Scenario: System prompt is byte-stable across retries
- **WHEN** the refine is invoked twice in a row for the same `(conversationId, ticketId)` and the same `contract-prompt-version`
- **THEN** the two system prompt strings are byte-for-byte equal

#### Scenario: System prompt forbids user-content edits
- **WHEN** the refine system prompt is built
- **THEN** the prompt contains an explicit instruction that the model MUST NOT alter or restate the user-authored title, description, labels, priority, or acceptance criteria
- **AND** the prompt instructs the model to emit only the `contract-layer` fenced block

### Requirement: contract-layer fenced block parses to a known shape

The app SHALL recognise a fenced code block tagged ` ```contract-layer ` in the refine assistant turn and parse the JSON payload against a fixed shape:

```
{
  "contractVersion": 1,
  "namingContract": {
    "enums":     [{ "name": string, "values": string[], "file": string }],
    "fields":    [{ "name": string, "type": string, "where": string }],
    "functions": [{ "signature": string, "file": string }],
    "files":     [{ "path": string, "purpose": string }]
  },
  "dataShapes":    [{ "name": string, "ts": string }],
  "stateMachine":  string | null,
  "invariants":    string[],
  "fileTouchList": [{ "path": string, "action": "create" | "extend" | "delete", "reason": string }]
}
```

Unknown keys MUST be dropped silently. Missing arrays MUST default to `[]`. A missing or non-integer `contractVersion` MUST cause the block to be treated as malformed. The raw fenced block MUST be stripped from the chat content broadcast to clients (same scrub behaviour as the `spec-draft` block). Malformed blocks MUST log a server warning with `conversationId` and `ticketId` and MUST be treated as a refine failure.

#### Scenario: Valid block parses to canonical shape
- **WHEN** the refine assistant turn contains a `contract-layer` block with the full known shape
- **THEN** the parsed object exposes all five top-level fields with the declared types
- **AND** the raw block is removed from the chat content broadcast over the WS

#### Scenario: Missing optional arrays default to empty
- **WHEN** the block omits `invariants` and `dataShapes`
- **THEN** the parsed object has `invariants: []` and `dataShapes: []`

#### Scenario: Unknown keys are dropped
- **WHEN** the block contains `{ "contractVersion": 1, "namingContract": {...}, "specFlavour": "weird" }`
- **THEN** `specFlavour` is not surfaced in the parsed result
- **AND** parsing succeeds

#### Scenario: Missing contractVersion is malformed
- **WHEN** the block omits `contractVersion` or sets it to a non-integer
- **THEN** parsing fails
- **AND** a server warning is logged with `conversationId` and `ticketId`
- **AND** the refine is treated as a failure per the refine-failure requirement

#### Scenario: Malformed JSON does not crash
- **WHEN** the block contains malformed JSON
- **THEN** parsing fails gracefully
- **AND** the chat content broadcast still strips the fenced block boundaries
- **AND** the refine is treated as a failure

### Requirement: Successful refine patches the ticket description with a Contract Layer section

On successful parse of the `contract-layer` block, the app SHALL patch the committed ticket's description by appending a deterministic Contract Layer markdown section. The section MUST be separated from the user-authored body by a single horizontal rule line `\n\n---\n\n` followed by the heading `## Contract Layer` and exactly five labelled subsections in this order: `### Naming Contract`, `### Data Shapes`, `### State Machine`, `### Invariants`, `### File Touch List`. Subsections that have no items MUST render the literal line `_N/A — model did not produce items for this subsection._` (or equivalent). The patch MUST use the existing `PATCH /api/projects/:projectId/tickets/:id` endpoint with only the `description` field set. The patch MUST NOT alter `title`, `labels`, `priority`, or any other ticket field. The app MUST broadcast a `ticket_updated` WebSocket event after the patch, identical in shape to other PATCH-driven updates.

#### Scenario: Successful refine appends the Contract Layer section
- **WHEN** the refine produces a valid `contract-layer` block
- **THEN** the ticket's `description` is patched
- **AND** the patched description ends with `\n\n---\n\n## Contract Layer\n\n### Naming Contract\n...\n### Data Shapes\n...\n### State Machine\n...\n### Invariants\n...\n### File Touch List\n...`
- **AND** the original user-authored part of the description (everything before the `\n\n---\n\n` separator) is byte-identical to the description committed by `from-draft`

#### Scenario: Empty subsections render an N/A placeholder
- **WHEN** the `contract-layer` block contains an empty `invariants` array
- **THEN** the rendered `### Invariants` subsection contains the literal `_N/A — model did not produce items for this subsection._` line

#### Scenario: stateMachine null renders N/A
- **WHEN** the `contract-layer` block contains `stateMachine: null`
- **THEN** the rendered `### State Machine` subsection contains the N/A placeholder line

#### Scenario: PATCH carries only description
- **WHEN** the app fires the patch after a successful refine
- **THEN** the PATCH request body contains only `description`
- **AND** does NOT contain `title`, `labels`, `priority`, `acceptanceCriteria`, or `status`

#### Scenario: ticket_updated WS event fires after patch
- **WHEN** the patch succeeds
- **THEN** a `ticket_updated` WS event is broadcast for the project
- **AND** subscribers receive the updated ticket payload including the new description

### Requirement: Refine failure is non-blocking and surfaces a recoverable toast

If the refine fails for any reason — model error, `chat_error`, crash that exhausts auto-respawn, malformed `contract-layer` block, app-side parser exception, timeout at 60 seconds from refine spawn start — the app MUST NOT patch the ticket description and MUST broadcast a project-scoped WebSocket event `explore.contract_refine_failed { ticketId, reason }` where `reason` is one of `model_error | crashed | malformed | timeout | parser_error`. The client SHALL react by showing a sonner toast on the SpecsBoard surface with copy "Contract layer skipped — ticket saved without it" and an action button `Reintentar`. Activating `Reintentar` SHALL invoke `POST /api/projects/:projectId/tickets/:id/contract-refine` to fire a fresh refine for the same ticket. The retry endpoint MUST gate on the app-wide kill switch and on the ticket having a non-null `origin_conversation_id`; it MUST NOT gate on the originating conversation's `context_scope.contractRefine`. The retry MUST reuse the same `(conversationId, ticketId)` pair and the same lifecycle as the original refine.

#### Scenario: Model error emits failure event and skips patch
- **WHEN** the refine spawn exits with a `chat_error` after auto-respawn is exhausted
- **THEN** no PATCH is sent to the ticket
- **AND** an `explore.contract_refine_failed` WS event is broadcast with `reason: "model_error"` or `"crashed"`
- **AND** the ticket description remains as the user committed it

#### Scenario: 60-second timeout treated as failure
- **WHEN** the refine has been running for 60 seconds without emitting a parseable `contract-layer` block
- **THEN** the refine spawn is terminated
- **AND** an `explore.contract_refine_failed` WS event is broadcast with `reason: "timeout"`

#### Scenario: Retry endpoint fires a fresh refine
- **WHEN** the client POSTs `POST /api/projects/:projectId/tickets/:id/contract-refine` for a ticket with a non-null `origin_conversation_id`
- **AND** the kill switch is inactive
- **THEN** a fresh refine spawn is scheduled for the same ticket id
- **AND** the response is 202 with `{ scheduled: true }`

#### Scenario: Retry endpoint rejects when kill switch active
- **WHEN** the client POSTs the retry endpoint while `SPECRAILS_EXPLORE_CONTRACT_REFINE=off`
- **THEN** the server responds 409 with an error code indicating the feature is disabled
- **AND** no spawn is scheduled

#### Scenario: Retry endpoint rejects ticket without origin conversation
- **WHEN** the client POSTs the retry endpoint for a ticket whose `origin_conversation_id` is `null`
- **THEN** the server responds 409 with an error code indicating no origin conversation
- **AND** no spawn is scheduled

#### Scenario: Retry endpoint rejects unknown ticket
- **WHEN** the client POSTs the retry endpoint for a ticket id that does not exist
- **THEN** the server responds 404

### Requirement: Refine writes one ai_invocations row per turn

Each Contract Refine spawn SHALL write a single row to `ai_invocations` at process exit via the existing `recordInvocation` capture path. The row MUST have `surface='explore-spec'`, `conversation_id` equal to the parent Explore conversation id, and `ticket_id` equal to the ticket being refined. Other columns (`model`, `started_at`, `finished_at`, `duration_ms`, `duration_api_ms`, `tokens_in/out/cache_read/cache_create`, `total_cost_usd`, `num_turns`, `status`, `session_id`) MUST be populated using the same rules as Explore turns. Refine failures MUST still record a row with `status` set to `failed` or `aborted` so spending analytics absorb the cost transparently.

#### Scenario: Successful refine records one row
- **WHEN** a refine completes successfully and the ticket is patched
- **THEN** exactly one new `ai_invocations` row exists for the refine spawn
- **AND** the row's `surface='explore-spec'`, `conversation_id` matches the parent, and `ticket_id` matches the refined ticket

#### Scenario: Failed refine still records a row
- **WHEN** a refine fails because the spawn crashed and auto-respawn was exhausted
- **THEN** an `ai_invocations` row is still recorded for the failed attempt
- **AND** its `status` is `failed` or `aborted`

#### Scenario: ticket_id back-fill works for flipped drafts
- **WHEN** the refine fires after a flip-in-place draft commit
- **THEN** the recorded `ticket_id` is the flipped ticket id (not a new id)
- **AND** matches the ticket id targeted by the patch

### Requirement: TicketDetailModal renders Contract Layer collapsed by default

When a ticket's description contains a Contract Layer section (delimited by the `\n\n---\n\n## Contract Layer\n\n` prefix), `TicketDetailModal` SHALL render the body in two regions: the user-authored body (rendered normally) and the Contract Layer region rendered inside a collapsible disclosure widget that defaults to collapsed. The disclosure header MUST display the label `Contract Layer` and an indicator of whether sections are populated (e.g., a count badge of non-N/A subsections). Expanding the disclosure MUST reveal the full Contract Layer markdown. SpecsBoard previews (and any other card-style summary surface) MUST ignore content after the `\n\n---\n\n` separator when computing the preview text.

#### Scenario: Modal renders collapsed disclosure
- **WHEN** the modal opens for a ticket whose description contains a Contract Layer section
- **THEN** a collapsible disclosure with the label `Contract Layer` is rendered after the user-authored body
- **AND** the disclosure is collapsed by default

#### Scenario: Expand reveals full Contract Layer
- **WHEN** the user clicks the disclosure header
- **THEN** the disclosure expands to show all five subsections rendered as markdown

#### Scenario: SpecsBoard preview ignores Contract Layer
- **WHEN** SpecsBoard renders a card preview for a ticket whose description contains a Contract Layer
- **THEN** the preview text is computed from only the user-authored portion of the description (everything before `\n\n---\n\n`)

#### Scenario: Ticket without Contract Layer renders unchanged
- **WHEN** the modal opens for a ticket whose description does not contain the Contract Layer separator
- **THEN** no disclosure is rendered
- **AND** the description renders identically to today

### Requirement: SpecsBoard surface tracks refine pending and failure states

The client SHALL render a sonner toast on the SpecsBoard surface for each ticket whose refine is in-flight. The toast text SHALL be `Afinando contrato…` and the toast id MUST be derived deterministically from the ticket id so consecutive refines do not stack. On `ticket_updated` (refine success) the toast MUST be dismissed automatically. On `explore.contract_refine_failed` the toast MUST swap to an error variant with copy `Contract layer skipped — ticket saved without it` and an action `Reintentar` that POSTs to the retry endpoint. The toast MUST be dismissable manually at any time.

#### Scenario: Pending toast appears on commit when conversation scope has contractRefine ON
- **WHEN** the user commits an Explore spec whose conversation has `context_scope.contractRefine=true`
- **THEN** a sonner toast with id `contract-refine:<ticketId>` and text `Afinando contrato…` appears within 100 ms of the commit response

#### Scenario: Success dismisses the toast
- **WHEN** the matching `ticket_updated` event arrives and the patched description contains a Contract Layer section
- **THEN** the toast with id `contract-refine:<ticketId>` is dismissed

#### Scenario: Failure swaps the toast to error variant
- **WHEN** an `explore.contract_refine_failed` WS event arrives for `ticketId`
- **THEN** the existing toast with id `contract-refine:<ticketId>` is updated to the error variant
- **AND** an action button `Reintentar` is rendered on the toast
- **AND** clicking `Reintentar` POSTs `POST /api/projects/:projectId/tickets/<ticketId>/contract-refine`

#### Scenario: Toast id is stable across retries
- **WHEN** the user activates `Reintentar` on the error toast
- **THEN** the toast id remains `contract-refine:<ticketId>` and reverts to the pending variant
- **AND** no second toast for the same ticket is created

### Requirement: contextScope carries contractRefine per conversation

The server-side `ContextScope` type SHALL include a `contractRefine: boolean` field, persisted in `chat_conversations.context_scope` JSON alongside the existing `specrails`, `openspec`, `full`, `mcp` flags. `normalizeContextScope` MUST default missing `contractRefine` values to `false`. The boot value for the Add Spec modal's `contractRefine` toggle MUST come from the active preset or, when a per-project sticky scope exists (`useContextScope`), from that persisted value. The app MUST NOT consult any project-level setting when seeding the boot value.

#### Scenario: contractRefine defaults to false when absent in stored scope
- **GIVEN** a legacy `chat_conversations` row whose `context_scope` JSON lacks `contractRefine`
- **WHEN** the runner reads the scope via `normalizeContextScope`
- **THEN** `contractRefine` is `false`

#### Scenario: Modal boot uses per-project sticky scope when available
- **GIVEN** the project has a persisted `useContextScope` value with `contractRefine: true`
- **WHEN** the user opens the Add Spec modal in Explore mode
- **THEN** the Contract Refine flag in the slider/fine-tune surface boots to `true`

#### Scenario: contractRefine round-trips through JSON
- **WHEN** a scope `{ specrails: true, openspec: false, full: true, mcp: false, contractRefine: true }` is JSON-stringified and re-normalised
- **THEN** every flag including `contractRefine` round-trips byte-equal

### Requirement: from-draft commit reads contractRefine from conversation scope

When `POST /tickets/from-draft` schedules `runContractRefine` after a successful commit, the runner SHALL gate the spawn exclusively on `conversation.context_scope.contractRefine` (and on the app-wide kill switch). If the field is `false` (including the legacy `false` default) the runner MUST early-return with `reason='scope-disabled'`. The runner MUST NOT consult any project-level setting.

#### Scenario: Per-conversation false skips refine
- **GIVEN** the committed conversation's `context_scope.contractRefine` is `false`
- **WHEN** the user commits via `Create Spec`
- **THEN** no refine spawn is scheduled
- **AND** the ticket has no Contract Layer appended

#### Scenario: Per-conversation true fires refine
- **GIVEN** the committed conversation's `context_scope.contractRefine` is `true`
- **AND** the kill switch is inactive
- **WHEN** the user commits via `Create Spec`
- **THEN** a refine spawn is scheduled
- **AND** on success the ticket gains a Contract Layer section

#### Scenario: scope-disabled reason recorded as skipped, not failed
- **WHEN** the runner early-returns with `reason='scope-disabled'`
- **THEN** no `claude` process is spawned
- **AND** no `ai_invocations` row is recorded for that attempt
- **AND** no `explore.contract_refine_failed` WS event is broadcast

### Requirement: Retry endpoint stays gated by the project setting

`POST /api/projects/:projectId/tickets/:id/contract-refine` SHALL continue to gate on the project-wide `explore_contract_refine_enabled` setting and the app-wide kill switch, NOT on the originating conversation's `contextScope.contractRefine`. Tickets created with `contractRefine=false` in their scope MUST still be retriable when the project default is `true`.

#### Scenario: Retry succeeds for a ticket whose origin scope opted out
- **GIVEN** ticket `T` whose origin Explore conversation had `context_scope.contractRefine=false`
- **AND** the project setting is `true`
- **WHEN** the user POSTs the retry endpoint for `T`
- **THEN** the server responds 202 with `{ scheduled: true }`
- **AND** a refine spawn fires for `T`

#### Scenario: Retry rejected when project setting is OFF
- **GIVEN** the project setting is `false`
- **WHEN** the user POSTs the retry endpoint
- **THEN** the server responds 409 regardless of the conversation's stored scope

### Requirement: Quick mode supports Contract Refine after generate-spec

The `POST /api/projects/:projectId/tickets/generate-spec` endpoint SHALL accept an optional `contractRefine: boolean` field in its request body. When `true` and the app-wide kill switch is inactive, the server MUST schedule `runContractRefine` after the generated ticket is persisted. The refine spawn MUST use a one-shot pathway (no `--resume`, no parent conversation): the system prompt is augmented with the just-generated `title` and `description` so the model has the spec body in-context, and the recorded `ai_invocations` row uses `surface='quick-spec'` with `conversation_id=null` and the new ticket id. The endpoint MUST NOT consult any project-level setting.

#### Scenario: Quick toggle ON fires refine after generation
- **GIVEN** the kill switch is inactive
- **WHEN** the client posts `{ idea, contractRefine: true }` to `generate-spec`
- **THEN** the ticket is created normally
- **AND** within 100 ms of the response the refine spawn is scheduled
- **AND** the refine spawn argv does NOT include `--resume`

#### Scenario: Quick toggle OFF skips refine
- **WHEN** the client posts `{ idea, contractRefine: false }` to `generate-spec`
- **THEN** the ticket is created and no refine spawn is scheduled

#### Scenario: Quick toggle ON skipped under kill switch
- **GIVEN** the kill switch is active
- **WHEN** the client posts `{ idea, contractRefine: true }` to `generate-spec`
- **THEN** the ticket is created and no refine spawn is scheduled

#### Scenario: Quick refine writes a quick-spec invocation row
- **WHEN** a Quick refine completes successfully
- **THEN** an `ai_invocations` row exists with `surface='quick-spec'`, `conversation_id IS NULL`, and `ticket_id` equal to the new ticket id

### Requirement: Add Spec modal Explore mode renders the six-stop slider

In Explore mode, the Add Spec modal SHALL render a `<ContextScopeSlider>` component in place of the existing four-checkbox row. The slider MUST expose exactly six stops in fixed left-to-right order: `Minimal`, `Light`, `Standard`, `Rich`, `Max`, `Desktop`. The label of the active stop MUST be highlighted; inactive stop labels MUST remain visible. A one-line cost summary MUST appear directly below the rail, copy fixed per stop (see design.md D5). The `▾ Fine-tune` disclosure MUST render below the cost line and contain the five individual flag toggles (`specrails`, `openspec`, `full`, `mcp`, `contractRefine`), bound to the same state as the slider.

#### Scenario: Initial mount picks the matching preset
- **WHEN** the modal opens with a boot scope matching `Rich` (specrails+openspec+full, mcp=false, contractRefine=false)
- **THEN** the slider thumb sits on the `Rich` stop
- **AND** the active stop label is highlighted

#### Scenario: Drag and release snaps to nearest stop
- **WHEN** the user drags the thumb 60 % of the rail width to the right and releases mid-air
- **THEN** the thumb snaps to the closest stop on release
- **AND** the bound scope flags update to that preset's combination
- **AND** the cost line updates to the new preset's copy

#### Scenario: Click on a stop dot jumps to that preset
- **WHEN** the user clicks on the `Max` stop label / dot
- **THEN** the thumb animates to `Max`
- **AND** the bound flags are `{ specrails: true, openspec: true, full: true, mcp: false, contractRefine: true }`

#### Scenario: Keyboard arrow keys move one stop
- **GIVEN** focus on the slider with the thumb on `Standard`
- **WHEN** the user presses `ArrowRight`
- **THEN** the thumb moves to `Rich`
- **AND** `ArrowLeft` from `Rich` moves back to `Standard`
- **AND** `End` jumps to `Desktop`
- **AND** `Home` jumps to `Minimal`

#### Scenario: Touch / pointer-events drag works in webview
- **WHEN** a pointer-down on the thumb is followed by a pointer-move and pointer-up
- **THEN** the slider tracks the pointer and snaps on pointer-up
- **AND** the same handlers fire for both mouse and touch input types

### Requirement: Custom indicator appears when the scope matches no preset

When the bound scope combination does not match any of the six preset rows exactly, the slider MUST render a `Custom` pill that replaces the active-stop highlight, positioned between the two nearest stops by interpolated cost rank. The user MUST NOT be able to drag *to* `Custom`; dragging always snaps to one of the six preset stops on release.

#### Scenario: Toggling a single flag off-preset enters Custom
- **GIVEN** the slider is on `Standard` (specrails+openspec, others false)
- **WHEN** the user opens Fine-tune and toggles `contractRefine` on
- **THEN** the slider shows the `Custom` pill (no preset matches `specrails+openspec+contractRefine`)
- **AND** the cost line reads "Custom mix — see Fine-tune below"

#### Scenario: Dragging from Custom snaps to a preset, never to Custom
- **GIVEN** the slider is currently in the Custom state
- **WHEN** the user drags the thumb and releases anywhere on the rail
- **THEN** the thumb snaps to one of the six preset stops
- **AND** the Custom pill disappears

### Requirement: Fine-tune disclosure stays available

The `▾ Fine-tune` disclosure under the slider MUST render five aligned rows, one per flag: `Specrails specs`, `OpenSpec specs`, `Full repo read`, `External tools (MCPs)`, `Enrich with Contract Layer`. Each row MUST render the toggle styled identically to the existing Settings page toggles (height `h-5`, width `w-9`, theme tokens, `shrink-0`). Toggling any flag MUST write through to the same state the slider reads, so the slider's thumb position re-derives automatically.

#### Scenario: Disclosure starts collapsed
- **WHEN** the modal opens
- **THEN** the Fine-tune disclosure is collapsed by default
- **AND** the slider is fully visible above it

#### Scenario: Expanding the disclosure reveals five toggles
- **WHEN** the user clicks the `▾ Fine-tune` chevron
- **THEN** the five toggles render in fixed order: specrails, openspec, full, mcp, contractRefine
- **AND** the chevron rotates to `▴`

#### Scenario: Toggle changes propagate to the slider position
- **WHEN** the user clicks the `Specrails specs` toggle off while on `Standard`
- **THEN** the slider re-derives to `Custom` (specrails off but openspec on does not match any preset)

### Requirement: contractRefine persists in add_spec_context_scope_last

The per-project `add_spec_context_scope_last` payload SHALL include `contractRefine: boolean` alongside the other four flags. Boot order in the modal: (a) per-project last value when present → (b) `defaultBootScope` from project settings.

#### Scenario: Last value rehydrates on next open
- **GIVEN** the user last committed an Explore spec with scope `{ ..., contractRefine: true }`
- **WHEN** the user opens the Add Spec modal again for the same project
- **THEN** the slider boots on a preset that includes `contractRefine: true` (`Max` or `Desktop`, depending on other flags) — or `Custom` if no preset matches

#### Scenario: Missing field in legacy payload normalises to false
- **GIVEN** a stored `add_spec_context_scope_last` payload without `contractRefine`
- **WHEN** the modal boots
- **THEN** `contractRefine` is `false`
- **AND** the slider position reflects the matching preset for the remaining flags (or Custom)

### Requirement: Quick mode renders a standalone Contract Refine toggle

In Quick mode, the Add Spec modal SHALL render a single toggle labelled `Enrich with Contract Layer` underneath the model picker. The toggle MUST NOT render in Explore mode (where the slider already covers Contract Refine). The boot value of the Quick toggle MUST come from `add_spec_quick_contract_refine_last` (per project) when present, else the project setting `explore_contract_refine_enabled`. The toggle's value MUST be included in the request body of `POST /tickets/generate-spec` as `contractRefine: boolean`.

#### Scenario: Toggle visible only in Quick mode
- **WHEN** the user selects `Quick` in the segmented control
- **THEN** the Contract Refine toggle renders below the model picker
- **AND** when the user switches to `Explore` the toggle disappears (the slider covers it instead)

#### Scenario: Quick last-used value rehydrates on next open
- **GIVEN** the user last submitted a Quick spec with the toggle ON
- **WHEN** the user reopens the modal in Quick mode for the same project
- **THEN** the toggle boots ON

#### Scenario: Quick submit sends the field in the request body
- **WHEN** the user submits with the toggle ON
- **THEN** the body of the `POST /tickets/generate-spec` request includes `contractRefine: true`

### Requirement: Contract Refine sits at the heavy end of the slider

The slider's preset-to-flag mapping MUST place `contractRefine: true` ONLY at the two heaviest stops: `Max` and `Desktop`. The four lighter stops (`Minimal`, `Light`, `Standard`, `Rich`) MUST keep `contractRefine: false`. This positioning communicates that Contract Refine is the highest-cost / highest-output option.

#### Scenario: Light stops do not enable Contract Refine
- **WHEN** the slider is on any of `Minimal`, `Light`, `Standard`, or `Rich`
- **THEN** the bound scope's `contractRefine` is `false`

#### Scenario: Max and Desktop stops enable Contract Refine
- **WHEN** the slider is on `Max` or `Desktop`
- **THEN** the bound scope's `contractRefine` is `true`

### Requirement: Settings page relabels the project default

The Settings page Explore Spec card SHALL relabel the existing Contract Refine toggle to "Default for new Explore specs" with helper copy that clarifies the value seeds the modal's default and gates retry attempts. The PATCH endpoint and storage shape MUST be unchanged.

#### Scenario: Card label uses the new copy
- **WHEN** the user opens Settings → Explore Spec card
- **THEN** the second toggle reads "Default for new Explore specs"
- **AND** a helper line explains "Seeds the toggle in Add Spec and gates manual retry attempts"

#### Scenario: Endpoint shape unchanged
- **WHEN** the client PATCHes `/explore-contract-refine-enabled` with `{ enabled: true }`
- **THEN** the server still responds `{ enabled: true }` (no schema change)

### Requirement: Explore session captures short_summary at commit

The Explore flow SHALL request a `shortSummary` value in the same final AI call that produces title and description at `from-draft` commit time, and SHALL persist it on the resulting ticket.

#### Scenario: Summary present in commit
- **WHEN** the user commits an Explore session via `from-draft` and the model returns `shortSummary`
- **THEN** the committed ticket persists `short_summary` (trimmed, max 240 chars)

#### Scenario: Summary absent in commit response
- **WHEN** the model omits `shortSummary`
- **THEN** the committed ticket has `short_summary = null` (fresh insert) or preserves the prior value (flip-in-place)
- **AND** the commit succeeds

