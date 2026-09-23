# ai-refine-custom-agents Specification

## Purpose
TBD - created by syncing change add-ai-refine-custom-agents. Update Purpose after archive.
## Requirements
### Requirement: AI Edit entry point on the Agents Catalog

The Agents Catalog SHALL render an **AI Edit** action button on every agent card whose `kind === 'custom'`, alongside the existing Duplicate and Edit buttons. The button SHALL NOT appear on `kind === 'upstream'` agents.

#### Scenario: AI Edit visible on custom agent
- **WHEN** the user opens the Agents Catalog tab and selects a custom agent (`kind: 'custom'`)
- **THEN** the agent detail header renders three actions in order: Duplicate, Edit, AI Edit
- **AND** clicking AI Edit opens the AI Refine overlay scoped to that agent

#### Scenario: AI Edit hidden on upstream agent
- **WHEN** the user selects an upstream agent (`kind: 'upstream'`)
- **THEN** the AI Edit button is not rendered
- **AND** only Duplicate is offered (matching current behavior)

### Requirement: AI Refine overlay has three UI states

The AI Refine surface SHALL render in one of three states: **Composing** (instruction input only, no draft), **Streaming** (chat with token-stream cursor + staged status pills + skeleton diff), or **Reviewing** (chat history + diff + Apply/Discard/Open-in-Studio actions). The state SHALL be derived from the client values `draftBody`, `phase`, and `streaming` — no extra server polling required to transition.

#### Scenario: Composing to Streaming
- **WHEN** the user submits an instruction from the Composing state
- **THEN** the overlay transitions to Streaming
- **AND** the chat shows a token-stream cursor
- **AND** the status pills render `reading` active, `drafting`/`validating`/`testing`/`done` pending

#### Scenario: Streaming to Reviewing
- **WHEN** the server emits `agent_refine_ready` with a non-empty `draftBody`
- **THEN** the overlay transitions to Reviewing
- **AND** the diff pane renders the word-level diff of the on-disk body vs `draftBody`
- **AND** the input field clears and refocuses for the next refinement turn

#### Scenario: Reviewing to Streaming on follow-up turn
- **WHEN** the user submits a refinement instruction in Reviewing state
- **THEN** the overlay transitions back to Streaming
- **AND** the previous chat turns remain visible above the new streaming turn
- **AND** the diff pane shows a shimmer overlay until the new draft is ready

### Requirement: Multi-turn refinement uses session resume

The server SHALL spawn `claude` with `--resume <sessionId>` for every turn after the first, where `sessionId` is the value persisted in `agent_refine_sessions.session_id` from the first turn's stream.

#### Scenario: First turn starts a new claude session
- **WHEN** the user submits the first instruction for a refine session
- **THEN** the server spawns `claude` without `--resume`
- **AND** captures `session_id` from the stream-json `system`/`init` block
- **AND** persists it on the `agent_refine_sessions` row

#### Scenario: Subsequent turn resumes the session
- **WHEN** the user submits a follow-up instruction and `agent_refine_sessions.session_id` is non-null
- **THEN** the server spawns `claude --resume <sessionId>`

### Requirement: Token streaming and staged status pills drive progress feedback

The server SHALL emit two parallel signal streams over WebSocket per turn: `agent_refine_stream` deltas (raw text chunks for the chat cursor) and `agent_refine_phase` events (named phase transitions for the pills).

#### Scenario: Phase pills transition in order
- **WHEN** a turn starts
- **THEN** the server emits `agent_refine_phase` events in order: `reading`, `drafting`, `validating`, optionally `testing`, then `done`
- **AND** the client renders each pill as pending → active (spinner) → completed

#### Scenario: Token deltas append to chat
- **WHEN** the server emits `agent_refine_stream` with `deltaText`
- **THEN** the chat appends the delta to the current assistant turn
- **AND** the delta is surfaced via `aria-live="polite"` to assistive tech

### Requirement: Apply path reuses the existing custom-agent write logic

The Apply action SHALL submit the `draftBody` through a server endpoint that wraps the same write logic used by `PATCH /api/projects/:projectId/profiles/catalog/:agentId`, including frontmatter validation, custom-prefix check, file write, and `agent_versions` insert.

#### Scenario: Apply succeeds
- **WHEN** the user clicks Apply in the Reviewing state
- **AND** the on-disk body hash equals `agent_refine_sessions.base_body_hash`
- **AND** the `name` field in the draft equals the current agent name
- **THEN** the server writes the new body to `.claude/agents/<agentId>.md`
- **AND** inserts a new row in `agent_versions`
- **AND** sets `agent_refine_sessions.status = 'applied'`
- **AND** broadcasts the existing catalog change WS event
- **AND** the overlay closes

#### Scenario: Apply blocked by concurrent disk edit
- **WHEN** the user clicks Apply
- **AND** the on-disk body hash differs from `agent_refine_sessions.base_body_hash`
- **THEN** the server returns HTTP 409 with `{ reason: "disk_changed" }`
- **AND** the overlay surfaces a "File changed on disk" message with options Reopen, Force-apply, Discard
- **AND** no write occurs

#### Scenario: Apply blocked by name change
- **WHEN** the draft body's frontmatter `name` differs from the current agent's name
- **THEN** the server returns HTTP 409 with `{ reason: "name_changed" }`
- **AND** the overlay surfaces "AI changed the agent name; rename is a separate action"
- **AND** no write occurs

### Requirement: Optional auto-test in Smart mode

Each refine session SHALL track an `auto_test` flag, defaulting to ON. When ON, the server SHALL run `testCustomAgent()` after a turn reaches the `ready` phase **only if** (a) `draftBody` differs from the body used in the last test for this session, AND (b) `>5s` have elapsed since the last test in this session.

#### Scenario: Auto-test runs in Smart mode
- **WHEN** a turn reaches `ready` and `auto_test = 1` and the Smart-mode conditions are met
- **THEN** the server emits `agent_refine_phase` with `testing`
- **AND** runs `testCustomAgent` against the most-recent test in `agent_tests` for this agent (or the built-in fallback)
- **AND** emits `agent_refine_test` with the structured result
- **AND** the chat renders a system turn `kind: 'test_result'` with the outcome

#### Scenario: Auto-test toggle persists per session
- **WHEN** the user toggles auto-test off in the overlay
- **THEN** `agent_refine_sessions.auto_test` is updated to 0
- **AND** subsequent turns skip the testing phase

### Requirement: Session lifecycle and cancellation

The server SHALL persist a row in `agent_refine_sessions` for every refine session and SHALL support cancelling an in-flight turn via `DELETE /api/projects/:projectId/profiles/catalog/:agentId/refine/:refineId`.

#### Scenario: Cancel kills the spawn
- **WHEN** the user clicks Discard during the Streaming state
- **THEN** the server kills the active claude spawn
- **AND** sets `agent_refine_sessions.status = 'cancelled'`
- **AND** emits `agent_refine_cancelled`
- **AND** the overlay closes without writing to disk

#### Scenario: Reconnect resumes session view
- **WHEN** a WebSocket disconnects mid-stream and reconnects
- **THEN** the client fetches `GET /api/projects/.../refine/:refineId`
- **AND** rehydrates the chat history, current `draftBody`, and active phase from server state
- **AND** the diff pane re-renders without losing in-flight content

#### Scenario: Stale draft sessions are pruned at server startup
- **WHEN** the server starts up
- **THEN** rows in `agent_refine_sessions` with `status IN ('cancelled','error') AND updated_at < now - 24h` are deleted
- **AND** rows with `status = 'streaming' AND updated_at < now - 24h` are marked `error` and pruned
- **AND** rows with `status IN ('ready','applied')` are retained indefinitely

### Requirement: Open-in-Studio handoff

The overlay SHALL provide an "Open in Studio" action that navigates to `AgentStudio` for the current agent and passes the in-flight `refineId` as a query parameter, so the Studio can rehydrate the draft body for manual editing.

#### Scenario: Handoff with active draft
- **WHEN** the user clicks "Open in Studio" in the Reviewing state
- **THEN** the overlay closes
- **AND** the route navigates to AgentStudio for the agent with `?draftFromRefine=<refineId>`
- **AND** Studio loads `draft_body` as the editor's current value
- **AND** Studio displays a "Resume AI Edit" pill linking back to the overlay

### Requirement: Full keyboard accessibility and reduced-motion support

The AI Refine overlay SHALL be fully operable from the keyboard and SHALL honor `prefers-reduced-motion` and color-blind-safe diff cues.

#### Scenario: Keyboard shortcuts
- **WHEN** focus is inside the overlay
- **THEN** `⌘⏎` / `Ctrl+Enter` triggers Apply (in Reviewing state) or submit (in Composing state)
- **AND** `Esc` triggers Discard with confirmation if a non-empty draft exists
- **AND** `J` / `K` move between diff hunks (in Reviewing state)
- **AND** `⌘K` / `Ctrl+K` focuses the chat input

#### Scenario: Focus trap and restoration
- **WHEN** the overlay opens from a catalog card
- **THEN** focus moves to the chat input
- **AND** Tab cycling stays inside the overlay
- **AND** on close, focus returns to the originating "AI Edit" button

#### Scenario: Diff is color-blind safe
- **WHEN** the diff renders
- **THEN** added segments include a leading `+` glyph in addition to green styling
- **AND** removed segments include a leading `−` glyph in addition to red styling

#### Scenario: Reduced motion disables animation
- **WHEN** the user agent reports `prefers-reduced-motion: reduce`
- **THEN** the diff shimmer and fade transitions are not rendered
- **AND** state transitions are instantaneous

### Requirement: Refine flow is gated to custom agents and the agents-section feature flag

The refine endpoints and overlay SHALL be available only when `SPECRAILS_AGENTS_SECTION !== 'false'` (matching the existing `profiles-router` gate) and only for agents with `id` matching `^custom-`.

#### Scenario: Feature flag disabled
- **WHEN** the server starts with `SPECRAILS_AGENTS_SECTION=false`
- **THEN** the refine routes return 404
- **AND** the AI Edit button is not rendered in the catalog

#### Scenario: Refine attempted on upstream agent
- **WHEN** a client posts to `/refine` with a non-`custom-` agent id
- **THEN** the server returns HTTP 400 with `{ reason: "not_a_custom_agent" }`

### Requirement: AI Refine overlay can be minimized to the dock

The AI Refine overlay SHALL expose a minimize control in its header, distinct from the existing close button. Activating the minimize control MUST hide the overlay without unmounting it, without cancelling any in-flight refine turn, and without writing the draft to disk. A chip MUST be registered in the global minimized chats dock.

#### Scenario: Minimize during streaming does not cancel
- **WHEN** the user clicks the minimize control while the overlay is in the Streaming state
- **THEN** the overlay is hidden
- **AND** the active refine spawn continues running on the server
- **AND** `agent_refine_sessions.status` remains `streaming`
- **AND** a chip with the agent name appears in the dock

#### Scenario: Minimize during reviewing preserves diff
- **WHEN** the user clicks the minimize control while the overlay is in the Reviewing state with a pending diff
- **THEN** the overlay is hidden
- **AND** the chip is added to the dock
- **AND** restoring the chip later shows the same `draftBody`, `history[]`, and diff pane content

#### Scenario: AiEdit shell hoisted out of AgentsCatalogTab
- **WHEN** an AiEdit session is active and the user navigates away from `/agents`
- **THEN** the AiEdit shell remains mounted (in the global minimized chats provider's hidden host)
- **AND** the session is reachable from the dock chip on any project route

#### Scenario: Restore from chip preserves all refine state
- **WHEN** the user clicks the chip for a previously minimized AiEdit session
- **THEN** the active project switches to the session's owning project (if different)
- **AND** the application navigates to `/agents` with the catalog tab active
- **AND** the overlay is shown with the same `refineId`, `agentId`, `baseBody`, `draftBody`, `history[]`, `streamingText`, `phase`, `uiState`, `testResult`, and `appliedVersion` as before minimize

### Requirement: AI Refine regenerates short_summary when description changes

The AI Refine flow (`server/modules/agents/runtime/agent-refine-manager.ts`) SHALL request a `shortSummary` field in the refine response prompt, and SHALL update the ticket's `short_summary` only when the model returns a non-empty value.

#### Scenario: Refine returns new summary
- **WHEN** AI Refine returns a response with `shortSummary`
- **THEN** the ticket's `short_summary` is updated to the new trimmed value
- **AND** the WS `ticket_updated` event includes the new summary

#### Scenario: Refine omits summary
- **WHEN** AI Refine returns a response without `shortSummary` (or with an empty string)
- **THEN** the ticket's existing `short_summary` is preserved (not overwritten to null)

#### Scenario: Refine only touches summary alongside content changes
- **WHEN** AI Refine does not change title or description
- **THEN** `short_summary` is left untouched regardless of what the model returns

