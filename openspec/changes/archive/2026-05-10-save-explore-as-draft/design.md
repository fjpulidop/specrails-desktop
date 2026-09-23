## Context

Today an Explore session in `ExploreSpecShell` ends in one of three states: (a) committed to a real ticket via `POST /tickets/from-draft`, (b) parked as a sonner toast through `MinimizedChatsContext` (localStorage-only metadata, capped at 50, single-device), or (c) discarded via the destructive close confirm. There is no durable, visible, multi-device-friendly resting state. The `chat_conversations` table already persists Explore conversations server-side (`kind='explore'`), so the resume infrastructure exists — it just lacks a board-visible surface that the user can return to.

The user has explicitly asked for a low-impact visual change: drafts must live in the existing Backlog column with only a tarjeta-level color shift and a `[Draft]` pill replacing the priority pill. No new column, no new filter, no collapsible section.

## Goals / Non-Goals

**Goals:**

- A draft ticket is a real row in `tickets`, surfaced in the board exactly where future tickets live (Backlog), distinguishable only by tarjeta color/border and the `[Draft]` pill.
- Saving a draft is an explicit, conscious action: a button in `ExploreSpecShell` and a non-destructive close prompt.
- Continuing an exploration from a draft reuses the existing `resumeConversationId` plumbing — zero new client infrastructure for resumption.
- When the draft is committed, the resulting ticket retains `origin_conversation_id` so the Explore session is permanently linked to its outcome.
- Drafts persist indefinitely until the user explicitly discards them.

**Non-Goals:**

- Concurrency control across multiple sessions on the same draft. Last-write-wins, consistent with existing chat behaviour.
- Auto-cleanup, archival, or expiry of stale drafts.
- A "View origin conversation" UI on committed tickets (data is captured for it, but rendering it is left as a future enhancement).
- Promoting the minimize-toast into a draft automatically. Toast and draft remain distinct — toast = transient session, draft = cold storage.
- Surfacing drafts outside the board (no draft count badge in sidebar, no global "Drafts" view).

## Decisions

### Decision 1: Draft is a ticket with `status='draft'` in the existing JSON store, not a separate entity

**Choice:** Extend the `TicketStatus` union in `server/modules/specs/runtime/ticket-store.ts` to include `'draft'`. Tickets continue to live in `<project>/.specrails/local-tickets.json` (NOT in SQLite — there is no `tickets` table; that was a planning oversight in the initial draft of this design and has been corrected).

**Why:** The user wants drafts to appear inside the Backlog column. The board renderer already groups tickets by status; adding a status keeps a single source of truth, a single render pipeline, and a single transition path (`draft → todo` is a one-row update, not a row migration). Auto-title resolves the historical objection that "tickets need a title" — by the time a draft is persisted, a title has been generated.

**Alternatives considered:**

- *Separate `spec_drafts` table*: cleaner separation but forces the board to merge two streams, complicates `from-draft` (delete + insert with atomicity concerns), and duplicates the modal/detail surface. Rejected because the visible UX is "a tarjeta in the Backlog", which leans toward the same entity.
- *Reuse `MinimizedChatsContext`*: localStorage-only, not a viable durable store. Rejected.

**Cost:** Existing ticket queries that should not include drafts (analytics rollups, `/implement` launch dialogs, batch implementation pickers, etc.) need an explicit `status != 'draft'` filter. This is a finite, enumerable set of touchpoints that we identify in tasks.md.

### Decision 2: `priority` becomes nullable; required again on transition out of `draft`

**Choice:** Widen the `Ticket.priority` field type to `TicketPriority | null` and adapt the `isValidPriority` / mutation paths. Add a server-side validation helper that rejects any ticket update which would leave `priority` null while `status != 'draft'`.

**Why:** During exploration the priority is unknown and forcing the user to pick one would be a usability tax. The `[Draft]` pill semantically replaces the priority pill on the board, so there's nothing to render anyway. The transition out of draft is the natural moment to require a priority — `from-draft` already accepts an explicit ticket payload.

**Alternatives considered:**

- *Default priority `medium` while in draft*: leaks a fake choice into analytics and into the moment of commit. Rejected.

### Decision 3: New `Ticket.origin_conversation_id` field, application-level cascade

**Choice:** Add a nullable `origin_conversation_id: string | null` field on the `Ticket` interface pointing at the Explore conversation that produced (or is producing) the ticket. There is no DB-level FK because tickets live in JSON, not SQLite — the equivalent of `ON DELETE SET NULL` is enforced by the chat-conversation deletion path (when an Explore conversation is deleted, sweep tickets whose `origin_conversation_id` points at it and clear the field).

**Why:** It serves three purposes with one field:

1. While in draft, the server uses it to know which conversation to resume.
2. After commit, it preserves provenance ("this ticket was born from that exploration") for future UI.
3. The cascade-clear keeps tickets safe if a conversation is purged later.

The existing `chat_conversations` SQLite table already persists per-turn history — no parallel chat store is needed.

**Backwards compatibility:** Tickets written before this change have no `origin_conversation_id`. Reads MUST default missing values to `null`. The store's `schema_version` bumps from `'1.0'` to `'1.1'` so consumers can identify the new shape.

### Decision 4: Auto-title is generated server-side when `Save as Draft` arrives without a title

**Choice:** When the client posts a save-as-draft request and no title has been produced, the server generates one synchronously from the conversation transcript before persisting the ticket.

**Why:** Keeps the client simple (no separate "generate title" round-trip), keeps the title deterministic for a given conversation state (server-side same input → same output is easier to test), and avoids a UX where the tarjeta briefly shows a placeholder. The exact strategy (first user message truncated vs. one-shot LLM summary) is left to implementation; the spec only requires "a non-empty, human-meaningful title".

**Alternatives considered:**

- *Client-side first-message truncation*: trivial but produces low-quality titles ("How do I…?"). Rejected as default; can be a fallback if the server-side summarizer fails.
- *Title prompt at save time*: extra friction at exactly the moment the user wants to step away. Rejected.

### Decision 5: Close-without-commit replaces the destructive confirm with `Save as Draft / Discard / Cancel`

**Choice:** When the user closes `ExploreSpecShell` with unsaved conversation content via Esc or the X button, present a three-way prompt. `Save as Draft` is the recommended (default-focus) action. `Discard` retains the existing destructive-confirm semantics. `Cancel` keeps the shell open.

**Why:** Aligns the implicit close path with the new explicit button. Without this change the user could lose work by reflex.

**Out of scope:** the *minimize* button remains untouched and still produces a sonner toast. Toast and draft are different surfaces.

### Decision 6: Continue Explore from a draft keeps `status='draft'` until explicit save or commit

**Choice:** Clicking Continue Explore on a draft ticket reopens `ExploreSpecShell` with `resumeConversationId`. The ticket stays in `status='draft'` for the duration of the session. Closing follows the same Save / Discard / Cancel flow.

**Why:** Simplest model; no intermediate state. Concurrency (two tabs continuing the same draft) is acknowledged as last-write-wins — same behaviour as anywhere else in the chat system.

**Alternatives considered:**

- *Intermediate `exploring` status*: visible "someone is here" affordance, but adds complexity for a problem we have not seen in practice. Rejected for v1.

### Decision 7: `from-draft` extends to flip status, not to insert

**Choice:** When `POST /tickets/from-draft` is invoked with a payload that originates from a draft ticket (i.e., the ticket already exists with `status='draft'`), the server transitions the existing row (`status → todo`, sets `priority`, updates title/desc with the final spec content) instead of creating a new row. The existing behaviour for non-draft sources is preserved.

**Why:** Preserves ticket id stability (any link to the draft ticket — e.g., from analytics or attachments — keeps working) and avoids deleting the row only to insert one with the same `origin_conversation_id`.

## Risks / Trade-offs

- **Ticket query contamination** → Mitigated by an exhaustive review in tasks.md of every place tickets are listed/aggregated, and adding `status != 'draft'` filters where appropriate. Analytics, implement launch dialogs, batch implement, the activity feed, and CSV/JSON exports are the main suspects.
- **Auto-title quality** → Server-side summarizer may produce odd titles for very short conversations. Mitigation: title is editable inline both from the board card (long-press / dedicated edit path that already exists in the detail modal) and the detail modal; auto-title is a starting point, not a contract.
- **Two-tab concurrent edit** → Accepted: last-write-wins. If users hit it in practice, a follow-up change can introduce an `editing_session_id` lock.
- **JSON-store schema bump** → No SQLite migration is needed for tickets. The `schema_version` field jumps from `'1.0'` to `'1.1'` and the read path tolerates pre-1.1 entries (treats missing `origin_conversation_id` as `null`). Mitigation: a unit test loads a hand-crafted pre-1.1 store and asserts no field is mutated unless the user touches the ticket.
- **Discarding a draft must clean up the conversation** → Decision: deleting a draft ticket cascades to the linked `chat_conversations` row only when the conversation has no other references and is `kind='explore'`. Since the cascade is application-level (no FK), it must be enforced at every deletion entry point (ticket delete endpoint, draft-discard from the close prompt). The `chat_conversations` table is project-scoped already; we do NOT want to leave orphan conversations forever, but we also do not want to wipe a conversation that the user is mid-exploring in another tab. Implementation detail in tasks.md.

## Migration Plan

1. Update `server/modules/specs/runtime/ticket-store.ts`: extend `TicketStatus`, `VALID_STATUSES`; widen `Ticket.priority` to allow `null`; add `Ticket.origin_conversation_id`; bump default `schema_version` for newly-created stores from `'1.0'` to `'1.1'`. Existing on-disk stores retain their value and read fine — `origin_conversation_id` defaults to `null` when absent.
2. Server: extend ticket types, add list filters that exclude drafts where appropriate (in `Object.values(store.tickets)` consumers), extend `from-draft` to support the status-flip path, wire `Save as Draft` endpoint, add the auto-title summarizer, wire the conversation-delete cascade.
3. Client: add `Save as Draft` button + close prompt to `ExploreSpecShell`, add draft tarjeta variant + `[Draft]` pill to the board card, add Continue Explore CTA to the detail modal.
4. Tests: store-level tests for the new fields and back-compat read; extend `server/from-draft.test.ts` for the status-flip path; new tests for save-as-draft endpoint, auto-title, board rendering, detail modal Continue Explore.
5. No rollback strategy needed beyond reverting the field additions: drafts are additive and existing tickets are untouched.

## Open Questions

- **Auto-title strategy**: server-side LLM summary vs. deterministic first-user-message truncation. Recommendation: try LLM with a tight prompt (cheap, one-shot, cached if conversation hasn't changed) and fall back to truncation on failure. Resolve in tasks.md.
- **Where exactly the `[Draft]` pill goes**: same DOM slot as the priority pill, or a separate slot? Recommendation: same slot to keep the tarjeta layout invariant. Confirm during implementation.
- **Discard semantics on the conversation row**: cascade delete vs. soft-keep. Lean toward cascade-delete the `chat_conversations` row when a draft ticket is the only thing referencing it. Confirm during implementation.
