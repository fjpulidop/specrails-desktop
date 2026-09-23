## ADDED Requirements

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
