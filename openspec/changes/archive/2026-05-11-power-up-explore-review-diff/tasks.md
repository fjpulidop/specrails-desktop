## 1. Diff utilities

- [x] 1.1 `client/src/features/specs/components/explore-spec/diff-utils.ts` exports `wordDiff` + `arrayDiff` (with `ordered` interleaved sequence)
- [x] 1.2 Typed segment + array-diff result shapes
- [x] 1.3 13 unit tests in `__tests__/diff-utils.test.ts` covering identical/empty/partial/different/custom-eq/dedupe

## 2. ExploreReviewOverlay component

- [x] 2.1 `client/src/features/specs/components/explore-spec/ExploreReviewOverlay.tsx` accepts `baseline`/`proposed`/`isCommitting`/`onBack`/`onCommit`
- [x] 2.2 Full-screen overlay with backdrop, header, two-column responsive body, footer actions
- [x] 2.3 Word-level diff for title and description via `wordDiff`, semantic green/red tokens, whitespace-preserving block for description
- [x] 2.4 Set diff for labels (chips) and acceptance criteria (bullets) via `arrayDiff.ordered`, ordered + removed-after rendering
- [x] 2.5 Priority renders single pill when unchanged, `from → to` pair when changed
- [x] 2.6 Footer `[← Back to edit]` + `[Create Spec]`
- [x] 2.7 Esc keyboard handler equivalent to Back
- [x] 2.8 Empty-baseline branch: every value rendered as added, no removed sections

## 3. ExploreReviewOverlay tests

- [x] 3.1 `__tests__/ExploreReviewOverlay.test.tsx` created
- [x] 3.2 Empty baseline → all additions, no removed
- [x] 3.3 Word-level diff on description (unchanged + added + removed segments)
- [x] 3.4 Label set diff rendered in proposed-order with removed last
- [x] 3.5 Criteria set diff preserves proposed order
- [x] 3.6 Priority `from → to` pair when changed
- [x] 3.7 Priority single pill when unchanged
- [x] 3.8 Back-to-edit fires `onBack`
- [x] 3.9 Create-Spec fires `onCommit`
- [x] 3.10 Esc fires `onBack`

## 4. ExploreSpecShell wiring

- [x] 4.1 `Review →` button gated by `VITE_FEATURE_EXPLORE_REVIEW` flag AND non-empty title
- [x] 4.2 Local `reviewOpen` state, open/close handlers
- [x] 4.3 Pass live draft from `useSpecDraftStream` as `proposed`; `EMPTY_REVIEW_BASELINE` as baseline (Phase B contract preserved)
- [x] 4.4 `onCommit` reuses the existing `handleCreate` (same handler for footer and overlay)
- [x] 4.5 Overlay mounts on top with backdrop; shell stays in DOM underneath

## 5. ExploreSpecShell tests

- [x] 5.1 New `__tests__/ExploreSpecShell.review.test.tsx` with `useSpecDraftStream` mocked so we can inject a title
- [x] 5.2 Review button hidden when title empty; visible when non-empty
- [x] 5.3 Click opens overlay; Back closes it without unmounting shell
- [x] 5.4 Create-Spec from inside overlay triggers `POST /tickets/from-draft` (same path as footer button)

## 6. Verification

- [x] 6.1 `npm run typecheck` clean
- [x] 6.2 `npm test` (server 1875 + client 1856) clean
- [x] 6.3 `cd client && npm run test:coverage` — 80.37% L / 80.77% B / 71.4% F / 80.37% S — passes 80/—/70/80
- [x] 6.4 `openspec validate power-up-explore-review-diff --strict` clean
- [ ] 6.5 Manual smoke: open Explore, set a title, see `Review →`, click it, see all-additions render, Back returns cleanly, Create commits — _pending real-world run_
- [ ] 6.6 Manual smoke: build with `VITE_FEATURE_EXPLORE_REVIEW=false`; verify `Review →` gone and footer Create Spec still works — _pending real-world run_
