## Why

Explore is the most natural way to shape a spec, but right now an Explore session has no durable resting state: it's either committed as a real ticket via `from-draft` or lost. The minimize-as-toast feature only covers "vuelvo en dos minutos" (localStorage-only, no multi-device, capped at 50). Users who want to pause an exploration and pick it up tomorrow have no place to put it. We need a first-class **Draft** state for tickets that captures an in-progress exploration, surfaces it on the board with minimal visual disruption, and lets the user resume the conversation exactly where they left it.

## What Changes

- Add `draft` as a new value in the `TicketStatus` union exposed by the per-project JSON ticket store (`server/modules/specs/runtime/ticket-store.ts`, file `.specrails/local-tickets.json`).
- Make `priority` nullable on the `Ticket` interface while `status='draft'` (required again on transition out of draft). Update `VALID_PRIORITIES` checks to admit a null/missing priority specifically for drafts.
- Add an `origin_conversation_id` field on the `Ticket` interface (nullable string). It permanently links the Explore conversation that produced the ticket — preserved even after the ticket is committed. Cascade-cleanup is enforced in the application layer (the JSON store has no FK).
- Bump the JSON store's `schema_version` (currently `'1.0'`) to `'1.1'`. Reads remain backwards compatible: tickets written before this change keep working with the new code (missing `origin_conversation_id` reads as `null`).
- New trigger paths in `ExploreSpecShell`:
  - Explicit **Save as Draft** button next to the existing Minimize / Create Spec actions.
  - On close-without-commit (Esc / X), replace the destructive confirm with a **Save as Draft / Discard / Cancel** prompt.
- Auto-title generation when the user saves a draft and no title has been produced by the conversation yet (derived from the conversation transcript).
- Visual marker on the board ticket card only (no new columns, no filters, no collapsible sections):
  - Tarjeta con color/borde tenue distinto.
  - Pill `[Draft]` ocupa el sitio del pill de prioridad (High/Medium/Low) mientras el ticket está en draft.
- `TicketDetailModal` shows a **Continue Explore** CTA when `status='draft'` that reopens `ExploreSpecShell` with the existing `resumeConversationId` plumbing. Ticket stays `status='draft'` during resumed sessions; the same Save / Discard / Cancel flow applies on close.
- `POST /tickets/from-draft` extended to set `origin_conversation_id` on the resulting ticket and to flip `status` from `draft → todo` (instead of creating a new ticket) when the source is a draft ticket.
- Drafts are **never auto-deleted**. They disappear only via explicit Discard.

## Capabilities

### New Capabilities

- `ticket-drafts`: introduces the `draft` ticket status, nullable priority while in draft, `origin_conversation_id` field, the visual draft treatment on the board card, and the Continue Explore CTA in the ticket detail modal.

### Modified Capabilities

- `explore-spec`: adds the Save as Draft / Discard / Cancel flows, draft-aware close behaviour, auto-title generation, and the Continue Explore resume entry point from a draft ticket.

## Impact

- **Storage**: per-project JSON store at `<project>/.specrails/local-tickets.json` managed by `server/modules/specs/runtime/ticket-store.ts`. Bump `schema_version` to `'1.1'`, extend `TicketStatus` and `VALID_STATUSES`, allow null `priority` on the `Ticket` interface and adapt `VALID_PRIORITIES` checks, add `origin_conversation_id` field. No SQLite migration required for tickets.
- **Server**: `server/project-router.ts` ticket endpoints (create/update/list filters in `Object.values(store.tickets)` consumers), `server/project-router.ts` `POST /tickets/from-draft` extension, ticket helpers in `server/modules/specs/runtime/ticket-store.ts`, conversation linking when saving from Explore. The `chat_conversations` SQLite table itself does not change.
- **Client**: `ExploreSpecShell` (new buttons + close flow), `TicketCard` on `SpecsBoard` (visual variant), `TicketDetailModal` (Continue Explore CTA + draft-aware actions), ticket creation/list types in `client/src/lib/api.ts` and shared types.
- **Tests**: from-draft flow tests already exist (`server/from-draft.test.ts`) — extend to cover the status-flip path and `origin_conversation_id` persistence. New tests for draft creation, auto-title, board rendering, and Continue Explore resume.
- **Backwards compatibility**: existing tickets unaffected (status enum widens, priority becomes nullable but existing rows keep their values). No client breaking changes.
- **Out of scope**: concurrency lock for two sessions on the same draft (last-write-wins for now, consistent with existing chat behaviour); auto-cleanup policies; surfacing `origin_conversation_id` as a "View origin conversation" UI element on committed tickets (left as a future enhancement enabled by the schema change).
