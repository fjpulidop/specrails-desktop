## 1. Sort state plumbing

- [x] 1.1 Add type `SpecSortMode = 'default' | 'ticket-id' | 'priority'` and `SpecSortDir = 'asc' | 'desc'` in a shared location (e.g. `client/src/features/specs/types/spec-sort.ts`)
- [x] 1.2 Add per-project localStorage helpers `loadSpecSort(projectId)` / `saveSpecSort(projectId, mode, dir)` reading/writing `specrails-hub:spec-sort-mode:<projectId>` and `specrails-hub:spec-sort-dir:<projectId>` with safe parsing and defaults (`mode='default'`, `dir='desc'`)
- [x] 1.3 Wire `useState` for `(mode, dir)` in `DashboardPage.tsx`, initialised from `loadSpecSort(activeProjectId)`; reset on `activeProjectId` change
- [x] 1.4 Persist `(mode, dir)` to localStorage whenever it changes; preserve `dir` even while `mode === 'default'`

## 2. Ordering pipeline

- [x] 2.1 Implement comparator helpers in a new `client/src/features/specs/lib/spec-sort.ts`: `sortByTicketId(a, b, dir)` and `sortByPriority(a, b, dir)` using bucket order `critical>high>medium>low>null` with id-asc tiebreaker (inverted bucket comparison for `asc`)
- [x] 2.2 In `DashboardPage.tsx`, refactor `specTickets` so that: `mode='default'` → keep existing custom-order logic; `mode='ticket-id'` → sort by id; `mode='priority'` → sort by priority bucket
- [x] 2.3 In `DashboardPage.tsx`, apply the same comparator to `doneSpecTickets` for non-default modes; keep `mode='default'` as API order
- [x] 2.4 Unit tests in `client/src/features/specs/lib/__tests__/spec-sort.test.ts` covering: id asc/desc, priority bucket asc/desc, null bucket placement, id-asc tiebreaker stability

## 3. Drag-flips-to-default behaviour

- [x] 3.1 In `DashboardPage.tsx` drag-end handler for the `specs` container, when `mode !== 'default'` use the currently visible sorted order as the base array, apply `arrayMove(visible, fromIdx, toIdx)`, persist the resulting `id[]` to `specrails-hub:spec-order:<projectId>`, and set `mode='default'`
- [x] 3.2 Ensure direction is unchanged on flip (preserved for next time the user enters a sorted mode)
- [x] 3.3 Verify drag of a card while in `default` keeps existing behaviour byte-for-byte (regression guard) — confirmed: branch only flips when `sortMode !== 'default'`; default path unchanged

## 4. SpecSortControl component

- [x] 4.1 Create `client/src/features/specs/components/SpecSortControl.tsx` with props `{ mode, dir, onChange(mode, dir) }`
- [x] 4.2 Render a chip with items `Default`, `Ticket #`, `Priority` using existing Radix `Select` (no new dep); show the active mode as the chip label
- [x] 4.3 Render a direction arrow button (`↑`/`↓`) immediately to the right of the chip; hide when `mode === 'default'`
- [x] 4.4 Use only semantic Tailwind tokens (`accent-secondary`, `muted-foreground`); no brand colours
- [x] 4.5 Tooltips: chip → "Sort: <mode>"; arrow → "Ascending" / "Descending"
- [x] 4.6 Accessibility: chip has `aria-label="Sort mode"`, arrow has `aria-label="Toggle sort direction"`, both reachable via keyboard

## 5. SpecsBoard wiring

- [x] 5.1 Extend `SpecsBoardProps` with `{ sortMode, sortDir, onSortChange }` (optional with safe defaults for back-compat with existing tests)
- [x] 5.2 Render `<SpecSortControl />` in the header between the label filter strip and the `+ Add` button; ensure `+ Add` stays right-aligned
- [x] 5.3 Verify label strip shrinks correctly (no overflow); `shrink-0` on the sort control
- [x] 5.4 Pass props through from `DashboardPage` to `SpecsBoard`

## 6. Tests

- [x] 6.1 New tests in `client/src/features/specs/components/__tests__/SpecSortControl.test.tsx`: renders three modes; arrow hidden in default; arrow visible and toggles in sorted modes; emits expected `onChange` payloads
- [x] 6.2 Extend `client/src/features/specs/components/__tests__/SpecsBoard.test.tsx`: control renders in header; selecting a mode/direction calls the callback
- [x] 6.3 New `client/src/pages/__tests__/DashboardPageSort.test.tsx` covering: switching to `ticket-id` re-renders cards in id order; switching to `priority` re-renders in bucket order; persists to localStorage and survives remount; default mode restores API order; direction preserved across default round-trips. Drag-flip end-to-end is not exercised (would require simulating dnd-kit drag-end through the mocked DndContext); the conditional itself is a 3-line guard and the comparator + persistence paths are covered by other tests.
- [x] 6.4 Test localStorage round-trip: covered in both `spec-sort.test.ts` and `DashboardPageSort.test.tsx`

## 7. Coverage & polish

- [x] 7.1 Run `npm run typecheck` — passes
- [x] 7.2 Run `npm test` (1998/1998 pass) and client coverage gate (`81.85% lines / 81.15% branches / 72.44% functions / 81.85% statements` — above thresholds)
- [ ] 7.3 Sanity-check the UI in `npm run dev`: switch modes, toggle direction, drag from a sorted view, switch projects, reload — left for user verification
- [x] 7.4 Update `CLAUDE.md` if needed — skipped (no architecture-level notes warranted)
