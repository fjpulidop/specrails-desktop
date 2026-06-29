# specs-smash Specification

## Purpose

TBD - created by promoting delta spec from change `add-specs-smash`. Defines the SMASH feature that converts a Contract-Layer-enriched ticket into an épica with 3–8 auto-generated child tickets.
## Requirements
### Requirement: SMASH action visibility gate

The system SHALL render the SMASH action affordance in `TicketDetailModal` only when ALL of the following are true: (a) the ticket's `status` is not `'draft'`, (b) the ticket's `description` contains a `## Contract Layer` block (matching the separator used by the contract-refine feature), (c) the ticket has `parent_epic_id === null` (children cannot themselves be SMASHed), (d) the hub-wide kill switch `SPECRAILS_SMASH` is not disabled, and (e) the project's provider is NOT `'codex'`.

When any of (a)–(e) is false, the SMASH button MUST be hidden entirely (not rendered greyed-out). When the button would be hidden specifically because of (b) (no Contract Layer), the UI MAY surface an inert tooltip or helper text guiding the user to generate a Contract Layer first.

**Note:** Condition (e) is a new addition in this change. Conditions (a)–(d) and all non-provider scenarios are unchanged from the prior version of this requirement.

#### Scenario: Draft ticket with Contract Layer
- **WHEN** user opens `TicketDetailModal` for a ticket with `status === 'draft'` and a `## Contract Layer` block
- **THEN** the SMASH button is not rendered

#### Scenario: Committed ticket without Contract Layer
- **WHEN** user opens `TicketDetailModal` for a ticket with `status === 'todo'` and no `## Contract Layer` block
- **THEN** the SMASH button is not rendered

#### Scenario: Committed ticket with Contract Layer, Claude project
- **WHEN** user opens `TicketDetailModal` for a ticket with `status === 'todo'` and a `## Contract Layer` block, no parent, kill switch off, and the project's provider is `'claude'`
- **THEN** the SMASH button is rendered in the secondary actions row alongside Refresh Contract

#### Scenario: Child ticket
- **WHEN** user opens `TicketDetailModal` for a ticket with `parent_epic_id !== null`
- **THEN** the SMASH button is not rendered, regardless of the ticket's Contract Layer presence

#### Scenario: Kill switch disabled
- **WHEN** the server is started with `SPECRAILS_SMASH=0` and a ticket meeting all other gate conditions is opened
- **THEN** the SMASH button is not rendered

### Requirement: Inline confirmation before spawn

The SMASH action MUST present an inline confirmation step before any spawn fires. The confirmation SHALL replace the button content in-place (no separate modal overlay), show a brief warning that the ticket will become an épica with 3–8 child tickets, and offer exactly two actions: `Cancelar` and `Confirmar`.

#### Scenario: User clicks SMASH
- **WHEN** the user clicks the SMASH button
- **THEN** the button area swaps to an inline confirmation with `Cancelar` and `Confirmar` actions, and no spawn is initiated

#### Scenario: User cancels the inline confirm
- **WHEN** the user clicks `Cancelar` in the inline confirmation
- **THEN** the button area returns to its idle state and no spawn is initiated

#### Scenario: User confirms
- **WHEN** the user clicks `Confirmar` in the inline confirmation
- **THEN** the client POSTs to `/api/projects/:projectId/tickets/:id/smash` and the streaming UX activates

### Requirement: SMASH endpoint contract

The server SHALL expose `POST /api/projects/:projectId/tickets/:id/smash` that orchestrates a single fresh `claude` spawn (no `--resume`, max 1 turn) whose system prompt is the byte-stable `buildSmashSystemPrompt()` and whose user prompt is the épica's `title` and `description` concatenated. The spawn SHALL be invoked from an app-managed working directory that does not load the project's `CLAUDE.md` or `.mcp.json`. The endpoint MUST be idempotent at the run level (the client guards against double-fire while a SMASH is in flight) and MUST reject re-SMASH attempts against an épica that still has children.

#### Scenario: Successful SMASH
- **WHEN** the endpoint is invoked for a valid épica candidate, the spawn succeeds, and the output parses to 3–8 valid children
- **THEN** the server flips the original ticket to `is_epic = true`, inserts N children with `parent_epic_id` and `execution_order`, persists the store atomically, records an `ai_invocations` row with `surface='smash'`, and broadcasts `smash.completed`

#### Scenario: Already an épica with children
- **WHEN** the endpoint is invoked for a ticket that already has `is_epic = true` and at least one child with `parent_epic_id` equal to this ticket's id
- **THEN** the server responds `409` with body `{ reason: 'has-children' }` and performs no mutation

#### Scenario: Kill switch disabled
- **WHEN** the endpoint is invoked while `SPECRAILS_SMASH` is `0`, `false`, or `off` (case-insensitive)
- **THEN** the server responds `409` with body `{ reason: 'disabled' }` and performs no mutation, no spawn

#### Scenario: Ticket has no Contract Layer
- **WHEN** the endpoint is invoked for a ticket whose `description` does not contain `## Contract Layer`
- **THEN** the server responds `409` with body `{ reason: 'no-contract-layer' }` and performs no mutation

### Requirement: SMASH agent output validation

The agent's output SHALL be parsed as JSON and validated against a strict schema with `smashVersion === 1` and `children` length between 3 and 8 inclusive. Each child MUST have `title` (≤ 80 chars, non-empty), `description` (non-empty string), `priority` (one of `critical | high | medium | low`), `executionOrder` (1-based integer, contiguous and unique across the result), and `rationale` (≤ 200 chars). Any validation failure SHALL produce a `smash.failed` event with `reason: 'invalid-output'` and SHALL NOT mutate the store.

#### Scenario: Valid output
- **WHEN** the agent returns valid JSON matching the schema with 4 children
- **THEN** the server proceeds with the transactional flip + insert

#### Scenario: Output below minimum
- **WHEN** the agent returns valid JSON with `children.length === 2`
- **THEN** the server emits `smash.failed` with `reason: 'invalid-output'` and no mutation occurs

#### Scenario: Output above maximum
- **WHEN** the agent returns valid JSON with `children.length === 9`
- **THEN** the server emits `smash.failed` with `reason: 'invalid-output'` and no mutation occurs

#### Scenario: Non-contiguous executionOrder
- **WHEN** the agent returns children with `executionOrder` values `[1, 2, 4, 5]`
- **THEN** the server emits `smash.failed` with `reason: 'invalid-output'` and no mutation occurs

#### Scenario: Malformed JSON
- **WHEN** the agent's last stream-json result event cannot be parsed as JSON
- **THEN** the server emits `smash.failed` with `reason: 'invalid-output'` and no mutation occurs

### Requirement: Atomic épica flip and child insertion

The server SHALL perform the épica flip (`is_epic = true`) and the N child insertions inside a single `mutateStore` callback so the store is persisted with all changes or none. The mutation MUST happen under the existing advisory file lock. Children SHALL inherit no Contract Layer; their `description` is exactly what the agent returned. The épica's `description` MUST be preserved verbatim (including its existing Contract Layer block).

#### Scenario: Atomic success
- **WHEN** the mutation callback completes without throwing
- **THEN** `writeStore` is called once, the store's `revision` advances by exactly 1, and observers see all changes together

#### Scenario: Mutation throws mid-callback
- **WHEN** the callback throws after partially modifying the in-memory store
- **THEN** `writeStore` is NOT called, the on-disk store is unchanged, and `smash.failed` is emitted with `reason: 'mutation-failed'`

#### Scenario: Concurrent SMASHes serialize
- **WHEN** two SMASH requests for different tickets in the same project arrive simultaneously
- **THEN** the advisory file lock serialises them and both succeed in sequence with monotonically increasing `revision`

### Requirement: Child ticket schema fields

Each child ticket created by SMASH MUST be persisted with `is_epic = false`, `parent_epic_id` set to the épica's id, `execution_order` set to the value provided by the agent, `source = 'specs-smash'`, `status = 'todo'`, `origin_conversation_id = null`, and the priority chosen by the agent. The ticket store's `schema_version` MUST advance to `'1.2'` on the first write that creates or modifies épica/child fields, while remaining backwards-compatible at read time (older stores without these fields normalise to defaults on load).

#### Scenario: New fields persisted
- **WHEN** SMASH succeeds and the store is written
- **THEN** every child ticket in the resulting JSON has `is_epic`, `parent_epic_id`, `execution_order`, and `source` populated as specified

#### Scenario: Older store reads cleanly
- **WHEN** a store written under `schema_version === '1.1'` (no SMASH fields) is loaded
- **THEN** every ticket reads with `is_epic === false`, `parent_epic_id === null`, and `execution_order === null` without rewriting the file

#### Scenario: Schema version bump on first SMASH write
- **WHEN** SMASH succeeds against a `schema_version === '1.1'` store
- **THEN** the on-disk store's `schema_version` is `'1.2'` after `writeStore` returns

### Requirement: Streaming pills lifecycle

While a SMASH is in flight for a given ticket, the `TicketDetailModal` MUST render a three-stage pill indicator above the action area showing successive labels `Analizando spec…`, `Identificando subtareas…`, `Ordenando ejecución…`. Each pill MUST be visible for at least 150 ms (minimum-display floor) to prevent flicker. The pill indicator MUST disappear as soon as the corresponding `smash.completed` or `smash.failed` event arrives, or after a hard timeout of 60 seconds. The action button MUST remain disabled with a spinner during streaming.

#### Scenario: Pills appear after confirm
- **WHEN** the client receives `smash.started` for an open ticket modal
- **THEN** the pill indicator renders with the first pill visible

#### Scenario: Pills advance on progress
- **WHEN** `smash.progress` events arrive with `stage` values `'analyzing' | 'identifying' | 'ordering'`
- **THEN** the pill indicator advances accordingly, with each pill held visible for at least 150 ms before transitioning

#### Scenario: Pills disappear on completion
- **WHEN** `smash.completed` arrives
- **THEN** the pill indicator unmounts and the modal re-renders the épica state with the children section visible

#### Scenario: Pills disappear on failure
- **WHEN** `smash.failed` arrives
- **THEN** the pill indicator unmounts, the action button returns to its idle state, and an error toast is shown

### Requirement: Success toast with Deshacer

On `smash.completed`, the client SHALL display a sonner toast with the success message including the number of children created and the épica title, a 10-second duration, and a `Deshacer` action button. Clicking `Deshacer` SHALL POST to `/api/projects/:projectId/tickets/:id/smash/undo` which reverses the SMASH by deleting the children created in this run and clearing `is_epic`. The toast MUST use the glass-card chrome shared with Quick spec generation and minimized-chat chips.

#### Scenario: Toast on success
- **WHEN** `smash.completed` arrives with `childrenIds.length === 4`
- **THEN** a sonner toast appears with text indicating "4 tickets" and the épica's title, and a `Deshacer` action

#### Scenario: Deshacer reverses the SMASH
- **WHEN** the user clicks `Deshacer` within the 10-second window
- **THEN** the client POSTs to the undo endpoint, the server deletes the children and clears `is_epic`, and broadcasts `smash.undone` plus the corresponding `ticket_deleted` and `ticket_updated` events

#### Scenario: Toast auto-dismisses after 10 s
- **WHEN** 10 seconds elapse without the user clicking Deshacer
- **THEN** the toast auto-dismisses; the SMASH stays applied

### Requirement: Failure toast with Reintentar

On `smash.failed`, the client SHALL display a destructive sonner toast describing the failure with a `Reintentar` action that re-POSTs to the SMASH endpoint. The toast SHALL NOT use the glass-card success chrome; it uses the destructive toast variant consistent with Contract Refine failure toasts.

#### Scenario: Failure toast
- **WHEN** `smash.failed` arrives with `reason: 'invalid-output'`
- **THEN** the destructive toast appears with a human-readable description and a `Reintentar` action

#### Scenario: Reintentar fires a new SMASH
- **WHEN** the user clicks `Reintentar`
- **THEN** the client POSTs again to `/tickets/:id/smash` and the streaming UX activates from the beginning

### Requirement: Épica rendering on board

Ticket card components (`SpecCard`, `TicketListView`, `TicketGridView`, `TicketPostItView`, `TicketStatusIndicator`) SHALL render an additional `💥 N hijos` badge whenever `is_epic === true`, where N is the count of tickets with `parent_epic_id` equal to this ticket's id. The badge MUST be themed with semantic tokens (`accent-highlight`) and MUST NOT alter the ticket's column placement, status indicator, or priority pill.

#### Scenario: Épica badge with children
- **WHEN** a ticket has `is_epic === true` and 4 tickets reference it via `parent_epic_id`
- **THEN** the card renders the badge "💥 4 hijos"

#### Scenario: Épica with zero children renders as épica
- **WHEN** a ticket has `is_epic === true` but no tickets reference it (e.g., after all children were manually deleted)
- **THEN** the card renders the badge "💥 0 hijos" and the ticket is eligible for re-SMASH

### Requirement: Child rendering on board

Ticket cards for tickets with `parent_epic_id !== null` SHALL render an additional clickable `↑ Épica: <title>` pill, where `<title>` is the title of the épica resolved by lookup. Clicking the pill SHALL open `TicketDetailModal` for the épica. The pill MUST use the `accent-secondary` semantic token to remain coherent with existing variant pills (e.g., the draft pill). Children remain in the same Backlog column as the épica; they are not visually grouped or indented, and they are not collapsed.

#### Scenario: Child card pill
- **WHEN** a ticket has `parent_epic_id === 42` and ticket 42 exists with title "Real-time collab"
- **THEN** the card renders a pill labelled "↑ Épica: Real-time collab"

#### Scenario: Child of deleted épica
- **WHEN** a ticket has `parent_epic_id === 42` but ticket 42 has been deleted (orphan)
- **THEN** the card renders no épica pill (the ticket is treated as a normal ticket)

#### Scenario: Backlog ordering
- **WHEN** the Backlog list is sorted under its default mode
- **THEN** child tickets with `parent_epic_id !== null` sort by `execution_order` ascending when their parent and creation timestamps tie

### Requirement: Hijos section in épica modal

The `TicketDetailModal` for a ticket with `is_epic === true` MUST render a `Hijos (N)` section below the description that lists each child in `execution_order` ascending. Each child entry SHALL show its ordinal, title, priority pill, and an affordance to navigate into that child's modal. The section MUST also expose a `Re-SMASH` action and an action that triggers a confirmation to delete all children at once.

#### Scenario: Section rendered for épica
- **WHEN** the modal opens for a ticket with `is_epic === true` and 4 children
- **THEN** the modal renders a "Hijos (4)" section listing the four children sorted by `execution_order`

#### Scenario: Re-SMASH while children exist
- **WHEN** the user clicks `Re-SMASH` on an épica with existing children
- **THEN** a confirmation appears stating that the existing children will be deleted

#### Scenario: Re-SMASH after children deleted
- **WHEN** the user confirms the Re-SMASH deletion
- **THEN** the server deletes the children, then the client immediately POSTs a fresh SMASH against the same épica

### Requirement: Breadcrumb on child modal

The `TicketDetailModal` for a ticket with `parent_epic_id !== null` MUST render a breadcrumb at the top of the modal showing `← <epic title>` that navigates the modal stack to the épica. The modal MUST also render a "Parte de épica · paso K de N" indicator where K is `execution_order` and N is the total child count, derived live.

#### Scenario: Breadcrumb visible
- **WHEN** the modal opens for a child with `parent_epic_id === 42` (épica title "Real-time collab", `execution_order = 2`, total siblings = 4)
- **THEN** the modal renders a breadcrumb "← Real-time collab" and an indicator "Parte de épica · paso 2 de 4"

#### Scenario: Breadcrumb click navigates
- **WHEN** the user clicks the breadcrumb
- **THEN** the modal stack navigates to the épica's `TicketDetailModal`

### Requirement: Épica deletion orphans children

Deleting an épica (via the existing `DELETE /tickets/:id` endpoint) MUST NOT cascade-delete its children. Instead, every ticket with `parent_epic_id` equal to the deleted épica's id MUST have its `parent_epic_id` set to `null` and its `execution_order` set to `null` in the same `mutateStore` callback. The corresponding `ticket_updated` events MUST be broadcast for each orphaned child.

#### Scenario: Épica deleted with children
- **WHEN** the user deletes an épica that has 3 children
- **THEN** the épica row is removed, every child's `parent_epic_id` and `execution_order` are cleared to `null`, and three `ticket_updated` broadcasts fire

#### Scenario: Épica deleted with no children
- **WHEN** the user deletes an épica with no children
- **THEN** the épica row is removed and no additional broadcasts fire

### Requirement: Analytics surface integration

Every SMASH spawn (success, failure, undo, retry) MUST record one row in `ai_invocations` with `surface = 'smash'`, `ticket_id` set to the épica's id, `conversation_id = null`, and the full duration / token / cost fields populated from the spawn's `result` event. The `AnalyticsPage` MUST include `smash` in its surface filter chips, colour the surface with `accent-highlight`, and include it in the daily timeline, by-surface aggregation, and CSV/JSON exports without further code changes per consumer.

#### Scenario: Invocation row on success
- **WHEN** SMASH completes successfully
- **THEN** an `ai_invocations` row exists with `surface='smash'`, `ticket_id` = épica id, `status = 'completed'`, and non-null cost/token fields

#### Scenario: Invocation row on failure
- **WHEN** SMASH fails with invalid output
- **THEN** an `ai_invocations` row exists with `surface='smash'`, `status = 'failed'`, and the duration field populated up to the failure point

#### Scenario: Analytics chip
- **WHEN** the user opens `AnalyticsPage` and clicks the `smash` surface chip
- **THEN** the page filters its aggregations and table to only the SMASH rows

### Requirement: Kill switch behaviour

The app-wide environment variable `SPECRAILS_SMASH` MUST be honoured at three layers: (a) `POST /tickets/:id/smash` returns `409 { reason: 'disabled' }`, (b) the per-project config response includes `featureFlags.smash: false` so the client hides the button, and (c) Re-SMASH and Deshacer endpoints reject with the same `disabled` reason. The kill switch SHALL accept the case-insensitive values `0`, `false`, and `off` to mean disabled; any other value (including unset) means enabled.

#### Scenario: Kill switch off (default)
- **WHEN** the server starts without `SPECRAILS_SMASH` set
- **THEN** the SMASH feature is enabled and the button is rendered for eligible tickets

#### Scenario: Kill switch disabled
- **WHEN** the server starts with `SPECRAILS_SMASH=0`
- **THEN** the SMASH endpoint returns 409, the config response surfaces `featureFlags.smash: false`, and the button is hidden

#### Scenario: Mixed-case disable value
- **WHEN** the server starts with `SPECRAILS_SMASH=Off`
- **THEN** the feature is disabled, identical to `SPECRAILS_SMASH=0`

### Requirement: SMASH decomposition produces short_summary per sub-spec

Both SMASH modes (Simple and Full) SHALL request a `shortSummary` field for each sub-spec produced and persist it on the created child tickets.

#### Scenario: Simple mode generates summary per sub-spec
- **WHEN** a parent ticket is decomposed using SMASH Simple
- **THEN** each child ticket created has `short_summary` populated from the model's response
- **AND** if the model omits `shortSummary` for a child, that child has `short_summary = null`

#### Scenario: Full mode generates summary per sub-spec
- **WHEN** a parent ticket is decomposed using SMASH Full
- **THEN** each child ticket created has `short_summary` populated from the model's response
- **AND** missing values default to null without aborting decomposition

