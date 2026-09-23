## Why

Clicking **Save as Draft** inside an Explore session that was opened via **Continue Editing** on a non-draft ticket (e.g. `todo`, `backlog`) does NOT demote that ticket to `draft`. Instead, the server creates a brand-new duplicate draft ticket and leaves the original intact. The user ends up with two tickets — the original still in its prior column and an orphan draft they did not intend to create — and no signal that the original was meant to be parked.

Root cause: `POST /tickets/save-as-draft` only matches an existing draft by `(origin_conversation_id === conversationId AND status === 'draft')`. When the Explore session was launched from a non-draft ticket, there is no such match, so the endpoint falls through to its insert path. The client (`ExploreSpecShell.handleSaveAsDraft`) never tells the server which ticket is being edited.

## What Changes

- `POST /tickets/save-as-draft` accepts an optional `editTicketId: number`. When provided and the ticket exists, the endpoint flips that ticket in place to `status='draft'` (preserving `id`, replacing title/description/labels, setting `priority=null`, setting `origin_conversation_id` to the current `conversationId`) and skips the insert path entirely.
- `ExploreSpecShell.handleSaveAsDraft` sends `editTicketId: editTicket.id` when the shell is in edit mode.
- Idempotency for the Continue-Editing-on-non-draft flow: a second Save-as-Draft on the same `(editTicketId, conversationId)` is a no-op flip (already a draft), not a duplicate insert.
- The existing flow (Save as Draft on a fresh Explore session, with no `editTicketId`) is unchanged.
- Broadcast: when flipping in place, emit `ticket_updated` (not `ticket_created`).

## Capabilities

### New Capabilities
*(none)*

### Modified Capabilities
- `ticket-drafts`: extend the **Save-as-Draft endpoint** behaviour with an in-place demotion path for non-draft tickets opened via Continue Editing.

## Impact

- **Server**: `server/project-router.ts` (`POST /:projectId/tickets/save-as-draft`).
- **Client**: `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx` (`handleSaveAsDraft` body).
- **Tests**: `server/from-draft.test.ts` / new save-as-draft tests covering the flip path and the no-op idempotency case.
- **No schema migration**: the demotion uses existing `Ticket` fields. No new columns, no DB changes.
- **No breaking changes**: `editTicketId` is optional; existing callers keep working unchanged.
