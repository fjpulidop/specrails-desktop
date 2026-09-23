## 1. Ticket store schema changes

- [x] 1.1 Update `server/modules/specs/runtime/ticket-store.ts`: add `'draft'` to `TicketStatus` and `VALID_STATUSES`; widen `Ticket.priority` to `TicketPriority | null`; add `Ticket.origin_conversation_id: string | null`; bump default `schema_version` for newly-created stores from `'1.0'` to `'1.1'`. Read paths must default missing `origin_conversation_id` to `null` and accept `priority = null` only when `status === 'draft'`.
- [x] 1.2 Add a validation helper (e.g., `validatePriorityForStatus(status, priority)`) in `server/modules/specs/runtime/ticket-store.ts` that returns an error string when a non-draft status is paired with `priority = null`. Call it from every ticket-mutating endpoint.
- [x] 1.3 Write a back-compat regression test in `server/modules/specs/runtime/ticket-store.unit.test.ts` (or sibling): load a hand-written `local-tickets.json` with `schema_version: '1.0'` and pre-existing tickets, read it, assert no field is mutated, and assert that adding a draft ticket bumps the version to `'1.1'` while preserving the existing rows verbatim.

## 2. Server: persistence and endpoints

- [x] 2.1 Extend any other server-side ticket types/zod schemas outside `ticket-store.ts` (request body validators in `server/project-router.ts`, shared types) to expose `status='draft'`, nullable `priority`, and `origin_conversation_id`.
- [x] 2.2 Add an endpoint to save an Explore session as a draft ticket. Accept `{ conversationId, title?, attachmentIds?, ... }`. Server MUST set `status='draft'`, `origin_conversation_id=conversationId`, and either honour the supplied title or invoke the auto-title generator.
- [x] 2.3 Implement the auto-title generator (server-side LLM one-shot summary with a deterministic first-user-message truncation as fallback). Keep the prompt and timeout self-contained in a small helper module so it can be unit-tested.
- [x] 2.4 Extend `POST /tickets/from-draft` (`server/project-router.ts`) so that, when the payload references an existing draft ticket, the row is updated in place: `status` flips to the initial active status, `priority` is set, title/description/spec body are updated, `origin_conversation_id` is preserved. Legacy non-draft path keeps its current insert semantics.
- [x] 2.5 Audit every `Object.values(store.tickets)` consumer and add a `status !== 'draft'` filter where the spec requires it: SpecsBoard listing keeps drafts; analytics rollups (top tickets, etc.), implement and batch-implement launch dialogs, activity feed, and CSV/JSON exports exclude drafts. Document each touched callsite inline.
- [x] 2.6 On draft ticket discard, cascade-delete the linked `chat_conversations` row when no other ticket references it and `kind='explore'`. On Explore-conversation deletion (the inverse direction), sweep tickets whose `origin_conversation_id` matches and clear the field to `null`. Both paths are application-level (no FK).
- [x] 2.7 Broadcast project-scoped WebSocket events for draft lifecycle (`ticket.created`, `ticket.updated`, `ticket.deleted`) consistent with existing ticket events so the board updates without manual refetch.

## 3. Server tests

- [x] 3.1 Extend `server/from-draft.test.ts` with cases for: draft → todo status flip in place, `origin_conversation_id` preservation across commit, rejection when `priority` cannot be resolved on commit, legacy non-draft path still inserts a new ticket.
- [x] 3.2 New test file for the save-as-draft endpoint covering: happy path, auto-title fallback, no-user-turn rejection, resumed-session updates the same ticket instead of creating a second one.
- [x] 3.3 Unit tests for the auto-title generator (mocked LLM): deterministic fallback, single-line output, non-empty result on minimal input.
- [x] 3.4 Test that ticket-listing endpoints excluded by spec actually exclude drafts (one focused test per surface listed in 2.5).
- [x] 3.5 Test that discarding a draft cascade-deletes the orphan `chat_conversations` row but leaves shared conversations untouched. Symmetric test: deleting an Explore conversation clears `origin_conversation_id` on every referencing ticket.

## 4. Client: shared types and API

- [x] 4.1 Update ticket types in `client/src/lib/api.ts` (and any shared types module) to allow `status='draft'`, nullable `priority`, and `origin_conversation_id`.
- [x] 4.2 Add a typed API client function for the save-as-draft endpoint and another that triggers Continue Explore (which is just a URL + state hand-off into `ExploreSpecShell`, not a new server call — but a typed helper centralises the contract).

## 5. Client: ExploreSpecShell changes

- [x] 5.1 Add the `Save as Draft` action in `ExploreSpecShell` header (or persistent control surface) next to the existing minimize / Create Spec actions. Disabled until at least one user-submitted turn exists. On click: call the save-as-draft endpoint, close the shell, no discard-confirm.
- [x] 5.2 Replace the destructive close confirm with the three-way `Save as Draft / Discard / Cancel` prompt. `Save as Draft` is the default-focused action. `Discard` retains existing destructive semantics. `Cancel` keeps the shell open. Minimize control bypasses this prompt unchanged.
- [x] 5.3 When the shell is opened via Continue Explore (i.e., resuming a draft ticket), wire `Save as Draft` to update the existing ticket in place rather than create a new one. Keep the shell's existing `resumeConversationId` plumbing as the resume mechanism.

## 6. Client: SpecsBoard ticket card

- [x] 6.1 Add a draft visual variant to the board ticket card: distinct background and/or border colour derived from semantic theme tokens (`accent-*`, `surface`, etc.) — no brand-named or hardcoded colours.
- [x] 6.2 In the priority pill DOM slot, render a `Draft` pill instead of `High`/`Medium`/`Low` whenever the ticket has `status='draft'`. Preserve all other tarjeta layout invariants.
- [x] 6.3 Verify the draft variant renders correctly under all themes (`dracula`, `aurora-light`, `obsidian-dark`).
- [x] 6.4 Confirm drafts appear inside the existing Backlog column with no new column, no filter chip, and no collapsible section.

## 7. Client: TicketDetailModal

- [x] 7.1 Render a `Continue Explore` primary action when the ticket has `status='draft'` and a non-null `origin_conversation_id`. On click: hand off to `ExploreSpecShell` with `resumeConversationId = origin_conversation_id`.
- [x] 7.2 Hide `Continue Explore` when `origin_conversation_id` is null. Surface a sensible empty/disabled state for any other draft-only actions if needed.
- [x] 7.3 Ensure `Continue Explore` keeps the ticket's `status` as `draft` (no optimistic status change in the client).

## 8. Client tests

- [x] 8.1 Unit-test the board ticket card draft variant: pill substitution, theme-token usage (snapshot or computed-style assertions), Backlog placement.
- [ ] 8.2 Unit-test `ExploreSpecShell` save flows: explicit button, close-prompt three-way, minimize bypass, resumed-session updates the existing ticket.
- [ ] 8.3 Unit-test `TicketDetailModal` draft branch: Continue Explore CTA visibility, hand-off to the shell, no status mutation on click.
- [ ] 8.4 Integration test: open Explore, save as draft, see the draft on the board, click Continue Explore, see history restored, click Create Spec, see the same ticket transition to non-draft and the `Draft` pill replaced by a real priority pill.

## 9. Coverage & polish

- [x] 9.1 Run `npm run typecheck`, `npm test`, `npm run test:coverage`, and `cd client && npm run test:coverage`. Iterate on tests until all CI thresholds pass locally (70% global; 80% server lines/functions/statements + 70% branches; 80% client lines/statements + 70% functions).
- [ ] 9.2 Final visual pass under all three themes confirming no FOUC, no layout jitter, and the draft tarjeta is unmistakably distinct without breaking the column rhythm.
- [x] 9.3 Update `CLAUDE.md` with a short "Draft tickets" section describing the schema additions, capture sites, and the resume flow (consistent with the existing per-feature sections).
