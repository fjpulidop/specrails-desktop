## 1. Server — PATCH /tickets/:id accepts acceptanceCriteria

- [x] 1.1 `formatDescriptionWithCriteria(body, criteria)` helper exported from `server/project-router.ts`
- [x] 1.2 PATCH endpoint validates + folds `acceptanceCriteria` via the helper
- [x] 1.3 `from-draft` refactored to call the same helper (drift-free)
- [x] 1.4 Supertest cases: new section, replace, remove on `[]`, preserve on omit, non-array rejection, non-string-items rejection
- [x] 1.5 Unit tests for `formatDescriptionWithCriteria` directly (heading detection, empty body, case-insensitive, mid-doc section)

## 2. Client — acceptanceCriteria parser

- [x] 2.1 `client/src/features/specs/components/explore-spec/acceptance-criteria.ts` exports `parseAcceptanceCriteria` + `formatWithCriteria`
- [x] 2.2 13 tests covering parse/format/round-trip + mixed bullet styles + case-insensitive heading

## 3. ExploreSpecShell — edit-existing-ticket mode

- [x] 3.1 `editTicket?: EditTicketSeed` added to props with type export
- [x] 3.2 Edit-mode skips legacy `resumeConversationId`, bootstraps a fresh `/specrails:explore-spec` conversation seeded with the ticket as context
- [x] 3.3 Draft pane pre-populated from `editTicket` via `setField` on first render
- [x] 3.4 Header eyebrow flips to `EDITING SPEC · #{id}` when in edit mode
- [x] 3.5 `handleCreate` branches on `editTicket`: edit mode hits `PATCH /tickets/:id`, regular path unchanged
- [x] 3.6 Acceptance criteria parsed from description body on the modal side before passing into `editTicket`
- [x] 3.7 Composer / Review / Send gating unchanged across modes

## 4. ExploreReviewOverlay — edit-mode label

- [x] 4.1 New optional `mode?: 'create' | 'edit'` prop
- [x] 4.2 Commit button label flips to `Update Spec` when `mode === 'edit'`; `data-testid` stays stable
- [x] 4.3 Two new tests in `ExploreReviewOverlay.test.tsx` cover both modes

## 5. TicketDetailModal — replace AI Edit with Continue Editing

- [x] 5.1 Removed `TicketAiEditOverlay` import, `aiEditOpen` state, snapshot revert state, `handleApplyDraft`, `handleAiRevert`
- [x] 5.2 Removed the inline `<TicketAiEditOverlay />` JSX mount
- [x] 5.3 New `<ContinueEditingButton />` in the modal header, gated to `draft`/`todo`/`backlog`
- [x] 5.4 Single button routes drafts-with-conv to resume path; otherwise dispatches `triggerResume({ params: { editTicket } })` consumed by SpecsBoard
- [x] 5.5 `ExploreSpecParams.editTicket` added to context; `SpecsBoard.ExploreState.editTicket` added; pending-restore handler and minimize round-trip preserve it
- [x] 5.6 `client/src/components/tickets/TicketAiEditOverlay.tsx` deleted
- [x] 5.7 No prior test file existed for `TicketAiEditOverlay` — nothing to delete

## 6. Tests — Continue Editing wiring

- [x] 6.1 TicketDetailModal tests: `Continue Editing` visible for `todo`/`backlog`/`draft`, hidden for `in_progress`/`done`/`cancelled`
- [x] 6.2 Click handler dispatches resume path via `onClose` callback contract (asserted up to fallback context boundary)
- [x] 6.3 Draft-with-`origin_conversation_id` routes through resume path; non-draft routes through fresh-edit path
- [x] 6.4 `ExploreSpecShell.review.test.tsx` extended: edit mode opens overlay with `mode='edit'` and `Update Spec` label
- [x] 6.5 Edit mode commit fires `PATCH /tickets/7` and does NOT fire `POST /tickets/from-draft`

## 7. Verification

- [x] 7.1 `npm run typecheck` clean
- [x] 7.2 `npm test` clean (server 1887 + client 1881)
- [x] 7.3 Server coverage: 81.14% L / 70.55% B / 86.54% F / 82.59% S — passes 80/70/80/80
- [x] 7.4 Client coverage: 81.61% L / 80.9% B / 71.9% F / 81.61% S — passes 80/—/70/80
- [x] 7.5 `openspec validate replace-ai-edit-with-continue-editing --strict` clean
- [ ] 7.6 Manual smoke: open a `todo` ticket → `Continue Editing` → Explore mounts seeded → refinement → Review → PATCH commit → ticket updated — _pending real-world run_
- [ ] 7.7 Manual smoke: `in_progress` ticket → no `Continue Editing` — _pending real-world run_
- [ ] 7.8 Manual smoke: draft with `origin_conversation_id` → `Continue Editing` resumes existing conversation — _pending real-world run_
- [ ] 7.9 Manual smoke: ticket with existing `## Acceptance Criteria` → parsed into bullets → edit + commit re-folds correctly — _pending real-world run_
