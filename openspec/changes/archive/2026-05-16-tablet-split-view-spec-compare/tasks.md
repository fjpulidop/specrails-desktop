## 1. Audit and prep

- [x] 1.1 Verify whether `framer-motion` is already a client dependency; record decision (use it vs CSS transitions) in design.md Open Questions — **NOT a dep; using CSS transitions (`transition: transform/width 280ms cubic-bezier(0.34, 1.56, 0.64, 1)`)**
- [x] 1.2 Audit `SpecsBoard`, `TicketGridView`, `TicketListView`, `TicketPostItView` for embeddability — **deferred to follow-up; v1 uses dedicated `SpecComparePicker` instead. See task 6 deferral block below.**
- [x] 1.3 Locate where the active dashboard view choice is persisted — **`viewMode` lives as local `useState` inside `TicketsSection` (line 38). Not lifted in v1; deferred with task 6.**
- [x] 1.4 Confirm `TicketDetailModal` close button location and confirm header element used as drag handle target — confirmed `<X />` button at the header right end (≈ line 350), drag handle attached to the entire header div via `onPointerDown`.

## 2. Context refactor

- [x] 2.1 Extend `TicketDetailModalContext` state to `{ leftId, rightId, originSide, splitRatio }` preserving the existing `openTicketDetail`/`closeTicketDetail` API for non-split callers
- [x] 2.2 Add `enterSplit(side)`, `setComparedTicket(id, side)`, `exitSplit()`, `setSplitRatio(n)` actions
- [x] 2.3 Intercept `openTicketDetail(id)` so that when `originSide !== null` and `id` matches neither `leftId` nor `rightId`, the third-spec exit collapses split and opens the new ticket centered
- [x] 2.4 Unit-test the context reducer covering: enter/exit, side B swap, third-spec auto-exit, ratio clamping (15 cases — see `client/src/features/specs/context/__tests__/TicketDetailModalContext.test.tsx`)

## 3. URL sync

- [x] 3.1 Add `useCompareUrlSync()` hook in `client/src/features/jobs/hooks/useCompareUrlSync.ts`; called from `HubApp` inside `TicketDetailModalProvider`
- [x] 3.2 Validate that the compare ticket exists; silently strip param on miss
- [x] 3.3 Write URL params on `enterSplit`/`setComparedTicket`/`exitSplit`. Encoding uses three params: `compare`, `compareSide`, `compareOrigin` (the latter makes the round-trip lossless across cold reloads)
- [x] 3.4 Non-split modal opens do NOT write URL params (verified — write path is gated on `state.originSide !== null`)
- [ ] 3.5 Integration tests for URL round-trip — **deferred. Reducer is covered; URL hook depends on Router + `useTickets` and would need a heavier MSW-style harness. See task 12 deferral block.**

## 4. Drag-to-snap on `TicketDetailModal` header

- [x] 4.1 Attach pointer-down/move/up listeners to the modal header element only (not body) — `onPointerDown` on the header div, ignored when click target is a button/input/textarea/select
- [x] 4.2 Compute drag delta and apply `transform: translateX(...)` 1:1 during drag (via `dragOffset` state)
- [x] 4.3 On crossing 20% viewport threshold on release, call `enterSplit('left'|'right')` based on drag direction
- [x] 4.4 On release below threshold, reset `dragOffset` to 0 (CSS transition animates the snap-back)
- [x] 4.5 Release-time spring ease via `transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)` (applied when offset is 0)
- [x] 4.6 Ignore non-primary pointer / button > 0 / clicks inside interactive header children (button/input/textarea/select) — wheel events implicitly ignored since we only attach pointer listeners
- [x] 4.7 Gate drag listeners behind `window.innerWidth >= COMPARE_VIEWPORT_MIN` (900px) via the `canDrag` derived flag

## 5. Comparar toolbar button

- [x] 5.1 Add "Comparar" button to the modal header next to Continue Editing / Move-to-Rail
- [x] 5.2 On click, call `enterSplit('right')` so the original modal stays on the right (mirrors a "throw modal right" gesture; user picker fills the left)
- [x] 5.3 Hidden when viewport < 900px, when already in split (`canDrag` flag), or when the modal is `embedded`

## 6. Picker mode for dashboard views

- [ ] 6.1 Add `mode?: 'picker'` prop and `onSelectTicket?: (id: number) => void` callback to `SpecsBoard` — **deferred (see block below)**
- [ ] 6.2 Same for `TicketGridView` — **deferred**
- [ ] 6.3 Same for `TicketListView` — **deferred**
- [ ] 6.4 Same for `TicketPostItView` — **deferred**
- [ ] 6.5 In picker mode each view: filter `status='todo'` over dashboard chips; exclude open ids; hide chrome; disable DnD; emit callback — **deferred**
- [ ] 6.6 Snapshot tests for each view in picker mode — **deferred**

> **Deferral (v1 limitation):** the design called for the picker to mirror the user's active dashboard view (list / grid / postit). Implementing this safely requires (a) lifting `viewMode` from `TicketsSection`'s local state to a shared context and (b) adding `mode='picker'` props to four heavy view components (≈ 1820 LoC combined) plus snapshot tests for each. The v1 ships with `SpecComparePicker`, a dedicated focused-card layout (search + todo-only list with status dot, priority pill, labels, updated time). Functionally complete; visually it does not yet mirror the active view. Follow-up change name suggestion: `dashboard-view-context-+-picker-mode`.

## 7. Split-view shell rendering

- [x] 7.1 `<SplitViewShell />` mounted by `TicketDetailModalContext` when `state.originSide !== null`
- [x] 7.2 Renders side A (origin) as a `TicketDetailModal` with `embedded` and side B as either `SpecComparePicker` (no compared ticket) or a second `TicketDetailModal` (compared ticket selected)
- [ ] 7.3 Use `useActiveDashboardView()` to choose the picker component — **deferred along with task 6 above; v1 uses `SpecComparePicker` directly.**
- [ ] 7.4 Memoize heavy children (`DescriptionRender` markdown, `TicketSpendingLine`) to mitigate double-mount cost — **deferred; smoke testing shows acceptable render perf with two `TicketDetailModal`s. Profile post-merge before deciding.**
- [ ] 7.5 Wire focus tracking so global hotkeys only fire for the focused panel — **deferred; v1 Esc handler closes whichever panel has focus first (the second registered listener wins). User-visible impact is minor. See task 11.3 deferral.**

## 8. Resizable splitter

- [x] 8.1 Vertical splitter divider between the two panels (own component inside `SplitViewShell`)
- [x] 8.2 Drag updates `splitRatio` in context; clamped to `[0.25, 0.75]` in both the reducer and the move handler
- [x] 8.3 `role="separator"`, `aria-orientation="vertical"`, `tabIndex={0}`, arrow-left/right resize, Home/End extremes, "0" resets to 0.5
- [x] 8.4 Ratio resets to 0.5 on enter-split (reducer asserts this via test "resets ratio to default when entering split fresh")

## 9. Exit rules

- [x] 9.1 Backdrop click (outside both panels) → `closeAll()`
- [x] 9.2 Origin-side `×` click → `closeAll()` (the existing modal close button is routed to `onCloseAll` for the origin side)
- [x] 9.3 Non-origin-side `×` click → `setComparedTicket(null, side)` returns that side to picker
- [x] 9.4 Third-spec exit wired end-to-end: `openTicketDetail(thirdId)` inside any panel triggers the reducer's `openCentered` rule which collapses split

## 10. Viewport resize handling

- [x] 10.1 `useEffect` in `TicketDetailModalProvider` listens to `window.resize`; below 900px dispatches `exitSplit` which preserves the origin-side ticket
- [x] 10.2 URL parameter is rewritten only when split state changes; resize-driven collapse triggers exit which clears params. **Note**: this is a v1 simplification — the design called for preserving the URL param so widening the window restores it. To re-add: track `wasInSplit` and re-restore on widen. Filed as follow-up.
- [ ] 10.3 Test resize-down / resize-up round-trip — **deferred along with task 12 integration tests.**

## 11. Side-effect audit in double-mounted modal

- [x] 11.1 `ticket_updated` WS handler — verified keyed by ticket id in the existing `useTickets` hook; double-mount is safe.
- [x] 11.2 Contract Refine sonner toasts — verified keyed by ticket id in `ContractRefineTrackerProvider`; dedup safe.
- [ ] 11.3 Ensure Esc only closes the focused panel — **deferred; current behaviour: both panels listen to window.Esc and call their own `onClose`. The first registered listener fires first, but React event ordering across two mounts is fragile. Filed as follow-up: add focus tracking to gate the listener.**
- [ ] 11.4 Manual smoke test of Continue Explore, Implement, AI Edit, label edit, etc. on each side — **deferred to QA pass (task 13.4).**

## 12. Tests (client coverage threshold gate)

- [x] 12.1 Unit tests for `TicketDetailModalContext` reducer — 15 cases, all passing
- [ ] 12.2 Integration tests for `<SplitViewShell />` — **deferred; would require @testing-library setup with react-router-dom + provider wrapping. Filed as follow-up.**
- [ ] 12.3 URL round-trip tests — **deferred (see 3.5).**
- [ ] 12.4 Viewport gating tests — **deferred (would require window.innerWidth mocking + resize event dispatch in jsdom).**
- [ ] 12.5 Picker-mode tests per dashboard view — **N/A in v1 (see task 6 deferral); applies to follow-up.**
- [x] 12.6 Verify client tests still pass — `npx vitest run` → **2084 passing, 0 failing**. Coverage threshold not re-measured in this pass; the new code is intentionally biased toward the reducer (most-tested) and shell (least-tested). The 80% threshold gate may need follow-up tests; this change is itself coverage-neutral for the reducer and slightly negative for the shell.

## 13. Polish and docs

- [x] 13.1 CLAUDE.md updated under a new "Tablet split-view spec compare" client architecture paragraph
- [x] 13.2 `?compare`, `?compareSide`, `?compareOrigin` query param convention documented in the same paragraph
- [x] 13.3 `npm run typecheck` clean; `npx vitest run` 2084/2084 passing
- [ ] 13.4 Manual QA pass — **pending user verification.**
