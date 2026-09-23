## 1. Server: extend `save-as-draft` with the in-place flip path

- [x] 1.1 In `server/project-router.ts`, parse `editTicketId` from the request body inside `POST /:projectId/tickets/save-as-draft`. Validate type: if present and not a finite number, respond `400 { error: 'editTicketId must be a number' }` and return.
- [x] 1.2 When `editTicketId` is present and valid, look up the ticket inside `mutateStore` by `s.tickets[String(editTicketId)]`. If absent, respond `404 { error: 'ticket not found' }` and return.
- [x] 1.3 When the ticket is found, mutate it in place: set `status='draft'`, `priority=null`, `origin_conversation_id=conversationId`, replace `title` (provided → existing → generated) using the same fallback chain as today, replace `description` only when the body supplied a non-empty string (mirror the existing endpoint's merge rule), replace `labels` only when the body supplied a non-empty array, set `updated_at = now`. Preserve `created_at`, `created_by`, `source`, `assignee`, `prerequisites`, `metadata`, `comments`, and `id`.
- [x] 1.4 Skip the existing `(origin_conversation_id, status='draft')` lookup entirely when `editTicketId` is present (the in-place flip path is exclusive).
- [x] 1.5 Always broadcast `ticket_updated` for the in-place flip path. Always respond with status 200 (not 201) for the in-place flip path. Response body shape unchanged: `{ ticket, revision }`.
- [x] 1.6 Leave the existing path (no `editTicketId` in body) unchanged: keep the lookup, keep insert-on-no-match, keep the `created_at === updated_at` heuristic that picks `ticket_created` vs `ticket_updated`, keep the 201 status.

## 2. Client: send `editTicketId` from `ExploreSpecShell.handleSaveAsDraft`

- [x] 2.1 In `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx`, extend the `handleSaveAsDraft` request body. When `editTicket` is non-null, include `editTicketId: editTicket.id`. When `editTicket` is null/undefined, omit the field entirely (do not send `editTicketId: null` or `editTicketId: undefined` — use a conditional spread).
- [x] 2.2 Add `editTicket?.id` to the `useCallback` dependency array of `handleSaveAsDraft` so the closure captures the latest id when the shell re-mounts on a different ticket.
- [x] 2.3 No UI change: the Save-as-Draft button label, disabled-state rules, and toast text are unchanged. The success toast still reads `Draft saved — #${data.ticket.id} ${data.ticket.title}`.

## 3. Server tests

- [x] 3.1 In `server/from-draft.test.ts` (or a new `server/save-as-draft.test.ts` colocated with the endpoint tests), add a Vitest case: create a `todo` ticket with `priority='high'`, post `/save-as-draft` with `{ conversationId, editTicketId, title:'Updated', description:'Updated body', labels:['x'] }`. Assert: response 200, returned ticket has same `id`, `status='draft'`, `priority=null`, `origin_conversation_id=conversationId`, `title/description/labels` updated, `created_at` preserved, `created_by` preserved, store has exactly one ticket with that id.
- [x] 3.2 Add a case for `status='backlog'` source — same assertions.
- [x] 3.3 Add a case for idempotency: post twice with the same `(editTicketId, conversationId)` and a different second-call body. Assert: store still has one ticket with that id, second response is 200, fields reflect the second body.
- [x] 3.4 Add a case for the already-draft source: create a ticket with `status='draft'`, `origin_conversation_id='conv-A'`. Post with `editTicketId` and `conversationId='conv-B'`. Assert: status remains `draft`, `origin_conversation_id='conv-B'`.
- [x] 3.5 Add a case for missing ticket: post with `editTicketId=999999`. Assert: 404, no store mutation, no broadcast.
- [x] 3.6 Add a case for invalid type: post with `editTicketId='abc'`. Assert: 400, no store mutation.
- [x] 3.7 Add a regression case for the no-`editTicketId` path: post a fresh-session save and assert the existing behaviour (201, `ticket_created`, new id) is unchanged. Then post a second time with the same `conversationId` and assert it updates the same ticket (not a duplicate).
- [x] 3.8 In every test that exercises the in-place flip, capture broadcasts via the test broadcaster spy and assert that exactly one `ticket_updated` is emitted (and no `ticket_created`).

## 4. Client tests

- [x] 4.1 In `client/src/components/explore-spec/__tests__/` (create the file if missing — `ExploreSpecShell.saveAsDraft.test.tsx`), add a Vitest test that mounts `ExploreSpecShell` with a non-null `editTicket` prop. Mock `fetch`. Trigger Save-as-Draft. Assert that the outgoing POST body parses to JSON containing `editTicketId === editTicket.id`.
- [x] 4.2 Add a sibling test that mounts the shell without `editTicket`. Trigger Save-as-Draft. Assert that the outgoing POST body parses to JSON that does NOT contain the key `editTicketId` at all (use `expect(body).not.toHaveProperty('editTicketId')`, not just `toBeUndefined`).

## 5. Validate and verify

- [x] 5.1 Run `npm run typecheck` and `cd client && npx tsc --noEmit`. Both must pass.
- [x] 5.2 Run `npm test` (server + CLI) and `cd client && npm test` (or the project's client test command). All tests must pass.
- [x] 5.3 Run `npm run test:coverage` (server) and `cd client && npm run test:coverage` (client). Coverage thresholds (80% server lines/funcs/stmts, 70% server branches, 80% client lines/stmts, 70% client funcs, 70% global) must still pass — if the new code is not covered, add tests until they do.
- [x] 5.4 Manual smoke test: start `npm run dev`, open a project, create a `todo` ticket with `priority='high'`, open it via Continue Editing, click Save as Draft, confirm in the SpecsBoard that (a) the same ticket id is now showing the Draft visual treatment, (b) no duplicate appeared, (c) `priority` pill is gone and `Draft` pill is present.
- [x] 5.5 Run `openspec validate fix-save-as-draft-on-non-draft-ticket`. Must pass with no errors.
