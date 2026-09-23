## 1. Server: spec-draft parser and broadcast

- [x] 1.1 Create `server/modules/specs/runtime/spec-draft-parser.ts` exporting `parseSpecDraftBlocks(text)`: returns `{ stripped: string, drafts: ParsedDraft[] }`. Use a non-greedy regex on ` ```spec-draft\n...\n``` `; pre-check `text.includes("```spec-draft")` to skip the regex when absent.
- [x] 1.2 Validate the parsed JSON shape. Allowed fields: `title: string`, `description: string`, `labels: string[]`, `priority: 'low'|'medium'|'high'|'critical'`, `acceptanceCriteria: string[]`, `chips: string[]`, `ready: boolean`. Drop unknown fields. Drop invalid `priority` values silently. Coerce `labels`/`acceptanceCriteria`/`chips` to string[].
- [x] 1.3 Define merge semantics: arrays replace, empty strings are no-op, manual overrides not relevant on the server side. Export `mergeDraft(prev, next)`.
- [x] 1.4 In `server/modules/conversations/runtime/chat-manager.ts`: when emitting an assistant message belonging to an Explore conversation (detect via the conversation's slash-command prefix `/specrails:explore-spec`), run the parser, merge into a per-conversation `latestDraft` map, and broadcast `{ type: 'spec_draft.update', conversationId, draft }` over the project WS.
- [x] 1.5 Strip the matched fenced block(s) from the chat content before broadcasting the assistant message. Persist the original (unstripped) content to the on-disk chat ndjson.
- [x] 1.6 Garbage-collect `latestDraft` when the chat conversation ends or the project is removed.
- [x] 1.7 Unit tests `server/__tests__/spec-draft-parser.test.ts`: valid block, malformed JSON, unknown fields, invalid priority, empty strings, array replace, multi-block in one message (last wins).
- [x] 1.8 Integration test extending `server/__tests__/chat-manager.test.ts`: an explore conversation message with a draft block emits `spec_draft.update` and strips the block from the WS broadcast but leaves it on disk.

## 2. Server: from-draft commit endpoint

- [x] 2.1 Add route `POST /api/projects/:projectId/tickets/from-draft` in `server/tickets-router.ts` (or wherever existing ticket creation routes live).
- [x] 2.2 Validate payload: trim and require non-empty `title` (400 on fail); enum-check `priority` and default `medium` on invalid; default `labels: []` and `acceptanceCriteria: []` when missing.
- [x] 2.3 Insert directly into the per-project `local-tickets.json` using the existing ticket-write helper. Set `source: "propose-spec"` and assign the next numeric id.
- [x] 2.4 Return 200 with the inserted ticket as JSON.
- [x] 2.5 Tests in `server/__tests__/tickets-router.test.ts`: 200 happy path, 400 empty title, 400 whitespace-only title, invalid priority normalised, missing arrays defaulted, source set correctly, id assigned monotonically with existing tickets.

## 3. Slash command for explore-spec

- [x] 3.1 Create `.claude/commands/specrails/explore-spec.md` with the system prompt: thinking-partner stance, fenced-block convention, JSON schema documentation, `ready: true` semantics, two few-shot examples (one short conversation, one with code reading), explicit rule "do NOT create the ticket yourself — the hub commits".
- [x] 3.2 Add an example chip set in the prompt so Claude knows the `chips` field is for short user-facing replies.
- [x] 3.3 Verify the command is discovered by the hub's slash-command discovery (the existing one in `ProposeSpecModal`'s explore path uses `/specrails:propose-spec`; mirror that registration).

## 4. Client: spec-draft client-side merge hook

- [x] 4.1 Create `client/src/features/specs/lib/spec-draft.ts` with the `SpecDraft` type matching the server validator and `MANUAL_FIELDS = ['title','description','labels','priority','acceptanceCriteria'] as const`.
- [x] 4.2 Create `client/src/features/specs/hooks/useSpecDraftStream.ts` subscribing to `spec_draft.update` WS messages filtered by `conversationId`. Maintains `{ draft, ready, chips }`.
- [x] 4.3 Track `manualFields: Set<keyof SpecDraft>`. `mergeFromClaude(update)` skips entries in `manualFields`. Expose `setField(key, value)` that records the manual override and updates the draft. Expose `clearManualOverrides()` invoked when the user sends a new message.
- [x] 4.4 Unit tests `client/src/hooks/__tests__/useSpecDraftStream.test.ts`: WS message merges, manual override blocks Claude write within same turn cycle, clearing on user message restores Claude authority, ready flag toggles, chips array exposed.

## 5. Client: ExploreSpecShell overlay

- [x] 5.1 Create `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx`. Full-screen overlay, eyebrow `EXPLORE SPEC · interactive`, headline copy, two-column layout (chat left, draft right), composer at the bottom of the left column, header with back-arrow + close.
- [x] 5.2 Reuse the focus-trap and Esc/⌘⏎ keyboard pattern from `AiEditShell` — extract to `useOverlayKeyboard` hook only if both consumers stabilise; otherwise inline.
- [x] 5.3 Mount `<SpecDraftPanel>` (next group) on the right column, wired to `useSpecDraftStream`.
- [x] 5.4 Render the conversation history as turn bubbles using existing `MessageBubble` + `MessageList` if compatible; otherwise build minimal bubbles inline.
- [x] 5.5 Composer based on `RichAttachmentEditor` but with attachments disabled (Explore v1 is conversation-only). Submit on `⌘⏎`. Disable while a turn is streaming.
- [x] 5.6 Render up to 3 chips above the composer when the latest draft block included `chips`. Click sends the chip text as the next user message.
- [x] 5.7 Confirm-discard dialog when closing with a non-empty conversation (more than the initial user idea). Match the destructive-action visual from `AiEditShell`.
- [x] 5.8 Tauri-on-Mac padding for traffic-lights — copy the helper from `AiEditShell`.
- [x] 5.9 Component tests `client/src/features/specs/components/explore-spec/__tests__/ExploreSpecShell.test.tsx`: mount, layout, composer streaming-disabled, chip click sends, confirm-discard appears only with non-empty conversation, Esc behaviour.

## 6. Client: SpecDraftPanel

- [x] 6.1 Create `client/src/features/specs/components/explore-spec/SpecDraftPanel.tsx` with structured fields: title input, priority select (`low | medium | high | critical`), label chips (add/remove), description textarea, acceptance bullet list (add/remove).
- [x] 6.2 Each field reads from `useSpecDraftStream().draft` and writes via `setField` (recording manual override).
- [x] 6.3 Animate (200ms bg flash) only the field(s) modified by the latest Claude update — track which fields changed in `useSpecDraftStream` and surface a per-update changedFields set.
- [x] 6.4 Render a `✦ Draft ready` banner above the action area when `ready === true`.
- [x] 6.5 Render a `Create Spec` button: disabled when `title` empty/whitespace; outline when title present and not ready; filled primary with soft pulse when `ready === true`.
- [x] 6.6 On click, POST `/from-draft`; on success show toast `Spec created`, close the overlay, and notify the parent `onTicketCreated` callback so the new ticket lands in the SpecsBoard.
- [x] 6.7 Component tests `client/src/features/specs/components/explore-spec/__tests__/SpecDraftPanel.test.tsx`: field rendering, manual edit recorded, Claude-driven flash animates only changed fields, button states (disabled / available / amplified), commit triggers POST and closes overlay.

## 7. Client: ProposeSpecModal mode control + Explore handoff

- [x] 7.1 Remove the `exploreCodebase` checkbox and its conditional handling in `ProposeSpecModal.tsx`.
- [x] 7.2 Add a 2-mode segmented control above the composer (`Quick` | `Explore`); default `Quick`. Use the existing UI primitive set; if no segmented-control primitive exists, build a small inline one using `Button` toggles.
- [x] 7.3 The button label reflects the mode: `Generate Spec` for Quick, `Continue` for Explore.
- [x] 7.4 On submit in Quick mode: keep the existing `/generate-spec` POST untouched.
- [x] 7.5 On submit in Explore mode: close the modal and mount `<ExploreSpecShell>` with the typed idea as the initial user message; start the chat with the `/specrails:explore-spec` slash-command prefix and the idea body. Disable attachments (Explore v1).
- [x] 7.6 Update placeholder copy and the surrounding helper text to reflect both modes.
- [x] 7.7 Update tour/onboarding copy (any reference to `Explore codebase`) — `grep` `client/src/` for the string.
- [x] 7.8 Update `ProposeSpecModal` tests for the new control: default mode is Quick, switching to Explore changes the button label, attachments disabled in Explore mode.

## 8. Wiring + state lifecycle

- [x] 8.1 Decide overlay mount point: render `ExploreSpecShell` inside `ProposeSpecModal`'s parent so the modal can close while the overlay takes over. The simplest is to lift `exploreOverlayState` up to `SpecsBoard` (which already renders the modal) and conditionally render the overlay alongside.
- [x] 8.2 Verify the chat conversation is started fresh on each overlay mount and disposed on close (ChatManager already handles disposal via existing close path; double-check no leak).
- [x] 8.3 Wire `onTicketCreated` from the overlay through to `SpecsBoard` so the new ticket appears in the list immediately, mirroring the Quick path.
- [x] 8.4 Ensure the overlay is dismissed cleanly on project switch (close + discard, no confirm — the active-project change is itself the implicit discard).

## 9. Accessibility

- [x] 9.1 Overlay has `role="dialog"`, `aria-modal="true"`, labelled by the eyebrow.
- [x] 9.2 Composer has `aria-label` matching `Spec idea` for screen-readers; chip row has `role="group"` with `aria-label="Suggested replies"`.
- [x] 9.3 Draft fields are reachable in a logical tab order: title → priority → labels → description → acceptance → Create button.
- [x] 9.4 The 200ms bg-flash is decorative — not announced; live region used for `✦ Draft ready` banner with `aria-live="polite"`.
- [x] 9.5 Confirm-discard dialog reuses an accessible Dialog primitive.

## 10. Coverage and CI

- [x] 10.1 Run `npm run typecheck` (server + client) — zero errors.
- [x] 10.2 Run `npm test` (server) — pass.
- [x] 10.3 Run `npm run test:coverage` (server) — confirm thresholds (80% lines/functions/statements, 70% branches) still pass.
- [x] 10.4 Run `cd client && npm run test:coverage` — confirm thresholds (80% lines/statements, 70% functions) still pass.
- [x] 10.5 If thresholds fail, add focused tests on the new parser, hook, shell, and panel — never lower thresholds.

## 11. Manual verification

- [x] 11.1 Manual: open Add Spec, switch to Explore, type `dark mode toggle`, click Continue. Overlay opens, Claude streams the first turn, draft pane shows the title within 1-2 turns.
- [x] 11.2 Manual: edit the priority by hand to `low` while Claude proposes `high` — the manual value persists across one Claude turn cycle.
- [x] 11.3 Manual: click a suggested chip — the chip text is sent as the next user message, the chip row updates with the next turn's chips.
- [x] 11.4 Manual: when Claude emits `ready: true`, verify the `✦ Draft ready` banner appears and the Create Spec button pulses.
- [x] 11.5 Manual: click Create Spec at any point with a title set — the ticket appears in SpecsBoard with all fields populated and `source: propose-spec`.
- [x] 11.6 Manual: close the overlay with conversation in progress — confirm-discard appears; cancel returns to overlay; confirm discards state.
- [x] 11.7 Manual: close with only the initial idea typed (no Claude response yet) — no confirm.
- [x] 11.8 Manual: in Quick mode, verify `Generate Spec` still works exactly as before (with attachments).
