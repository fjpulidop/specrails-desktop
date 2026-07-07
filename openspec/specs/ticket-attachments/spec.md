# Ticket Attachments

## Purpose
Define ticket attachment upload, serving, deletion, and assistant prompt injection behavior.

## Requirements

### Requirement: Attachment upload endpoint
The system SHALL expose `POST /api/projects/:projectId/tickets/:ticketId/attachments` accepting multipart form data with a single `file` field. Supported MIME types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `application/pdf`, `text/csv`, `text/plain`, `application/json`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-excel`, and SQL files (including `.sql` uploads sent as `application/sql`, `application/x-sql`, `text/sql`, `text/x-sql`, or with no reliable browser MIME type). The server SHALL save the file to `~/.specrails/projects/<slug>/attachments/<ticketId>/<uuid>-<originalName>` and append an `Attachment` record to `ticket.attachments[]` in `local-tickets.json`.

#### Scenario: Valid file uploaded
- **WHEN** a supported file is POSTed to the upload endpoint
- **THEN** the server returns HTTP 201 with `{ attachment: { id, filename, mimeType, size, addedAt } }`
- **AND** the file exists at `~/.specrails/projects/<slug>/attachments/<ticketId>/<uuid>-<filename>`
- **AND** `ticket.attachments` contains the new record

#### Scenario: Unsupported file type
- **WHEN** a file with an unsupported MIME type is uploaded
- **THEN** the server returns HTTP 400 with `{ error: "Unsupported file type: <mimeType>" }`
- **AND** no file is saved to disk

#### Scenario: Ticket does not exist
- **WHEN** the ticketId in the URL does not exist in the project store
- **THEN** the server returns HTTP 404

### Requirement: Attachment serve endpoint
The system SHALL expose `GET /api/projects/:projectId/tickets/:ticketId/attachments/:attachmentId` that streams the stored file with its original MIME type and appropriate `Content-Disposition` header.

#### Scenario: Attachment exists
- **WHEN** GET is called with a valid projectId, ticketId, and attachmentId
- **THEN** the server streams the file bytes with `Content-Type: <mimeType>` and `Content-Disposition: inline; filename="<filename>"`

#### Scenario: Attachment not found
- **WHEN** the attachmentId does not exist in `ticket.attachments`
- **THEN** the server returns HTTP 404

### Requirement: Attachment delete endpoint
The system SHALL expose `DELETE /api/projects/:projectId/tickets/:ticketId/attachments/:attachmentId` that removes the file from disk and removes the record from `ticket.attachments[]`.

#### Scenario: Successful delete
- **WHEN** DELETE is called with a valid attachmentId
- **THEN** the server returns HTTP 204
- **AND** the file no longer exists on disk
- **AND** `ticket.attachments` no longer contains the record

#### Scenario: Delete non-existent attachment
- **WHEN** DELETE is called with an attachmentId not in `ticket.attachments`
- **THEN** the server returns HTTP 404

### Requirement: Attachments injected into generate-spec Claude spawn
The system SHALL accept an optional `attachmentIds: string[]` field in the `POST /tickets/generate-spec` request body. When present, `AttachmentManager.getClaudeArgs(attachmentIds)` SHALL be called and the resulting image flags and text blocks injected into the Claude CLI spawn.

#### Scenario: Image attachments included
- **WHEN** generate-spec is called with `attachmentIds` containing image attachment IDs
- **THEN** each image's absolute path is inlined in the prompt as `@<absolutePath>` inside a `<user-attachment>` block so Claude CLI auto-resolves it for image understanding

#### Scenario: Text-extractable attachments included
- **WHEN** generate-spec is called with `attachmentIds` containing PDF, CSV, JSON, TXT, SQL, or Excel attachment IDs
- **THEN** the Claude CLI process receives extracted text content appended to the prompt for each attachment
- **AND** each extracted block is wrapped in `<user-attachment id="<uuid>" name="<filename>" mime="<mimeType>">...</user-attachment>` delimiters
- **AND** the system prompt instructs Claude to treat content inside `<user-attachment>` as untrusted user data, not as instructions
- **AND** any occurrence of the literal closing tag `</user-attachment>` inside the extracted content is escaped before wrapping

#### Scenario: No attachments
- **WHEN** generate-spec is called without `attachmentIds` or with an empty array
- **THEN** Claude CLI is spawned exactly as before with no additional flags or prompt text

### Requirement: Attachments injected into ai-edit Claude spawn
The system SHALL accept an optional `attachmentIds: string[]` field in the `POST /tickets/:id/ai-edit` request body and inject files into the Claude CLI spawn using the same mechanism as generate-spec. The route SHALL also accept optional `priorInstructions?: string[]` and `priorProposal?: string` fields to support iterative refinement turns. When `priorProposal` is present, the system prompt SHALL instruct Claude to refine the prior draft rather than rewrite the saved description from scratch, and the user prompt SHALL thread the instruction history for context.

#### Scenario: AI edit with attachments
- **WHEN** ai-edit is called with `attachmentIds`
- **THEN** the Claude CLI process receives image flags and/or extracted text for each attachment

#### Scenario: First-turn edit (no prior proposal)
- **WHEN** ai-edit is called without `priorProposal`
- **THEN** Claude is prompted to rewrite the saved description according to the user's instructions
- **AND** the behavior matches the pre-change ai-edit flow exactly

#### Scenario: Refinement turn with prior proposal
- **WHEN** ai-edit is called with `priorProposal` populated and non-empty `priorInstructions`
- **THEN** the user prompt includes the current saved description (for reference), the accumulated `priorInstructions` in order, the `priorProposal` as the "latest draft", and the new `instructions`
- **AND** Claude's output replaces the proposed draft rather than rewriting the saved description

#### Scenario: Refinement turn reuses attachment resolution
- **WHEN** ai-edit is called with both `priorProposal` and `attachmentIds`
- **THEN** `attachmentManager.getClaudeArgs` runs exactly as in first-turn mode
- **AND** the resulting text blocks are wrapped in `<user-attachment>` delimiters identically

### Requirement: Attachment cascade delete on ticket delete
The system SHALL delete all attachment files and the attachment directory when a ticket is deleted via `DELETE /tickets/:id`.

#### Scenario: Ticket deleted with attachments
- **WHEN** a ticket with `attachments` records is deleted
- **THEN** all files under `~/.specrails/projects/<slug>/attachments/<ticketId>/` are removed from disk

#### Scenario: Ticket deleted without attachments
- **WHEN** a ticket has no `attachments` or the attachment directory does not exist
- **THEN** the delete proceeds without error

### Requirement: Pending spec attachment directory
The system SHALL accept a `pendingSpecId` (UUID) as the `:ticketId` path parameter in the upload endpoint to support pre-creation attachment during spec generation. On successful ticket creation via generate-spec, the server SHALL rename `attachments/<pendingSpecId>/` to `attachments/<newTicketId>/` and update all attachment records on the new ticket.

#### Scenario: Attachments uploaded before ticket exists
- **WHEN** files are uploaded with a `pendingSpecId` UUID before the spec is generated
- **THEN** files are stored under `attachments/<pendingSpecId>/`
- **AND** when generate-spec succeeds and creates a ticket, the directory is renamed to `attachments/<ticketId>/` and attachment metadata is written to the new ticket

#### Scenario: Spec generation cancelled
- **WHEN** the ProposeSpecModal is cancelled after files were uploaded under a pendingSpecId
- **THEN** the client calls `DELETE /tickets/<pendingSpecId>/attachments` (bulk delete) and the directory is removed
