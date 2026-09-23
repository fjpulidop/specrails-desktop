# ticket-drafts Specification

## Purpose

Lets a user persist an in-progress Explore session as a **draft ticket** that lives on the SpecsBoard until they either commit it to a real spec or discard it. Drafts use the existing per-project ticket store (`server/modules/specs/runtime/ticket-store.ts`, `<project>/.specrails/local-tickets.json`) so they appear naturally alongside other tickets without a separate column, filter, or collapsible section. Resuming a draft reuses the existing `resumeConversationId` plumbing in `ExploreSpecShell`.

## Requirements

### Requirement: Tickets support a `draft` status

The `TicketStatus` union exposed by the per-project ticket store (`server/modules/specs/runtime/ticket-store.ts`) SHALL accept the value `draft`. A ticket with `status='draft'` represents an in-progress Explore exploration that the user has chosen to persist for later resumption. The `draft` status MUST be a valid source for transitions into the existing initial active status (e.g., `todo`). The store's `schema_version` for stores created or written by this version SHALL be `'1.1'` or later. Stores at `'1.0'` MUST remain readable; missing `origin_conversation_id` MUST be treated as `null`.

#### Scenario: Draft ticket persists across server restarts
- **WHEN** a ticket is created with `status='draft'`
- **AND** the server is restarted
- **THEN** the ticket is still present in `local-tickets.json` with `status='draft'`
- **AND** its linked `chat_conversations` row is still present with `kind='explore'`

#### Scenario: Existing tickets are unaffected by the enum widening
- **WHEN** a project's `local-tickets.json` is read after the code change ships
- **THEN** every pre-existing ticket retains its previous `status` value verbatim
- **AND** every pre-existing ticket retains a non-null `priority`
- **AND** every pre-existing ticket reads with `origin_conversation_id = null` if the field is absent on disk

### Requirement: Priority is nullable while a ticket is in draft

The `Ticket.priority` field SHALL be widened to allow `null`. A ticket MAY have `priority = null` while `status='draft'`. The server MUST reject any transition that leaves `priority = null` once `status` becomes any value other than `draft`. Validation helpers (the equivalent of `isValidPriority` for non-draft states) MUST treat `null` as invalid for non-draft tickets.

#### Scenario: Draft accepts null priority
- **WHEN** a draft ticket is created without a priority
- **THEN** the ticket is persisted with `priority = null` and `status = 'draft'`
- **AND** no validation error is raised

#### Scenario: Transition out of draft requires priority
- **WHEN** the server receives a request to set a draft ticket's `status` to a non-draft value
- **AND** the request does not provide a non-null `priority` and the ticket's `priority` is `null`
- **THEN** the request is rejected with a 400-class error
- **AND** the ticket's `status` remains `draft`

### Requirement: Tickets carry an `origin_conversation_id` linking to their Explore conversation

The `Ticket` interface SHALL gain a nullable `origin_conversation_id: string | null` field that holds the id of a row in `chat_conversations`. When a ticket is saved as a draft from an Explore session, the server MUST populate this field with the conversation's id. When the draft is committed to a non-draft status, the server MUST preserve the value (it MUST NOT clear it). Because tickets live in a JSON store, the cascade behaviour (the equivalent of `ON DELETE SET NULL`) MUST be enforced by the server at every code path that deletes an Explore conversation.

#### Scenario: Draft ticket records its conversation id at save time
- **WHEN** a draft ticket is created from an Explore session
- **THEN** the ticket's `origin_conversation_id` equals the Explore conversation's id

#### Scenario: Commit preserves the origin conversation id
- **WHEN** a draft ticket transitions to a non-draft status (commit)
- **THEN** the ticket's `origin_conversation_id` retains the same value it had while in draft

#### Scenario: Conversation deletion does not delete the ticket
- **WHEN** a `chat_conversations` row referenced by a ticket's `origin_conversation_id` is deleted
- **THEN** the ticket remains present in `local-tickets.json`
- **AND** the ticket's `origin_conversation_id` is cleared to `null` by the server's cascade-cleanup path

### Requirement: Board ticket card visually marks draft tickets

A ticket card rendered on the SpecsBoard SHALL display a visually distinct treatment when its underlying ticket has `status='draft'`. The treatment MUST satisfy all of the following: (a) the tarjeta uses a background and/or border colour that differs from the non-draft tarjeta in the same column, derived from semantic theme tokens (no brand-named or hardcoded colours); (b) the priority pill (`High`/`Medium`/`Low`) MUST NOT render; (c) a `Draft` pill MUST render in the same DOM slot the priority pill would otherwise occupy; (d) no other tarjeta layout invariants change. The card MUST appear in the same Backlog column as non-draft tickets — there is no separate Drafts column, no filter chip, and no collapsible section.

#### Scenario: Draft tarjeta renders with the Draft pill in place of priority
- **WHEN** the SpecsBoard renders a ticket with `status='draft'`
- **THEN** the tarjeta has the draft visual treatment
- **AND** a `Draft` pill is shown
- **AND** no `High`/`Medium`/`Low` pill is shown

#### Scenario: Draft tarjeta lives in the Backlog column
- **WHEN** the SpecsBoard renders a project that contains both draft and non-draft tickets
- **THEN** drafts are rendered inside the Backlog column alongside other Backlog tickets
- **AND** no separate `Drafts` column is rendered
- **AND** no draft-specific filter chip is rendered

#### Scenario: Visual treatment uses theme tokens
- **WHEN** a draft tarjeta is rendered under any of the supported themes (`dracula`, `aurora-light`, `obsidian-dark`)
- **THEN** the tarjeta's background/border colours resolve from semantic theme tokens
- **AND** no brand-named or hardcoded hex colours are used

### Requirement: Ticket detail modal exposes a Continue Explore action for draft tickets

When `TicketDetailModal` opens a ticket with `status='draft'` and a non-null `origin_conversation_id`, it SHALL render a `Continue Explore` primary action. Activating this action MUST reopen `ExploreSpecShell` for the conversation referenced by `origin_conversation_id`, using the existing `resumeConversationId` resume path. The ticket MUST remain `status='draft'` while the resumed session is active.

#### Scenario: Continue Explore appears on draft tickets
- **WHEN** the user opens `TicketDetailModal` on a ticket with `status='draft'`
- **AND** the ticket's `origin_conversation_id` is non-null
- **THEN** a `Continue Explore` action is rendered

#### Scenario: Continue Explore reopens the shell with full history
- **WHEN** the user activates `Continue Explore` on a draft ticket
- **THEN** `ExploreSpecShell` opens with the same conversation history, draft fields, attachments, and streaming state that were associated with `origin_conversation_id`
- **AND** the ticket's `status` remains `draft`

#### Scenario: Continue Explore is hidden when origin conversation is missing
- **WHEN** the user opens `TicketDetailModal` on a ticket with `status='draft'` and `origin_conversation_id IS NULL`
- **THEN** no `Continue Explore` action is rendered

### Requirement: Drafts are never auto-deleted

The system SHALL NOT auto-delete, auto-archive, or auto-expire draft tickets based on age, inactivity, or any time-based policy. A draft ticket MUST remain present until either (a) the user explicitly discards it, or (b) the user commits it to a non-draft status.

#### Scenario: Old drafts persist indefinitely
- **WHEN** a draft ticket has not been touched for an arbitrary period of time
- **THEN** the ticket remains present in the database
- **AND** it remains visible on the SpecsBoard

#### Scenario: Discard removes the draft
- **WHEN** the user explicitly discards a draft ticket
- **THEN** the ticket is removed from the database
- **AND** it disappears from the SpecsBoard

### Requirement: Ticket list consumers exclude drafts unless drafts are explicitly requested

Server consumers that iterate `Object.values(store.tickets)` for purposes other than the SpecsBoard (analytics rollups, implement/batch-implement launch dialogs, activity feed, CSV/JSON exports, and equivalent surfaces) SHALL exclude tickets with `status='draft'` by default. The SpecsBoard listing endpoint (`GET /:projectId/tickets`) MUST include drafts. Endpoints MAY accept an explicit opt-in parameter to include drafts where it is meaningful.

#### Scenario: SpecsBoard listing includes drafts
- **WHEN** the SpecsBoard fetches tickets for a project that contains drafts
- **THEN** the response includes the drafts

#### Scenario: Implement launch dialog excludes drafts
- **WHEN** the implement (or batch-implement) launch dialog fetches the ticket picker list
- **THEN** the response excludes tickets with `status='draft'`

#### Scenario: Analytics aggregations exclude drafts
- **WHEN** any analytics aggregation that counts or groups tickets is computed
- **THEN** tickets with `status='draft'` are excluded from the aggregation

### Requirement: Save-as-Draft demotes a non-draft ticket in place when `editTicketId` is supplied

The `POST /:projectId/tickets/save-as-draft` endpoint SHALL accept an optional `editTicketId: number` field on the request body. When `editTicketId` is provided AND a ticket with that id exists in the project's local ticket store, the endpoint MUST update **that ticket** in place (preserving its `id`, `created_at`, `created_by`, `source`, `assignee`, `prerequisites`, `metadata`, and `comments`) and MUST set:

- `status` → `'draft'`
- `priority` → `null`
- `origin_conversation_id` → the request's `conversationId`
- `title` / `description` / `labels` → the values supplied on the body, using the same merge rules as the existing endpoint (provided title falls back to the existing title or the auto-generated title; description and labels are replaced when supplied)
- `updated_at` → the current ISO timestamp

The endpoint MUST NOT insert a new ticket when `editTicketId` is provided. The endpoint MUST NOT consult the existing `(origin_conversation_id, status='draft')` lookup when `editTicketId` is provided. The endpoint MUST broadcast a `ticket_updated` WebSocket message for the demoted ticket. The response status MUST be 200 OK (not 201) when an existing ticket is updated, and the response body MUST contain the updated ticket.

#### Scenario: Save as Draft on a `todo` ticket flips it to draft in place

- **WHEN** the client posts to `/tickets/save-as-draft` with `{ conversationId, editTicketId, title, description, labels }`
- **AND** the ticket identified by `editTicketId` exists with `status='todo'` and `priority='high'`
- **THEN** the response status is 200
- **AND** the same ticket id is returned
- **AND** the persisted ticket has `status='draft'`, `priority=null`, `origin_conversation_id=conversationId`
- **AND** the persisted ticket retains its original `created_at`, `created_by`, and `source`
- **AND** a `ticket_updated` WebSocket message is broadcast carrying the demoted ticket

#### Scenario: Save as Draft on a `backlog` ticket flips it to draft in place

- **WHEN** the client posts to `/tickets/save-as-draft` with `{ conversationId, editTicketId }`
- **AND** the ticket identified by `editTicketId` exists with `status='backlog'`
- **THEN** the persisted ticket has `status='draft'` and `priority=null`
- **AND** no new ticket is inserted into the store
- **AND** the response carries the same `id` that was supplied

#### Scenario: `editTicketId` resolving to a missing ticket returns 404

- **WHEN** the client posts to `/tickets/save-as-draft` with `editTicketId=999999`
- **AND** no ticket with id 999999 exists in the project's store
- **THEN** the response status is 404
- **AND** no ticket is inserted or modified
- **AND** no WebSocket message is broadcast

#### Scenario: `editTicketId` of the wrong type returns 400

- **WHEN** the client posts to `/tickets/save-as-draft` with `editTicketId="abc"`
- **THEN** the response status is 400
- **AND** no ticket is inserted or modified

### Requirement: Save-as-Draft is idempotent for repeated demotions on the same ticket

When the `POST /:projectId/tickets/save-as-draft` endpoint receives a second request with the same `editTicketId` and `conversationId`, and the ticket is already `status='draft'` with the same `origin_conversation_id`, it SHALL succeed with 200, update only the supplied `title` / `description` / `labels` (and `updated_at`), MUST NOT insert a new ticket, MUST NOT change `priority` (it remains `null`), MUST NOT change `status`, and MUST broadcast `ticket_updated`.

#### Scenario: Second save in the same session does not duplicate the ticket

- **WHEN** the client posts `/tickets/save-as-draft` twice with the same `(editTicketId, conversationId)` in the same Explore session
- **THEN** both requests return 200
- **AND** the project's ticket store contains exactly one ticket with id `editTicketId` after both requests
- **AND** the ticket's `status` is `draft` and `priority` is `null`
- **AND** the ticket's `title`/`description`/`labels` reflect the second request's payload

#### Scenario: Save-as-Draft on a ticket already in draft is a no-op flip

- **WHEN** the client opens an already-`draft` ticket via Continue Editing and clicks Save as Draft
- **AND** posts `/tickets/save-as-draft` with `editTicketId` for that draft and the current `conversationId`
- **THEN** the response status is 200
- **AND** the ticket's `status` remains `draft`
- **AND** the ticket's `priority` remains `null`
- **AND** the ticket's `origin_conversation_id` is updated to the current `conversationId`

### Requirement: Save-as-Draft without `editTicketId` preserves the original fresh-session behaviour

When `editTicketId` is absent from the `POST /:projectId/tickets/save-as-draft` request body, the endpoint SHALL behave exactly as before this change: it MUST look up an existing ticket by `(origin_conversation_id === conversationId AND status === 'draft')`, update it in place if found, or insert a new draft ticket if not. The response code, broadcast type, and persisted shape MUST be unchanged from the prior behaviour.

#### Scenario: Fresh Explore session without `editTicketId` still inserts a new draft

- **WHEN** the client posts `/tickets/save-as-draft` with `{ conversationId }` and no `editTicketId`
- **AND** no draft ticket exists with `origin_conversation_id === conversationId`
- **THEN** a new draft ticket is inserted with the next sequential id
- **AND** the response status is 201
- **AND** a `ticket_created` WebSocket message is broadcast

#### Scenario: Repeated save in the same fresh session updates the same draft

- **WHEN** the client posts `/tickets/save-as-draft` twice with the same `conversationId` and no `editTicketId`
- **THEN** the project's ticket store contains exactly one draft ticket whose `origin_conversation_id` matches `conversationId`
- **AND** the second response carries the same ticket id as the first

### Requirement: ExploreSpecShell sends `editTicketId` whenever it is in edit mode

The `ExploreSpecShell` component's Save-as-Draft handler SHALL include `editTicketId: editTicket.id` in the `POST /tickets/save-as-draft` request body whenever the shell was mounted with a non-null `editTicket` prop. When the shell was NOT mounted in edit mode, the handler MUST omit `editTicketId` entirely (sending it as `undefined` or `null` is not acceptable; the field must be absent).

#### Scenario: Continue-Editing flow sends `editTicketId`

- **WHEN** the user opens a `todo` ticket via Continue Editing in `TicketDetailModal`
- **AND** clicks Save as Draft inside the resulting `ExploreSpecShell`
- **THEN** the outgoing request body contains `editTicketId` equal to that ticket's id

#### Scenario: Fresh Explore session does not send `editTicketId`

- **WHEN** the user opens a fresh Explore session from the SpecsBoard "+ Add Spec" entry point
- **AND** clicks Save as Draft
- **THEN** the outgoing request body does not contain an `editTicketId` field
